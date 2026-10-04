/**
 * 离线测试台：用假的 `ctx`（dsh-chat / dsh-bridge / tools / commands）跑真插件。
 *
 * 目的：在没有 Harness 运行时的情况下，端到端验证庄家的全部判定 —— 房间消息进出、
 * 私聊信道、状态落盘、审计与 raw 导出。假件的形状严格照宿主实现：
 *   - `ctx.dshChat.chat`：`resolveRoom / send / subscribe`（dsh-chat 0.1.0-rc.36）
 *   - `ctx.dshBridge`：`deliverExternal(from, to, text, options)`（dsh-bridge 0.1.0-rc.17）
 *   - `ctx.tools.register` / `ctx.commands.register`：只捕获定义，由测试直接调用
 *
 * @module dsh-werewolf-dealer/test/helpers
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply, DEALER_ID } from '../index.js';

/** 一局测试的假环境。 */
export class Harness {
	/**
	 * @param options - `{ players, roomName, stateDir, exportDir, config }`。
	 */
	constructor(options) {
		this.players = options.players;
		this.room = {
			id: options.roomId ?? 'room-dealer-test',
			name: options.roomName ?? '庄家插件测试房',
			// 真人在房间里的发言，作者就是房间自身的会话（dsh-chat 客户端行为）
			sessionId: `dsh-chat-room-v3-${options.roomId ?? 'room-dealer-test'}`,
			members: options.players.map((player) => ({ kind: 'session', sessionId: player.sessionId, alias: player.name }))
		};
		this.roomMessages = [];
		this.dmLog = [];
		this.auditLog = [];
		/** 房间成员增删记录（真人占位成员用）。 */
		this.memberLog = [];
		/** 被删掉的消息 id（v1.9.1：真人发言规范化会删原文）。 */
		this.removedIds = [];
		/** `true` 时 removeMessage 一律抛错（验删除失败时的退化行为）。 */
		this.removeFails = false;
		/** 插件写过的 warn（v1.9.1：删除失败/退化会记 warn，用它断言）。 */
		this.warns = [];
		this.subscriber = null;
		this.tools = new Map();
		this.commands = new Map();
		this.stateDir = options.stateDir;
		this.exportDir = options.exportDir;
		this.disposers = [];
		/** 房间外、但真实存在的会话 id（真人自己的私聊信道）。 */
		this.extraSessions = new Set(options.extraSessions ?? []);
		/** 上面这些额外会话的标题（重名用例用）。 */
		this.extraTitles = new Map(Object.entries(options.extraTitles ?? {}));
		/** 房间落盘文件的读取次数（§11「投票期间不读房间落盘文件」的探针）。 */
		this.roomFileReads = [];
		/** 这些会话 id 的私聊投递一律失败（复刻"没到"：地址写错/会话不可 resume）。 */
		this.failDeliveryTo = new Set(options.failDeliveryTo ?? []);

		const self = this;
		const chat = {
			async resolveRoom(reference) {
				if (String(reference) !== self.room.id && String(reference) !== self.room.name) throw new Error(`room "${reference}" does not exist`);
				return self.room;
			},
			async messages(roomId, limit, waitMs) {
				self.roomFileReads.push({ api: 'messages', roomId, limit, waitMs, at: Date.now() });
				throw new Error('房间落盘文件在投票期间禁止读取');
			},
			async history(roomId, beforeId, limit) {
				self.roomFileReads.push({ api: 'history', roomId, beforeId, limit, at: Date.now() });
				throw new Error('房间落盘文件在投票期间禁止读取');
			},
			async send(request) {
				const message = { id: randomUUID(), roomId: request.roomId, author: request.author, authorAlias: request.authorAlias, text: request.text, mentions: request.mentions ?? [], sentAt: Date.now(), deliveries: [] };
				self.roomMessages.push(message);
				// v1.9.0：真实 dsh-chat 会把落进时间线的消息广播给订阅者 —— 庄家**代投**的席位发言
				// 也因此回流（发言链就是靠这条回流前进的）。测试台必须复刻这一步，否则
				// 「代投 → 引擎步进」这条链在测试里永远验不到。
				self.subscriber?.({ kind: 'message', message });
				return message;
			},
			async addMember(roomId, member) {
				const existing = self.room.members.find((item) => item.kind === member.kind && item.sessionId === member.sessionId);
				if (existing !== undefined) {
					if (member.alias) existing.alias = member.alias;
					return existing;
				}
				const entry = { kind: member.kind, sessionId: member.sessionId, alias: member.alias };
				self.room.members.push(entry);
				self.memberLog.push({ action: 'add', kind: entry.kind, sessionId: entry.sessionId, alias: entry.alias });
				return entry;
			},
			async removeMember(roomId, member) {
				const index = self.room.members.findIndex((item) => item.kind === member.kind && item.sessionId === member.sessionId);
				if (index === -1) return null;
				const [removed] = self.room.members.splice(index, 1);
				self.memberLog.push({ action: 'remove', kind: removed.kind, sessionId: removed.sessionId, alias: removed.alias });
				return removed;
			},
			/**
			 * v1.9.1（dsh-chat 补丁 19 的假实现）：删窗口里的任意一条（与真实现同口径）。
			 * `self.removeFails = true` 时抛错（验「先发后删 ⇒ 删失败也不丢发言」）。
			 */
			async removeMessage(roomId, messageId) {
				if (self.removeFails === true) throw new Error('removeMessage 探针：拒绝删除');
				const at = self.roomMessages.findIndex((message) => message.id === messageId);
				if (at === -1) return { removed: false, reason: 'not-in-window', id: messageId };
				self.roomMessages.splice(at, 1);
				self.removedIds.push(messageId);
				return { removed: true, id: messageId };
			},
			subscribe(listener) {
				self.subscriber = listener;
				return () => { self.subscriber = null; };
			}
		};
		const bridge = {
			async status(sessionId) {
				const ref = String(sessionId);
				const known = self.players.some((player) => player.sessionId === ref) || self.extraSessions.has(ref);
				return { sessionId: ref, state: known ? 'idle' : 'missing', live: known };
			},
			/**
			 * 镜像 dsh-bridge 的 `resolveTarget`：先精确会话 id，再按标题。
			 *
			 * ⚠ 这里刻意**复刻真机标题分支的故障**（2026-10-04 实测）：真桥接层调
			 * `sessionProjectionCache.cachedSnapshot(header, 0, ['title'])`，而本版本该方法是
			 * `cachedSnapshot(meta, keys)` 两参 ⇒ keys=0 ⇒ 内部遍历数字 0 ⇒ `number 0 is not iterable`。
			 * 所以插件必须自己把标题解析掉，并把这条错翻译成人话。
			 */
			async resolveTarget(reference, mode = 'auto') {
				const ref = String(reference);
				const all = [
					...self.players.map((player) => ({ id: player.sessionId, title: player.title ?? player.name })),
					...[...self.extraSessions].map((id) => ({ id, title: self.extraTitles.get(id) }))
				];
				if (mode !== 'name' && all.some((entry) => entry.id === ref)) return ref;
				if (mode === 'id') throw new Error(`no session with id "${ref}"`);
				throw new Error('number 0 is not iterable (cannot read property Symbol(Symbol.iterator))');
			},
			async deliverExternal(from, to, text, opts = {}) {
				// `failDeliveryTo` 复刻"没到"（真人席位地址写错、目标会话不可 resume 等）
				if (self.failDeliveryTo.has(String(to))) {
					self.dmLog.push({ from, to: String(to), text, id: opts.id, wake: opts.wake !== false, transport: opts.transport, at: Date.now(), failed: true });
					throw new Error(`session "${to}" could not be resumed（harness 注入的投递失败）`);
				}
				self.dmLog.push({ from, to: String(to), text, id: opts.id, wake: opts.wake !== false, transport: opts.transport, at: Date.now() });
				return { messageId: opts.id ?? randomUUID(), from, to: String(to), delivered: true };
			}
		};
		this.ctx = {
			tools: { register: (definition) => { self.tools.set(definition.name, definition); const dispose = () => self.tools.delete(definition.name); self.disposers.push(dispose); return dispose; } },
			commands: { register: (definition) => { self.commands.set(definition.name, definition); const dispose = () => self.commands.delete(definition.name); self.disposers.push(dispose); return dispose; } },
			dshChat: { chat },
			dshBridge: bridge,
			effect: (body) => { const dispose = body(); if (typeof dispose === 'function') self.disposers.push(dispose); return dispose; },
			logger: { info: () => {}, warn: (text) => { self.warns.push(String(text)); }, debug: () => {}, error: () => {} },
			// 宿主服务的最小替身：`/ww-sessions` 从 agents + sessionTitle 读"标题 → id"
			get: (name) => {
				if (name === 'agents') {
					return {
						list: () => [
							...self.players.map((player) => ({ session: { id: player.sessionId, header: { id: player.sessionId, title: player.title ?? player.name } } })),
							...[...self.extraSessions].map((id) => ({ session: { id, header: { id, title: self.extraTitles.get(id) } } }))
						]
					};
				}
				if (name === 'sessionTitle') return { get: (session) => ({ title: session?.header?.title }) };
				if (name === 'sessionPersistence') return { list: async () => [] };
				return undefined;
			}
		};
		apply(this.ctx, { stateDir: this.stateDir, exportDir: this.exportDir, reminderMs: 0, ...(options.config ?? {}) });
	}

	/**
	 * 模拟某个玩家会话在房间里发言。
	 * @param sessionId - 房间侧作者（AI 席位=自己的会话；真人=房间自身会话）。
	 * @param text - 正文。
	 * @param mentions - dsh-chat 解析后的提及引用；默认 `['all']`（= 真人忘了 AT 下一位的情形，
	 *   v1.9.0 的「真人那一棒」兜底用例要用它）。
	 */
	say(sessionId, text, mentions = ['all']) {
		if (this.subscriber === null) throw new Error('harness has no subscriber');
		const message = { id: randomUUID(), roomId: this.room.id, author: sessionId, authorAlias: this.players.find((p) => p.sessionId === sessionId)?.name, text, mentions, sentAt: Date.now() };
		// v1.9.1：真 dsh-chat 里这条消息是**落在时间线里**的（庄家随后要按 id 删它），所以这里也要登记，
		// 否则「删掉真人原文」这条链在测试台里根本走不通。
		this.roomMessages.push(message);
		this.subscriber({ kind: 'message', message });
		return message;
	}

	/** 模拟观察员在房间里发言（非玩家）。 */
	observerSay(text) {
		return this.say('observer-session', text);
	}

	/** 调用模型侧工具。 */
	async callTool(name, args, sessionId) {
		const tool = this.tools.get(name);
		if (tool === undefined) throw new Error(`tool ${name} is not registered`);
		return await tool.execute(args, { agent: { session: { id: sessionId } } });
	}

	/** 调用人类命令。 */
	async runCommand(name, rawInput, sessionId = 'observer-session') {
		const command = this.commands.get(name);
		if (command === undefined) throw new Error(`command ${name} is not registered`);
		return await command.handler({ commandId: 'cmd-1', agent: { session: { id: sessionId } }, rawInput, attachments: [], signal: new AbortController().signal });
	}

	/** 等串行链跑完（插件内部为 promise 串行队列，真实定时器足够排空）。 */
	async flush(times = 3) {
		for (let i = 0; i < times; i += 1) await new Promise((done) => setTimeout(done, 0));
	}

	/** 最近若干条房间公告。 */
	get lastRoomText() {
		return this.roomMessages.at(-1)?.text ?? '';
	}

	/** 某会话收到的私聊。 */
	dmsTo(sessionId) {
		return this.dmLog.filter((entry) => entry.to === sessionId);
	}

	/** 读取私有状态文件。 */
	readState(gameId) {
		return JSON.parse(readFileSync(join(this.stateDir, `${gameId}.json`), 'utf8'));
	}

	/** 读取审计文件。 */
	readAudit(gameId) {
		const path = join(this.stateDir, `${gameId}.audit.jsonl`);
		return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
	}

	/** 清理。 */
	dispose() {
		for (const dispose of this.disposers.reverse()) {
			try { dispose(); } catch { /* 忽略 */ }
		}
	}
}

/** 建一个工作区之外的临时目录（§8.1 要求状态目录在工作区外）。 */
export function makeTempDir(prefix = 'werewolf-dealer-test') {
	const dir = join(tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** 递归删除。 */
export function removeDir(dir) {
	rmSync(dir, { recursive: true, force: true });
}

/** 递归列出文件。 */
export function listFiles(root, filter = () => true) {
	const out = [];
	let entries;
	try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(path, filter));
		else if (entry.isFile() && filter(path)) out.push(path);
	}
	return out;
}

/** 大小与 mtime（隐私验收的辅助证据）。 */
export function fileStamp(path) {
	try {
		const info = statSync(path);
		return { size: info.size, mtimeMs: info.mtimeMs };
	} catch {
		return null;
	}
}
