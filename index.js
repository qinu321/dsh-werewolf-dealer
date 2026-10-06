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
import { Game, MAX_MODE, MIN_MODE, PHASE, compositionText, parseSpeechPrefix } from './lib/engine.js';
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
	/**
	 * v1.19.0（用户 2026-10-06 定）：**投票限时**（先催后判），毫秒。
	 * - `voteDeadlineMs`：开票公告之后多久，对**未投的 AI 席位**催一次票（私聊唤醒 + 房间一条中性提醒）；
	 * - `voteGraceMs`：催票之后再宽限多久，仍未投的 AI 席位记**弃权**并推进结算（all-in）。
	 * **真人席位全程豁免**（用户理由：真人看完最后一轮全部发言就不止这几分钟）。
	 * `voteDeadlineMs: 0` = 关闭本功能（回到"只靠观察员手动 /ww-nudge、/ww-close-vote"）。
	 * 默认 **关闭（0）**：v1.21.0 起改用**确认阶段**（v1.19.x 的限时只在需要时打开）。
	 * 打开后的语义：默认 **2 分 30 秒 + 2 分 30 秒 = 总窗口 5 分钟**。
	 * 5 分钟的依据：本机实测 15 张票的「公告→投票」中位 **8.3s**、最长 **58.0s** ⇒ 2.5 分钟已有 2.6 倍余量。
	 */
	voteDeadlineMs: 0,
	voteGraceMs: 150000,
	/** 上诉流回放的审计片段条数（§10）。 */
	appealReplayLines: 20,
	/** 复盘 raw 的 Chatbox 样式（§7.1，v1.8.0）：写进 `> [!chatbox|<样式>-long]+ 第N局`。 */
	chatstyle: 'qqchat',
	/**
	 * v1.12.0：房间发言框「开局」按钮勾了「真人」时，追加的那个真人席位叫什么。
	 * 玩家可以按自己喜好改（`cordis.patch.yml` 的 `humanName`），默认「玩家」。
	 */
	humanName: '玩家',
	/** dsh-chat 的头像映射文件（复盘 raw 的 `![face](…)` 取它；真人与 AI 都按同名键取）。支持 `%ENV%` 与 `~`。 */
	avatarFile: 'E:\\DeepSeek Harness\\dsh-chat\\avatars.json',
	/**
	 * v1.17.0（用户 2026-10-06 要的）：**给 AI 席位一个「叫停键」**。
	 *
	 * 开启后多注册一个 `wolf_pause` 工具 —— AI 遇到异常（该收到的信息没到、状态与规则不符）时
	 * 可以第一时间暂停本局并写下理由，观察员**立刻在弹窗里看到**，而不是事后自己去翻会话日志。
	 * 用户原话要旨：「这样它们那里出了问题，第一时间会想到先暂停游戏，我就能及时发现问题」。
	 *
	 * 默认 **关闭**：它把"暂停"这个权力交给模型，只适合看局/排障时临时打开。关闭时**工具根本不注册**
	 * ⇒ AI 的工具表里看不到它。开启＝在 `cordis.patch.yml` 的 `- id: werewolf-dealer` 里写
	 * `aiPauseTool: true` 并重启 DSH。
	 */
	aiPauseTool: false
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
 * v1.17.0：取布尔配置。**只有真给了 `true`（或字符串 `'true'`）才算开** ——
 * 未给、空串、`false`、`'false'`、任意别的值一律回落 `fallback`。
 * 这样 `aiPauseTool: 'false'`（YAML 里手滑写成字符串）不会意外打开一个把暂停权交给模型的开关。
 */
function pickFlag(value, fallback = false) {
	if (value === undefined || value === null || value === '') return fallback;
	if (typeof value === 'boolean') return value;
	return String(value).trim().toLowerCase() === 'true';
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
		humanName: pickText(raw.humanName, DEFAULT_CONFIG.humanName),
		avatarFile: resolve(expandPath(pickText(raw.avatarFile, DEFAULT_CONFIG.avatarFile))),
		// v1.17.0：给 AI 的「叫停键」开关（默认 false；只有真给了 true / 'true' 才算开）
		aiPauseTool: pickFlag(raw.aiPauseTool, DEFAULT_CONFIG.aiPauseTool),
		// v1.19.0：投票限时（先催后判）；0 = 关闭。两个值都非负整数毫秒。
		voteDeadlineMs: Math.max(0, Math.floor(pickNumber(raw.voteDeadlineMs, DEFAULT_CONFIG.voteDeadlineMs))),
		voteGraceMs: Math.max(0, Math.floor(pickNumber(raw.voteGraceMs, DEFAULT_CONFIG.voteGraceMs)))
	};
	/** 哪些键是行配置**真的**给了值（`/ww-config` 用来说明值的来源；空白串不算）。 */
	const provided = (value) => (typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null);
	const explicitKeys = ['stateDir', 'exportDir', 'reminderMs', 'appealReplayLines', 'chatstyle', 'humanName', 'avatarFile', 'aiPauseTool', 'voteDeadlineMs', 'voteGraceMs'].filter((key) => provided(raw[key]));
	settings.defaultStateDir = resolve(expandPath(DEFAULT_CONFIG.stateDir));

	const store = new PrivateStore({ stateDir: settings.stateDir });
	/** roomId → Game。 */
	const games = new Map();

	const log = (level, message) => ctx.logger?.[level]?.(`[werewolf-dealer] ${message}`);

	/**
	 * v1.11.0：**房间内可执行的命令**表。
	 *
	 * 房间里打 `/ww-*` 时那条消息不落房间（被发言适配器吞掉），执行靠的就是这张表 ⇒ 每个命令注册时
	 * 一并存进来。行为不变：人类观察员侧的斜杠命令照旧走 `ctx.commands`。
	 */
	const roomCommands = new Map();
	function registerCommand(definition) {
		roomCommands.set(definition.name, definition);
		return ctx.commands.register(definition);
	}

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
				// v1.16.0：收到完赛感想的**第一条**就把 raw 重写一遍（同一个文件）—— 那一节立刻进复盘。
				if (effect.record.type === 'closing-statement') await rewriteRaw(game);
				continue;
			}
			if (effect.type === 'room') {
				await sendRoom(game, effect.text, effect.mentions);
				receipt.rooms += 1;
				continue;
			}
			if (effect.type === 'dm') {
				receipt.dm += 1;
				// v1.11.0：弹窗模式的真人席位 —— 私密内容进弹窗队列，不落任何会话。
				// v1.14.0：`effect.options`（提问的按钮选项）一并带过去，只有它存在时才会写进记录。
				// v1.15.0：`effect.channel` 同理（`'room'` = 这张卡的回答要公开发进房间）。
				const ok = await deliverPrivate(game, effect.sessionId, effect.text, effect.seq, effect.wake !== false, effect.options, effect.channel);
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
			// v1.16.7：这个分支在结算后**每次** `runEffects` 都会跑到（赛后每来一条完赛感想就一次）。
			// raw 路径已定死为**开局时间** ⇒ `exportRaw()` 撞 `already exists` 即返回，重复调用是幂等的
			// （2026-10-05 第 8 局实测四份的成因：这里重复跑 + `rawExportPath()` 缺省用 `Date.now()`）。
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
	 * v1.9.0（B 方案）：**以某个席位的身份**把它的发言代投到房间。
	 *
	 * - 房间用 `game.roomId` —— 模型完全不碰房间名/房间 id，「进错房间」结构上不可能；
	 * - `author` 传该席位的会话 id ⇒ dsh-chat 按房间成员解析别名，气泡仍显示玩家名；
	 * - `text` 已含庄家生成的前缀，`mentions` 已由 `Game.speak()` 按顺序算好。
	 *
	 * 唯一失败模式是提及解析（别名漂移：房间里没有这个成员/有歧义）。这时**不能整条丢**：
	 * 退化为 `["all"]` 重发一次（发言必须落地），并**补一条私聊**唤醒下一位 ——
	 * 否则那条发言不唤醒任何人，而本机空转提醒是关的，整局就卡住了。
	 */
	async function sendAsSeat(game, intent) {
		const chat = ctx.dshChat.chat;
		const request = { roomId: game.roomId, author: intent.author, authorAlias: intent.authorAlias, text: intent.text, mentions: intent.mentions };
		try {
			await chat.send(request);
			return { ok: true, mentionDropped: false };
		} catch (error) {
			const message = String(error?.message ?? error);
			if (!/mention "/u.test(message)) {
				log('warn', `席位发言投递失败（${message}）`);
				return { ok: false, error: message };
			}
			log('warn', `席位发言的提及解析失败（${message}）；退化为 @all 并由私聊唤醒下一位`);
			await chat.send({ ...request, mentions: ['all'] });
			const nudged = game.nudge();
			if (nudged.error === undefined) await applyEffects(game, nudged.effects);
			return { ok: true, mentionDropped: true };
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
			const { no, path } = writeRawExport(game, { exportDir: settings.exportDir, chatstyle: settings.chatstyle, avatarFile: settings.avatarFile, humanName: settings.humanName });
			game.no = no;
			store.appendAudit(game.gameId, { at: Date.now(), type: 'export', path });
			store.saveState(game);
			log('info', `第${no}局 raw 已导出：${path}`);
		} catch (error) {
			if (String(error?.message ?? '').includes('already exists')) return;
			log('warn', `raw 导出失败：${String(error?.message ?? error)}`);
		}
	}

	/**
	 * v1.16.0：把「完赛感想」并进已经导出的那份 raw —— **重写同一个文件**（用户 2026-10-05 拍板）。
	 *
	 * 路径从审计里的 `export` 记录取（结算时写的那个）⇒ 进程重启后照样找得到，不依赖内存。
	 * 重写失败只记一条 warn：感想已经落在对局状态里，下一次收到还会再试，不会因为写盘失败而丢。
	 */
	async function rewriteRaw(game) {
		const record = store.readAudit(game.gameId).filter((item) => item.type === 'export').at(-1);
		if (record === undefined || typeof record.path !== 'string') return;
		try {
			writeRawExport(game, { exportDir: settings.exportDir, chatstyle: settings.chatstyle, avatarFile: settings.avatarFile, humanName: settings.humanName, path: record.path, overwrite: true });
			log('info', `完赛感想已并入 raw：${record.path}`);
		} catch (error) {
			log('warn', `raw 重写失败（感想仍在状态里，下一条感想到达时会再试）：${String(error?.message ?? error)}`);
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
			// v1.10.0：真人手打的那条**在落盘之前**就被 `rewriteHumanSpeech` 补好了前缀与提及
			// （dsh-chat 的发言适配器，见下面的注册）。所以这里不再有「先发原文、再删掉换规范版」
			// 这回事 —— 收到的已经是规范版，直接交给既有判定即可。
			if (event.speechRewritten === true) {
				store.appendAudit(game.gameId, { at: Date.now(), type: 'human-speech-takeover', seat: game.bySession(message.author)?.seat, messageId: message.id });
			}
			const effects = game.onRoomMessage({ authorSessionId: message.author, authorAlias: message.authorAlias, text: message.text, sentAt: message.sentAt });
			await runEffects(game, effects);
		});
	});
	ctx.effect(() => () => { try { unsubscribe?.(); } catch { /* 关闭期忽略 */ } });

	// ------------------------------------------------------------ 发言框接管（v1.10.0）

	/**
	 * v1.10.0（用户 2026-10-04 的要求）：**接管房间发言框** —— 真人在房间里手打的正文，
	 * 在**落盘之前**就被补成带前缀、带算好提及的规范版；不再有「先发原文、再删掉换一条」。
	 *
	 * 缝在 dsh-chat 的 `DshChatService.send()` 里、**构造消息之前**（见
	 * `PATCH-NOTES-dsh-chat.md` 补丁 20）：改写后的正文与提及直接用于建消息 ⇒ 落盘、投递、
	 * 唤醒都只发生这一次。返回 `null` = 不改写，照旧落原文。
	 *
	 * 接管条件全在 `game.speak()` 里（它同时负责生成规范版）：
	 * 本局在白天、没暂停、没终止、**而且现在正轮到这位真人**。不在他的轮次、投票阶段、
	 * 上诉流、没有对局、作者不是本局玩家 —— 一律 `null`，由既有判定处理（房间照旧能看到）。
	 *
	 * v1.11.0 起还在这里拦**房间里打的 `/ww-*` 命令**（见 `runRoomCommand`）。
	 */
	async function rewriteHumanSpeech({ roomId, author, text }) {
		const raw = String(text ?? '');
		// v1.11.0：房间里打的 /ww-* 命令 —— 先执行，再**吞掉**那条消息（不进房间）。
		// 只有宿主真的支持吞掉（dsh-chat 补丁 21 的 `supportsComposerConsume`）时才敢这么做：
		// 否则适配器回的 `{consume:true}` 会被忽略，命令正文会照常落进**公共**房间。
		if (canConsume === true) {
			const command = ROOM_COMMAND.exec(raw);
			if (command !== null && (await roomSideIds(roomId)).has(String(author))) {
				return await runRoomCommand(roomId, author, command[1], command[2]);
			}
		}
		const game = games.get(roomId);
		if (game === undefined) return null;
		// 上诉流（§10）：由 Host 脱敏回放，不该被加上发言前缀，原文照旧落房间。
		if (/申请庄家裁定|申请复议|上诉/u.test(raw)) return null;
		// 他若自己写了前缀（旧习惯），只取前缀后面的正文 —— 规范前缀由 `speak()` 重新生成，
		// 因此房间里不会出现两个前缀。
		const intent = game.speak(author, parseSpeechPrefix(raw)?.body ?? raw);
		if (intent.ok !== true) {
			// v1.16.3：`speak()` 拒了不等于"什么都不做" —— **AI 局里作者是观察员**（不是本局席位），
			// 他赛后点评赛时表现时要和参赛时同一条逻辑：第一条点评自动 AT 全体 AI，把他们唤醒来回话。
			// 判据双重：① 作者是**房间侧身份**（房间会话；不是别的会话/别的房间）；② 引擎那边**还没用过**
			// 这次点名（`closingPromptFor` 内部还会排掉玩家，并把它记进对局状态）。
			if ((await roomSideIds(roomId)).has(String(author))) {
				const prompt = game.closingPromptFor(String(author));
				if (prompt !== null) return { text: raw, mentions: prompt.mentions };
			}
			return null;
		}
		// v1.15.1：投票阶段 `speak()` 也会返回 ok（那是给 `wolf_speak` 的兜底）——
		// 但**投票一个字都不接管**（正文与提及都原样，acceptance 的「投票：不接管」用例守着）。
		if (intent.kind === 'vote') return null;
		// v1.16.2：**赛后第一条发言只接管提及** —— 真人自动 AT 全员（他一句「这局……」就把 AI 都唤醒，
		// 让他们顺着回话、顺便把感想说了）；正文仍然原样、不加任何前缀。
		return { text: intent.text, mentions: intent.mentions };
	}

	/** 房间里那类命令的识别式：`/ww-<名字> <参数…>`。 */
	const ROOM_COMMAND = /^\/(ww-[a-z0-9-]+)\s*([\s\S]*)$/u;

	/**
	 * v1.11.0：**在房间里执行一条 `/ww-*` 命令**（用户 2026-10-04：「所有命令直接在房间里执行」）。
	 *
	 * 调用者身份 = 房间会话（真人在房间里的身份）⇒ 处理器里的 `bySession(caller)` 照旧解析到他
	 * 那个席位，权限判定与私聊版本完全一致。**回执进弹窗队列**（可能含身份表这类秘密），
	 * 那条消息本身被适配器吞掉 ⇒ 房间里不留痕、AI 谁也看不到。
	 * @returns `{ consume: true }`。
	 */
	async function runRoomCommand(roomId, author, name, args) {
		const definition = roomCommands.get(name);
		if (definition === undefined) {
			const game = games.get(roomId);
			if (game !== undefined) pushMail(game, author, T.unknownRoomCommand(name, [...roomCommands.keys()].sort().join('、')), 'command-error');
			else log('info', `房间里出现未知命令 /${name}（本房间还没有对局，未回执）`);
			return { consume: true };
		}
		let result;
		try {
			result = await definition.handler({
				commandId: `room-${randomUUID()}`,
				agent: { session: { id: String(author) } },
				rawInput: String(args ?? ''),
				attachments: [],
				signal: new AbortController().signal
			});
		} catch (error) {
			result = { kind: 'error', text: String(error?.message ?? error) };
		}
		const failed = result?.kind === 'error';
		const text = typeof result?.text === 'string' && result.text.trim() !== '' ? result.text : (failed ? '命令执行失败（无详情）。' : '已完成。');
		// `/ww-start` 是例外：跑之前还没有对局、跑完才有 ⇒ 这里重新查一次。
		const game = games.get(roomId);
		if (game !== undefined) pushMail(game, author, text, failed ? 'command-error' : 'command');
		else log('info', `房间命令 /${name} 已执行（本房间还没有对局，回执无处投递）：${text}`);
		return { consume: true };
	}

	// ------------------------------------------------------------ 发言框动作条（v1.12.0）

	/**
	 * v1.12.0：房间发言框那一排**最右边**的「开局 / 真人 / 随机」。
	 *
	 * 声明给 dsh-chat（补丁 22 的 `actions`/`invoke`），由它画、由它把点击转回来 —— 位置固定是
	 * 「与提及按钮同一排、右对齐」。
	 *
	 * - **开局**：按房间**当前成员**一键开一局（纯 AI）；勾上「真人」会把你（`humanName`）也加进去。
	 * - **随机**：不按加入顺序，随机排全体玩家的发言顺序。
	 * - 只有「这个房间还没有进行中的对局」时才提供这排控件（开局后就收起来）。
	 * - **老房间（冷存、只读）一个控件都不给**（v1.13.2）：那种房间连发言都收不下
	 *   （dsh-chat 的 `send()` 直接拒绝），开局必然失败。判据用 dsh-chat 自己的
	 *   `room.coldStored === true`，见下面 `composerActionsFor` 里的说明。
	 * - 「真人」勾选框在缺 dsh-chat 补丁 21 时是禁用的 —— 弹窗模式开不了局（见 `startGame`）。
	 */
	async function composerActionsFor({ roomId }) {
		const game = games.get(roomId);
		if (game !== undefined && game.phase !== PHASE.SETTLED && game.phase !== PHASE.ENDED) return [];
		let room;
		let memberCount = 0;
		try {
			room = await ctx.dshChat.chat.resolveRoom(String(roomId));
			memberCount = (await roomAiSeats(room)).seats.length;
		} catch { room = undefined; memberCount = 0; }
		// v1.13.2（用户 2026-10-05）：「**老房间只是归档、没有会话功能**」⇒ 不注入任何控件。
		// 判据取 dsh-chat 自己的那条只读判据（`coldStored === true`，它的 `send()` 就是按它拒绝的），
		// 不另造口径；于是「同时只有一个活跃房间」这件事自然成立（冷存的都是老房间）。
		// dsh-chat 补丁 23 已在服务端先拦一道，这里是庄家自己的一道：插件升级把它的补丁冲掉时，
		// 老房间里也不会长出按钮。
		if (room?.coldStored === true) return [];
		return [
			{ id: 'start', label: T.composerStartLabel(), kind: 'button', hint: T.composerStartHint(memberCount, settings.humanName) },
			{
				id: 'human',
				label: T.composerHumanLabel(),
				kind: 'toggle',
				value: false,
				disabled: canConsume !== true,
				hint: canConsume === true ? T.composerHumanHint(settings.humanName) : T.composerHumanDisabledHint()
			},
			{ id: 'random', label: T.composerRandomLabel(), kind: 'toggle', value: false, hint: T.composerRandomHint() }
		];
	}

	/**
	 * 把房间当前成员换算成**纯 AI 席位**（给「一键开局」用）。
	 *
	 * 过滤掉：占位成员、房间侧身份、以及**已归档/已不存在**的会话 —— 后者会让那一棒永远没人接
	 * （本机空转提醒默认是关的，一卡就是干等）。过滤掉的成员名会回报给点击的人。
	 * @returns `{ seats, skipped }`；`seats` = `[{ name, human: false }]`，顺序 = 房间成员顺序。
	 */
	async function roomAiSeats(room) {
		const seats = [];
		const skipped = [];
		for (const member of room.members ?? []) {
			if (member?.kind !== 'session') continue;
			const id = String(member.sessionId ?? '');
			if (id === '') continue;
			if (id.startsWith(HUMAN_PLACEHOLDER_PREFIX)) continue;
			if (id === room.sessionId || id.startsWith(ROOM_SESSION_PREFIX)) continue;
			let state = 'unknown';
			try { state = String((await ctx.dshBridge.status(id))?.state ?? 'unknown'); } catch { state = 'unknown'; }
			if (state === 'missing' || state === 'archived') {
				skipped.push(String(member.alias ?? id));
				continue;
			}
			seats.push({ name: String(member.alias ?? id), human: false });
		}
		return { seats, skipped };
	}

	/** Fisher–Yates：勾了「随机」时用它决定发言顺序（返回同一个数组）。 */
	function shuffle(list) {
		for (let index = list.length - 1; index > 0; index -= 1) {
			const other = Math.floor(Math.random() * (index + 1));
			[list[index], list[other]] = [list[other], list[index]];
		}
		return list;
	}

	/**
	 * 执行「开局」按钮。**永不抛**：失败也回 `{ok:false, text}`，由前端显示给点击的人。
	 * 人数规则（§总卡数）：3–6 人；少于 3 人拒绝，7 人及以上没有规则也拒绝。
	 */
	async function invokeComposerAction({ roomId, id, values }) {
		if (id !== 'start') return { ok: false, text: T.composerUnknownAction(id) };
		let room;
		try {
			room = await ctx.dshChat.chat.resolveRoom(String(roomId));
		} catch (error) {
			return { ok: false, text: `找不到房间：${String(error?.message ?? error)}` };
		}
		// v1.13.2：老房间（冷存、只读）开不了局 —— 房间连消息都收不下（dsh-chat 的 `send()` 直接拒绝）。
		// 控件本来就不会出现，这条兜的是「旧页面 + 旧勾选状态」还能点到的情形：明确告诉人为什么。
		if (room.coldStored === true) return { ok: false, text: T.composerArchivedRoom(room.name) };
		const existing = games.get(room.id);
		if (existing !== undefined && existing.phase !== PHASE.SETTLED && existing.phase !== PHASE.ENDED) {
			return { ok: false, text: T.composerBusyRoom(existing.gameId) };
		}
		const withHuman = values?.human === true;
		if (withHuman && canConsume !== true) return { ok: false, text: T.composerHumanDisabledHint() };
		const { seats, skipped } = await roomAiSeats(room);
		const plan = [...seats];
		if (withHuman) plan.push({ name: settings.humanName, human: true });
		if (plan.length < MIN_MODE) return { ok: false, text: T.composerTooFew(plan.length, withHuman, settings.humanName) };
		if (plan.length > MAX_MODE) return { ok: false, text: T.composerTooMany(plan.length) };
		const random = values?.random === true;
		const order = random ? shuffle(plan) : plan;
		try {
			const result = await startGame({ roomRef: room.id, mode: order.length, seats: order });
			const names = order.map((seat) => `${seat.name}${seat.human === true ? '（真人）' : ''}`).join(' → ');
			return { ok: true, text: T.composerStarted(result.no, order.length, names, random, skipped) };
		} catch (error) {
			return { ok: false, text: `开局失败：${String(error?.message ?? error)}` };
		}
	}

	/**
	 * 发言框上那行只读提示（前缀 + 点名对象）。**纯展示**：前端不拿它拼接正文，
	 * 所以这个提示滞后一两秒也不会写坏消息（真正的改写由上面的 `rewriteHumanSpeech` 做）。
	 */
	async function composerRuleFor({ roomId }) {
		const game = games.get(roomId);
		if (game === undefined) return null;
		const plan = game.speechPlan();
		if (plan === null) return null;
		return { prefix: plan.prefix, hint: plan.next === null ? T.speechPlanLast() : T.speechPlanNext(plan.next) };
	}

	const chat = ctx.dshChat.chat;
	// v1.11.0：宿主会不会真的把 `{consume:true}` 当真吞掉？拿不到这个能力时**绝不在房间里拦截命令**
	// （适配器回的 consume 会被忽略 ⇒ 命令正文照常落进公共房间），并拒绝「弹窗模式」开局。
	const canConsume = chat.supportsComposerConsume === true;
	if (typeof chat.setComposerAdapter === 'function') {
		// v1.12.0：除了改写（补丁 20）与吞掉（补丁 21），还借同一条缝声明**发言框动作条**（补丁 22）。
		chat.setComposerAdapter({ rewrite: rewriteHumanSpeech, rule: composerRuleFor, actions: composerActionsFor, invoke: invokeComposerAction });
		ctx.effect(() => () => { try { chat.setComposerAdapter(undefined); } catch { /* 关闭期忽略 */ } });
		log('info', '发言框接管已注册（白天轮到真人时，他手打的正文会在落盘前补上前缀与点名）');
	} else {
		log('warn', 'dsh-chat 未装「发言框接管」补丁（没有 setComposerAdapter）：真人在房间里只打正文会因缺前缀被判无效 —— 请按 PATCH-NOTES-dsh-chat.md 重打补丁 20');
	}
	if (canConsume !== true) {
		log('warn', 'dsh-chat 未装「吞掉消息」补丁（没有 supportsComposerConsume）：房间里打 /ww-* 不会被拦下，真人席位请用 `*名字=<会话>` 的老玩法（补丁 21 见 PATCH-NOTES-dsh-chat.md）');
	} else {
		log('info', '房间内命令已启用（在房间里打 /ww-*：命令被拦下执行，回执走弹窗，房间不留痕）');
	}

	// 重启续局：把未结束的对局读回内存（§8 私有存储）。
	for (const data of store.listResumable()) {
		try {
			const game = Game.fromJSON(data);
			// v1.19.0：投票限时（先催后判）—— 续局也把配置挂上（引擎只存配置，判定在 `tickVoteDeadline`）。
			game.voteLimits = { deadlineMs: settings.voteDeadlineMs, graceMs: settings.voteGraceMs };
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

	// v1.19.0（用户 2026-10-06 定）：**投票限时 —— 先催后判**（真人豁免）。
	// 到点先给未投的 AI 席位催一次票；再宽限一段仍不投 ⇒ 记弃权并推进结算。
	// ⚠ 判定必须**在同一个串行队列里**做（它会写票、甚至推进结算），不能先算 effects 再排队。
	if (settings.voteDeadlineMs > 0) {
		// 检查频率：足够密，不会错过判弃权的时刻；也不至于空转太频繁。
		const step = Math.max(1000, Math.min(15000, Math.round(settings.voteDeadlineMs / 3)));
		const voteTimer = setInterval(() => {
			for (const game of games.values()) {
				if (game.phase !== PHASE.VOTE) continue;
				enqueue(() => {
					const effects = game.tickVoteDeadline({ deadlineMs: settings.voteDeadlineMs, graceMs: settings.voteGraceMs });
					return effects.length === 0 ? undefined : runEffects(game, effects);
				});
			}
		}, step);
		voteTimer.unref?.();
		ctx.effect(() => () => clearInterval(voteTimer));
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
		if (mode < MIN_MODE || mode > MAX_MODE) throw new Error(`局型只能是 ${MIN_MODE}–${MAX_MODE}（7 人及以上没有规则）`);
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
			// v1.11.0：真人**不写 `=`**（只写 `*名字`）= **弹窗模式** —— 私密内容不进任何会话，
			// 只写进局内弹窗信箱、由浏览器浮层显示。前提是房间里的 `/ww-*` 能被拦下
			// （dsh-chat 补丁 21 的 consume）；没有那条能力就**拒绝**这种玩法，退回 `*名字=<会话>`。
			const popupSeat = seat.human === true && seat.ref === undefined;
			if (popupSeat && canConsume !== true) throw new Error(T.humanPopupNeedsPatch(seat.name, roomSideIds[0]));
			// 显式把私密信道写成房间自身会话：那既不是弹窗模式、也收不到私聊（房间视图里看不到），
			// 一律拒绝并告诉他两种正确写法。
			if (seat.human === true && seat.ref !== undefined && roomSideIds.includes(seat.ref)) {
				throw new Error(T.humanNeedsChannel(seat.name, roomSideIds[0]));
			}
			if (popupSeat) {
				sessionId = roomSideIds[0];
			} else if (seat.ref !== undefined) {
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
					throw new Error(`房间成员里找不到「${seat.name}」（命中 ${hit.length} 个）；当前成员：${members.map((member) => member.alias ?? member.sessionId).join('、') || '（无）'}`);
				}
				sessionId = hit[0].sessionId;
			}
			const chanIds = [];
			if (seat.human === true) {
				if (!popupSeat && roomSideIds.includes(sessionId)) throw new Error(T.humanNeedsChannel(seat.name, roomSideIds[0]));
				chanIds.push(...roomSideIds);
			}
			players.push({ name: seat.name, sessionId, chanIds, human: seat.human === true });
		}

		const no = nextGameNo(settings.exportDir);
		const gameId = `${sanitize(room.id)}-第${no}局`;
		const seed = request.seed === undefined || request.seed === null || request.seed === '' ? undefined : Number(request.seed);
		const game = new Game({ roomId: room.id, roomName: room.name, mode, players, seed, gameId, no });
		// v1.19.0（用户 2026-10-06 定）：投票限时（先催后判）—— 开票公告要用它写期限行。
		game.voteLimits = { deadlineMs: settings.voteDeadlineMs, graceMs: settings.voteGraceMs };
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
			// v1.21.0：确认阶段报「已确认 N/M」（不限时，没回的人在 /ww-nudge 里能逐个看到）
			status.phase === 'ready' ? `已确认进入投票 ${status.readyIn}/${game.players.length}${status.readyIn >= game.players.length ? '' : '（还没齐 —— /ww-nudge 催，或 /ww-close-vote 跳过）'}` : '',
			receipts.length === 0 ? '' : `私聊投递：成功 ${receipts.filter((entry) => entry.ok).length}／失败 ${failed.length}${recent.length === 0 ? '' : `（最近：${recent.join(' ')}）`}`,
			failed.length === 0 ? '' : `⚠ 未送达：${[...new Set(failed.map((entry) => `${entry.seat === null ? '' : `${entry.seat}.`}${entry.name}`))].join('、')}`,
			`座位：${status.seats.join(' → ')}`
		].filter((line) => line !== '').join('\n');
	}

	// ------------------------------------------------------------ 工具（模型侧）

	ctx.tools.register({
		name: 'wolf_speak',
		// v1.16.1：把「**狼人杀专用**」在工具层钉死 —— AI 会把它当通用发消息工具用，
		// 而它只在局内有效（没有对局时一个字都不发）。局外要发消息得用 chat_send。
		description: '一夜狼人杀**专用**工具：把你这轮在**本局房间里**要说的话交给庄家代投（只给正文）—— 白天发言、投票（「投票：<座位名>」或「投票：平安夜」）、赛后的完赛感想都用它。前缀【RN-K · 别名】与提及（唤醒下一位；投票与赛后**不唤醒任何人**）全由庄家按状态算：不要自己写前缀、不要自己填 mentions、也不要自己指定房间。**只在狼人杀局内有效**：没轮到你、或你当前没有参与中的对局时，它一律**不投递**、只回一句原因 —— 局外想往房间发消息请用 chat_send。',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: { text: { type: 'string', description: '你要说的话（白天发言只给正文；投票写「投票：<座位名>」或「投票：平安夜」；赛后感想直接写正文）。不要写【R…】前缀、不要写 @ 提及，庄家会补。' } },
			required: ['text']
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: { status: { type: 'string', enum: ['accepted', 'rejected', 'failed'] }, note: { type: 'string' } },
				required: ['status', 'note']
			},
			render: (_args, value) => [{ type: 'text', text: value.note }]
		},
		async execute(args, exec) {
			const sessionId = exec.agent?.session?.id;
			if (sessionId === undefined) throw new Error('wolf_speak 需要由会话调用');
			const body = String(args?.text ?? '').trim();
			if (body === '') throw new Error('wolf_speak 需要非空的 text（只放正文）');
			const session = String(sessionId);
			let target;
			for (const game of games.values()) {
				if (target === undefined && game.bySession(session) !== undefined) target = game;
			}
			if (target === undefined) return { status: 'rejected', note: '当前没有你参与的对局；本条未投递。' };

			// 轮次/前缀/提及全部由引擎按自己的状态算；不合格就**什么都不发**。
			const intent = target.speak(session, body);
			// v1.18.0（用户 2026-10-06）：**首投落定**。同内容重发 ⇒ 幂等回执（`accepted`，让模型知道
			// "票还在、不必再试"，也不必绕道 chat_send）；内容不同/认不出 ⇒ 拒绝。
			// 两种都**没有投递** —— 引擎侧就挡下了，房间不留第二只气泡。
			if (intent.ok !== true) {
				if (intent.locked === true && intent.same === true) return { status: 'accepted', note: intent.reason };
				return { status: 'rejected', note: intent.reason };
			}

			// 只投递。引擎的步进照旧由房间里那条消息回流触发（同一条路径，不另开分支）。
			const posted = await sendAsSeat(target, intent);
			if (posted.ok !== true) return { status: 'failed', note: `投递失败：${posted.error}。可以再调一次 wolf_speak 重试（本条未计入发言）。` };

			// v1.15.1：投票阶段也认它 —— 正文原样公开投进房间（是不是有效票由票型解析判定；
			// 认不出来时庄家会私聊让你重发，所以这里不必替它猜）。
			// v1.18.0：**一票落定不可撤改** —— 落定之后再调本工具连房间都到不了（上面那条预检），
			// 所以这条回执的语义就是"你的票已进房间、且从此定下"。
			if (intent.kind === 'vote') {
				return { status: 'accepted', note: '已作为公开投票投到房间；本票已落定，重发不覆盖（改票会被拒）。若格式不对，庄家随后会私聊让你重发。' };
			}
			// v1.16.0：结算之后的完赛感想（每人只收第一条进复盘）。
			if (intent.kind === 'closing') {
				return { status: 'accepted', note: '已作为完赛感想投到房间（每人只收第一条进复盘）。' };
			}

			const parts = [`已代投到房间（第 ${intent.round} 轮第 ${intent.index} 位）。`];
			if (intent.final === true) parts.push('你是全场最后一位，发言阶段到此结束。');
			else if (intent.next !== null) parts.push(`下一位 ${intent.next} 已被唤醒。`);
			if (posted.mentionDropped === true) parts.push('（提及解析失败：本条以广播落地、不点名，下一位改由私聊唤醒。）');
			return { status: 'accepted', note: parts.join('') };
		}
	});

	ctx.tools.register({
		name: 'wolf_reply',
		description: '一夜狼人杀：把夜间回答或**确认阶段**的回话私下发给庄家。夜间：只在庄家私聊问你（验人/换卡）时使用；确认阶段：庄家问「是否进入投票阶段？」时用它回一个字「是」。房间里的公开发言请用 wolf_speak（只给正文，前缀与提及由庄家补），不要用本工具。★庄家私发你的内容（验人读数 / 换卡结果 / 格式复问）**就在本工具的返回值里**——结果看返回值，不要去轮询收件箱。',
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
			// v1.16.13（用户 2026-10-06 拍板 · A 方案）：AI 席位的「读数 / 换卡结果 / 复问」不再另发一条私信，
			// 改为**随本次返回值直给**。引擎层不变（照常产生那条 `wake:true` 的 dm effect），摘除只发生在本层。
			// 依据：`wake:true` 的私信要走 next-turn 队列，得等对方**当前 turn 结束**才被 claim
			// （2026-10-06 局10 实测：03:43:55 投递 → 03:46:14 才落成可见消息，延迟 139.3 秒），
			// 而 tool result **当场**就是下一个 step 的输入 ⇒ 更快，且省一条消息 + 一次唤醒 + 一个模型轮次。
			// 内容与原私信逐字相同（`T.replyReturn` 只加一层信封）。真人席位（`human === true`）不走这里：
			// 它的私信要进弹窗/信箱，照旧投递。
			const caller = target.bySession(session);
			const handed = (caller !== undefined && caller.human !== true)
				? effects.filter((effect) => effect.type === 'dm' && effect.sessionId === session)
				: [];
			for (const effect of handed) {
				// 摘掉的那条私信在投递侧不再留痕 ⇒ 补一条审计（**只记元信息、不记内容**），
				// 免得日后又出现"庄家到底发没发"只能去翻别人会话日志的场面。
				store.appendAudit(target.gameId, {
					at: Date.now(), type: 'dm-returned', secret: true,
					seat: caller.seat, seq: effect.seq, chars: String(effect.text).length
				});
			}
			await applyEffects(target, handed.length === 0 ? effects : effects.filter((effect) => handed.includes(effect) === false));
			const auditTypes = effects.filter((effect) => effect.type === 'audit').map((effect) => effect.record.type);
			if (auditTypes.includes('reply-unexpected')) {
				// 发牌、同伴信息这类**通报**不是提问：回它只会进档。首轮测试里两名 AI 都踩了这个坑。
				return { status: 'no-pending', note: '当前没有等待你回答的问题（发牌、同伴信息这类通报不需要回复）；本条只记了档，庄家不会回应内容。' };
			}
			// v1.21.0（用户 2026-10-06 定）：**确认阶段**（庄家问「是否进入投票阶段？」）
			if (auditTypes.includes('ready-confirm')) {
				return { status: 'accepted', note: target.phase === PHASE.VOTE ? '已确认；全场已齐 —— 进入投票阶段。' : '已确认（还在等其他人）。' };
			}
			if (auditTypes.includes('ready-unparsed')) return { status: 'accepted', note: '已收到 —— 这里只认「是」，庄家随后会私聊让你重发（照它回一个字：是）。' };
			if (auditTypes.includes('ready-dup')) return { status: 'accepted', note: '你已经确认过了（不用再回）。' };
			// v1.16.13：庄家私发的内容（含复问、读数、换卡结果）已经随返回值给出 ⇒ 优先原样回它。
			if (handed.length > 0) return { status: 'accepted', note: T.replyReturn(handed.map((effect) => effect.text).join('\n')) };
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
				mode: { type: 'integer', enum: [3, 4, 5, 6], description: '局型：3–6 人局（7 人及以上没有规则）。' },
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

	// ── v1.17.0：给 AI 席位的「叫停键」（默认关闭，由 cordis.patch.yml 的 aiPauseTool 打开）────────
	//
	// 用户 2026-10-06 的要求与原话要旨：局10 里预言家没收到读数，是**用户自己翻它的会话、看它的思考链**
	// 才发现的 ——「我需要 AI 也有暂停游戏的命令……这样它们那里出了问题，第一时间会想到先暂停游戏，
	// 我就能及时发现问题，而不是像这样看我自己去查」。
	//
	// 四条设计取舍：
	// ① **只给暂停、不给恢复**（单向阀门）。恢复是观察员的判断；模型若能自己起，这个键就变成"停一下再试"。
	// ② **理由必填**。这个工具的价值一半在"停"，一半在"它看到了什么" —— 没有理由的暂停等于没报障。
	// ③ **正文只给人看**：报障（含理由）进**弹窗信箱**（`inbox` 端点不按 `to` 过滤，浮层全局可见 ⇒
	//    人立刻看到）+ 审计（`secret`，不进复盘 raw）。**理由不进房间** —— 它可能带模型自己的判断与身份
	//    线索；房间只保留引擎 `setPaused()` 已有的那条中性公告。
	// ④ **默认关闭、关闭时根本不注册**：把"暂停"交给模型只适合看局/排障时临时开；关着时它连工具表里
	//    都看不到这个键，不会去想它。
	if (settings.aiPauseTool) {
		ctx.tools.register({
			name: 'wolf_pause',
			description: '一夜狼人杀：**发现你无法处理的异常时，立刻暂停本局并报障** —— 例：该收到的信息（读数 / 换卡结果 / 提问 / 轮到你）一直没到、状态与规则明显不符、庄家的行为无法解释。暂停后整局停止推进，**观察员会立刻收到你写的理由**；恢复只能由人做（你没有恢复工具）。只在真有异常时用：不要用它抢时间，也不要当策略。',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					reason: { type: 'string', description: '一句话说清：你看到了什么、你以为应该是什么（例：我回了「2」，但一直没收到读数）。' }
				},
				required: ['reason']
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: { status: { type: 'string', enum: ['paused', 'already-paused', 'rejected'] }, note: { type: 'string' } },
					required: ['status', 'note']
				},
				render: (_args, value) => [{ type: 'text', text: value.note }]
			},
			async execute(args, exec) {
				const sessionId = exec.agent?.session?.id;
				if (sessionId === undefined) throw new Error('wolf_pause 需要由会话调用');
				const reason = String(args?.reason ?? '').trim();
				if (reason === '') throw new Error('wolf_pause 需要非空的 reason：请写清你看到了什么、你以为应该是什么');
				const session = String(sessionId);
				let target;
				for (const game of games.values()) {
					if (game.bySession(session) !== undefined) { target = game; break; }
				}
				if (target === undefined) {
					return { status: 'rejected', note: '你不是任何进行中对局的席位，本工具只给局内玩家用；要暂停请让观察员用 /ww-pause。' };
				}
				const seat = target.bySession(session);
				const wasPaused = target.paused === true;
				// 引擎自会发房间里那条中性公告（`T.paused()`）+ 记 `pause` 审计 + 落盘；已暂停时它只记一条 noop。
				await applyEffects(target, target.setPaused(true));
				// 报障正文只给人看：先弹窗（未读队列，人在哪个页面都能看到），再落审计（secret，不进复盘）。
				const alert = T.aiPauseAlert(seat.seat, seat.name, reason, target.no);
				pushMail(target, 'observer', alert, 'alert');
				store.appendAudit(target.gameId, { at: Date.now(), type: 'ai-pause', secret: true, seat: seat.seat, name: seat.name, reason, alreadyPaused: wasPaused });
				log('warn', `AI 席位请求暂停：${target.gameId} 座位${seat.seat}（${seat.name}）—— ${reason}`);
				return wasPaused
					? { status: 'already-paused', note: '本局本来就是暂停状态；你的报障已记档并已通知观察员。恢复要等人做。' }
					: { status: 'paused', note: '已暂停本局，观察员已收到你的报障（理由已记录）。恢复只能由人做，等观察员处理完再继续。' };
			}
		});
	} else {
		log('info', '「AI 叫停键」wolf_pause 未启用（默认关闭）；要打开就在 cordis.patch.yml 的 werewolf-dealer 行写 aiPauseTool: true 并重启 DSH');
	}

	// ------------------------------------------------------------ 弹窗信箱（v1.11.0）

	/**
	 * v1.11.0：**弹窗模式**真人的私密信道。
	 *
	 * 用户 2026-10-04 的要求：「信箱会话也可以去掉，所有命令直接在房间里执行，信息用弹窗给我」。
	 * 于是：房间里的 `/ww-*` 被发言适配器拦下执行（见 `runRoomCommand`），而**发牌 / 验人结果 /
	 * 夜序提问 / 命令回执**这些不能公开的内容**不进任何会话** —— 只写进本局的
	 * `<gameId>.mail.jsonl`，再由 `/api/dsh-werewolf` 的 `inbox` 端点吐给浏览器，由客户端半边
	 * 画成浮层卡片（`shell.overlay`）。
	 *
	 * ⇒ 秘密不进任何 LLM 上下文，也不在任何会话里留痕（比"投给一个专用会话"更干净）。
	 * 代价是**没有持久留痕**：靠「未读队列 + 关掉才推进游标」保证不丢，`/ww-inbox` 可重弹。
	 */
	let mailSeq = 0;
	function pushMail(game, to, text, kind, options, channel) {
		mailSeq += 1;
		const record = { seq: mailSeq, at: Date.now(), gameId: game.gameId, room: game.roomName, to: String(to), kind: kind ?? 'dealer', text: String(text ?? '') };
		// v1.14.0：**弹窗按钮的选项**（`[{ label, text }]`，见 engine 的 `#dmSeat`）。有它在，
		// 客户端就把这张卡画成一排按钮；`text` 是引擎自己认识的答案 ⇒ 点按钮与手打 `/ww-reply` 同路。
		if (Array.isArray(options) && options.length > 0) record.options = options;
		// v1.15.0：这张卡的回答该走哪条信道（`'room'` = 投票，要以他的席位身份公开投进房间）。
		if (channel !== undefined) record.channel = channel;
		try {
			store.appendMail(game.gameId, record);
		} catch (error) {
			log('warn', `弹窗信箱写入失败（这条只留在内存里）：${String(error?.message ?? error)}`);
		}
		return record;
	}
	// 进程重启后把全局单调序号接上：不接的话新消息 seq 从 1 重来，而浏览器记着旧游标 ⇒ 永远拉不到。
	mailSeq = store.maxMailSeq();

	/** `/api/dsh-werewolf` 的端点表（形状照 dsh-chat 的 `/api/dsh-chat`：POST + RpcResult 信封）。 */
	const mailboxEndpoints = {
		/**
		 * 拉取弹窗消息（增量）：`since` = 浏览器上次**确认读过**的序号，0 = 从未看过。
		 * 返回所有未结束对局的记录 —— 浮层是全局的，人在哪个页面都该看到。
		 */
		inbox: ({ since = 0, limit = 20 } = {}) => {
			const from = Number.isFinite(since) && since > 0 ? since : 0;
			const cap = Math.min(Math.max(Number.isFinite(limit) ? limit : 20, 1), 100);
			const records = [];
			for (const game of games.values()) {
				if (game.phase === PHASE.SETTLED || game.phase === PHASE.ENDED) continue;
				for (const record of store.readMail(game.gameId, from)) records.push(record);
			}
			records.sort((a, b) => a.seq - b.seq);
			return { records: records.slice(0, cap), seq: mailSeq, more: records.length > cap };
		},
		/**
		 * v1.14.0：**点按钮回答** —— 与手打 `/ww-reply <回答>` 是**同一条入口**
		 * （`game.onPrivateReply` + `applyEffects`，同一把串行锁），只是把"人打的字"换成
		 * "按钮上写好的那串字"（`option.text`）。所以按钮与保底命令的行为必然一致。
		 *
		 * 授权口径：本端点与 `inbox` 同一道门（loopback + `/api` 浏览器围栏、单用户本机）；
		 * `to` 必须真是这一局里的席位（`bySession` 校验），引擎自己还会再判一次
		 * 「当前是不是在等他回答」—— 答非所问只记一条 `reply-unexpected`，不改任何状态。
		 *
		 * v1.15.0：`channel: 'room'` 的卡（投票）走另一条路 —— 以该席位身份把答案**公开发进房间**，
		 * 并校验当前确实在投票阶段（见下面的分支）。
		 */
		reply: async ({ gameId, to, text, channel } = {}) => {
			const id = String(gameId ?? '');
			const answer = typeof text === 'string' ? text.trim() : '';
			if (answer === '') return { ok: false, text: '按钮没带答案（reply 需要非空 text）。' };
			const game = [...games.values()].find((item) => item.gameId === id);
			if (game === undefined) return { ok: false, text: `找不到对局 ${id}（可能已结束或 DSH 重启过）。` };
			const player = game.bySession(String(to ?? ''));
			if (player === undefined) return { ok: false, text: `对局 ${id} 里没有这个席位。` };
			// v1.15.0：**投票卡**（`channel: 'room'`）的回答是公开的 —— 以他的席位身份把这条
			// 投进房间（与他自己手打一字不差），引擎照旧从房间消息回流里收票
			// （`onRoomMessage` → `parseVote`），**不新增第二条解析路径**。
			// 卡的 `channel` 必须与**当前阶段**对得上：陈旧卡片（夜间提问在投票阶段被点）绝不能被
			// 当成一条公开消息发进房间。
			if (channel === 'room') {
				if (game.phase !== PHASE.VOTE) return { ok: false, text: '现在不在投票阶段，这张卡已经过期了。' };
				try {
					await ctx.dshChat.chat.send({ roomId: game.roomId, author: String(player.sessionId), authorAlias: player.name, text: answer, mentions: [] });
				} catch (error) {
					return { ok: false, text: `这条投票没能发进房间：${String(error?.message ?? error)}` };
				}
				return { ok: true, text: '' };
			}
			const effects = game.onPrivateReply({ sessionId: player.sessionId, text: answer });
			await applyEffects(game, effects);
			const unexpected = effects.some((effect) => effect.type === 'audit' && effect.record.type === 'reply-unexpected');
			if (unexpected) return { ok: false, text: '当前没有等待你回答的问题。' };
			return { ok: true, text: '' };
		}
	};
	const mailboxFailure = (code, message) => ({ ok: false, error: { code, message, details: {} } });
	async function handleMailboxRequest(request) {
		const answer = (envelope) => new Response(JSON.stringify(envelope), { status: 200, headers: { 'content-type': 'application/json' } });
		let payload;
		try {
			payload = await request.json();
		} catch {
			return answer(mailboxFailure('bad-request', 'request body is not JSON'));
		}
		const endpoint = payload?.endpoint;
		const handler = typeof endpoint === 'string' && Object.hasOwn(mailboxEndpoints, endpoint) ? mailboxEndpoints[endpoint] : undefined;
		if (handler === undefined) return answer(mailboxFailure('bad-request', `unknown dsh-werewolf endpoint: ${String(endpoint)}`));
		try {
			return answer({ ok: true, value: await handler(payload?.args ?? {}) });
		} catch (error) {
			return answer(mailboxFailure('internal', String(error?.message ?? error)));
		}
	}
	if (typeof ctx.inject === 'function') {
		// 动态注入：`connection` 不在本插件的静态 inject 列表里（缺了它整个插件会变 inactive），
		// 这里等它出现即可 —— 与 dsh-chat 注册 /api/dsh-chat 同一套（loopback + /api 围栏）。
		ctx.inject(['connection'], (connectionCtx) => {
			connectionCtx.effect(() => connectionCtx.connection.fetch.register({
				path: '/api/dsh-werewolf',
				methods: ['POST'],
				requestBody: 'buffered',
				fetch: (request) => handleMailboxRequest(request)
			}), 'werewolf-dealer: mailbox route');
		});
	} else {
		log('warn', '宿主没有 ctx.inject：弹窗信箱端点未注册（真人席位仍可用 `*名字=<会话>` 的老玩法）');
	}

	/** 房间侧身份集合（房间会话 id + 约定前缀拼出来的那个），按 roomId 缓存。 */
	const roomSideCache = new Map();
	async function roomSideIds(roomId) {
		const key = String(roomId);
		if (!roomSideCache.has(key)) {
			const ids = new Set([`${ROOM_SESSION_PREFIX}${key}`]);
			try {
				const room = await ctx.dshChat.chat.resolveRoom(key);
				if (typeof room?.sessionId === 'string' && room.sessionId !== '') ids.add(room.sessionId);
			} catch {
				// 房间已经不在了：只用前缀拼出来的那个（够做绑定合法性判定）。
			}
			roomSideCache.set(key, ids);
		}
		return roomSideCache.get(key);
	}

	/** 该席位是不是「弹窗模式」真人（私密内容不落会话）。判据：他的私聊信道就是房间侧身份。 */
	async function isPopupSeat(game, sessionId) {
		const player = game.bySession(sessionId);
		if (player?.human !== true) return false;
		return (await roomSideIds(game.roomId)).has(String(player.sessionId));
	}

	/** 私密投递：弹窗模式 ⇒ 进弹窗队列；绑了信箱的真人 / AI 席位 ⇒ 照旧走 dsh-bridge。 */
	async function deliverPrivate(game, sessionId, text, seq, wake, options, channel) {
		if (await isPopupSeat(game, sessionId)) {
			pushMail(game, sessionId, text, 'dealer', options, channel);
			return true;
		}
		return await sendPrivate(game, sessionId, text, seq, wake);
	}

	// ------------------------------------------------------------ 命令（人类观察员侧 §10）

	registerCommand({
		name: 'ww-start',
		description: '开局：/ww-start <房间名> <3|4|5|6> <玩家1> <玩家2> … [seed=数字]（复盘写手结算后按胜负判定，不用指定）',
		input: { hint: '房间名 3|4|5|6 玩家名…' },
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

	registerCommand({
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

	registerCommand({
		name: 'ww-pause',
		description: '暂停当前对局：/ww-pause [房间名]',
		async handler(invocation) {
			return commandWithGame(invocation, async (game) => {
				await applyEffects(game, game.setPaused(true));
				return '对局已暂停。';
			});
		}
	});

	registerCommand({
		name: 'ww-resume',
		description: '恢复当前对局：/ww-resume [房间名]',
		async handler(invocation) {
			return commandWithGame(invocation, async (game) => {
				await applyEffects(game, game.setPaused(false));
				return '对局已恢复。';
			});
		}
	});

	registerCommand({
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

	registerCommand({
		name: 'ww-recount',
		description: '重算当前票型（只看已收到的票，不改状态）：/ww-recount [房间名]',
		async handler(invocation) {
			return commandWithGame(invocation, async (game) => {
				await applyEffects(game, game.effectsForAudit([{ type: 'recount' }]));
				return game.recount().text;
			});
		}
	});

	registerCommand({
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

	registerCommand({
		name: 'ww-close-vote',
		description: '截止收票并结算（缺票者记为弃票）；在**确认阶段**则跳过等待、直接进入投票：/ww-close-vote [房间名]',
		async handler(invocation) {
			return commandWithGame(invocation, async (game) => {
				// v1.21.0：确认阶段不限时 ⇒ 观察员用同一个命令跳过等待（未确认者照旧进投票阶段）
				if (game.phase === PHASE.READY) {
					await applyEffects(game, game.skipReady());
					return '已跳过确认等待，直接进入投票阶段。';
				}
				if (game.phase !== PHASE.VOTE) throw new Error('当前不在投票阶段（也不在确认阶段）');
				await applyEffects(game, game.closeVote('observer'));
				return '已截止收票并结算。';
			});
		}
	});

	registerCommand({
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
			// v1.16.5（用户 2026-10-05 实测）：`/ww-nudge 大D` 把"大D"当**房间名**送去 resolveRoom
			// ⇒ dsh-chat 抛 `room "大D" does not exist`（观察员看到的"大D不存在"）。位置参数先按房间名
			// 解析，房间不存在时**退一步当席位名**（席位是否存在由 `game.nudge()` 判定，报错里会列
			// 本局席位与真正该动的人）。
			const roomRef = positional.join(' ');
			let game;
			if (roomRef === '') {
				game = await pickGame('');
			} else {
				try {
					game = await pickGame(roomRef);
				} catch (error) {
					if (seatRef !== undefined) throw error;   // 显式写了 seat= ⇒ 不再兜底，免得掩盖打错的房间名
					seatRef = roomRef;
					game = await pickGame('');
				}
			}
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

	registerCommand({
		name: 'ww-nudge',
		description: '催当前该行动的人（观察员手动触发，无计时器）：/ww-nudge [seat=<座位名|座位号>] [房间名]；也可以直接写 /ww-nudge <座位名>（先按房间名解析，不存在再当座位名）。夜间催等待回复者、白天催当前应发言者、投票期催未投票者；报告里会给每个被催会话的实时状态。',
		input: { hint: '[seat=<座位>] [房间名]' },
		async handler(invocation) {
			return nudgeCommand(invocation);
		}
	});

	registerCommand({
		name: 'ww-night',
		description: '（旧名，等价于 /ww-nudge）重新提醒当前夜序等待者：/ww-night [房间名]',
		async handler(invocation) {
			return nudgeCommand(invocation);
		}
	});

	registerCommand({
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
					`AI 叫停键 wolf_pause：${settings.aiPauseTool ? '**已开启**（AI 工具表里多一个 wolf_pause：发现异常可暂停本局并把理由弹给观察员；恢复仍只能由人做）' : '关闭（默认，AI 没有这个工具）'}（来源：${source('aiPauseTool')}）`,
					`投票限时：${settings.voteDeadlineMs === 0 ? '**关闭**' : `开票后 ${settings.voteDeadlineMs / 60000} 分钟先催票，再宽限 ${settings.voteGraceMs / 60000} 分钟（合计 ${(settings.voteDeadlineMs + settings.voteGraceMs) / 60000} 分钟）仍未投的 **AI 席位记弃权**（真人席位豁免）`}（来源：${source('voteDeadlineMs')}）`,
					'复盘写手：**开局不再指定**，结算后按胜负判定（赢家独一份 ⇒ 写赢家；败者独一份 ⇒ 写败者；其余 ⇒ 排序第一个 AI）。',
					'改配置：编辑 E:\\DeepSeek Harness\\profiles\\web\\cordis.patch.yml，给 `- id: werewolf-dealer` 写 config 覆盖（优先级高于插件自带默认值，且不会被插件重装覆盖），改完**重启 DSH** 生效。'
				];
				return lines.join('\n');
			});
		}
	});

	registerCommand({
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

	registerCommand({
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

	registerCommand({
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

	registerCommand({
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
