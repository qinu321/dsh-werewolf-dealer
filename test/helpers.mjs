/**
 * 离线测试台：用假的 `ctx`（dsh-chat / dsh-bridge / tools / commands）跑真插件。
 *
 * 目的：在没有 Harness 运行时的情况下，端到端验证庄家的全部判定 —— 房间消息进出、
 * 私聊信道、状态落盘、审计与 raw 导出。假件的形状严格照宿主实现：
 *   - `ctx.dshChat.chat`：`resolveRoom / send / subscribe`（dsh-chat 0.1.0-rc.36）
 *   - `ctx.dshBridge`：`deliverExternal(from, to, text, options)`（dsh-bridge 0.1.0-rc.17）
 *   - `ctx.tools.register` / `ctx.commands.register`：只捕获定义，由测试直接调用
 *
 * @module dsh-werewolf-dealer/test/helpers
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply, DEALER_ID } from '../index.js';

/** 一局测试的假环境。 */
export class Harness {
	/**
	 * @param options - `{ players, roomName, stateDir, exportDir, config }`。
	 */
	constructor(options) {
		this.players = options.players;
		this.room = {
			id: options.roomId ?? 'room-dealer-test',
			name: options.roomName ?? '庄家插件测试房',
			// 真人在房间里的发言，作者就是房间自身的会话（dsh-chat 客户端行为）
			sessionId: `dsh-chat-room-v3-${options.roomId ?? 'room-dealer-test'}`,
			members: options.players.map((player) => ({ kind: 'session', sessionId: player.sessionId, alias: player.name }))
		};
		this.roomMessages = [];
		this.dmLog = [];
		this.auditLog = [];
		/** 房间成员增删记录（真人占位成员用）。 */
		this.memberLog = [];
		/** `removeMessage` 的调用次数（v1.10.0：庄家**不再**删任何消息，这个计数应当恒为 0）。 */
		this.removeCalls = 0;
		/** 现在注册着的发言适配器（v1.10.0「发言框接管」；`undefined` = 没注册）。 */
		this.composerAdapter = undefined;
		/** `false` 时假宿主**不提供** `setComposerAdapter`（验「dsh-chat 补丁 20 未装」的退化路径）。 */
		this.hasComposerAdapter = options.hasComposerAdapter ?? true;
		/** `false` 时假宿主**不提供** `supportsComposerConsume`（验「dsh-chat 补丁 21 未装」的退化路径）。 */
		this.hasConsume = options.hasConsume ?? true;
		/** v1.11.0：`/api/dsh-werewolf` 注册进来的路由（弹窗信箱端点）。 */
		this.mailboxRoute = undefined;
		/** 插件写过的 warn（v1.10.0：补丁 20 缺失时会记一条，用它断言）。 */
		this.warns = [];
		this.subscriber = null;
		this.tools = new Map();
		this.commands = new Map();
		this.stateDir = options.stateDir;
		this.exportDir = options.exportDir;
		this.disposers = [];
		/** 房间外、但真实存在的会话 id（真人自己的私聊信道）。 */
		this.extraSessions = new Set(options.extraSessions ?? []);
		/** 上面这些额外会话的标题（重名用例用）。 */
		this.extraTitles = new Map(Object.entries(options.extraTitles ?? {}));
		/** 房间落盘文件的读取次数（§11「投票期间不读房间落盘文件」的探针）。 */
		this.roomFileReads = [];
		/** 这些会话 id 的私聊投递一律失败（复刻"没到"：地址写错/会话不可 resume）。 */
		this.failDeliveryTo = new Set(options.failDeliveryTo ?? []);

		const self = this;
		const chat = {
			async resolveRoom(reference) {
				if (String(reference) !== self.room.id && String(reference) !== self.room.name) throw new Error(`room "${reference}" does not exist`);
				return self.room;
			},
			async messages(roomId, limit, waitMs) {
				self.roomFileReads.push({ api: 'messages', roomId, limit, waitMs, at: Date.now() });
				throw new Error('房间落盘文件在投票期间禁止读取');
			},
			async history(roomId, beforeId, limit) {
				self.roomFileReads.push({ api: 'history', roomId, beforeId, limit, at: Date.now() });
				throw new Error('房间落盘文件在投票期间禁止读取');
			},
			/**
			 * v1.10.0：真机路径是 `/api/dsh-chat` 的 send → `DshChatService.send`，
			 * **在构造消息之前**问一次发言适配器（dsh-chat 补丁 20）。测试台必须照这条路径走 ——
			 * 「庄家接管发言框」这件事的全部内容就是它。
			 */
			async send(request) {
				let text = request.text;
				let mentions = request.mentions ?? [];
				let speechRewritten = false;
				const rewritten = await self.composerAdapter?.rewrite?.({ roomId: request.roomId, author: request.author, authorAlias: request.authorAlias, text: request.text, mentions: request.mentions });
				// v1.11.0（dsh-chat 补丁 21）：适配器说「吞掉」⇒ 这条消息不成立（不落盘、不投递、不发事件）。
				if (self.hasConsume === true && rewritten?.consume === true) return { roomId: request.roomId, author: request.author, consumed: true };
				if (rewritten !== undefined && rewritten !== null) {
					if (typeof rewritten.text === 'string') { text = rewritten.text; speechRewritten = true; }
					if (Array.isArray(rewritten.mentions)) { mentions = rewritten.mentions; speechRewritten = true; }
				}
				const message = { id: randomUUID(), roomId: request.roomId, author: request.author, authorAlias: request.authorAlias, text, mentions, sentAt: Date.now(), deliveries: [] };
				self.roomMessages.push(message);
				// v1.9.0：真实 dsh-chat 会把落进时间线的消息广播给订阅者 —— 庄家**代投**的席位发言
				// 也因此回流（发言链就是靠这条回流前进的）。测试台必须复刻这一步，否则
				// 「代投 → 引擎步进」这条链在测试里永远验不到。
				self.subscriber?.({ kind: 'message', message, speechRewritten });
				return message;
			},
			// v1.10.0（dsh-chat 补丁 20）：适配器的注册口与只读提示端点。宿主没打补丁时**整个不存在**，
			// 插件据此判定「接管能力不可用」并记 warn（`hasComposerAdapter: false` 用来验这条）。
			...(self.hasComposerAdapter ? {
				// v1.11.0：`supportsComposerConsume` 只在「补丁 21 装了」时存在 —— 插件就是靠
				// 「这个属性在不在」判定能不能在房间里拦命令的。
				...(self.hasConsume ? { supportsComposerConsume: true } : {}),
				setComposerAdapter(adapter) { self.composerAdapter = adapter ?? undefined; },
				async composerRule(roomId) {
					const rule = await self.composerAdapter?.rule?.({ roomId, sessionId: self.room.sessionId, name: self.room.name });
					return rule ?? null;
				}
			} : {}),
			async addMember(roomId, member) {
				const existing = self.room.members.find((item) => item.kind === member.kind && item.sessionId === member.sessionId);
				if (existing !== undefined) {
					if (member.alias) existing.alias = member.alias;
					return existing;
				}
				const entry = { kind: member.kind, sessionId: member.sessionId, alias: member.alias };
				self.room.members.push(entry);
				self.memberLog.push({ action: 'add', kind: entry.kind, sessionId: entry.sessionId, alias: entry.alias });
				return entry;
			},
			async removeMember(roomId, member) {
				const index = self.room.members.findIndex((item) => item.kind === member.kind && item.sessionId === member.sessionId);
				if (index === -1) return null;
				const [removed] = self.room.members.splice(index, 1);
				self.memberLog.push({ action: 'remove', kind: removed.kind, sessionId: removed.sessionId, alias: removed.alias });
				return removed;
			},
			/**
			 * v1.10.0：庄家**不该再调用它**（「先发原文、再删掉换规范版」已删除）。保留一个会记账的
			 * 假实现，好让用例正面断言「一次都没调过」，而不是只能靠读代码。
			 */
			async removeMessage(roomId, messageId) {
				self.removeCalls += 1;
				const at = self.roomMessages.findIndex((message) => message.id === messageId);
				if (at === -1) return { removed: false, reason: 'not-in-window', id: messageId };
				self.roomMessages.splice(at, 1);
				return { removed: true, id: messageId };
			},
			subscribe(listener) {
				self.subscriber = listener;
				return () => { self.subscriber = null; };
			}
		};
		const bridge = {
			async status(sessionId) {
				const ref = String(sessionId);
				const known = self.players.some((player) => player.sessionId === ref) || self.extraSessions.has(ref);
				return { sessionId: ref, state: known ? 'idle' : 'missing', live: known };
			},
			/**
			 * 镜像 dsh-bridge 的 `resolveTarget`：先精确会话 id，再按标题。
			 *
			 * ⚠ 这里刻意**复刻真机标题分支的故障**（2026-10-04 实测）：真桥接层调
			 * `sessionProjectionCache.cachedSnapshot(header, 0, ['title'])`，而本版本该方法是
			 * `cachedSnapshot(meta, keys)` 两参 ⇒ keys=0 ⇒ 内部遍历数字 0 ⇒ `number 0 is not iterable`。
			 * 所以插件必须自己把标题解析掉，并把这条错翻译成人话。
			 */
			async resolveTarget(reference, mode = 'auto') {
				const ref = String(reference);
				const all = [
					...self.players.map((player) => ({ id: player.sessionId, title: player.title ?? player.name })),
					...[...self.extraSessions].map((id) => ({ id, title: self.extraTitles.get(id) }))
				];
				if (mode !== 'name' && all.some((entry) => entry.id === ref)) return ref;
				if (mode === 'id') throw new Error(`no session with id "${ref}"`);
				throw new Error('number 0 is not iterable (cannot read property Symbol(Symbol.iterator))');
			},
			async deliverExternal(from, to, text, opts = {}) {
				// `failDeliveryTo` 复刻"没到"（真人席位地址写错、目标会话不可 resume 等）
				if (self.failDeliveryTo.has(String(to))) {
					self.dmLog.push({ from, to: String(to), text, id: opts.id, wake: opts.wake !== false, transport: opts.transport, at: Date.now(), failed: true });
					throw new Error(`session "${to}" could not be resumed（harness 注入的投递失败）`);
				}
				self.dmLog.push({ from, to: String(to), text, id: opts.id, wake: opts.wake !== false, transport: opts.transport, at: Date.now() });
				return { messageId: opts.id ?? randomUUID(), from, to: String(to), delivered: true };
			}
		};
		this.ctx = {
			tools: { register: (definition) => { self.tools.set(definition.name, definition); const dispose = () => self.tools.delete(definition.name); self.disposers.push(dispose); return dispose; } },
			commands: { register: (definition) => { self.commands.set(definition.name, definition); const dispose = () => self.commands.delete(definition.name); self.disposers.push(dispose); return dispose; } },
			dshChat: { chat },
			dshBridge: bridge,
			// v1.11.0：动态注入（弹窗信箱端点用它等 `connection` 出现）。这里立刻回调并把注册进来的
			// 路由留一份，供用例直接调用 —— 免得测试还得起一个真 HTTP 服务。
			inject: (deps, callback) => {
				if (!Array.isArray(deps) || !deps.includes('connection')) return;
				callback({
					effect: (body) => { const dispose = body(); if (typeof dispose === 'function') self.disposers.push(dispose); return dispose; },
					connection: { fetch: { register: (route) => { self.mailboxRoute = route; return () => { self.mailboxRoute = undefined; }; } } }
				});
			},
			effect: (body) => { const dispose = body(); if (typeof dispose === 'function') self.disposers.push(dispose); return dispose; },
			logger: { info: () => {}, warn: (text) => { self.warns.push(String(text)); }, debug: () => {}, error: () => {} },
			// 宿主服务的最小替身：`/ww-sessions` 从 agents + sessionTitle 读"标题 → id"
			get: (name) => {
				if (name === 'agents') {
					return {
						list: () => [
							...self.players.map((player) => ({ session: { id: player.sessionId, header: { id: player.sessionId, title: player.title ?? player.name } } })),
							...[...self.extraSessions].map((id) => ({ session: { id, header: { id, title: self.extraTitles.get(id) } } }))
						]
					};
				}
				if (name === 'sessionTitle') return { get: (session) => ({ title: session?.header?.title }) };
				if (name === 'sessionPersistence') return { list: async () => [] };
				return undefined;
			}
		};
		apply(this.ctx, { stateDir: this.stateDir, exportDir: this.exportDir, reminderMs: 0, ...(options.config ?? {}) });
	}

	/**
	 * 模拟「一条消息已经落在房间里」（AI 席位自己发的、或绕过发言框的路径）。
	 *
	 * ⚠ 真人**走发言框**的那条不要用它 —— 那条必须经过 dsh-chat 的改写钩子，用 `speakAsHuman()`。
	 * @param sessionId - 房间侧作者（AI 席位=自己的会话；真人=房间自身会话）。
	 * @param text - 正文。
	 * @param mentions - dsh-chat 解析后的提及引用；默认 `['all']`。
	 */
	say(sessionId, text, mentions = ['all']) {
		if (this.subscriber === null) throw new Error('harness has no subscriber');
		const message = { id: randomUUID(), roomId: this.room.id, author: sessionId, authorAlias: this.players.find((p) => p.sessionId === sessionId)?.name, text, mentions, sentAt: Date.now() };
		this.roomMessages.push(message);
		this.subscriber({ kind: 'message', message, speechRewritten: false });
		return message;
	}

	/**
	 * v1.10.0：模拟**真人在房间发言框里打字并按发送**。
	 *
	 * 真机路径：RoomComposer → `/api/dsh-chat` 的 send → `DshChatService.send`（**在这里**问
	 * 发言适配器要不要改写）→ 落盘 + 广播回流。所以这里也走 `chat.send`，而不是直接塞一条消息。
	 * @param text - 他手打的正文（可自带前缀，会被剥掉后重写）。
	 * @param mentions - 他在界面上选的提及（发送时正文从不被解析，手打 @ 也不算）。
	 * @returns 房间里落下的那一条（= 规范版；没被接管时就是原文）。
	 */
	async speakAsHuman(text, mentions = []) {
		return await this.ctx.dshChat.chat.send({ roomId: this.room.id, author: this.room.sessionId, authorAlias: 'You', text, mentions });
	}

	/** v1.10.0：房间发言框此刻会显示的前缀条（真机走 `/api/dsh-chat` 的 composerRule 端点）。 */
	async composerRule() {
		const chat = this.ctx.dshChat.chat;
		return typeof chat.composerRule === 'function' ? await chat.composerRule(this.room.id) : null;
	}

	/** 模拟观察员在房间里发言（非玩家）。 */
	observerSay(text) {
		return this.say('observer-session', text);
	}

	/** 调用模型侧工具。 */
	async callTool(name, args, sessionId) {
		const tool = this.tools.get(name);
		if (tool === undefined) throw new Error(`tool ${name} is not registered`);
		return await tool.execute(args, { agent: { session: { id: sessionId } } });
	}

	/** 调用人类命令。 */
	async runCommand(name, rawInput, sessionId = 'observer-session') {
		const command = this.commands.get(name);
		if (command === undefined) throw new Error(`command ${name} is not registered`);
		return await command.handler({ commandId: 'cmd-1', agent: { session: { id: sessionId } }, rawInput, attachments: [], signal: new AbortController().signal });
	}

	/** 等串行链跑完（插件内部为 promise 串行队列，真实定时器足够排空）。 */
	async flush(times = 3) {
		for (let i = 0; i < times; i += 1) await new Promise((done) => setTimeout(done, 0));
	}

	/** 最近若干条房间公告。 */
	get lastRoomText() {
		return this.roomMessages.at(-1)?.text ?? '';
	}

	/** 某会话收到的私聊。 */
	dmsTo(sessionId) {
		return this.dmLog.filter((entry) => entry.to === sessionId);
	}

	/** 读取私有状态文件。 */
	readState(gameId) {
		return JSON.parse(readFileSync(join(this.stateDir, `${gameId}.json`), 'utf8'));
	}

	/** 读取审计文件。 */
	readAudit(gameId) {
		const path = join(this.stateDir, `${gameId}.audit.jsonl`);
		return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
	}

	/**
	 * v1.11.0：读本局的**弹窗信箱**（真人私密内容的唯一落点 —— 它不进任何会话）。
	 * @param gameId - 局标识。
	 * @returns 记录数组（按 seq 升序）。
	 */
	readMail(gameId) {
		const path = join(this.stateDir, `${gameId}.mail.jsonl`);
		if (!existsSync(path)) return [];
		return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
	}

	/**
	 * v1.11.0：直接调 `/api/dsh-werewolf`（等价于浏览器 POST 一次）。
	 * @param args - 端点参数（`{ since, limit }`）。
	 * @param endpoint - 端点名，默认 `inbox`。
	 */
	async callMailbox(args = {}, endpoint = 'inbox') {
		if (this.mailboxRoute === undefined) throw new Error('mailbox route is not registered');
		const response = await this.mailboxRoute.fetch({ json: async () => ({ endpoint, args }) });
		return await response.json();
	}

	/** 清理。 */
	dispose() {
		for (const dispose of this.disposers.reverse()) {
			try { dispose(); } catch { /* 忽略 */ }
		}
	}
}

/** 建一个工作区之外的临时目录（§8.1 要求状态目录在工作区外）。 */
export function makeTempDir(prefix = 'werewolf-dealer-test') {
	const dir = join(tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** 递归删除。 */
export function removeDir(dir) {
	rmSync(dir, { recursive: true, force: true });
}

/** 递归列出文件。 */
export function listFiles(root, filter = () => true) {
	const out = [];
	let entries;
	try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(path, filter));
		else if (entry.isFile() && filter(path)) out.push(path);
	}
	return out;
}

/** 大小与 mtime（隐私验收的辅助证据）。 */
export function fileStamp(path) {
	try {
		const info = statSync(path);
		return { size: info.size, mtimeMs: info.mtimeMs };
	} catch {
		return null;
	}
}
