/**
 * 补丁 35（2026-10-29）：删除房间时**连房间会话一起删**。
 *
 * 真机症状：在房间设置面板点「删除房间」后房间没了，侧栏却多出一条「未分组」的会话 ——
 * 因为补丁 33 只把 `<ROOM_SESSION_PREFIX><roomId>` 从 Chatrooms 工作区摘掉，
 * 会话工件还留在 `<DSH_HOME>/sessions/<project>/<会话 id>/session.*.jsonl[.zstd]` 里
 * （重启后 `sessionPersistence.list()` 照样列它，点开是个空壳）。
 *
 * 本套件用假 ctx 复刻宿主的三条接口（sessions / workspaceRegistry / sessionPersistence），
 * 逐条验 `#deleteRoomSession` 的收尾顺序：
 *   ① 先取工件路径 → ② 全工作区摘记账 → ③ 活 store 行 detach → ④ 没有活行时补
 *   `session/disposed` → ⑤ 拆完再取一次路径 → 删会话目录。
 * 另外三个退化路径：「路径越界拒删」「持久层缺席不抛错」「会话在拆的时候才落盘」。
 *
 * 判据口径与 dsh-session-manager 的 `deleteSession` 相同（2026-10-29 读其 lib/index.js 确认）：
 * 它同样先 detach（或显式 emit disposed）再 rm 会话目录，并先做目录形状校验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DshChatService } from '../lib/chat/room-store.js';

const ROOM_ID = '06589187-16e6-4d45-98cf-49f739fbc138';
const SESSION_ID = `dsh-chat-room-v3-${ROOM_ID}`;

/** 一套临时「DSH home」：sessions 根下的房间会话工件 + 一份只含该房间的 rooms.json。 */
async function makeFixture() {
	const root = await mkdtemp(join(tmpdir(), 'dsh-chat-delete-'));
	const home = join(root, 'home');
	const sessionDir = join(home, 'sessions', '--proj--', SESSION_ID);
	const artifactPath = join(sessionDir, 'session.v4.jsonl.zstd');
	await mkdir(sessionDir, { recursive: true });
	await writeFile(artifactPath, 'artifact');
	// 一个**越界**的工件路径（不在 <home>/sessions 下），用来验「拒删」。
	const outsidePath = join(root, 'outside', SESSION_ID, 'session.v4.jsonl.zstd');
	await mkdir(join(root, 'outside', SESSION_ID), { recursive: true });
	await writeFile(outsidePath, 'artifact');
	const roomsFile = join(root, 'rooms.json');
	await writeFile(roomsFile, JSON.stringify({
		version: 1,
		rooms: [{
			id: ROOM_ID, name: '测试房间', createdAt: 1,
			members: [], messages: [], cursor: 0, messageOffset: 0, sessionId: SESSION_ID
		}]
	}, null, 2));
	return { root, home, sessionDir, artifactPath, outsidePath, roomsFile };
}

/**
 * 假宿主。`live` = 房间会话此刻在 `sessions.store` 里有一行（用户正开着房间视图）。
 * `artifactPath` 可换成越界路径；`persistence: false` 模拟持久层缺席（老 DSH / 服务未就绪）。
 * `materializeOnDetach` 模拟「已创建、还没落盘」的会话：拆会话（writer.close 的最后一次 drain）
 * 时才把工件写出来 —— 只有拆完再取一次路径才删得到它。
 */
function makeHost(fixture, { live = false, persistence = true, artifactPath = fixture.artifactPath, locate = true, materializeOnDetach = false } = {}) {
	const calls = { detached: [], entryDetached: 0, emitted: [], warns: [], debug: [] };
	let liveSession = live ? { id: SESSION_ID } : undefined;
	let materialized = !materializeOnDetach;
	const entry = {
		detach() {
			calls.entryDetached += 1;
			liveSession = undefined;
			if (materializeOnDetach) {
				mkdirSync(dirname(artifactPath), { recursive: true });
				writeFileSync(artifactPath, 'artifact');
				materialized = true;
			}
		}
	};
	const sessions = {
		get: (id) => (id === SESSION_ID ? liveSession : undefined),
		store: new Map(live ? [[SESSION_ID, entry]] : [])
	};
	const persistenceService = {
		async stat(id) {
			if (id !== SESSION_ID) return undefined;
			// 未落盘的会话在 stat 里只有 header/revision，没有 location.path（DSH 0.2.x 实况）。
			return materialized ? { header: { id }, location: { kind: 'jsonl', path: artifactPath } } : { header: { id }, revision: 'pending' };
		},
		...(locate ? { locate() { return { kind: 'jsonl', path: artifactPath }; } } : {})
	};
	const ctx = {
		logger: { info() {}, warn: (message) => calls.warns.push(message), debug: (message) => calls.debug.push(message) },
		emit: (name, payload) => { calls.emitted.push({ name, payload }); },
		get(name) {
			switch (name) {
				case 'sessions': return sessions;
				case 'workspaceRegistry': return { list: () => [{ async detachSession(id) { calls.detached.push(id); } }] };
				case 'sessionPersistence': return persistence ? persistenceService : undefined;
				case 'dshHomePath': return (...segments) => join(fixture.home, ...segments);
				default: return undefined;
			}
		}
	};
	return { ctx, calls };
}

async function openService(fixture, ctx) {
	return new DshChatService(ctx, { path: fixture.roomsFile, workspacePath: join(fixture.home, 'dsh-chat', 'Chatrooms') });
}

async function remainingRooms(fixture) {
	return JSON.parse(await readFile(fixture.roomsFile, 'utf8')).rooms;
}

test('删除房间：活着的房间会话被 detach，工件目录被删掉', async () => {
	const fixture = await makeFixture();
	const { ctx, calls } = makeHost(fixture, { live: true });
	const service = await openService(fixture, ctx);
	try {
		const result = await service.deleteRoom(ROOM_ID);
		assert.equal(result.id, ROOM_ID);
		assert.equal(result.sessionRemoved, true);
		assert.deepEqual(calls.detached, [SESSION_ID], '要从所有工作区摘掉房间会话');
		assert.equal(calls.entryDetached, 1, '活会话的 store 行要被 detach');
		assert.equal(
			calls.emitted.filter((item) => item.name === 'session/disposed').length, 0,
			'活 store 行的 detach 自己会发 disposed，这里不该重复发'
		);
		await assert.rejects(stat(fixture.sessionDir), { code: 'ENOENT' }, '会话目录应被彻底删掉');
		assert.deepEqual(await remainingRooms(fixture), [], 'rooms.json 里该房间应已摘掉');
	} finally {
		await service.close();
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test('删除房间：只剩盘上工件的房间会话（重启后没活 store 行）也删，并显式广播 disposed', async () => {
	const fixture = await makeFixture();
	const { ctx, calls } = makeHost(fixture, { live: false });
	const service = await openService(fixture, ctx);
	try {
		const result = await service.deleteRoom(ROOM_ID);
		assert.equal(result.sessionRemoved, true);
		assert.equal(calls.entryDetached, 0, '没有活会话，不该有 store 行可 detach');
		assert.deepEqual(calls.detached, [SESSION_ID]);
		assert.deepEqual(
			calls.emitted, [{ name: 'session/disposed', payload: { id: SESSION_ID } }],
			'没有活 store 行时必须显式发 session/disposed（客户端据此掉掉侧栏那一行）'
		);
		await assert.rejects(stat(fixture.sessionDir), { code: 'ENOENT' });
		assert.deepEqual(await remainingRooms(fixture), []);
	} finally {
		await service.close();
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test('删除房间：工件路径不在 sessions 根下时拒删（房间照样删掉、文件留着、记 warn）', async () => {
	const fixture = await makeFixture();
	const { ctx, calls } = makeHost(fixture, { live: false, artifactPath: fixture.outsidePath });
	const service = await openService(fixture, ctx);
	try {
		const result = await service.deleteRoom(ROOM_ID);
		assert.equal(result.sessionRemoved, false, '拒删要让调用方看见（sessionRemoved:false）');
		assert.ok(calls.warns.some((message) => message.includes('could not delete its session')), `要记 warn：${JSON.stringify(calls.warns)}`);
		const kept = await stat(fixture.outsidePath);
		assert.equal(kept.isFile(), true, '越界路径上的文件必须原样保留');
		assert.deepEqual(await remainingRooms(fixture), [], '房间条目仍应删掉（会话删不掉不回滚）');
	} finally {
		await service.close();
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test('删除房间：持久层缺席时不抛错（定位不到工件就只做记账与广播）', async () => {
	const fixture = await makeFixture();
	const { ctx, calls } = makeHost(fixture, { live: false, persistence: false });
	const service = await openService(fixture, ctx);
	try {
		const result = await service.deleteRoom(ROOM_ID);
		assert.equal(result.sessionRemoved, true);
		assert.deepEqual(calls.warns, [], '定位不到工件不是错误路径');
		assert.deepEqual(calls.detached, [SESSION_ID]);
		assert.deepEqual(await remainingRooms(fixture), []);
	} finally {
		await service.close();
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test('删除房间：会话在拆的时候才落盘（created 但未 materialize）也要删干净', async () => {
	const fixture = await makeFixture();
	// 起点：工件还没写出来（只在内存里 pending）。
	await rm(fixture.sessionDir, { recursive: true, force: true });
	const { ctx, calls } = makeHost(fixture, {
		live: true, locate: false, materializeOnDetach: true
	});
	const service = await openService(fixture, ctx);
	try {
		const result = await service.deleteRoom(ROOM_ID);
		assert.equal(result.sessionRemoved, true);
		assert.equal(calls.entryDetached, 1, '活会话要被 detach（它顺带把工件写出来）');
		assert.equal(calls.emitted.filter((item) => item.name === 'session/disposed').length, 0);
		await assert.rejects(stat(fixture.sessionDir), { code: 'ENOENT' }, '拆的时候才写出来的工件也要被删掉');
		assert.deepEqual(await remainingRooms(fixture), []);
	} finally {
		await service.close();
		await rm(fixture.root, { recursive: true, force: true });
	}
});
