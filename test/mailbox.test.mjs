// v1.11.0：房间里打命令 + 私密内容走弹窗（不落任何会话）。
//
// 这一套件验的是本轮改动的两条主线：
//   ① 房间里打的 `/ww-*` 被发言适配器**吞掉**（房间与 rooms.json 都不该留下它），但命令确实执行了；
//   ② 弹窗模式真人的私密内容（发牌 / 夜序提问 / 命令回执）**不进任何会话**，只进局内弹窗信箱，
//      由 `/api/dsh-werewolf` 的 `inbox` 端点吐给浏览器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Harness, makeTempDir } from './helpers.mjs';
import { Game, PEACE, ROLES } from '../lib/engine.js';
import { DEALER_ID } from '../index.js';

/**
 * 找一个满足条件的种子（否则夜序可能一步都没有、或就某席位的第一条私聊没有定论）。
 * 做法与 acceptance 的 `findSeed` 一致：建探针局、看牌面。
 * @param predicate - `(roles) => boolean`，`roles` 按座位顺序。
 */
function seedWhere(predicate, mode = 3) {
	for (let seed = 1; seed < 2000; seed += 1) {
		const probe = new Game({ roomId: 'probe', roomName: 'probe', mode, players: ['a', 'b', 'c'].slice(0, mode).map((name, index) => ({ name, sessionId: `p${index}` })), seed, gameId: 'probe' });
		if (predicate([...probe.dealt.values()])) return seed;
	}
	throw new Error('找不到满足条件的种子');
}
/** 预言家在场 ⇒ 夜序一定有步骤（否则可能直接进白天，`/ww-reply` 那条链就无从验起）。 */
const SEED = seedWhere((roles) => roles.includes(ROLES.SEER));
/** 第 3 席（真人那一席）拿预言家 ⇒ 他开局必有一条夜序提问私聊（确定性用）。 */
const SEED_HUMAN_SEER = seedWhere((roles) => roles[2] === ROLES.SEER);
/** 第 3 席拿怪盗 ⇒ 夜序走到「怪盗」那一步必然问他换不换。 */
const SEED_HUMAN_TRICKSTER = seedWhere((roles) => roles[2] === ROLES.TRICKSTER);

/** 状态目录里出现的局 id（`<gameId>.json` 的名字）。 */
const stateGameIds = (h) => readdirSync(h.stateDir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
/** 有弹窗信箱文件的那些局 id。 */
const mailGameIds = (h) => readdirSync(h.stateDir).filter((name) => name.endsWith('.mail.jsonl')).map((name) => name.slice(0, -'.mail.jsonl'.length));

/** 建一个「真人在房间里」的测试台。 */
function harness(options = {}) {
	const nonce = randomUUID().slice(0, 6);
	const aiNames = [`甲${nonce}`, `乙${nonce}`];
	const aiPlayers = aiNames.map((name) => ({ name, sessionId: `session-${randomUUID()}` }));
	const humanName = `丙${nonce}`;
	const extraSession = `session-${randomUUID()}`;
	const h = new Harness({
		players: aiPlayers,
		stateDir: join(makeTempDir('werewolf-roomcmd'), 'state'),
		exportDir: join(makeTempDir('werewolf-roomcmd-export'), 'raw'),
		extraSessions: [extraSession],
		...(options.hasConsume === undefined ? {} : { hasConsume: options.hasConsume })
	});
	return { h, nonce, aiNames, aiPlayers, humanName, extraSession };
}
/** 弹窗模式开局（在房间里打命令，不是斜杠命令）。种子固定，让夜序/首条私聊有定论。 */
async function startInRoom(h, aiNames, humanName, seed = SEED) {
	const result = await h.speakAsHuman(`/ww-start ${h.room.name} 3 ${aiNames[0]} ${aiNames[1]} *${humanName} seed=${seed}`);
	await h.flush();
	return { result, gameId: stateGameIds(h)[0] };
}

/**
 * v1.14.0：用工具替 AI 席位答到「轮到真人」为止；返回他那一刻的**带按钮提问卡**与当时的状态。
 * （按钮只给真人席位画，所以这里只认带 `options` 的记录。）
 */
async function advanceToHumanAsk(h, gameId, maxSteps = 8) {
	for (let guard = 0; guard < maxSteps; guard += 1) {
		const state = h.readState(gameId);
		assert.equal(state.phase, 'night', '夜序还没走完就该停在等待回复的步骤上');
		const waiting = state.nightAwaiting;
		assert.ok(waiting, '夜序应停在等待回复的步骤上');
		if (waiting === h.room.sessionId) {
			const card = h.readMail(gameId).filter((record) => Array.isArray(record.options)).at(-1);
			assert.ok(card, '轮到真人时应有一条带按钮的提问卡');
			return { card, state };
		}
		const answer = new Map(state.dealt).get(waiting) === ROLES.TRICKSTER ? '不换' : '2';
		const receipt = await h.callTool('wolf_reply', { text: answer }, waiting);
		assert.equal(receipt.status, 'accepted', receipt.note);
		await h.flush();
	}
	throw new Error('一直没轮到真人回答');
}

/** 跑完夜序：轮到真人就在房间里打 `/ww-reply`（会被吞掉），轮到 AI 才走工具。 */
async function runNight(h, gameId) {
	for (let guard = 0; guard < 8; guard += 1) {
		const state = h.readState(gameId);
		if (state.phase !== 'night') break;
		const waiting = state.nightAwaiting;
		assert.ok(waiting, '夜序应停在等待回复的步骤上');
		const answer = new Map(state.dealt).get(waiting) === ROLES.TRICKSTER ? '不换' : '2';
		if (waiting === h.room.sessionId) {
			const typed = await h.speakAsHuman(`/ww-reply ${answer}`);
			assert.equal(typed?.consumed, true, '★ 真人在房间里打的夜聊回答被吞掉');
		} else {
			const receipt = await h.callTool('wolf_reply', { text: answer }, waiting);
			assert.equal(receipt.status, 'accepted', receipt.note);
		}
		await h.flush();
	}
	return h.readState(gameId);
}

test('v1.11.0：房间里打 /ww-start ⇒ 命令执行了、房间一个字都没留下', async () => {
	const { h, aiNames, humanName } = harness();
	try {
		const before = h.roomMessages.length;
		const { result, gameId } = await startInRoom(h, aiNames, humanName);
		assert.equal(result?.consumed, true, '★ 适配器把这条消息吞掉了');
		assert.equal(h.roomMessages.some((message) => String(message.text).startsWith('/ww-')), false, '★ 没有任何一条房间消息以 /ww- 开头（命令正文不在公共时间线上）');
		// 房间里多出来的只可能是庄家自己的公开公告（开局公告），绝不是他打的那条命令
		const added = h.roomMessages.slice(before);
		assert.equal(added.every((message) => message.author === DEALER_ID), true, added.map((message) => `${message.author}:${String(message.text).slice(0, 40)}`));

		assert.ok(gameId, '应有一局开起来了');
		const state = h.readState(gameId);
		assert.equal(state.players.find((player) => player.human).name, humanName, '真人席位按他写的名字建好了');
		assert.equal(state.phase, 'night', '开局后进入夜序（种子固定为「预言家在场」⇒ 夜序一定有步骤）');
		const receipt = h.readMail(gameId).find((record) => record.kind === 'command');
		assert.ok(receipt, '开局的回执应进弹窗信箱');
		assert.match(receipt.text, /第\d+局|开局/, receipt.text);
	} finally {
		h.dispose();
	}
});

test('v1.11.0：弹窗模式真人的私密内容**不进任何会话**（发牌/提问只进弹窗信箱）', async () => {
	const { h, aiNames, humanName } = harness();
	try {
		const { gameId } = await startInRoom(h, aiNames, humanName);
		// 真人那一侧：一条 dsh-bridge 投递都没有（他的私密信道就是房间侧身份）
		assert.deepEqual(h.dmsTo(h.room.sessionId), [], '★ 弹窗模式下不往任何会话投递私聊');

		// 把整夜跑完（轮到真人时他在房间里打 /ww-reply）—— 保证他一定被问过至少一次
		const after = await runNight(h, gameId);
		assert.equal(after.phase, 'day', '夜序应能跑完（真人的回答从房间进来也照常生效）');
		assert.deepEqual(h.dmsTo(h.room.sessionId), [], '★ 整夜都不往任何会话投递私聊');

		// 内容确实发出去了 —— 全在弹窗信箱里（发牌 / 夜序提问 / 回答的回执）
		const mail = h.readMail(gameId).filter((record) => record.kind === 'dealer');
		assert.ok(mail.length >= 1, `私密内容应进弹窗信箱（实收 ${mail.length} 条）`);
		assert.equal(mail.every((record) => record.to === h.room.sessionId), true, '收件人是房间侧身份');
		const state = h.readState(gameId);
		assert.ok(new Map(state.dealt).get(h.room.sessionId), '真人在这一局里有身份牌');
		assert.equal(h.roomMessages.some((message) => String(message.text).includes('你的角色卡')), false, '牌面不能出现在房间里');
	} finally {
		h.dispose();
	}
});

test('v1.11.0：房间里打 /ww-reply ⇒ 命令被吞掉；轮到他时夜序照常推进', async () => {
	const { h, aiNames, humanName } = harness();
	try {
		const { gameId } = await startInRoom(h, aiNames, humanName);
		const beforeState = h.readState(gameId);
		const waiting = beforeState.nightAwaiting;
		assert.ok(waiting, '夜序应停在等待回复的步骤上');
		const humanRole = new Map(beforeState.dealt).get(h.room.sessionId);
		const answer = humanRole === ROLES.TRICKSTER ? '不换' : '2';
		// 注意：有夜间身份 ≠ 现在就轮到他 —— 夜序是「预言家 → 狼 → 怪盗」，他可能还在后面排队。
		const waitingIsHuman = waiting === h.room.sessionId;

		const before = h.roomMessages.length;
		const result = await h.speakAsHuman(`/ww-reply ${answer}`);
		await h.flush();
		assert.equal(result?.consumed, true, '★ 房间里打的 /ww-reply 一律被吞掉（不管轮没轮到他）');
		assert.equal(h.roomMessages.some((message) => String(message.text).startsWith('/ww-')), false, '★ 命令正文不在房间里');
		// ⚠ 别用 includes(answer)：答案是「2」这种短串，房间里的「第2局」「【R1-2】」都会命中它。
		assert.equal(h.roomMessages.some((message) => String(message.text).trim() === answer), false, '答案本身不作为一条房间消息出现');
		// 房间只可能多出庄家自己的公开公告（例如他这一答正好走完夜序 ⇒ 白天开场广播）
		const added = h.roomMessages.slice(before);
		assert.equal(added.every((message) => message.author === DEALER_ID), true, added.map((message) => `${message.author}:${String(message.text).slice(0, 40)}`));

		const receipt = h.readMail(gameId).at(-1);
		assert.equal(receipt.to, h.room.sessionId, '回执进弹窗信箱（只有他能看到）');
		if (waitingIsHuman) {
			assert.notEqual(h.readState(gameId).nightAwaiting, waiting, '轮到他 ⇒ 夜序照常往下走');
		} else {
			assert.equal(h.readState(gameId).nightAwaiting, waiting, '没轮到他 ⇒ 夜序不动');
			assert.match(receipt.text, /当前没有等待你回答的问题/, receipt.text);
		}
	} finally {
		h.dispose();
	}
});

test('v1.11.0：/ww-status、未知命令、/ww-nudge 都能在房间里打', async () => {
	const { h, aiNames, humanName } = harness();
	try {
		const { gameId } = await startInRoom(h, aiNames, humanName);
		const before = h.roomMessages.length;

		const status = await h.speakAsHuman('/ww-status');
		await h.flush();
		assert.equal(status?.consumed, true);
		const statusReceipt = h.readMail(gameId).filter((record) => record.kind === 'command').at(-1);
		assert.match(statusReceipt.text, /第\d+局/, statusReceipt.text);

		const unknown = await h.speakAsHuman('/ww-whatever');
		await h.flush();
		assert.equal(unknown?.consumed, true);
		const unknownReceipt = h.readMail(gameId).at(-1);
		assert.equal(unknownReceipt.kind, 'command-error');
		assert.match(unknownReceipt.text, /没有 \/ww-whatever 这个命令/);
		assert.match(unknownReceipt.text, /ww-start/, '应把可用命令列出来');

		const nudged = await h.speakAsHuman('/ww-nudge');
		await h.flush();
		assert.equal(nudged?.consumed, true);
		assert.equal(h.roomMessages.length, before, '★ 三条命令都没在房间里留下任何东西');
	} finally {
		h.dispose();
	}
});

test('v1.11.0：缺补丁 21（没有 supportsComposerConsume）时**不拦**命令 —— 绝不在没保护的情况下吞消息', async () => {
	const { h, aiNames, humanName, extraSession } = harness({ hasConsume: false });
	try {
		// 弹窗模式被拒绝（见 §11-10b），这里用老玩法开局
		const started = await h.runCommand('ww-start', `${h.room.name} 3 ${aiNames[0]} ${aiNames[1]} *${humanName}=${extraSession}`);
		assert.equal(started.kind, 'success', started.text);
		const before = h.roomMessages.length;
		// 房间里打的命令**不会被拦**（没有 consume 能力，拦了就等于把正文当普通发言发出去）
		const typed = await h.speakAsHuman('/ww-status');
		await h.flush();
		assert.equal(typed?.consumed, undefined, '没有吞掉能力 ⇒ 不返回 consumed');
		// ⚠ 不要数「多了几条」：那条命令落进房间后，若正处在白天还会被既有判定再补一条「无效发言」提示
		// （夜序有没有步骤随种子变）⇒ 计数会漂。断言的是**这条正文确实作为普通发言落了地**。
		assert.equal(
			h.roomMessages.some((message) => message.text === '/ww-status' && message.author === h.room.sessionId),
			true,
			'★ 那条命令作为普通发言落进房间（与旧行为一致 —— 没有假装吞掉）'
		);
	} finally {
		h.dispose();
	}
});

test('v1.11.0：老玩法（绑了会话）不受影响 —— 私密内容照旧投到那个会话', async () => {
	const { h, aiNames, humanName, extraSession } = harness();
	try {
		// 固定种子让他那一席拿到预言家 ⇒ 开局必有一条夜序提问投进他的信箱会话（确定性）
		const started = await h.runCommand('ww-start', `${h.room.name} 3 ${aiNames[0]} ${aiNames[1]} *${humanName}=${extraSession} seed=${SEED_HUMAN_SEER}`);
		assert.equal(started.kind, 'success', started.text);
		const gameId = stateGameIds(h)[0];
		assert.equal(new Map(h.readState(gameId).dealt).get(extraSession), ROLES.SEER, '（前置）真人是预言家');
		assert.ok(h.dmsTo(extraSession).length >= 1, '私密内容照旧走 dsh-bridge 投到他的信箱会话');
		assert.equal(h.dmsTo(h.room.sessionId).length, 0, '不往房间会话投东西');
		assert.deepEqual(mailGameIds(h), [], '老玩法下连弹窗信箱文件都不该产生');
	} finally {
		h.dispose();
	}
});

test('v1.14.0：弹窗提问带按钮选项 —— 预言家（看牌堆 + 逐个其他座位「验」）', async () => {
	const { h, aiNames, humanName } = harness();
	try {
		const { gameId } = await startInRoom(h, aiNames, humanName, SEED_HUMAN_SEER);
		const state = h.readState(gameId);
		assert.equal(new Map(state.dealt).get(h.room.sessionId), ROLES.SEER, '种子保证真人是预言家');
		assert.equal(state.nightAwaiting, h.room.sessionId, '夜序第一步就是预言家（轮到他）');
		const ask = h.readMail(gameId).filter((record) => record.kind === 'dealer').at(-1);
		assert.match(ask.text, /你是预言家/, ask.text);
		assert.deepEqual(ask.options, [
			{ label: '查看未分配的 2 张牌', text: '2' },
			{ label: `验 ${aiNames[0]}`, text: `验 ${aiNames[0]}` },
			{ label: `验 ${aiNames[1]}`, text: `验 ${aiNames[1]}` }
		], '★ 按钮顺序：先看牌堆、再按座位顺序；`text` 就是引擎认识的原话');
		assert.equal(ask.options.some((option) => String(option.label).includes(humanName)), false, '★ 不给自己「验」的按钮（规则卡：验别的一名玩家）');
	} finally {
		h.dispose();
	}
});

test('v1.14.0：弹窗提问带按钮选项 —— 怪盗（不换 + 逐个其他座位「换」）', async () => {
	const { h, aiNames, humanName } = harness();
	try {
		const { gameId } = await startInRoom(h, aiNames, humanName, SEED_HUMAN_TRICKSTER);
		const { card, state } = await advanceToHumanAsk(h, gameId);
		assert.equal(new Map(state.dealt).get(h.room.sessionId), ROLES.TRICKSTER, '种子保证真人是怪盗');
		assert.equal(state.nightAwaiting, h.room.sessionId, '夜序走到怪盗那一步才停下');
		assert.match(card.text, /你是怪盗/, card.text);
		assert.deepEqual(card.options, [
			{ label: '不换', text: '不换' },
			{ label: `换 ${aiNames[0]}`, text: `换 ${aiNames[0]}` },
			{ label: `换 ${aiNames[1]}`, text: `换 ${aiNames[1]}` }
		], '★ 按钮：「不换」在最前，然后是每个其他座位（不能换自己）');
		assert.equal(card.options.some((option) => String(option.label).includes(humanName)), false, '★ 没有换自己的按钮');
	} finally {
		h.dispose();
	}
});

test('v1.14.0：reply 端点 —— 点按钮就能答完夜序（与手打 /ww-reply 同一条入口）', async () => {
	const scenarios = [
		{ role: ROLES.SEER, seed: SEED_HUMAN_SEER },
		{ role: ROLES.TRICKSTER, seed: SEED_HUMAN_TRICKSTER }
	];
	for (const scenario of scenarios) {
		const { h, aiNames, humanName } = harness();
		try {
			const { gameId } = await startInRoom(h, aiNames, humanName, scenario.seed);
			const { card } = await advanceToHumanAsk(h, gameId);
			assert.equal(card.to, h.room.sessionId, '提问卡是发给他的');
			// ★ 点第二个按钮（座位 1）：预言家 ⇒ 「验 甲」，怪盗 ⇒ 「换 甲」
			const option = card.options[1];
			const reply = await h.callMailbox({ gameId, to: card.to, text: option.text }, 'reply');
			await h.flush();
			assert.equal(reply.ok, true, JSON.stringify(reply));
			assert.deepEqual(reply.value, { ok: true, text: '' }, '成功 = 空 text（失败才带原因）');
			assert.notEqual(h.readState(gameId).nightAwaiting, h.room.sessionId, `★ ${scenario.role} 答完后夜序不再停在他身上`);
			const read = h.readAudit(gameId).filter((record) => record.type === 'seer-read').at(-1);
			const swap = h.readAudit(gameId).filter((record) => record.type === 'swap').at(-1);
			if (scenario.role === ROLES.SEER) {
				assert.equal(read.option, 1, '★ 点「验 ×××」走的是选项①（验人），不是看牌堆');
				assert.equal(read.target, aiNames[0], '★ 验的正是按钮上那个座位');
			} else {
				assert.equal(swap.action, 'swap', '★ 点「换 ×××」真的换了卡（不是「不换」那条）');
				assert.equal(swap.target, aiNames[0], '★ 换的正是按钮上那个座位');
			}
			assert.deepEqual(h.dmsTo(h.room.sessionId), [], '★ 点按钮照样不落任何会话（弹窗模式的承诺不变）');
			assert.equal((await runNight(h, gameId)).phase, 'day', '夜序能接着跑完');
		} finally {
			h.dispose();
		}
	}
});

test('v1.14.0：reply 端点的边界 —— 空答案 / 未知局 / 不是席位 / 答非所问', async () => {
	const { h, aiNames, humanName } = harness();
	try {
		const { gameId } = await startInRoom(h, aiNames, humanName, SEED_HUMAN_TRICKSTER);
		const blank = await h.callMailbox({ gameId, to: h.room.sessionId, text: '   ' }, 'reply');
		assert.deepEqual(blank.value, { ok: false, text: '按钮没带答案（reply 需要非空 text）。' }, JSON.stringify(blank));

		const unknownGame = await h.callMailbox({ gameId: '不存在的一局', to: h.room.sessionId, text: '2' }, 'reply');
		assert.equal(unknownGame.value.ok, false);
		assert.match(unknownGame.value.text, /找不到对局/, unknownGame.value.text);

		const unknownSeat = await h.callMailbox({ gameId, to: 'session-不是席位', text: '2' }, 'reply');
		assert.match(unknownSeat.value.text, /没有这个席位/, unknownSeat.value.text);

		// 此刻夜序停在 AI 的预言家那一步（真人是怪盗，还在后面排队）⇒ 答非所问只记账、不改状态
		const before = h.readState(gameId).nightAwaiting;
		const unexpected = await h.callMailbox({ gameId, to: h.room.sessionId, text: '2' }, 'reply');
		await h.flush();
		assert.equal(unexpected.value.ok, false, JSON.stringify(unexpected));
		assert.match(unexpected.value.text, /当前没有等待你回答的问题/, unexpected.value.text);
		assert.equal(h.readState(gameId).nightAwaiting, before, '★ 答非所问不动任何状态');
		assert.equal(h.readAudit(gameId).some((record) => record.type === 'reply-unexpected'), true, '只留一条 reply-unexpected 审计');
	} finally {
		h.dispose();
	}
});

/** 走完 5 轮发言 ⇒ 进入投票阶段（AI 用带前缀的房间消息；v1.21.0 起还要过**确认阶段**）。 */
async function runDayToVote(h, gameId, aiNames) {
	for (let round = 1; round <= 5; round += 1) {
		for (const [index, name] of aiNames.entries()) {
			const player = h.players.find((item) => item.name === name);
			h.say(player.sessionId, `【R${round}-${index + 1} · ${name}】第${round}轮：我怀疑别人。`);
			await h.flush(1);
		}
		await h.speakAsHuman(`第${round}轮我的看法。`);
		await h.flush(1);
	}
	// v1.21.0：5 轮走完进**确认阶段** —— 全员回「是」才开票（真人走同一个入口 reply）。
	// 用状态文件里的席位表来点名（真人席位不在 `h.players` 里）。
	for (const seat of h.readState(gameId).players) {
		const receipt = await h.callTool('wolf_reply', { text: '是' }, seat.sessionId);
		assert.equal(receipt.status, 'accepted', `确认阶段：${seat.name} 回「是」应被收下（${receipt.note}）`);
		await h.flush(1);
	}
	await h.flush();
	return h.readState(gameId);
}

test('v1.15.0：投票卡带按钮（其他座位 + 平安夜），点了就以他的席位身份公开投进房间', async () => {
	const { h, aiNames, humanName } = harness();
	try {
		const { gameId } = await startInRoom(h, aiNames, humanName);
		await runNight(h, gameId); // 夜序跑完 ⇒ 白天
		assert.equal((await runDayToVote(h, gameId, aiNames)).phase, 'vote', '5 轮发言走完 ⇒ 投票阶段');

		const card = h.readMail(gameId).filter((record) => Array.isArray(record.options)).at(-1);
		assert.ok(card, '投票卡应带按钮');
		assert.deepEqual(card.options, [
			{ label: `投 ${aiNames[0]}`, text: `投票：${aiNames[0]}` },
			{ label: `投 ${aiNames[1]}`, text: `投票：${aiNames[1]}` },
			{ label: '投 平安夜', text: '投票：平安夜' }
		], '★ 选项 = 其他每个座位（按座位顺序）+ 平安夜');
		assert.equal(card.options.some((option) => String(option.label).includes(humanName)), false, '★ 不给自己投票的按钮（口径：所有AI玩家+平安夜）');
		assert.equal(card.channel, 'room', '★ 这张卡的回答信道是「公开发进房间」');
		assert.match(card.text, /请投票/, card.text);

		// 点「投 甲」：以他的房间身份往房间发一条公开投票（与手打一字不差）
		const before = h.roomMessages.length;
		const reply = await h.callMailbox({ gameId, to: card.to, text: card.options[0].text, channel: card.channel }, 'reply');
		await h.flush();
		assert.equal(reply.ok, true, JSON.stringify(reply));
		assert.deepEqual(reply.value, { ok: true, text: '' }, '成功 = 空 text');
		const posted = h.roomMessages.slice(before).find((message) => message.author === h.room.sessionId);
		assert.ok(posted, '★ 票以「房间里的他」这个身份落进房间（票是公开的）');
		assert.equal(posted.text, `投票：${aiNames[0]}`, '★ 房间那条与手打一字不差');
		assert.deepEqual(posted.mentions, [], '不替投票算提及（与手打一致）');
		const vote = h.readAudit(gameId).filter((record) => record.type === 'vote' && record.decision === 'accepted').at(-1);
		assert.equal(vote.name, humanName, '★ 票记在他自己的席位名下');
		assert.equal(vote.target, 1, '★ 投的正是按钮上那个座位');
	} finally {
		h.dispose();
	}
});

test('v1.15.1：投票阶段也能用 wolf_speak 投票（兜底「AI 用顺手了搞错命令」）', async () => {
	const { h, aiNames, humanName } = harness();
	try {
		const { gameId } = await startInRoom(h, aiNames, humanName);
		await runNight(h, gameId);
		assert.equal((await runDayToVote(h, gameId, aiNames)).phase, 'vote', '5 轮发言走完 ⇒ 投票阶段');

		const roomBefore = h.roomMessages.length;
		const ai = h.players.find((player) => player.name === aiNames[1]);
		const receipt = await h.callTool('wolf_speak', { text: `投票：${aiNames[0]}` }, ai.sessionId);
		await h.flush();
		assert.equal(receipt.status, 'accepted', receipt.note);
		assert.match(receipt.note, /公开投票/, receipt.note);
		const aiPosted = h.roomMessages.slice(roomBefore).find((message) => message.author === ai.sessionId);
		assert.ok(aiPosted, '★ AI 的票是一条公开房间消息（与 chat_send 那条路等价）');
		assert.equal(aiPosted.text, `投票：${aiNames[0]}`, '★ 正文原样，不加 `【R…】` 发言前缀');
		assert.deepEqual(aiPosted.mentions, ['all'], '投票不唤醒谁');
		const aiVote = h.readAudit(gameId).filter((record) => record.type === 'vote' && record.name === aiNames[1]).at(-1);
		assert.equal(aiVote.target, 1, '★ 票被正常收下');
		assert.equal(aiVote.raw, `投票：${aiNames[0]}`, '票原文与提交的一致');

		// v1.18.0（用户 2026-10-06 裁定）：**首投落定** —— 改票被拒、房间不留第二只气泡、票不变。
		const roomBeforeChange = h.roomMessages.length;
		const change = await h.callTool('wolf_speak', { text: '投票：平安夜' }, ai.sessionId);
		await h.flush();
		assert.equal(change.status, 'rejected', change.note);
		assert.match(change.note, /本票已落定，不可撤改/);
		assert.equal(h.roomMessages.length, roomBeforeChange, '★ 被拒的票不进房间（房间不留第二只气泡）');
		const kept = h.readAudit(gameId).filter((record) => record.type === 'vote' && record.name === aiNames[1]).at(-1);
		assert.equal(kept.target, 1, '★ 首投不变（不再覆盖）');

		// 同内容重发 ⇒ 幂等回执（`accepted`，但同样不投递、不重复计票）
		const roomBeforeSame = h.roomMessages.length;
		const same = await h.callTool('wolf_speak', { text: `投票：${aiNames[0]}` }, ai.sessionId);
		await h.flush();
		assert.equal(same.status, 'accepted', same.note);
		assert.match(same.note, /本票已落定，重发不覆盖/);
		assert.equal(h.roomMessages.length, roomBeforeSame, '★ 幂等重发不投递');
		const acceptedCount = h.readAudit(gameId)
			.filter((record) => record.type === 'vote' && record.name === aiNames[1] && record.decision === 'accepted').length;
		assert.equal(acceptedCount, 1, '★ 只有一条 accepted（没有重复计票）');

		// v1.20.0（用户 2026-10-06 定）：**禁止自投** —— 工具层预检就挡下（房间不留气泡、不落票），且**不落定**
		const other = h.players.find((player) => player.sessionId !== ai.sessionId && player.human !== true);
		const roomBeforeSelf = h.roomMessages.length;
		const selfTry = await h.callTool('wolf_speak', { text: `投票：${other.name}` }, other.sessionId);
		await h.flush();
		assert.equal(selfTry.status, 'rejected', selfTry.note);
		assert.match(selfTry.note, /不能投给自己/u);
		assert.equal(h.roomMessages.length, roomBeforeSelf, '★ 自投不进房间');
		assert.equal(h.readAudit(gameId).filter((record) => record.type === 'vote' && record.name === other.name).length, 0, '★ 自投不落票（预检阶段就返回，连审计都没有）');

		// 自投不落定 ⇒ 他随后正常投一票仍被收下
		const targetName = aiNames.find((name) => name !== other.name);
		const redo = await h.callTool('wolf_speak', { text: `投票：${targetName}` }, other.sessionId);
		await h.flush();
		assert.equal(redo.status, 'accepted', redo.note);
		const otherVote = h.readAudit(gameId).filter((record) => record.type === 'vote' && record.name === other.name).at(-1);
		assert.equal(otherVote.decision, 'accepted', '★ 重投被正常收下');

		// 空白正文在工具层就被挡下（扔错、不投递）
		await assert.rejects(() => h.callTool('wolf_speak', { text: '   ' }, ai.sessionId), /需要非空的 text/);
	} finally {
		h.dispose();
	}
});

test('v1.16.2：真人的第一条赛后发言自动 AT 全员（不再有邀请），AI 顺着回话/说感想', async () => {
	const { h, aiNames, humanName } = harness();
	try {
		const { gameId } = await startInRoom(h, aiNames, humanName);
		await runNight(h, gameId);
		await runDayToVote(h, gameId, aiNames);
		// 全员投票 ⇒ 结算（这里用房间消息这条既有路，不牵扯按钮）
		h.say(h.room.sessionId, `投票：${aiNames[0]}`);
		await h.flush(1);
		for (const player of h.players) {
			// v1.20.0：禁止自投 —— 被票的那位改投平安夜
			h.say(player.sessionId, player.name === aiNames[0] ? '投票：平安夜' : `投票：${aiNames[0]}`);
			await h.flush(1);
		}
		assert.equal(h.readState(gameId).phase, 'settled', '三票齐 ⇒ 结算');
		assert.equal(String(h.roomMessages.at(-1).text).includes('最终投票结果'), true, '★ 结算公告之后不再有邀请（庄家不发这一条了）');

		// ★ 真人的第一条赛后发言：正文一个字不改，提及自动补成「@all + 全部 AI」
		const sent = await h.speakAsHuman('这局我藏得还行，各位辛苦了。');
		await h.flush();
		assert.equal(sent.text, '这局我藏得还行，各位辛苦了。', '★ 只接管提及，正文原样');
		assert.deepEqual(sent.mentions, ['all', ...aiNames], '★ 真人赛后第一条自动 AT 全员（一句话把 AI 都唤醒）');
		assert.deepEqual(h.readState(gameId).closing.map((entry) => [entry.human === true, entry.text]), [[true, '这局我藏得还行，各位辛苦了。']]);

		// 被唤醒的 AI 顺着回话（= 它的完赛感想），只 @all：不叫醒其他 AI
		const ai = h.players[0];
		const receipt = await h.callTool('wolf_speak', { text: `${humanName}，我认了，这局是我藏得不够好。` }, ai.sessionId);
		await h.flush();
		assert.equal(receipt.status, 'accepted', receipt.note);
		assert.match(receipt.note, /完赛感想/, receipt.note);
		const aiPosted = h.roomMessages.at(-1);
		assert.equal(aiPosted.author, ai.sessionId, 'AI 的感想以它的席位身份落房间');
		assert.deepEqual(aiPosted.mentions, ['all'], '★ AI 的感想不唤醒谁（否则会互相叫醒、回声风暴）');
		assert.deepEqual(h.readState(gameId).closing.map((entry) => entry.name), [humanName, aiNames[0]]);

		// 只有**第一条**会 AT 全员：第二条恢复原样（而且不进复盘）
		const second = await h.speakAsHuman('再补一句。');
		await h.flush();
		assert.deepEqual(second.mentions, [], '★ 第二条不再 AT 全员');
		assert.equal(h.readState(gameId).closing.length, 2, '每人只收第一条');
	} finally {
		h.dispose();
	}
});

test('v1.15.0：投票卡的边界 —— 非投票阶段点投票按钮被拒；夜间卡带 room 信道也被拒', async () => {
	const { h, aiNames, humanName } = harness();
	try {
		const { gameId } = await startInRoom(h, aiNames, humanName);
		// 夜序还在跑 ⇒ 投票卡不存在，硬点也要被拒（陈旧卡片绝不能变成一条公开消息）
		const early = await h.callMailbox({ gameId, to: h.room.sessionId, text: '投票：平安夜', channel: 'room' }, 'reply');
		assert.equal(early.value.ok, false, JSON.stringify(early));
		assert.match(early.value.text, /不在投票阶段/, early.value.text);
		const roomBefore = h.roomMessages.length;
		assert.equal(h.roomMessages.length, roomBefore, '被拒时不往房间发任何东西');

		// 夜间提问卡（没有 channel）+ 手打的投票文本 ⇒ 仍走夜间入口，答非所问只记账
		const typed = await h.callMailbox({ gameId, to: h.room.sessionId, text: '投票：平安夜' }, 'reply');
		await h.flush();
		assert.equal(typed.value.ok, false, JSON.stringify(typed));
		assert.match(typed.value.text, /当前没有等待你回答的问题/, typed.value.text);
	} finally {
		h.dispose();
	}
});

test('v1.11.0：弹窗信箱端点 —— 增量游标、未知端点、坏 body、局结束后不再吐', async () => {
	const { h, aiNames, humanName } = harness();
	try {
		const { gameId } = await startInRoom(h, aiNames, humanName);

		const all = await h.callMailbox({ since: 0 });
		assert.equal(all.ok, true, JSON.stringify(all));
		assert.ok(all.value.records.length >= 1, '应有记录');
		const seqs = all.value.records.map((record) => record.seq);
		assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), '按 seq 升序');
		assert.equal(all.value.seq >= seqs.at(-1), true, '返回的 seq 是当前水位');

		const after = await h.callMailbox({ since: seqs.at(-1) });
		assert.deepEqual(after.value.records, [], '★ 客户端确认过的序号不会被再发一次（增量语义）');

		const paged = await h.callMailbox({ since: 0, limit: 1 });
		assert.equal(paged.value.records.length, 1, 'limit 生效');
		assert.equal(paged.value.more, all.value.records.length > 1, 'more 提示还有没拉完的');

		const unknownEndpoint = await h.callMailbox({}, 'nope');
		assert.equal(unknownEndpoint.ok, false);
		assert.match(unknownEndpoint.error.message, /unknown dsh-werewolf endpoint/);

		const badBody = await h.mailboxRoute.fetch({ json: async () => { throw new Error('不是 JSON'); } });
		const badEnvelope = await badBody.json();
		assert.equal(badBody.status, 200, '坏 body 也只回 200 的 RpcResult（与 dsh-chat 同口径）');
		assert.equal(badEnvelope.ok, false);
		assert.match(badEnvelope.error.message, /not JSON/);

		// 局结束后不再吐（弹窗只服务进行中的对局），但历史记录仍在盘上
		await h.runCommand('ww-end', '');
		await h.flush();
		const settled = await h.callMailbox({ since: 0 });
		assert.deepEqual(settled.value.records, [], '已结束的对局不再出现在弹窗队列里');
		assert.ok(h.readMail(gameId).length >= 1, '但记录仍在磁盘上（不删历史）');
	} finally {
		h.dispose();
	}
});
