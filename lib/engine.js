/**
 * 《新版一夜狼人杀》庄家引擎 —— 纯确定性状态机。
 *
 * 设计约束（需求说明 §0）：
 * - 秘密不进任何 LLM 上下文：本模块**不含任何模型调用**，输入是房间消息与私聊回复，
 *   输出是「效果」数组（房间广播 / 私聊 / 审计记录），由 Host 层执行。
 * - 只裁程序、不裁身份：只做流程状态机与规则算术，不判断发言真假。
 * - 可复现：洗牌走注入的种子化 PRNG，时间走注入的 `now()`，同一输入序列必得同一效果序列。
 *
 * 效果（Effect）词表：
 *   { type:'room',  text, mentions }  房间广播（mentions 交给 dsh-chat 解析）
 *   { type:'dm',    sessionId, text } 私有信道（发牌 / 夜聊 / 复问）
 *   { type:'audit', record }          审计记录（record.secret=true 表示含牌面，回放时脱敏）
 *   { type:'appeal', authorSessionId, authorAlias } 上诉请求（Host 用审计日志脱敏回放）
 *
 * @module dsh-werewolf-dealer/engine
 */

import { createHash, randomBytes } from 'node:crypto';
import { T, verdictSentence } from './templates.js';

/** 角色。 */
export const ROLES = Object.freeze({
	VILLAGER: '村民',
	SEER: '预言家',
	TRICKSTER: '怪盗',
	WOLF: '狼'
});

/** 平安夜票目标。 */
export const PEACE = '平安夜';
/** 明确弃权（规则卡只定义「未声明记为弃票」，此处额外接受显式弃权，语义相同）。 */
export const ABSTAIN = '弃票';

/** 阶段。 */
export const PHASE = Object.freeze({
	NIGHT: 'night',
	DAY: 'day',
	VOTE: 'vote',
	SETTLED: 'settled',
	ENDED: 'ended'
});

/** 夜间子步骤顺序：预言家 → 狼 → 怪盗。 */
export const NIGHT_ORDER = Object.freeze(['seer', 'wolf', 'trickster']);

/** 白天发言轮数。 */
export const DAY_ROUNDS = 5;

/** 支持的局型（人数）范围：3–6（规则卡 §总卡数）。7 人及以上没有规则，直接拒绝。 */
export const MIN_MODE = 3;
export const MAX_MODE = 6;

/** 阵营：只有狼是狼阵营，其余（含被换卡后的怪盗）都是人类。 */
export function campOf(role) {
	return role === ROLES.WOLF ? 'wolf' : 'human';
}

/**
 * 牌堆算术（§总卡数）。
 *
 * 规则卡四档的规律：**总卡数 = 人数 + 2**（未分配的那 2 张正好给预言家选项②看），
 * 其中狼恒 2 张、预言家 1 张、怪盗 1 张，其余按人数补村民（村民 = 人数 − 2）：
 * 3人局 狼2村民1预言家1怪盗1（5 张）、4人局 狼2村民2…（6 张）、
 * 5人局 狼2村民3…（7 张）、6人局 狼2村民4…（8 张）。
 * @param mode - 3/4/5/6（人数）。
 * @returns 该局型的全部角色卡（顺序固定：狼、狼、村民…、预言家、怪盗）。
 */
export function deckFor(mode) {
	if (!Number.isInteger(mode) || mode < MIN_MODE || mode > MAX_MODE) throw new Error(`mode must be ${MIN_MODE}..${MAX_MODE}`);
	const villagers = mode - 2;
	return [ROLES.WOLF, ROLES.WOLF, ...Array.from({ length: villagers }, () => ROLES.VILLAGER), ROLES.SEER, ROLES.TRICKSTER];
}

/** 发/留牌数量：总卡数 = 人数 + 2，**留 2 张**（任何局型都留 2 张）。 */
export function dealCounts(mode) {
	if (!Number.isInteger(mode) || mode < MIN_MODE || mode > MAX_MODE) throw new Error(`mode must be ${MIN_MODE}..${MAX_MODE}`);
	return { total: deckFor(mode).length, dealt: mode, pile: 2 };
}

/** 多重集构成串（`狼×2、村民×1、预言家×1、怪盗×1`；顺序固定，公告稳定可断言）。 */
export function compositionText(roles) {
	const ORDER = [ROLES.WOLF, ROLES.VILLAGER, ROLES.SEER, ROLES.TRICKSTER];
	const counts = new Map();
	for (const role of roles) counts.set(role, (counts.get(role) ?? 0) + 1);
	const known = ORDER.filter((role) => counts.has(role)).map((role) => `${role}×${counts.get(role)}`);
	const unknown = [...counts.keys()].filter((role) => !ORDER.includes(role)).map((role) => `${role}×${counts.get(role)}`);
	return [...known, ...unknown].join('、');
}

/** 种子化 PRNG（mulberry32）：同一 seed 必得同一牌序。 */
export function mulberry32(seed) {
	let state = seed >>> 0;
	return function next() {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Fisher–Yates；rng 注入以便复现。 */
function shuffle(items, rng) {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i -= 1) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** 归一化：去首尾空白、（用于比对的）全角/半角空格与不可见字符。 */
function norm(text) {
	return String(text ?? '').replace(/[\u200b\ufeff]/gu, '').trim();
}

/** 宽松的名字比对（大小写/重音不敏感）。 */
function sameName(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string') return false;
	return norm(a).localeCompare(norm(b), undefined, { sensitivity: 'accent' }) === 0;
}

/**
 * 生成发言前缀 `【R{r}-{序号} · {别名}】`。
 *
 * v1.9.0（B 方案）：前缀与提及**不再由模型写**，改由插件按自己的轮次/序号生成
 * （`Game.speak()`），所以这里必须与 `parseSpeechPrefix` 是同一格式的唯一出处。
 */
export function speechPrefix(round, index, alias) {
	return `【R${round}-${index} · ${alias}】`;
}

/**
 * 解析发言前缀 `【R{r}-{序号} · {别名}】`（§4.2-1）。
 * @param text - 房间消息原文。
 * @returns `{ round, index, alias, body }` 或 `undefined`。
 */
export function parseSpeechPrefix(text) {
	const raw = String(text ?? '');
	const match = /^\s*【\s*R\s*(\d+)\s*[-–—]\s*(\d+)\s*[·・•∙.\u00b7]?\s*([^】]{1,80}?)\s*】\s*([\s\S]*)$/u.exec(raw);
	if (!match) return undefined;
	return {
		round: Number(match[1]),
		index: Number(match[2]),
		alias: norm(match[3]),
		body: norm(match[4])
	};
}

/** 大厅一条消息的归属判定结果。 */
export class Game {
	/**
	 * @param options - 开局参数（§2）。
	 * @param options.roomId - 房间 id。
	 * @param options.roomName - 房间名（公告里用）。
	 * @param options.mode - 3/4/5/6（人数）。
	 * @param options.players - `[{ name, sessionId }]`，顺序即庄家声明的座位顺序。
	 * @param options.seed - 可选随机种子（复盘复现）。
	 * @param options.gameId - 局标识（文件名 / 幂等投递 id 用）。
	 * @param options.no - 局号（导出文件名用）。
	 * @param options.now - 时间源（默认 Date.now）。
	 */
	constructor(options) {
		const { roomId, roomName, mode, players, seed, gameId, no, now } = options;
		if (!Array.isArray(players) || players.length !== mode) throw new Error(`players must contain exactly ${mode} entries`);
		const names = new Set(players.map((p) => norm(p.name)));
		if (names.size !== players.length) throw new Error('player names must be unique');
		const ids = new Set(players.map((p) => String(p.sessionId)));
		if (ids.size !== players.length) throw new Error('player sessions must be unique');

		this.roomId = String(roomId);
		this.roomName = String(roomName ?? roomId);
		this.mode = mode;
		// 席位：`sessionId` = 私聊信道（DM 目标）；`chanIds` = 该席位可用的全部身份 id
		// （含房间侧身份，例如房间自身会话——真人在房间里发言时作者就是它）；
		// `human` = 真人席位（DM 不唤醒其会话、房间提及不含它；白天不自动私聊提醒，
		// 靠房间发言框上的前缀条提示轮到谁了）。
		this.players = players.map((player, index) => {
			const sessionId = String(player.sessionId);
			const extra = Array.isArray(player.chanIds) ? player.chanIds.map(String) : [];
			return {
				seat: index + 1,
				name: norm(player.name),
				sessionId,
				chanIds: [...new Set([sessionId, ...extra])],
				human: player.human === true
			};
		});
		const claimedChan = new Map();
		for (const player of this.players) {
			for (const chanId of player.chanIds) {
				if (claimedChan.has(chanId)) throw new Error(`channel "${chanId}" is bound to more than one seat`);
				claimedChan.set(chanId, player.seat);
			}
		}
		this.seed = seed === undefined ? (Date.now() >>> 0) : (Number(seed) >>> 0);
		this.gameId = String(gameId);
		this.no = no === undefined ? null : Number(no);
		this.now = typeof now === 'function' ? now : () => Date.now();

		this.phase = PHASE.NIGHT;
		this.startedAt = this.now();
		this.paused = false;
		this.playable = true; // false = 已终止（/ww-end）、只读
		this.nightStep = NIGHT_ORDER[0];
		this.nightAwaiting = null; // sessionId
		this.nightDone = false;
		this.round = 1;
		this.position = 0;
		this.voidCount = 0;
		this.voteOpenAt = null;
		this.votes = new Map(); // sessionId -> { target, raw, at, seq }
		this.voteSeq = 0;
		this.settlement = null;
		/** v1.16.8（规则卡《信息协议与证据规则》§4）：开局的「全量状态」哈希承诺；结算时公布同一个值供对账。 */
		this.commitmentHash = null;
		/**
		 * v1.16.9：**承诺必须加盐**。牌面空间只有几十到几百种（3 人局 60、4 人局 180、5 人局 420、6 人局 840）
		 * ⇒ 无盐哈希能被穷举秒破（本机实测：4 人局 **21 次尝试**就反推出全部牌面）。
		 * 盐开局**不公开**（只在私有状态文件里），结算时随牌面一起公布 ⇒ 届时全员可重算对账，但结算前谁也算不出来。
		 */
		this.commitmentSalt = null;
		/** v1.16.9：夜序流水的盐 —— **连结算都不公布**，只留给"第三方定向核对"。 */
		this.nightSalt = null;
		/** v1.16.8：夜序（私信）流水 —— 只用来算哈希；原文留在庄家手里，不对外发布。 */
		this.nightTrace = [];
		this.recapWriter = null;
		this.endedInformally = false;
		this.voided = false;
		/** v1.16.0：**完赛感想** —— 结算之后每人**第一条**房间发言（进复盘的那一句）。`[{seat,name,sessionId,human,text,at}]`。 */
		this.closing = [];
		/** v1.16.3：赛后那次「全员点名」是否已经用掉（观察员的第一条点评 —— 见 `closingPromptFor`）。 */
		this.closingPrompt = false;
		/** v1.16.4：正在等回流的**观察员身份**（他那条点评要记进 `closing`；`null` = 没有）。 */
		this.observerClosing = null;

		// 牌面：dealt = 发牌时的牌，hand = 现值（换卡后）。
		const deck = shuffle(deckFor(mode), mulberry32(this.seed));
		this.dealt = new Map();
		this.hand = new Map();
		this.players.forEach((p, index) => {
			this.dealt.set(p.sessionId, deck[index]);
			this.hand.set(p.sessionId, deck[index]);
		});
		this.pile = deck.slice(mode);

		this.log = []; // 结构化对局记录（§7 导出用）
		this.outSeq = 0; // 对外输出的稳定序号（投递 id 用）
		this.lastActivityAt = this.startedAt;
		this.lastOutput = null; // 房间/私聊最后一次输出（测试与审计用）
	}

	// ---------------------------------------------------------------- 查询

	/** 座位号 → 玩家。 */
	bySeat(seat) {
		return this.players[seat - 1];
	}

	/** 会话/房间侧身份 id → 玩家（含 chanIds 别名）。 */
	bySession(sessionId) {
		const id = String(sessionId);
		return this.players.find((player) => player.chanIds.includes(id));
	}

	/** 真人席位列表。 */
	humans() {
		return this.players.filter((player) => player.human);
	}

	/** 名字/座位号 → `{ player, index }`；不唯一或无匹配返回 undefined（附 ambiguous 标记）。 */
	resolveSeat(reference) {
		const ref = norm(reference).replace(/^@/, '');
		if (ref === '') return undefined;
		const byNumber = /^(\d+)\s*(?:号|位)?$/u.exec(ref);
		if (byNumber) {
			const seat = Number(byNumber[1]);
			if (seat >= 1 && seat <= this.players.length) return { player: this.bySeat(seat), index: seat - 1, ambiguous: false };
			return undefined;
		}
		const hits = this.players.filter((p) => sameName(p.name, ref));
		if (hits.length === 1) return { player: hits[0], index: hits[0].seat - 1, ambiguous: false };
		// 名字是别名的子串（如「大D」对上「大D(v4.1)」）时按最长匹配给唯一解。
		const partial = this.players.filter((p) => p.name.startsWith(ref) || p.name.includes(ref));
		if (partial.length === 1) return { player: partial[0], index: partial[0].seat - 1, ambiguous: false };
		return { player: undefined, index: -1, ambiguous: partial.length > 1 };
	}

	/** 当前应发言的玩家。 */
	expectedSpeaker() {
		return this.players[this.position % this.players.length];
	}

	/** 顺序表文本（真人席位标注出来，供 AI 判断提及规则）。 */
	orderText() {
		return this.players.map((p) => `${p.seat}.${p.name}${p.human ? '（真人）' : ''}`).join(' → ');
	}

	/** 场上现值为狼的座位。 */
	wolves() {
		return this.players.filter((p) => campOf(this.hand.get(p.sessionId)) === 'wolf');
	}

	/** 现值牌。 */
	currentRole(sessionId) {
		return this.hand.get(String(sessionId));
	}

	/** 公开安全的状态摘要（不含任何牌面；供 /ww-status 与 wolf_status 用）。 */
	status() {
		const waiting = this.nightAwaiting ? this.bySession(this.nightAwaiting) : undefined;
		return {
			gameId: this.gameId,
			no: this.no,
			roomId: this.roomId,
			roomName: this.roomName,
			mode: this.mode,
			phase: this.phase,
			paused: this.paused,
			round: this.round,
			position: this.position,
			expectedSpeaker: this.phase === PHASE.DAY ? this.expectedSpeaker().name : null,
			nightStep: this.phase === PHASE.NIGHT ? this.nightStep : null,
			awaiting: waiting ? waiting.name : null,
			votesIn: this.votes.size,
			seats: this.players.map((p) => `${p.seat}.${p.name}${p.human ? '（真人）' : ''}`)
		};
	}

	// ---------------------------------------------------------------- 效果

	#room(text, mentions) {
		return { type: 'room', text, mentions: mentions ?? ['all'] };
	}

	/**
	 * v1.17.1（用户 2026-10-06 定 **B 方案**）：**「召集」型的提及** —— `@all` + 逐个具名 AI 席位。
	 *
	 * 具名 = `wake:true`（`room-store.js:1163-1167` 的 `direct`）⇒ 目标**空闲**时会被叫起来一个回合；
	 * 正在跑回合时由桥接层补丁 8 改走 `inject` ⇒ **下一步就看到**。两者都不再依赖"它当时在不在跑"。
	 * ⚠ **真人席位绝不点名**：点名会唤醒他那个私聊会话，把夜聊带进模型上下文（既有硬规矩）。
	 * 开票公告（`#openVote`）与结算公告（`#settlementEffects`）共用这一处定义。
	 */
	#gatherMentions() {
		return ['all', ...this.players.filter((player) => player.human !== true).map((player) => player.name)];
	}

	#dm(sessionId, text) {
		return { type: 'dm', sessionId: String(sessionId), text };
	}

	/**
	 * 给某个席位发私聊。真人席位的会话**不唤醒**（`wake:false`：只落到它自己的会话时间线里，
	 * 不触发该会话的模型回合，避免夜聊文本进入任何 LLM 上下文），并按需追加信道提示。
	 * @param player - 席位。
	 * @param text - 正文。
	 * @param options - `{ hint, quiet, options }`：`hint` = 追加「用 /ww-reply 回答」的信道提示；
	 *   `quiet` = **只落时间线、不唤醒**。v1.7.6 起只给"纯确认、且不含新信息"的消息用
	 *   （当前唯一一处：怪盗选了不换的那句回执）——带新信息的读数/换卡结果都要唤醒，好让 AI 当场消化。
	 *   真人席位永远不唤醒（唤醒会把夜聊读进那个会话的 LLM 上下文）。
	 *   `options` = **v1.14.0 的弹窗按钮**（`[{ label, text }]`）：只有真人弹窗席位用得上，
	 *   由主持层（index.js）写进弹窗信箱记录；AI 席位走 dsh-bridge，这个字段被忽略。
	 *   `channel` = **v1.15.0：这条回答该往哪条信道回**（`'room'` = 公开发到房间，例如投票；
	 *   缺省 = 夜间私聊）。同样只对真人弹窗席位有意义。
	 */
	#dmSeat(player, text, options = {}) {
		const wake = options.quiet === true ? false : player.human !== true;
		const effect = { type: 'dm', sessionId: player.sessionId, text: this.#seatText(player, text, options.hint === true), wake };
		// v1.16.8：夜序（私信）流水只在这里留痕 —— 结算时公布它的哈希（规则卡 §4）。
		if (this.phase === PHASE.NIGHT) this.nightTrace.push({ dir: 'out', seat: player.seat, text: effect.text });
		if (Array.isArray(options.options) && options.options.length > 0) effect.options = options.options;
		if (options.channel !== undefined) effect.channel = options.channel;
		return effect;
	}

	// ─── v1.14.0：夜间提问的按钮选项（真人在弹窗里点，不用打字）────────────────────────
	// `text` 由 templates 提供，就是引擎下面那套解析认识的原话；`label` 是按钮上给人看的字。
	// 两处提问与两处复问共用这两个函数 ⇒ 点错了也能顺着按钮再点一次。

	/** 预言家：看牌堆 + 每个**其他**座位的「验」（规则卡：「验别的一名玩家」，不含自己）。 */
	#seerOptions(seer) {
		return [T.seerOptionPile(), ...this.players.filter((player) => player !== seer).map((player) => T.seerOptionSeat(player.name))];
	}

	/** 怪盗：不换 + 每个**其他**座位的「换」（规则卡：不能换自己）。 */
	#tricksterOptions(trickster) {
		return [T.tricksterOptionNone(), ...this.players.filter((player) => player !== trickster).map((player) => T.tricksterOptionSwap(player.name))];
	}

	/**
	 * v1.15.0：投票按钮的选项 —— **除他自己以外**的每个座位 + 平安夜（用户 2026-10-05 口径
	 * 「所有AI玩家+平安夜选项」）。投票那条问与夜间不同：它的答案是一条**公开的房间消息**，
	 * 所以选项的 `text` 是完整的 `投票：<座位名>`（见 `#openVote` 的 `channel: 'room'`）。
	 */
	#voteOptions(voter) {
		return [...this.players.filter((player) => player !== voter).map((player) => T.voteOptionSeat(player.name)), T.voteOptionPeace()];
	}

	/** 席位实际收到的正文：按席位类型追加对应的信道提示（AI = wolf_reply 工具，真人 = /ww-reply 命令）。 */
	#seatText(player, text, hint) {
		if (hint !== true) return text;
		return `${text}\n${player.human ? T.humanChannelHint() : T.aiChannelHint()}`;
	}

	/**
	 * 「轮到你发言」的正文（真人版与 AI 版共用同一套指引：前缀 + 怎么唤醒下一位）。
	 *
	 * ⚠️ 只给**手动催人**（`/ww-nudge` 与 §4.3 的空转提醒）用。v1.10.1 起白天**不再**自动私聊提醒真人
	 * 该发言了 —— 他看房间发言框上的只读前缀条就知道（见 `speechPlan()` 与 dsh-chat 补丁 20）。
	 * @param player - 席位。
	 * @param round - 当前轮次。
	 * @param index - 本轮第几位（1 基）。
	 */
	#turnText(player, round, index) {
		const total = this.players.length;
		const next = this.players[index % total];
		const isFinal = round >= DAY_ROUNDS && index >= total;
		if (player.human === true) {
			return T.humanTurn(round, index, player.name, isFinal ? T.humanTurnLast() : T.humanTurnNext(next.name));
		}
		return T.nudgeDay(round, index, player.name, isFinal ? null : next.name);
	}

	/**
	 * 当前"该行动"的席位（观察员 `/ww-nudge` 用；也是空转提醒的唯一判据来源）。
	 * 夜间 = 等待回复者；白天 = 当前应发言者；投票 = 还没投票的人。
	 */
	#pendingActions() {
		if (this.paused || !this.playable || this.phase === PHASE.SETTLED || this.phase === PHASE.ENDED) return [];
		if (this.phase === PHASE.NIGHT) {
			const waiting = this.bySession(this.nightAwaiting);
			return waiting === undefined ? [] : [{ player: waiting, kind: 'night', text: T.idleReminderNight(), hint: true }];
		}
		if (this.phase === PHASE.DAY) {
			const expected = this.expectedSpeaker();
			return [{ player: expected, kind: 'day', text: this.#turnText(expected, this.round, this.position + 1), hint: false }];
		}
		if (this.phase === PHASE.VOTE) {
			const names = this.players.map((player) => player.name);
			return this.players
				.filter((player) => !this.votes.has(player.sessionId))
				.map((player) => ({ player, kind: 'vote', text: player.human ? T.humanVote(names) : T.nudgeVote(names), hint: false }));
		}
		return [];
	}

	/**
	 * 观察员手动催人。**没有计时器**：只在被调用时动作一次，谁该动由状态机判定，不靠时间猜。
	 * @param options - `{ seatRef }`：只催指定席位（它必须正是当前该行动者，否则报错并列出真正该动的人）。
	 * @returns `{ effects, seats }` 或 `{ error }`。
	 */
	nudge(options = {}) {
		const seatRef = options.seatRef === undefined || options.seatRef === null ? '' : String(options.seatRef).trim();
		if (this.paused) return { error: '对局已暂停：先 /ww-resume 再催' };
		if (!this.playable || this.phase === PHASE.SETTLED || this.phase === PHASE.ENDED) return { error: '对局已结束，没有需要催的人' };
		const pending = this.#pendingActions();
		if (pending.length === 0) return { error: '当前没有等待行动的席位' };
		let targets = pending;
		if (seatRef !== '') {
			const hit = this.resolveSeat(seatRef);
			// v1.16.5（用户 2026-10-05 实测）：名字打错/打偏时旧实现一律回"不是该行动的人"，
			// 看不出其实是"没这个席位"。两种情况分开报，并把花名册给出来（免得再去翻 /ww-status）。
			if (hit?.player === undefined) {
				const roster = this.players.map((player) => `${player.seat}.${player.name}`).join('、');
				return { error: `没有「${seatRef}」这个席位（本局席位：${roster}）${hit?.ambiguous === true ? '；名字有歧义，请改用座位号' : ''}` };
			}
			const match = pending.filter((entry) => entry.player === hit.player);
			if (match.length === 0) {
				return { error: `「${seatRef}」现在不是该行动的人（现在应该动的是：${pending.map((entry) => entry.player.name).join('、')}）` };
			}
			targets = match;
		}
		const effects = [];
		for (const entry of targets) effects.push(this.#dmSeat(entry.player, entry.text, { hint: entry.hint === true }));
		effects.push(this.#audit({ type: 'nudge', seats: targets.map((entry) => entry.player.seat), kinds: [...new Set(targets.map((entry) => entry.kind))], targeted: seatRef === '' ? undefined : seatRef }));
		this.#note({ type: 'nudge', seats: targets.map((entry) => entry.player.seat), kinds: [...new Set(targets.map((entry) => entry.kind))] });
		return { effects, seats: targets.map((entry) => ({ seat: entry.player.seat, name: entry.player.name, human: entry.player.human === true, sessionId: entry.player.sessionId, kind: entry.kind })) };
	}

	#audit(record) {
		return { type: 'audit', record: { at: this.now(), ...record } };
	}

	#note(record) {
		this.log.push({ at: this.now(), ...record });
	}

	/** 生成效果并把「庄家对外输出」记账（测试与审计用）。 */
	#emit(effects) {
		const decorated = [];
		for (const effect of effects) {
			if (effect === undefined || effect === null) continue;
			if (effect.type === 'room' || effect.type === 'dm') {
				// 稳定投递 id：同一条效果被重复执行时，dsh-bridge 的 `transport:from:to:id` 幂等键会去重。
				this.outSeq += 1;
				effect.seq = this.outSeq;
				this.lastOutput = effect;
			}
			decorated.push(effect);
		}
		return decorated;
	}

	// ---------------------------------------------------------------- 开局（§2）

	/**
	 * v1.16.8：开局承诺的**规范串** —— 按座位号升序的「发到的牌」+ 牌堆顺序。
	 * ⚠ 刻意**只用 `dealt` 与 `pile`**：换卡改的是 `hand`（现值），这两个量从开局起不变
	 * ⇒ 结算时可以用同一算法重算并核对开局的承诺（规则卡《信息协议与证据规则》§4）。
	 * @returns 规范串。
	 */
	#commitmentPayload() {
		const seats = [...this.players]
			.sort((a, b) => a.seat - b.seat)
			.map((player) => `${player.seat}.${player.name}=${this.dealt.get(player.sessionId)}`);
		return `seats[${seats.join(';')}]pile[${this.pile.join(',')}]`;
	}

	/** v1.16.9：统一出口 —— `sha256(盐 + 换行 + 正文)` 取前 16 位十六进制（好念、够用；有盐后不可穷举）。 */
	#hash(salt, text) {
		return createHash('sha256').update(`${salt}\n${text}`, 'utf8').digest('hex').slice(0, 16);
	}

	/** 开局全量状态的哈希承诺（**加盐**；盐开局不公开，结算时随牌面公布）。 */
	#stateCommitment(salt) {
		return this.#hash(salt, this.#commitmentPayload());
	}

	/** v1.16.8/1.16.9：夜序（私信）流水的哈希 —— 结算时公布，防事后改写；原文与盐只在庄家手里。 */
	#nightTraceHash() {
		if (this.nightSalt === null) this.nightSalt = randomBytes(16).toString('hex');
		return this.#hash(this.nightSalt, this.nightTrace.map((entry) => `${entry.dir}|${entry.seat}|${entry.text}`).join('\n'));
	}

	/**
	 * 开局：广播 + 逐一私聊发牌 + 进入夜序第一步。
	 * @returns 效果数组。
	 */
	start() {
		const effects = [];
		// v1.16.8（规则卡《信息协议与证据规则》§4）：开局公布**全量状态（发到的牌 + 牌堆）的哈希承诺**。
		// v1.16.9：**必须加盐** —— 牌面空间只几十到几百种，无盐哈希可被穷举反推（实测 21 次就破）。
		// 盐只留在私有状态里，结算时随牌面一起公布，届时谁都能重算对账。
		this.commitmentSalt = randomBytes(16).toString('hex');
		this.commitmentHash = this.#stateCommitment(this.commitmentSalt);
		// ⚠ 审计里**不写 payload、更不写盐**：`/ww-audit` 是观察员可见的（AI 局里观察员也是 AI），
		// 写进去＝把牌面前移到"敲一条命令就能看"。
		effects.push(this.#audit({ type: 'commitment', secret: true, hash: this.commitmentHash }));
		effects.push(this.#room(T.open(this.mode, this.players.map((p) => p.name), this.commitmentHash)));
		effects.push(this.#audit({ type: 'game-start', secret: true, gameId: this.gameId, roomId: this.roomId, mode: this.mode, seed: this.seed, players: this.players.map((p) => ({ seat: p.seat, name: p.name, sessionId: p.sessionId })) }));
		this.#note({ type: 'game-start', mode: this.mode, seed: this.seed });
		for (const player of this.players) {
			const role = this.dealt.get(player.sessionId);
			// v1.7.4（用户要求"怪盗/预言家别在发牌阶段发消息"）：这两者的身份改由**夜间提问**承载
			// —— 提问第一句就是「你是怪盗／你是预言家」，而它们在提问之前都没有任何动作可做。
			// 审计仍保留一条 deal 记录（复盘与 §11-8 依赖"每人一条身份记录"），但**不带正文**，
			// 免得 `/ww-inbox` 显示一条它们从没收到的"发牌原文"（inbox 只列有 text 的记录）。
			if (role === ROLES.SEER || role === ROLES.TRICKSTER) {
				effects.push(this.#audit({ type: 'deal', secret: true, seat: player.seat, name: player.name, sessionId: player.sessionId, role, delivered: false }));
				this.#note({ type: 'deal', seat: player.seat, role });
				continue;
			}
			// 只剩狼与村民需要发牌：村民没有夜间动作，身份只能靠发牌承载；狼的发牌里并着同伴信息。
			const text = role === ROLES.VILLAGER ? T.dealVillager() : T.dealWolf(this.#wolfMateName(player));
			const deal = this.#dmSeat(player, text, { hint: true });
			deal.deal = true; // 标记"这条是发牌"（开局回执按此统计；怪盗/预言家不计入）
			effects.push(deal);
			effects.push(this.#audit({ type: 'deal', secret: true, seat: player.seat, name: player.name, sessionId: player.sessionId, role, text: deal.text }));
			this.#note({ type: 'deal', seat: player.seat, role });
		}
		effects.push(...this.#nightStep());
		return this.#emit(effects);
	}

	// ---------------------------------------------------------------- 夜间（§3）

	/**
	 * 该玩家**在场上**的同伴狼座位名（按**发牌时**的牌算，与夜序「狼」步同口径）。
	 * 返回 undefined ⇒ 另一张狼留在牌堆，这只狼这局没有同伴。
	 */
	#wolfMateName(player) {
		const mate = this.players.find((other) => other !== player && this.dealt.get(other.sessionId) === ROLES.WOLF);
		return mate?.name;
	}

	/** 进入当前夜序子步骤，返回其效果。 */
	#nightStep() {
		const effects = [];
		if (this.phase !== PHASE.NIGHT) return effects;
		const step = this.nightStep;
		this.nightAwaiting = null;
		effects.push(this.#audit({ type: 'night-step', step }));
		if (step === 'seer') {
			const seer = this.players.find((p) => this.dealt.get(p.sessionId) === ROLES.SEER);
			// 预言家一定在场上：牌堆固定留 2 张，故若预言家在牌堆则没人可选——牌堆算术上不可能出现。
			if (seer) {
				this.nightAwaiting = seer.sessionId;
				const ask = this.#dmSeat(seer, T.askSeer(), { hint: true, options: this.#seerOptions(seer) });
				effects.push(ask);
				effects.push(this.#audit({ type: 'night-ask', secret: true, step, seat: seer.seat, text: ask.text }));
			} else {
				effects.push(...this.#advanceNight());
			}
		} else if (step === 'wolf') {
			// v1.7.2（用户要求"狼只收一条消息"）：同伴信息已并入**发牌那一条**（见 dealWolf），
			// 这一步不再单独投递、也不写 night-wolf-info（发牌审计里已带同一段原文）。
			// 狼步本身没有提问（规则卡：狼「可以确认自己有无同伴」，由庄家主动通报），故直接推进。
			effects.push(...this.#advanceNight());
		} else if (step === 'trickster') {
			const trickster = this.players.find((p) => this.dealt.get(p.sessionId) === ROLES.TRICKSTER);
			if (trickster) {
				this.nightAwaiting = trickster.sessionId;
				// v1.7.3：提问里列出**可换的座位名**（场上其他玩家，不能换自己）——
				// 旧文本里的 `{座位}` 是个从没被替换过的死占位符。
				const swapTargets = this.players.filter((p) => p !== trickster).map((p) => p.name);
				const ask = this.#dmSeat(trickster, T.askTrickster(swapTargets), { hint: true, options: this.#tricksterOptions(trickster) });
				effects.push(ask);
				effects.push(this.#audit({ type: 'night-ask', secret: true, step, seat: trickster.seat, text: ask.text }));
			} else {
				effects.push(...this.#finishNight());
			}
		}
		return effects;
	}

	/** 推进到下一个夜序子步骤。 */
	#advanceNight() {
		const index = NIGHT_ORDER.indexOf(this.nightStep);
		if (index < 0 || index >= NIGHT_ORDER.length - 1) return this.#finishNight();
		this.nightStep = NIGHT_ORDER[index + 1];
		return this.#nightStep();
	}

	/** 夜间结束：不发任何结束公告（§3 末），直接开白天（§4.1）。 */
	#finishNight() {
		this.nightAwaiting = null;
		this.nightDone = true;
		this.phase = PHASE.DAY;
		this.round = 1;
		this.position = 0;
		this.voidCount = 0;
		const effects = [this.#audit({ type: 'night-done' })];
		this.#note({ type: 'night-done' });
		effects.push(...this.#dayOpen());
		return effects;
	}

	/**
	 * v1.16.3：**赛后那一次「全员点名」** —— 用户 2026-10-05 的口径：**AI 局里他是观察员**，
	 * 赛后通常由他点评大家的赛时表现；这与参赛时是**同一条逻辑**（一句话把 AI 都唤醒，
	 * 它们顺着回话、顺便把感想说了）⇒ 复用同一套。
	 *
	 * 玩家那条走 `speak()`（那里已经算好了自己的提及），这里只管**不是本局席位**的房间侧身份
	 * （观察员/房间会话）。**一场只给一次**：用过就记在 `closingPrompt` 上（进状态、重启不丢）——
	 * 免得他每说一句都叫醒全场（AI 每人只收第一条，再叫醒只会让他们白跑一轮）。
	 *
	 * @param sessionId - 房间里的作者身份。
	 * @returns `{ mentions }`（替他补上的提及）；不该接管时返回 `null`。
	 */
	closingPromptFor(sessionId) {
		if (this.phase !== PHASE.SETTLED && this.phase !== PHASE.ENDED) return null;
		if (this.closingPrompt === true) return null;
		if (this.bySession(String(sessionId)) !== undefined) return null; // 玩家那条走 speak()，不在这里重复
		this.closingPrompt = true;
		// v1.16.4：同时**挂上**这个身份 —— 他那条点评回流时要被记进 `closing`（进「## 完赛感想」节），
		// 而引擎自己认不出"房间侧身份"，只能认主持层挂上来的这一个。
		this.observerClosing = String(sessionId);
		return { mentions: ['all', ...this.players.filter((player) => player.human !== true).map((player) => player.name)] };
	}

	/**
	 * 夜间私聊回复（`wolf_reply` 工具入口）。
	 * @param input - `{ sessionId, text }`。
	 * @returns 效果数组。
	 */
	onPrivateReply(input) {
		const sessionId = String(input.sessionId);
		const text = norm(input.text);
		const player = this.bySession(sessionId);
		if (this.paused || !this.playable) return this.#emit([this.#audit({ type: 'reply-ignored', reason: this.paused ? 'paused' : 'ended', sessionId })]);
		if (this.phase !== PHASE.NIGHT || this.nightAwaiting === null || player === undefined || player.sessionId !== this.nightAwaiting) {
			// 没有待答问题：只记账，不回答任何内容（§8.4）。
			return this.#emit([this.#audit({ type: 'reply-unexpected', sessionId, text })]);
		}
		this.lastActivityAt = this.now();
		// v1.16.8：夜序流水也记玩家的原话（只进哈希，不外发）。
		this.nightTrace.push({ dir: 'in', seat: player.seat, text });

		if (this.nightStep === 'seer') return this.#emit(this.#seerReply(sessionId, text));
		if (this.nightStep === 'trickster') return this.#emit(this.#tricksterReply(sessionId, text));
		return this.#emit([this.#audit({ type: 'reply-unexpected', sessionId, text })]);
	}

	#seerReply(sessionId, text) {
		const seer = this.bySession(sessionId);
		const effects = [];
		if (/^(2|②|二)$/u.test(text) || /牌堆|未分配|剩余的?2张|剩余两张|看牌堆/u.test(text)) {
			const composition = compositionText(this.pile);
			const reply = T.seerReadPile(this.pile.length, composition);
			// v1.7.6：读数**要唤醒**（用户 2026-10-04 指出）：AI 需要单独一轮把读数想清楚，
			// 否则它会到白天发言那一轮、在满屏房间发言里才看到读数，容易错过。
			effects.push(this.#dmSeat(seer, reply));
			effects.push(this.#audit({ type: 'seer-read', secret: true, seat: seer.seat, option: 2, text: reply, pile: [...this.pile] }));
			this.#note({ type: 'seer-read', option: 2 });
			this.nightAwaiting = null;
			effects.push(...this.#advanceNight());
			return effects;
		}
		const cleaned = text.replace(/^(①|1|验|查验|查看|查)\s*[:：]?\s*/u, '').trim();
		const hit = cleaned === '' ? undefined : this.resolveSeat(cleaned);
		if (hit && hit.player) {
			const role = this.dealt.get(hit.player.sessionId); // 夜序上怪盗未行动 ⇒ 即发牌时的牌
			const reply = T.seerReadSeat(hit.player.name, role);
			// v1.7.6：同上看牌堆 —— 读数要唤醒，让 AI 当场把它想清楚。
			effects.push(this.#dmSeat(seer, reply));
			effects.push(this.#audit({ type: 'seer-read', secret: true, seat: seer.seat, option: 1, targetSeat: hit.player.seat, target: hit.player.name, role, text: reply }));
			this.#note({ type: 'seer-read', option: 1, targetSeat: hit.player.seat });
			this.nightAwaiting = null;
			effects.push(...this.#advanceNight());
			return effects;
		}
		effects.push(this.#dmSeat(seer, T.nightRetrySeer(), { hint: true, options: this.#seerOptions(seer) }));
		effects.push(this.#audit({ type: 'night-retry', secret: true, step: 'seer', seat: seer.seat }));
		return effects;
	}

	#tricksterReply(sessionId, text) {
		const trickster = this.bySession(sessionId);
		const effects = [];
		if (/不换|跳过|不改|^no$/u.test(text)) {
			effects.push(this.#audit({ type: 'swap', secret: true, seat: trickster.seat, action: 'none', text }));
			this.#note({ type: 'swap', action: 'none' });
			// v1.7.3：不换也给一条确认（原先静默进白天；措辞按用户 2026-10-04 手发版本）。
			// 它**没有新信息**（阵营不变，怪盗自己知道它拒绝了）⇒ 保留 `quiet`：只落时间线、不为一句
			// 确认白跑一个模型回合（v1.7.6 起这是唯一还用 quiet 的消息；读数与换卡结果都改回唤醒了）。
			// 复用 `swap-result` 这个类型 ⇒ `/ww-inbox` 的 INBOX_TYPES 不用动。
			const noneReceipt = T.swapNone();
			effects.push(this.#dmSeat(trickster, noneReceipt, { quiet: true }));
			effects.push(this.#audit({ type: 'swap-result', secret: true, seat: trickster.seat, action: 'none', text: noneReceipt }));
			this.nightAwaiting = null;
			effects.push(...this.#finishNight());
			return effects;
		}
		const swapMatch = /(?:换卡?|交换)\s*[:：]?\s*(.+)$/u.exec(text);
		const candidate = swapMatch ? swapMatch[1].trim() : '';
		const hit = candidate === '' ? undefined : this.resolveSeat(candidate);
		if (hit && hit.player && hit.player.sessionId !== sessionId) {
			const beforeFrom = this.hand.get(sessionId);
			const beforeTo = this.hand.get(hit.player.sessionId);
			this.hand.set(sessionId, beforeTo);
			this.hand.set(hit.player.sessionId, beforeFrom);
			effects.push(this.#audit({ type: 'swap', secret: true, seat: trickster.seat, action: 'swap', targetSeat: hit.player.seat, target: hit.player.name, before: { self: beforeFrom, target: beforeTo }, after: { self: beforeTo, target: beforeFrom }, text }));
			this.#note({ type: 'swap', action: 'swap', targetSeat: hit.player.seat });
			// 规则卡：「怪盗清楚知道自己和被换卡后的玩家的角色卡」⇒ 结果**只补发怪盗本人**；
			// 被换者一律不自知（绝不发）。需求说明 §3.3 的"不通知任何玩家"只取后一半。
			const receipt = T.swapResult(beforeTo, hit.player.name, beforeFrom);
			// v1.7.6：换卡结果**要唤醒** —— 它决定怪盗**现在是什么阵营**，白天发言全靠它；
			// 按同一理由（用户对"预言家读数"的要求）也让它当场消化，别等到白天那一轮。
			effects.push(this.#dmSeat(trickster, receipt));
			effects.push(this.#audit({ type: 'swap-result', secret: true, seat: trickster.seat, text: receipt }));
			this.nightAwaiting = null;
			effects.push(...this.#finishNight());
			return effects;
		}
		effects.push(this.#dmSeat(trickster, T.nightRetryTrickster(this.players.filter((p) => p !== trickster).map((p) => p.name)), { hint: true, options: this.#tricksterOptions(trickster) }));
		effects.push(this.#audit({ type: 'night-retry', secret: true, step: 'trickster', seat: trickster.seat }));
		return effects;
	}

	// ---------------------------------------------------------------- 白天（§4）

	#dayOpen() {
		const first = this.expectedSpeaker();
		this.#note({ type: 'day-open', round: this.round });
		const humanRule = this.humans().length > 0 ? `${T.humanMentionRule(this.humans().map((player) => player.name))}` : '';
		const effects = [
			// 首位发言者是人类时只 @all：点名会把他的私聊会话唤醒，夜聊就进了模型上下文。
			this.#room(T.dayOpen(this.orderText(), humanRule), first.human === true ? ['all'] : ['all', first.name]),
			this.#audit({ type: 'day-open', round: this.round, order: this.players.map((p) => p.name) })
		];
		return effects;
	}

	/**
	 * 房间消息入口（发言链状态机 §4.2 / 投票解析 §5.2）。
	 * @param input - `{ authorSessionId, authorAlias, text, sentAt }`。
	 *   v1.10.0 起**不再需要** `mentions` / `canonical`：真人那一棒的前缀与提及已由庄家
	 *   在消息落盘之前补好（`speak()` 生成），所以引擎只需按规范版本来的一条判定。
	 * @returns 效果数组。
	 */
	onRoomMessage(input) {
		const text = String(input.text ?? '');
		const authorSessionId = String(input.authorSessionId);
		// v1.16.0：**完赛感想** —— 结算之后（`playable` 已是 false）**每人只收第一条**房间发言。
		// 这条必须在下面的「本局已不可用」早退**之前**：那时房间还开着，只有判定该停。
		// 之后的闲聊不进复盘（`closing` 里已经有他），也不再回任何东西。
		if (this.phase === PHASE.SETTLED || this.phase === PHASE.ENDED) {
			const speaker = this.bySession(authorSessionId);
			if (text.trim() === '') return this.#emit([]);
			if (speaker === undefined) {
				// v1.16.4：**观察员的点评**（AI 局里房间里那条的作者不是任何席位）。他不是玩家，
				// 引擎自己认不出「房间侧身份」—— 那条判据在主持层（index.js 的 `roomSideIds`），
				// 它替他点名时会**挂上** `observerClosing`；这里只认那一个身份、只收**一条**。
				// 记进 `closing` 时 `human: true`（他是真人）但**没有名字**（渲染时用配置里的玩家名兜底）。
				if (this.observerClosing === null || authorSessionId !== this.observerClosing) return this.#emit([]);
				this.observerClosing = null;
				this.closing.push({ seat: null, name: null, sessionId: authorSessionId, human: true, observer: true, text, at: this.now() });
				this.#note({ type: 'closing-statement', seat: null });
				return this.#emit([this.#audit({ type: 'closing-statement', seat: null, name: null, observer: true, text })]);
			}
			if (this.closing.some((entry) => entry.sessionId === speaker.sessionId)) return this.#emit([]);
			this.closing.push({ seat: speaker.seat, name: speaker.name, sessionId: speaker.sessionId, human: speaker.human === true, text, at: this.now() });
			this.#note({ type: 'closing-statement', seat: speaker.seat });
			return this.#emit([this.#audit({ type: 'closing-statement', seat: speaker.seat, name: speaker.name, text })]);
		}
		if (this.paused || !this.playable) return this.#emit([]);

		// 上诉流（§10）：任何阶段都可申请，Host 负责脱敏回放。
		if (/申请庄家裁定|申请复议|上诉/u.test(text)) {
			this.#note({ type: 'appeal', author: authorSessionId });
			return this.#emit([{ type: 'appeal', authorSessionId, authorAlias: input.authorAlias }, this.#audit({ type: 'appeal', author: authorSessionId })]);
		}

		// 夜间：庄家只走夜序私聊，房间文本一律不作输入（§8.4）。
		if (this.phase === PHASE.NIGHT) return this.#emit([this.#audit({ type: 'room-ignored', phase: 'night', author: authorSessionId })]);

		const player = this.bySession(authorSessionId);
		if (!player) return this.#emit([]); // 非玩家（人类观察员 / 庄家自己）

		this.lastActivityAt = this.now();
		if (this.phase === PHASE.DAY) return this.#emit(this.#speech(player, text));
		if (this.phase === PHASE.VOTE) return this.#emit(this.#vote(player, text));
		return this.#emit([]);
	}

	/**
	 * v1.10.0：**当前这一棒的规范形态**（不含正文）—— 给「发言框接管」用。
	 *
	 * 前端据此在输入框上方显示只读前缀（`【R{轮}-{位} · {名字}】`），真正的改写由宿主在
	 * 消息落盘之前调用 `speak()` 完成；两者共用 `#speechShape()`，口径不可能漂移。
	 *
	 * 不适用时返回 `null`：暂停 / 已终止 / 不是白天 / **当前该发言的不是真人**。
	 * @returns `{ seat, name, human, round, index, prefix, mentions, next, final }` 或 `null`。
	 */
	speechPlan() {
		if (this.paused || !this.playable) return null;
		if (this.phase !== PHASE.DAY) return null;
		const player = this.expectedSpeaker();
		if (player?.human !== true) return null;
		const shape = this.#speechShape(player);
		return {
			seat: player.seat,
			name: player.name,
			human: true,
			round: shape.round,
			index: shape.index,
			prefix: speechPrefix(shape.round, shape.index, player.name),
			mentions: shape.mentions,
			next: shape.mentionNext ? shape.next.name : null,
			final: shape.isFinal === true
		};
	}

	/**
	 * 这一棒的形状（轮次 / 位次 / 下一位 / 提及）。**唯一的算法出处**：`speak()` 与
	 * `speechPlan()` 都走它 —— 免得「谁在算下一位」出现两套口径（v1.10.0 抽出来）。
	 * @param player - 这一棒的发言者；调用方保证它就是 `expectedSpeaker()`。
	 */
	#speechShape(player) {
		const total = this.players.length;
		const index = this.position + 1;
		const isFinal = this.round >= DAY_ROUNDS && index >= total;
		const next = this.players[index % total];                  // 与 #turnText 同一算法：跨轮循环
		const mentionNext = isFinal !== true && next.human !== true;
		return {
			round: this.round,
			index,
			total,
			isFinal,
			next,
			mentionNext,
			mentions: mentionNext ? ['all', next.name] : ['all']
		};
	}

	/**
	 * v1.9.0（B 方案）：**玩家把这一轮的发言交给庄家代投**。
	 *
	 * 动机（用户 2026-10-04 的实测）：让模型自己填房间、写前缀、数「下一位是谁」时，
	 * 会出现进错房间、前缀写错、唤醒错人甚至漏唤醒（本机空转提醒是关的，漏唤醒=干等）。
	 * 这里把三件事全收到插件：**房间**（调用方用 `game.roomId`）、**前缀**（本方法生成）、
	 * **提及**（按下一位是谁算）。模型只剩正文。
	 *
	 * 输出的 `mentions` 与今天模型自己写的那套**逐字等价**：
	 *   - 正常一位：`["all", 下一位别名]`（下一位是跨轮循环的，第 1 轮末位照旧唤醒第 2 轮首位）；
	 *   - 第 5 轮最后一位（`isFinal`）：只 `["all"]`（没有下一棒）；
	 *   - 下一位是**真人**：只 `["all"]`（点名对真人无效、还可能让这条发不出去）；
	 *     他靠房间发言框上的只读前缀条知道自己该发言了（v1.10.1 起不再自动私聊提醒）。
	 *
	 * @param sessionId - 调用者会话 id。
	 * @param body - 正文（**不含前缀**；投票阶段放投票原文）。
	 * @returns `{ ok: true, kind, text, mentions, author, authorAlias, round, index, seat, name, next, final }`
	 *   或 `{ ok: false, reason }`（reason 是可直接回给模型的说明，且**不投递**）。
	 *   `kind` = `'speech'`（白天发言，带前缀）/ `'vote'`（投票阶段，正文原样 + 只 @all）/
	 *   `'closing'`（结算之后的完赛感想，同上，且每人只收第一条）。
	 */
	speak(sessionId, body) {
		const id = String(sessionId);
		if (this.paused) return { ok: false, reason: '本局已暂停（等观察员 /ww-resume）；本条未投递。' };
		if (!this.playable) return { ok: false, reason: '本局不可用；本条未投递。' };
		// v1.15.1（用户 2026-10-05）：「**投票阶段也支持投票**，兜底 AI 用顺手了搞错命令」——
		// 原来这一步直接回「现在不是发言阶段」，习惯用 wolf_speak 的 AI 会卡在收票阶段。
		// 投票不是发言：正文**原样**（不加 `【R…】` 前缀）、提及只给 `['all']`（不唤醒谁），
		// 发进房间之后照旧由 `onRoomMessage` → `parseVote` 收票 ⇒ 与 chat_send 那条路完全等价。
		if (this.phase === PHASE.VOTE) {
			const player = this.bySession(id);
			if (player === undefined) return { ok: false, reason: '你不在本局玩家名单里；本条未投递。' };
			const text = String(body ?? '').trim();
			if (text === '') return { ok: false, reason: '投票正文不能为空；本条未投递。' };
			return {
				ok: true,
				kind: 'vote',
				round: null,
				index: null,
				seat: player.seat,
				name: player.name,
				author: String(player.sessionId),
				authorAlias: player.name,
				text,
				mentions: ['all'],
				next: null,
				final: false
			};
		}
		// v1.16.0：**结算/终止之后**也认它 —— 完赛感想（正文原样、只 @all、不加前缀）。
		// 与投票那条同一套理由：AI 用顺手的是这个工具，赛后想说一句不该被「不是发言阶段」挡住。
		// 每人只收第一条（`closing` 里记过就拒，免得房间里留一句不进复盘的废话）。
		if (this.phase === PHASE.SETTLED || this.phase === PHASE.ENDED) {
			const player = this.bySession(id);
			if (player === undefined) return { ok: false, reason: '你不在本局玩家名单里；本条未投递。' };
			if (this.closing.some((entry) => entry.sessionId === player.sessionId)) {
				return { ok: false, reason: '你赛后已经说过一条了（每人只收第一条进复盘）；本条未投递。' };
			}
			const text = String(body ?? '').trim();
			if (text === '') return { ok: false, reason: '感想正文不能为空；本条未投递。' };
			// v1.16.2（用户 2026-10-05）：**真人赛后第一条自动 AT 全员**（由发言框接管补提及）——
			// 他一句话就把所有人唤醒，AI 顺着回话、顺便把感想说了；庄家不再发邀请。
			// ⚠ AI 席位**只 @all（不唤醒谁）**：否则每个 AI 的感想都会再把其他 AI 叫醒一轮，
			// 变成"说一句吵醒全场"的回声风暴（而且他们大多已经说过了）。
			const mentions = player.human === true
				? ['all', ...this.players.filter((other) => other.human !== true).map((other) => other.name)]
				: ['all'];
			return {
				ok: true,
				kind: 'closing',
				round: null,
				index: null,
				seat: player.seat,
				name: player.name,
				author: String(player.sessionId),
				authorAlias: player.name,
				text,
				mentions,
				next: null,
				final: false
			};
		}
		if (this.phase !== PHASE.DAY) return { ok: false, reason: `现在不是发言阶段（当前：${this.phaseLabel()}）；本条未投递。` };
		const player = this.bySession(id);
		if (player === undefined) return { ok: false, reason: '你不在本局玩家名单里；本条未投递。' };
		const expected = this.expectedSpeaker();
		if (player.seat !== expected.seat) {
			return { ok: false, reason: `还没轮到你 —— 现在应由 ${expected.name} 发言（第 ${this.round} 轮第 ${this.position + 1} 位）；本条未投递。` };
		}
		const text = String(body ?? '').trim();
		if (text === '') return { ok: false, reason: '正文不能为空；本条未投递。' };

		const shape = this.#speechShape(player);
		return {
			ok: true,
			kind: 'speech',
			round: shape.round,
			index: shape.index,
			seat: player.seat,
			name: player.name,
			author: String(player.sessionId),
			authorAlias: player.name,
			text: `${speechPrefix(shape.round, shape.index, player.name)}${text}`,
			mentions: shape.mentions,
			next: shape.mentionNext ? shape.next.name : null,
			final: shape.isFinal === true
		};
	}

	/**
	 * 一条普通发言判定（§4.2）。
	 *
	 * v1.10.0：真人那一棒的**前缀与提及已在落盘之前由庄家补好**（dsh-chat 的发言适配器
	 * 调 `speak()`，见 index.js 的 `rewriteHumanSpeech`），所以这里不再有「他忘了点下一位
	 * 怎么办」的问题 —— v1.9.0 的兜底唤醒 `#wakeNextIfUnmentioned` 连同它的 `mentions` /
	 * `canonical` 参数一并删除。
	 */
	#speech(player, text) {
		const prefix = parseSpeechPrefix(text);
		const base = { type: 'speech', seat: player.seat, name: player.name, text, round: this.round, position: this.position, prefix: prefix ?? null };
		const expected = this.expectedSpeaker();

		if (prefix === undefined) {
			const reason = `缺少【R${this.round}-{序号} · {别名}】前缀`;
			return this.#rejectSpeech(base, reason, expected);
		}
		if (prefix.round !== this.round) {
			return this.#rejectSpeech(base, `轮次不符（本条声明 R${prefix.round}，当前 R${this.round}）`, expected);
		}
		// 真人席位也接受房间视图里的自称（dsh-chat 把它显示成 You/你）。
		if (!sameName(prefix.alias, player.name) && !(player.human === true && /^(you|你)$/iu.test(prefix.alias))) {
			return this.#rejectSpeech(base, '署名与发言者不符', expected);
		}
		if (this.spokeThisRound(player)) {
			// 本轮已发过言：本条不计入（规则卡把「重复」与「作废」分开处理）。
			return this.#rejectSpeech(base, '重复发言', expected);
		}
		if (prefix.index <= this.position) {
			// 尚未发言者声称已经走过的序号 ⇒ 顺序重排无法复原 ⇒ 本轮作废重来（§4.2-3）。
			this.#note({ ...base, decision: 'void' });
			return this.#voidRound('序号回退');
		}
		if (prefix.index > this.position + 1) {
			return this.#rejectSpeech(base, `抢发（跳号：声明第 ${prefix.index} 位）`, expected);
		}
		if (player !== expected) {
			return this.#rejectSpeech(base, `顺序错（当前应由 ${expected.name} 发言）`, expected);
		}
		if (prefix.body === '') {
			return this.#rejectSpeech(base, '只有定向、没有正文', expected);
		}

		this.position += 1;
		this.voidCount = 0;
		this.#note({ ...base, decision: 'accepted' });
		const effects = [this.#audit({ type: 'speech', ...base, decision: 'accepted', nextPosition: this.position })];
		if (this.position >= this.players.length) {
			if (this.round >= DAY_ROUNDS) {
				effects.push(...this.#openVote());
			} else {
				this.round += 1;
				this.position = 0;
				this.#note({ type: 'round-advanced', round: this.round });
				effects.push(this.#audit({ type: 'round-advanced', round: this.round }));
			}
		}
		return effects;
	}

	/**
	 * v1.10.1（用户 2026-10-04 要求）：**删掉「轮到你发言」的自动私聊提醒**。
	 *
	 * 它原来的作用是「真人不在 AI 的唤醒链上，得有人叫他」；现在房间发言框上有只读前缀条
	 * （dsh-chat 补丁 20 的 `composerRule`，由 `speechPlan()` 供数据），轮到他时那条提示自己会出现
	 * ⇒ 再往他信箱里投一条就是重复通知（还会把信箱会话顶到侧栏最上面）。
	 * 需要人工催时仍有 `/ww-nudge`（走 `idleTarget()` → `#pendingActions()`，文案不变）。
	 */

	/** 本轮该玩家是否已有效发言（作废重来会清空本轮记录）。 */
	spokeThisRound(player) {
		const BARRIERS = ['round-advanced', 'day-open', 'round-void'];
		const start = this.log.findLastIndex((entry) => BARRIERS.includes(entry.type));
		const since = this.log.slice(start < 0 ? 0 : start + 1);
		return since.some((entry) => entry.type === 'speech' && entry.decision === 'accepted' && entry.seat === player.seat);
	}

	#rejectSpeech(base, reason, expected) {
		this.#note({ ...base, decision: 'rejected', reason });
		return [
			this.#room(T.invalidSpeech(reason, expected.name)),
			this.#audit({ type: 'speech', ...base, decision: 'rejected', reason, expected: expected.name })
		];
	}

	/** 本轮作废重来（§4.2-3）。 */
	#voidRound(reason) {
		this.position = 0;
		this.voidCount += 1;
		this.#note({ type: 'round-void', round: this.round, reason, count: this.voidCount });
		const effects = [
			this.#room(T.roundVoid(this.round)),
			this.#audit({ type: 'round-void', round: this.round, reason, count: this.voidCount })
		];
		if (this.voidCount >= 3) {
			this.paused = true;
			effects.push(this.#room(T.voidLimit(this.round, 3)));
			effects.push(this.#audit({ type: 'auto-pause', reason: 'void-limit' }));
		}
		return effects;
	}

	// ---------------------------------------------------------------- 投票（§5）

	#openVote() {
		this.phase = PHASE.VOTE;
		this.voteOpenAt = this.now();
		this.position = 0;
		// 「广播 + 逐个 AT」：AI 席位用一条消息的具名提及唤醒；真人席位**不能被提及**
		// （点名即唤醒其私聊会话，会把夜聊带进模型上下文），改用私聊提醒。
		// v1.17.1：与结算公告共用 `#gatherMentions()`（同一处定义，行为不变）。
		const mentions = this.#gatherMentions();
		const effects = [
			this.#audit({ type: 'vote-open' }),
			this.#room(T.voteOpen(), mentions)
		];
		for (const human of this.humans()) {
			// v1.15.0：投票卡带按钮（`channel: 'room'` ⇒ 点下去是以他的席位身份往房间发一条公开投票）。
			effects.push(this.#dmSeat(human, T.humanVote(this.players.map((player) => player.name)), { options: this.#voteOptions(human), channel: 'room' }));
			effects.push(this.#audit({ type: 'human-vote-ping', seat: human.seat }));
		}
		return effects;
	}

	/**
	 * 解析一条投票消息。
	 *
	 * **容忍"带前缀／装饰"的写法**（用户 2026-10-04 真机报的 bug：`【投票 · 小鲸鱼】投票：小米`
	 * 被判"无法识别"）。旧实现按**第一个**「投票」二字切分：装饰里那个"投票"先命中，于是装饰里
	 * 投票人自己的名字被算成候选 ⇒「小鲸鱼 + 小米」两个候选 ⇒ 歧义 ⇒ 复问。
	 *
	 * 分层解析，**不猜**（宁可复问，也不能把票记到错的人头上）：
	 * 1) 剥掉**行首**的装饰块（`【…】`/`「…」`/`[…]`/`（…）`/引用符），它们不是投票正文；
	 * 2) 取**投票标记之后**的正文（`投票：`／`投票  `／`投票`）；
	 * 3) 再剥掉正文里成对的括号说明（`（因为…）`）后数候选：恰好一个 ⇒ 认；
	 * 4) 步骤 3 得到 0 个或多个 ⇒ 退回"整条消息里恰好一个候选"（兼容裸写一个名字）；
	 * 5) 仍没有 ⇒ 未解析；多个 ⇒ 同时标 `ambiguous` 便于审计区分"歧义"与"没写"。
	 * @param text - 房间里的原始消息。
	 * @returns `{ target, ambiguous? }`；`target` 为座位号、`PEACE`、`ABSTAIN` 或 undefined。
	 */
	parseVote(text) {
		const raw = norm(text);
		if (/^弃票|^弃权|不投/u.test(raw)) return { target: ABSTAIN };
		// 1) 行首装饰块（可能套好几层：`> 【…】「…」投票：甲`）
		let body = raw;
		for (;;) {
			const cut = body.replace(/^[>〉》\s]+/u, '').replace(/^(?:【[^】]*】|「[^」]*」|\[[^\]]*\]|（[^）]*）|\([^)]*\))\s*/u, '');
			if (cut === body) break;
			body = cut;
		}
		body = body.trim();
		// 2) 投票标记之后的正文（标记取**第一个**，但装饰已在步骤 1 剥掉，不会误命中装饰里的"投票"）
		const marked = /投票\s*[:：]?\s*/u.exec(body);
		const clause = (marked === null ? body : body.slice(marked.index + marked[0].length)).trim();
		// 3) 括号说明不算候选
		const bare = clause.replace(/(?:【[^】]*】|「[^」]*」|\[[^\]]*\]|（[^）]*）|\([^)]*\))/gu, '').trim();
		const inBare = this.#voteCandidates(bare);
		if (inBare.size === 1) return { target: [...inBare][0] };
		// 4) 退回整条消息（兼容"整条就是一个名字/平安夜"）
		const inAll = this.#voteCandidates(body);
		if (inAll.size === 1) return { target: [...inAll][0] };
		// 5) 一个座位名都没匹配到 ⇒ 试宽松解析（真人房间侧身份 `You`/`你`、会话 id 等别名写法）
		for (const candidate of [bare, clause, body]) {
			if (candidate === '') continue;
			const hit = this.resolveSeat(candidate);
			if (hit && hit.player) return { target: hit.player.seat };
		}
		return { target: undefined, ambiguous: inAll.size > 1 || inBare.size > 1 };
	}

	/** 收集投票候选：正文里出现的座位名 + 平安夜。 */
	#voteCandidates(text) {
		const found = new Set();
		for (const player of this.players) if (text.includes(player.name)) found.add(player.seat);
		if (/平安夜/u.test(text)) found.add(PEACE);
		return found;
	}

	#vote(player, text) {
		const parsed = this.parseVote(text);
		if (parsed.target === undefined) {
			return [
				// v1.15.0：真人这条复问同样带按钮（点错了还能顺着按钮再点）。
				player.human
					? this.#dmSeat(player, T.voteRetryHuman(), { options: this.#voteOptions(player), channel: 'room' })
					: this.#dmSeat(player, T.voteRetry()),
				this.#audit({ type: 'vote', seat: player.seat, name: player.name, raw: text, decision: 'unparsed', ambiguous: parsed.ambiguous === true })
			];
		}
		this.voteSeq += 1;
		this.votes.set(player.sessionId, { target: parsed.target, raw: text, at: this.now(), seq: this.voteSeq });
		const effects = [this.#audit({ type: 'vote', seat: player.seat, name: player.name, target: parsed.target, raw: text, decision: parsed.target === ABSTAIN ? 'abstain' : 'accepted', seq: this.voteSeq })];
		if (this.votes.size >= this.players.length) effects.push(...this.closeVote('all-in'));
		return effects;
	}

	/** 覆盖一票（观察员 /ww-override-vote）。 */
	overrideVote(seatRef, targetRef) {
		if (!this.playable) return this.effectsForAudit([{ type: 'override-rejected', reason: 'ended' }]);
		const seat = this.resolveSeat(seatRef);
		if (!seat || !seat.player) return this.effectsForAudit([{ type: 'override-rejected', reason: 'unknown-seat', seatRef: String(seatRef) }]);
		let target;
		if (String(targetRef).trim() === PEACE) target = PEACE;
		else if (/^弃票|^弃权$/u.test(String(targetRef).trim())) target = ABSTAIN;
		else {
			const hit = this.resolveSeat(targetRef);
			if (!hit || !hit.player) return this.effectsForAudit([{ type: 'override-rejected', reason: 'unknown-target', targetRef: String(targetRef) }]);
			target = hit.player.seat;
		}
		this.voteSeq += 1;
		this.votes.set(seat.player.sessionId, { target, raw: `[override] ${targetRef}`, at: this.now(), seq: this.voteSeq, override: true });
		return this.effectsForAudit([{ type: 'override-vote', seat: seat.player.seat, target }]);
	}

	/** 只产审计效果（命令路径下没有对外输出时用）。 */
	effectsForAudit(records) {
		return this.#emit(records.map((record) => this.#audit(record)));
	}

	/** 计票。 */
	tally() {
		const counts = new Map();
		const ballot = [];
		const abstain = [];
		for (const player of this.players) {
			const vote = this.votes.get(player.sessionId);
			if (!vote) {
				abstain.push({ seat: player.seat, name: player.name, reason: 'no-declaration' });
				continue;
			}
			if (vote.target === ABSTAIN) {
				abstain.push({ seat: player.seat, name: player.name, reason: 'explicit' });
				continue;
			}
			ballot.push({ seat: player.seat, name: player.name, target: vote.target, raw: vote.raw, override: vote.override === true });
			counts.set(vote.target, (counts.get(vote.target) ?? 0) + 1);
		}
		const max = counts.size === 0 ? 0 : Math.max(...counts.values());
		const leaders = max === 0 ? [] : [...counts.entries()].filter(([, n]) => n === max).map(([target]) => target);
		return { counts, ballot, abstain, max, leaders };
	}

	/**
	 * 结算（§6）：按换卡后的现值算阵营。
	 * @returns 结算对象（含各分支的可审计字段）。
	 */
	computeSettlement() {
		const { counts, ballot, abstain, max, leaders } = this.tally();
		const wolves = this.wolves();
		const presentSeats = this.players.map((p) => ({ seat: p.seat, name: p.name, dealt: this.dealt.get(p.sessionId), current: this.hand.get(p.sessionId), camp: campOf(this.hand.get(p.sessionId)) }));
		const wolvesPresent = wolves.length > 0;
		const leaderSeats = leaders.filter((leader) => typeof leader === 'number');
		const leadersIncludePeace = leaders.includes(PEACE);

		let verdict;
		let eliminated = [];
		/** 一名玩家被淘汰时的胜负（规则卡 §游戏胜败 第 1/2 条 + 末条：场上无狼却误杀同伴 ⇒ 人类阵营失败）。 */
		const verdictForLynched = (seat) => {
			if (presentSeats[seat - 1].camp === 'wolf') return 'human-single-wolf';
			return wolvesPresent ? 'wolf-single-human' : 'wolf-mislynch-no-wolf';
		};
		if (leaders.length === 0) {
			// v1.13.1（用户 2026-10-05 的口径）：**全场弃票算做平安夜** —— 胜负按「场上有没有狼」判。
			// 结算正文里照样会列出「（无有效票）+ 弃票名单」，所以记录看得出这是弃票而非真的投了平安夜。
			verdict = wolvesPresent ? 'wolf-peace-with-wolf' : 'human-peace-no-wolf';
		} else if (leaders.length === 1) {
			if (leadersIncludePeace) {
				verdict = wolvesPresent ? 'wolf-peace-with-wolf' : 'human-peace-no-wolf';
			} else {
				const seat = leaderSeats[0];
				eliminated = [seat];
				verdict = verdictForLynched(seat);
			}
		} else if (leaders.length === 2) {
			if (leadersIncludePeace) {
				// 平安夜 N 票 + 某玩家 N 票 ⇒ 按淘汰该 1 名玩家算（§游戏胜败 第 5 条）。
				const seat = leaderSeats[0];
				eliminated = [seat];
				verdict = verdictForLynched(seat);
			} else {
				// 2:2 / 3:3 / 2:2:… 里最高的两位并列 ⇒ **两名玩家都淘汰**（第 4 条）。
				eliminated = [...leaderSeats];
				const anyWolf = leaderSeats.some((seat) => presentSeats[seat - 1].camp === 'wolf');
				verdict = anyWolf ? 'human-double' : 'wolf-double-human';
			}
		} else {
			// 三方及以上并列（含「平安夜 + 两名玩家」）⇒ 谁都不淘汰（第 6 条）。
			verdict = wolvesPresent ? 'wolf-no-lynch' : 'human-no-lynch';
		}
		const winner = verdict.startsWith('human') ? 'human' : 'wolf';
		return {
			verdict,
			winner,
			sentence: verdictSentence(verdict),
			leaders: leaders.map((leader) => (leader === PEACE ? PEACE : presentSeats[leader - 1].name)),
			max,
			counts: Object.fromEntries([...counts.entries()].map(([target, n]) => [target === PEACE ? PEACE : presentSeats[target - 1].name, n])),
			ballot: ballot.map((entry) => ({ ...entry, targetName: entry.target === PEACE ? PEACE : presentSeats[entry.target - 1].name })),
			abstain,
			eliminated,
			seats: presentSeats,
			pile: [...this.pile],
			wolvesPresent,
			formal: true
		};
	}

	/**
	 * 收票并结算（§5.3 / §6）。
	 * @param reason - `all-in` / `observer` / `timeout`。
	 */
	closeVote(reason = 'observer') {
		if (this.phase === PHASE.SETTLED || this.phase === PHASE.ENDED) return [];
		this.settlement = this.computeSettlement();
		this.settlement.reason = reason;
		// v1.8.0：写手在这里才定（用户要求"不要事先指定"）——判定要用的胜负已经算完了。
		this.assignRecapWriter(this.settlement);
		this.phase = PHASE.SETTLED;
		const effects = this.#settlementEffects(`（${this.settlement.reason}）`);
		return effects;
	}

	/**
	 * 观察员 `/ww-end [--void]`：终止本局（可按当前状态给**非正式**参考结算，§10）。
	 *
	 * **身份表只回给执行命令的那个会话**（`observerSessionId`），房间只发一条中性通知。
	 * 首轮测试的教训：旧实现把"仅供观察员"的身份表广播进了房间，全体玩家都看到了。
	 * @param options - `{ observerSessionId, void }`：`void` = 作废（不产生结算记录、不写复盘 raw）。
	 */
	endInformally(options = {}) {
		if (this.phase === PHASE.ENDED) return this.effectsForAudit([{ type: 'end-rejected', reason: 'already-ended' }]);
		const isVoid = options.void === true;
		const observerSessionId = options.observerSessionId === undefined || options.observerSessionId === null ? undefined : String(options.observerSessionId);
		const partial = this.phase === PHASE.VOTE ? this.computeSettlement() : null;
		// 非正式终止也走同一套写手规则（只要算出了参考结算）；作废局不写 raw，写手只出现在观察员报告里。
		if (partial !== null) this.assignRecapWriter(partial);
		const phaseBefore = this.phaseLabel();
		this.endedInformally = true;
		if (isVoid) this.voided = true;
		this.playable = false;
		this.phase = PHASE.ENDED;

		const effects = [this.#room(isVoid ? T.voidedNotice() : T.endedNotice())];
		const reveal = this.players.map((player) => `${player.seat}.${player.name}｜发到：${this.dealt.get(player.sessionId)}｜现值：${this.hand.get(player.sessionId)}`).join('  ');
		const title = isVoid ? '本局作废（不产生结算记录）' : '非正式终止';
		const report = partial !== null
			? `${title}（对照当前票型的参考结算，非正式）：\n${this.#settlementText({ ...partial, formal: false }, '（非正式）')}`
			: `${title}：当时处于${phaseBefore}，未进入投票阶段。\n身份表：${reveal}\n牌堆：${compositionText(this.pile)}`;
		if (observerSessionId !== undefined && observerSessionId !== '') {
			effects.push({ type: 'dm', sessionId: observerSessionId, text: T.observerReport(report), wake: false });
		}
		effects.push(this.#audit({ type: 'end-informal', secret: true, generalized: isVoid ? 'void' : 'end', partial: partial ? partial.verdict : null, reportedTo: observerSessionId ?? null }));
		this.#note({ type: 'end-informal', voided: isVoid });
		return effects;
	}

	#settlementEffects(note) {
		// v1.17.1（用户 2026-10-06 定 B 方案）：结算公告从**知悉型**（`@all`）改成**召集**
		// （`@all` + 具名 AI 席位），并在正文末尾点明"可以开始说感想了"。
		// 理由（局11 实测）：知悉型公告下，"正在跑长回合的人顺手就写了感想、空闲的人什么也收不到、
		// 只能干等观察员点名" ⇒ 赛后起跑线取决于**运气**。本机这批模型普遍长思考（想几十分钟是常态），
		// 回合跨过结算边界必然发生 ⇒ 必须让**所有人**都收到同一个开场信号。
		const text = `${this.#settlementText(this.settlement, note)}\n${T.closingOpen()}`;
		const effects = [
			this.#room(text, this.#gatherMentions()),
			this.#audit({ type: 'settle', secret: true, verdict: this.settlement.verdict, winner: this.settlement.winner, counts: this.settlement.counts, eliminated: this.settlement.eliminated })
		];
		this.#note({ type: 'settle', verdict: this.settlement.verdict, winner: this.settlement.winner });
		return effects;
	}

	#settlementText(settlement, note) {
		const lines = [];
		lines.push(`${T.voteTallyHeader()}${note}`);
		const tallyOrder = [...settlement.ballot].sort((a, b) => a.seat - b.seat);
		if (tallyOrder.length === 0) lines.push('  （无有效票）');
		for (const entry of tallyOrder) lines.push(`  ${entry.seat}.${entry.name} → ${entry.targetName}${entry.override ? '（观察员覆写）' : ''}`);
		if (settlement.abstain.length > 0) lines.push(`  弃票：${settlement.abstain.map((entry) => `${entry.seat}.${entry.name}`).join('、')}`);
		lines.push(T.revealHeader());
		lines.push('  座位 | 被发到的牌 | 现值（换卡后）');
		for (const seat of settlement.seats) lines.push(`  ${seat.seat}.${seat.name} | ${seat.dealt} | ${seat.current}`);
		lines.push(`${T.pileHeader()}${compositionText(settlement.pile)}`);
		// v1.16.8（规则卡 §4）：结算后公布牌面供对账，并给出开局承诺哈希与夜序记录哈希。
		if (this.commitmentHash !== null) {
			// v1.16.10：把**承诺原串**一起交给模板 —— 结算列表里的牌堆是 `compositionText()` 的分类计数
			// （"村民×1、怪盗×1"），丢掉了承诺时的原始顺序 ⇒ 复算者按列表顺序拼串会得到不匹配值，
			// 看着像"牌被改过"（第 9 局实测：pile[村民,怪盗] 与 pile[怪盗,村民] 的哈希不同）。
			// 原串照抄即可复算，顺序不再靠猜。
			lines.push(T.commitmentEcho({
				hash: this.commitmentHash,
				salt: this.commitmentSalt,
				payload: this.#commitmentPayload(),
				nightHash: this.#nightTraceHash(),
				nightCount: this.nightTrace.length
			}));
		}
		lines.push(`${settlement.winner === 'human' ? '人类阵营获胜！' : '狼阵营获胜！'}`);
		lines.push(settlement.sentence);
		if (this.recapWriter) lines.push(T.recapAssign(this.recapWriter));
		return lines.join('\n');
	}

	/** 观察员 /ww-recount：重算当前票型（公开安全，不含牌面）。 */
	recount() {
		const { ballot, abstain, counts, max, leaders } = this.tally();
		const names = new Map(this.players.map((p) => [p.seat, p.name]));
		const parts = [...counts.entries()].map(([target, n]) => `${target === PEACE ? PEACE : names.get(target)} ${n} 票`);
		return {
			text: [
				`当前票型（${this.votes.size}/${this.players.length} 已投）：${parts.join('、') || '暂无有效票'}`,
				ballot.map((entry) => `${entry.seat}.${entry.name}→${entry.target === PEACE ? PEACE : names.get(entry.target)}`).join('  '),
				abstain.length > 0 ? `未声明/弃权：${abstain.map((entry) => `${entry.seat}.${entry.name}`).join('、')}` : '',
				`最高票：${leaders.length === 0 ? '（无）' : leaders.map((leader) => (leader === PEACE ? PEACE : names.get(leader))).join('、')}（${max} 票）`
			].filter((line) => line !== '').join('\n')
		};
	}

	// ---------------------------------------------------------------- 观察员控制（§10）

	setPaused(paused) {
		if (this.paused === paused) return this.effectsForAudit([{ type: paused ? 'pause' : 'resume', noop: true }]);
		this.paused = paused;
		const effects = [this.#room(paused ? T.paused() : T.resumed()), this.#audit({ type: paused ? 'pause' : 'resume' })];
		this.#note({ type: paused ? 'pause' : 'resume' });
		return effects;
	}

	/** 观察员手动作废当前轮。 */
	voidRoundManually(reason = 'observer') {
		return this.#voidRound(reason);
	}

	/** 空转提醒目标（§4.3）：夜间提醒带上信道提示，白天提醒说的是房间发言，不带。 */
	idleTarget() {
		// 与手动催人共用同一判据（`#pendingActions`）：谁该动由状态机说了算，不靠时间猜。
		const first = this.#pendingActions()[0];
		if (first === undefined) return null;
		return { sessionId: first.player.sessionId, text: this.#seatText(first.player, first.text, first.hint === true) };
	}

	phaseLabel() {
		return { night: '夜间', day: `白天第${this.round}轮`, vote: '投票', settled: '已结算', ended: '已终止' }[this.phase] ?? this.phase;
	}

	// ---------------------------------------------------------------- 持久化与导出

	/** 结构化对局记录（§7-1，含牌面，只在结算后写出）。 */
	rawExport() {
		const settlement = this.settlement;
		return {
			gameId: this.gameId,
			no: this.no,
			room: { id: this.roomId, name: this.roomName },
			mode: this.mode,
			seed: this.seed,
			startedAt: this.startedAt,
			recapWriter: this.recapWriter,
			players: this.players.map((p) => ({ seat: p.seat, name: p.name, sessionId: p.sessionId, human: p.human === true, dealt: this.dealt.get(p.sessionId), current: this.hand.get(p.sessionId), camp: campOf(this.hand.get(p.sessionId)) })),
			pile: [...this.pile],
			night: this.log.filter((entry) => String(entry.type).startsWith('night') || entry.type === 'deal' || entry.type === 'seer-read' || entry.type === 'swap'),
			day: this.log.filter((entry) => entry.type === 'speech' || entry.type === 'round-void' || entry.type === 'round-advanced' || entry.type === 'day-open'),
			votes: settlement ? settlement.ballot : [...this.votes.entries()].map(([sessionId, vote]) => ({ seat: this.bySession(sessionId).seat, target: vote.target, raw: vote.raw, override: vote.override === true })),
			settlement: settlement ?? null,
			// v1.16.0：完赛感想（结算后每人第一条房间发言；可能为空 ⇒ 导出时整节不出现）。
			closing: this.closing.map((entry) => ({ ...entry })),
			log: this.log,
			informal: this.endedInformally
		};
	}

	/** 序列化（写私有状态文件）。 */
	toJSON() {
		return {
			version: 1,
			roomId: this.roomId,
			roomName: this.roomName,
			mode: this.mode,
			players: this.players,
			seed: this.seed,
			gameId: this.gameId,
			no: this.no,
			phase: this.phase,
			startedAt: this.startedAt,
			paused: this.paused,
			playable: this.playable,
			nightStep: this.nightStep,
			nightAwaiting: this.nightAwaiting,
			nightDone: this.nightDone,
			round: this.round,
			position: this.position,
			voidCount: this.voidCount,
			voteOpenAt: this.voteOpenAt,
			votes: [...this.votes.entries()],
			voteSeq: this.voteSeq,
			settlement: this.settlement,
			recapWriter: this.recapWriter,
			endedInformally: this.endedInformally,
			voided: this.voided,
			closing: this.closing,
			closingPrompt: this.closingPrompt,
			observerClosing: this.observerClosing,
			dealt: [...this.dealt.entries()],
			hand: [...this.hand.entries()],
			commitmentHash: this.commitmentHash,
			commitmentSalt: this.commitmentSalt,
			nightSalt: this.nightSalt,
			nightTrace: this.nightTrace,
			pile: this.pile,
			log: this.log,
			outSeq: this.outSeq,
			lastActivityAt: this.lastActivityAt
		};
	}

	/**
	 * 反序列化（DSH 重启后续局）。
	 * @param data - `toJSON()` 的输出。
	 */
	static fromJSON(data) {
		// 走构造函数重建（同 seed ⇒ 同牌序），再覆盖可变状态：私有方法只能由构造函数装到实例上。
		const game = new Game({ roomId: data.roomId, roomName: data.roomName, mode: data.mode, players: data.players, seed: data.seed, gameId: data.gameId, no: data.no });
		game.phase = data.phase;
		game.startedAt = data.startedAt;
		game.paused = data.paused;
		game.playable = data.playable !== false;
		game.nightStep = data.nightStep;
		game.nightAwaiting = data.nightAwaiting;
		game.nightDone = data.nightDone;
		game.round = data.round;
		game.position = data.position;
		game.voidCount = data.voidCount;
		game.voteOpenAt = data.voteOpenAt;
		game.votes = new Map(data.votes);
		game.voteSeq = data.voteSeq;
		game.settlement = data.settlement;
		game.recapWriter = data.recapWriter;
		game.endedInformally = data.endedInformally === true;
		game.voided = data.voided === true;
		game.closing = Array.isArray(data.closing) ? data.closing : [];
		game.closingPrompt = data.closingPrompt === true;
		game.observerClosing = typeof data.observerClosing === 'string' ? data.observerClosing : null;
		game.dealt = new Map(data.dealt);
		game.hand = new Map(data.hand);
		game.commitmentHash = typeof data.commitmentHash === 'string' ? data.commitmentHash : null;
		game.commitmentSalt = typeof data.commitmentSalt === 'string' ? data.commitmentSalt : null;
		game.nightSalt = typeof data.nightSalt === 'string' ? data.nightSalt : null;
		game.nightTrace = Array.isArray(data.nightTrace) ? data.nightTrace : [];
		game.pile = data.pile;
		game.log = data.log;
		game.outSeq = data.outSeq ?? 0;
		game.lastActivityAt = data.lastActivityAt;
		game.now = () => Date.now();
		game.lastOutput = null;
		return game;
	}

	/**
	 * 复盘写手（v1.8.0，用户 2026-10-04 定的规则）：**不再由开局指定**，结算后按结果判定 ——
	 * ① 赢家 1 人、败者为复数 ⇒ 写手 = 赢家；
	 * ② 败者 1 人、赢家为复数 ⇒ 写手 = 败者；
	 * ③ 其余情况（2:2、1:1:1:1、3:0、双方同为复数、场上无狼但判狼胜…）⇒ **排序顺序的第一个 AI 席位**。
	 * 赢/败按**换卡后的阵营**（`settlement.seats[].camp`）对 `settlement.winner` 判定。
	 * 全部席位都是真人时退化为第一个席位（不会崩，也没别的可选）。
	 * @param settlement - `computeSettlement()` 的产物。
	 * @returns 写手名（写进 `recapWriter`）。
	 */
	assignRecapWriter(settlement) {
		const winners = settlement.seats.filter((seat) => seat.camp === settlement.winner);
		const losers = settlement.seats.filter((seat) => seat.camp !== settlement.winner);
		let picked;
		if (winners.length === 1 && losers.length > 1) picked = winners[0];
		else if (losers.length === 1 && winners.length > 1) picked = losers[0];
		else picked = this.players.find((player) => player.human !== true) ?? this.players[0];
		this.recapWriter = picked === undefined ? null : picked.name;
		return this.recapWriter;
	}

	/** 设置复盘写手（§7.2；现在只由 `assignRecapWriter` 在结算时调用，保留为显式入口便于测试）。 */
	setRecapWriter(name) {
		this.recapWriter = name === undefined || name === null ? null : norm(name);
		return this.recapWriter;
	}
}
