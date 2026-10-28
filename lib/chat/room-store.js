// Stop waiting promptly while still observing a late upstream rejection.
function withSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

import { appendFile, chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

/*
 * 本地补丁索引 —— 本文件被改动的地方都标成「本地补丁 YYYY-MM-DD（补丁 N）」，编号对应
 * 下面这份说明的章节（路径相对 DSH 根目录）：
 *
 *   profiles/web/.dsh-plugin-backups/dsh-chat-PATCH-ALL/APPLY.md   ← 合并补丁（唯一入口）
 *   逐条历史与原始动机：同目录 HISTORY.md（旧的 PATCH-NOTES-dsh-chat.md 原样保留）
 *
 * 本文件带这些补丁：
 *   补丁 4  条级溢出冷存（300 条窗 + archive/<roomId>.jsonl）
 *   补丁 5  整房间冷存（未冷存房间最多 MAX_LIVE_ROOMS=5，老群进 archive/<roomId>.json）
 *   补丁 6  往回翻页 history(roomId, beforeId, limit)
 *   补丁 10 listRooms 窄查询（options.roomId）+ 成员状态 TTL 缓存
 *   补丁 11 @all 改静默投递：非唤醒走 wake:false + 广播口径文案（定向 @ 照旧唤醒）
 *   补丁 12 非唤醒投递带 sourceKind=plugin:dsh-chat（前端只给广播画卡片）
 *   补丁 15 房间内容合并 mergeRooms（老房间接收、源房间删除或掏空）
 *   补丁 16 分页查询 roomPages / roomPage（每页 200 条，第 1 页为最新）
 *   补丁 19 removeMessage（删窗口内任意一条；曾给庄家「先发后删」用，v1.10.0 起不再被它调用）
 *   补丁 20 发言框接管：setComposerAdapter（落盘/投递前的发言改写）+ composerRule（只读前缀提示）
 *   补丁 21 发言适配器可**吞掉**一条消息（rewrite 回 `{consume:true}`）+ supportsComposerConsume 能力标记
 *   补丁 22 发言框**动作条**（适配器声明 actions、点击走 invoke；新增 composerAction 端点）
 *   补丁 23 老房间（冷存、只读）不接管发言框：composerRule 直接回 null（前缀条与动作条都不下发）
 *   补丁 25 `@all` 的「唤醒」档：mentions 里的保留记号 `members` 在发送那一刻展开成全员引用
 *            ⇒ 全员走 wake:true；被唤醒的本地席位**下一条**房间消息自动补 `all`（广播、不再叫醒）
 *   补丁 32 createColdRoom：直接造一个空的老房间（写空的整房归档 + 只留目录条目），
 *            供设置面板「新增冷存房间」与「给合并准备目标」用；重名一律拒且不写盘
 *   补丁 33 deleteRoom：删除一个**本地**房间（目录条目 + 整房归档/溢出文件 + Chatrooms 会话），
 *            只给房间设置面板用；远端主办的房间拒删（只能在主办机上删）
 *   补丁 35 deleteRoom 连**房间会话本身**一起删（会话目录 + 活的 store 行 + 工作区记账 +
 *            `session/disposed` 广播）。补丁 15/33 只摘了工作区记账，会话工件留在盘上 ⇒
 *            侧栏多出一条「未分组」的残留会话；合并删源房间走同一条删除序列。
 *
 * 该说明里有每节的设计、验证证据、备份路径与改前 SHA256、回滚与重打要点。
 * 插件升级/重装会覆盖 lib/，届时照它重打；改动本文件需要重启 DSH 才生效。
 */

const EMPTY = Object.freeze({ version: 1, rooms: [] });
const MAX_MESSAGES_PER_ROOM = 2_000;
// 本地补丁 2026-09-29（补丁 4）：房间历史溢出冷存。见
// profiles/web/.dsh-plugin-backups/PATCH-NOTES-dsh-chat.md。
//
// rooms.json 每发一条消息都要整份重写，而前端只渲染每个房间最新 200 条
// （client.js 的 call("messages", { limit: 200 })，无分页），更早的历史是纯存储负债。
// 这里把超窗的头部消息以 JSONL 追加到 <rooms.json 同目录>/archive/<roomId>.jsonl，
// **落盘成功之后**才从内存里移除并前移 messageOffset —— 与插件自己在
// MAX_MESSAGES_PER_ROOM 处做的裁剪同源（room-store.js 的 send），只是阈值更低、
// 并且丢弃前先存一份。任何失败都回退成「消息留在 rooms.json」，绝不丢内容。
const KEEP_MESSAGES_PER_ROOM = 300;
/** 判断「最后一条已归档记录」时读取的归档文件尾部窗口。 */
const ARCHIVE_TAIL_SCAN_BYTES = 64 * 1024;
// 本地补丁 2026-09-29（补丁 5）：整房间冷存。见 PATCH-NOTES-dsh-chat.md。
//
// 补丁 4 只压得住「一个活跃房间自己变长」；老群本身会一直堆在 rooms.json 里。
// 这里让 rooms.json 里**未冷存的房间最多 MAX_LIVE_ROOMS 个**（按 createdAt 保留最新的），
// 其余的连同全部消息整体搬进 archive/<roomId>.json，房间本身只留一份目录条目
// （messages 清空、coldStored: true）—— 目录条目很便宜，但它是房间能被
// ensureRoomSessions 继续维护、从而在会话里点开看历史的**前提**。
// 冷存后的房间只读：send() 明确拒绝，不再产生新消息。
//
// 本地改动 2026-10-10（用户要求）：**1 → 5**。淘汰时机不变，仍是启动装载与 createRoom
// 各调一次 #coldStoreExtraRooms() ⇒「建到第 6 个活跃房间时，最老的那个当场进归档」。
// 构造函数可用 `maxLiveRooms` 覆盖（与 statusCacheMs 同类：只给直接构造的调用方/测试用，
// 不在 lib/index.js 的 Config schema 里，插件运行时拿到的永远是下面这个默认值）。
const MAX_LIVE_ROOMS = 5;
/** 冷读整房归档时最多缓存多少条（只影响内存占用，不改变归档文件内容）。 */
const COLD_CACHE_MESSAGES = 5_000;
// 本地补丁 2026-09-30（补丁 10）：成员状态探测的缓存窗口与容量。
//
// 房间视图每秒轮询一次 listRooms，而**非活跃**成员的那次探测会走 dsh-bridge →
// sessionPersistence.list()，实测该实现无缓存（遍历目录 + 逐个会话读/解压首行 header
// + stat）。重复探测纯属浪费，这里给状态加一个短 TTL；顺便让 listRooms 支持只列
// 当前房间（前端本来就只 find 一个），把"每个房间的所有成员"降到"当前房间的成员"。
const DEFAULT_STATUS_CACHE_MS = 5_000;
const STATUS_CACHE_MAX = 512;
const ROOM_SESSION_PREFIX = "dsh-chat-room-v3-";
// 本地补丁 2026-10-29（补丁 35）：删房间会话时的重试节奏（毫秒，第一次不等待）。
// `entry.detach()` 之后持久层是**异步**收尾（writer.close() 才放文件句柄），Windows 上
// 立刻 rm 目录会拿到 EBUSY/EPERM ⇒ 按这个梯度重试，总量 ~1.8s，仍失败才记错误。
const SESSION_DELETE_RETRY_MS = Object.freeze([0, 120, 240, 480, 960]);
/** 本地补丁 35：删目录/等写句柄放锁时用的一拍。 */
function pause(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }
// 本地补丁 2026-09-30（补丁 12）：静默广播的 producer kind。官方 Chat 时间线只显示
// source.kind === "user" 的消息，或「唤醒型」插件消息（client.js:9237 把它升级成
// turn-trigger）；插件来源的普通消息一律是 context 节点、被 isVisibleChatNode 排除。
// dsh-chat 前端因此为自己注册了一个可见节点，并靠这个 kind 只认广播、不误抓定向投递
// （定向仍然是 plugin:dsh-bridge）。
const BROADCAST_SOURCE_KIND = "plugin:dsh-chat";
// 本地补丁 2026-10-09（补丁 25）：`@all` 的「唤醒」档。
//
// 前端勾了「唤醒」时往 mentions 里多塞一个保留记号 `members` —— 它在 `#mentions()` 里被展开成
// 房间**当前**全部成员引用（所以落盘的 mentions 里是具体成员、名单不会是陈旧的），于是每个人都
// 命中 `#deliver()` 的 `direct` ⇒ 全员走 wake:true。同时给**真的被投递到位**的本地席位记一个
// 「下一条房间消息补 `all`」的待办（`this.wokenReplies`，内存态）—— 那条回复因此变成广播：
// 全员收到「仅知悉」的投递，但**不叫醒**任何人（不会链式唤醒）。
//
// `members` 与 `all` 一样是保留记号：某个成员别名若恰叫这两个词，就不能按别名 @ 到他
// （与既有的 `all` 口径一致，不另造例外）。
const WAKE_MEMBERS_MENTION = "members";

function copy(value) { return structuredClone(value); }
// 本地补丁 2026-10-04（补丁 16）：分页的页大小与页数。上限与 messages()/history() 的 limit 一致。
const DEFAULT_PAGE_SIZE = 200;
const PAGE_SIZE_MAX = 500;
function normalizePageSize(size) {
  const value = Math.floor(Number(size));
  if (!Number.isFinite(value) || value < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(PAGE_SIZE_MAX, value);
}
function pageCountOf(total, size) { return Math.max(1, Math.ceil(total / size)); }
function ensureText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must not be blank`);
  return value.trim();
}
function memberReference(member) {
  return `session:${encodeURIComponent(member.sessionId)}`;
}
/** 本地补丁 2026-10-09（补丁 25）：「@all + 唤醒」待办的 key —— 房间 + 席位。 */
function wokenReplyKey(roomId, sessionId) { return `${roomId}\u0000${sessionId}`; }
/** 本地补丁 25：mentions 里有没有保留记号 `members`（必须在 `#mentions()` 展开之前问）。 */
function mentionsWakeMembers(list) {
  return Array.isArray(list) && list.some((item) => typeof item === "string" && item.replace(/^@/, "") === WAKE_MEMBERS_MENTION);
}
/**
 * 本地补丁 2026-09-29（补丁 4）：从一段 JSONL 文本里倒着找最后一条带整数 `i` 的记录。
 * 只有 meta 行（或空文本）返回 -1，即「什么都没归档」；被截断的尾行跳过再往前找；
 * 整段里一条完整记录都没有时返回 undefined，调用方据此拒绝溢出而不是冒重复的风险。
 */
function lastArchivedIndex(text) {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    try {
      const record = JSON.parse(line);
      if (Number.isSafeInteger(record?.i)) return record.i;
      if (record?.type === "meta") return -1;
    } catch { /* 被截断的尾行：再往前找一条 */ }
  }
  return undefined;
}

/**
 * 本地补丁 2026-10-04（补丁 15）：把多个房间的记录归并成一条时间线。
 * 按 `sentAt` 升序；同刻保持稳定顺序 —— 目标房间在前，其余按传入顺序，各房间内部保持原顺序。
 * 缺 `sentAt` 的记录按 0 计（本机 send() 一定写 sentAt，只有外部导入的历史会缺）。
 */
function mergeMessageRecords(groups) {
  const rows = [];
  groups.forEach((records, groupIndex) => {
    records.forEach((record, index) => {
      const sentAt = Number.isFinite(record?.m?.sentAt) ? record.m.sentAt : 0;
      rows.push({ message: record.m, groupIndex, index, sentAt });
    });
  });
  rows.sort((a, b) => (a.sentAt - b.sentAt) || (a.groupIndex - b.groupIndex) || (a.index - b.index));
  return rows.map((row) => row.message);
}

/** Durable room store and delivery coordinator for dsh-chat. */
export class DshChatService {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    // The schema defaults these for a composed plugin; a directly constructed
    // store resolves the same directory from `$DSH_HOME`, then `~/.dsh`.
    const home = process.env.DSH_HOME || join(homedir(), ".dsh");
    this.path = config.path ?? join(home, "dsh-chat", "rooms.json");
    this.workspacePath = config.workspacePath ?? join(dirname(this.path), "Chatrooms");
    // 本地补丁 2026-09-29（补丁 4）：历史消息冷存目录，默认与 rooms.json 同级。
    this.archivePath = config.archivePath ?? join(dirname(this.path), "archive");
    // 本地改动 2026-10-10（补丁 5 的参数化）：rooms.json 里最多留几个未冷存房间。
    this.maxLiveRooms = Number.isSafeInteger(config.maxLiveRooms) && config.maxLiveRooms >= 1 ? config.maxLiveRooms : MAX_LIVE_ROOMS;
    this.state = copy(EMPTY);
    this.ready = this.#load();
    this.listeners = new Set();
    this.roomSessionTail = Promise.resolve();
    this.saveTail = Promise.resolve();
    // 本地补丁 2026-09-29（补丁 4）：溢出串行链 + 「最后一条已归档序号」的进程内缓存。
    this.spillTail = Promise.resolve();
    this.archivedIndex = new Map();
    // 本地补丁 2026-09-30（补丁 5）：整房归档的冷读缓存（key = roomId）。
    this.archivedRooms = new Map();
    // 本地补丁 2026-09-30（补丁 10）：成员状态探测的 TTL 缓存（key = sessionId）。
    this.statusCacheMs = Number.isFinite(config.statusCacheMs) && config.statusCacheMs >= 0 ? config.statusCacheMs : DEFAULT_STATUS_CACHE_MS;
    this.statusCache = new Map();
    this.closed = false;
    this.lifetime = new AbortController();
    // 本地补丁 2026-10-04（补丁 20）：外部发言适配器（发言框接管）。缺省 undefined ⇒
    // 本文件的行为与打补丁之前逐字节一致。见 PATCH-NOTES-dsh-chat.md。
    this.composerAdapter = undefined;
    // 本地补丁 2026-10-05（补丁 21）：适配器可以**吞掉**一条消息（`rewrite` 回 `{consume:true}`）。
    // 调用方据此探测宿主能力：没有这个标记就说明补丁 21 没装，**绝不能**把「我处理了」当成
    // 「消息会被拦住」—— 否则命令正文会照常落进房间（可能当众泄密）。
    this.supportsComposerConsume = true;
    // 本地补丁 2026-10-09（补丁 25）：被「@all + 唤醒」叫醒的**本地席位**，其下一条房间消息要自动
    // 补上 `all`（变成广播、不再叫醒任何人）。key = `<roomId>\0<sessionId>`，内存态：
    // 消费一次即删、DSH 重启即清空（重启时那盘对局本来也已经失效）。
    this.wokenReplies = new Set();
  }

  async #load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (parsed?.version === 1 && Array.isArray(parsed.rooms)) {
        this.state = parsed;
        await chmod(dirname(this.path), 0o700); await chmod(this.path, 0o600);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    // 本地补丁 2026-09-29（补丁 4/5）：启动时先溢出超窗历史（补丁 4），再冷存超编的老房间（补丁 5）。
    // 这一步绝不能让 this.ready 变成 rejected —— 房间照常可用优先于瘦身。
    try {
      const spilled = await this.#spillAll();
      const coldStored = await this.#coldStoreExtraRooms();
      if (spilled > 0 || coldStored > 0) await this.#save();
    } catch (error) {
      this.ctx?.logger?.warn?.(`dsh-chat could not spill old room messages: ${String(error)}`);
    }
  }

  async #save() {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    const operation = this.saveTail.then(async () => {
      const parent = dirname(this.path);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await chmod(parent, 0o700);
      const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    });
    this.saveTail = operation.catch(() => {});
    await operation;
  }

  #emit(event) { for (const listener of this.listeners) listener(copy(event)); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  // ─── 本地补丁 2026-10-04（补丁 20）：发言框接管 ─────────────────────────────
  /**
   * 注册（或注销）一个**外部发言适配器**。它是房间与「某个外部功能想接管本房间的发言框」
   * 之间唯一的缝：dsh-chat 不需要知道对方是谁，对方消失时把这里注销即可。
   *
   *   adapter.rewrite({ roomId, author, authorAlias, text, mentions })
   *     → `{ text, mentions }`（用改写后的正文/提及**建消息**）；`{ consume: true }`（**吞掉**这条
   *       消息：不落盘、不投递、不发事件，`send()` 回 `{consumed:true}`，见补丁 21）；
   *       或 `null`/`undefined`（不改）。
   *   adapter.rule({ roomId, sessionId, name })
   *     → `{ prefix, hint }`（发言框上那行只读提示）或 `null`。被 /api/dsh-chat 的
   *       `composerRule` 端点消费，纯展示、不参与发送。
   *   adapter.actions({ roomId, sessionId, name })          // 本地补丁 2026-10-05（补丁 22）
   *     → `[{ id, label, kind: 'button'|'toggle', value?, hint?, disabled? }]`：发言框上那排
   *       **动作条**（按钮 / 勾选框）。dsh-chat 只负责画，语义全在适配器那边；
   *       点击后由 `adapter.invoke({ roomId, id, values, … })` 执行。
   *   adapter.invoke({ roomId, sessionId, name, id, values })
   *     → `{ ok?, text? }`（`ok:false` 时 `text` 是给人看的失败原因）。
   *
   * 缺省（没注册过）时本文件的行为与打补丁前**逐字节相同**。
   * 调用方要探测「宿主会不会真的吞掉」时看 `supportsComposerConsume`（补丁 21 才有的实例属性）。
   * @param adapter - `{ rewrite?, rule? }`；`null`/`undefined` = 注销。
   */
  setComposerAdapter(adapter) { this.composerAdapter = adapter ?? undefined; }

  /**
   * 当前房间的发言框提示（只读前缀 + 一行说明）。**永不抛错** —— 房间 UI 不能因为
   * 外部适配器坏掉而打不开：没适配器 / 房间不存在 / 适配器抛错一律返回 null。
   */
  async composerRule(roomId) {
    if (this.composerAdapter === undefined) return null;
    try {
      await this.ready;
      // 直接查而不是走 #room()：房间不存在（正在建、刚被删、前端拿着旧 id）是正常路径，
      // 不该刷日志，也不该顺手初始化那个房间的字段。
      const room = this.state.rooms.find((item) => item.id === String(roomId));
      // 本地补丁 2026-10-05（补丁 23）：**老房间（冷存、只读）不接管发言框**。
      // 冷存房间的 `send()` 直接抛错（见补丁 5），「谁接管这条发言」根本无从谈起；这里提前
      // 回 null ⇒ 适配器**连问都不问**，前缀条与动作条都不会出现在老房间里。
      // 判据与服务端唯一的那条只读判据同源（`room.coldStored === true`），不另造口径。
      if (room === undefined || room.coldStored === true) return null;
      const input = { roomId: room.id, sessionId: room.linkedSessionId, name: room.name };
      const rule = (await this.composerAdapter.rule?.(input)) ?? null;
      const actions = (await this.composerAdapter.actions?.(input)) ?? [];
      const list = Array.isArray(actions) ? actions : [];
      if (rule === null && list.length === 0) return null;
      return { ...(rule ?? {}), actions: list };
    } catch (error) {
      this.ctx?.logger?.warn?.(`dsh-chat could not resolve the composer rule of room ${roomId}: ${String(error)}`);
      return null;
    }
  }

  /**
   * 本地补丁 2026-10-05（补丁 22）：执行发言框上的一个动作（按钮被按下）。
   *
   * **永不抛**：失败也回一个 `{ok:false, text}`，由前端把它显示给人看 —— 点了没反应是最糟的结果。
   * @param request - `{ roomId, id, values }`；`values` = 当前各勾选框的取值。
   * @returns `{ ok, text }`。
   */
  async composerAction(request = {}) {
    if (this.composerAdapter === undefined) return { ok: false, text: "dsh-chat has no composer adapter" };
    try {
      await this.ready;
      const room = this.state.rooms.find((item) => item.id === String(request.roomId));
      if (room === undefined) return { ok: false, text: `room ${String(request.roomId)} does not exist` };
      const invoke = this.composerAdapter.invoke;
      if (typeof invoke !== "function") return { ok: false, text: "the composer adapter does not support actions" };
      const result = await invoke({ roomId: room.id, sessionId: room.linkedSessionId, name: room.name, id: String(request.id ?? ""), values: request.values ?? {} });
      return { ok: result?.ok !== false, text: typeof result?.text === "string" ? result.text : "" };
    } catch (error) {
      this.ctx?.logger?.warn?.(`dsh-chat composer action "${String(request.id)}" failed in room ${String(request.roomId)}: ${String(error)}`);
      return { ok: false, text: String(error?.message ?? error) };
    }
  }

  async close() {
    this.closed = true;
    this.lifetime.abort();
    this.listeners.clear();
    await Promise.allSettled([this.saveTail, this.spillTail, this.roomSessionTail].filter(Boolean));
  }

  #signal(options) { return AbortSignal.any([this.lifetime.signal, ...(options?.signal ? [options.signal] : [])]); }

  /**
   * List rooms with their members.
   *
   * 本地补丁 2026-09-30（补丁 10）：`options.roomId` 可以只列一个房间 —— 房间视图本来
   * 就只 `find` 自己那一个，而探测**所有**房间的所有成员才是贵的部分（非活跃成员的
   * 一次探测 = 一次全量 sessionPersistence.list()）。不传 roomId 时行为与原来完全一致，
   * Typert 网关那条 `listRooms()` 因此不受影响。
   */
  async listRooms(options) {
    const signal = this.#signal(options);
    await withSignal(this.ready, signal); signal.throwIfAborted();
    const bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge");
    const wanted = typeof options?.roomId === "string" && options.roomId !== "" ? options.roomId : undefined;
    const listed = wanted === undefined ? this.state.rooms : this.state.rooms.filter((room) => room.id === wanted);
    const rooms = [];
    for (const { messages, ...room } of listed) {
      const members = [];
      for (const member of room.members) {
        const view = this.#memberView(member);
        // 本地补丁 2026-09-30（补丁 10）：状态探测带 TTL 缓存；探测不到状态时不写缓存，
        // 免得把一次瞬时失败钉住整个窗口。
        const key = member.sessionId;
        const cached = this.statusCache.get(key);
        if (cached !== undefined && Date.now() - cached.at < this.statusCacheMs) {
          if (cached.state !== undefined) view.state = cached.state;
          members.push(view);
          continue;
        }
        try {
          const status = await withSignal(bridge?.status?.(member.sessionId, signal), signal);
          if (status?.state) view.state = status.state;
        } catch {
          signal.throwIfAborted();
          // A status probe only decorates the row: an unreachable Bridge peer
          // leaves the member without a state instead of failing the whole listing.
          this.ctx?.logger?.debug?.(`dsh-chat could not read the state of member ${member.sessionId}`);
        }
        if (view.state !== undefined) {
          if (this.statusCache.size >= STATUS_CACHE_MAX) this.statusCache.clear();
          this.statusCache.set(key, { at: Date.now(), state: view.state });
        }
        members.push(view);
      }
      rooms.push({ ...room, members, messageCount: messages.length + (room.coldStored === true && Number.isSafeInteger(room.archivedCount) ? room.archivedCount : 0) });
    }
    return copy(rooms);
  }
  async messages(roomId, limit = 100, options) {
    const signal = this.#signal(options);
    await withSignal(this.ready, signal); signal.throwIfAborted(); const room = this.#room(roomId);
    const size = Math.max(1, Math.min(500, limit));
    // 本地补丁 2026-09-29（补丁 5）：冷存房间的历史来自整房归档。读出来的消息只进
    // 冷读缓存，**绝不回写 room.messages** —— 否则下一次 #save() 会把整份归档又写回 rooms.json。
    if (room.coldStored === true) return copy([...(await this.#coldMessages(room)), ...room.messages].slice(-size));
    return copy(room.messages.slice(-size));
  }

  /**
   * 本地补丁 2026-10-04（补丁 19）：删掉房间窗口里的**一条**消息（按 id）。
   *
   * 需求方是庄家插件（dsh-werewolf-dealer v1.9.1）：真人在房间里手打的正文由庄家规范化后
   * 用同一身份重发（带 `【RN-K · 别名】` 前缀与算好的提及），**重发成功之后**再把那条裸正文删掉，
   * 房间里因此只留规范版；删除失败也不丢发言（退化成"房间里多一条裸正文"）。
   *
   * 序号安全性的推导（为什么删窗口内任意一条都行）：
   *   窗口消息的全局序号 = `messageOffset + 下标`，即窗口恰好覆盖 `[O, O+L-1]`；
   *   归档与条级溢出文件里只会有 `< O` 的序号（`#spillRoomNow` 把窗口头部移走时会把 `messageOffset`
   *   同步推到归档末尾之后，而**已落盘的消息不在窗口里**）。
   *   删掉下标 k 之后，k 后面的消息整体前移一位 ⇒ 占用的序号集合变成 `[O, O+L-2]`，
   *   仍然全部 ≥ O，与归档/溢出文件里那些 < O 的序号**不可能撞车**。
   *   （代价只是被删那条的序号会被后来的消息复用，对读侧没有影响：排序与去重都按序号做，
   *   而序号只在同一个窗口内使用。）
   *
   * 只拦一种情况：id 不在内存窗口里（已溢出/已冷存）。
   */
  async removeMessage(roomId, messageId, options) {
    const signal = this.#signal(options);
    await withSignal(this.ready, signal); signal.throwIfAborted();
    const room = this.#room(roomId);
    const id = ensureText(messageId, "message id");
    const at = room.messages.findIndex((message) => message.id === id);
    if (at === -1) return copy({ removed: false, reason: "not-in-window", id });
    room.messages.splice(at, 1);
    await this.#save();
    this.#emit({ kind: "message-removed", roomId: room.id, id });
    return copy({ removed: true, id });
  }

  /**
   * 本地补丁 2026-09-30（补丁 6）：按消息 id 往回翻页，供房间 UI 的「加载更早」使用。
   * 只服务本机房间。
   * @param beforeId - 取这条消息**之前**的 limit 条；省略时取最新 limit 条。
   * @returns `{ messages, hasMore }`；beforeId 找不到时返回空页且 hasMore=false（避免前端空转）。
   */
  async history(roomId, beforeId, limit = 200, options) {
    const signal = this.#signal(options);
    await withSignal(this.ready, signal); signal.throwIfAborted();
    const room = this.#room(roomId);
    const size = Math.max(1, Math.min(500, Number(limit) || 200));
    const all = await this.#historyRecords(room);
    let end = all.length;
    if (typeof beforeId === "string" && beforeId !== "") {
      const at = all.findIndex((record) => record.m.id === beforeId);
      if (at === -1) return copy({ messages: [], hasMore: false });
      end = at;
    }
    const start = Math.max(0, end - size);
    return copy({ messages: all.slice(start, end).map((record) => record.m), hasMore: start > 0 });
  }

  /**
   * 本地补丁 2026-10-04（补丁 16）：房间分页。
   *
   * `roomPages` 只报数（给设置面板里的页数选框用），`roomPage` 取某一页 ——
   * **第 1 页是最新的一页**，与房间视图默认显示的那 200 条一致；页码越大约早。
   * 与 `history()` 一样只读：绝不写回 `room.messages`，也不落盘。
   */
  async roomPages(roomId, size = DEFAULT_PAGE_SIZE, options) {
    const signal = this.#signal(options);
    await withSignal(this.ready, signal); signal.throwIfAborted();
    const room = this.#room(roomId);
    const pageSize = normalizePageSize(size);
    const total = (await this.#historyRecords(room)).length;
    return copy({ total, pageCount: pageCountOf(total, pageSize), size: pageSize });
  }

  async roomPage(roomId, page = 1, size = DEFAULT_PAGE_SIZE, options) {
    const signal = this.#signal(options);
    await withSignal(this.ready, signal); signal.throwIfAborted();
    const room = this.#room(roomId);
    const pageSize = normalizePageSize(size);
    const all = await this.#historyRecords(room);
    const total = all.length;
    const count = pageCountOf(total, pageSize);
    // 页码越界就钳到有效范围（前端选框理论上不会越界，但 RPC 得自己站得住）。
    const wanted = Math.min(Math.max(1, Math.floor(Number(page)) || 1), count);
    const end = Math.max(0, total - (wanted - 1) * pageSize);
    const earliest = Math.max(0, end - pageSize);
    return copy({ messages: all.slice(earliest, end).map((record) => record.m), page: wanted, pageCount: count, total, size: pageSize });
  }

  /**
   * 本地补丁 2026-10-04（补丁 15）：房间内容合并。
   *
   * 两种用法（同一个原语）：
   *   ① `deleteSources: true`（缺省）—— 把任意几个房间的内容并进目标房间，**源房间删除**；
   *   ② `deleteSources: false` —— 把源房间（必须是活跃房间）的内容并进目标房间，**源房间掏空**、
   *      保留房间本身与成员，可以继续在里面发言。
   *
   * 约定（用户拍板）：
   *   - 目标必须是**冷存房间**（老房间）：合并会按用户口径清空目标房间的成员名单，
   *     拿活跃房间当目标会当场把它变成投递不到任何人的死房间，所以直接拒绝；
   *   - 源房间归档**直接删除**，不留任何副本 —— 因此完整性哨兵是必需项（见下 ②）；
   *   - 合并后的房间名保持目标房间原样，成员清空，房间仍是冷存（只读）。
   *
   * 落盘顺序（崩溃只可能留下「rooms.json 落后于归档」这一种状态，重跑即收敛，不会丢内容）：
   *   ① 只读地算出归并结果 → ② 完整性哨兵 → ③ 原子写目标归档 → ④ 改内存 → ⑤ `#save()`
   *   → ⑥ 删源归档 + 摘掉源房间会话（这一步失败只留孤儿文件，不影响正确性）。
   */
  async mergeRooms({ sources, target, deleteSources = true } = {}, options) {
    const signal = this.#signal(options);
    await withSignal(this.ready, signal); signal.throwIfAborted();
    const targetRoom = this.#room(ensureText(target, "target room"));
    if (targetRoom.coldStored !== true) throw new Error(`merge target "${targetRoom.name}" must be a cold-stored room (a live room cannot receive a merge)`);
    const ids = Array.isArray(sources) ? sources.map((item) => ensureText(item, "source room")) : [];
    if (ids.length === 0) throw new Error("merge needs at least one source room");
    if (new Set(ids).size !== ids.length) throw new Error("merge sources must be unique");
    if (ids.includes(targetRoom.id)) throw new Error("the merge target cannot also be a source room");
    const sourceRooms = ids.map((id) => {
      const room = this.#room(id);
      if (deleteSources !== true && room.coldStored === true) throw new Error(`merge source "${room.name}" is cold-stored; a kept source must be a live room`);
      return room;
    });
    signal.throwIfAborted();
    // ① 只读归并：目标在前，源按传入顺序；每个房间取**完整**历史（整房归档 + 条级溢出 + 内存）。
    const groups = [{ room: targetRoom, records: await this.#historyRecords(targetRoom) }];
    for (const room of sourceRooms) groups.push({ room, records: await this.#historyRecords(room) });
    const merged = mergeMessageRecords(groups.map((group) => group.records));
    // ② 完整性哨兵：归并前后必须是同一组消息（按 id 计）。少了或重了就整体放弃 —— 源归档是被删掉的，
    //    这一步是唯一能挡住「写错归档又删源」的闸。
    const before = new Set();
    for (const group of groups) for (const record of group.records) before.add(record.m.id);
    const after = new Set(merged.map((message) => message.id));
    if (before.size !== after.size || after.size !== merged.length || [...before].some((id) => !after.has(id))) {
      throw new Error(`merge would change the message set (${before.size} distinct in, ${merged.length} rows out); nothing was written`);
    }
    signal.throwIfAborted();
    // ③ 原子写目标归档：此刻源房间一个字节都没动。
    const coldStoredAt = Date.now();
    const messages = merged.map((message) => ({ ...message, roomId: targetRoom.id }));
    const payload = {
      type: "room", v: 1, roomId: targetRoom.id, name: targetRoom.name, createdAt: targetRoom.createdAt,
      coldStoredAt, messageOffset: 0, members: [], messages,
      mergedFrom: groups.slice(1).map((group) => ({ id: group.room.id, name: group.room.name, count: group.records.length }))
    };
    await mkdir(this.archivePath, { recursive: true, mode: 0o700 });
    const file = this.#coldFile(targetRoom.id);
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      // 写不进去就整体放弃：此刻 rooms.json 与所有源归档都还没动过。
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    // ④ 归档就位后才动内存。
    targetRoom.messages = [];
    targetRoom.messageOffset = messages.length;
    targetRoom.coldStored = true;
    targetRoom.coldStoredAt = coldStoredAt;
    targetRoom.archivedCount = messages.length;
    targetRoom.members = [];
    this.archivedRooms.delete(targetRoom.id);
    this.archivedIndex.delete(targetRoom.id);
    for (const room of sourceRooms) {
      this.archivedIndex.delete(room.id);
      if (deleteSources === true) continue;
      // ② 的形态：源房间保留但掏空 —— 它的溢出文件随后也会删掉（内容已进目标归档），
      // 否则新消息的序号会和老溢出记录撞在一起、把旧消息重新捞回来。
      room.messages = [];
      room.messageOffset = 0;
    }
    if (deleteSources === true) {
      const removed = new Set(sourceRooms.map((room) => room.id));
      this.state.rooms = this.state.rooms.filter((room) => !removed.has(room.id));
    }
    // ⑤ rooms.json 落盘。
    await this.#save();
    // ⑥ 落盘之后才删源文件、删源房间会话：失败只留孤儿文件。
    // 本地补丁 2026-10-29（补丁 35）：源房间会被删掉 ⇒ 它的房间会话也走**彻底删除**
    // （工件 + 活的 store 行 + 工作区记账 + disposed 广播），不再只摘工作区记账。
    for (const room of sourceRooms) {
      await this.#removeMergedArchives(room.id, deleteSources === true);
      if (deleteSources === true) {
        try { await this.#queueRoomSessionStep(() => this.#deleteRoomSession(room.id)); }
        catch (error) { this.ctx?.logger?.warn?.(`dsh-chat merged away room ${room.id} but could not delete its session: ${String(error)}`); }
      }
    }
    this.#emit({ kind: "rooms-merged", target: targetRoom.id, sources: sourceRooms.map((room) => room.id), messages: messages.length });
    await this.ensureRoomSessions();
    return copy({
      target: targetRoom.id, name: targetRoom.name, messages: messages.length, deleted: deleteSources === true,
      sources: sourceRooms.map((room) => ({ id: room.id, name: room.name }))
    });
  }

  /** 本地补丁 2026-10-04（补丁 15）：删掉被合并房间的归档文件（`full` 时连整房归档一起）。 */
  async #removeMergedArchives(roomId, full) {
    if (full === true) {
      try { await rm(this.#coldFile(roomId), { force: true }); }
      catch (error) { this.ctx?.logger?.warn?.(`dsh-chat could not remove the cold archive of merged room ${roomId}: ${String(error)}`); }
    }
    try { await rm(join(this.archivePath, `${roomId}.jsonl`), { force: true }); }
    catch (error) { this.ctx?.logger?.debug?.(`dsh-chat could not remove the spill file of merged room ${roomId}: ${String(error)}`); }
  }

  /**
   * 本地补丁 2026-10-04（补丁 15）：把一个房间会话从**所有**工作区的记账里摘掉。
   * 必须显式做 —— `ensureRoomSessions()` 只遍历**现存**房间，不会清理已删房间的会话，
   * 那个会话会一直挂在工作区里、点开就是「room does not exist」。
   *
   * 本地补丁 2026-10-29（补丁 35）：改成按**会话 id** 收参数、遍历全部工作区 ——
   * 此前是「先造出 Chatrooms 再摘它一个」，房间会话被人挪到别的工作区时会漏掉一条记账。
   */
  async #detachRoomSession(sessionId) {
    let registry;
    try { registry = this.ctx?.get?.("workspaceRegistry") ?? this.ctx?.workspaceRegistry; }
    catch { registry = undefined; }
    let entities = [];
    try { entities = typeof registry?.list === "function" ? registry.list() : []; }
    catch (error) { this.ctx?.logger?.warn?.(`dsh-chat could not list workspaces while detaching room session ${sessionId}: ${String(error)}`); }
    for (const entity of entities) {
      try { await entity?.detachSession?.(sessionId); }
      catch (error) { this.ctx?.logger?.warn?.(`dsh-chat could not detach room session ${sessionId} from a workspace: ${String(error)}`); }
    }
  }

  /**
   * 本地补丁 2026-10-29（补丁 35）：房间会话的落盘工件路径。
   *
   * 两次取样：
   *   · **拆会话之前**取一次 —— 还没落盘的会话在拆完之后就没有 `pending` 记录了；
   *   · **拆会话之后**再取一次 —— 活着但还没落盘的会话，detach 的收尾（writer.close 的
   *     最后一次 drain）可能才把它写出来；只看前一次就会把刚写出的文件留在盘上。
   *     `stat()`/`findLog()` 是**扫盘**找的（不依赖活状态），所以拆完仍然有效。
   * DSH 0.2.x 的 jsonl 后端把路径放在 `stat()` 返回值的 `location.path`；`locate()` 是不碰盘
   * 的同形接口，用于 stat 缺失/抛错时兜底。
   * @returns 工件文件的绝对路径；从未落盘（或持久层不可用）时 undefined。
   */
  async #roomSessionArtifact(sessionId) {
    let persistence;
    try { persistence = this.ctx?.get?.("sessionPersistence") ?? this.ctx?.sessionPersistence; }
    catch { persistence = undefined; }
    if (!persistence) return undefined;
    try {
      const snapshot = await persistence.stat?.(sessionId);
      const path = snapshot?.location?.path;
      if (typeof path === "string" && path !== "") return path;
    } catch (error) {
      this.ctx?.logger?.debug?.(`dsh-chat could not stat room session ${sessionId}: ${String(error)}`);
    }
    try {
      const located = persistence.locate?.({ id: sessionId, cwd: this.workspacePath });
      const path = located?.path;
      if (typeof path === "string" && path !== "") return path;
    } catch (error) {
      this.ctx?.logger?.debug?.(`dsh-chat could not locate room session ${sessionId}: ${String(error)}`);
    }
    return undefined;
  }

  /**
   * 本地补丁 2026-10-29（补丁 35）：只允许删 `<DSH_HOME>/sessions/<project>/<会话目录>`。
   *
   * 路径是**算出来的**（stat 给的），真删之前必须验形状 —— 与 dsh-session-manager 的
   * `assertSessionDirectory` 同一条判据：相对 sessions 根恰好两段、第二段就是本会话的 id、
   * 不含 `.` / `..` / 空段。对不上就抛错、宁可不删。
   * @returns 规范化后的目录（就是 rm 的目标）。
   */
  #assertRoomSessionDir(directory, sessionId) {
    let homePath;
    try { homePath = this.ctx?.get?.("dshHomePath") ?? this.ctx?.dshHomePath; }
    catch { homePath = undefined; }
    const root = typeof homePath === "function"
      ? homePath("sessions")
      : join(process.env.DSH_HOME || join(homedir(), ".dsh"), "sessions");
    const target = resolve(directory);
    const relativePath = relative(resolve(root), target);
    const parts = relativePath.split(sep);
    if (isAbsolute(relativePath) || parts.length !== 2
      || parts.some((part) => part === "" || part === "." || part === "..")
      || parts[1] !== sessionId) {
      throw new Error(`refusing to delete "${target}": it is not the session directory of "${sessionId}"`);
    }
    return target;
  }

  /**
   * 本地补丁 2026-10-29（补丁 35）：**彻底删除**一个房间的承载会话。
   *
   * 补丁 15/33 只做了「从工作区摘掉」，会话工件留在盘上 ⇒ 侧栏里它就是那条「未分组」的
   * 残留会话，重启也还在。DSH 没有公开的会话删除 API，这里按 dsh-session-manager 的
   * `deleteSession` 同一条顺序自己收尾：
   *   ① 先取工件路径（还没落盘的会话，拆完之后就没有 pending 记录了）
   *   ② 从所有工作区摘记账
   *   ③ 停活的 store 行：`entry.detach()` 会删 store 行并发 `session/disposed`
   *      （持久层据此关写句柄；客户端据此 `api-session/removed` 掉那一行）
   *   ④ 没有活的 store 行时**显式**补一次 `session/disposed` —— 重启后的房间会话只剩盘上
   *      一份工件、`sessions.get()` 是 undefined；不补这一下，已连接的客户端仍会把那一行
   *      留在侧栏（「未分组」就是这么来的）。
   *   ⑤ 拆完再取一次工件路径（收尾可能刚把文件写出来）→ 删会话目录
   *      （Windows 上写句柄可能还没放锁 ⇒ 短重试）
   *
   * 这里**不 flush**：会话反正要删，flush 只会把「已创建未落盘」的会话写成文件，多一次
   * 白写；要持久的事件由 `entry.detach()` 的收尾自己 drain。
   * 也不吞错：rooms.json 已经先落盘了，删不掉文件只会留孤儿，调用方记 warn 即可，不能回滚。
   */
  async #deleteRoomSession(roomId) {
    const sessionId = `${ROOM_SESSION_PREFIX}${roomId}`;
    const before = await this.#roomSessionArtifact(sessionId);
    await this.#detachRoomSession(sessionId);
    let sessions;
    try { sessions = this.ctx?.get?.("sessions") ?? this.ctx?.sessions; }
    catch { sessions = undefined; }
    let detached = false;
    try {
      const entry = sessions?.store?.get?.(sessionId);
      if (entry !== undefined && typeof entry.detach === "function") {
        entry.detach();
        detached = true;
        // 让写后置的退役（最后一次 drain + writer.close）先落完，再动文件。
        await pause(200);
      }
    } catch (error) {
      this.ctx?.logger?.warn?.(`dsh-chat could not detach live room session ${sessionId}: ${String(error)}`);
    }
    if (!detached) {
      try { this.ctx?.emit?.("session/disposed", { id: sessionId }); }
      catch (error) { this.ctx?.logger?.debug?.(`dsh-chat could not emit session/disposed for ${sessionId}: ${String(error)}`); }
    }
    const settled = await this.#roomSessionArtifact(sessionId);
    const artifact = settled ?? before;
    if (artifact === undefined) return;
    const directory = this.#assertRoomSessionDir(dirname(artifact), sessionId);
    let lastError;
    for (const wait of SESSION_DELETE_RETRY_MS) {
      if (wait > 0) await pause(wait);
      try { await rm(directory, { recursive: true, force: true }); return; }
      catch (error) { lastError = error; }
    }
    throw lastError;
  }

  /**
   * 本地补丁 2026-10-29（补丁 35）：把「删房间会话」串到 `ensureRoomSessions` 的同一条链上。
   * 不串的话，启动期的迁移会和删除交错：迁移刚为某个房间建好会话、删除刚好把它删掉，
   * 迁移随后又 `attachSession` 一个已经不存在的 id，工作区里就留一条悬空记账。
   */
  #queueRoomSessionStep(step) {
    const operation = this.roomSessionTail.then(step);
    this.roomSessionTail = operation.catch(() => {});
    return operation;
  }

  /**
   * 直接造一个**空的老房间**（冷存房间）：写空的整房归档 + 在 rooms.json 里放一条目录条目。
   *
   * 局部改动 2026-10-12（补丁 32）：设置面板的「新增冷存房间」用它。用途是**给合并准备一个目标** ——
   * 合并的目标必须是冷存房间（服务端契约：`mergeRooms` 拒绝非冷存目标），而此前只能靠「活跃房间攒到
   * 超编被自动冷存」才会出现老房间。所以这里不接入任何成员、不排期被 #coldStoreExtraRooms 淘汰：
   * 它出生就是冷存态（`coldStored: true`、`messages: []`、`messageOffset: 0`），归档是一份 messages 为空的合法记录。
   *
   * 重名一律拒绝（活跃房间、老房间都算占名）—— 理由与 `createRoom` 同源：房间是按名字寻址的
   * （`chat_join` / `chat_send` 的 `room` 参数收名字），同名房间会让之后每一次按名引用变得歧义。
   * 拒绝路径**不写盘**（先判、后改内存），所以失败时 rooms.json 逐字节不变。
   * @param request - `{ name }`；名字去首尾空白，空名字或非字符串直接拒绝。
   * @returns 新房间的视图（与 `createRoom` 同形）。
   */
  async createColdRoom({ name } = {}, options) {
    const signal = this.#signal(options);
    await withSignal(this.ready, signal); signal.throwIfAborted();
    const roomName = ensureText(name, "room name");
    const existing = this.state.rooms.find((item) => item.name === roomName);
    if (existing) throw new Error(`room "${roomName}" already exists (${existing.id}); join it instead of creating a second one`);
    const room = {
      id: crypto.randomUUID(), name: roomName, createdAt: Date.now(),
      members: [], messages: [], cursor: 0, messageOffset: 0
    };
    // 归档就位之后才动内存（与 #coldStore 同序）：写归档失败 ⇒ 不留半截房间。
    const coldStoredAt = Date.now();
    await this.#writeColdFile(room, {
      type: "room", v: 1, roomId: room.id, name: room.name, createdAt: room.createdAt, coldStoredAt,
      messageOffset: 0, members: [], messages: []
    });
    room.coldStored = true;
    room.coldStoredAt = coldStoredAt;
    room.archivedCount = 0;
    this.state.rooms.push(room);
    await this.#save();
    this.#emit({ kind: "room-created", room: { ...room, messages: [] } });
    await withSignal(this.ensureRoomSessions(), signal);
    return copy({ ...room, messages: [] });
  }

  async createRoom({ name, members = [] }, options) {
    const signal = this.#signal(options);
    await withSignal(this.ready, signal); signal.throwIfAborted();
    const roomName = ensureText(name, "room name");
    const existing = this.state.rooms.find((item) => item.name === roomName);
    // Rooms are addressed by name in chat_join/chat_send, so a second room with the
    // same name would make every later by-name reference ambiguous.
    if (existing) throw new Error(`room "${roomName}" already exists (${existing.id}); join it instead of creating a second one`);
    const room = { id: crypto.randomUUID(), name: roomName, createdAt: Date.now(), members: [], messages: [], cursor: 0, messageOffset: 0 };
    for (const member of members) room.members.push(this.#member(member));
    this.state.rooms.push(room);
    // 本地补丁 2026-09-29（补丁 5）：新群建成即是「最新」，超编的老群当场整体冷存。
    await this.#coldStoreExtraRooms();
    await this.#save(); this.#emit({ kind: "room-created", room: { ...room, messages: [] } });
    await withSignal(this.ensureRoomSessions(), signal);
    return copy({ ...room, messages: [] });
  }

  /** Materialize one visible DSH session per durable room under Chatrooms. */
  ensureRoomSessions() {
    const operation = this.roomSessionTail.then(async () => {
      await this.ready;
      const sessions = this.ctx?.get?.("sessions") ?? this.ctx?.sessions;
      const registry = this.ctx?.get?.("workspaceRegistry") ?? this.ctx?.workspaceRegistry;
      const persistence = typeof this.ctx?.get === "function" ? this.ctx.get("sessionPersistence") : this.ctx?.sessionPersistence;
      if (!sessions || !registry) return;
      await mkdir(this.workspacePath, { recursive: true });
      const workspace = await registry.create(this.workspacePath, "Chatrooms");
      let changed = false;
      for (const room of this.state.rooms) {
        if (room.sessionId && !room.sessionId.startsWith(ROOM_SESSION_PREFIX)) {
          await workspace.detachSession?.(room.sessionId);
          delete room.sessionId;
          changed = true;
        }
        const sessionId = room.sessionId ?? `${ROOM_SESSION_PREFIX}${room.id}`;
        let session = sessions.get(sessionId);
        const stored = await persistence?.stat?.(sessionId);
        if (!stored && (!room.sessionId || persistence)) {
          if (!session) {
            const time = Date.now();
            session = sessions.create(sessionId, {
              meta: { cwd: this.workspacePath },
              seed: [
                { type: "turn/start", seq: 0, time, data: { turn: 1 } },
                { type: "chat/room-link", seq: 1, time: time + 1, data: { roomId: room.id, name: room.name }, ignorable: true },
                { type: "turn/end", seq: 2, time: time + 2, data: { turn: 1, reason: { kind: "completed" } } }
              ]
            });
          }
          const events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : session.events;
          const existingLink = events?.find?.((event) => event.type === "chat/room-link");
          if (existingLink && existingLink.data?.roomId !== room.id) throw new Error(`room session ${sessionId} is already linked to another room`);
          if (!existingLink) throw new Error(`room session ${sessionId} is missing its room link`);
          const titles = this.ctx?.get?.("sessionTitle") ?? this.ctx?.sessionTitle;
          titles?.rename?.(session, room.name);
          if (persistence) {
            // sessions.create publishes a live Session; only the storage handle
            // persists its seed. A plain room has no AgentLoop to own that write.
            const handle = await persistence.create(session.header, { inheritedEventCount: session.inheritedEventCount ?? 0 });
            try {
              await handle.append(typeof session.snapshotEvents === "function" ? session.snapshotEvents() : session.events);
              await handle.flush();
            } finally { await handle.close(); }
          } else { await sessions.flush?.(session); }
        }
        if (room.sessionId !== sessionId) {
          room.sessionId = sessionId;
          changed = true;
        }
        await workspace.attachSession(sessionId);
      }
      if (changed) await this.#save();
    });
    this.roomSessionTail = operation.catch(() => {});
    return operation;
  }

  /** Resolve a room by durable id or by its unique human-readable name. */
  async resolveRoom(reference, options) {
    const signal = this.#signal(options);
    await withSignal(this.ready, signal); signal.throwIfAborted();
    const needle = ensureText(reference, "room reference");
    const matches = this.state.rooms.filter((room) => room.id === needle || room.name === needle);
    if (matches.length === 0) throw new Error(`room "${needle}" does not exist`);
    if (matches.length > 1) throw new Error(`room reference "${needle}" is ambiguous; use its id`);
    return copy({ ...matches[0], messages: [] });
  }

  async addMember(roomId, member, options) {
    const signal = this.#signal(options);
    await withSignal(this.ready, signal); signal.throwIfAborted(); const room = this.#room(roomId); const normalized = this.#member(member);
    const existing = room.members.find((item) => item.sessionId === normalized.sessionId);
    if (existing) {
      for (const field of ["alias", "workspaceTitle"]) if (normalized[field]) existing[field] = normalized[field];
      await this.#save();
      return copy(existing);
    }
    room.members.push(normalized);
    await this.#save(); this.#emit({ kind: "member-added", roomId, member: normalized });
    return copy(normalized);
  }

  /** Remove one member durably. Absent members resolve without writing. */
  async removeMember(roomId, member, options) {
    const signal = this.#signal(options);
    await withSignal(this.ready, signal); signal.throwIfAborted(); const room = this.#room(roomId);
    if (!member || member.kind !== "session") throw new TypeError("member.kind must be session");
    const sessionId = ensureText(member.sessionId, "member sessionId");
    const index = room.members.findIndex((item) => item.kind === member.kind && item.sessionId === sessionId);
    if (index === -1) return null;
    const [removed] = room.members.splice(index, 1);
    // 本地补丁 25：席位被移出后，它身上那份「下一条消息补 all」的待办一并清掉 ——
    // 否则它以后被重新拉回房间时，第一条消息会莫名其妙变成全员广播。
    this.wokenReplies.delete(wokenReplyKey(roomId, sessionId));
    await this.#save(); this.#emit({ kind: "member-removed", roomId, member: this.#memberView(removed) });
    return copy(removed);
  }

  /**
   * 本地补丁 2026-10-21（补丁 33）：删除一个**本地**房间。
   *
   * 本地补丁 2026-10-29（补丁 35）：房间的**承载会话**也一起彻底删除。
   * 补丁 33 只把会话从 Chatrooms 摘掉，会话工件仍留在盘上 ⇒ 侧栏多出一条「未分组」的
   * 残留会话，点开是空壳、重启也在。现在走 #deleteRoomSession（工件目录 + 活的 store 行 +
   * 全工作区记账 + `session/disposed` 广播）。
   *
   * 删除 = 目录条目、全部历史、房间会话三样一起消失，复用 mergeRooms 删除源房间的
   * 同一条清理序列（#removeMergedArchives + #deleteRoomSession）：
   *   ① 从 state.rooms 摘掉条目 → ② #save() → ③ 删整房归档与条级溢出文件 → ④ 删房间会话。
   * 落盘在删文件之前 ⇒ 中途崩溃最多留下孤儿文件，不会出现「rooms.json 说有、历史/会话没了」的房间。
   * 顺序与 mergeRooms 一致，所以恢复/排障口径也一致。
   *
   * 边界：
   *   · 不可撤销（归档与房间会话一起删）。要保留内容请先用 mergeRooms 并进老房间。
   *   · 该房间成员的「下一条消息补 all」待办一并清掉 —— 删掉的房间不该留任何待办。
   *   · 会话删不掉（文件被占/越界）不回滚：房间已经没了，只记 warn 并回 `sessionRemoved:false`。
   */
  async deleteRoom(roomId, options) {
    const signal = this.#signal(options);
    await withSignal(this.ready, signal); signal.throwIfAborted();
    const room = this.#room(ensureText(roomId, "room id"));
    signal.throwIfAborted();
    for (const member of room.members) this.wokenReplies.delete(wokenReplyKey(room.id, member.sessionId));
    this.archivedRooms.delete(room.id);
    this.archivedIndex.delete(room.id);
    this.state.rooms = this.state.rooms.filter((item) => item.id !== room.id);
    await this.#save();
    await this.#removeMergedArchives(room.id, true);
    let sessionRemoved = false;
    try { await this.#queueRoomSessionStep(() => this.#deleteRoomSession(room.id)); sessionRemoved = true; }
    catch (error) { this.ctx?.logger?.warn?.(`dsh-chat deleted room ${room.id} but could not delete its session: ${String(error)}`); }
    this.#emit({ kind: "room-deleted", roomId: room.id, name: room.name });
    return copy({ id: room.id, name: room.name, sessionRemoved });
  }

  async send({ roomId, author, authorAlias, text, mentions }, options) {
    const signal = this.#signal(options);
    await withSignal(this.ready, signal); signal.throwIfAborted();
    const room = this.#room(roomId);
    // 本地补丁 2026-09-29（补丁 5）：冷存房间只读 —— 历史在 archive/<roomId>.json，
    // 想继续用就先按 PATCH-NOTES 的恢复步骤把它捞回 rooms.json。
    if (room.coldStored === true) throw new Error(`room "${room.name}" is cold-stored and read-only; its history is in archive/${room.id}.json`);
    const authorId = ensureText(author, "author");
    const member = room.members.find((item) => item.sessionId === authorId && item.kind === "session");
    if (member && !member.alias && authorAlias) { member.alias = ensureText(authorAlias, "author alias"); await this.#save(); }
    signal.throwIfAborted();
    // 本地补丁 2026-10-04（补丁 20）：**在构造消息之前**问一次外部适配器要不要改写这条发言。
    // 改写后的正文/提及直接用于建消息 ⇒ 落盘、投递、唤醒都只发生这一次，调用方因此不需要
    // 「先发一条、再删掉换一条」。适配器抛错时退回原文发送（绝不吞掉用户的消息）。
    let outgoingText = text;
    let outgoingMentions = mentions;
    let speechRewritten = false;
    if (this.composerAdapter !== undefined) {
      let rewritten;
      try {
        rewritten = await this.composerAdapter.rewrite?.({ roomId: room.id, author: authorId, authorAlias, text, mentions });
      } catch (error) {
        // 适配器出错绝不吞消息：退回原文发送（与没有适配器时同形）。
        this.ctx?.logger?.warn?.(`dsh-chat composer adapter could not rewrite a message of room ${room.id}: ${String(error)}`);
      }
      // 本地补丁 2026-10-05（补丁 21）：**吞掉**这条消息 —— 适配器已经把它处理完了
      // （本机实例：房间里打 /ww-* 由庄家执行）。它不该落盘、不该投递、也不该发事件，
      // 否则「命令正文」会作为普通消息出现在房间里。
      if (rewritten?.consume === true) return { roomId: room.id, author: authorId, consumed: true };
      if (rewritten !== undefined && rewritten !== null) {
        // 逐字段回落：只有真的被替换过才算「接管」（残缺返回体因此不会谎报接管）。
        if (typeof rewritten.text === "string") { outgoingText = rewritten.text; speechRewritten = true; }
        if (Array.isArray(rewritten.mentions)) { outgoingMentions = rewritten.mentions; speechRewritten = true; }
      }
    }
    // 本地补丁 2026-10-09（补丁 25）：这个席位刚被「@all + 唤醒」叫醒过 ⇒ 它的这条回复补上 `all`。
    // 结果是**广播**：除作者外全员收到一条「仅知悉、不要回复」的投递，但谁都不会被叫醒（不链式唤醒）。
    // 三条边界：
    //   · **是「换成一条纯广播」而不是「追加」**：追加的话，这条回复自己 @ 到的人仍命中 `direct`
    //     ⇒ 会被当场叫起来（正是要避免的链式唤醒）；
    //   · 适配器**改写**过的消息一律不碰（庄家算好的提及归它自己），但待办照旧消费 —— 它确实回过话了，
    //     不能把 all 拖到很久以后那条无关消息上；
    //   · 被适配器**吞掉**的消息在上面就 return 了、走不到这里 ⇒ 待办留着给下一条真消息。
    // 待办用 `has` 读、**消息真的建出来之后**才删：提及解析失败 / 正文空白 / 发送被中止都不该吃掉它。
    const wokenReply = this.wokenReplies.has(wokenReplyKey(room.id, authorId));
    if (wokenReply && !speechRewritten) outgoingMentions = ["all"];
    // 本地补丁 25：这条到底有没有把「全员名单」发出去 —— **在适配器之后**问：适配器若替换了
    // mentions（庄家返回 text/mentions），`members` 记号就没了、唤醒根本没发生，这时绝不能再给人
    // 记待办（否则庄家算好的「下一位」会平白变成一条全员广播）。
    const wakeAll = mentionsWakeMembers(outgoingMentions);
    signal.throwIfAborted();
    const message = { id: crypto.randomUUID(), roomId, author: authorId, authorAlias: member?.alias ?? (authorAlias ? ensureText(authorAlias, "author alias") : undefined), text: ensureText(outgoingText, "message"), mentions: this.#mentions(room, outgoingMentions), sentAt: Date.now(), deliveries: [] };
    if (wokenReply) this.wokenReplies.delete(wokenReplyKey(room.id, authorId));
    room.messages.push(message);
    if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
      const removed = room.messages.length - MAX_MESSAGES_PER_ROOM;
      room.messages.splice(0, removed);
      room.messageOffset = (room.messageOffset ?? 0) + removed;
    }
    // Retain the message and completed deliveries even when a later recipient is cancelled.
    try { await this.#deliver(room, message, signal, wakeAll); }
    finally {
      // 本地补丁 2026-09-29（补丁 4）：先把超窗头部冷存，再落盘 —— 这样内存里的
      // messages 永远 ≤ KEEP_MESSAGES_PER_ROOM，rooms.json 不再无上限增长。
      // 溢出失败只记一条 warn：消息留在文件里，退化成打补丁之前的行为。
      try { await this.#spillRoom(room); }
      catch (error) { this.ctx?.logger?.warn?.(`dsh-chat could not spill old messages of room ${room.id}: ${String(error)}`); }
      await this.#save(); this.#emit({ kind: "message", message, speechRewritten });
    }
    return copy(message);
  }
  #room(roomId) {
    const room = this.state.rooms.find((item) => item.id === roomId);
    if (!room) throw new Error(`room ${roomId} does not exist`);
    if (!Array.isArray(room.messages)) room.messages = [];
    if (!Number.isSafeInteger(room.messageOffset) || room.messageOffset < 0) room.messageOffset = 0;
    return room;
  }
  // ─── 本地补丁 2026-09-29（补丁 5）：整房间冷存 ────────────────────────────────
  /** 一个房间的整房归档文件（JSON，每次冷存整份重写）。 */
  #coldFile(roomId) { return join(this.archivePath, `${roomId}.json`); }

  /** 读整房归档；不存在或解析失败都按「没有」处理（房间照常可用优先）。 */
  async #readColdFile(roomId) {
    try { return JSON.parse(await readFile(this.#coldFile(roomId), "utf8")); }
    catch { return undefined; }
  }

  /** 冷读：整房归档读进内存缓存（按 mtime+size 失效），绝不写回 state。返回带全局序号的记录。 */
  async #coldRecords(room) {
    const file = this.#coldFile(room.id);
    let info;
    try { info = await stat(file); } catch { return []; }
    const stamp = `${info.mtimeMs}:${info.size}`;
    const cached = this.archivedRooms.get(room.id);
    if (cached !== undefined && cached.stamp === stamp) return cached.records;
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      const base = Number.isSafeInteger(parsed?.messageOffset) ? parsed.messageOffset : 0;
      const list = Array.isArray(parsed?.messages) ? parsed.messages.slice(-COLD_CACHE_MESSAGES) : [];
      const records = list.map((message, index) => ({ i: base + index, m: message }));
      this.archivedRooms.set(room.id, { stamp, records });
      return records;
    } catch (error) {
      this.ctx?.logger?.warn?.(`dsh-chat could not read the cold archive of room ${room.id}: ${String(error)}`);
      return [];
    }
  }

  /** 冷存房间的历史消息（只要消息本身；带全局序号的版本见 #coldRecords）。 */
  async #coldMessages(room) { return (await this.#coldRecords(room)).map((record) => record.m); }

  /**
   * 本地补丁 2026-09-30（补丁 6）：一个房间的**完整**本地历史 —— 冷存归档（或条级溢出）
   * 加内存消息，按全局序号去重排序。只服务分页读取，绝不写回 state。
   */
  async #historyRecords(room) {
    const union = new Map();
    if (room.coldStored === true) {
      for (const record of await this.#coldRecords(room)) union.set(record.i, record.m);
    } else {
      for (const record of await this.#readSpillRecords(room.id)) union.set(record.i, record.m);
    }
    const offset = Number.isSafeInteger(room.messageOffset) && room.messageOffset >= 0 ? room.messageOffset : 0;
    (room.messages ?? []).forEach((message, index) => union.set(offset + index, message));
    return [...union.entries()].sort((a, b) => a[0] - b[0]).map(([i, m]) => ({ i, m }));
  }

  /**
   * rooms.json 里未冷存的房间超过 maxLiveRooms 时，把按 createdAt 最老的那些整体冷存。
   * 永不抛出：冷存失败就让它继续留在 rooms.json 里（宁可不瘦身，也不丢房间）。
   * @returns 被冷存的房间数。
   */
  async #coldStoreExtraRooms() {
    const limit = this.maxLiveRooms;
    const live = this.state.rooms.filter((room) => room.coldStored !== true);
    if (live.length <= limit) return 0;
    const keep = new Set(live.slice().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, limit).map((room) => room.id));
    let stored = 0;
    for (const room of live) {
      if (keep.has(room.id)) continue;
      try { await this.#coldStore(room); stored += 1; }
      catch (error) { this.ctx?.logger?.warn?.(`dsh-chat could not cold-store room ${room.id}: ${String(error)}`); }
    }
    return stored;
  }

  /**
   * 把一份整房归档写到 `archive/<roomId>.json`（先写 .tmp 再原子 rename）。
   * 局部改动 2026-10-12（补丁 32）：从 #coldStore 里抽出来，让「新建冷存房间」复用同一份写入路径 ——
   * 归档格式只有这一处定义，两边不会漂。
   * @returns 写进去的消息条数。
   */
  async #writeColdFile(room, payload) {
    await mkdir(this.archivePath, { recursive: true, mode: 0o700 });
    const file = this.#coldFile(room.id);
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
    return payload.messages.length;
  }

  /** 整房冷存：归档写完（原子 rename）之后，才把房间在 rooms.json 里掏成目录条目。 */
  async #coldStore(room) {
    const union = await this.#coldUnion(room);
    const indices = [...union.keys()].sort((a, b) => a - b);
    const messages = indices.map((index) => union.get(index));
    const coldStoredAt = Date.now();
    const offset = Number.isSafeInteger(room.messageOffset) && room.messageOffset >= 0 ? room.messageOffset : 0;
    const payload = {
      type: "room", v: 1, roomId: room.id, name: room.name, createdAt: room.createdAt, coldStoredAt,
      messageOffset: indices.length > 0 ? indices[0] : offset,
      members: room.members, messages
    };
    await this.#writeColdFile(room, payload);
    // 归档就位之后才动内存：房间仍在 state.rooms 里（房间会话因此继续被维护），
    // 只是消息清空、messageOffset 推到归档末尾之后。
    room.messages = [];
    room.messageOffset = indices.length > 0 ? indices.at(-1) + 1 : offset;
    room.coldStored = true;
    room.coldStoredAt = coldStoredAt;
    room.archivedCount = messages.length;
    this.archivedRooms.delete(room.id);
    // 条级溢出文件（补丁 4）已折进整房归档；清不掉也无妨 —— #coldUnion 按全局序号去重。
    try { await rm(join(this.archivePath, `${room.id}.jsonl`), { force: true }); }
    catch (error) { this.ctx?.logger?.debug?.(`dsh-chat could not remove the folded spill file of room ${room.id}: ${String(error)}`); }
    this.ctx?.logger?.info?.(`dsh-chat cold-stored room ${room.id} (${messages.length} messages) into archive/${room.id}.json`);
  }

  /** 把「已有整房归档 + 条级溢出 + 内存消息」按全局序号合并成一张表（同一序号只留一条）。 */
  async #coldUnion(room) {
    const union = new Map();
    const existing = await this.#readColdFile(room.id);
    const list = Array.isArray(existing?.messages) ? existing.messages : [];
    const base = Number.isSafeInteger(existing?.messageOffset) ? existing.messageOffset : 0;
    for (let index = 0; index < list.length; index += 1) union.set(base + index, list[index]);
    for (const record of await this.#readSpillRecords(room.id)) if (!union.has(record.i)) union.set(record.i, record.m);
    const offset = Number.isSafeInteger(room.messageOffset) && room.messageOffset >= 0 ? room.messageOffset : 0;
    const live = Array.isArray(room.messages) ? room.messages : [];
    for (let index = 0; index < live.length; index += 1) union.set(offset + index, live[index]);
    return union;
  }

  /** 读完整个条级溢出文件（补丁 4 的 JSONL），返回带全局序号的记录；坏行跳过。 */
  async #readSpillRecords(roomId) {
    let text;
    try { text = await readFile(join(this.archivePath, `${roomId}.jsonl`), "utf8"); }
    catch { return []; }
    const records = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const record = JSON.parse(line);
        if (Number.isSafeInteger(record?.i) && record.m) records.push({ i: record.i, m: record.m });
      } catch { /* 被截断的尾行：内容仍在 rooms.json 或整房归档里 */ }
    }
    return records;
  }

  // ─── 本地补丁 2026-09-29（补丁 4）：历史消息溢出冷存 ──────────────────────────
  /** 一个房间的归档文件（JSONL，只追加）。 */
  #archiveFile(roomId) { return join(this.archivePath, `${roomId}.jsonl`); }

  /** 启动迁移：把所有超窗房间的历史溢出一次，返回离开 rooms.json 的消息条数。 */
  async #spillAll() {
    let spilled = 0;
    for (const room of this.state.rooms) {
      try { spilled += await this.#spillRoom(room); }
      catch (error) { this.ctx?.logger?.warn?.(`dsh-chat could not spill room ${room.id}: ${String(error)}`); }
    }
    return spilled;
  }

  /** 串行化溢出：并发的两次 send 不能交错写同一个房间的归档。 */
  #spillRoom(room) {
    const operation = this.spillTail.then(() => this.#spillRoomNow(room));
    this.spillTail = operation.catch(() => {});
    return operation;
  }

  /**
   * 把房间头部超出 KEEP_MESSAGES_PER_ROOM 的消息追加进归档，成功之后才从内存移除。
   * 归档记录里的全局序号 `i`（= messageOffset + 当时的数组下标）就是幂等标记：先追加、
   * 后落盘，即使中间被强杀，下一次也只会补上缺的那几条，不会重复。
   * @returns 离开 rooms.json 的消息条数。
   */
  async #spillRoomNow(room) {
    const messages = Array.isArray(room.messages) ? room.messages : [];
    const overflow = messages.length - KEEP_MESSAGES_PER_ROOM;
    if (overflow <= 0) return 0;
    const offset = Number.isSafeInteger(room.messageOffset) && room.messageOffset >= 0 ? room.messageOffset : 0;
    let last = this.archivedIndex.get(room.id);
    if (last === undefined) {
      last = await this.#readLastArchivedIndex(room.id);
      if (last === undefined) throw new Error(`cannot read the last archived message of room ${room.id}; leaving its history in rooms.json`);
      this.archivedIndex.set(room.id, last);
    }
    if (last < offset) {
      // 归档落后于 offset：老版本的 2000 条硬裁丢掉过一段（那段无法找回）。
      // 只能从 offset 继续归档，归档里的序号跳号本身就是这段空档的记录。
      this.ctx?.logger?.debug?.(`dsh-chat room ${room.id} has an unarchived gap of ${offset - last - 1} message(s)`);
    }
    const from = Math.max(0, Math.max(last + 1, offset) - offset);
    if (from < overflow) {
      const records = messages.slice(from, overflow).map((message, index) => ({ i: offset + from + index, m: message }));
      await this.#appendArchive(room, records);
    }
    messages.splice(0, overflow);
    room.messageOffset = offset + overflow;
    this.archivedIndex.set(room.id, Math.max(last, room.messageOffset - 1));
    return overflow;
  }

  /** 追加若干条归档记录；文件不存在（或为空）时先写一行 meta。 */
  async #appendArchive(room, records) {
    await mkdir(this.archivePath, { recursive: true, mode: 0o700 });
    const file = this.#archiveFile(room.id);
    let existing = true;
    try { existing = (await stat(file)).size > 0; }
    catch (error) { if (error?.code !== "ENOENT") throw error; existing = false; }
    const header = existing ? "" : `${JSON.stringify({ type: "meta", v: 1, roomId: room.id, name: room.name, offset: room.messageOffset ?? 0, createdAt: Date.now() })}\n`;
    await appendFile(file, `${header}${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  }

  /**
   * 倒着读归档文件，找出最后一条记录的全局序号。
   * @returns 没有归档时 -1；整段尾部窗口里读不出完整记录时 undefined（调用方据此拒绝溢出）。
   */
  async #readLastArchivedIndex(roomId) {
    const file = this.#archiveFile(roomId);
    let handle;
    try { handle = await open(file, "r"); }
    catch (error) { if (error?.code === "ENOENT") return -1; throw error; }
    try {
      const { size } = await handle.stat();
      if (size === 0) return -1;
      const length = Math.min(size, ARCHIVE_TAIL_SCAN_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      let text = buffer.toString("utf8");
      if (length < size) {
        // 尾部窗口可能从一行中间开始：丢掉首个不完整的行再解析。
        const breakAt = text.indexOf("\n");
        text = breakAt === -1 ? "" : text.slice(breakAt + 1);
      }
      const found = lastArchivedIndex(text);
      if (found !== undefined || length >= size) return found;
      // 极少见：单条归档消息比尾部窗口还长。整份读一次兜底。
      return lastArchivedIndex(await readFile(file, "utf8"));
    } finally { await handle.close(); }
  }

  #mentions(room, mentions) {
    if (mentions === undefined) return [];
    if (!Array.isArray(mentions)) throw new TypeError("mentions must be an array");
    const tokens = mentions.map((item) => ensureText(item, "mention").replace(/^@/, ""));
    // 本地补丁 25：`members` 只在**同一条里也有 `all`** 时才展开 —— 「勾了但没 @all ⇒ 等同没勾」
    // 是用户口径，必须在服务端也成立（否则任何调用方随手写一句 members 就能把全房间叫起来，
    // 而那正是勾选框之外的一条隐藏入口）。单独一个 members 因此等于一个空提及（静默无操作）。
    const wakeAll = tokens.includes("all");
    const resolved = tokens.flatMap((reference) => {
      // 本地补丁 2026-10-09（补丁 25）：保留记号 `members` = 「房间当前全部成员」。
      // 在**这一刻**展开（而不是让前端把名单塞过来）⇒ 名单永远与房间一致：成员刚被移出不会
      // 让这条发送报「提及不存在」，刚加入的也会被叫醒。展开结果就是具体成员引用，照旧落盘。
      if (reference === WAKE_MEMBERS_MENTION) return wakeAll ? room.members.map(memberReference) : [];
      if (reference === "all") return [reference];
      const byReference = room.members.find((member) => memberReference(member) === reference);
      if (byReference) return [memberReference(byReference)];
      const byId = room.members.filter((member) => member.sessionId === reference);
      if (byId.length === 1) return [memberReference(byId[0])];
      if (byId.length > 1) throw new Error(`session mention "${reference}" is ambiguous; choose it from the member list`);
      const matches = room.members.filter((member) => member.alias?.localeCompare(reference, undefined, { sensitivity: "accent" }) === 0);
      if (matches.length === 0) throw new Error(`session mention "${reference}" does not match a room member`);
      if (matches.length > 1) throw new Error(`session mention "${reference}" is ambiguous; choose it from the member list`);
      return [memberReference(matches[0])];
    });
    return [...new Set(resolved)];
  }
  #member(member) {
    if (!member || member.kind !== "session") throw new TypeError("member.kind must be session");
    const normalized = { kind: member.kind, sessionId: ensureText(member.sessionId, "member sessionId") };
    for (const field of ["alias", "workspaceTitle"]) if (member[field]) normalized[field] = ensureText(member[field], `member ${field}`);
    if (!normalized.alias) {
      const session = (this.ctx?.get?.("sessions") ?? this.ctx?.sessions)?.get?.(normalized.sessionId);
      const title = session && (this.ctx?.get?.("sessionTitle") ?? this.ctx?.sessionTitle)?.get?.(session)?.title;
      if (title) normalized.alias = ensureText(title, "member alias");
    }
    return normalized;
  }
  #memberView(member) {
    const view = { ...member };
    if (!view.alias) {
      const session = (this.ctx?.get?.("sessions") ?? this.ctx?.sessions)?.get?.(view.sessionId);
      const title = session && (this.ctx?.get?.("sessionTitle") ?? this.ctx?.sessionTitle)?.get?.(session)?.title;
      if (title) view.alias = title;
    }
    return view;
  }

  async #deliver(room, message, signal, wakeAll = false) {
    const bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge");
    const recipients = message.mentions.includes("all")
      ? [...room.members]
      : room.members.filter((member) => message.mentions.includes(memberReference(member)));
    for (const member of recipients) {
      signal.throwIfAborted();
      if (member.sessionId === message.author) continue;
      // 本地补丁 2026-09-30（补丁 12）：@all 是「通知」不是「召集」——被单独点名的成员
      // 照旧唤醒（followup），只被 @all 命中的成员只投递、不唤醒（dsh-bridge wake:false
      // → Session.append，落在目标会话表面、模型下次请求照读）。
      // 非唤醒的广播额外带上 BROADCAST_SOURCE_KIND：官方 Chat 时间线对插件来源的消息一律
      // 按 context 节点处理且不显示，所以 dsh-chat 前端注册了一个自己的可见节点，并靠这个
      // kind 只认广播、不误抓定向投递。说明见 PATCH-NOTES-dsh-chat.md。
      const direct = message.mentions.includes(memberReference(member));
      try {
        if (!bridge) throw new Error("dsh-bridge is not installed");
        await bridge.deliverExternal(`chat:${room.id}:${message.author}`, member.sessionId, this.#agentDeliveryText(room, message, direct), { id: message.id, transport: "chat", signal, wake: direct, ...(direct ? {} : { sourceKind: BROADCAST_SOURCE_KIND }) });
        message.deliveries.push({ member: member.sessionId, kind: member.kind, status: "delivered" });
        // 本地补丁 2026-10-09（补丁 25）：这条是「@all + 唤醒」且**投递真的成功** ⇒ 给这个本地席位
        // 记一笔「下一条房间消息补 all」。投递失败（bridge 报错）不记 —— 没叫醒它就不该改它的话。
        if (wakeAll && direct) this.wokenReplies.add(wokenReplyKey(room.id, member.sessionId));
      } catch (error) { message.deliveries.push({ member: member.sessionId, kind: member.kind, status: "failed", error: String(error.message ?? error) }); signal.throwIfAborted(); }
    }
  }

  #agentDeliveryText(room, message, direct = true) {
    // 补丁 12：广播（只被 @all 命中）的投递文案必须与定向区分 —— 否则「只让会话看到」
    // 的成员会误以为要回房间。
    if (!direct) return `[${room.name}] ${message.text}\n\n[DSH Chat broadcast: awareness notice only — no reply is expected and you must not post this to the room. Do not call chat_send for it. A direct @mention arrives as its own message with its own instruction.]`;
    const sender = room.members.find((member) => member.sessionId === message.author);
    if (sender) {
      const alias = sender.alias ?? message.authorAlias ?? message.author;
      return `[${room.name}] ${message.text}\n\n[DSH Chat delivery: a normal assistant reply stays only in this session and is not posted to the room. To answer ${alias} in the room, call chat_send with room "${room.name}" and mentions ["${alias}"].]`;
    }
    return `[${room.name}] ${message.text}\n\n[DSH Chat delivery: this message was sent by a human room participant. A normal assistant reply stays only in this session and is not posted to the room. To reply visibly to the human, call chat_send with room "${room.name}" and omit mentions. This posts to the room timeline without waking another agent.]`;
  }

}
