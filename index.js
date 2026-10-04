/**
 * dsh-werewolf-dealer —— 《新版一夜狼人杀》DSH 庄家插件（Host 半边，零外部依赖）。
 *
 * 需求：`E:\codeVibe\group\庄家插件需求说明.md` v1.0；规则权威：`新版一夜狼人杀规则卡.md`。
 *
 * 角色分工（§0）：
 * - 本插件＝庄家（确定性代码，**不是 LLM 会话**）：发牌、夜序、换卡、计票、结算全部在此完成；
 * - 玩家＝房间里的真人／AI 会话：房间发言走 dsh-chat，夜间私聊走 dsh-bridge；
 * - 人类观察员＝命令入口（`/ww-*`）。
 *
 * 三条不可妥协的架构原则：
 * 1. 秘密不进任何 LLM 上下文：本文件不含模型调用，输出只有固定模板串；身份表只进审计日志（工作区之外）。
 * 2. 状态不进共享记忆：所有持牌期状态写 `%APPDATA%\dsh-werewolf`，从不触碰 `.dsh-memory` / `MEMORY.md`。
 * 3. 只裁程序、不裁身份：只维护流程状态机与规则算术。
 *
 * @module dsh-werewolf-dealer
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEALER_ALIAS, DEALER_ID, T } from './lib/templates.js';
import { Game, PHASE, compositionText } from './lib/engine.js';
import { PrivateStore, defaultStateDir, nextGameNo, writeRawExport } from './lib/store.js';

export { DEALER_ALIAS, DEALER_ID };

/** 依赖的 Host 服务；缺任一则该插件在本 profile 里保持 inactive（不抛错）。 */
export const inject = ['tools', 'commands', 'dshChat', 'dshBridge'];

/**
 * 本插件私聊消息在会话里的 producer kind（v1.7.1 客户端半边的匹配依据）。
 *
 * ⚠ 客户端半边 `client.js` 里有一份**同名副本**（浏览器模块拿不到本文件的导出），
 * 改这里必须同步改那里，否则卡片不渲染（消息回落到普通 context 行）。
 */
export const SOURCE_KIND = 'plugin:dsh-werewolf-dealer';

const DEFAULT_CONFIG = Object.freeze({
	/** 私有状态目录（§8.1，必须在工作区之外）。支持 `%ENV%` 与 `~`。 */
	stateDir: '%APPDATA%\\dsh-werewolf',
	/** 复盘 raw 导出目录（§7.1）。支持 `%ENV%` 与 `~`。 */
	exportDir: 'E:\\codeVibe\\group\\狼人杀复盘\\_raw',
	/** 空转提醒间隔（毫秒）；0 = 关闭（§4.3 可选，但本机不要开——见 README）。 */
	reminderMs: 0,
	/** 上诉流回放的审计片段条数（§10）。 */
	appealReplayLines: 20,
	/** 复盘 raw 的 Chatbox 样式（§7.1，v1.8.0）：写进 `> [!chatbox|<样式>-long]+ 第N局`。 */
	chatstyle: 'qqchat',
	/** dsh-chat 的头像映射文件（复盘 raw 的 `![face](…)` 取它；真人与 AI 都按同名键取）。支持 `%ENV%` 与 `~`。 */
	avatarFile: 'E:\\DeepSeek Harness\\dsh-chat\\avatars.json'
});

/** 展开配置里的 `%ENV%` 与 `~`（`resolve()` 不认这些）。 */
function expandPath(value) {
	let text = String(value);
	text = text.replace(/%([^%]+)%/gu, (match, name) => process.env[name] ?? match);
	if (text === '~') text = homedir();
	else if (text.startsWith('~/') || text.startsWith('~\\')) text = join(homedir(), text.slice(2));
	return text;
}

/** 取字符串配置：空/空白/非字符串一律回落默认值。 */
function pickText(value, fallback) {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/** 取数值配置：未给值（null/undefined/空白）或非法值一律回落默认值。 */
function pickNumber(value, fallback) {
	if (value === null || value === undefined) return fallback;
	if (typeof value === 'string' && value.trim() === '') return fallback;
	const number = Number(value);
	return Number.isFinite(number) ? number : fallback;
}

/**
 * 插件入口。
 * @param ctx - 插件上下文（含 tools / commands / dshChat / dshBridge）。
 * @param config - 行配置（`cordis.patch.yml` 的 `config`）。
 */
export function apply(ctx, config = {}) {
	const raw = config ?? {};
	// 状态目录：先展开 %ENV%/~；展开不掉（例如非 Windows 没有 %APPDATA%）就回落到平台默认目录，
	// 绝不让一个没展开的 `%APPDATA%\...` 变成工作区里的相对路径。
	const stateExpanded = expandPath(pickText(raw.stateDir, DEFAULT_CONFIG.stateDir));
	const settings = {
		stateDir: resolve(stateExpanded.includes('%') ? defaultStateDir() : stateExpanded),
		exportDir: resolve(expandPath(pickText(raw.exportDir, DEFAULT_CONFIG.exportDir))),
		reminderMs: Math.max(0, pickNumber(raw.reminderMs, DEFAULT_CONFIG.reminderMs)),
		appealReplayLines: Math.max(1, Math.floor(pickNumber(raw.appealReplayLines, DEFAULT_CONFIG.appealReplayLines))),
		chatstyle: pickText(raw.chatstyle, DEFAULT_CONFIG.chatstyle),
		avatarFile: resolve(expandPath(pickText(raw.avatarFile, DEFAULT_CONFIG.avatarFile)))
	};
	/** 哪些键是行配置**真的**给了值（`/ww-config` 用来说明值的来源；空白串不算）。 */
	const provided = (value) => (typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null);
	const explicitKeys = ['stateDir', 'exportDir', 'reminderMs', 'appealReplayLines', 'chatstyle', 'avatarFile'].filter((key) => provided(raw[key]));
	settings.defaultStateDir = resolve(expandPath(DEFAULT_CONFIG.stateDir));

	const store = new PrivateStore({ stateDir: settings.stateDir });
	/** roomId → Game。 */
	const games = new Map();

	const log = (level, message) => ctx.logger?.[level]?.(`[werewolf-dealer] ${message}`);

	// ------------------------------------------------------------ 串行执行队列

	/** 所有房间事件走同一条串行链，保证效果顺序与消息顺序一致。 */
	let chain = Promise.resolve();
	function enqueue(task) {
		chain = chain.then(task).catch((error) => log('warn', `效果执行失败：${String(error?.message ?? error)}`));
		return chain;
	}

	// ------------------------------------------------------------ 效果执行

	/**
	 * 执行引擎产出的效果数组。
	 * @param game - 归属对局。
	 * @param effects - 引擎返回的效果。
	 * @returns 投递回执 `{ dm, failed: [{ sessionId, error }] }`（观察员侧可见；首轮测试缺的就是它）。
	 */
	async function runEffects(game, effects) {
		const receipt = { dm: 0, deal: 0, dealFailed: [], failed: [], rooms: 0 };
		for (const effect of effects) {
			if (effect.type === 'audit') {
				store.appendAudit(game.gameId, effect.record);
				continue;
			}
			if (effect.type === 'room') {
				await sendRoom(game, effect.text, effect.mentions);
				receipt.rooms += 1;
				continue;
			}
			if (effect.type === 'dm') {
				receipt.dm += 1;
				const ok = await sendPrivate(game, effect.sessionId, effect.text, effect.seq, effect.wake !== false);
				if (!ok) receipt.failed.push({ sessionId: effect.sessionId });
				if (effect.deal === true) {
					receipt.deal += 1;
					if (!ok) receipt.dealFailed.push({ sessionId: effect.sessionId });
				}
				noteDelivery(game, effect.sessionId, ok);
				continue;
			}
			if (effect.type === 'appeal') {
				await replayAppeal(game);
			}
		}
		store.saveState(game);
		if (game.phase === PHASE.SETTLED || game.phase === PHASE.ENDED) {
			// 作废局不写复盘 raw（免得占用局号、污染复盘目录）；审计照留。
			if (game.voided !== true) await exportRaw(game);
			await releaseHumanPlaceholders(game);
		}
		return receipt;
	}

	/**
	 * 记录一条私聊投递结果（内存态，`/ww-status` 用）。
	 * 首轮测试的教训：真人席位"什么都没收到"时，无法区分"没发"与"没到" ⇒ 必须有回执。
	 */
	function noteDelivery(game, sessionId, ok) {
		if (!Array.isArray(game.receipts)) game.receipts = [];
		const player = game.bySession(sessionId);
		game.receipts.push({ at: Date.now(), seat: player?.seat ?? null, name: player?.name ?? String(sessionId), sessionId: String(sessionId), ok: ok === true });
		if (game.receipts.length > 50) game.receipts.splice(0, game.receipts.length - 50);
	}

	/** 需要与房间事件严格互斥的调用点用它（工具/命令侧）。 */
	function applyEffects(game, effects) {
		return enqueue(() => runEffects(game, effects));
	}

	/** 房间广播；mention 解析失败时退化为 @all（不因别名漂移而丢公告）。 */
	async function sendRoom(game, text, mentions) {
		const chat = ctx.dshChat.chat;
		const request = { roomId: game.roomId, author: DEALER_ID, authorAlias: DEALER_ALIAS, text, mentions: mentions ?? ['all'] };
		try {
			await chat.send(request);
		} catch (error) {
			log('warn', `房间广播失败（${String(error?.message ?? error)}），以 @all 重发`);
			await chat.send({ ...request, mentions: ['all'] });
		}
	}

	/**
	 * 私有信道：只发给该玩家的会话，其他玩家会话不可读（§1、§8.3）。
	 * `wake:false` 用于人类席位——消息只落到他自己的会话时间线里，**不触发该会话的模型回合**，
	 * 因此夜聊文本不会进入任何 LLM 上下文。
	 */
	async function sendPrivate(game, sessionId, text, seq, wake = true) {
		try {
			// 稳定投递 id：同一条效果重复执行时由 dsh-bridge 的幂等键去重。
			const id = seq === undefined ? randomUUID() : `${game.gameId}:${seq}`;
			await ctx.dshBridge.deliverExternal(DEALER_ID, sessionId, text, {
				id, transport: 'werewolf', wake,
				// v1.7.1：自带 producer kind，客户端半边只认自己的消息（否则与别的插件共用
				// `plugin:dsh-bridge`，前端无法区分 ⇒ 卡片要么抓错、要么抓不到）。
				// 依赖 dsh-bridge 本地补丁 12 的 `sourceKind` 透传；被校验器拒收时只在审计里
				// 留一条 `dm-failed`，投递本身不影响，见 HANDOFF-客户端半边.md §3。
				sourceKind: SOURCE_KIND
			});
			return true;
		} catch (error) {
			log('warn', `私聊投递失败 session=${sessionId}：${String(error?.message ?? error)}`);
			store.appendAudit(game.gameId, { at: Date.now(), type: 'dm-failed', secret: true, sessionId, error: String(error?.message ?? error) });
			return false;
		}
	}

	/** 上诉流：只回放**非密**审计片段（§10，含牌面的记录一律剔除）。 */
	async function replayAppeal(game) {
		const records = store.readAudit(game.gameId).filter((record) => record.secret !== true);
		const tail = records.slice(-settings.appealReplayLines);
		const lines = tail.map((record) => `- ${new Date(record.at).toISOString()} ${record.type}${record.seat ? ` 座位${record.seat}` : ''}${record.decision ? ` ${record.decision}` : ''}${record.reason ? `（${record.reason}）` : ''}`);
		await sendRoom(game, [T.appealHeader(tail.length), ...lines].join('\n'), ['all']);
	}

	/** 结算后写复盘 raw（§7.1）；文件已存在即视为已导出（幂等）。 */
	async function exportRaw(game) {
		try {
			const { no, path } = writeRawExport(game, { exportDir: settings.exportDir, chatstyle: settings.chatstyle, avatarFile: settings.avatarFile });
			game.no = no;
			store.appendAudit(game.gameId, { at: Date.now(), type: 'export', path });
			store.saveState(game);
			log('info', `第${no}局 raw 已导出：${path}`);
		} catch (error) {
			if (String(error?.message ?? '').includes('already exists')) return;
			log('warn', `raw 导出失败：${String(error?.message ?? error)}`);
		}
	}

	/** 对局结束：撤掉真人席位的占位成员（best-effort；插件重启过的局不会补撤）。 */
	async function releaseHumanPlaceholders(game) {
		const entry = humanPlaceholders.get(game.gameId);
		if (entry === undefined) return;
		humanPlaceholders.delete(game.gameId);
		for (const sessionId of entry.ids) {
			try {
				await ctx.dshChat.chat.removeMember(entry.roomId, { kind: 'session', sessionId });
			} catch (error) {
				log('warn', `真人占位成员清理失败（无害）：${String(error?.message ?? error)}`);
			}
		}
	}

	// ------------------------------------------------------------ 房间事件路由

	/** dsh-chat 订阅回调（同步）：只做归属判定，实际处理进串行链。 */
	const unsubscribe = ctx.dshChat.chat.subscribe((event) => {
		if (event?.kind !== 'message') return;
		const message = event.message;
		if (message?.author === DEALER_ID) return;
		const game = games.get(message.roomId);
		if (game === undefined) return;
		if (message.sentAt < game.startedAt) return; // 开局前的旧消息不参与判定
		enqueue(async () => {
			const effects = game.onRoomMessage({ authorSessionId: message.author, authorAlias: message.authorAlias, text: message.text, sentAt: message.sentAt });
			await runEffects(game, effects);
		});
	});
	ctx.effect(() => () => { try { unsubscribe?.(); } catch { /* 关闭期忽略 */ } });

	// 重启续局：把未结束的对局读回内存（§8 私有存储）。
	for (const data of store.listResumable()) {
		try {
			const game = Game.fromJSON(data);
			games.set(game.roomId, game);
			log('info', `续局 ${game.gameId}（${game.phaseLabel()}）`);
		} catch (error) {
			log('warn', `续局失败 ${data?.gameId}：${String(error?.message ?? error)}`);
		}
	}

	// 空转提醒（§4.3，仅提醒不代发）。
	if (settings.reminderMs > 0) {
		const timer = setInterval(() => {
			const now = Date.now();
			for (const game of games.values()) {
				if (now - game.lastActivityAt < settings.reminderMs) continue;
				const target = game.idleTarget();
				if (target === null) continue;
				game.lastActivityAt = now;
				enqueue(async () => {
					await sendPrivate(game, target.sessionId, target.text, undefined, game.bySession(target.sessionId)?.human !== true);
					store.saveState(game);
				});
			}
		}, Math.max(1000, Math.floor(settings.reminderMs / 2)));
		timer.unref?.();
		ctx.effect(() => () => clearInterval(timer));
	}

	// ------------------------------------------------------------ 开局

	/** 房间自身会话的前缀（dsh-chat：房间视图就渲染在这个会话里）。 */
	const ROOM_SESSION_PREFIX = 'dsh-chat-room-v3-';
	/**
	 * 真人席位的「聋占位成员」前缀。真人玩家的私聊信道是**房间外**的独立会话，
	 * 但房间里仍需要一个同名成员：否则 AI 一旦误 AT 人类，dsh-chat 的提及解析会直接抛错，
	 * 那条发言整条发不出去（消息丢失、该轮卡住）。占位成员不指向任何真实会话 ⇒
	 * 投递必然失败且被 dsh-chat 按收件人吞掉：既不唤醒谁（无模型回合、无上下文泄漏），
	 * 也不影响消息落时间线。
	 */
	const HUMAN_PLACEHOLDER_PREFIX = 'werewolf-human-seat-';
	/** gameId → 本局注册的占位成员（结算/终止后清理）。 */
	const humanPlaceholders = new Map();

	/**
	 * 解析席位 token：`名字` / `*名字`（真人）/ `名字=会话标题或id` / `*名字=会话标题或id`。
	 * @param token - 单个 token。
	 * @returns `{ name, ref, human }`。
	 */
	function parseSeatToken(token) {
		const raw = String(token).trim();
		const human = raw.startsWith('*');
		const body = human ? raw.slice(1) : raw;
		const eq = body.indexOf('=');
		const name = (eq === -1 ? body : body.slice(0, eq)).trim();
		const ref = eq === -1 ? undefined : body.slice(eq + 1).trim();
		if (name === '') throw new Error(`座位名不能为空（token: ${raw}）`);
		if (name.includes('*') || name.includes('=')) throw new Error(`座位名不能含 * 或 =（token: ${raw}）`);
		return { name, ref: ref === undefined || ref === '' ? undefined : ref, human };
	}

	/**
	 * 会话引用 → 会话 id。**自己解析，不把标题交给桥接层**：
	 *
	 * 当前版本的 dsh-bridge 在按标题解析时调 `sessionProjectionCache.cachedSnapshot(header, 0, ['title'])`，
	 * 而本版本该方法是 `cachedSnapshot(meta, keys)` 两个参数 ⇒ `keys = 0` ⇒ 内部遍历数字 0，
	 * 抛 `number 0 is not iterable (cannot read property Symbol(Symbol.iterator))`。
	 * 这条错会原样冒到 `ww-start` 上（"绑定的会话无法解析：千野（number 0 is not iterable…）"），
	 * 而且 `session_send` 用标题时同样会踩。
	 *
	 * 因此这里的顺序是：① 先当**会话 id** 试（活着的与已落盘的都认）；② 只在**活着的会话**里
	 * 按标题精确匹配（唯一命中才认，重名直接列出候选 id）；③ 都不中才退回桥接层，并把它那条
	 * 已知的签名错翻译成人话。
	 */
	async function resolveSessionRef(reference) {
		const bridge = ctx.dshBridge;
		const ref = String(reference).trim();

		// ① 会话 id：桥接层的 status 能区分"不存在"，也就不必猜
		let status;
		try { status = await bridge.status?.(ref); } catch { status = undefined; }
		if (status !== undefined && status.state !== 'missing') return ref;

		// ② 活着的会话里按标题找（标题权威来自 sessionTitle，不走那条坏掉的投影缓存）
		const sessionTitle = ctx.get?.('sessionTitle') ?? ctx.sessionTitle;
		const hits = new Map();
		for (const agent of ctx.get?.('agents')?.list?.() ?? []) {
			const session = agent?.session;
			if (session === undefined) continue;
			let title;
			try { title = sessionTitle?.get?.(session)?.title; } catch { title = undefined; }
			if (typeof title !== 'string' || title.localeCompare(ref, undefined, { sensitivity: 'accent' }) !== 0) continue;
			hits.set(String(session.id), title);
		}
		if (hits.size === 1) return [...hits.keys()][0];
		if (hits.size > 1) {
			throw new Error(`会话标题「${ref}」在活着的会话里不唯一：${[...hits.keys()].join('、')}；请改用会话 id（/ww-sessions 可列出）`);
		}

		// ③ 退回桥接层（含它的标题分支 —— 已知签名错在这里被翻译成人话）
		if (typeof bridge.resolveTarget !== 'function') throw new Error(`找不到会话「${ref}」（既不是会话 id，也不在活着的会话标题里；/ww-sessions 可列出）。`);
		try {
			return String(await bridge.resolveTarget(ref, 'auto'));
		} catch (error) {
			const reason = String(error?.message ?? error);
			if (/not iterable/u.test(reason)) {
				throw new Error(`按标题「${ref}」解析失败：当前 DSH 版本的 dsh-bridge 标题分支不可用（它给 sessionProjectionCache.cachedSnapshot 传了 3 个参数，本版本只收 2 个）。请改用会话 id 绑定，或先把这个会话打开使其变为"活着"从而走本插件的标题解析（/ww-sessions 可列出 id）。`);
			}
			throw error;
		}
	}

	/**
	 * 开一局（`/ww-start` 与 `wolf_start` 共用）。
	 * @param request - `{ roomRef, mode, seats: [{name, ref, human}], seed, writer }`。
	 * @returns `{ gameId, no, room, mode, seats, text }`。
	 */
	async function startGame(request) {
		const mode = Number(request.mode);
		if (mode !== 3 && mode !== 4) throw new Error('局型只能是 3 或 4');
		const seats = (request.seats ?? []).filter((seat) => seat !== undefined);
		if (seats.length !== mode) throw new Error(`需要 ${mode} 个玩家名（实收 ${seats.length} 个）`);

		const chat = ctx.dshChat.chat;
		const room = await chat.resolveRoom(String(request.roomRef));
		const existing = games.get(room.id);
		if (existing !== undefined && existing.phase !== PHASE.SETTLED && existing.phase !== PHASE.ENDED) {
			throw new Error(`房间 ${room.name} 已有进行中的对局（${existing.gameId}），先 /ww-end 终止它`);
		}
		// 真人在房间里的发言，作者就是**房间自身的会话**（dsh-chat 客户端用 sessionId 当 author）。
		const roomSideIds = [...new Set([room.sessionId, `${ROOM_SESSION_PREFIX}${room.id}`].filter((id) => typeof id === 'string' && id !== ''))];
		const members = (room.members ?? []).filter((member) => member.kind === 'session');

		const players = [];
		for (const seat of seats) {
			let sessionId;
			// 真人席位不得绑房间自身会话：房间视图里私聊行会被 dsh-chat 隐藏，等于收不到夜聊。
			if (seat.human === true && seat.ref !== undefined && roomSideIds.includes(seat.ref)) {
				throw new Error(T.humanNeedsChannel(seat.name, roomSideIds[0]));
			}
			if (seat.ref !== undefined) {
				try {
					sessionId = String(await resolveSessionRef(seat.ref));
				} catch (error) {
					const reason = String(error?.message ?? error);
					// 标题重名是这里最常见的一种失败：直接把出路写进报错。
					const hint = /ambiguous/u.test(reason) ? '；标题重名，请改用会话 id（/ww-sessions 可列出）' : '';
					throw new Error(`「${seat.name}」绑定的会话无法解析：${seat.ref}（${reason}${hint}）`);
				}
				const status = await ctx.dshBridge.status(sessionId);
				if (status.state === 'missing') throw new Error(`「${seat.name}」绑定的会话不存在：${seat.ref}`);
				if (status.state === 'archived') throw new Error(`「${seat.name}」绑定的会话已归档：${seat.ref}`);
			} else {
				const hit = members.filter((member) => member.alias === seat.name || member.sessionId === seat.name);
				if (hit.length !== 1) {
					if (seat.human === true) throw new Error(T.humanNeedsChannel(seat.name, roomSideIds[0]));
					throw new Error(`房间成员里找不到「${seat.name}」（命中 ${hit.length} 个）；当前成员：${members.map((member) => member.alias ?? member.sessionId).join('、') || '（无）'}`);
				}
				sessionId = hit[0].sessionId;
			}
			const chanIds = [];
			if (seat.human === true) {
				if (roomSideIds.includes(sessionId)) throw new Error(T.humanNeedsChannel(seat.name, roomSideIds[0]));
				chanIds.push(...roomSideIds);
			}
			players.push({ name: seat.name, sessionId, chanIds, human: seat.human === true });
		}

		const no = nextGameNo(settings.exportDir);
		const gameId = `${sanitize(room.id)}-第${no}局`;
		const seed = request.seed === undefined || request.seed === null || request.seed === '' ? undefined : Number(request.seed);
		const game = new Game({ roomId: room.id, roomName: room.name, mode, players, seed, gameId, no });
		// v1.8.0：**开局不再指定复盘写手**（用户要求）——写手在结算时按胜负判定，见 `Game#assignRecapWriter`。
		games.set(room.id, game);

		// 真人席位在房间里注册同名「聋占位成员」（见 HUMAN_PLACEHOLDER_PREFIX 的说明）。
		// 前提：房间里不能已经有一个同名成员——否则 dsh-chat 的提及解析会判歧义，
		// 任何 AT 人类的那条发言都会整条发不出去（比"消息发废"更糟）。
		const placeholders = [];
		for (const [index, player] of players.entries()) {
			if (player.human !== true) continue;
			const clash = (room.members ?? []).filter((member) => member.kind === 'session' && member.alias === player.name && !member.sessionId.startsWith(HUMAN_PLACEHOLDER_PREFIX));
			if (clash.length > 0) {
				throw new Error(`真人席位「${player.name}」在房间里已有同名成员（${clash.map((member) => member.sessionId).join('、')}）：请先把它移出房间（它会让点名歧义、把 AI 的发言整条发废），或换一个席位名`);
			}
			const seatId = `${HUMAN_PLACEHOLDER_PREFIX}${room.id}-${index + 1}`;
			try {
				await chat.addMember(room.id, { kind: 'session', sessionId: seatId, alias: player.name });
				placeholders.push(seatId);
			} catch (error) {
				log('warn', `真人占位成员注册失败（不影响对局）：${String(error?.message ?? error)}`);
			}
		}
		if (placeholders.length > 0) humanPlaceholders.set(gameId, { roomId: room.id, ids: placeholders });

		const startReceipt = await applyEffects(game, game.start());
		// 投递回执（首轮测试的教训：观测员无法区分"没发"与"没到"）。
		// v1.7.4：分母改成**本批实际发出的私聊条数**（发牌 + 夜序第一条提问）——
		// 怪盗与预言家不再收发牌（身份随夜间提问送达），拿玩家数当分母会永远差一条；
		// 失败名单也改成全部 `failed`（原先只看发牌），否则"提问投递失败"会漏报。
		const failedSeats = (startReceipt?.failed ?? []).map((entry) => game.bySession(entry.sessionId)?.name ?? entry.sessionId);
		const attempted = startReceipt?.dm ?? 0;
		const deliveryLine = failedSeats.length === 0
			? `开局私聊：${attempted}/${attempted} 已投递 ✓（发牌只发给狼与村民；怪盗/预言家的身份随夜间提问送达）`
			: `开局私聊：${attempted - failedSeats.length}/${attempted} 已投递 ⚠ 未送达：${failedSeats.join('、')}（查 /ww-audit 的 dm-failed 记录）`;
		const seatList = players.map((player, index) => `${index + 1}.${player.name}${player.human ? '（真人）' : ''}`).join(' → ');
		return {
			gameId,
			no,
			room: room.name,
			mode,
			seats: seatList,
			delivery: deliveryLine,
			text: `第${no}局已开始：${mode}人局，顺序 ${seatList}（复盘写手结算后按胜负判定）\n${deliveryLine}`
		};
	}

	function sanitize(value) {
		return String(value).replace(/[^A-Za-z0-9._-]/gu, '_');
	}

	/**
	 * 观察员命令选中哪一局：给房间名就用它，否则用唯一进行中的那一局；
	 * 没有进行中的对局时退回最近一局（已结算的局仍要能 /ww-status、/ww-audit 查看）。
	 */
	async function pickGame(roomRef) {
		if (roomRef !== undefined && String(roomRef).trim() !== '') {
			const room = await ctx.dshChat.chat.resolveRoom(String(roomRef).trim());
			const game = games.get(room.id);
			if (game === undefined) throw new Error(`房间 ${room.name} 没有对局`);
			return game;
		}
		const all = [...games.values()];
		if (all.length === 0) throw new Error('当前没有对局');
		const live = all.filter((game) => game.phase !== PHASE.SETTLED && game.phase !== PHASE.ENDED);
		if (live.length === 1) return live[0];
		if (live.length > 1) throw new Error(`有多局进行中（${live.map((game) => game.roomName).join('、')}），请带上房间名`);
		return all.sort((a, b) => (a.no ?? 0) - (b.no ?? 0)).at(-1);
	}

	function statusText(game, callerSessionId) {
		const status = game.status();
		const receipts = Array.isArray(game.receipts) ? game.receipts : [];
		const failed = receipts.filter((entry) => entry.ok !== true);
		const recent = receipts.slice(-3).map((entry) => `${entry.seat === null ? '' : `${entry.seat}.`}${entry.name}${entry.ok ? '✓' : '✗'}`);
		// 若调用者正是夜间被等待的席位，直接把待答私聊原文贴出来（真人看不到私聊行，这是唯一的"主动"替代）
		const caller = callerSessionId === undefined ? undefined : game.bySession(String(callerSessionId));
		const pending = game.phase === PHASE.NIGHT && caller !== undefined && game.nightAwaiting === caller.sessionId
			? store.readAudit(game.gameId).filter((record) => record.seat === caller.seat && record.type === 'night-ask').at(-1)
			: undefined;
		return [
			`第${status.no ?? '?'}局｜房间 ${status.roomName}｜${status.mode}人局`,
			`阶段：${game.phaseLabel()}${status.paused ? '（已暂停）' : ''}${game.voided === true ? '（已作废）' : ''}`,
			status.expectedSpeaker ? `当前应由 ${status.expectedSpeaker} 发言` : '',
			status.nightStep ? `夜序：${status.nightStep}` : '',
			status.awaiting ? `等待 ${status.awaiting} 的夜间回复` : '',
			pending === undefined ? '' : `⚠ 庄家在等**你**回答（原文）：${pending.text}`,
			pending === undefined ? '' : '  回复：/ww-reply <回答>；完整信箱：/ww-inbox',
			`已收票 ${status.votesIn}/${game.players.length}`,
			receipts.length === 0 ? '' : `私聊投递：成功 ${receipts.filter((entry) => entry.ok).length}／失败 ${failed.length}${recent.length === 0 ? '' : `（最近：${recent.join(' ')}）`}`,
			failed.length === 0 ? '' : `⚠ 未送达：${[...new Set(failed.map((entry) => `${entry.seat === null ? '' : `${entry.seat}.`}${entry.name}`))].join('、')}`,
			`座位：${status.seats.join(' → ')}`
		].filter((line) => line !== '').join('\n');
	}

	// ------------------------------------------------------------ 工具（模型侧）

	ctx.tools.register({
		name: 'wolf_reply',
		description: '一夜狼人杀：把夜间行动或私聊问题的回答私下发给庄家。只在庄家私聊问你（发牌/验人/换卡）时使用；房间里的公开发言请用 chat_send，不要用本工具。',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: { text: { type: 'string', description: '你的回答原文（例：换 大D / 不换 / 2 / 验 小米）。庄家按固定模板处理，不会回答任何提问。' } },
			required: ['text']
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: { status: { type: 'string', enum: ['accepted', 'no-pending', 'ignored'] }, note: { type: 'string' } },
				required: ['status', 'note']
			},
			render: (_args, value) => [{ type: 'text', text: value.note }]
		},
		async execute(args, exec) {
			const sessionId = exec.agent?.session?.id;
			if (sessionId === undefined) throw new Error('wolf_reply 需要由会话调用');
			const text = String(args?.text ?? '').trim();
			if (text === '') throw new Error('wolf_reply 需要非空的 text');
			const session = String(sessionId);
			let target;
			for (const game of games.values()) {
				if (game.nightAwaiting === session) { target = game; break; }
				if (target === undefined && game.bySession(session) !== undefined) target = game;
			}
			if (target === undefined) return { status: 'ignored', note: '当前没有你参与的对局；本条未送达庄家。' };
			const effects = target.onPrivateReply({ sessionId: session, text });
			await applyEffects(target, effects);
			const auditTypes = effects.filter((effect) => effect.type === 'audit').map((effect) => effect.record.type);
			if (auditTypes.includes('reply-unexpected')) {
				// 发牌、同伴信息这类**通报**不是提问：回它只会进档。首轮测试里两名 AI 都踩了这个坑。
				return { status: 'no-pending', note: '当前没有等待你回答的问题（发牌、同伴信息这类通报不需要回复）；本条只记了档，庄家不会回应内容。' };
			}
			// v1.7.6：不能说"按上一条消息的格式" —— 引擎随后会发一条**自带格式**的复问，
			// 而"上一条消息"到那时就是那条复问自己（用户 2026-10-04 指出）。
			if (auditTypes.includes('night-retry')) return { status: 'accepted', note: '已收到，但格式无法识别 —— 庄家随后会发一条写明格式的消息，照它重发即可。' };
			if (auditTypes.includes('swap-result')) return { status: 'accepted', note: '已收到并生效；换卡结果已私发给你（只通知你本人）。' };
			if (auditTypes.includes('swap')) return { status: 'accepted', note: '已收到并生效：你选择不换卡。' };
			if (auditTypes.includes('seer-read')) return { status: 'accepted', note: '已收到并生效；读数已私发给你。' };
			if (target.phase === PHASE.NIGHT && target.nightAwaiting === session) return { status: 'accepted', note: '已收到，但格式无法识别 —— 庄家随后会发一条写明格式的消息，照它重发即可。' };
			return { status: 'accepted', note: '已收到并生效；夜序的下一步私聊随后送达。' };
		}
	});

	ctx.tools.register({
		name: 'wolf_status',
		description: '一夜狼人杀：查询庄家当前公开状态（局号、阶段、轮次、当前应发言者、已收票数）。不含任何身份信息。',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: { room: { type: 'string', description: '可选：房间名或房间 id；省略时取唯一进行中的那一局。' } },
			required: []
		},
		output: {
			schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
			render: (_args, value) => [{ type: 'text', text: value.text }]
		},
		async execute(args) {
			const game = await pickGame(args?.room);
			return { text: statusText(game) };
		}
	});

	ctx.tools.register({
		name: 'wolf_start',
		description: '一夜狼人杀：按人类观察员的要求开一局（房间已建好、玩家已在房间里）。会广播开局并把身份私下发给每位玩家，因此只能在本局玩家名单确定后调用。玩家名写法：`名字`（房间成员别名）｜`名字=会话标题或id`（显式绑定私聊信道）｜`*名字=会话标题或id`（真人玩家：必须显式绑定一个可读会话，房间自身的会话不能当私聊信道）。',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				room: { type: 'string', description: '房间名或房间 id。' },
				mode: { type: 'integer', enum: [3, 4], description: '局型：3 或 4 人局。' },
				players: { type: 'array', items: { type: 'string' }, description: '玩家名（房间成员别名），顺序即座位顺序；支持 名字 / 名字=会话引用 / *名字=会话引用。' },
				seed: { type: 'integer', description: '可选随机种子（复盘复现用）。' }
			},
			required: ['room', 'mode', 'players']
		},
		output: {
			schema: { type: 'object', additionalProperties: false, properties: { gameId: { type: 'string' }, no: { type: 'integer' }, text: { type: 'string' } }, required: ['gameId', 'no', 'text'] },
			render: (_args, value) => [{ type: 'text', text: value.text }]
		},
		async execute(args) {
			const seats = (args?.players ?? []).map(parseSeatToken);
			const result = await startGame({ roomRef: args?.room, mode: args?.mode, seats, seed: args?.seed });
			return { gameId: result.gameId, no: result.no, text: result.text };
		}
	});

	// ------------------------------------------------------------ 命令（人类观察员侧 §10）

	ctx.commands.register({
		name: 'ww-start',
		description: '开局：/ww-start <房间名> <3|4> <玩家1> <玩家2> … [seed=数字]（复盘写手结算后按胜负判定，不用指定）',
		input: { hint: '房间名 3|4 玩家名…' },
		async handler(invocation) {
			try {
				const tokens = invocation.rawInput.trim().split(/\s+/u).filter((token) => token !== '');
				const options = new Map();
				const positional = [];
				for (const token of tokens) {
					const match = /^seed=(.+)$/u.exec(token);
					if (match) options.set('seed', match[1]);
					else positional.push(token);
				}
				const [roomRef, mode, ...seatTokens] = positional;
				const seats = seatTokens.map(parseSeatToken);
				const result = await startGame({ roomRef, mode, seats, seed: options.get('seed') });
				return { kind: 'success', text: result.text };
			} catch (error) {
				return { kind: 'error', text: `开局失败：${String(error?.message ?? error)}` };
			}
		}
	});

	ctx.commands.register({
		name: 'ww-status',
		description: '查看庄家当前状态：/ww-status [房间名]',
		input: { hint: '[房间名]' },
		async handler(invocation) {
			try {
				const game = await pickGame(invocation.rawInput.trim());
				return { kind: 'success', text: statusText(game, invocation.agent?.session?.id) };
			} catch (error) {
				return { kind: 'error', text: String(error?.message ?? error) };
			}
		}
	});

	ctx.commands.register({
		name: 'ww-pause',
		description: '暂停当前对局：/ww-pause [房间名]',
		async handler(invocation) {
			return commandWithGame(invocation, async (game) => {
				await applyEffects(game, game.setPaused(true));
				return '对局已暂停。';
			});
		}
	});

	ctx.commands.register({
		name: 'ww-resume',
		description: '恢复当前对局：/ww-resume [房间名]',
		async handler(invocation) {
			return commandWithGame(invocation, async (game) => {
				await applyEffects(game, game.setPaused(false));
				return '对局已恢复。';
			});
		}
	});

	ctx.commands.register({
		name: 'ww-override-vote',
		description: '覆写某座位的一票：/ww-override-vote <座位名或座位号> <目标名|平安夜|弃票> [房间名]',
		input: { hint: '座位 目标' },
		async handler(invocation) {
			return bareCommand(async () => {
				const [seatRef, targetRef, ...tail] = invocation.rawInput.trim().split(/\s+/u);
				if (seatRef === undefined || targetRef === undefined) throw new Error('用法：/ww-override-vote <座位名或座位号> <目标名|平安夜|弃票>');
				const game = tail.length > 0 ? await pickGame(tail.join(' ')) : await pickGame(undefined);
				const effects = game.overrideVote(seatRef, targetRef);
				const rejected = effects.find((effect) => effect.type === 'audit' && String(effect.record.type).includes('rejected'));
				await applyEffects(game, effects);
				if (rejected !== undefined) throw new Error(`覆写被拒：${rejected.record.reason}`);
				return `已把 ${seatRef} 的票改为 ${targetRef}。`;
			});
		}
	});

	ctx.commands.register({
		name: 'ww-recount',
		description: '重算当前票型（只看已收到的票，不改状态）：/ww-recount [房间名]',
		async handler(invocation) {
			return commandWithGame(invocation, async (game) => {
				await applyEffects(game, game.effectsForAudit([{ type: 'recount' }]));
				return game.recount().text;
			});
		}
	});

	ctx.commands.register({
		name: 'ww-void',
		description: '手动作废当前发言轮并重来：/ww-void [房间名]',
		async handler(invocation) {
			return commandWithGame(invocation, async (game) => {
				if (game.phase !== PHASE.DAY) throw new Error('只有白天发言阶段可以作废本轮');
				await applyEffects(game, game.voidRoundManually('observer'));
				return `第${game.round}轮已作废，重来。`;
			});
		}
	});

	ctx.commands.register({
		name: 'ww-close-vote',
		description: '截止收票并结算（缺票者记为弃票）：/ww-close-vote [房间名]',
		async handler(invocation) {
			return commandWithGame(invocation, async (game) => {
				if (game.phase !== PHASE.VOTE) throw new Error('当前不在投票阶段');
				await applyEffects(game, game.closeVote('observer'));
				return '已截止收票并结算。';
			});
		}
	});

	ctx.commands.register({
		name: 'ww-sessions',
		description: '列出可绑定为私聊信道的会话（标题 + 会话 id）：/ww-sessions [关键字]。标题重名时按 id 绑定。',
		input: { hint: '[关键字]' },
		async handler(invocation) {
			return bareCommand(async () => {
				const keyword = invocation.rawInput.trim().toLowerCase();
				const sessionTitle = ctx.get?.('sessionTitle') ?? ctx.sessionTitle;
				const rows = [];
				const seen = new Set();
				// 1) 活着的会话（标题权威）
				for (const agent of ctx.get?.('agents')?.list?.() ?? []) {
					const session = agent?.session;
					if (session === undefined) continue;
					const id = String(session.id);
					if (seen.has(id)) continue;
					seen.add(id);
					let title;
					try { title = sessionTitle?.get?.(session)?.title; } catch { title = undefined; }
					rows.push({ id, title: title ?? session.header?.title ?? '(无标题)', state: '在线', room: id.startsWith(ROOM_SESSION_PREFIX) });
				}
				// 2) 已落盘但当前没在跑的会话（id 一定有效，标题可能取不到）
				try {
					const persistence = ctx.get?.('sessionPersistence');
					for (const snapshot of (await persistence?.list?.()) ?? []) {
						const header = snapshot?.header ?? snapshot;
						const id = String(header?.id ?? '');
						if (id === '' || seen.has(id)) continue;
						seen.add(id);
						let title = typeof header?.title === 'string' ? header.title : undefined;
						if (title === undefined) {
							try { title = ctx.get?.('sessionProjectionCache')?.cachedSnapshot?.(header, 0, ['title'])?.values?.title; } catch { title = undefined; }
						}
						rows.push({ id, title: title ?? '(无标题)', state: '离线', room: id.startsWith(ROOM_SESSION_PREFIX) });
					}
				} catch { /* 落盘目录不可读时不列离线会话，不影响在线部分 */ }

				const dup = new Map();
				for (const row of rows) dup.set(row.title, (dup.get(row.title) ?? 0) + 1);
				const matched = rows.filter((row) => keyword === '' || `${row.title} ${row.id}`.toLowerCase().includes(keyword));
				if (matched.length === 0) return `没有匹配的会话（关键字：${keyword === '' ? '（空）' : keyword}）。`;
				const shown = matched.slice(0, 60);
				const lines = shown.map((row) => {
					const flags = [row.room ? '房间会话' : '', dup.get(row.title) > 1 ? '⚠标题重名' : ''].filter((flag) => flag !== '').join('，');
					return `- ${row.title}｜${row.state}${flags === '' ? '' : `｜${flags}`} → ${row.id}`;
				});
				return [
					`可绑定会话（共 ${matched.length} 个${matched.length > shown.length ? `，只列前 ${shown.length} 个` : ''}）：`,
					...lines,
					'绑定写法：`*名字=<会话 id>`（标题唯一时才建议用标题；房间会话不能当真人的私聊信道）。'
				].join('\n');
			});
		}
	});

	/**
	 * 观察员手动催人（`/ww-nudge`，`/ww-night` 是它的旧名）。
	 * 只在被调用时动作一次；报告里带上每个被催会话的实时状态，好让观察员分清
	 * 「它在长思考（running）」和「它真卡住了（idle/offline）」——这正是不能用计时器的原因。
	 */
	async function nudgeCommand(invocation) {
		return bareCommand(async () => {
			const tokens = invocation.rawInput.trim().split(/\s+/u).filter((token) => token !== '');
			let seatRef;
			const positional = [];
			for (const token of tokens) {
				const match = /^seat=(.+)$/u.exec(token);
				if (match) seatRef = match[1];
				else positional.push(token);
			}
			const game = await pickGame(positional.join(' '));
			const result = game.nudge({ seatRef });
			if (result.error !== undefined) throw new Error(result.error);
			await applyEffects(game, result.effects);

			const STATE_LABEL = { idle: '空闲', running: '正在运行（可能正在长思考）', waking: '唤醒中', offline: '离线', archived: '已归档', missing: '找不到该会话' };
			const lines = [];
			let running = 0;
			for (const seat of result.seats) {
				const status = await ctx.dshBridge.status(seat.sessionId).catch(() => undefined);
				const label = STATE_LABEL[status?.state] ?? '未知';
				if (status?.state === 'running') running += 1;
				lines.push(`  ${seat.seat}.${seat.name}${seat.human ? '（真人）' : ''}｜${seat.kind === 'vote' ? '未投票' : seat.kind === 'night' ? '等待夜间回复' : '该发言'}｜状态：${label}`);
			}
			const tail = running > 0
				? '\n注意：有会话正在运行——它可能只是在长思考，本条提醒会排在它当前这一轮之后，**不要重复催**。'
				: '';
			return `已提醒 ${result.seats.length} 人：\n${lines.join('\n')}${tail}`;
		});
	}

	ctx.commands.register({
		name: 'ww-nudge',
		description: '催当前该行动的人（观察员手动触发，无计时器）：/ww-nudge [seat=<座位>] [房间名]。夜间催等待回复者、白天催当前应发言者、投票期催未投票者；报告里会给每个被催会话的实时状态。',
		input: { hint: '[seat=<座位>] [房间名]' },
		async handler(invocation) {
			return nudgeCommand(invocation);
		}
	});

	ctx.commands.register({
		name: 'ww-night',
		description: '（旧名，等价于 /ww-nudge）重新提醒当前夜序等待者：/ww-night [房间名]',
		async handler(invocation) {
			return nudgeCommand(invocation);
		}
	});

	ctx.commands.register({
		name: 'ww-config',
		description: '查看庄家插件当前生效的配置与目录可用性（改配置后重启 DSH，再用它核对）：/ww-config',
		async handler() {
			return bareCommand(async () => {
				const stateFiles = (() => {
					try { return readdirSync(settings.stateDir).filter((name) => name.endsWith('.json') || name.endsWith('.jsonl')).length; } catch { return null; }
				})();
				const source = (key) => (explicitKeys.includes(key) ? '行配置' : '默认值');
				const lines = [
					`状态目录（私有，§8.1 要求在工作区之外）：${settings.stateDir}`,
					`  ｜来源：${source('stateDir')}｜${stateFiles === null ? '目录还不存在（首次写盘时创建）' : `已有 ${stateFiles} 个状态/审计文件`}`,
					`导出目录（赛后 raw，§7-1）：${settings.exportDir}`,
					`  ｜来源：${source('exportDir')}｜${existsSync(settings.exportDir) ? '已存在' : '还不存在（首次结算时创建）'}｜下一个局号：第 ${nextGameNo(settings.exportDir)} 局`,
					`空转提醒 reminderMs：${settings.reminderMs}${settings.reminderMs === 0 ? '（关闭）' : ' ⚠ 本机不建议开启：会把长思考判成空转（本机 mimo 会想 54 分钟）；要催用 /ww-nudge'}`,
					`上诉回放条数 appealReplayLines：${settings.appealReplayLines}（来源：${source('appealReplayLines')}）`,
					`复盘 raw 的 Chatbox 样式 chatstyle：${settings.chatstyle}（来源：${source('chatstyle')}）⇒ 写成 \`> [!chatbox|${settings.chatstyle}-long]+ 第N局\``,
					`头像映射 avatarFile：${settings.avatarFile}（来源：${source('avatarFile')}）｜${existsSync(settings.avatarFile) ? '已存在' : '读不到 ⇒ 气泡不带头像，不影响导出'}`,
					'复盘写手：**开局不再指定**，结算后按胜负判定（赢家独一份 ⇒ 写赢家；败者独一份 ⇒ 写败者；其余 ⇒ 排序第一个 AI）。',
					'改配置：编辑 E:\\DeepSeek Harness\\profiles\\web\\cordis.patch.yml，给 `- id: werewolf-dealer` 写 config 覆盖（优先级高于插件自带默认值，且不会被插件重装覆盖），改完**重启 DSH** 生效。'
				];
				return lines.join('\n');
			});
		}
	});

	ctx.commands.register({
		name: 'ww-end',
		description: '终止当前对局：/ww-end [--void] [房间名]。房间只发中性通知，身份表/参考结算**只私聊回执行命令的这个会话**；`--void` = 作废（不写复盘 raw、状态标记作废）',
		input: { hint: '[--void] [房间名]' },
		async handler(invocation) {
			return bareCommand(async () => {
				const tokens = invocation.rawInput.trim().split(/\s+/u).filter((token) => token !== '');
				const isVoid = tokens.includes('--void');
				const rest = tokens.filter((token) => token !== '--void').join(' ');
				const game = await pickGame(rest);
				const observerSessionId = invocation.agent?.session?.id;
				await applyEffects(game, game.endInformally({ observerSessionId, void: isVoid }));
				const reveal = game.players.map((player) => `${player.seat}.${player.name}｜发到：${game.dealt.get(player.sessionId)}｜现值：${game.hand.get(player.sessionId)}`).join('  ');
				return `${isVoid ? '本局已作废（不写复盘 raw）。' : '已终止本局（结算为非正式）。'}房间只收到中性通知，身份表只回给你：\n${reveal}\n牌堆：${compositionText(game.pile)}`;
			});
		}
	});

	ctx.commands.register({
		name: 'ww-reply',
		description: '真人玩家的私人回答（夜间行动等）：在自己的会话里输入 /ww-reply <回答>。只发给庄家，不进房间、也不进任何模型上下文。',
		input: { hint: '<回答>' },
		async handler(invocation) {
			return bareCommand(async () => {
				const text = invocation.rawInput.trim();
				if (text === '') throw new Error('用法：/ww-reply <回答>（例：/ww-reply 换 小米、/ww-reply 2、/ww-reply 验 大D）');
				const sessionId = String(invocation.agent?.session?.id ?? '');
				if (sessionId === '') throw new Error('该命令需要在会话里执行');
				const candidates = [...games.values()].filter((game) => game.bySession(sessionId) !== undefined);
				if (candidates.length === 0) throw new Error('当前没有你参与的对局');
				const awaiting = candidates.find((game) => game.bySession(sessionId).sessionId === game.nightAwaiting);
				const game = awaiting ?? candidates.sort((a, b) => (a.no ?? 0) - (b.no ?? 0)).at(-1);
				const player = game.bySession(sessionId);
				const effects = game.onPrivateReply({ sessionId, text });
				await applyEffects(game, effects);
				if (effects.some((effect) => effect.type === 'audit' && effect.record.type === 'reply-unexpected')) return '当前没有等待你回答的问题（本条只记了档，庄家不会回应内容）。';
				if (game.phase === PHASE.NIGHT && game.nightAwaiting === player.sessionId) return '已收到，但格式无法识别 —— 庄家随后会发一条写明格式的消息，照它重发即可。';
				return '已收到，庄家按夜序处理。';
			});
		}
	});

	/**
	 * 取回庄家发给**本会话所在席位**的夜聊私聊原文。
	 *
	 * 为什么必须有它：官方 UI 的可见性判据（`dsh-client-ui-chat/lib/client.js:7718` 的
	 * `isVisibleChatNode`）把**任何非 `user` 来源的普通文本消息**归成 `context` 行并
	 * **排除在可见 Chat 行之外** ⇒ 桥接投递的私聊在界面上看不到（人坐在那个会话里也看不到），
	 * 只有模型看得到。命令卡片是可见的，所以真人的"信箱"走命令取回。
	 */
	/**
	 * 会被 `/ww-inbox` 取回的审计类型。
	 * `night-wolf-info` 自 v1.7.2 起不再产生（同伴信息并入 `deal`），保留它是为了**旧局的审计**
	 * 还能被完整取回 —— 对已在盘上的老对局不算破坏性变更。
	 */
	const INBOX_TYPES = new Set(['deal', 'night-wolf-info', 'night-ask', 'seer-read', 'swap-result', 'night-retry']);

	ctx.commands.register({
		name: 'ww-inbox',
		description: '取回庄家发给你的夜聊私聊原文（房间/会话界面都不渲染私聊，真人靠它看牌与提问）：/ww-inbox',
		async handler(invocation) {
			return bareCommand(async () => {
				const sessionId = String(invocation.agent?.session?.id ?? '');
				if (sessionId === '') throw new Error('该命令需要在会话里执行');
				const mine = [...games.values()].filter((game) => game.bySession(sessionId) !== undefined);
				if (mine.length === 0) throw new Error('你还不是任何一局的席位（若你是观察员，请看 /ww-status）');
				const game = mine.sort((a, b) => (a.no ?? 0) - (b.no ?? 0)).at(-1);
				const player = game.bySession(sessionId);
				const lines = store
					.readAudit(game.gameId)
					.filter((record) => record.seat === player.seat && INBOX_TYPES.has(record.type) && typeof record.text === 'string')
					.map((record, index) => `${index + 1}. ${new Date(record.at).toLocaleTimeString('zh-CN', { hour12: false })} ${record.text}`);
				const awaiting = game.phase === PHASE.NIGHT && game.nightAwaiting === player.sessionId;
				const head = `【庄家私聊·${player.name} 的信箱】第${game.no ?? '?'}局｜阶段：${game.phaseLabel()}${game.voided === true ? '（已作废）' : ''}`;
				const tail = awaiting
					? `\n⚠ 庄家正在等你回答：回复用 /ww-reply <回答>（例：/ww-reply 换 小米、/ww-reply 2、/ww-reply 不换）`
					: '\n（当前没有等待你回答的问题；命令卡片是可见的，而私聊行官方 UI 不渲染，所以夜聊一律用本命令取。）';
				return [head, lines.length === 0 ? '（本局还没有发给你的私聊）' : lines.join('\n'), tail].join('\n');
			});
		}
	});

	ctx.commands.register({
		name: 'ww-audit',
		description: '人类观察员查看本局完整审计（含牌面，只回给输入命令的这个会话）：/ww-audit [房间名]',
		input: { hint: '[房间名]' },
		async handler(invocation) {
			return commandWithGame(invocation, async (game) => {
				const records = store.readAudit(game.gameId);
				const head = records.slice(0, 40).map((record) => `${new Date(record.at).toISOString()} ${record.type}${record.role ? ` role=${record.role}` : ''}${record.target ? ` target=${record.target}` : ''}${record.reason ? ` reason=${record.reason}` : ''}${record.text ? ` text=${JSON.stringify(record.text)}` : ''}`);
				return [`审计文件：${store.auditPath(game.gameId)}`, `共 ${records.length} 条，前 40 条：`, ...head].join('\n');
			});
		}
	});

	/**
	 * 命令公共壳：解析房间名、取对局、把剩余参数交给业务体。
	 * @param invocation - 命令调用。
	 * @param body - `(game, rest) => Promise<string>`。
	 */
	async function commandWithGame(invocation, body) {
		return bareCommand(async () => {
			const rest = invocation.rawInput.trim();
			const game = await pickGame(rest);
			return body(game, rest);
		});
	}

	/** 只做错误收敛的命令壳。 */
	async function bareCommand(body) {
		try {
			return { kind: 'success', text: await body() };
		} catch (error) {
			return { kind: 'error', text: String(error?.message ?? error) };
		}
	}

	log('info', `庄家已就绪：状态目录 ${settings.stateDir}，导出目录 ${settings.exportDir}`);
}
