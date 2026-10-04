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
import { Game, ROLES } from '../lib/engine.js';
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
		assert.equal(h.roomMessages.length, before + 1, '那条命令会作为普通发言落进房间（与旧行为一致）');
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
