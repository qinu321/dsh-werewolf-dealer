/**
 * 离线自检：只验证"注册形状"是否符合 Host 的校验口径（不跑对局）。
 *
 * 运行：`node selftest.mjs`
 *
 * 依据（实测）：`ctx.tools.register` 只校验 `output:{schema,render}` + `output.schema`
 * 属于受支持子集；`parameters` 收**标准 JSON Schema**（`required` 是字符串数组，
 * 不是 defineTool 那种属性内 `required: true` 方言）。命令名须匹配
 * `^[a-z][a-z0-9_-]*$`（dsh-commands）。
 *
 * @module dsh-werewolf-dealer/selftest
 */

import { apply, inject } from './index.js';

let failures = 0;
const results = [];
function check(label, condition, detail) {
	if (condition) { results.push(`  ok   ${label}`); return; }
	failures += 1;
	results.push(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

const captured = { tools: new Map(), commands: new Map(), effects: 0, subscribed: false };
const fakeRoom = {
	id: 'room-selftest',
	name: '自检房',
	sessionId: 'dsh-chat-room-v3-room-selftest',
	members: [{ kind: 'session', sessionId: 'session-a', alias: '甲' }, { kind: 'session', sessionId: 'session-b', alias: '乙' }]
};
const fakeChat = {
	async resolveRoom() { return fakeRoom; },
	async send() { throw new Error('selftest 不发送消息'); },
	subscribe() { captured.subscribed = true; return () => {}; }
};
apply({
	tools: { register: (definition) => { captured.tools.set(definition.name, definition); return () => {}; } },
	commands: { register: (definition) => { captured.commands.set(definition.name, definition); return () => {}; } },
	dshChat: { chat: fakeChat },
	dshBridge: {
		async status() { return { sessionId: 'session-a', state: 'idle', live: true }; },
		async resolveTarget(reference) { return String(reference); },
		async deliverExternal() { throw new Error('selftest 不投递私聊'); }
	},
	effect: (body) => { captured.effects += 1; return body(); },
	logger: { info: () => {}, warn: () => {} }
}, { stateDir: process.env.TEMP ?? '/tmp', exportDir: process.env.TEMP ?? '/tmp' });

// --- 依赖声明 ---------------------------------------------------------------
check('inject 声明四个 Host 服务', JSON.stringify(inject) === JSON.stringify(['tools', 'commands', 'dshChat', 'dshBridge']), JSON.stringify(inject));
check('激活时订阅了房间消息流', captured.subscribed === true);
check('用了 ctx.effect 托管副作用（订阅清理）', captured.effects >= 1, String(captured.effects));

// --- 工具 -------------------------------------------------------------------
const EXPECTED_TOOLS = ['wolf_speak', 'wolf_reply', 'wolf_start', 'wolf_status'];
check('注册了预期工具集', JSON.stringify([...captured.tools.keys()].sort()) === JSON.stringify([...EXPECTED_TOOLS].sort()), JSON.stringify([...captured.tools.keys()]));

for (const [name, tool] of captured.tools) {
	check(`[${name}] description 非空`, typeof tool.description === 'string' && tool.description.length > 10);
	check(`[${name}] parameters 是 object 根 Schema`, tool.parameters?.type === 'object');
	check(`[${name}] parameters.required 是数组（标准 JSON Schema 方言）`, Array.isArray(tool.parameters?.required), JSON.stringify(tool.parameters?.required));
	check(`[${name}] 参数属性没有 required: true 方言`, !Object.values(tool.parameters?.properties ?? {}).some((property) => property.required !== undefined));
	check(`[${name}] output.render 是函数`, typeof tool.output?.render === 'function');
	check(`[${name}] output.schema 是 object 根`, tool.output?.schema?.type === 'object');
	check(`[${name}] output.schema.required 是数组`, Array.isArray(tool.output?.schema?.required));
	check(`[${name}] execute 是 async 函数`, tool.execute?.constructor?.name === 'AsyncFunction');
	check(`[${name}] 声明了 additionalProperties: false（参数）`, tool.parameters?.additionalProperties === false);
}

// --- 命令 -------------------------------------------------------------------
const EXPECTED_COMMANDS = ['ww-start', 'ww-status', 'ww-pause', 'ww-resume', 'ww-override-vote', 'ww-recount', 'ww-void', 'ww-close-vote', 'ww-night', 'ww-nudge', 'ww-config', 'ww-inbox', 'ww-end', 'ww-audit', 'ww-reply', 'ww-sessions'];
check('注册了预期命令集', JSON.stringify([...captured.commands.keys()].sort()) === JSON.stringify([...EXPECTED_COMMANDS].sort()), JSON.stringify([...captured.commands.keys()]));
for (const [name, command] of captured.commands) {
	check(`[/${name}] 名字符合 ^[a-z][a-z0-9_-]*$`, /^[a-z][a-z0-9_-]*$/u.test(name), name);
	check(`[/${name}] description 非空`, typeof command.description === 'string' && command.description.length > 4);
	check(`[/${name}] handler 是函数`, typeof command.handler === 'function');
}

// --- 错误分支 ---------------------------------------------------------------
async function rejects(label, run, matcher) {
	try {
		await run();
		check(label, false, 'did not throw');
	} catch (error) {
		check(label, matcher(error), error?.message);
	}
}

await rejects('wolf_reply 缺少会话时抛错', () => captured.tools.get('wolf_reply').execute({ text: '不换' }, {}), (error) => error.message.includes('需要由会话调用'));
await rejects('wolf_reply 空文本时抛错', () => captured.tools.get('wolf_reply').execute({ text: '   ' }, { agent: { session: { id: 's1' } } }), (error) => error.message.includes('非空的 text'));
await rejects('wolf_status 无对局时给出可读错误', () => captured.tools.get('wolf_status').execute({}), (error) => error.message.includes('当前没有对局'));
// 命令 handler 自己收敛错误：始终返回 CommandResult，不向调用方抛
const badCount = await captured.commands.get('ww-start').handler({ rawInput: '房间 3 甲 乙', agent: {}, attachments: [], signal: new AbortController().signal });
check('ww-start 人数不符返回 error 结果（不抛）', badCount.kind === 'error' && badCount.text.includes('需要 3 个玩家名'), JSON.stringify(badCount));
const badMode = await captured.commands.get('ww-start').handler({ rawInput: '房间 5 甲 乙 丙 丁 戊', agent: {}, attachments: [], signal: new AbortController().signal });
check('ww-start 非法局型返回 error 结果（不抛）', badMode.kind === 'error' && badMode.text.includes('局型'), JSON.stringify(badMode));
const missingRoom = await captured.commands.get('ww-status').handler({ rawInput: '', agent: {}, attachments: [], signal: new AbortController().signal });
check('ww-status 无对局返回 error 结果', missingRoom.kind === 'error', JSON.stringify(missingRoom));

// --- 席位 token 语法（真人对局用） ------------------------------------------
const seat = (rawInput) => captured.commands.get('ww-start').handler({ rawInput, agent: {}, attachments: [], signal: new AbortController().signal });
const humanNoBinding = await seat('自检房 3 甲 乙 *丙');
// 本自检台的假宿主没有 `supportsComposerConsume`（= dsh-chat 补丁 21 未装）⇒ 弹窗模式必须被拒绝，
// 并把两条出路写清楚（打补丁 21 / 改用 `*名字=<会话>` 的老玩法）。
check('真人只写 `*名字` 但宿主没有吞掉能力时给出可执行指引', humanNoBinding.kind === 'error' && humanNoBinding.text.includes('用不了弹窗模式') && humanNoBinding.text.includes('补丁 21'), JSON.stringify(humanNoBinding));
const humanRoomSession = await seat('自检房 3 甲 乙 *丙=dsh-chat-room-v3-room-selftest');
check('真人席位不能绑房间自身会话（房间视图看不到私聊）', humanRoomSession.kind === 'error' && humanRoomSession.text.includes('房间视图里看不到房间会话自己的私聊行'), JSON.stringify(humanRoomSession));
const badName = await seat('自检房 3 甲*乙 乙 丙');
check('座位名含 * 时报错', badName.kind === 'error' && badName.text.includes('不能含 * 或 ='), JSON.stringify(badName));

const reply = captured.commands.get('ww-reply');
check('ww-reply 存在且 description 说明它不进模型上下文', typeof reply?.description === 'string' && reply.description.includes('不进任何模型上下文'));
const replyEmpty = await reply.handler({ rawInput: '   ', agent: { session: { id: 'session-x' } }, attachments: [], signal: new AbortController().signal });
check('ww-reply 空文本返回 error 结果', replyEmpty.kind === 'error' && replyEmpty.text.includes('用法'), JSON.stringify(replyEmpty));
const replyNoGame = await reply.handler({ rawInput: '2', agent: { session: { id: 'session-x' } }, attachments: [], signal: new AbortController().signal });
check('ww-reply 无对局返回 error 结果', replyNoGame.kind === 'error' && replyNoGame.text.includes('没有你参与的对局'), JSON.stringify(replyNoGame));
check('wolf_start 的 players 描述说明了真人语法', captured.tools.get('wolf_start').parameters.properties.players.description.includes('*名字=会话引用'));

// /ww-sessions 在宿主服务缺席时必须优雅降级（不抛）
const sessions = await captured.commands.get('ww-sessions').handler({ rawInput: '', agent: {}, attachments: [], signal: new AbortController().signal });
check('ww-sessions 缺宿主服务时优雅返回', sessions.kind === 'success' && typeof sessions.text === 'string', JSON.stringify(sessions));

// /ww-config：报出生效目录、值来源与"改哪里"
const config = await captured.commands.get('ww-config').handler({ rawInput: '', agent: {}, attachments: [], signal: new AbortController().signal });
check('ww-config 返回 success', config.kind === 'success', JSON.stringify(config).slice(0, 160));
check('ww-config 报出状态目录（自检传的是 TEMP）', typeof config.text === 'string' && config.text.includes(process.env.TEMP ?? '/tmp'), String(config.text).slice(0, 200));
check('ww-config 指出改配置的位置', typeof config.text === 'string' && config.text.includes('cordis.patch.yml'));
check('ww-config 提示 reminderMs 关闭', typeof config.text === 'string' && config.text.includes('（关闭）'));

// 显式把 reminderMs 打开 ⇒ 必须给出"本机不要开"的警告（时间是错误判据）
const warnCommands = new Map();
const fakeCtx = {
	tools: { register: () => () => {} },
	commands: { register: (definition) => { warnCommands.set(definition.name, definition); return () => {}; } },
	dshChat: { chat: { subscribe: () => () => {}, resolveRoom: async () => ({ id: 'r', name: 'r', members: [] }), send: async () => {} } },
	dshBridge: { deliverExternal: async () => {}, status: async () => ({ state: 'idle' }) },
	effect: (body) => body(),
	logger: { info: () => {}, warn: () => {} },
	get: () => undefined
};
apply(fakeCtx, { stateDir: process.env.TEMP ?? '/tmp', exportDir: process.env.TEMP ?? '/tmp', reminderMs: 300_000 });
const warned = await warnCommands.get('ww-config').handler({ rawInput: '', agent: {}, attachments: [], signal: new AbortController().signal });
check('ww-config 在 reminderMs 被打开时给出警告', typeof warned.text === 'string' && warned.text.includes('本机不建议开启'), String(warned.text).slice(0, 200));

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${results.length - failures}/${results.length} checks`);
process.exit(failures === 0 ? 0 : 1);
