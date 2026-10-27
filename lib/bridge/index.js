// Stop waiting promptly while still observing a late upstream rejection.
function withSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";
//#region lib/types/index.js
const name = "dsh-bridge";
const inject = ["agents", "tools", "sessionPersistence", "workspaceRegistry", "typert"];
const DEFAULT_RECENT_MESSAGES = 1000;
const DEFAULT_DEDUPE_CAPACITY = 10_000;
const DEFAULT_MAX_MESSAGES_PER_READ = 100;
/** 本地补丁 2026-10-04（补丁 5）：表面追加前的工具结算等待窗口。 */
const APPEND_SETTLE_TIMEOUT_MS = 3_000;
const APPEND_SETTLE_POLL_MS = 25;
/**
 * 本地补丁 2026-10-04（补丁 5）：目标会话是否还有「未结算的工具请求」。
 *
 * 表面追加（`session.append(..., { surfaceOp: "append" })`）只能落在**表面尾部**。
 * 若此刻助手刚发出工具请求、结果尚未落盘，追加就会插进那条助手消息与其工具结果之间，
 * 提供方随即拒单（工具角色的消息必须紧跟带工具请求的助手消息）。这类坏序列一经落盘
 * 就无法自愈：此后每一轮请求都从表面重建，于是整个会话持续失败。
 *
 * 判据（只读）：从末尾往前扫，收集工具结果已回答过的 callId；遇到最近一条助手消息时，
 * 若它还有未回答的工具请求即为「未结算」。会话未暴露事件游标时按「可追加」处理。
 * @param session - 目标会话（`eventAt` / `seq` 由会话暴露）。
 * @returns 是否应等待其工具结算。
 */
function hasUnsettledToolCall(session) {
	if (typeof session?.eventAt !== "function" || typeof session?.seq !== "number") return false;
	const answered = /* @__PURE__ */ new Set();
	for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
		const event = session.eventAt(seq);
		if (event === undefined) continue;
		if (event.type === "tool/result") {
			const callId = event.data?.message?.source?.callId ?? event.data?.message?.toolCallId;
			if (callId !== undefined) answered.add(callId);
			continue;
		}
		if (event.type === "assistant/message") {
			const content = event.data?.message?.content;
			if (!Array.isArray(content)) return false;
			return content.some((block) => block?.type === "tool-call" && !answered.has(block.id));
		}
	}
	return false;
}
/**
 * 本地补丁 2026-10-04（补丁 5）：等到目标会话的工具结算完成，或等到超时。
 * @param session - 目标会话。
 * @param timeoutMs - 最长等待毫秒数。
 * @returns 现在是否可以安全地在表面尾部追加。
 */
async function settlesBeforeAppend(session, timeoutMs = APPEND_SETTLE_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (!hasUnsettledToolCall(session)) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, APPEND_SETTLE_POLL_MS));
	}
}
/**
 * 本地补丁 2026-10-05（补丁 7）：读目标 agent 的相位。
 *
 * 为什么需要它：补丁 5 的门控只看「有没有未结算的工具调用」，**看不见"模型回合还在不在跑"**。
 * 2026-10-05 真机实测（狼人杀第 9 局）：结算广播发出时，最后一个投票者的**回合还在收尾**（无 pending 工具）
 * ⇒ 被判「可追加」⇒ `session.append` 落进那条**正在结束的回合** ⇒ 该会话下一轮上下文里没有这条消息
 * （它的思考链写着"从未收到结算通知"，赛后感想全靠推算）。这是"广播撞上回合关闭"的竞态。
 *
 * @param target - Agent（有 `phase.kind`）；非标准目标返回 undefined。
 * @returns 相位名（"idle" / "running" / …），读不到则 undefined。
 */
function agentPhaseKind(target) {
	const kind = target?.phase?.kind;
	return typeof kind === "string" ? kind : undefined;
}
/**
 * 本地补丁 2026-10-05（补丁 7）：`wake:false` 的通道选择（纯函数，便于单测直接钉契约）。
 *
 * - 目标 **idle** ⇒ `"append"`：没有在跑的回合，消息落在表面尾部 ⇒ 界面可见 + 下次请求读到。
 * - 目标 **非 idle**（跑回合 / 收尾 / 跑工具）**或相位判不出** ⇒ `"inject"`：
 *   进 next-step 队列（`Agent.inject` = `send(input,"next-step",false)`）⇒ **不唤醒、不丢**，
 *   该会话下次被唤醒时整批进上下文。
 *   ⚠ 用户口径（2026-10-05）：「**确保收到比能不能看见更重要**」—— 判不出相位时也走 inject；
 *   真人的老玩法（`*名字=<会话>`）另有 `/ww-inbox` 可重弹，不会因为界面不可见就丢掉。
 * - 目标没有 `inject` ⇒ 退回 `"append"`（保底可见性）。
 * @param target - Agent。
 * @returns `"append"` | `"inject"`。
 */
function pickQuietChannel(target) {
	if (agentPhaseKind(target) === "idle") return "append";
	if (typeof target?.inject === "function") return "inject";
	return "append";
}
/**
 * 本地补丁 2026-10-06（补丁 8）：`wake:true` 的通道选择。
 *
 * 问题（狼人杀第 11 局实测）：`wake:true` 走 `followup` = next-turn 队列 ⇒ **要等目标当前回合结束**
 * 才被 claim；而 `wake:false` 的知悉型广播**下一步就读到**。于是**正在跑回合的玩家会先看到别人的
 * 动作、后收到给自己的指令**：局11 里小米先看到大D 的公开票，据此投票、看着结算、顺手写完感想，
 * 而那条「投票阶段开始」的唤醒直到**结算后约 19 秒**才被 claim —— 它从头到尾没收到过开票指令。
 *
 * 选路（**与补丁 7 的极性故意相反**）：
 * - **明确在跑**（`running` / `tool`）⇒ `"inject"`：进当前回合的 next-step ⇒ **下一步立即可见**，
 *   不再等整轮跑完；且 inject 不丢（这一轮若恰好结束，它仍会在下一次请求被读到，见补丁 7 的取证）。
 * - **idle 或相位判不出** ⇒ `"followup"`：**必须保住"叫醒"** —— 一条 `wake:true` 的消息要是被塞进
 *   空闲会话的 next-step 队列，就没有任何东西会去 claim 它 ⇒ 整局卡在等它。补丁 7 处理的是"知悉"
 *   （丢得起可见性），这里处理的是"召集"（叫不醒就是事故）⇒ 两条极性必须相反。
 * - 目标没有 `inject` ⇒ `"followup"`（保底叫醒）。
 * @param target - Agent。
 * @returns `"inject"` | `"followup"`。
 */
function pickWakeChannel(target) {
	const kind = agentPhaseKind(target);
	if ((kind === "running" || kind === "tool") && typeof target?.inject === "function") return "inject";
	return "followup";
}
/** Deployment-varying bounds; every default is overridable from cordis.yml. */
export const Config = Schema.object({
	recentMessages: Schema.number().default(DEFAULT_RECENT_MESSAGES).description("Recent messages retained per host for session_messages."),
	dedupeCapacity: Schema.number().default(DEFAULT_DEDUPE_CAPACITY).description("Delivered-message ids remembered for idempotent delivery."),
	maxMessagesPerRead: Schema.number().default(DEFAULT_MAX_MESSAGES_PER_READ).description("Upper bound on one session_messages read.")
});
/**
 * Whether one live session belongs in `session_list`.
 *
 * An unfiltered `ctx.agents.list()` also reports the two kinds the harness's own
 * session list hides: subagent children and the blank rows the Workspace UI
 * pre-creates before a first turn. Both read to a model as duplicate
 * conversations, so neither counts as a message target. Fork lineage is
 * deliberately not a filter: `parentSession` marks a fork, whose child is an
 * ordinary visible conversation (`dsh-client-ui-workspace` hides only
 * `origin === "subagent"`), while `delegationDepth` is the structural subagent
 * marker that survives a missing `origin`. A session whose shape is unknown is
 * kept — hiding a real target is worse than listing one.
 * The blank scan below is bounded by one live session's own log, so this runs only
 * over the live agent set; a persisted-session sweep would need a cheaper signal.
 * @param session - live Session exposed by one Agent.
 * @returns whether the model should see it in the listing.
 */
function isListedTarget(session) {
	if (session?.header?.origin === "subagent") return false;
	if (typeof session?.header?.delegationDepth === "number" && session.header.delegationDepth > 0) return false;
	if (typeof session?.eventAt !== "function" || typeof session?.seq !== "number") return true;
	// A blank row stops being blank at its first turn/start (dsh-api-session-controller).
	for (let seq = 0; seq < session.seq; seq += 1) {
		const event = session.eventAt(seq);
		if (event === undefined) break;
		if (event.type === "turn/start") return true;
	}
	return false;
}
class LocalSessionMessagingImpl {
	ctx;
	messages = [];
	listeners = /* @__PURE__ */ new Set();
	resuming = /* @__PURE__ */ new Map();
	deliveries = /* @__PURE__ */ new Map();
	constructor(ctx, options = {}) {
		this.ctx = ctx;
		this.recentMessages = options.recentMessages ?? DEFAULT_RECENT_MESSAGES;
		this.dedupeCapacity = options.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY;
	}
	list() {
		return [...this.ctx.agents.list()].map((agent) => agent.session).filter(isListedTarget).map((session) => String(session.id));
	}
	async status(sessionId, signal) {
		const id = String(sessionId);
		if (this.resuming.has(id)) return { sessionId: id, state: "waking", live: false };
		// Archive is a durable hide flag: it masks live presence so an archived
		// session never advertises as running/idle, even while its agent keeps
		// working in the background.
		if (new Set(this.ctx.workspaceRegistry?.archivedSessionIds ?? []).has(id)) return { sessionId: id, state: "archived", live: false };
		const live = this.ctx.agents.get(sessionId);
		if (live) return { sessionId: id, state: live.status, live: true };
		signal?.throwIfAborted?.();
		const snapshots = await this.ctx.sessionPersistence.list(signal === undefined ? undefined : { signal });
		return { sessionId: id, state: snapshots.some((snapshot) => String((snapshot.header ?? snapshot).id) === id) ? "offline" : "missing", live: false };
	}
	/** Resolve a session reference — a stable id or a session title — to its id.
	 * `mode` controls interpretation: `auto` tries the id first then the title,
	 * `id` accepts an exact known id only, `name` matches titles only. Titles
	 * match case-insensitively; ambiguous titles reject with the candidates. */
	async resolveTarget(reference, mode = "auto", signal) {
		const id = String(reference);
		signal?.throwIfAborted?.();
		const snapshots = await this.ctx.sessionPersistence.list(signal === undefined ? undefined : { signal });
		const headers = snapshots.map((snapshot) => snapshot.header ?? snapshot);
		const knownIds = new Set([
			...this.ctx.agents.list().map((agent) => String(agent.session.id)),
			...headers.map((header) => String(header.id))
		]);
		if (mode !== "name" && knownIds.has(id)) return id;
		if (mode === "id") throw new Error(`no session with id "${reference}"`);
		const sessionTitle = this.ctx.get?.("sessionTitle");
		const projCache = this.ctx.get?.("sessionProjectionCache");
		const matches = [];
		for (const agent of this.ctx.agents.list()) {
			const title = sessionTitle?.get?.(agent.session)?.title;
			if (typeof title === "string" && title.localeCompare(id, undefined, { sensitivity: "accent" }) === 0) matches.push(String(agent.session.id));
		}
		for (const header of headers) {
			// 本地补丁 2026-10-04（补丁 6）：`sessionProjectionCache.cachedSnapshot` 的当前签名是
			// `(meta, keys)` 两个参数（源码 dsh-session-projection-cache/lib/index.js:193），
			// 而这里原样传了 `(header, 0, ["title"])` —— 跟上位版本把 inherited cut 当第二个参数的
			// 旧签名漂移了。多出来的 `0` 落到 `keys` 上，viewRecord 遍历数字 0 直接抛
			// `number 0 is not iterable (cannot read property Symbol(Symbol.iterator))`。
			// 上面那段"cut 只对 unseeded 有效"的注释也随之失效：当前 API 的 lifecycle identity
			// 完全由 header 自身投影得到（lifecycleIdentityOf），不再需要 caller 传 cut。
			// 同包的 `cachedPredecessorTitle(meta)`（lib/index.js:218）就是这么调的，故这里删掉 `0`。
			const title = projCache?.cachedSnapshot?.(header, ["title"])?.values?.title;
			if (typeof title === "string" && title.localeCompare(id, undefined, { sensitivity: "accent" }) === 0) matches.push(String(header.id));
		}
		// A session can be both live and persisted; dedupe before judging ambiguity.
		const unique = [...new Set(matches)];
		if (unique.length === 0) throw new Error(`no session named "${reference}"`);
		if (unique.length > 1) throw new Error(`session name "${reference}" is ambiguous; choose a session id: ${unique.join(", ")}`);
		return unique[0];
	}
	async target(to) {
		const id = String(to);
		// Archive is a durable hide flag: an archived session never receives
		// delivery, whether its agent is still live or only persisted on disk.
		if (new Set(this.ctx.workspaceRegistry?.archivedSessionIds ?? []).has(id)) {
			throw new Error(`session "${id}" is archived and cannot receive messages`);
		}
		const live = this.ctx.agents.get(to);
		if (live) return live;
		let pending = this.resuming.get(id);
		if (!pending) {
			pending = (async () => {
				const provider = this.ctx.typert.lookups.get("agent");
				if (!provider) throw new Error("DSH host agent resolver is unavailable");
				const resolved = await provider.resolve(to);
				if (!resolved) throw new Error(`session "${id}" could not be resumed`);
				return resolved;
			})().then((agent) => {
				return agent;
			}).catch((error) => {
				const raced = this.ctx.agents.get(to);
				if (raced) return raced;
				throw error;
			}).finally(() => this.resuming.delete(id));
			this.resuming.set(id, pending);
		}
		return pending;
	}
	async deliver({ id = crypto.randomUUID(), from, to, text, transport = "local", signal, wake = true, sourceKind }) {
		signal?.throwIfAborted();
		const key = `${transport}:${String(from)}:${String(to)}:${id}`;
		const existing = this.deliveries.get(key);
		if (existing) return withSignal(existing, signal);
		const delivery = this._deliver({ id, from, to, text, transport, signal, wake, sourceKind }).catch((error) => {
			this.deliveries.delete(key);
			throw error;
		});
		this.deliveries.set(key, delivery);
		while (this.deliveries.size > this.dedupeCapacity) this.deliveries.delete(this.deliveries.keys().next().value);
		return delivery;
	}
	async _deliver({ id, from, to, text, transport, signal, wake = true, sourceKind }) {
		const target = await withSignal(this.target(to), signal);
		signal?.throwIfAborted();
		const message = {
			id,
			from: String(from),
			to,
			text,
			createdAt: Date.now(),
			delivered: true,
			transport
		};
		// 本地补丁 2026-09-30（补丁 12）：`wake: false` = 只投递、不唤醒，**且必须让人类在目标
		// 会话的时间线里看得见**。官方 UI（dsh-client-ui-chat client.js:5095）只渲染
		// source.kind === "user" 的挂起项、:9208 又要求消息先成为 user/message 事件才渲染 ⇒
		// inject（停在 inbox，不被 claim 就不落盘）在界面上等于不存在。故改用 Session.append ——
		// 官方自己就这么写合成消息（dsh-agent-loop:1046 每次 step、dsh-compaction-basic:650 写检查点），
		// 落在表面尾部：人立刻可见、不唤醒、模型下次请求照读。详见 PATCH-NOTES-dsh-bridge.md。
		const input = createUserMessage({
			content: [{
				type: "text",
				text: `[dsh-bridge ${transport} message ${id} from ${message.from}]\n${text}`
			}],
			source: {
				// DSH session format v4 retires the bare `kind: "plugin"` wrapper: a
				// producer owns its own kind(本地补丁 2026-09-28)。`plugin:dsh-bridge`
				// 正是 v3->v4 迁移为旧行推导出的形状，v4 校验器据此放行。
				// 本地补丁 2026-09-30（补丁 12）：调用方可自带 producer kind（sourceKind）。
				// dsh-chat 用它把「静默广播」标成 plugin:dsh-chat，好让 dsh-chat 前端注册的
				// 自定义可见节点只匹配广播、不误抓定向投递（定向仍是 plugin:dsh-bridge）。
				kind: sourceKind ?? `plugin:${name}`,
				// `relay` is the harness's ContextForm for a message carried from
				// elsewhere; the transport distinction travels in the text and record.
				form: "relay"
			}
		});
		if (wake === false && typeof target.session?.append === "function") {
			// 本地补丁 2026-10-04（补丁 5）：表面追加必须避开「带工具请求的助手消息 → 工具结果」
			// 这段窗口（否则提供方直接拒单，且坏序列一经落盘无法自愈）。
			// 本地补丁 2026-10-05（补丁 7）：**判据升级为"目标相位"**——补丁 5 只看工具窗口，
			// 看不见"模型回合还在收尾"；那种情形下 append 会被吞进那条正在结束的回合，目标下一轮
			// 再也读不到（狼人杀第 9 局实测：结算广播对最后一个投票者凭空消失）。
			// 口径见 `pickQuietChannel`：idle ⇒ append（可见+下次读到）；非 idle / 判不出 ⇒ inject（不唤醒、不丢）。
			if (pickQuietChannel(target) === "append") {
				if (await settlesBeforeAppend(target.session)) target.session.append("user/message", input, { surfaceOp: "append" });
				else if (typeof target.inject === "function") target.inject(input);
				else target.session.append("user/message", input, { surfaceOp: "append" });
			} else {
				target.inject(input);
			}
		}
		else if (wake === false && typeof target.inject === "function") target.inject(input);
		// 本地补丁 2026-10-06（补丁 8）：`wake:true`（"召集"）也按相位选路 —— 见 `pickWakeChannel`：
		// 目标**明确在跑**时改走 `inject`（下一步就可见，不再等整轮跑完）；idle / 判不出照旧 `followup`。
		else if (pickWakeChannel(target) === "inject") target.inject(input);
		else target.followup(input);
		this.messages.push(message);
		if (this.messages.length > this.recentMessages) {
			this.messages.splice(0, this.messages.length - this.recentMessages);
		}
		for (const listener of this.listeners) listener(message);
		return {
			messageId: id,
			from: message.from,
			to: String(to),
			delivered: true
		};
	}
	async send(from, to, text) {
		return this.deliver({ from: from.session.id, to, text });
	}
	async deliverExternal(from, to, text, options = {}) {
		return this.deliver({
			id: options.id,
			from,
			to,
			text,
			transport: options.transport ?? "external",
			// 本地补丁 2026-09-30：缺省 true（唤醒）—— 不传该选项的调用方行为完全不变。
			wake: options.wake ?? true,
			sourceKind: options.sourceKind,
		signal: options.signal
		});
	}
	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	receive(sessionId, limit) {
		return this.messages.filter((message) => message.to === sessionId).slice(-limit);
	}
};
function apply(ctx, config = {}) {
	const messaging = new LocalSessionMessagingImpl(ctx, {
		recentMessages: config.recentMessages ?? DEFAULT_RECENT_MESSAGES,
		dedupeCapacity: config.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY
	});
	const maxMessagesPerRead = config.maxMessagesPerRead ?? DEFAULT_MAX_MESSAGES_PER_READ;
	// `dshBridge` is the public service name. Keep the old accessor for one
	// release so an early local installation does not break on upgrade.
	ctx.provide("dshBridge", messaging);
	ctx.accessor("sessionMessaging", { get: () => messaging });
	ctx.tools.register(defineTool({
		name: "session_list",
		description: "List the live DeepSeek Harness sessions in this process that hold a conversation and can receive a message. Sessions the Web UI pre-created but never used, and subagent children, are omitted; an omitted session can still be targeted by its exact id with session_send.",
		parameters: {},
		output: {
			schema: {
				type: "array",
				items: { type: "string" }
			},
			render: (_args, value) => [{
				type: "text",
				text: value.join("\n") || "No live sessions."
			}]
		},
		async execute() {
			return messaging.list().map(String);
		}
	}));
	ctx.tools.register(defineTool({
		name: "session_send",
		description: "Send a message to another DeepSeek Harness session in this host. A persisted offline session is resumed before delivery. The target may be a session id or its human-readable title; mode controls how the target is interpreted.",
		parameters: {
			to: {
				type: "string",
				required: true,
				description: "Target session id or session title."
			},
			mode: {
				type: "string",
				enum: ["auto", "id", "name"],
				description: "How to interpret the target: auto (id first, then title), id (exact session id only), name (session title only). Defaults to auto."
			},
			text: {
				type: "string",
				required: true,
				description: "Message text."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					messageId: {
						type: "string",
						required: true
					},
					from: {
						type: "string",
						required: true
					},
					to: {
						type: "string",
						required: true
					},
					delivered: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Delivered ${value.messageId} to ${value.to}.`
			}]
		},
		async execute(args, exec) {
			if (!exec.agent) throw new Error("session_send requires an owning agent");
			if (args.text.trim() === "") throw new Error("text must not be empty");
			const to = await messaging.resolveTarget(args.to, args.mode, exec.signal);
			return await messaging.send(exec.agent, SessionId(to), args.text);
		}
	}));
	ctx.tools.register(defineTool({
		name: "session_messages",
		description: "Read messages delivered to the current session in this process.",
		parameters: { limit: {
			type: "number",
			description: "Maximum number of messages, default 20."
		} },
		output: {
			schema: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						id: {
							type: "string",
							required: true
						},
						from: {
							type: "string",
							required: true
						},
						to: {
							type: "string",
							required: true
						},
						text: {
							type: "string",
							required: true
						},
						createdAt: {
							type: "number",
							required: true
						},
						delivered: {
							type: "boolean",
							required: true
						},
						transport: {
							type: "string",
							required: true
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.map((message) => `[${message.from}] ${message.text}`).join("\n") || "No messages."
			}]
		},
		async execute(args, exec) {
			if (!exec.agent) throw new Error("session_messages requires an owning agent");
			const limit = args.limit === void 0 ? 20 : Math.max(1, Math.min(maxMessagesPerRead, Math.floor(args.limit)));
			return [...messaging.receive(exec.agent.session.id, limit)];
		}
	}));
}
//#endregion
export { LocalSessionMessagingImpl, apply, inject, name };
