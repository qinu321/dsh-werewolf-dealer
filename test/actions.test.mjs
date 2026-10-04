// v1.12.0：房间发言框上的「开局 / 真人 / 随机」（dsh-chat 补丁 22 的动作条）。
//
// 用户 2026-10-04 的需求：
//   1. 点「开局」= 按房间**当前成员数**开一局纯 AI 狼人杀（少于 3 人拒绝）；
//   2. 勾「真人」= 再追加一个真人玩家（名字来自配置 `humanName`，默认「玩家」）；
//   3. 勾「随机」= 不按加入顺序，随机排全体玩家（含真人）的发言顺序。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Harness, makeTempDir } from './helpers.mjs';

/** 建一个「房间里有 N 个 AI 成员」的测试台（成员顺序 = 传入顺序 = 加入顺序）。 */
function harness(names, options = {}) {
	const nonce = randomUUID().slice(0, 6);
	const players = names.map((name) => ({ name: `${name}${nonce}`, sessionId: `session-${randomUUID()}` }));
	const h = new Harness({
		players,
		stateDir: join(makeTempDir('werewolf-actions'), 'state'),
		exportDir: join(makeTempDir('werewolf-actions-export'), 'raw'),
		...(options.config === undefined ? {} : { config: options.config }),
		...(options.hasConsume === undefined ? {} : { hasConsume: options.hasConsume })
	});
	return { h, names: players.map((player) => player.name), nonce };
}
/** 唯一的局 id（测试里只会有一局）。 */
const gameIdOf = (h, suffix = '.json') => h.readdirState().find((name) => name.endsWith(suffix))?.slice(0, -suffix.length);
/** 局里的座位顺序（= 发言顺序）。 */
const seatOrder = (h, gameId) => h.readState(gameId).players.map((player) => `${player.name}${player.human ? '(真人)' : ''}`);

test('v1.12.0：动作条声明 —— 开局/真人/随机，只在没有进行中的对局时提供', async () => {
	const { h, names } = harness(['甲', '乙', '丙']);
	try {
		const actions = await h.composerActions();
		assert.deepEqual(actions.map((action) => action.id), ['start', 'human', 'random'], '三个控件的顺序');
		assert.deepEqual(actions.map((action) => action.kind), ['button', 'toggle', 'toggle']);
		assert.deepEqual(actions.map((action) => action.label), ['开局', '真人', '随机'], '标签是给人看的短词');
		assert.equal(actions[1].value, false, '「真人」默认不勾（点一下就是纯 AI 局）');
		assert.equal(actions[2].value, false, '「随机」默认不勾（按加入顺序）');
		assert.match(actions[0].hint, new RegExp(`3 个可用成员`), actions[0].hint);
		assert.match(actions[1].hint, /玩家/, '「真人」的说明里带上配置的玩家名');
		assert.equal(actions[1].disabled, false, '能力齐备时不该是禁用状态');
		assert.equal((await h.composerRule()).prefix ?? '', '', '还没开局 ⇒ 没有发言前缀条');

		// 一键开局后再看：控件收起来（房间里已有对局）
		const started = await h.pressAction('start', {});
		await h.flush();
		assert.equal(started.ok, true, started.text);
		assert.deepEqual(await h.composerActions(), [], '已有进行中的对局 ⇒ 不再提供开局控件');
		assert.ok(names.length === 3);
	} finally {
		h.dispose();
	}
});

test('v1.12.0：点「开局」= 按房间当前的 N 个成员开一局纯 AI（顺序 = 加入顺序）', async () => {
	const { h, names } = harness(['甲', '乙', '丙']);
	try {
		const result = await h.pressAction('start', {});
		await h.flush();
		assert.equal(result.ok, true, result.text);
		const gameId = gameIdOf(h);
		assert.deepEqual(seatOrder(h, gameId), names, '★ 发言顺序 = 成员加入顺序');
		assert.equal(h.readState(gameId).players.some((player) => player.human === true), false, '★ 纯 AI 局：没有真人席位');
		assert.match(result.text, /3人局/, result.text);
		assert.match(result.text, new RegExp(names.join(' → ')), result.text);
		// 开局公告照旧发进房间（玩家名单按座位顺序列出，人人可见）
		assert.match(h.roomMessages.map((message) => message.text).join('\n'), new RegExp(names.join('、')), '开局公告按座位顺序列出玩家');
	} finally {
		h.dispose();
	}
});

test('v1.12.0：勾「真人」⇒ 追加一个真人玩家（名字来自配置，默认「玩家」）', async () => {
	const { h, names } = harness(['甲', '乙', '丙']);
	try {
		const result = await h.pressAction('start', { human: true });
		await h.flush();
		assert.equal(result.ok, true, result.text);
		const gameId = gameIdOf(h);
		const state = h.readState(gameId);
		assert.equal(state.players.length, 4, '3 个 AI + 1 个真人');
		const human = state.players.find((player) => player.human === true);
		assert.equal(human.name, '玩家', '★ 默认玩家名 = 玩家（可由 cordis.patch.yml 的 humanName 改）');
		assert.equal(human.sessionId, h.room.sessionId, '弹窗模式：私密信道就是房间侧身份');
		assert.deepEqual(seatOrder(h, gameId), [...names, '玩家(真人)'], '真人在最后一位（加入顺序）');
		// 真人的私密内容**不落任何会话**（内容确实进了弹窗信箱这件事，由 mailbox.test.mjs 的
		// 「跑完一整夜」用例覆盖 —— 这里不能断言信箱非空：真人若是怪盗且预言家在场，开局阶段
		// 本来就没有任何私聊，那会让这条断言随种子漂移）。
		assert.deepEqual(h.dmsTo(h.room.sessionId), [], '不往任何会话投私聊');
	} finally {
		h.dispose();
	}
});

test('v1.12.0：配置 `humanName` 改玩家名（也出现在勾选框说明里）', async () => {
	const { h } = harness(['甲', '乙', '丙'], { config: { humanName: '千野' } });
	try {
		const actions = await h.composerActions();
		assert.match(actions[1].hint, /千野/, actions[1].hint);
		const result = await h.pressAction('start', { human: true });
		await h.flush();
		assert.equal(result.ok, true, result.text);
		assert.equal(h.readState(gameIdOf(h)).players.find((player) => player.human).name, '千野');
		assert.match(result.text, /千野（真人）/, result.text);
	} finally {
		h.dispose();
	}
});

test('v1.12.0：勾「随机」⇒ 发言顺序被打乱（固定 Math.random 后是确定的）', async () => {
	const { h, names } = harness(['甲', '乙', '丙']);
	try {
		const savedRandom = Math.random;
		Math.random = () => 0;                 // Fisher–Yates 每步都与首位交换 ⇒ 顺序确定
		try {
			const result = await h.pressAction('start', { random: true });
			await h.flush();
			assert.equal(result.ok, true, result.text);
			const randomOrder = seatOrder(h, gameIdOf(h));
			assert.deepEqual(randomOrder, [names[1], names[2], names[0]], '★ 随机顺序 ≠ 加入顺序（且是确定的置换）');
			assert.match(result.text, /随机顺序/, result.text);
		} finally { Math.random = savedRandom; }
	} finally {
		h.dispose();
	}

	// 对照组：不勾「随机」时顺序就是加入顺序（同一次运行里两局分开建台）
	const control = harness(['甲', '乙', '丙']);
	try {
		await control.h.pressAction('start', {});
		await control.h.flush();
		assert.deepEqual(seatOrder(control.h, gameIdOf(control.h)), control.names, '对照：默认按加入顺序');
	} finally {
		control.h.dispose();
	}
});

test('v1.12.0：人数规则 —— 少于 3 人拒绝（但勾上真人就够 3 人）；5/6 人可用；7 人及以上拒绝', async () => {
	const two = harness(['甲', '乙']);
	try {
		const refused = await two.h.pressAction('start', {});
		assert.equal(refused.ok, false);
		assert.match(refused.text, /凑不齐 3 个人/, refused.text);
		assert.match(refused.text, /2 个可用成员/, refused.text);
		assert.match(refused.text, /勾上「真人」就是 3 人局/, '要给出可执行的出路');
		assert.equal(gameIdOf(two.h), undefined, '被拒绝时不该建出对局');

		const ok = await two.h.pressAction('start', { human: true });
		await two.h.flush();
		assert.equal(ok.ok, true, ok.text);
		assert.equal(two.h.readState(gameIdOf(two.h)).players.length, 3, '2 个 AI + 真人 = 3 人局');
	} finally {
		two.h.dispose();
	}

	// v1.13.0：5 / 6 人局现在都开得起来（牌堆 = 人数 + 2、村民 = 人数 − 2）
	for (const count of [5, 6]) {
		const multi = harness(['甲', '乙', '丙', '丁', '戊', '己'].slice(0, count));
		try {
			const result = await multi.h.pressAction('start', {});
			await multi.h.flush();
			assert.equal(result.ok, true, `${count} 人局：${result.text}`);
			const gameId = gameIdOf(multi.h);
			assert.equal(multi.h.readState(gameId).players.length, count, `${count} 人局座位数`);
			assert.match(result.text, new RegExp(`${count}人局`), result.text);
			assert.match(result.text, new RegExp(multi.names.join(' → ')), `顺序仍是加入顺序（${count} 人）`);
		} finally {
			multi.h.dispose();
		}
	}

	// 7 人及以上没有规则 ⇒ 拒绝
	const seven = harness(['甲', '乙', '丙', '丁', '戊', '己', '庚']);
	try {
		const tooMany = await seven.h.pressAction('start', {});
		assert.equal(tooMany.ok, false);
		assert.match(tooMany.text, /支持 3–6 人局/, tooMany.text);
		assert.match(tooMany.text, /7 人及以上还没有规则/, tooMany.text);
		assert.equal(gameIdOf(seven.h), undefined, '被拒绝时不该建出对局');

		const withHuman = await seven.h.pressAction('start', { human: true });
		assert.equal(withHuman.ok, false, '7 个 AI + 真人更超编');
	} finally {
		seven.h.dispose();
	}
});

test('v1.12.0：已有进行中的对局 ⇒ 再点开局被拒绝（并告诉你先终止）', async () => {
	const { h } = harness(['甲', '乙', '丙']);
	try {
		assert.equal((await h.pressAction('start', {})).ok, true);
		await h.flush();
		const again = await h.pressAction('start', {});
		assert.equal(again.ok, false);
		assert.match(again.text, /已有进行中的对局/, again.text);
		assert.match(again.text, /ww-end/, '要写清出路');
	} finally {
		h.dispose();
	}
});

test('v1.12.0：缺 dsh-chat 补丁 21 ⇒ 「真人」勾选框禁用，但纯 AI 局照常能开', async () => {
	const ai = harness(['甲', '乙', '丙'], { hasConsume: false });
	try {
		const actions = await ai.h.composerActions();
		assert.equal(actions[1].disabled, true, '★ 加入真人需要「吞掉」能力（弹窗模式）⇒ 禁用');
		assert.match(actions[1].hint, /补丁 21/, actions[1].hint);
		const refused = await ai.h.pressAction('start', { human: true });
		assert.equal(refused.ok, false);
		assert.match(refused.text, /补丁 21/, refused.text);

		const ok = await ai.h.pressAction('start', {});
		await ai.h.flush();
		assert.equal(ok.ok, true, '★ 纯 AI 局不依赖补丁 21，照常能开');
		assert.equal(ai.h.readState(gameIdOf(ai.h)).players.length, 3, '3 人局');
	} finally {
		ai.h.dispose();
	}
});

test('v1.12.0：会话已归档/不存在的成员被跳过，并如实回报', async () => {
	const { h, names } = harness(['甲', '乙', '丙']);
	try {
		// 房间里多一个「幽灵」成员（不是任何已知会话 ⇒ dshBridge.status 判 missing）
		h.room.members.push({ kind: 'session', sessionId: 'session-ghost', alias: '幽灵' });
		const actions = await h.composerActions();
		assert.match(actions[0].hint, /3 个可用成员/, '幽灵不算可用成员');

		const result = await h.pressAction('start', {});
		await h.flush();
		assert.equal(result.ok, true, result.text);
		assert.deepEqual(seatOrder(h, gameIdOf(h)), names, '开局用的是那 3 个可用成员');
		assert.match(result.text, /已跳过 幽灵/, result.text);
	} finally {
		h.dispose();
	}
});

test('v1.12.0：未知动作 id ⇒ 明确拒绝（不静默）', async () => {
	const { h } = harness(['甲', '乙', '丙']);
	try {
		const result = await h.pressAction('bogus', {});
		assert.equal(result.ok, false);
		assert.match(result.text, /未知的房间操作：bogus/, result.text);
	} finally {
		h.dispose();
	}
});
