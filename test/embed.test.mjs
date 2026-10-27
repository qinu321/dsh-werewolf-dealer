/**
 * v2.0.0 内嵌启动的离线冒烟：**不跳过** chat/bridge 的 apply，验证合并后的宿主半边真能起来。
 *
 * 其余套件走 `{ embed: false }`（它们要断言投递/唤醒细节，用自带桩）；
 * 本套件用一个**真的 cordis Context**（只提供最小服务桩）起真服务，断言「装得上、注册齐」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { apply, inject } from '../index.js';

/** 真的 cordis Context + 最小服务桩。 */
function makeApp() {
	const app = new Context();
	const registered = { tools: new Set(), commands: new Set(), routes: [] };
	app.provide('tools', { register(definition) { registered.tools.add(definition.name); return () => {}; } });
	app.provide('commands', { register(definition) { registered.commands.add(definition.name); return () => {}; } });
	app.provide('connection', { fetch: { register(route) { registered.routes.push(route.path); return () => {}; } } });
	app.provide('sessions', { list: () => ({ getSnapshot: () => ({ byId: {} }) }), get: () => undefined });
	app.provide('workspaceRegistry', { archivedSessionIds: [] });
	app.provide('sessionTitle', { get: () => undefined });
	app.provide('sessionPersistence', { list: async () => [] });
	app.provide('agents', { list: () => [], get: () => undefined });
	app.provide('typert', { lookups: new Map() });
	return { app, registered };
}

/** 给 inject 回调与异步启动留一拍（cordis 的服务就绪回调可能被排到微任务之后）。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

test('内嵌启动：自己 provide dshChat/dshBridge，并注册 chat_*/session_* 工具与两条 /api 路由', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'wolf-embed-'));
	const { app, registered } = makeApp();
	apply(app, { stateDir: dir, exportDir: dir, path: join(dir, 'rooms.json'), workspacePath: join(dir, 'Chatrooms') });
	await tick();

	assert.equal(typeof app.dshBridge?.deliverExternal, 'function', 'dshBridge 服务应由本插件自己 provide');
	assert.equal(typeof app.dshChat?.chat?.send, 'function', 'dshChat 服务应由本插件自己 provide');
	for (const name of ['chat_create', 'chat_join', 'chat_invite', 'chat_send', 'session_list', 'session_send', 'session_messages', 'wolf_start', 'wolf_speak']) {
		assert.ok(registered.tools.has(name), `缺少工具：${name}`);
	}
	assert.ok(registered.routes.includes('/api/dsh-chat'), '/api/dsh-chat 房间路由应注册');
	assert.ok(registered.routes.includes('/api/dsh-werewolf'), '/api/dsh-werewolf 信箱路由应注册');
	await app.stop?.();
});

test('inject 并集剔除 dshBridge/dshChat（自己 provide 的服务不能出现在 inject 里）', () => {
	assert.ok(Array.isArray(inject) && inject.length > 0);
	assert.ok(!inject.includes('dshBridge'));
	assert.ok(!inject.includes('dshChat'));
	for (const service of ['tools', 'commands', 'connection', 'sessions', 'workspaceRegistry', 'sessionTitle', 'sessionPersistence', 'agents', 'typert']) {
		assert.ok(inject.includes(service), `inject 缺少 ${service}`);
	}
});
