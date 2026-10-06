/**
 * 引擎单元测试：牌堆算术、夜序、发言链状态机、票型解析、结算决策树全分支。
 *
 * 运行：`node --test test/`
 *
 * @module dsh-werewolf-dealer/test/engine.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Game, PHASE, PEACE, ABSTAIN, ROLES, campOf, compositionText, dealCounts, deckFor, formatSpan, mulberry32, parseSpeechPrefix } from '../lib/engine.js';
import { T } from '../lib/templates.js';

const NAMES = ['甲', '乙', '丙', '丁', '戊', '己'];

/**
 * 建一局并**覆盖**牌面（绕过洗牌，用于定点验证规则算术）。
 * 人数取 `players` / `roles` 的长度；都不给时**默认 4 人**（老用例的口径）。
 * @param options - `{ roles, mode, players }`。
 */
function makeGame(options = {}) {
	const count = options.players?.length ?? options.roles?.length ?? 4;
	const players = (options.players ?? NAMES.slice(0, count)).map((name, index) => ({ name, sessionId: `s${index}` }));
	const mode = options.mode ?? players.length;
	const game = new Game({ roomId: 'room-test', roomName: '测试房', mode, players, seed: 12345, gameId: 'g-test', no: 1, now: () => 1_000 });
	if (options.roles !== undefined) {
		game.dealt = new Map(game.players.map((player, index) => [player.sessionId, options.roles[index]]));
		game.hand = new Map(game.dealt);
		game.pile = options.pile ?? [ROLES.VILLAGER, ROLES.VILLAGER];
	}
	return game;
}

/** 设置票型：每个座位投给 `1`(座位号) / `'平安夜'` / `'弃票'` / `null`(未投)。 */
function setVotes(game, targets) {
	game.phase = PHASE.VOTE;
	game.votes = new Map();
	targets.forEach((target, index) => {
		if (target === null || target === undefined) return;
		game.votes.set(game.players[index].sessionId, { target, raw: String(target), at: 0, seq: index + 1 });
	});
}

// ---------------------------------------------------------------- 牌堆算术（§11-1）

test('牌堆算术：四档人数都满足「总卡数 = 人数 + 2、狼2、预言家1、怪盗1、其余村民」', () => {
	const cases = [
		{ mode: 3, total: 5, text: '狼×2、村民×1、预言家×1、怪盗×1' },
		{ mode: 4, total: 6, text: '狼×2、村民×2、预言家×1、怪盗×1' },
		{ mode: 5, total: 7, text: '狼×2、村民×3、预言家×1、怪盗×1' },
		{ mode: 6, total: 8, text: '狼×2、村民×4、预言家×1、怪盗×1' }
	];
	for (const item of cases) {
		const deck = deckFor(item.mode);
		assert.equal(deck.length, item.total, `${item.mode} 人局总卡数`);
		assert.equal(compositionText(deck), item.text, `${item.mode} 人局构成`);
		// 结构断言（不只看总数）：狼恒 2、预言家/怪盗各 1、村民 = 人数 − 2
		assert.equal(deck.filter((role) => role === ROLES.WOLF).length, 2);
		assert.equal(deck.filter((role) => role === ROLES.SEER).length, 1);
		assert.equal(deck.filter((role) => role === ROLES.TRICKSTER).length, 1);
		assert.equal(deck.filter((role) => role === ROLES.VILLAGER).length, item.mode - 2);
		assert.deepEqual(dealCounts(item.mode), { total: item.total, dealt: item.mode, pile: 2 }, `${item.mode} 人局发/留牌`);
	}
});

test('非法局型抛错（2 人及以下、7 人及以上都没有规则）', () => {
	for (const mode of [2, 1, 0, 7, 8, 3.5, undefined, 'x']) {
		assert.throws(() => deckFor(mode), /mode must be 3\.\.6/u, String(mode));
		assert.throws(() => dealCounts(mode), /mode must be 3\.\.6/u, String(mode));
	}
});

test('发牌数、留牌数与构成公告一致（四档局型各跑 200 个种子）', () => {
	for (const mode of [3, 4, 5, 6]) {
		for (let seed = 0; seed < 200; seed += 1) {
			const game = new Game({ roomId: 'r', roomName: '房', mode, players: NAMES.slice(0, mode).map((name, index) => ({ name, sessionId: `s${index}` })), seed, gameId: `g-${seed}`, now: () => 0 });
			assert.equal(game.hand.size, mode);
			assert.equal(game.pile.length, 2);
			assert.equal(compositionText([...game.hand.values(), ...game.pile]), compositionText(deckFor(mode)));
		}
	}
});

test('同一种子得到同一牌序（可复现）', () => {
	const build = () => new Game({ roomId: 'r', roomName: '房', mode: 4, players: NAMES.slice(0, 4).map((name, index) => ({ name, sessionId: `s${index}` })), seed: 777, gameId: 'g', now: () => 0 });
	assert.deepEqual([...build().hand.values()], [...build().hand.values()]);
	assert.deepEqual([...build().pile], [...build().pile]);
});

test('mulberry32 是确定性序列', () => {
	const a = mulberry32(42);
	const b = mulberry32(42);
	assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

// ---------------------------------------------------------------- v1.16.8：开局承诺 / 结算对账

test('v1.16.9：开局承诺必须**加盐** —— 无盐能被穷举反推（实测 21 次即破），带盐后算不出来', () => {
	const game = makeGame({ roles: [ROLES.SEER, ROLES.WOLF, ROLES.TRICKSTER, ROLES.VILLAGER] });
	const effects = game.start();
	const open = effects.find((effect) => effect.type === 'room');
	const shown = /哈希：`([0-9a-f]{16})`/u.exec(open.text)?.[1];
	assert.ok(shown, '开局广播必须带全量状态（发到的牌 + 牌堆）的哈希承诺');
	const salt = game.commitmentSalt;
	assert.match(salt, /^[0-9a-f]{32}$/u, '承诺必须用 16 字节随机盐');
	// ★ 开局广播**绝不能**带盐：带盐就等于公开牌面（牌面空间只有 60~840 种，穷举秒破）。
	assert.equal(open.text.includes(salt), false, '★ 开局广播不得泄露盐');
	assert.equal(open.text.includes('盐：`'), false, '★ 开局也不该公布盐（结算才公布）');
	// 独立重算（不碰引擎私有方法）：sha256(盐 + 换行 + "seats[座位升序=牌]pile[牌堆]") 前 16 位。
	const payloadOf = (g) => `seats[${[...g.players]
		.sort((a, b) => a.seat - b.seat)
		.map((p) => `${p.seat}.${p.name}=${g.dealt.get(p.sessionId)}`)
		.join(';')}]pile[${g.pile.join(',')}]`;
	const hashOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
	assert.equal(shown, hashOf(`${salt}\n${payloadOf(game)}`), '★ 承诺值 = sha256(盐 + 换行 + 规范串) 前 16 位');
	// ★ 判别力①：**不加盐**重算必须对不上 —— 那正是会被穷举反推的旧实现（本机实测 4 人局 21 次破）。
	assert.notEqual(shown, hashOf(payloadOf(game)), '★ 无盐重算必须对不上（否则牌面可被反推）');
	// ★ 判别力②：换掉一张「发到的牌」（现值 hand 不动）⇒ 带盐重算也必须变。
	const first = game.players[0];
	const before = game.dealt.get(first.sessionId);
	game.dealt.set(first.sessionId, before === ROLES.WOLF ? ROLES.VILLAGER : ROLES.WOLF);
	assert.notEqual(hashOf(`${salt}\n${payloadOf(game)}`), shown, '★ 改了发到的牌就必须对不上');
	game.dealt.set(first.sessionId, before);
	// 承诺只算一次并落进 state：结算公布的就是开局广播出去的那个值。
	assert.equal(game.commitmentHash, shown, 'state 里记的承诺必须与广播出去的同值');
	// ★ v1.16.10 回归（第 9 局实测数据）：**同一副牌、两种牌堆顺序 ⇒ 哈希不同**。
	// 这正是"结算必须把承诺原串原样输出"的理由 —— 复算者不能靠猜顺序（否则会误判成"牌被改过"）。
	const ninthSalt = 'b034fda82b0546f9a95212314b695a34';
	const ninthSeats = '1.大D=村民;2.小米=狼;3.大G=预言家;4.千野=狼';
	assert.equal(hashOf(`${ninthSalt}\nseats[${ninthSeats}]pile[怪盗,村民]`), '89ee00e24c2199b2', '第 9 局实测值（原序）');
	assert.notEqual(hashOf(`${ninthSalt}\nseats[${ninthSeats}]pile[村民,怪盗]`), '89ee00e24c2199b2', '换个顺序就对不上');
});

// ---------------------------------------------------------------- 夜序（§11-2）

test('夜序严格 预言家→狼→怪盗，①读数取换卡前状态', () => {
	const game = makeGame({ roles: [ROLES.SEER, ROLES.WOLF, ROLES.TRICKSTER, ROLES.VILLAGER] });
	const effects = game.start();
	const dms = effects.filter((effect) => effect.type === 'dm');
	// v1.7.4：发牌只发给**狼与村民**（2 条），怪盗/预言家的身份由夜序提问承载 ⇒ 开局共 3 条
	assert.equal(dms.length, 3);
	assert.equal(dms[0].sessionId, 's1');
	// v1.16.5：发牌必须写清"被唤醒就是轮到你"（v1.20.1 起不再说"被 @"）。结构断言之外再用**字面量**校验关键口径，
	// 并负向断言旧措辞已消失（「请等待我的AT再发言」会让 AI 去等一条庄家永远不会发的 AT）。
	assert.equal(dms[0].text, `你的角色卡是狼。这局你没有同伴。本条无需回复。\n${T.wakeRule()}\n${T.aiChannelHint()}`);
	assert.equal(dms[0].text.includes('【怎么知道轮到你】**被唤醒就是轮到你**'), true, '发牌必须带唤醒口径');
	assert.equal(dms[0].text.includes('请等待我的AT再发言'), false, '旧措辞必须消失');
	assert.equal(dms[1].sessionId, 's3');
	assert.equal(dms[1].text, `你的角色卡是村民。本条无需回复。\n${T.wakeRule()}\n${T.aiChannelHint()}`);
	assert.equal(dms[2].sessionId, 's0');
	assert.equal(dms[2].text, `你是预言家。请选择：① 验一名玩家（回复座位名）② 查看未分配的2张牌（回复"2"）。\n${T.aiChannelHint()}`);

	// 审计仍**每人一条 deal 记录**（复盘与 §11-8 依赖它），但没投递的那两个不带正文
	const dealRecords = effects.filter((effect) => effect.type === 'audit' && effect.record.type === 'deal').map((effect) => effect.record);
	assert.deepEqual(dealRecords.map((record) => record.role), [ROLES.SEER, ROLES.WOLF, ROLES.TRICKSTER, ROLES.VILLAGER]);
	assert.equal(dealRecords[0].delivered, false);
	assert.equal('text' in dealRecords[0], false, '未投递的发牌不写正文，否则 /ww-inbox 会显示它从没收到的原文');
	assert.equal(dealRecords[1].delivered, undefined);
	assert.equal(typeof dealRecords[1].text, 'string');

	// 预言家验人：读到的是**被发到的**牌
	const afterSeer = game.onPrivateReply({ sessionId: 's0', text: '验 乙' });
	const afterSeerDms = afterSeer.filter((effect) => effect.type === 'dm');
	assert.equal(afterSeerDms.length, 2, '预言家读数 + 怪盗提问（v1.7.2 起狼步不再单独投递）');
	assert.equal(afterSeerDms[0].text, '乙 的角色卡为 狼。（读数描述换卡前状态）');
	// v1.7.6：读数**要唤醒**（用户要求：AI 需要单独一轮把读数想清楚；否则它会等到白天发言那一轮，
	// 在满屏房间发言里才看到读数，容易错过）
	assert.equal(afterSeerDms[0].wake, true, '读数要唤醒 AI 席位');
	// 需要行动的那条（怪盗提问）照旧唤醒
	assert.equal(afterSeerDms[1].wake, true, '提问必须唤醒');

	// v1.7.2：同伴信息并入**发牌那一条** ⇒ 狼步不再给狼发消息、这局狼只收一条。
	// 本局第二张狼在牌堆，故发牌里直接写"这局你没有同伴"。
	assert.equal(afterSeerDms.some((effect) => effect.sessionId === 's1'), false, '狼步不该再给狼发消息');
	assert.equal(dms[0].sessionId, 's1');

	// 最后是怪盗提问（AI 席位的信道提示挂在"需要行动的那一条"上）
	assert.equal(afterSeerDms[1].sessionId, 's2');
	// 提问里必须带**真实可选座位名**（v1.7.3 修掉死占位符 `{座位}`）：本局怪盗是丙，可选甲乙丁
	assert.equal(afterSeerDms[1].text, `${'你是怪盗。要换卡吗？不换回复"不换"；换的话回复"换 <座位名>"，可选：甲、乙、丁（不能换自己）。'}\n${T.aiChannelHint()}`);
});

test('怪盗换卡：双方现值互换；结果只私发怪盗，被换者零通知', () => {
	const game = makeGame({ roles: [ROLES.SEER, ROLES.WOLF, ROLES.TRICKSTER, ROLES.VILLAGER] });
	game.start();
	game.onPrivateReply({ sessionId: 's0', text: '2' });
	const effects = game.onPrivateReply({ sessionId: 's2', text: '换 乙' });
	// 规则卡「怪盗清楚知道自己和被换卡后的玩家的角色卡」⇒ 必须给怪盗一条结果私聊；
	// 被换者一律不自知 ⇒ 一条都不许给他。
	const dms = effects.filter((effect) => effect.type === 'dm');
	assert.equal(dms.length, 1);
	assert.equal(dms[0].sessionId, 's2', '只发给怪盗本人');
	// 措辞按用户 2026-10-04 手发版本：两行，自己那行带能力/阵营说明，被换者那行说明它不自知。
	// 断言用**字面量**而不是 `T.swapResult(...)`：模板正文写错时自引用断言抓不到（`{座位}` 那个坑就是这么漏的）。
	assert.equal(dms[0].text, [
		'你的角色卡被换成了狼，你已经加入狼阵营，但你无法得知场上是否有你的同伴',
		'乙的角色卡被换成了怪盗，它已经自动变成人类阵营，但它自己不知道'
	].join('\n'));
	assert.equal(effects.filter((effect) => effect.type === 'room').length, 1); // [白天] 开场广播
	assert.equal(effects.some((effect) => effect.type === 'audit' && effect.record.type === 'swap-result'), true);
	assert.equal(game.currentRole('s2'), ROLES.WOLF);
	assert.equal(game.currentRole('s1'), ROLES.TRICKSTER);
	assert.equal(game.dealt.get('s2'), ROLES.TRICKSTER); // 发到的牌不变
	assert.equal(campOf(game.currentRole('s2')), 'wolf');
	assert.equal(campOf(game.currentRole('s1')), 'human');
});

test('怪盗不换：状态不动，进入白天，且收到"保留怪盗/人类阵营"的确认', () => {
	const game = makeGame({ roles: [ROLES.SEER, ROLES.WOLF, ROLES.TRICKSTER, ROLES.VILLAGER] });
	game.start();
	game.onPrivateReply({ sessionId: 's0', text: '2' });
	const effects = game.onPrivateReply({ sessionId: 's2', text: '不换' });
	assert.equal(game.currentRole('s1'), ROLES.WOLF);
	assert.equal(game.phase, PHASE.DAY);
	// v1.7.3：不换不再静默 —— 给怪盗一条确认（措辞按用户手发版本），且**不给别人**发
	const dms = effects.filter((effect) => effect.type === 'dm');
	assert.equal(dms.length, 1);
	assert.equal(dms[0].sessionId, 's2');
	assert.equal(dms[0].text, '行，你保留怪盗身份，依然是人类阵营');
	assert.equal(effects.some((effect) => effect.type === 'audit' && effect.record.type === 'swap-result' && effect.record.action === 'none'), true);
	const dayOpen = effects.find((effect) => effect.type === 'room');
	// v1.16.5：开场广播也要讲清唤醒口径（第 2 轮起庄家不再自己点名，唤醒靠上一位发言的提及）
	assert.equal(dayOpen.text, [
		'每轮按顺序每人 1 次发言，共 5 轮。AI 席位请用 wolf_speak 工具交正文（**只给正文**：前缀【RN-K · 别名】与"唤醒下一位"的提及都由庄家按顺序补，不要自己写前缀、不要自己填 mentions）。',
		T.wakeRule(),
		'顺序为 1.甲 → 2.乙 → 3.丙 → 4.丁。请开始你们的发言！'
	].join(''));
	assert.equal(dayOpen.text.includes('**被唤醒就是轮到你**'), true, '开场广播必须带唤醒口径');
	assert.equal(dayOpen.text.includes('wolf_speak'), true, '开场广播必须告诉 AI 用 wolf_speak');
	assert.equal(/mentions = /.test(dayOpen.text), false, '开场广播不再教模型自己填 mentions（v1.9.0 由庄家算）');
	assert.deepEqual(dayOpen.mentions, ['all', '甲']);
});

test('预言家看牌堆：读数与牌堆构成一致', () => {
	const game = makeGame({ roles: [ROLES.SEER, ROLES.WOLF, ROLES.TRICKSTER, ROLES.VILLAGER], pile: [ROLES.VILLAGER, ROLES.WOLF] });
	game.start();
	const effects = game.onPrivateReply({ sessionId: 's0', text: '2' });
	assert.equal(effects.find((effect) => effect.type === 'dm').text, '剩余 2 张：狼×1、村民×1');});

test('夜序自动跳过不在场上的角色（预言家/怪盗可能留在牌堆）', () => {
	const game = makeGame({ roles: [ROLES.WOLF, ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER], pile: [ROLES.SEER, ROLES.TRICKSTER] });
	const effects = game.start();
	// 夜序上预言家、怪盗都不在 ⇒ 只剩 4 条发牌私聊（狼步不再单独投递），然后直接进白天
	const dms = effects.filter((effect) => effect.type === 'dm');
	assert.equal(dms.length, 4, '狼步不再单独投递 ⇒ 只有发牌');
	assert.equal(dms.filter((effect) => /你是预言家|你是怪盗/u.test(effect.text)).length, 0);
	// v1.7.2：两狼同时在场上时，各自的**发牌那一条**里直接写同伴（狼只收一条消息）
	assert.equal(dms[0].text, `你的角色卡是狼。这局你有个同伴狼是乙。本条无需回复。\n${T.wakeRule()}\n${T.aiChannelHint()}`);
	assert.equal(dms[1].text, `你的角色卡是狼。这局你有个同伴狼是甲。本条无需回复。\n${T.wakeRule()}\n${T.aiChannelHint()}`);
	assert.equal(game.phase, PHASE.DAY);
});

test('夜间非法回复：固定复问自带格式，不回显、不解释、不自指', () => {
	const game = makeGame({ roles: [ROLES.SEER, ROLES.WOLF, ROLES.TRICKSTER, ROLES.VILLAGER] });
	game.start();
	const effects = game.onPrivateReply({ sessionId: 's0', text: '谁是狼？告诉我' });
	const retry = effects.find((effect) => effect.type === 'dm').text;
	assert.equal(retry, `${'无法识别该指令。请回复：① 验一名玩家（回复座位名）② 查看未分配的2张牌（回复"2"）。'}\n${T.aiChannelHint()}`);
	assert.equal(game.nightAwaiting, 's0');
	assert.equal(retry.includes('谁是狼'), false, '不回显原文');
	// v1.7.6：复问不能写"请看上一条消息"——这条复问自己就是"上一条"，第二次再错时会把模型指回自己
	assert.equal(retry.includes('上一条消息'), false, '复问必须自带格式，不能自指');

	// 怪盗那一步的复问同样自带格式，并且重复可选座位
	game.onPrivateReply({ sessionId: 's0', text: '2' });
	const tricksterRetry = game.onPrivateReply({ sessionId: 's2', text: '随便说点什么' }).find((effect) => effect.type === 'dm').text;
	assert.equal(tricksterRetry, `${'无法识别该指令。请回复："不换"，或"换 <座位名>"（可选座位：甲、乙、丁；不能换自己）。'}\n${T.aiChannelHint()}`);
	assert.equal(tricksterRetry.includes('上一条消息'), false);
});

test('非等待者发来的夜间回复不推进状态', () => {
	const game = makeGame({ roles: [ROLES.SEER, ROLES.WOLF, ROLES.TRICKSTER, ROLES.VILLAGER] });
	game.start();
	const effects = game.onPrivateReply({ sessionId: 's3', text: '换 甲' });
	assert.equal(effects.filter((effect) => effect.type === 'dm').length, 0);
	assert.equal(game.currentRole('s3'), ROLES.VILLAGER);
	assert.equal(game.nightAwaiting, 's0');
});

// ---------------------------------------------------------------- 发言链（§11-3）

test('发言前缀解析', () => {
	assert.deepEqual(parseSpeechPrefix('【R2-2 · 大D】我觉得甲有问题'), { round: 2, index: 2, alias: '大D', body: '我觉得甲有问题' });
	assert.deepEqual(parseSpeechPrefix('【R1-1 · 甲】'), { round: 1, index: 1, alias: '甲', body: '' });
	assert.equal(parseSpeechPrefix('大家好'), undefined);
	assert.equal(parseSpeechPrefix('【R1-1】缺别名'), undefined);
});

/** 走完开局进白天。 */
function toDay(roles) {
	const game = makeGame({ roles: roles ?? [ROLES.SEER, ROLES.WOLF, ROLES.TRICKSTER, ROLES.VILLAGER] });
	game.start();
	game.onPrivateReply({ sessionId: 's0', text: '2' });
	game.onPrivateReply({ sessionId: 's2', text: '不换' });
	assert.equal(game.phase, PHASE.DAY);
	return game;
}

test('白天：缺前缀 / 顺序错 / 抢发 / 重复 / 只有定向 —— 一律不计入且链不动', () => {
	const game = toDay();

	// 缺前缀
	let effects = game.onRoomMessage({ authorSessionId: 's0', text: '我先说两句' });
	assert.match(effects[0].text, /该条不计入本轮（缺少【R1-\{序号\} · \{别名\}】前缀）。当前应由 甲 发言。/);
	assert.equal(game.position, 0);

	// 顺序错：乙抢在甲之前（声明第 1 位）
	effects = game.onRoomMessage({ authorSessionId: 's1', text: '【R1-1 · 乙】我先来' });
	assert.match(effects[0].text, /该条不计入本轮（顺序错（当前应由 甲 发言））/);
	assert.equal(game.position, 0);

	// 跳号抢发：乙声明第 3 位
	effects = game.onRoomMessage({ authorSessionId: 's1', text: '【R1-3 · 乙】我第三' });
	assert.match(effects[0].text, /该条不计入本轮（抢发（跳号：声明第 3 位））/);
	assert.equal(game.position, 0);

	// 只有定向、没有正文
	effects = game.onRoomMessage({ authorSessionId: 's0', text: '【R1-1 · 甲】' });
	assert.match(effects[0].text, /该条不计入本轮（只有定向、没有正文）/);
	assert.equal(game.position, 0);

	// 有效发言
	effects = game.onRoomMessage({ authorSessionId: 's0', text: '【R1-1 · 甲】我认为丙可疑' });
	assert.equal(game.position, 1);
	assert.equal(effects.filter((effect) => effect.type === 'room').length, 0);

	// 重复：同一轮再发一条（本轮已发言 ⇒ 不计入，不触发作废）
	effects = game.onRoomMessage({ authorSessionId: 's0', text: '【R1-2 · 甲】我再补一句' });
	assert.equal(effects[0].text, '该条不计入本轮（重复发言）。当前应由 乙 发言。');
	assert.equal(game.position, 1);

	// 轮次不符
	effects = game.onRoomMessage({ authorSessionId: 's1', text: '【R3-2 · 乙】跨轮' });
	assert.match(effects[0].text, /该条不计入本轮（轮次不符（本条声明 R3，当前 R1））/);
	assert.equal(game.position, 1);
});

test('白天：序号回退 ⇒ 该轮作废重来', () => {
	const game = toDay();
	game.onRoomMessage({ authorSessionId: 's0', text: '【R1-1 · 甲】开口' });
	game.onRoomMessage({ authorSessionId: 's1', text: '【R1-2 · 乙】接上' });
	assert.equal(game.position, 2);
	const effects = game.onRoomMessage({ authorSessionId: 's2', text: '【R1-1 · 丙】我要重来' });
	assert.equal(effects[0].text, '第1轮作废，重来。');
	assert.equal(game.position, 0);
	assert.equal(game.round, 1);
});

test('白天：连续三次作废后自动暂停（防死循环）', () => {
	const game = toDay();
	for (let i = 0; i < 3; i += 1) {
		const effects = game.onRoomMessage({ authorSessionId: 's0', text: '【R1-0 · 甲】回退' });
		if (i < 2) assert.equal(game.paused, false, `第 ${i + 1} 次作废不应暂停`);
		else {
			assert.equal(game.paused, true);
			assert.equal(effects.filter((effect) => effect.type === 'room').map((effect) => effect.text).at(-1), '第1轮作废已达上限（3 次），游戏暂停，等待观察员 /ww-resume。');
		}
	}
});

test('白天：5 轮走满进入**确认阶段**（v1.21.0；全员回「是」才开票）', () => {
	const game = toDay();
	for (let round = 1; round <= 5; round += 1) {
		for (let seat = 0; seat < 4; seat += 1) {
			const effects = game.onRoomMessage({ authorSessionId: `s${seat}`, text: `【R${round}-${seat + 1} · ${NAMES[seat]}】第${round}轮第${seat + 1}位发言内容` });
			assert.equal(effects.filter((effect) => effect.type === 'room' && /不计入/u.test(effect.text)).length, 0, `R${round} 第${seat + 1}位应被接受`);
		}
	}
	assert.equal(game.phase, PHASE.READY, '★ 5 轮走完 → 确认阶段（庄家问「是否进入投票阶段？」）');
});

test('v1.19.0：时长文案按半分钟渲染（2 分 30 秒，不是四舍五入的"3 分钟"）', () => {
	assert.equal(formatSpan(150_000), '2 分 30 秒');
	assert.equal(formatSpan(300_000), '5 分钟');
	assert.equal(formatSpan(90_000), '1 分 30 秒');
	assert.equal(formatSpan(45_000), '45 秒');
});

/** v1.21.0：走完 5 轮后逐个确认（回「是」），返回**最后一次**确认的 effects（其中含开票公告）。 */
function confirmAll(game) {
	let effects = [];
	for (const player of game.players) effects = game.onPrivateReply({ sessionId: player.sessionId, text: '是' });
	return effects;
}

test('v1.19.0：开票公告写明「总窗口 + 起算点 + 提醒环节」（v1.22.0：真人不再豁免）；关闭时公告逐字不变', () => {
	const drive = (game) => {
		for (let round = 1; round <= 5; round += 1) {
			for (let seat = 0; seat < 4; seat += 1) {
				game.onRoomMessage({ authorSessionId: `s${seat}`, text: `【R${round}-${seat + 1} · ${NAMES[seat]}】第${round}轮第${seat + 1}位发言内容` });
			}
		}
		// v1.21.0：5 轮走完先进确认阶段 ⇒ 全员回「是」才拿到开票公告（用 `/请给出你们的投票/` 与确认公告区分）
		return confirmAll(game).find((effect) => effect.type === 'room' && /请给出你们的投票/u.test(effect.text));
	};

	const on = toDay();
	on.voteLimits = { deadlineMs: 150_000, graceMs: 150_000 };
	const openText = drive(on).text;
	assert.match(openText, /投票限时 5 分钟/u, '★ 写的是**总窗口**（2 分 30 秒 + 2 分 30 秒）');
	assert.match(openText, /自本条公告起/u, '★ 起算点（否则 AI 可以主张"从我看见起算"）');
	assert.match(openText, /2 分 30 秒时庄家会提醒一次仍未投者/u, '★ 提醒这一环必须写在公告里，否则房间里会出现规则外的公告');
	assert.match(openText, /仍未投的席位记\*\*弃权\*\*/u, 'v1.22.0：真人不再豁免 ⇒ 公告里不能再说"AI 席位/真人不受此限"');
	assert.equal(/真人席位不受此限|AI 席位记/u.test(openText), false, '★ 旧的豁免说法必须消失');
	assert.equal(/等待|可以先等|等信息/u.test(openText), false, '★ 只写规则，不写策略');

	const off = toDay();
	off.voteLimits = { deadlineMs: 0, graceMs: 0 };
	assert.equal(/投票限时/u.test(drive(off).text), false, '关闭时公告逐字不变');
});

test('v1.21.0 确认阶段：全员回「是」才开票；只认「是」；观察员可跳过', () => {
	const game = toDay();
	for (let round = 1; round <= 5; round += 1) {
		for (let seat = 0; seat < 4; seat += 1) {
			game.onRoomMessage({ authorSessionId: `s${seat}`, text: `【R${round}-${seat + 1} · ${NAMES[seat]}】第${round}轮第${seat + 1}位发言内容` });
		}
	}
	assert.equal(game.phase, PHASE.READY, '★ 5 轮走完进确认阶段（不再直接开票）');

	// 回别的 ⇒ 只复问、不确认（且不定义"否"的后果）
	const bad = game.onPrivateReply({ sessionId: 's0', text: '否' });
	assert.equal(game.ready.size, 0, '★ 只认「是」');
	assert.match(bad.find((effect) => effect.type === 'dm').text, /只认「是」/u);

	// 同义写法容忍；重复确认不重复计数
	const ok = game.onPrivateReply({ sessionId: 's0', text: '是的。' });
	assert.equal(game.ready.size, 1);
	assert.equal(ok.filter((effect) => effect.record?.type === 'ready-dup').length, 0);
	game.onPrivateReply({ sessionId: 's0', text: '是' });
	assert.equal(game.ready.size, 1, '重复确认不重复计数');
	assert.equal(game.phase, PHASE.READY);

	// 集齐 ⇒ 房间报一句 + 开票
	game.onPrivateReply({ sessionId: 's1', text: '是' });
	game.onPrivateReply({ sessionId: 's2', text: '是' });
	const last = game.onPrivateReply({ sessionId: 's3', text: '是' });
	assert.equal(game.phase, PHASE.VOTE, '★ 集齐 ⇒ 进入投票阶段');
	const rooms = last.filter((effect) => effect.type === 'room').map((effect) => effect.text);
	assert.equal(rooms.some((text) => /全场已确认/u.test(text)), true, '房间要有"已确认"那句');
	assert.equal(rooms.some((text) => /请给出你们的投票/u.test(text)), true, '紧接着是开票公告');

	// 观察员跳过：确认没齐也能直接开票
	const skip = toDay();
	for (let round = 1; round <= 5; round += 1) {
		for (let seat = 0; seat < 4; seat += 1) {
			skip.onRoomMessage({ authorSessionId: `s${seat}`, text: `【R${round}-${seat + 1} · ${NAMES[seat]}】第${round}轮第${seat + 1}位发言内容` });
		}
	}
	assert.equal(skip.phase, PHASE.READY);
	const skipped = skip.skipReady();
	assert.equal(skip.phase, PHASE.VOTE, '★ /ww-close-vote 在确认阶段 = 跳过等待');
	assert.equal(skipped.some((effect) => effect.type === 'room' && /观察员跳过等待/u.test(effect.text)), true);
	assert.equal(skipped.some((effect) => effect.record?.type === 'ready-skipped'), true);
	// 非确认阶段调用 ⇒ 拒绝（记档）
	assert.equal(skip.skipReady().at(-1).record.type, 'ready-skip-rejected');
});

test('v1.21.0 确认阶段：真人拿到**带按钮的私聊卡**（点按钮 = 回「是」，不往房间发东西）', () => {
	const game = toDay();
	game.players[0] = { ...game.players[0], human: true };   // 甲 = 真人
	let effects = [];
	for (let round = 1; round <= 5; round += 1) {
		for (let seat = 0; seat < 4; seat += 1) {
			effects = game.onRoomMessage({ authorSessionId: `s${seat}`, text: `【R${round}-${seat + 1} · ${NAMES[seat]}】第${round}轮第${seat + 1}位发言内容` });
		}
	}
	assert.equal(game.phase, PHASE.READY);
	const ask = effects.find((effect) => effect.type === 'room' && /是否进入投票阶段/u.test(effect.text));
	assert.ok(ask, '房间里要问「是否进入投票阶段？」');
	assert.ok(ask.mentions.includes('all'), '问话要召集全员');
	assert.equal(ask.mentions.includes('甲'), false, '真人绝不点名');
	const card = effects.find((effect) => effect.type === 'dm' && effect.sessionId === game.players[0].sessionId);
	assert.ok(card, '★ 真人应收到确认卡');
	assert.deepEqual(card.options, [{ label: '确认进入投票', text: '是' }], '★ 卡上带按钮（text 就是引擎认的「是」）');
	assert.equal(card.channel, undefined, '★ 默认信道 ⇒ 点按钮走 reply 端点，不往房间发东西');

	// 点按钮 = 以他的席位回「是」（同一个入口）
	game.onPrivateReply({ sessionId: game.players[0].sessionId, text: '是' });
	assert.equal(game.ready.size, 1, '真人的确认同样计数');
	assert.equal(game.phase, PHASE.READY, '还差其他人 ⇒ 仍停在确认阶段');
});

test('白天每轮顺序固定为声明顺序（循环），不是全局连续计数', () => {
	const game = toDay();
	// 第 1 轮走完
	for (let seat = 0; seat < 4; seat += 1) game.onRoomMessage({ authorSessionId: `s${seat}`, text: `【R1-${seat + 1} · ${NAMES[seat]}】一` });
	// 第 2 轮仍从 甲 开始，序号重新从 1 计
	const effects = game.onRoomMessage({ authorSessionId: 's0', text: '【R2-1 · 甲】二轮开头' });
	assert.equal(effects.filter((effect) => effect.type === 'room').length, 0);
	assert.equal(game.position, 1);
	assert.equal(game.round, 2);
});

// ---------------------------------------------------------------- v1.16.x：完赛感想

test('v1.16.2：赛后不再有邀请；真人第一条自动 AT 全员、AI 只 @all；每人只收第一条', () => {
	const game = makeGame({ roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.SEER] });
	game.players[2].human = true; // 丙 = 真人
	setVotes(game, [1, 1, null]);
	const effects = game.closeVote('all-in');
	assert.equal(game.phase, PHASE.SETTLED);
	const rooms = effects.filter((effect) => effect.type === 'room');
	assert.equal(rooms.length, 1, 'v1.16.2：只发结算公告 —— 感想不再由庄家邀请（改由真人的第一条发言带起来）');
	assert.match(rooms[0].text, /最终投票结果/);

	// 真人赛后第一条 ⇒ **自动 AT 全员**（发言框接管会把这份提及写上）：一句「这局……」把 AI 都唤醒。
	// 这一步只产出意图、不记账，所以放在下面的回流之前。
	const humanIntent = game.speak('s2', '我是预言家，验错了');
	assert.equal(humanIntent.ok, true);
	assert.equal(humanIntent.kind, 'closing');
	assert.deepEqual(humanIntent.mentions, ['all', '甲', '乙'], '★ 真人赛后第一条自动 AT 全员');
	assert.equal(humanIntent.text, '我是预言家，验错了', '正文原样，不加前缀');
	// AI 席位**只 @all**：否则每个 AI 的感想会再叫醒其他 AI（回声风暴），而他们多半已经说过了。
	const aiIntent = game.speak('s1', '我是村民，认了');
	assert.equal(aiIntent.kind, 'closing');
	assert.deepEqual(aiIntent.mentions, ['all'], '★ AI 的感想不唤醒谁');

	// 每人只收**第一条**房间发言（真人与 AI 同口径）；非玩家、空正文不收
	game.onRoomMessage({ authorSessionId: 's0', text: '我是狼，谢谢大家' });
	game.onRoomMessage({ authorSessionId: 's0', text: '再说一句' });
	game.onRoomMessage({ authorSessionId: 's2', text: '我是预言家，验错了' });
	game.onRoomMessage({ authorSessionId: 'outsider', text: '我是路人' });
	game.onRoomMessage({ authorSessionId: 's1', text: '   ' });
	assert.deepEqual(
		game.closing.map((entry) => [entry.seat, entry.human, entry.text]),
		[[1, false, '我是狼，谢谢大家'], [3, true, '我是预言家，验错了']],
		'★ 每人只收第一条；后一条、非玩家、空正文都不进'
	);

	// 记账发生在**消息回流**里（与发言/投票同一条路）：回流落地之后，再说一条才被拒。
	game.onRoomMessage({ authorSessionId: 's1', text: '我是村民，认了' });
	assert.equal(game.closing.length, 3);
	const again = game.speak('s1', '再来一条');
	assert.equal(again.ok, false, '★ 已经说过的不再收');
	assert.match(again.reason, /已经说过一条/);
	const humanAgain = game.speak('s2', '再来一条');
	assert.equal(humanAgain.ok, false, '真人同样只收第一条（第二条不走接管、照旧落房间但不进复盘）');

	// 进 raw 导出、且序列化往返不丢（重启续局后照样能补写）
	assert.equal(game.rawExport().closing.length, 3);
	const revived = Game.fromJSON(JSON.parse(JSON.stringify(game.toJSON())));
	assert.deepEqual(revived.closing, game.closing, '★ 序列化往返不丢感想');
});

// ---------------------------------------------------------------- v1.16.3：观察员的赛后点评

test('v1.16.3：赛后「全员点名」—— 观察员第一条点评自动 AT 全体 AI，且一场只用一次', () => {
	const game = makeGame({ roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.SEER] });
	assert.equal(game.closingPromptFor('room-side'), null, '还没结算 ⇒ 不接管');
	setVotes(game, [1, 1, 1]);
	game.closeVote('all-in');
	// AI 局里没有真人席位 ⇒ 名单就是全部 AI；观察员不是席位，所以走的是这条（不是 speak()）
	assert.deepEqual(game.closingPromptFor('room-side'), { mentions: ['all', '甲', '乙', '丙'] }, '★ 观察员第一条点评 AT 全体 AI');
	assert.equal(game.closingPromptFor('room-side'), null, '★ 一场只用一次（免得每句都叫醒全场）');
	// v1.16.4：**他这条点评也记进 `closing`**（进「## 完赛感想」那一节）—— 引擎只认挂上来的那个身份。
	game.onRoomMessage({ authorSessionId: 'room-side', text: '我点评一下：甲演得不错。' });
	assert.deepEqual(
		game.closing.at(-1),
		{ seat: null, name: null, sessionId: 'room-side', human: true, observer: true, text: '我点评一下：甲演得不错。', at: game.now() },
		'★ 观察员的点评记成「真人、无座位」（名字留给渲染层用配置兜底）'
	);
	game.onRoomMessage({ authorSessionId: 'someone-else', text: '我也说一句。' });
	game.onRoomMessage({ authorSessionId: 'room-side', text: '再补一句。' });
	assert.equal(game.closing.filter((entry) => entry.observer === true).length, 1, '★ 观察员也只收第一条（别的非席位身份一条都不收）');
	assert.equal(game.observerClosing, null, '回流落地后就不必再等了');
	assert.equal(game.rawExport().closing.length, 1);
	const revived = Game.fromJSON(JSON.parse(JSON.stringify(game.toJSON())));
	assert.equal(revived.closingPrompt, true, '★ 「用过了」进状态：重启续局后不会又给一次');

	// 玩家**不走**这条（他自己的提及由 speak() 算：真人 = @all + 其余 AI）
	const withHuman = makeGame({ roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.SEER] });
	withHuman.players[0].human = true;
	setVotes(withHuman, [1, 1, 1]);
	withHuman.closeVote('all-in');
	assert.equal(withHuman.closingPromptFor('s0'), null, '★ 玩家那条由 speak() 负责，不在这里重复接管');
	assert.deepEqual(withHuman.speak('s0', '我是狼，谢谢大家').mentions, ['all', '乙', '丙']);
	assert.equal(withHuman.closingPrompt === false, true, 's0 是玩家 ⇒ 这次点名没被消耗掉');
});

// ---------------------------------------------------------------- 投票与结算（§11-4）

test('复盘写手：开局不指定，结算后按胜负判定（三条分支）', () => {
	// ① 赢家 1、败者为复数 ⇒ 写手 = 赢家（全场投人类 ⇒ 狼胜，而狼只有甲一只）
	const soleWinner = makeGame({ roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER] });
	assert.equal(soleWinner.recapWriter, null, '开局不该有写手');
	setVotes(soleWinner, [2, 2, 2, 2]);
	soleWinner.closeVote('observer');
	assert.equal(soleWinner.settlement.winner, 'wolf');
	assert.equal(soleWinner.recapWriter, '甲');

	// ② 败者 1、赢家为复数 ⇒ 写手 = 败者（全场票出狼 ⇒ 人类胜，败者只有甲）
	const soleLoser = makeGame({ roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER] });
	setVotes(soleLoser, [1, 1, 1, 1]);
	soleLoser.closeVote('observer');
	assert.equal(soleLoser.settlement.winner, 'human');
	assert.equal(soleLoser.recapWriter, '甲');

	// ③ 其余（这里 1:1:1:1 ⇒ 两方各 2 人）⇒ 排序顺序的第一个 AI
	const split = makeGame({ roles: [ROLES.WOLF, ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER] });
	setVotes(split, [2, 3, 4, 1]);
	split.closeVote('observer');
	assert.equal(split.settlement.verdict, 'wolf-no-lynch');
	assert.equal(split.recapWriter, '甲');

	// ③' 同一分支下"第一个 AI"要跳过真人席位（甲是真人 ⇒ 取乙）
	const withHuman = makeGame({ roles: [ROLES.WOLF, ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER] });
	withHuman.players[0] = { ...withHuman.players[0], human: true };
	setVotes(withHuman, [2, 3, 4, 1]);
	withHuman.closeVote('observer');
	assert.equal(withHuman.recapWriter, '乙');
});

test('票型解析：格式票、自由文本、平安夜、弃票、歧义', () => {
	const game = makeGame();
	assert.equal(game.parseVote('投票：甲').target, 1);
	assert.equal(game.parseVote('我投票给 丙').target, 3);
	assert.equal(game.parseVote('甲').target, 1);
	assert.equal(game.parseVote('投票：平安夜').target, PEACE);
	assert.equal(game.parseVote('平安夜').target, PEACE);
	assert.equal(game.parseVote('弃票').target, ABSTAIN);
	assert.equal(game.parseVote('甲乙都像狼').ambiguous, true);
	assert.equal(game.parseVote('我不知道').target, undefined);
});

test('票型解析：带前缀／装饰的投票不再被判"无法识别"（2026-10-04 真机 bug）', () => {
	// 真机那一局的席位名原样复现：装饰块里的"投票"先命中旧实现的切分点，把投票人自己的名字
	// （小鲸鱼）算成了候选 ⇒「小鲸鱼 + 小米」两个候选 ⇒ 判歧义 ⇒ 复问。
	const real = makeGame({ players: ['小鲸鱼', '小米', '大D', '大G'] });
	assert.equal(real.parseVote('【投票 · 小鲸鱼】投票：小米').target, 2);
	const game = makeGame();
	assert.equal(game.parseVote('【投票·甲】投票：丙').target, 3);
	// 带轮次前缀（白天发言那套前缀）+ 投票
	assert.equal(game.parseVote('【R5-3 · 甲】投票：乙').target, 2);
	// 引用符 / markdown 加粗 / 全角冒号 / 嵌套装饰
	assert.equal(game.parseVote('> 投票：丁').target, 4);
	assert.equal(game.parseVote('**投票：乙**').target, 2);
	assert.equal(game.parseVote('【投票 · 丙】「投票」：甲').target, 1);
	// 票后面带理由（成对括号里的说明不算候选）
	assert.equal(game.parseVote('投票：乙（因为丙昨天很可疑）').target, 2);
	assert.equal(game.parseVote('【投票 · 丁】投票：平安夜（我判断今晚是平安夜）').target, PEACE);
	// 依然**不猜**：正文里真的出现两个座位名 ⇒ 仍然要复问
	assert.equal(game.parseVote('投票：乙 丙').ambiguous, true);
	assert.equal(game.parseVote('【投票 · 甲】投票：乙 丙').ambiguous, true);
	assert.equal(game.parseVote('【投票 · 甲】').target, undefined);
});

test('v1.18.0 首投落定：同一席位后续票不再覆盖（回流路径）', () => {
	const game = makeGame({ roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER] });
	setVotes(game, [null, null, null, null]);
	const first = game.onRoomMessage({ authorSessionId: 's0', text: '投票：乙' });
	const accepted = first.filter((effect) => effect.type === 'audit').at(-1);
	assert.equal(accepted.record.decision, 'accepted');
	assert.equal(accepted.record.target, 2);

	// 改票（回流路径）：票不变，记 `locked-changed`
	const changed = game.onRoomMessage({ authorSessionId: 's0', text: '投票：丙' });
	const lockedChanged = changed.filter((effect) => effect.type === 'audit').at(-1);
	assert.equal(game.votes.get('s0').target, 2, '★ 首投就是最终票（后一条不覆盖）');
	assert.equal(lockedChanged.record.decision, 'locked-changed');
	assert.equal(lockedChanged.record.lockedTarget, 2, '审计留原票');
	assert.equal(lockedChanged.record.target, 3, '审计留他想改成的那一票');

	// 同内容重发 ⇒ 幂等（`locked-same`），票仍不变、票序号不推进
	const again = game.onRoomMessage({ authorSessionId: 's0', text: '投票：乙' });
	const lockedSame = again.filter((effect) => effect.type === 'audit').at(-1);
	assert.equal(lockedSame.record.decision, 'locked-same');
	assert.equal(game.votes.get('s0').target, 2);
	assert.equal(game.voteSeq, 1, '锁定不推进票序号（没有新票落盘）');

	// 已落定 + **认不出**的正文 ⇒ 也按已落定处理，且**不再发"请重发"复问**（用户 2026-10-06 边界 b）
	const garbage = game.onRoomMessage({ authorSessionId: 's0', text: '我不知道投谁' });
	assert.equal(garbage.filter((effect) => effect.type === 'dm').length, 0, '★ 已落定 ⇒ 静默（不复问）');
	assert.equal(garbage.filter((effect) => effect.type === 'audit').at(-1).record.decision, 'locked-changed');
	assert.equal(game.votes.get('s0').target, 2);
});

test('v1.20.0 禁止自投：speak 预检不投递、复问自带可选座位（不含自己）', () => {
	const game = makeGame({ roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER] });
	setVotes(game, [null, null, null, null]);
	const self = game.speak('s0', '投票：甲');
	assert.equal(self.ok, false, '★ 自投不产出发言意图（房间不留气泡）');
	assert.equal(self.selfVote, true);
	assert.match(self.reason, /不能投给自己/u);
	assert.match(self.reason, /可选座位（不含你自己）：乙、丙、丁/u);
	assert.equal(self.text, undefined);
	assert.equal(game.speak('s1', '投票：乙').selfVote, true, '对每个席位一视同仁');
	const ok = game.speak('s0', '投票：乙');
	assert.equal(ok.ok, true, '合法票照旧正常产出');
	assert.equal(ok.kind, 'vote');
});

test('v1.20.0 禁止自投：回流路径判无效、私下让他重投、且**不落定**', () => {
	const game = makeGame({ roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER] });
	setVotes(game, [null, null, null, null]);
	const effects = game.onRoomMessage({ authorSessionId: 's0', text: '投票：甲' });
	assert.equal(game.votes.has('s0'), false, '★ 自投不落票');
	const dm = effects.find((effect) => effect.type === 'dm');
	assert.ok(dm, '必须私下告知（否则他会以为自己投过了）');
	assert.match(dm.text, /不能投给自己/u);
	assert.equal(effects.filter((effect) => effect.type === 'audit').at(-1).record.decision, 'invalid-self');

	// 自投**不落定** ⇒ 之后正常投还能算（这是它与"已落定"的区别）
	game.onRoomMessage({ authorSessionId: 's0', text: '投票：乙' });
	assert.equal(game.votes.get('s0').target, 2);

	// 已落定之后再来一条自投 ⇒ 走"已落定不可撤改"（锁票优先），不再复问
	const after = game.onRoomMessage({ authorSessionId: 's0', text: '投票：甲' });
	assert.equal(after.filter((effect) => effect.type === 'dm').length, 0);
	assert.equal(after.filter((effect) => effect.type === 'audit').at(-1).record.decision, 'locked-changed');
});

test('v1.19.0 投票限时：先催后判（AI 记弃权、推进 all-in 自动结算）', () => {
	const game = makeGame({ roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER] });
	setVotes(game, [null, null, null, null]);
	let t = 1_000;
	game.now = () => t;
	game.voteOpenAt = t;
	// 用**生产默认值**：2 分 30 秒催 + 2 分 30 秒宽限（总窗口 5 分钟）
	const limits = { deadlineMs: 150_000, graceMs: 150_000 };

	// 未到期限：什么都不做
	assert.deepEqual(game.tickVoteDeadline(limits), []);
	assert.equal(game.voteNudgedAt, null);

	// 阶段 1：到点**先催**（每人一条私聊 + 房间一条中性提醒 + 审计），**不判弃权**
	t += 150_000;
	const nudge = game.tickVoteDeadline(limits);
	assert.equal(nudge.filter((effect) => effect.type === 'dm').length, 4, '★ 每个未投的 AI 席位各催一次');
	assert.match(nudge.find((effect) => effect.type === 'dm').text, /请在 2 分 30 秒内投出/u);
	const countdown = nudge.find((effect) => effect.type === 'room');
	assert.match(countdown.text, /投票限时提醒：还有 4 位/u);
	assert.match(countdown.text, /2 分 30 秒内仍未投/u);
	assert.equal(nudge.at(-1).record.type, 'vote-nudge');
	assert.equal(game.votes.size, 0, '催票本身不落票');
	assert.equal(game.phase, PHASE.VOTE);

	// 宽限未到：不动
	t += 149_000;
	assert.deepEqual(game.tickVoteDeadline(limits), []);

	// 阶段 2：宽限到点 ⇒ 记弃权（**写进票**，否则推进不了 all-in）⇒ 自动结算
	t += 1_000;
	const over = game.tickVoteDeadline(limits);
	assert.equal(game.votes.size, 4);
	for (const vote of game.votes.values()) {
		assert.equal(vote.target, ABSTAIN, '★ 超时记弃票');
		assert.equal(vote.timeout, true);
	}
	assert.equal(over.filter((effect) => effect.record?.type === 'vote-timeout').length, 4);
	assert.match(over.find((effect) => effect.type === 'room' && /投票截止/u.test(effect.text)).text, /仍未投的席位已记/u);
	assert.equal(game.phase, PHASE.SETTLED, '★ 全场弃票 ⇒ 直接结算（按平安夜口径裁决）');
	assert.deepEqual(game.tickVoteDeadline(limits), [], '结算后再 tick 不重复动作');
});

test('v1.22.0 投票限时：真人**同样**受限期（催票用真人文案、不唤醒；超时同样记弃权并私下告知）', () => {
	const game = makeGame({ roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER] });
	game.players[3].human = true; // 丁 = 真人
	setVotes(game, [null, null, null, null]);
	let t = 5_000;
	game.now = () => t;
	game.voteOpenAt = t;
	const limits = { deadlineMs: 1_000, graceMs: 1_000 };

	t += 1_000;
	const nudge = game.tickVoteDeadline(limits);
	const dms = nudge.filter((effect) => effect.type === 'dm');
	assert.equal(dms.length, 4, '★ 真人也在催票名单里');
	const humanDm = dms.find((effect) => effect.sessionId === 's3');
	assert.match(humanDm.text, /还没收到你的票/u);
	assert.match(humanDm.text, /在房间里发/u, '真人拿到的催票要用"在房间里投票"的写法');
	assert.equal(humanDm.wake, false, '★ 真人的催票不唤醒他的会话（只落时间线）');
	assert.match(nudge.find((effect) => effect.type === 'room').text, /还有 4 位/u);

	t += 1_000;
	const over = game.tickVoteDeadline(limits);
	const humanVote = game.votes.get('s3');
	assert.equal(humanVote.timeout, true, '★ 真人超时同样记弃权');
	assert.equal(humanVote.raw, '[timeout]');
	assert.equal(over.some((effect) => effect.type === 'dm' && effect.sessionId === 's3' && /已记\*\*弃权\*\*/u.test(effect.text)), true, '★ 要私下告知真人（房间里那条不点名）');
	assert.equal(over.some((effect) => effect.record?.type === 'vote-timeout' && effect.record.name === '丁'), true);
	assert.equal(game.phase, PHASE.SETTLED, '四票齐（含真人弃权）⇒ 推进 all-in 自动结算');

	assert.deepEqual(game.tickVoteDeadline({ deadlineMs: 0, graceMs: 1_000 }), [], 'deadlineMs=0 ⇒ 关闭');
});

test('v1.19.0 投票限时：已投的席位不受影响、也不重复判', () => {
	const game = makeGame({ roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER] });
	setVotes(game, [null, null, null, null]);
	let t = 9_000;
	game.now = () => t;
	game.voteOpenAt = t;
	const limits = { deadlineMs: 1_000, graceMs: 1_000 };
	game.onRoomMessage({ authorSessionId: 's0', text: '投票：乙' }); // 甲 已投

	t += 1_000;
	const nudge = game.tickVoteDeadline(limits);
	assert.equal(nudge.filter((effect) => effect.type === 'dm').length, 3, '已投的席位不再催');

	t += 1_000;
	game.tickVoteDeadline(limits);
	assert.equal(game.votes.get('s0').target, 2, '★ 已投的票原样不动');
	assert.equal(game.votes.size, 4);
	assert.equal(game.tickVoteDeadline(limits).filter((effect) => effect.record?.type === 'vote-timeout').length, 0, '不重复判');
});

test('全部到齐自动收票结算；未声明者记弃票', () => {
	const game = makeGame({ roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER] });
	setVotes(game, [null, null, null, null]);
	game.onRoomMessage({ authorSessionId: 's0', text: '投票：乙' }); // v1.20.0：禁止自投 —— 甲 不能投自己
	game.onRoomMessage({ authorSessionId: 's1', text: '投票：甲' });
	game.onRoomMessage({ authorSessionId: 's2', text: '投票：甲' });
	const effects = game.onRoomMessage({ authorSessionId: 's3', text: '投票：甲' });
	assert.equal(game.phase, PHASE.SETTLED);
	const announcement = effects.find((effect) => effect.type === 'room');
	assert.match(announcement.text, /身份揭晓：/);
	assert.match(announcement.text, /人类阵营获胜！/);
	assert.match(announcement.text, /4\.丁 → 甲/);
});

test('结算：弃票不参与最高票判定', () => {
	const game = makeGame({ roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER] });
	setVotes(game, [1, 1, null, null]);
	const settlement = game.computeSettlement();
	assert.deepEqual(settlement.leaders, ['甲']);
	assert.equal(settlement.verdict, 'human-single-wolf');
	assert.equal(settlement.abstain.length, 2);
});

/** 结算决策树逐分支（§11-4 要求的 8 类）。 */
const SETTLEMENT_CASES = [
	{ label: '单杀人类 ⇒ 狼胜', roles: [ROLES.VILLAGER, ROLES.VILLAGER, ROLES.WOLF, ROLES.SEER], votes: [1, 1, 1, 1], verdict: 'wolf-single-human', winner: 'wolf' },
	{ label: '单杀狼 ⇒ 人类胜', roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [1, 1, 1, 1], verdict: 'human-single-wolf', winner: 'human' },
	{ label: '平安夜有狼 ⇒ 狼胜', roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [PEACE, PEACE, PEACE, PEACE], verdict: 'wolf-peace-with-wolf', winner: 'wolf' },
	{ label: '平安夜无狼 ⇒ 人类胜', roles: [ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [PEACE, PEACE, PEACE, PEACE], verdict: 'human-peace-no-wolf', winner: 'human' },
	{ label: '2:2 含狼 ⇒ 人类胜', roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [2, 1, 1, 2], verdict: 'human-double', winner: 'human' },
	{ label: '2:2 双人类 ⇒ 人类败（狼胜）', roles: [ROLES.VILLAGER, ROLES.VILLAGER, ROLES.WOLF, ROLES.SEER], votes: [2, 1, 1, 2], verdict: 'wolf-double-human', winner: 'wolf' },
	{ label: '1:1:1:1 有狼 ⇒ 狼胜', roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [2, 3, 4, 1], verdict: 'wolf-no-lynch', winner: 'wolf' },
	{ label: '1:1:1:1 无狼 ⇒ 人类胜', roles: [ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [2, 3, 4, 1], verdict: 'human-no-lynch', winner: 'human' },
	{ label: '平安夜2+玩家2 ⇒ 按淘汰该玩家算（该玩家是狼）', roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [PEACE, PEACE, 1, 1], verdict: 'human-single-wolf', winner: 'human' },
	{ label: '平安夜2+玩家2 ⇒ 按淘汰该玩家算（该玩家是人类）', roles: [ROLES.VILLAGER, ROLES.VILLAGER, ROLES.WOLF, ROLES.SEER], votes: [PEACE, PEACE, 1, 1], verdict: 'wolf-single-human', winner: 'wolf' },
	// v1.13.1（用户口径）：**全场弃票算做平安夜** ⇒ 用平安夜那套裁决，胜负看有无狼
	{ label: '全场弃票且有狼 ⇒ 算平安夜 ⇒ 狼胜', roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [null, null, null, null], verdict: 'wolf-peace-with-wolf', winner: 'wolf' },
	{ label: '全场弃票且无狼 ⇒ 算平安夜 ⇒ 人类胜', roles: [ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [null, null, null, null], verdict: 'human-peace-no-wolf', winner: 'human' },
	{ label: '部分弃票、平安夜仍是最高票 ⇒ 平安夜口径', roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [PEACE, PEACE, null, null, null], verdict: 'wolf-peace-with-wolf', winner: 'wolf' },
	// ── 规则卡 §游戏胜败 末条：场上无狼却误杀同伴 ⇒ 人类阵营失败（结果同「狼胜」，但原因要写对）──
	{ label: '场上无狼，最高票是个人类 ⇒ 人类阵营失败（误杀同伴）', roles: [ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [1, 1, 1, 1], verdict: 'wolf-mislynch-no-wolf', winner: 'wolf' },
	{ label: '场上无狼，平安夜与某玩家平票 ⇒ 淘汰该人类 ⇒ 同样是误杀', roles: [ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [PEACE, PEACE, 1, 1], verdict: 'wolf-mislynch-no-wolf', winner: 'wolf' },

	// ── v1.13.0：5/6 人局才会出现的票型（更高人数 ⇒ 更多并列形态）──
	{ label: '5人局 2:2:1 ⇒ 最高两位并列，双淘汰含狼 ⇒ 人类胜', roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [1, 1, 2, 2, 3], verdict: 'human-double', winner: 'human' },
	{ label: '5人局 2:2:1 ⇒ 双淘汰均为人类 ⇒ 狼胜', roles: [ROLES.VILLAGER, ROLES.VILLAGER, ROLES.WOLF, ROLES.VILLAGER, ROLES.SEER], votes: [1, 1, 2, 2, 3], verdict: 'wolf-double-human', winner: 'wolf' },
	{ label: '6人局 3:3 ⇒ 双淘汰含狼 ⇒ 人类胜', roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [1, 1, 1, 4, 4, 4], verdict: 'human-double', winner: 'human' },
	{ label: '6人局 2:2:2 ⇒ 三方并列，无人淘汰，有狼 ⇒ 狼胜', roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [1, 1, 2, 2, 3, 3], verdict: 'wolf-no-lynch', winner: 'wolf' },
	{ label: '6人局 2:2:2 ⇒ 三方并列，无人淘汰，无狼 ⇒ 人类胜', roles: [ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [1, 1, 2, 2, 3, 3], verdict: 'human-no-lynch', winner: 'human' },
	{ label: '5人局 1:1:1:1:1 ⇒ 五方并列，无人淘汰，有狼 ⇒ 狼胜', roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [1, 2, 3, 4, 5], verdict: 'wolf-no-lynch', winner: 'wolf' },
	{ label: '6人局 1:1:1:1:1:1 ⇒ 六方并列，无人淘汰，无狼 ⇒ 人类胜', roles: [ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [1, 2, 3, 4, 5, 6], verdict: 'human-no-lynch', winner: 'human' },
	{ label: '6人局 平安夜3+玩家3 ⇒ 按淘汰该玩家算（该玩家是狼）', roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [PEACE, PEACE, PEACE, 1, 1, 1], verdict: 'human-single-wolf', winner: 'human' },
	{ label: '6人局 平安夜2+玩家2+玩家2 ⇒ 三方并列（含平安夜），无人淘汰，有狼 ⇒ 狼胜', roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], votes: [PEACE, PEACE, 1, 1, 2, 2], verdict: 'wolf-no-lynch', winner: 'wolf' }
];

for (const item of SETTLEMENT_CASES) {
	test(`结算决策树：${item.label}`, () => {
		const game = makeGame({ roles: item.roles });
		setVotes(game, item.votes);
		const settlement = game.computeSettlement();
		assert.equal(settlement.verdict, item.verdict);
		assert.equal(settlement.winner, item.winner);
	});
}

test('结算按**换卡后**的现值算阵营', () => {
	// 怪盗换到狼：怪盗现值是狼 → 他被投出 ⇒ 人类胜
	const game = makeGame({ roles: [ROLES.TRICKSTER, ROLES.WOLF, ROLES.VILLAGER, ROLES.SEER] });
	game.hand = new Map([[ 's0', ROLES.WOLF ], [ 's1', ROLES.TRICKSTER ], [ 's2', ROLES.VILLAGER ], [ 's3', ROLES.SEER ]]);
	setVotes(game, [1, 1, 1, 1]);
	assert.equal(game.computeSettlement().verdict, 'human-single-wolf');
	// 被换走的原狼（现值人类）被投出 ⇒ 狼胜
	setVotes(game, [2, 2, 2, 2]);
	assert.equal(game.computeSettlement().verdict, 'wolf-single-human');
});

test('结算公告含逐票统计、身份表、牌堆与复盘指派', () => {
	const game = makeGame({ roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER], pile: [ROLES.VILLAGER, ROLES.TRICKSTER] });
	game.setRecapWriter('甲');
	setVotes(game, [2, 1, 1, 2]);
	const settlement = game.computeSettlement();
	game.settlement = settlement;
	game.phase = PHASE.VOTE;
	const effects = game.closeVote('observer');
	const text = effects[0].text;
	assert.match(text, /最终投票结果：/);
	assert.match(text, /1\.甲 → 乙/);
	assert.match(text, /身份揭晓：/);
	assert.match(text, /座位 \| 被发到的牌 \| 现值（换卡后）/);
	assert.match(text, /牌堆：村民×1、怪盗×1/);
	assert.match(text, /人类阵营获胜！/);
	assert.match(text, /复盘日志由 甲 来写，其他 AI 只要把感想发群里就行！/);
});

// ---------------------------------------------------------------- 观察员控制（§10）

test('暂停期间房间消息与私聊一律不推进状态', () => {
	const game = toDay();
	game.setPaused(true);
	const before = game.position;
	game.onRoomMessage({ authorSessionId: 's0', text: '【R1-1 · 甲】推进试试' });
	assert.equal(game.position, before);
});

test('覆写票只影响指定座位', () => {
	const game = makeGame();
	setVotes(game, [2, 1, null, null]);
	const effects = game.overrideVote('丙', '平安夜');
	assert.equal(effects.filter((effect) => effect.type === 'audit' && effect.record.type === 'override-vote').length, 1);
	assert.equal(game.votes.get('s2').target, PEACE);
	assert.equal(game.votes.get('s0').target, 2);
});

test('覆写不存在的座位/目标被拒并记档', () => {
	const game = makeGame();
	setVotes(game, [null, null, null, null]);
	assert.equal(game.overrideVote('不存在的人', '甲').at(-1).record.type, 'override-rejected');
	assert.equal(game.overrideVote('甲', '不存在的人').at(-1).record.type, 'override-rejected');
});

test('/ww-end 非正式结算不改写正式结果', () => {
	const game = makeGame({ roles: [ROLES.WOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.SEER] });
	setVotes(game, [2, 1, null, null]);
	const effects = game.endInformally();
	assert.equal(game.phase, PHASE.ENDED);
	assert.equal(game.playable, false);
	assert.match(effects[0].text, /非正式/);
	assert.equal(game.settlement, null);
});

// ---------------------------------------------------------------- 持久化

test('序列化/反序列化保真（同 seed 重建牌序 + 覆盖可变状态）', () => {
	const game = makeGame({ roles: [ROLES.SEER, ROLES.WOLF, ROLES.TRICKSTER, ROLES.VILLAGER] });
	game.start();
	game.onPrivateReply({ sessionId: 's0', text: '验 乙' });
	game.onPrivateReply({ sessionId: 's2', text: '换 乙' });
	const restored = Game.fromJSON(JSON.parse(JSON.stringify(game.toJSON())));
	assert.equal(restored.phase, game.phase);
	assert.equal(restored.round, game.round);
	assert.deepEqual([...restored.hand.entries()], [...game.hand.entries()]);
	assert.deepEqual([...restored.dealt.entries()], [...game.dealt.entries()]);
	assert.deepEqual(restored.pile, game.pile);
	assert.deepEqual(restored.status(), game.status());
});

// ---------------------------------------------------------------- 观察员手动催人（/ww-nudge）

test('催人：白天只催当前应发言者，正文含前缀与"唤醒下一位"的写法', () => {
	const game = toDay();
	const result = game.nudge();
	assert.equal(result.seats.length, 1);
	assert.equal(result.seats[0].name, '甲');
	assert.equal(result.seats[0].kind, 'day');
	const dm = result.effects.find((effect) => effect.type === 'dm');
	assert.equal(dm.sessionId, 's0');
	assert.equal(dm.wake, true, 'AI 席位要唤醒');
	assert.equal(dm.text, T.nudgeDay(1, 1, '甲', '乙'));
	// 白天催的是房间发言，不能附"用 wolf_reply 回我"的信道提示
	assert.equal(dm.text.includes('wolf_reply'), false);
	// 催人也进审计与对局 log
	assert.equal(result.effects.some((effect) => effect.type === 'audit' && effect.record.type === 'nudge'), true);
	assert.equal(game.log.at(-1).type, 'nudge');
});

test('催人：夜间催等待回复者（带信道提示），投票期只催未投票者', () => {
	const night = makeGame({ roles: [ROLES.SEER, ROLES.WOLF, ROLES.TRICKSTER, ROLES.VILLAGER] });
	night.start();
	const nightResult = night.nudge();
	assert.equal(nightResult.seats[0].name, '甲');
	assert.equal(nightResult.seats[0].kind, 'night');
	const nightDm = nightResult.effects.find((effect) => effect.type === 'dm');
	assert.equal(nightDm.text, `${T.idleReminderNight()}\n${T.aiChannelHint()}`);

	const game = makeGame();
	setVotes(game, [1, null, 2, null]);
	const voteResult = game.nudge();
	assert.deepEqual(voteResult.seats.map((seat) => seat.name), ['乙', '丁']);
	assert.equal(voteResult.seats.every((seat) => seat.kind === 'vote'), true);
	for (const effect of voteResult.effects.filter((item) => item.type === 'dm')) {
		assert.equal(effect.text, T.nudgeVote(['甲', '乙', '丙', '丁']));
		assert.equal(effect.text.includes('wolf_reply'), false, '投票发在房间，不该附私聊信道提示');
	}
});

test('催人：真人席位拿到的是"在房间里发言"的提醒，且不唤醒', () => {
	const game = makeGame({ roles: [ROLES.SEER, ROLES.WOLF, ROLES.TRICKSTER, ROLES.VILLAGER] });
	// 把第 1 席（预言家）改成真人：房间侧身份用房间自身会话 id
	const humanSession = game.players[0].sessionId;
	game.players[0] = { ...game.players[0], human: true, chanIds: [humanSession, 'dsh-chat-room-v3-x'] };
	game.start();
	game.onPrivateReply({ sessionId: humanSession, text: '2' });
	game.onPrivateReply({ sessionId: 's2', text: '不换' });
	assert.equal(game.phase, PHASE.DAY);
	const result = game.nudge();
	assert.equal(result.seats[0].name, '甲');
	assert.equal(result.seats[0].human, true);
	const dm = result.effects.find((effect) => effect.type === 'dm');
	assert.equal(dm.wake, false, '真人席位不唤醒');
	assert.equal(dm.text, T.humanTurn(1, 1, '甲', T.humanTurnNext('乙')));
});

test('催人：第 5 轮最后一位不需要唤醒下一位（正文明说没有下一棒）', () => {
	const game = toDay();
	game.round = 5;
	game.position = 3; // 第 4 位（末位）
	const result = game.nudge();
	assert.equal(result.seats[0].name, '丁');
	const dm = result.effects.find((effect) => effect.type === 'dm');
	// 不写成 T.nudgeDay(...) —— 自引用断言什么都验不到，这里断正文本身
	assert.match(dm.text, /^提醒：第5轮当前应由你发言（第 4 位）。/);
	assert.match(dm.text, /wolf_speak/);
	assert.match(dm.text, /你是全场最后一位（第 5 轮末位），没有下一位要唤醒/);
	assert.equal(/mentions = /.test(dm.text), false, '不该再让模型自己填 mentions');
});

test('催人：暂停/结束时拒绝；指定非当前行动者时列出真正该动的人', () => {
	const game = toDay();
	assert.deepEqual(game.nudge({ seatRef: '丙' }).error, '「丙」现在不是该行动的人（现在应该动的是：甲）');
	// v1.16.5：名字根本不存在时，报"没有这个席位"并列出花名册（旧实现两种错都回同一句）
	assert.equal(game.nudge({ seatRef: '小明' }).error, '没有「小明」这个席位（本局席位：1.甲、2.乙、3.丙、4.丁）');
	const ok = game.nudge({ seatRef: '甲' });
	assert.equal(ok.seats[0].name, '甲');
	game.setPaused(true);
	assert.equal(game.nudge().error, '对局已暂停：先 /ww-resume 再催');
	game.setPaused(false);
	game.endInformally();
	assert.equal(game.nudge().error, '对局已结束，没有需要催的人');
});

// ------------------------------------------------ B 方案：庄家代投（v1.9.0）

test('v1.10.1：白天不再自动私聊提醒真人（手动催人不受影响）', () => {
	const game = makeGame({ roles: [ROLES.SEER, ROLES.WOLF, ROLES.TRICKSTER, ROLES.VILLAGER] });
	const humanSession = game.players[0].sessionId;                 // 甲 = 真人（预言家，第 1 位发言）
	game.players[0] = { ...game.players[0], human: true, chanIds: [humanSession, 'dsh-chat-room-v3-x'] };
	game.start();
	game.onPrivateReply({ sessionId: humanSession, text: '2' });
	const nightEnd = game.onPrivateReply({ sessionId: 's2', text: '不换' });
	assert.equal(game.phase, PHASE.DAY);
	assert.equal(nightEnd.filter((effect) => effect.type === 'dm' && effect.sessionId === humanSession).length, 0, '① 白天开场（首位就是他）不该私聊提醒真人');

	// ② 手动催人照旧：他不在 AI 的唤醒链上，需要人工叫时仍要能叫
	const nudged = game.nudge();
	const nudgedDm = nudged.effects.find((effect) => effect.type === 'dm');
	assert.equal(nudgedDm.sessionId, humanSession);
	assert.equal(nudgedDm.wake, false, '催真人一律不唤醒其会话');

	// ③ 他发言之后链照常推进，但同样不私聊提醒
	const spoke = game.onRoomMessage({ authorSessionId: humanSession, text: '【R1-1 · 甲】我先说。' });
	assert.equal(spoke.filter((effect) => effect.type === 'dm' && effect.sessionId === humanSession).length, 0, '轮次推进也不该私聊提醒真人');
	assert.equal(spoke.some((effect) => effect.type === 'audit' && effect.record.type === 'human-turn-ping'), false, '不该再写 human-turn-ping 审计');
});

test('speak：前缀、房间归属与提及全由庄家算（模型只给正文）', () => {
	const game = toDay();
	const intent = game.speak('s0', '  我先把结论放前面。  ');
	assert.equal(intent.ok, true);
	assert.equal(intent.text, '【R1-1 · 甲】我先把结论放前面。');
	assert.equal(intent.author, 's0');
	assert.equal(intent.authorAlias, '甲');
	assert.deepEqual(intent.mentions, ['all', '乙']);
	assert.deepEqual([intent.round, intent.index, intent.seat, intent.name, intent.next, intent.final], [1, 1, 1, '甲', '乙', false]);
	// 生成的正文必须能被自家的解析器原样认回来（同格式闭环）
	assert.deepEqual(parseSpeechPrefix(intent.text), { round: 1, index: 1, alias: '甲', body: '我先把结论放前面。' });
});

test('speak：第 1 轮末位负责唤醒第 2 轮首位（跨轮循环，不是"没下一位"）', () => {
	const game = toDay();
	game.round = 1;
	game.position = 3;                      // 第 4 位 = 本轮末位
	const intent = game.speak('s3', '末位发言');
	assert.equal(intent.ok, true);
	assert.equal(intent.index, 4);
	assert.equal(intent.final, false, '第 1 轮末位不是全局最后一位');
	assert.deepEqual(intent.mentions, ['all', '甲'], '跨轮唤醒第 2 轮首位');
	assert.equal(intent.next, '甲');
});

test('v1.21.0：第 5 轮末位（全场最后一位）的发言**唤醒全员**（收尾信号）', () => {
	const game = toDay();
	game.round = 5;
	game.position = 3;
	const intent = game.speak('s3', '收官发言');
	assert.equal(intent.ok, true);
	assert.equal(intent.final, true);
	assert.deepEqual(intent.mentions, ['all', '甲', '乙', '丙', '丁'], '★ 收尾发言召集全员（不再只 @all —— 之后庄家要问"是否进入投票"）');
	assert.equal(intent.next, null);
});

test('speak：下一位是真人 ⇒ 只 @all（点名对真人无效）', () => {
	const game = makeGame({ roles: [ROLES.SEER, ROLES.WOLF, ROLES.TRICKSTER, ROLES.VILLAGER] });
	game.players[2].human = true;           // 丙 = 真人
	game.start();
	game.onPrivateReply({ sessionId: 's0', text: '2' });
	game.onPrivateReply({ sessionId: 's2', text: '不换' });
	assert.equal(game.phase, PHASE.DAY);
	game.position = 1;                      // 乙 发言，下一位是丙（真人）
	const intent = game.speak('s1', '正文');
	assert.equal(intent.ok, true);
	assert.deepEqual(intent.mentions, ['all']);
	assert.equal(intent.next, null);
});

test('speak：抢跑 / 阶段不对 / 不在名单 / 空正文 —— 一律拒绝且不动状态', () => {
	const game = toDay();
	const before = game.position;

	const early = game.speak('s1', '我抢先说');
	assert.equal(early.ok, false);
	assert.match(early.reason, /还没轮到你/);
	assert.match(early.reason, /现在应由 甲 发言（第 1 轮第 1 位）/);
	assert.equal(early.text, undefined, '被拒绝时不给正文');
	assert.equal(game.position, before, '被拒绝不改链');

	const outsider = game.speak('s9', '我是路人');
	assert.equal(outsider.ok, false);
	assert.match(outsider.reason, /不在本局玩家名单里/);

	const blank = game.speak('s0', '   ');
	assert.equal(blank.ok, false);
	assert.match(blank.reason, /正文不能为空/);

	const late = game.speak('s0', '迟到的发言');
	assert.equal(late.ok, true, '轮到的人可以发');

	// v1.15.1（用户 2026-10-05）：投票阶段**不再拒** wolf_speak —— 它被当成「投票」交上去
	// （正文原样、不加发言前缀、提及只给 all；发进房间后照旧由 parseVote 收票）。
	game.position = 0;
	game.phase = PHASE.VOTE;
	const asVote = game.speak('s0', '  投票：乙  ');
	assert.equal(asVote.ok, true, '投票阶段认这个工具（兜底 AI 用顺手了搞错命令）');
	assert.equal(asVote.kind, 'vote');
	assert.equal(asVote.text, '投票：乙', '★ 不加 `【R…】` 前缀（原文原样，才能被 parseVote 认）');
	assert.deepEqual(asVote.mentions, ['all'], '投票不唤醒谁');
	assert.equal(asVote.author, 's0');
	assert.equal(asVote.next, null);
	assert.equal(game.parseVote(asVote.text).target, 2, '★ 产出直接就是一张可解析的票');
	// 空正文 / 不在名单 在投票阶段同样拒
	assert.match(game.speak('s0', '   ').reason, /投票正文不能为空/);
	assert.match(game.speak('s9', '投票：乙').reason, /不在本局玩家名单里/);

	// v1.18.0（用户 2026-10-06）：**首投落定** —— 票落定之后 wolf_speak 连房间都到不了
	// （必须在投递前挡：否则房间会多出第二只气泡），内容不同/认不出一律拒，且不再有"请重发"。
	game.votes.set('s0', { target: 2, raw: '投票：乙', at: 0, seq: 1 });
	const resend = game.speak('s0', '投票：乙');
	assert.equal(resend.ok, false, '★ 已落定 ⇒ 不投递');
	assert.equal(resend.locked, true);
	assert.equal(resend.same, true, '同内容 = 幂等回执');
	assert.match(resend.reason, /本票已落定，重发不覆盖/);
	assert.equal(resend.text, undefined, '被拒时不给正文（没有可投的东西）');

	const change = game.speak('s0', '投票：丙');
	assert.equal(change.ok, false);
	assert.equal(change.same, false);
	assert.match(change.reason, /本票已落定，不可撤改/);
	assert.match(game.speak('s0', '我看不出来投谁').reason, /本票已落定，不可撤改/, '认不出的也一律已落定');
	game.votes.delete('s0');

	// 真·阶段不对（夜间）仍然拒
	game.phase = PHASE.NIGHT;
	const atNight = game.speak('s0', '夜里想发言');
	assert.equal(atNight.ok, false);
	assert.match(atNight.reason, /不是发言阶段/);
});

// ---------------------------------------------------------------- v1.10.0：发言框接管的口径

test('speechPlan()：轮到真人时给出这一棒的规范形态（前缀 / 下一位 / 提及）', () => {
	const game = toDay();
	game.players[0].human = true;                       // 甲 = 真人，且现在是第 1 轮第 1 位
	const plan = game.speechPlan();
	assert.equal(plan.seat, 1);
	assert.equal(plan.name, '甲');
	assert.equal(plan.human, true);
	assert.equal(plan.round, 1);
	assert.equal(plan.index, 1);
	assert.equal(plan.prefix, '【R1-1 · 甲】');
	assert.deepEqual(plan.mentions, ['all', '乙'], '一般席位 = @all + 下一位');
	assert.equal(plan.next, '乙');
	assert.equal(plan.final, false);

	// 与 speak() 产出的规范版逐字一致 —— 前缀与提及只有一份算法（#speechShape）
	const intent = game.speak('s0', '正文');
	assert.equal(intent.ok, true);
	assert.equal(intent.text, `${plan.prefix}正文`);
	assert.deepEqual(intent.mentions, plan.mentions);
	assert.equal(intent.round, plan.round);
	assert.equal(intent.index, plan.index);
});

test('speechPlan()：不是「白天 + 轮到真人」时一律 null', () => {
	// 白天，但轮到 AI（把他的那一棒走完，期望发言者变成乙）
	const day = toDay();
	day.players[0].human = true;
	day.onRoomMessage({ authorSessionId: 's0', text: '【R1-1 · 甲】我先说。' });
	assert.equal(day.expectedSpeaker().name, '乙');
	assert.equal(day.speechPlan(), null, '轮到 AI ⇒ 不接管（AI 走 wolf_speak）');

	// 暂停 / 已终止
	const paused = toDay();
	paused.players[0].human = true;
	paused.paused = true;
	assert.equal(paused.speechPlan(), null, '暂停 ⇒ 不接管');

	const ended = toDay();
	ended.players[0].human = true;
	ended.playable = false;
	assert.equal(ended.speechPlan(), null, '已终止 ⇒ 不接管');

	// 夜间（还没走夜序）
	const night = makeGame({ roles: [ROLES.SEER, ROLES.WOLF, ROLES.TRICKSTER, ROLES.VILLAGER] });
	night.players[0].human = true;
	night.start();
	assert.equal(night.phase, PHASE.NIGHT);
	assert.equal(night.speechPlan(), null, '不是白天 ⇒ 不接管');

	// 白天但场上一个真人都没有
	const allAi = toDay();
	assert.equal(allAi.speechPlan(), null, '没有真人席位 ⇒ 不接管');
});

test('speechPlan()：末位与「下一位是真人」时只 @all（不点名）', () => {
	// 第 5 轮末位：没有下一棒
	const last = toDay();
	last.round = 5;
	last.position = last.players.length - 1;
	last.players[3].human = true;                       // 末位（丁）是真人
	const plan = last.speechPlan();
	assert.equal(plan.index, 4);
	assert.equal(plan.prefix, '【R5-4 · 丁】');
	assert.deepEqual(plan.mentions, ['all', '甲', '乙', '丙'], 'v1.21.0：末位发言召集全员（真人绝不点名 ⇒ 不含丁）');
	assert.equal(plan.next, null);
	assert.equal(plan.final, true);

	// 下一位是真人：点名对真人无效（还可能把发言发废），只 @all —— 他靠房间发言框上的前缀条知道轮到自己
	const nextHuman = toDay();
	nextHuman.players[0].human = true;                  // 甲（第 1 位）是真人
	nextHuman.players[1].human = true;                  // 乙（下一位）也是真人
	const plan2 = nextHuman.speechPlan();
	assert.deepEqual(plan2.mentions, ['all'], '下一位是真人 ⇒ 只 @all');
	assert.equal(plan2.next, null);
	assert.equal(plan2.final, false);
});
