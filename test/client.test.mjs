/**
 * 客户端半边（`client.js`）的离线回归测试。
 *
 * 客户端半边以前只有"临时脚本 + 人眼"验过，于是两个真机 bug 溜了过去：
 *   ① `askTrickster` 的死占位符 `{座位}`（模板正文错了，断言却是自引用）；
 *   ② 会唤醒会话的消息被画两遍（官方 `turn-trigger` 行 + 我们的卡片）。
 * 所以这里把**匹配规则**（尤其是 `surfaceOp === 'append'` 这条去重判据）与**渲染**都钉住。
 *
 * 做法：把 `client.js` 当模块加载，捕获它注册进 `window.__ModuleLoader__` 的工厂，
 * 配最小 React 存根跑 `apply(ctx)`，再直接调定义里的函数与组件。
 * 运行：`node --test "test/*.test.mjs"`。
 *
 * @module dsh-werewolf-dealer/test/client.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------- 最小 React 存根

const h = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } });
class Component {
	constructor(props) {
		this.props = props;
		this.state = {};
	}
	setState(next) {
		this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) };
	}
}
// v1.11.0：弹窗浮层用到了 hooks —— 给最小存根补上（与 dsh-chat 那些客户端套件同一套写法：
// 每次渲染把 cursor 归零，槽位跨渲染保留）。
let hookSlots = [];
let hookCursor = 0;
const resetHooks = () => { hookSlots = []; hookCursor = 0; };
/** 跑掉挂载时注册的清理函数（弹窗的轮询定时器靠它停 —— 否则测试进程退不出去）。 */
const runCleanups = () => { for (const slot of hookSlots) if (typeof slot?.cleanup === 'function') slot.cleanup(); };
const reactStub = {
	createElement: h,
	Component,
	useState: (init) => {
		const at = hookCursor++;
		if (hookSlots.length <= at) hookSlots[at] = { kind: 'state', value: typeof init === 'function' ? init() : init };
		return [hookSlots[at].value, (next) => { hookSlots[at].value = typeof next === 'function' ? next(hookSlots[at].value) : next; }];
	},
	useEffect: (fn) => {
		const at = hookCursor++;
		if (hookSlots.length > at) return;      // deps 为 [] ⇒ 挂载时跑一次即可
		hookSlots[at] = { kind: 'effect', cleanup: fn() };
	},
	useRef: (init) => {
		const at = hookCursor++;
		if (hookSlots.length <= at) hookSlots[at] = { kind: 'ref', value: { current: init } };
		return hookSlots[at].value;
	}
};

/** 捕获 `window.__ModuleLoader__.load` 的注册（必须在 import client.js 之前就位）。 */
let registration;
globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value; } } };
await import('../client.js');

/** 挂上 ctx，返回注册出来的定义/槽位/字典。
 *
 * v2.0.0：`client.js` 已合并群聊半边，所以这里的假 ctx 要同时满足两边的 apply：
 * `sessions`/`workspaces`（房间成员面板用）、`conversation.composer` 槽位、两份事件定义与两套 i18n。
 */
function mount() {
	const captured = { slots: [], definitions: new Map(), locales: new Map() };
	const ctx = {
		effect(body, label) {
			const dispose = body();
			// 群聊半边的样式注入在 Node 下是 no-op（`typeof document === 'undefined'`）⇒ 允许没有 disposer；
			// 其余 effect（订阅、槽位）必须有，否则清理链就是断的 —— 这条守卫留给庄家半边与真订阅。
			if (!String(label ?? '').startsWith('dsh-chat:')) {
				assert.equal(typeof dispose, 'function', `effect ${label} 必须返回 disposer`);
			}
			return typeof dispose === 'function' ? dispose : () => {};
		},
		locale: {
			bind: (ns) => (key) => captured.locales.get(ns)?.['zh']?.[key] ?? key,
			register: (ns, dicts) => {
				captured.locales.set(ns, dicts);
				return () => {};
			},
			getLocale: () => ({ active: 'zh' })
		},
		uiConversation: { events: { register: (value) => { captured.definitions.set(value.kind, value); return () => {}; } } },
		slots: {
			inject: (name, callback) => {
				assert.equal(['conversation.chat.node', 'conversation.composer', 'shell.overlay', 'settings.section'].includes(name), true, `意外的槽位：${name}`);
				return callback();
			},
			register: (options, component) => {
				captured.slots.push({ options, component });
				return () => {};
			}
		},
		sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
		workspaces: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
		connection: {}
	};
	const mod = registration.factory((name) => {
		assert.equal(name, 'react', '客户端半边只能 require react —— 不能 import 任何 Harness 客户端包');
		return reactStub;
	});
	mod.apply(ctx);
	const findSlot = (name, key) => captured.slots.find((entry) => entry.options.name === name && entry.options.key === key);
	const findOverlay = (id) => captured.slots.find((entry) => entry.options.name === 'shell.overlay' && entry.options.id === id);
	return {
		mod,
		...captured,
		definition: captured.definitions.get('werewolf-dealer-mail'),
		slot: findSlot('conversation.chat.node', 'werewolf-dealer-mail'),
		overlay: findOverlay('dsh-werewolf-dealer-mail'),
		localeNs: 'dsh-werewolf-dealer',
		dicts: captured.locales.get('dsh-werewolf-dealer')
	};
}

/** 造一条"庄家私聊"事件。 */
function mailEvent(text, overrides = {}) {
	return {
		type: 'user/message',
		time: 1_700_000_000_000,
		seq: 42,
		surfaceOp: 'append',
		data: {
			id: 'g1:7',
			source: { kind: 'plugin:dsh-werewolf-dealer', form: 'relay' },
			content: [{ type: 'text', text: `[dsh-bridge werewolf message g1:7 from werewolf-dealer]\n${text}` }]
		},
		...overrides
	};
}

/** 递归收集渲染树里的文本。 */
function collectText(node, out = []) {
	if (node === null || node === undefined || node === false) return out;
	if (typeof node === 'string' || typeof node === 'number') {
		out.push(String(node));
		return out;
	}
	if (Array.isArray(node)) {
		for (const item of node) collectText(item, out);
		return out;
	}
	collectText(node?.props?.children, out);
	return out;
}

// ---------------------------------------------------------------- 注册形状

test('客户端半边：注册形状（模块 id / inject 并集 / 两个槽位 / 两本字典）', () => {
	assert.ok(registration, 'client.js 必须调用 window.__ModuleLoader__.load');
	assert.equal(registration.id, 'dsh-werewolf-dealer', '模块 id 必须等于包名');
	const { mod, definition, slot, overlay, localeNs, dicts } = mount();
	assert.equal(typeof mod.apply, 'function');
	// v2.0.0：并集 = chat 的 inject（前六项）+ dealer 的（无新增）
	assert.deepEqual(mod.inject, ['slots', 'connection', 'uiConversation', 'sessions', 'workspaces', 'locale']);
	assert.equal(definition.kind, 'werewolf-dealer-mail');
	assert.equal(definition.target, 'chat');
	assert.equal(definition.publication(), 'immediate');
	assert.deepEqual(slot.options, { name: 'conversation.chat.node', key: 'werewolf-dealer-mail' });
	// v1.11.0：第二个槽位 —— 帧级浮层（弹窗）
	assert.equal(overlay.options.name, 'shell.overlay');
	assert.equal(overlay.options.id, 'dsh-werewolf-dealer-mail');
	assert.equal(typeof overlay.options.label, 'function');
	assert.equal(typeof overlay.component, 'function');
	assert.equal(localeNs, 'dsh-werewolf-dealer');
	assert.deepEqual(Object.keys(dicts).sort(), ['en', 'zh']);
	assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort(), '两本字典的键必须一一对应');
});

test('客户端半边：群聊半边也在同一模块里（两条事件定义 + 房间/广播节点 + 发言框 + 自己的字典）', () => {
	const { definitions, slots, locales } = mount();
	assert.equal(definitions.get('dsh-chat-room')?.target, 'chat', '房间时间线的事件定义要注册');
	assert.equal(definitions.get('dsh-chat-broadcast')?.target, 'chat', '静默广播的卡片定义要注册');
	for (const key of ['dsh-chat-room', 'dsh-chat-broadcast']) {
		assert.ok(slots.some((entry) => entry.options.name === 'conversation.chat.node' && entry.options.key === key), `缺少节点渲染器 ${key}`);
	}
	assert.ok(slots.some((entry) => entry.options.name === 'conversation.composer'), '房间发言框（conversation.composer）要注册');
	assert.deepEqual(Object.keys(locales.get('dsh-chat')).sort(), ['en', 'zh'], '群聊那套 i18n 不能被庄家的覆盖掉');
	assert.notEqual(locales.get('dsh-chat'), locales.get('dsh-werewolf-dealer'), '两套字典必须是两份对象');
});

test('客户端半边：设置页注册（settings.section，id=werewolf）', () => {
	const { slots } = mount();
	const section = slots.find((entry) => entry.options.name === 'settings.section');
	assert.ok(section, '没有注册 settings.section ⇒ 侧栏「设置」里就没有这一项');
	assert.equal(section.options.id, 'werewolf');
	assert.equal(typeof section.options.label, 'function');
	assert.equal(typeof section.component, 'function');
});

// ---------------------------------------------------------------- 匹配规则（本文件的核心）

test('客户端半边：match 只看来源与类型；「官方会不会自己画」交给 start 判（v1.16.12）', () => {
	const { definition } = mount();
	// 认：自己的 producer kind —— **不再在 match 里看 surfaceOp**（判定挪到 start，那里能读 inbox claim 状态）
	assert.deepEqual(definition.match(mailEvent('你好')), { id: 'g1:7', role: 'start' });
	assert.deepEqual(
		definition.match(mailEvent('你好', { surfaceOp: undefined })),
		{ id: 'g1:7', role: 'start' },
		'v1.16.12：静默投递（dsh-bridge 的 inject）落盘时没有 surfaceOp，也要进候选'
	);
	// 不认：别人来源 / 非 user-message / 缺 source（且不得抛）
	assert.equal(definition.match(mailEvent('你好', { data: { ...mailEvent('你好').data, source: { kind: 'plugin:dsh-bridge' } } })), null);
	assert.equal(definition.match(mailEvent('你好', { data: { ...mailEvent('你好').data, source: { kind: 'user' } } })), null);
	assert.equal(definition.match(mailEvent('你好', { type: 'assistant/message' })), null);
	assert.equal(definition.match({ type: 'user/message', surfaceOp: 'append', data: { id: 'x' } }), null);
});

test('客户端半边：start 按 inbox claim 判定「该不该由我们画」（v1.16.12）', () => {
	const { definition } = mount();
	const ID = 'g1:7';
	/** 假 reader：按 kind 返回"当前 claim"集合（= 官方 inbox 节点状态）。 */
	const readerWith = ({ step = [], turn = [] } = {}) => ({
		previous: (kind) => {
			if (kind === 'inbox-next-step') return { state: { currentClaimed: new Set(step) } };
			if (kind === 'inbox-next-turn') return { state: { currentClaimed: new Set(turn) } };
			return undefined;
		}
	});
	// ① 落表面（append）⇒ 照旧画，不依赖 reader（向后兼容）
	assert.equal(definition.start({}, { event: mailEvent('正文') })?.text, '正文');
	// ② 非表面 + 被 next-step claim ⇒ **画**（本次要救的：静默投递的消息窗口；官方 match 要求 append，故官方不渲染）
	const injected = mailEvent('静默投递', { surfaceOp: undefined });
	assert.equal(definition.start({}, { event: injected }, readerWith({ step: [ID] }))?.text, '静默投递');
	// ③ 非表面 + 被 next-turn claim ⇒ 不画（官方渲染 turn-trigger，防双气泡）
	assert.equal(definition.start({}, { event: injected }, readerWith({ turn: [ID] })), null);
	// ④ 非表面 + reader 读不到（老版本 / 官方改了 kind 名 / 尚未 claim）⇒ 保守不画
	assert.equal(definition.start({}, { event: injected }, undefined), null);
	assert.equal(definition.start({}, { event: injected }, readerWith({})), null);
	assert.equal(definition.start({}, { event: injected }, { previous: () => { throw new Error('boom'); } }), null, 'reader 抛错也不能崩');
	// ⑤ 唤醒类优先：即使落表面，只要被 next-turn claim 就不画（防御性：真实世界 append 不会被 next-turn claim）
	assert.equal(definition.start({}, { event: mailEvent('唤醒') }, readerWith({ turn: [ID] })), null);
});

// ---------------------------------------------------------------- start / buildViewNode

test('客户端半边：start 剥掉桥接信封且容错；buildViewNode 自报可见', () => {
	const { definition } = mount();
	assert.equal(definition.start({}, { event: mailEvent('你的角色卡是狼。') }).text, '你的角色卡是狼。');
	// 多行正文只剥第一行；假装封但没闭合方括号时不误剥；没有 text 块 ⇒ 空串
	assert.equal(definition.start({}, { event: mailEvent('第一行\n第二行') }).text, '第一行\n第二行');
	const tricky = mailEvent('x');
	tricky.data.content = [{ type: 'text', text: '[dsh-bridge 不是信封\n正文' }];
	assert.equal(definition.start({}, { event: tricky }).text, '[dsh-bridge 不是信封\n正文');
	const empty = mailEvent('x');
	empty.data.content = undefined;
	assert.equal(definition.start({}, { event: empty }).text, '');

	const state = definition.start({}, { event: mailEvent('正文') });
	const view = definition.buildViewNode({ key: 'k1', kind: 'werewolf-dealer-mail', id: 'g1:7', state, start: { event: { seq: 42 } } });
	assert.equal(view.visibility, 'visible', '必须显式 visible，否则会被 isVisibleChatNode 排除');
	assert.deepEqual(view.location, { kind: 'unresolved' }, '不参与回合折叠');
	assert.equal(view.anchorSeq, 42);
	assert.equal(view.target, 'chat');
	assert.equal(definition.buildViewNode({ key: 'k1', state: undefined, start: { event: { seq: 1 } } }), null);
	assert.equal(definition.update({ state }), state);
});

// ---------------------------------------------------------------- 渲染

test('客户端半边：卡片渲染出标题/正文/回复提示，且不含桥接信封', () => {
	const { definition, slot } = mount();
	// 本用例只验渲染：正文用中性文本，不绑定发牌模板（模板改了不该让渲染用例跟着红）
	const body = '你的角色卡是狼。这局你没有同伴。本条无需回复。';
	const state = definition.start({}, { event: mailEvent(body) });
	const view = definition.buildViewNode({ key: 'k1', kind: 'werewolf-dealer-mail', id: 'g1:7', state, start: { event: { seq: 42 } } });
	const tree = slot.component({ node: view });
	assert.equal(tree.type.name, 'MailBoundary', '卡片必须包在错误边界里');
	const text = collectText(tree).join('\n');
	assert.equal(text.includes('庄家私聊'), true, '要有标题');
	assert.equal(text.includes(body), true, '要有正文');
	assert.equal(text.includes('/ww-reply'), true, '要有回复提示');
	assert.equal(text.includes('[dsh-bridge'), false, '不显示桥接信封');
	// 错误边界降级：渲染炸了也必须留下纯文本
	const boundary = new tree.type({ text: '正文', children: null });
	boundary.state = { failed: true };
	assert.equal(boundary.render().props.children, '正文');
	// 坏数据不抛
	assert.ok(slot.component({ node: undefined }) !== null);
	assert.equal(collectText(slot.component({ node: { data: { id: 1, time: 'x', text: 42 } } })).join('').includes('42'), true);
});

// ---------------------------------------------------------------- 弹窗浮层（v1.11.0）

/** 在渲染树里找第一个按钮。 */
function findButton(node) {
	if (node === null || node === undefined || typeof node === 'string') return undefined;
	if (Array.isArray(node)) {
		for (const item of node) {
			const hit = findButton(item);
			if (hit !== undefined) return hit;
		}
		return undefined;
	}
	if (node.type === 'button') return node;
	return findButton(node?.props?.children);
}

/** v1.14.0：收集渲染树里的**全部**按钮（提问卡的选项按钮；v1.31.0 起必答卡不再有底部「知道了」）。 */
function findButtons(node, out = []) {
	if (node === null || node === undefined || typeof node === 'string') return out;
	if (Array.isArray(node)) {
		for (const item of node) findButtons(item, out);
		return out;
	}
	if (node.type === 'button') out.push(node);
	findButtons(node?.props?.children, out);
	return out;
}

test('客户端半边：弹窗浮层 —— 只拉未读、点「知道了」才推进游标', async () => {
	const savedFetch = globalThis.fetch;
	const savedStorage = globalThis.localStorage;
	// `AbortSignal.timeout(15s)` 的定时器会把测试进程吊住 15 秒 —— 换成不带定时器的等价物。
	const savedTimeout = AbortSignal.timeout;
	AbortSignal.timeout = () => new AbortController().signal;
	const store = new Map();
	const calls = [];
	let payload = { records: [], seq: 0, more: false };
	let failNext = false;
	globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
	globalThis.fetch = async (url, init) => {
		calls.push({ url, body: JSON.parse(init.body) });
		if (failNext) throw new Error('连不上');
		return { ok: true, json: async () => ({ ok: true, value: payload }) };
	};
	try {
		const { overlay } = mount();
		/** 渲染一次（hook 游标归零、槽位保留 —— 与真实 React 的重渲染同构）。 */
		const render = () => { hookCursor = 0; return overlay.component({}); };
		/** 挂载一次浮层、等那次 fetch 落地、返回渲染树（等价于「刷新页面」）。 */
		const round = async (next) => {
			runCleanups();
			resetHooks();
			payload = next;
			render();
			await new Promise((resolve) => setTimeout(resolve, 5));
			return render();
		};

		const first = await round({ records: [{ seq: 3, at: 1_700_000_000_000, gameId: 'g1', room: '测试房', to: 's', kind: 'dealer', text: '你是预言家。请选择要查验的座位。' }], seq: 3, more: false });
		assert.equal(calls[0].url, '/api/dsh-werewolf', '走的是本插件自己的端点');
		assert.deepEqual(calls[0].body, { endpoint: 'inbox', args: { since: 0 } }, '首次从 0 开始拉');
		const firstText = collectText(first).join('\n');
		assert.equal(firstText.includes('你是预言家。请选择要查验的座位。'), true, '私密内容出现在浮层里');
		assert.equal(firstText.includes('知道了'), true, '要有确认按钮');
		assert.equal(firstText.includes('/ww-reply'), true, '要告诉他怎么回');
		assert.equal(findButtons(first).length, 1, '★ 没有 options 的卡只画「知道了」，不画选项按钮');
		// v1.16.6：浮层必须**居中**（用户 2026-10-05：右下角会与记账插件的界面打架）。
		// 正向断三件 + 负向断 right/bottom 已消失，防止以后回退到角落。
		// v1.16.11：位置改成 `calc(50% + 拖动偏移)` ⇒ 未拖动时仍是正中（几何与 v1.16.6 一致）。
		assert.equal(first.props.style.left, 'calc(50% + 0px)', '浮层水平居中（未拖动时偏移 0）');
		assert.equal(first.props.style.top, 'calc(50% + 0px)', '浮层垂直居中');
		assert.equal(first.props.style.transform, 'translate(-50%, -50%)', '用 translate 抵消自身尺寸');
		// ★ v1.16.11：背景必须是官方 **overlay** token（与"弹出来问你"的框同浓度）——
		// 旧值 `--dsw-alias-bg-layer-1` 在用户皮肤下半透明，后面全是对话、字看不清。
		assert.equal(first.props.style.background, 'var(--dsw-alias-bg-overlay)', '背景必须用 overlay token');
		assert.equal('right' in first.props.style, false, '不能再贴右边');
		assert.equal('bottom' in first.props.style, false, '不能再贴下边');
		// ★ v1.16.11：header 作拖动把手 —— 按下一段位移后位置必须跟着走，指针捕捉按需 set/release。
		const header = first.props.children.find((child) => child?.type === 'header');
		assert.ok(header, '浮层要有 header（拖动把手）');
		const captured = [];
		const fakeTarget = { setPointerCapture: (id) => captured.push(`set:${id}`), releasePointerCapture: (id) => captured.push(`release:${id}`) };
		header.props.onPointerDown({ clientX: 100, clientY: 100, pointerId: 7, currentTarget: fakeTarget });
		header.props.onPointerMove({ clientX: 160, clientY: 130 });
		const moved = render();
		assert.equal(moved.props.style.left, 'calc(50% + 60px)', '拖动后水平偏移 +60');
		assert.equal(moved.props.style.top, 'calc(50% + 30px)', '拖动后垂直偏移 +30');
		// 松手后不再跟手（起点已清空）
		header.props.onPointerUp({ pointerId: 7, currentTarget: fakeTarget });
		header.props.onPointerMove({ clientX: 900, clientY: 900 });
		const afterUp = render();
		assert.equal(afterUp.props.style.left, 'calc(50% + 60px)', '松手后不再跟手');
		assert.deepEqual(captured, ['set:7', 'release:7'], '按需捕获 / 释放指针');
		assert.equal(store.get('dsh-werewolf-dealer:mail-cursor'), undefined, '★ 还没确认 ⇒ 游标不落盘');

		// 点了「知道了」才推进游标，并把浮层收起
		findButton(first).props.onClick();
		assert.equal(store.get('dsh-werewolf-dealer:mail-cursor'), '3', '★ 点过「知道了」才把游标推进到已看过的最大序号');
		assert.equal(render(), null, '确认后浮层收起');

		// 刷新页面（重新挂载）：从已确认的游标往后拉，旧消息不再弹
		const second = await round({ records: [{ seq: 4, at: 1_700_000_001_000, gameId: 'g1', room: '测试房', to: 's', kind: 'command', text: '已代投到房间。' }], seq: 4, more: false });
		assert.deepEqual(calls.at(-1).body, { endpoint: 'inbox', args: { since: 3 } }, '★ 从上次确认过的序号往后拉');
		const secondText = collectText(second).join('\n');
		assert.equal(secondText.includes('已代投到房间。'), true, '新消息照弹');
		assert.equal(secondText.includes('你是预言家'), false, '看过的旧消息不再出现');

		// 连不上时不出声、不抛（浮层最多是没内容）
		failNext = true;
		const failed = await round({ records: [], seq: 4, more: false });
		assert.equal(failed, null, '拉不到时不该崩，也不该显示半截内容');
		assert.equal(calls.at(-1).body.args.since, 3, '失败不推进游标（下次还会重试同一条）');
		runCleanups();
	} finally {
		globalThis.fetch = savedFetch;
		globalThis.localStorage = savedStorage;
		AbortSignal.timeout = savedTimeout;
	}
});

// ---------------------------------------------------------------- 弹窗按钮（v1.14.0）

test('客户端半边：提问卡上的按钮（v1.14.0）—— 点一下就把答案交给庄家', async () => {
	const savedFetch = globalThis.fetch;
	const savedStorage = globalThis.localStorage;
	// `AbortSignal.timeout(15s)` 的定时器会把测试进程吊住 —— 换成不带定时器的等价物。
	const savedTimeout = AbortSignal.timeout;
	AbortSignal.timeout = () => new AbortController().signal;
	const store = new Map();
	const calls = [];
	let replyValue = { ok: true, text: '' };
	const seerCard = {
		seq: 7, at: 1_700_000_000_000, gameId: 'g1', room: '测试房', to: 'dsh-chat-room-v3-g1', kind: 'dealer',
		text: '你是预言家。请选择：① 验一名玩家（回复座位名）② 查看未分配的2张牌（回复"2"）。',
		options: [
			{ label: '查看未分配的 2 张牌', text: '2' },
			{ label: '验 甲', text: '验 甲' },
			{ label: '验 乙', text: '验 乙' }
		]
	};
	globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
	globalThis.fetch = async (url, init) => {
		const body = JSON.parse(init.body);
		calls.push({ url, body });
		if (body.endpoint === 'reply') return { ok: true, json: async () => ({ ok: true, value: replyValue }) };
		const since = Number(body.args?.since ?? 0);
		return { ok: true, json: async () => ({ ok: true, value: { records: since >= seerCard.seq ? [] : [seerCard], seq: seerCard.seq, more: false } }) };
	};
	try {
		const { overlay } = mount();
		const render = () => { hookCursor = 0; return overlay.component({}); };
		const round = async () => { runCleanups(); resetHooks(); render(); await new Promise((resolve) => setTimeout(resolve, 5)); return render(); };

		const tree = await round();
		const buttons = findButtons(tree);
		// v1.31.0（2026-10-18 用户真机反馈）：**必答卡不画「知道了」** —— 误点它会推进游标、
		// 这张卡永久消失，而确认阶段 host 侧不限时、不自动催 ⇒ 整局静默停住。
		assert.equal(buttons.length, 3, '★ 只有三个选项按钮，底部没有「知道了」');
		assert.equal(collectText(tree).join('').includes('知道了'), false, '★ 必答卡上不出现「知道了」');
		assert.equal(collectText(tree).join('').includes('这张卡要先作答'), true, '★ 底部换成「先作答」的提示');
		assert.deepEqual(buttons.slice(0, 3).map((button) => collectText(button).join('')), ['查看未分配的 2 张牌', '验 甲', '验 乙'], '★ 按钮文案就是庄家给的 label（顺序也照给）');
		assert.deepEqual(buttons.slice(0, 3).map((button) => button.props.title), ['2', '验 甲', '验 乙'], '★ 悬停能看到它会回给庄家的原文（text）');
		assert.equal(store.get('dsh-werewolf-dealer:mail-cursor'), undefined, '还没点 ⇒ 游标不落盘');

		// 庄家说「没送到」⇒ 保留这张卡、说明原因、游标不动（可以再点一次）
		replyValue = { ok: false, text: '当前没有等待你回答的问题。' };
		buttons[1].props.onClick();
		await new Promise((resolve) => setTimeout(resolve, 5));
		const failedReply = calls.filter((call) => call.body.endpoint === 'reply').at(-1);
		assert.deepEqual(failedReply.body.args, { gameId: 'g1', to: 'dsh-chat-room-v3-g1', text: '验 甲' }, '★ 点按钮 = 把选项写好的原文回给庄家（与手打 /ww-reply 同一串字）');
		assert.equal(collectText(render()).join('\n').includes('当前没有等待你回答的问题。'), true, '★ 失败原因要显示给人看');
		assert.equal(store.get('dsh-werewolf-dealer:mail-cursor'), undefined, '★ 没送到就不推进游标（这张卡还在）');
		// v1.31.0：被庄家**明确拒收**之后才给「关闭这张卡」的逃生口（否则过期卡永远关不掉）。
		const afterFailed = findButtons(render());
		assert.equal(afterFailed.length, 4, '三个选项 + 关闭这张卡');
		assert.equal(collectText(afterFailed[3]).join(''), '关闭这张卡', '★ 逃生口只在被拒收后出现');

		// 成功 ⇒ 推进游标、浮层收起（下一个问题由轮询带来）
		replyValue = { ok: true, text: '' };
		findButtons(render())[2].props.onClick();
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.deepEqual(calls.filter((call) => call.body.endpoint === 'reply').at(-1).body.args.text, '验 乙', '★ 点的是哪个按钮就回哪个答案');
		assert.equal(store.get('dsh-werewolf-dealer:mail-cursor'), '7', '★ 答完才推进游标');
		assert.equal(render(), null, '答完浮层收起');
		runCleanups();
	} finally {
		globalThis.fetch = savedFetch;
		globalThis.localStorage = savedStorage;
		AbortSignal.timeout = savedTimeout;
	}
});

test('客户端半边：投票卡（v1.15.0）—— 点按钮把 channel 一并回传（庄家据此公开投进房间）', async () => {
	const savedFetch = globalThis.fetch;
	const savedStorage = globalThis.localStorage;
	const savedTimeout = AbortSignal.timeout;
	AbortSignal.timeout = () => new AbortController().signal;
	const store = new Map();
	const calls = [];
	const card = {
		seq: 9, at: 1_700_000_002_000, gameId: 'g1', room: '测试房', to: 'dsh-chat-room-v3-g1', kind: 'dealer',
		channel: 'room',
		text: '请投票：在房间里发一条「投票：<座位名>」或「投票：平安夜」；弃票就直接发「弃票」。座位名可选：甲、乙、你。',
		options: [{ label: '投 甲', text: '投票：甲' }, { label: '投 平安夜', text: '投票：平安夜' }, { label: '弃票', text: '弃票' }]
	};
	globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
	globalThis.fetch = async (_url, init) => {
		const body = JSON.parse(init.body);
		calls.push(body);
		if (body.endpoint === 'reply') return { ok: true, json: async () => ({ ok: true, value: { ok: true, text: '' } }) };
		return { ok: true, json: async () => ({ ok: true, value: { records: [card], seq: card.seq, more: false } }) };
	};
	try {
		const { overlay } = mount();
		const render = () => { hookCursor = 0; return overlay.component({}); };
		runCleanups(); resetHooks(); render(); await new Promise((resolve) => setTimeout(resolve, 5));
		const buttons = findButtons(render());
		// v1.31.0：投票卡同样是必答卡 —— 三个选项（本 fixture 还带着 v1.25.0 的「弃票」形状，
		// 客户端只负责原样画；v1.30.0 起庄家自己不再下发它）+ 底部**没有**「知道了」
		assert.equal(buttons.length, 3, '★ 投票卡也没有「知道了」');
		assert.equal(collectText(render()).join('').includes('知道了'), false, '★ 投票卡上不出现「知道了」');
		assert.deepEqual(buttons.slice(0, 2).map((button) => collectText(button).join('')), ['投 甲', '投 平安夜'], '★ 投票按钮的文案来自庄家给的 label');
		// v1.25.0：庄家多给一个「弃票」按钮 ⇒ 客户端原样画出来、点了照旧带 channel 回传。
		const abstainButton = buttons.find((button) => collectText(button).join('') === '弃票');
		assert.ok(abstainButton, '★ v1.25.0：投票卡多一个「弃票」按钮');
		buttons[1].props.onClick();
		await new Promise((resolve) => setTimeout(resolve, 5));
		const reply = calls.find((call) => call.endpoint === 'reply');
		assert.deepEqual(
			reply.args,
			{ gameId: 'g1', to: 'dsh-chat-room-v3-g1', text: '投票：平安夜', channel: 'room' },
			'★ channel 原样回传（庄家据此走「公开发进房间」而不是夜间私聊）'
		);
		abstainButton.props.onClick();
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.deepEqual(
			calls.filter((call) => call.endpoint === 'reply').at(-1).args,
			{ gameId: 'g1', to: 'dsh-chat-room-v3-g1', text: '弃票', channel: 'room' },
			'★ 点「弃票」回传的就是引擎认识的那串裸写 `弃票`（不走旁路、也不带多余的 `投票：` 前缀）'
		);
		assert.equal(store.get('dsh-werewolf-dealer:mail-cursor'), '9', '答完推进游标');
		runCleanups();
	} finally {
		globalThis.fetch = savedFetch;
		globalThis.localStorage = savedStorage;
		AbortSignal.timeout = savedTimeout;
	}
});

// ---------------------------------------------------------------- 必答卡的逃生口（v1.31.0）

test('客户端半边：必答卡被庄家拒收后才能「关闭这张卡」（v1.31.0）', async () => {
	const savedFetch = globalThis.fetch;
	const savedStorage = globalThis.localStorage;
	const savedTimeout = AbortSignal.timeout;
	AbortSignal.timeout = () => new AbortController().signal;
	const store = new Map();
	const calls = [];
	// 确认阶段的那张卡：只有一个「确认进入投票」按钮。庄家随后判"已过期"（手打 /ww-reply 已经答过、
	// 或观察员 /ww-close-vote 跳过）⇒ 这张卡再也答不进去，但也不能让它永远贴在屏幕上。
	const card = {
		seq: 11, at: 1_700_000_003_000, gameId: 'g2', room: '测试房', to: 'dsh-chat-room-v3-g2', kind: 'dealer',
		text: '发言阶段结束。是否进入投票阶段？点下面的按钮确认即可（等同回「是」）。',
		options: [{ label: '确认进入投票', text: '是' }]
	};
	globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
	globalThis.fetch = async (_url, init) => {
		const body = JSON.parse(init.body);
		calls.push(body);
		if (body.endpoint === 'reply') {
			return { ok: true, json: async () => ({ ok: true, value: { ok: false, text: '现在不在投票阶段，这张卡已经过期了。' } }) };
		}
		const since = Number(body.args?.since ?? 0);
		return { ok: true, json: async () => ({ ok: true, value: { records: since >= card.seq ? [] : [card], seq: card.seq, more: false } }) };
	};
	try {
		const { overlay } = mount();
		const render = () => { hookCursor = 0; return overlay.component({}); };
		runCleanups(); resetHooks(); render(); await new Promise((resolve) => setTimeout(resolve, 5));
		const before = findButtons(render());
		assert.equal(before.length, 1, '★ 必答卡只有一个作答按钮，没有「知道了」');
		assert.equal(collectText(render()).join('').includes('知道了'), false, '★ 没有被误关的入口');
		before[0].props.onClick();
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(store.get('dsh-werewolf-dealer:mail-cursor'), undefined, '★ 被拒收 ⇒ 游标不动（这张卡还在）');
		assert.equal(collectText(render()).join('\n').includes('这张卡已经过期了'), true, '★ 拒收原因要显示出来');
		const rejected = findButtons(render());
		assert.equal(rejected.length, 2, '『确认进入投票』+ 『关闭这张卡』');
		assert.equal(collectText(rejected[1]).join(''), '关闭这张卡');
		rejected[1].props.onClick();
		assert.equal(store.get('dsh-werewolf-dealer:mail-cursor'), '11', '★ 关闭 = 推进游标（否则刷新页面它还会被 inbox 吐出来）');
		assert.equal(render(), null, '关掉后浮层收起');
		assert.equal(calls.filter((call) => call.endpoint === 'reply').length, 1, '关闭不是作答：不再多发一次 reply');
		runCleanups();
	} finally {
		globalThis.fetch = savedFetch;
		globalThis.localStorage = savedStorage;
		AbortSignal.timeout = savedTimeout;
	}
});
