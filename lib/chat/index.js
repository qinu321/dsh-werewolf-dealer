import { DshChatService } from "./room-store.js";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineTool } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { readFile, stat } from "node:fs/promises";

/*
 * 本地补丁索引 —— 本文件被改动的地方都标成「本地补丁 YYYY-MM-DD（补丁 N）」，编号对应
 * 下面这份说明的章节（路径相对 DSH 根目录）：
 *
 *   profiles/web/.dsh-plugin-backups/dsh-chat-PATCH-ALL/APPLY.md   ← 合并补丁（唯一入口）
 *   逐条历史与原始动机：同目录 HISTORY.md（旧的 PATCH-NOTES-dsh-chat.md 原样保留）
 *
 * 本文件带这些补丁：
 *   补丁 2  房间头像（avatars.json → /api/dsh-chat 的 avatars 端点）
 *   补丁 6  往回翻页的 RPC 端点 history
 *   补丁 10 listRooms 透传 roomId（只列当前房间）
 *   补丁 15 房间内容合并的 RPC 端点 mergeRooms
 *   补丁 16 分页端点 roomPages / roomPage
 *   补丁 19 removeMessage 端点（删窗口内任意一条）
 *   补丁 20 composerRule 端点（发言框接管：只读前缀提示；改写钩子本身是宿主本地 API）
 *   补丁 22 composerAction 端点（发言框动作条被按下时执行）
 *   补丁 32 createColdRoom 端点（设置面板的「新增冷存房间」：直接造一个空的老房间）
 *   补丁 33 deleteRoom 端点（房间设置面板的「删除房间」；只删本地房间，远端主办的拒删）
 *
 * 该说明里有每节的设计、验证证据、备份路径与改前 SHA256、回滚与重打要点。
 * 插件升级/重装会覆盖 lib/，届时照它重打；改动本文件需要重启 DSH 才生效。
 */

/** The initial public contract version for dsh-chat. */
export const DSH_CHAT_PROTOCOL_VERSION = 1;

/** dsh-chat has a host identity; its interactive client is the next milestone. */
export const DSH_CHAT_STAGE = "room-sessions";

export const name = "dsh-chat";
/** Default state directory: an explicit configured path, then `$DSH_HOME`, then `~/.dsh`. */
const DEFAULT_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
export const Config = Schema.object({
  path: Schema.string().default(join(DEFAULT_HOME, "dsh-chat", "rooms.json")).description("Durable room state file."),
  workspacePath: Schema.string().default(join(DEFAULT_HOME, "dsh-chat", "Chatrooms")).description("Workspace used for room sessions.")
});
// Local delivery (dsh-bridge) and the session/workspace services are the load
// prerequisites; the store only coordinates local rooms.
export const inject = ["connection", "tools", "dshBridge", "sessions", "workspaceRegistry", "sessionTitle", "sessionPersistence"];

/*
 * 本地补丁 2026-09-28：房间头像图片支持。
 *
 * 房间 UI 的头像原本只有「首字母/别名缩写色块」，没有图片通道。这里给出一份
 * 由文件驱动的映射，浏览器端按需取图：
 *
 *   <rooms.json 同目录>/avatars.json
 *   { "session-946e…": "E:\\…\\role_a.png", "大D(v4.1)": "https://…/b.png",
 *     "dsh-chat-room-v3-…": "data:image/png;base64,…" }
 *
 * 键 = 成员会话 id 或成员别名（也接受房间自身的会话 id，即真人发言那侧的 id）；
 * 值 = 本地图片路径、http(s) 链接或 data URL。图片以 data URL 走既有的
 * `/api/dsh-chat` POST 通道回给前端，因此不新增路由、不新增对外暴露面；
 * 任何缺失/超限/读不到/格式不对的条目都只是被跳过，前端回落到首字母徽章 ——
 * 头像是装饰，绝不能让房间打不开。
 */
/** Image extensions the local avatar map may reference, mapped to their data-URL MIME. */
const AVATAR_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" };
/** Upper bound on one inlined avatar; anything larger is skipped instead of shipped. */
const AVATAR_MAX_BYTES = 4 * 1024 * 1024;
/** Upper bound on the whole inlined set: one room reply must stay a sane JSON body. */
const AVATAR_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
/** Inlined avatar per absolute path, keyed by mtime+size so an edited file is re-read. */
const AVATAR_FILE_CACHE = new Map();

/**
 * 本地补丁 2026-10-07（补丁 2 修订）：**一个图片路径可以挂多个别名** ——
 * 别名写在键里，用 `|` 分隔（也接受 `、` 与 `,`）：`"大D(v4.1)|大Dv4.1|大D": "…/deepseekv41.webp"`。
 * 这样同一张图不必复制成多行；本地图只内联一次、8 MiB 预算也只计一次。
 */
const AVATAR_KEY_SEPARATORS = /[|、,]/u;

/** Path of the avatar map beside the durable room state file. */
export function avatarMapPath(config = {}) {
  return join(dirname(config.path ?? join(DEFAULT_HOME, "dsh-chat", "rooms.json")), "avatars.json");
}

/**
 * Read one local image as a data URL, reusing a cached copy while the file is unchanged.
 * @param path - absolute image path from the map.
 * @param mime - data-URL MIME derived from the extension.
 * @returns the data URL, or undefined when the file is missing/empty/oversized.
 */
async function inlineAvatar(path, mime) {
  let info;
  try { info = await stat(path); } catch { return undefined; }
  if (!info.isFile() || info.size === 0 || info.size > AVATAR_MAX_BYTES) return undefined;
  const stamp = `${info.mtimeMs}:${info.size}`;
  const cached = AVATAR_FILE_CACHE.get(path);
  if (cached !== undefined && cached.stamp === stamp) return cached.dataUrl;
  try {
    const bytes = await readFile(path);
    const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
    AVATAR_FILE_CACHE.set(path, { stamp, dataUrl });
    return dataUrl;
  } catch { return undefined; }
}

/**
 * 本地补丁 2026-10-07（补丁 2 修订）：把键切成别名列表（`|` / `、` / `,` 分隔，去空白、丢空段）。
 * @param key - 映射文件里的原始键。
 * @returns 别名数组；没有可用名字时为空数组。
 */
export function avatarAliases(key) {
  return String(key)
    .split(AVATAR_KEY_SEPARATORS)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * Resolve the room avatars advertised to the browser UI.
 * @param config - plugin config carrying the durable state path.
 * @returns an object keyed by member id/alias with a browser-usable image URL.
 */
export async function loadChatAvatars(config = {}) {
  let declared;
  try { declared = JSON.parse(await readFile(avatarMapPath(config), "utf8")); } catch { return {}; }
  if (declared === null || typeof declared !== "object" || Array.isArray(declared)) return {};
  const avatars = {};
  // 本地补丁 2026-10-07：同一张本地图只内联一次 ⇒ 多个别名共用同一条 data URL，预算也只记一份。
  const inlinedByReference = new Map();
  let inlined = 0;
  for (const [key, value] of Object.entries(declared)) {
    // A leading underscore marks a documentation key, never a member identity.
    if (key.startsWith("_")) continue;
    const aliases = avatarAliases(key);
    if (aliases.length === 0) continue;
    const reference = typeof value === "string" ? value : value?.url ?? value?.path;
    if (typeof reference !== "string" || reference === "") continue;
    if (/^(https?:|data:)/i.test(reference)) {
      for (const alias of aliases) avatars[alias] = reference;
      continue;
    }
    const mime = AVATAR_MIME[extname(reference).toLowerCase()];
    if (mime === undefined) continue;
    let dataUrl = inlinedByReference.get(reference);
    if (dataUrl === undefined) {
      if (inlined >= AVATAR_TOTAL_MAX_BYTES) continue;
      dataUrl = await inlineAvatar(reference, mime);
      if (dataUrl === undefined) continue;
      inlined += dataUrl.length;
      inlinedByReference.set(reference, dataUrl);
    }
    for (const alias of aliases) avatars[alias] = dataUrl;
  }
  return avatars;
}

function exposeRemote(instance, method) {
  Remote(method)(instance[method], {
    private: false,
    static: false,
    name: method,
    addInitializer(initializer) { initializer.call(instance); }
  });
}

/** Failure envelope for one logical RPC endpoint. */
function rpcFailure(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

/**
 * Build the `/api/dsh-chat` endpoint handler.
 *
 * A non-200 answer reaches the browser as an opaque transport failure, so
 * business failures travel as the RpcResult error branch, and only an unknown
 * endpoint or a malformed `args` envelope is a caller error.
 * @param handlers - endpoint table keyed by the wire endpoint name.
 * @returns an endpoint handler returning an RpcResult for every input.
 */
export function createRpcHandler(handlers) {
  return async (endpoint, payload, options = {}) => {
    const handler = Object.hasOwn(handlers, endpoint) ? handlers[endpoint] : undefined;
    if (handler === undefined) return rpcFailure("bad-request", `unknown dsh-chat endpoint: ${endpoint}`);
    const args = payload?.args;
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      return rpcFailure("bad-request", `dsh-chat endpoint ${endpoint} requires an args object`);
    }
    try {
      options.signal?.throwIfAborted();
      return { ok: true, value: await handler(args ?? {}, options) };
    } catch (error) {
      return rpcFailure("internal", error?.message ?? String(error));
    }
  };
}

/** JSON response carrying one RpcResult envelope. */
function envelopeResponse(envelope) {
  return new Response(JSON.stringify(envelope), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

/**
 * Answer one room UI POST on `/api/dsh-chat`.
 *
 * Connection applies the browser fence to everything under `/api`, so this only
 * has to decode the envelope, dispatch the endpoint, and always answer 200 with
 * an RpcResult — a body that is not JSON, a missing endpoint, or a throwing
 * handler would otherwise surface in the browser as an opaque transport
 * failure rather than a message a human can act on.
 * @param handler - the endpoint handler built by `createRpcHandler`.
 * @param request - the incoming request.
 * @returns the response carrying the RpcResult.
 */
export async function handleChatRequest(handler, request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return envelopeResponse(rpcFailure("bad-request", "request body is not JSON"));
  }
  const endpoint = payload?.endpoint;
  if (typeof endpoint !== "string" || endpoint === "") {
    return envelopeResponse(rpcFailure("bad-request", "endpoint must be a non-empty string"));
  }
  try {
    return envelopeResponse(await handler(endpoint, payload, { signal: request.signal }));
  } catch (error) {
    return envelopeResponse(rpcFailure("internal", error?.message ?? String(error)));
  }
}

/** Host Remote. The source-mode Typert gateway derives JSON request shapes. */
export class DshChatRemote extends TypertRemoteService {
  constructor(ctx, config) {
    super(ctx, "dshChat");
    this.chat = new DshChatService(ctx, config);
    for (const method of ["listRooms", "messages", "history", "createRoom", "createColdRoom", "addMember", "removeMember", "send"]) exposeRemote(this, method);
  }
  async listRooms() { return this.chat.listRooms(); }
  async messages(roomId, limit) { return this.chat.messages(roomId, limit); }
  // 本地补丁 2026-09-30（补丁 6）：往回翻页（房间 UI 的「加载更早」）。
  async history(roomId, beforeId, limit) { return this.chat.history(roomId, beforeId, limit); }
  async createRoom(request) { return this.chat.createRoom(request); }
  // 局部改动 2026-10-12（补丁 32）：让 Typert 那条 RPC 通道也知道这个方法（与上面其他方法同形）。
  async createColdRoom(request) { return this.chat.createColdRoom(request); }
  async addMember(roomId, member) { return this.chat.addMember(roomId, member); }
  async removeMember(roomId, member) { return this.chat.removeMember(roomId, member); }
  async send(request) { return this.chat.send(request); }
}

/** Host entrypoint. */
export function apply(ctx, config) {
  const remote = new DshChatRemote(ctx, config);
  ctx.effect(() => async () => remote.chat.close());
  void remote.chat.ensureRoomSessions().catch((error) => ctx.logger?.warn?.(`dsh-chat room session migration failed: ${String(error)}`));
  const handlers = {
    // 本地补丁 2026-09-30（补丁 10）：房间视图传 roomId 只列当前房间（省掉无关成员探测）。
    // 不带 args 时行为不变，Typert 网关那条 Remote listRooms() 仍走全量。
    listRooms: ({ roomId } = {}, options) => remote.chat.listRooms({ ...options, roomId }),
    messages: ({ roomId, limit }, options) => remote.chat.messages(roomId, limit, options),
    // 本地补丁 2026-09-30（补丁 6）：往回翻页。前端在按钮点击时调用，轮询路径不变。
    history: ({ roomId, beforeId, limit }, options) => remote.chat.history(roomId, beforeId, limit, options),
    // 本地补丁 2026-10-04（补丁 15）：房间内容合并（老房间接收；源房间删除或掏空）。
    mergeRooms: ({ sources, target, deleteSources } = {}, options) => remote.chat.mergeRooms({ sources, target, deleteSources }, options),
    // 本地补丁 2026-10-21（补丁 33）：删除本地房间。只挂在房间 UI 的 RPC 上，**不注册成工具** ——
    // 任何会话都能删任意房间的话，误删面比「合并删除源房间」大得多。
    deleteRoom: ({ roomId } = {}, options) => remote.chat.deleteRoom(roomId, options),
    // 本地补丁 2026-10-04（补丁 16）：分页（设置面板的页数选框 + 跳页）。
    roomPages: ({ roomId, size } = {}, options) => remote.chat.roomPages(roomId, size, options),
    roomPage: ({ roomId, page, size } = {}, options) => remote.chat.roomPage(roomId, page, size, options),
    // 本地补丁 2026-10-04（补丁 19）：删房间里的一条消息（窗口内任意一条）。
    removeMessage: ({ roomId, messageId } = {}, options) => remote.chat.removeMessage(roomId, messageId, options),
    // 本地补丁 2026-10-04（补丁 20）：发言框接管的只读提示（外部适配器提供；没有就返回 null）。
    composerRule: ({ roomId } = {}, options) => remote.chat.composerRule(roomId, options),
    // 本地补丁 2026-10-05（补丁 22）：发言框动作条被按下时执行（失败也回 200 + `{ok:false,text}`）。
    composerAction: ({ roomId, id, values } = {}, options) => remote.chat.composerAction({ roomId, id, values }, options),
    createRoom: ({ request }, options) => remote.chat.createRoom(request, options),
    // 局部改动 2026-10-12（补丁 32）：设置面板的「新增冷存房间」（直接造一个空的老房间）。
    // 失败一律走 RpcResult 的 error 分支（handleChatRequest 把业务失败也包成 200），
    // 前端因此拿到的是 message，不是传输层异常 —— 输入框要不要留着由它自己判。
    createColdRoom: ({ name } = {}, options) => remote.chat.createColdRoom({ name }, options),
    addMember: ({ roomId, member }, options) => remote.chat.addMember(roomId, member, options),
    removeMember: ({ roomId, member }, options) => remote.chat.removeMember(roomId, member, options),
    send: ({ request }, options) => remote.chat.send(request, options),
    // 本地补丁 2026-09-28：房间头像映射（见 loadChatAvatars 的说明）。
    avatars: (_args, options) => { options?.signal?.throwIfAborted?.(); return loadChatAvatars(config); }
  };
  // The room UI's transport is a Connection Fetch route under `/api` — the one
  // path this deployment mounts and fences for browser callers — not a
  // per-plugin RPC channel: `connection.rpc.handle("/dsh-chat", …)` produced no
  // reachable route here, so every call fell through to the web carrier's static
  // fallback, which answers a non-GET request with 405.
  ctx.inject(["connection"], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.connection.fetch.register({
      path: "/api/dsh-chat",
      methods: ["POST"],
      requestBody: "buffered",
      fetch: (request) => handleChatRequest(createRpcHandler(handlers), request)
    }), "dsh-chat: room route");
  });
  const owningSession = (exec) => {
    if (!exec.agent) throw new Error("dsh-chat tools require an owning DSH session");
    return String(exec.agent.session.id);
  };
  const owningAlias = (exec) => exec.agent ? ctx.sessionTitle?.get?.(exec.agent.session)?.title : undefined;
  const roomOutput = {
    schema: { type: "object", additionalProperties: false, properties: {
      id: { type: "string", required: true }, name: { type: "string", required: true }
    } },
    render: (_args, value) => [{ type: "text", text: `${value.name} (${value.id})` }]
  };
  ctx.tools.register(defineTool({
    name: "chat_create",
    description: "Create a DSH group chat and join the current session to it. Use when the user asks to create a group chat by name.",
    parameters: { name: { type: "string", required: true, description: "Human-readable room name." } }, output: roomOutput,
    async execute(args, exec) {
      const sessionId = owningSession(exec);
      const room = await remote.chat.createRoom({ name: args.name, members: [{ kind: "session", sessionId, alias: owningAlias(exec) }] }, { signal: exec.signal });
      return { id: room.id, name: room.name };
    }
  }));
  ctx.tools.register(defineTool({
    name: "chat_join",
    description: "Join the current DSH session to an existing local group chat. Use when the user asks to join a named group chat.",
    parameters: { room: { type: "string", required: true, description: "Exact room name or room id." } }, output: roomOutput,
    async execute(args, exec) {
      const room = await remote.chat.resolveRoom(args.room, { signal: exec.signal });
      await remote.chat.addMember(room.id, { kind: "session", sessionId: owningSession(exec), alias: owningAlias(exec) }, { signal: exec.signal });
      return { id: room.id, name: room.name };
    }
  }));
  ctx.tools.register(defineTool({
    name: "chat_invite",
    description: "Add another live local DSH session to a group chat. Use only with an exact session id; the target receives subsequent group messages.",
    parameters: {
      room: { type: "string", required: true, description: "Exact room name or room id." },
      sessionId: { type: "string", required: true, description: "Target local DSH session id." }
    }, output: roomOutput,
    async execute(args, exec) {
      const room = await remote.chat.resolveRoom(args.room, { signal: exec.signal });
      const status = await ctx.dshBridge.status(args.sessionId, exec.signal);
      if (!status || status.state === "archived") throw new Error(`session ${args.sessionId} is not live`);
      await remote.chat.addMember(room.id, { kind: "session", sessionId: args.sessionId }, { signal: exec.signal });
      return { id: room.id, name: room.name };
    }
  }));
  ctx.tools.register(defineTool({
    name: "chat_send",
    description: "Send a message to a DSH group chat as the current session. Omit mentions for a human-only room message; use an exact member alias or session id to target sessions, or [\"all\"] for broadcast.",
    parameters: {
      room: { type: "string", required: true, description: "Exact room name or room id." },
      text: { type: "string", required: true, description: "Message body." },
      mentions: { type: "array", items: { type: "string" }, description: "Optional exact member aliases or stable session ids, or all. Message text is never parsed for delivery." }
    },
    output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, delivered: { type: "number", required: true } } }, render: (_args, value) => [{ type: "text", text: `Sent ${value.id} to ${value.delivered} member(s).` }] },
    async execute(args, exec) {
      const room = await remote.chat.resolveRoom(args.room, { signal: exec.signal });
      const sessionId = owningSession(exec);
      if (!room.members.some((member) => member.kind === "session" && member.sessionId === sessionId)) throw new Error("the current session is not a member of this room");
      const message = await remote.chat.send({ roomId: room.id, author: sessionId, authorAlias: owningAlias(exec), text: args.text, mentions: args.mentions }, { signal: exec.signal });
      return { id: message.id, delivered: message.deliveries.filter((item) => item.status === "delivered").length };
    }
  }));
}

export { DshChatService, Remote };
