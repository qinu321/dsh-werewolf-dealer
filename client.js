/**
 * dsh-werewolf-dealer —— 客户端半边（v2.0.0 起同时承载群聊房间 UI 与庄家卡片/弹窗）。
 *
 * 本文件由 `tools/merge-client.mjs` 生成：
 *   · chatHalf   ← dsh-chat 的 `lib/client.js`（快照提交 46118cb，来源见 lib/chat/VENDOR.md）
 *   · dealerHalf ← 本插件 v1.36.0 的 `client.js`（原文件在 git 历史里）
 * 合并后**本文件就是唯一真源**：改 UI 直接改这里，不要再跑合并脚本（脚本里有二次合并保护）。
 *
 * 两个半边各自一层 IIFE：它们都有各自的 `module/exports/React/h`、各自的 i18n 命名空间
 * （`dsh-chat` / `dsh-werewolf-dealer`）与各自的槽位 key，互不共享词法作用域。
 * 外层只做两件事：按顺序调两个 `apply`、把两个 `inject` 取并集。
 */

window.__ModuleLoader__.load({
  id: "dsh-werewolf-dealer",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    // ── 群聊半边（房间时间线、发言框、合并/分页/设置、广播卡片）────────────────────────
    const chatHalf = (() => {
      const module = { exports: {} };
      const exports = module.exports;
      const React = require("react");
      const h = React.createElement;

    /*
     * 本地补丁索引 —— 本文件被改动的地方都标成「本地补丁 YYYY-MM-DD（补丁 N）」，编号对应
     * 下面这份说明的章节（路径相对 DSH 根目录）：
     *
     *   profiles/web/.dsh-plugin-backups/dsh-chat-PATCH-ALL/APPLY.md   ← 合并补丁（唯一入口）
     *   逐条历史与原始动机：同目录 HISTORY.md（旧的 PATCH-NOTES-dsh-chat.md 原样保留）
     *
     * 本文件带这些补丁：
     *   补丁 1  房间卡片脱离「已完成回合」的步骤折叠
     *   补丁 2  图片头像（读服务端 avatars 映射，失败回落首字母徽章）
     *   补丁 3  @all 全员广播按钮
     *   补丁 6  「加载更早的消息」+ 往回翻页（补丁 26 起钉住某页时也有「加载更晚的消息」）
     *   补丁 7  房间标题栏吸顶（设置按钮常驻）
     *   补丁 8  正文 Markdown（复用 shell 的 MarkdownText + 错误边界回落纯文本）
     *   补丁 9  「回到顶部」圆形按钮
     *   补丁 10 listRooms 传当前房间 id
     *   补丁 12 静默广播在成员会话里的可见卡片（自注册 chat 节点 + BroadcastNotice）
     *   补丁 14 不严格换行（段内单换行走真实 <br>；围栏/缩进代码与行内代码内逐字节保留）
     *   补丁 15 房间内容合并面板（勾来源 / 选老房间作目标 / 二次确认）
     *   补丁 16 设置里的「跳到页」选框 + 钉住某页的时间线（回到最新）
     *   补丁 17 表情图的提升锚点移到正文块（图落在名字行下面）
     *   补丁 18 页码翻转（界面第 1 页 = 最早）+ 老房间默认第 1 页 / 活跃房间默认最后一页
     *   补丁 20 发言框接管的只读前缀条（问 composerRule 端点；纯提示，改写发生在服务端）
     *   补丁 22 发言框动作条（适配器声明 actions；与提及按钮同一排、右对齐）
     *   补丁 23 老房间（冷存、只读）不画任何发言控件：整条发言框换成一行「已归档」提示
     *   补丁 24 房间标题（卡片 h2 / 设置面板 / 发言框 placeholder）跟随 rooms.json，不再用建群
     *          那一刻冻结在 chat/room-link 事件里的名字
     *   补丁 25 @all 芯片加「唤醒」勾选框；勾上时发送的 mentions 多一个保留记号 `members`
     *          （服务端展开成全员引用 ⇒ 全员被唤醒）
     *   补丁 26 时间线底部的「加载更晚的消息」：钉住某页时点它＝跳到**下一页的顶部**
     *          （与设置里选页同一个动作，不是把下一页接在当前页后面）
     *   补丁 32 **「合并房间」面板**里的「新增冷存房间」：输入名字直接建一个空的老房间（只读、可当合并目标）；
     *          重名不执行、输入框留着，成功则收起表单并把回执留在面板里，且**就地刷新候选列表并预设为目标**
     *          （2026-10-12 GUI 改动：入口原在设置面板，已挪进合并面板）
     *   补丁 33 房间设置面板底部的「删除房间」：二次确认后删本房间（条目 + 归档 + Chatrooms 会话）；
     *          **只给人工用**，远端主办的房间按钮禁用（服务端也会拒）
     *
     * 该说明里有每节的设计、验证证据、备份路径与改前 SHA256、回滚与重打要点。
     * 插件升级/重装会覆盖 lib/，届时照它重打；本文件是纯前端，改完刷新页面即生效。
     */
    // 本地补丁 2026-09-30（补丁 8/9）：复用 shell 暴露的 UI 原语 ——
    // `@deepseek-ai/dsh-client-ui-primitives` 是 shell 的 seed 模块（见 dsh-web-frontend
    // 里那份 seed 表：react / cordis / client-store / ui-slots / ui-primitives / ui-dockkit），
    // 拿到的是**与 DSH 主会话同一个实例**，所以 markdown 渲染与图标外观天然一致。
    // 取不到就回落纯文本 + 文字箭头：绝不能因为拿不到原语让整个房间打不开。
    const primitives = (() => { try { return require("@deepseek-ai/dsh-client-ui-primitives"); } catch { return undefined; } })();
    const MarkdownText = primitives?.MarkdownText;
    const IconChevronUp = primitives?.IconChevronUpOutlineRegular;
    const inject = ["slots", "connection", "uiConversation", "sessions", "workspaces", "locale"];
    const NS = "dsh-chat";
    // 本地补丁 2026-09-30（补丁 12）：静默广播的标记。kind 由服务端（room-store.js 的
    // BROADCAST_SOURCE_KIND）写在消息 source 上；文本标记用来把投递时附加的说明块切掉，
    // 卡片里只显示「[房间名] 正文」这一段。
    const BROADCAST_SOURCE_KIND = "plugin:dsh-chat";
    const BROADCAST_TEXT_MARK = "\n\n[DSH Chat broadcast:";
    // 本地补丁 2026-10-04（补丁 16）：分页的页大小 —— 与补丁 6 的轮询窗口一样是 200 条，
    // 所以「第 1 页」就是房间视图默认显示的那一屏。
    const PAGE_SIZE = 200;
    const dictionaries = {
  "zh": {
    "you": "你",
    "session": "会话",
    "idle": "空闲",
    "running": "运行中",
    "waking": "唤醒中…",
    "offline": "离线",
    "hostOffline": "主机离线",
    "archived": "已归档",
    "missing": "不存在",
    "connecting": "连接中…",
    "unknown": "未知",
    "roomSettings": "聊天设置",
    "settings": "设置",
    "roomMessages": "聊天消息",
    "startConversation": "开始聊天",
    "quietHint": "提及某个会话后，它才会收到通知。",
    "loadEarlier": "加载更早的消息",
    "loadLater": "加载更晚的消息",
    "toTop": "回到顶部",
    "copy": "复制",
    "copied": "已复制",
    "codeBlock": "代码块",
    "wrapLines": "自动换行",
    "unwrapLines": "取消自动换行",
    "footnotes": "脚注",
    "closeSettings": "关闭聊天设置",
    "members": "成员",
    "removeMember": "移出聊天",
    "noMembers": "尚未添加成员。",
    "addSession": "添加会话",
    "addHint": "依次选择工作区和会话。已归档的工作区和会话不会显示。",
    "workspace": "工作区",
    "searchSessions": "搜索此工作区中的会话",
    "availableSessions": "可添加的会话",
    "noMatching": "没有匹配的会话。",
    "allMembers": "此工作区的所有会话都已加入。",
    "noWorkspaces": "暂无包含会话的活跃工作区。",
    "mentionSession": "提及会话",
    "mentionHint": "提及会话以发送通知",
    "send": "发送聊天消息",
    "message": "发送消息至",
    "roomMembers": "位成员",
    "mention": "提及",
    "mentionAll": "提及全部",
    "mentionAllHint": "把这条消息投递给房间里所有成员（默认只通知、不唤醒）",
    "wakeAll": "唤醒",
    "wakeAllHint": "勾上后，这条 @all 会真的把每个成员叫起来（不勾＝只通知，谁也不被唤醒）",
    "wakeAllIdle": "勾了也不会生效：本条没有 @all，或点名由接管方代填",
    "composerTakeover": "发言框自动补全",
    "composerTakeoverHint": "前缀与点名会自动补全，只打正文即可",
    "composerActions": "房间操作",
    "composerActionFailed": "操作失败",
    "roomArchived": "这个房间已归档（只读），只能翻阅历史。",
    "broadcast": "房间广播",
    "loadingMessages": "正在读取聊天记录…",
    "working": "处理中…",
    "merge": "合并房间",
    "mergeHint": "把几个房间的内容并成一条时间线。目标必须是老房间（只读的归档房间）。",
    "mergeSource": "来源",
    "mergeTarget": "目标",
    "mergeOld": "老房间",
    "mergeLive": "活跃",
    "mergeCount": "条消息",
    "mergeCreatedAt": "建于",
    "thisRoom": "本房间",
    "mergeToTarget": "合并到目标房间（删除源房间）",
    "mergeRemoveSources": "源房间及其聊天会话会被删除，归档不保留副本。",
    "mergeDrainSelf": "把本房间内容并入目标并清空本房间",
    "mergeDrainSelfCold": "本房间是已归档的老房间（只读），不能保留 —— 要并掉它请用上面的「合并到目标房间（删除源房间）」。",
    "mergeConfirm": "确认合并（不可撤销）",
    "mergeBusy": "正在合并…",
    "mergeNone": "还没有老房间可以当目标。",
    "mergeNeedTarget": "请选择一个目标房间。",
    "mergeNeedSource": "请勾选至少一个来源房间。",
    "mergeDone": "合并完成",
    "mergeDeletedSelf": "本房间已被删除，请切到目标房间。",
    "mergeDrainedSelf": "本房间内容已清空。",
    "mergeClose": "关闭合并面板",
    "deleteRoom": "删除房间",
    "deleteRoomHint": "删除本房间及其归档，并从 Chatrooms 移除；不可撤销。",
    "deleteRoomConfirm": "确认删除（不可撤销）",
    "deleteRoomBusy": "正在删除…",
    "deleteRoomDone": "房间已删除，请切换到其它会话。",
    "pages": "消息分页",
    "pagesHint": "每页 200 条；第 1 页是最早的一页，数字越大越接近最新。老房间默认停在第 1 页，活跃房间默认停在最后一页。",
    "jumpPage": "跳到页",
    "pagePrefix": "第 ",
    "pageSuffix": " 页",
    "viewing": "正在查看",
    "backToLatest": "回到最新",
    "createColdRoom": "新增冷存房间",
    "newColdRoomName": "房间名",
    "newColdRoomPlaceholder": "输入房间名",
    "newColdRoomConfirm": "确定",
    "newColdRoomCancel": "取消",
    "newColdRoomHint": "输入名字按确定，直接建一个空的**老房间**（冷存、只读），用来当合并目标；它不接收发言，也不会被自动淘汰。",
    "newColdRoomNeedName": "请输入房间名。",
    "newColdRoomDone": "已创建：",
    "newColdRoomBusy": "正在创建…",
    "newColdRoomClose": "收起新增冷存房间"
  },
  "en": {
    "you": "You",
    "session": "Session",
    "idle": "Idle",
    "running": "Running",
    "waking": "Waking…",
    "offline": "Offline",
    "hostOffline": "Host offline",
    "archived": "Archived",
    "missing": "Missing",
    "connecting": "Connecting…",
    "unknown": "Unknown",
    "roomSettings": "Room settings",
    "settings": "Settings",
    "roomMessages": "Room messages",
    "startConversation": "Start the conversation",
    "quietHint": "Messages stay quiet until you mention a session.",
    "loadEarlier": "Load earlier messages",
    "loadLater": "Load later messages",
    "toTop": "Back to top",
    "copy": "Copy",
    "copied": "Copied",
    "codeBlock": "Code",
    "wrapLines": "Wrap lines",
    "unwrapLines": "Unwrap lines",
    "footnotes": "Footnotes",
    "closeSettings": "Close room settings",
    "members": "Members",
    "removeMember": "Remove from room",
    "noMembers": "No members yet.",
    "addSession": "Add session",
    "addHint": "Choose a workspace, then a session. Archived workspaces and sessions stay hidden.",
    "workspace": "Workspace",
    "searchSessions": "Search sessions in this workspace",
    "availableSessions": "Available sessions",
    "noMatching": "No matching sessions.",
    "allMembers": "All sessions in this workspace are already members.",
    "noWorkspaces": "No active workspaces with sessions.",
    "mentionSession": "Mention a session",
    "mentionHint": "Mention a session to notify it",
    "send": "Send room message",
    "message": "Message",
    "roomMembers": "room members",
    "mention": "Mention",
    "mentionAll": "Mention all",
    "mentionAllHint": "Deliver this message to every member in this room (notify only by default)",
    "wakeAll": "Wake",
    "wakeAllHint": "Tick to actually wake every member with this @all (unticked = notify only)",
    "wakeAllIdle": "No effect here: this message has no @all, or the mentions are filled in by the takeover adapter",
    "composerTakeover": "Composer auto-fill",
    "composerTakeoverHint": "The prefix and mentions are filled in automatically — just type the body",
    "composerActions": "Room actions",
    "composerActionFailed": "The action failed",
    "roomArchived": "This room is archived (read-only); you can browse its history only.",
    "broadcast": "Room broadcast",
    "loadingMessages": "Loading messages…",
    "working": "Working…",
    "merge": "Merge rooms",
    "mergeHint": "Fold several rooms into one timeline. The target must be an old (cold-stored, read-only) room.",
    "mergeSource": "Source",
    "mergeTarget": "Target",
    "mergeOld": "Old",
    "mergeLive": "Live",
    "mergeCount": "messages",
    "mergeCreatedAt": "Created",
    "thisRoom": "This room",
    "mergeToTarget": "Merge into the target (delete sources)",
    "mergeRemoveSources": "Source rooms and their chat sessions are deleted; no archive copy is kept.",
    "mergeDrainSelf": "Move this room into the target and clear this room",
    "mergeDrainSelfCold": "This room is archived (read-only) and cannot be kept — use “Merge into the target (delete sources)” above to fold it away.",
    "mergeConfirm": "Confirm merge (irreversible)",
    "mergeBusy": "Merging…",
    "mergeNone": "No cold-stored room is available as a target yet.",
    "mergeNeedTarget": "Pick a target room.",
    "mergeNeedSource": "Tick at least one source room.",
    "mergeDone": "Merged",
    "mergeDeletedSelf": "This room was deleted; switch to the target room.",
    "mergeDrainedSelf": "This room is now empty.",
    "mergeClose": "Close the merge panel",
    "deleteRoom": "Delete room",
    "deleteRoomHint": "Delete this room and its archives, and remove it from Chatrooms. This cannot be undone.",
    "deleteRoomConfirm": "Confirm delete (irreversible)",
    "deleteRoomBusy": "Deleting…",
    "deleteRoomDone": "Room deleted; switch to another session.",
    "pages": "Message pages",
    "pagesHint": "200 messages per page; page 1 is the oldest and higher numbers are newer. Old rooms open at page 1, live rooms open at the last page.",
    "jumpPage": "Jump to page",
    "pagePrefix": "Page ",
    "pageSuffix": "",
    "viewing": "Viewing",
    "backToLatest": "Back to latest",
    "createColdRoom": "New cold room",
    "newColdRoomName": "Room name",
    "newColdRoomPlaceholder": "Type a room name",
    "newColdRoomConfirm": "OK",
    "newColdRoomCancel": "Cancel",
    "newColdRoomHint": "Type a name and confirm to create an empty **old room** (cold-stored, read-only) as the merge target; it takes no posts and is never auto-evicted.",
    "newColdRoomNeedName": "Enter a room name.",
    "newColdRoomDone": "Created: ",
    "newColdRoomBusy": "Creating…",
    "newColdRoomClose": "Collapse the new cold room form"
  }
};
    /** Host route the room UI posts to; under `/api`, the path Connection fences. */
    const SETTINGS_PATH = "/api/dsh-chat";

    function result(value) {
      if (!value?.ok) throw new Error(value?.error?.message ?? "DSH Chat request failed");
      return value.value;
    }

    /**
     * Post one endpoint to the host's `/api/dsh-chat` Fetch route.
     *
     * The route lives under `/api`, the single path Connection mounts and fences
     * for browser callers, and answers an `{ ok, value | error }` envelope; a
     * per-plugin RPC channel is not served by this deployment. The envelope is
     * returned whole because `result` owns unwrapping it.
     */
    async function postSettings(endpoint, args, signal) {
      const response = await fetch(SETTINGS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        signal: AbortSignal.any([AbortSignal.timeout(35_000), ...(signal ? [signal] : [])]),
        body: JSON.stringify({ endpoint, args })
      });
      if (!response.ok) throw new Error(`DSH Chat request failed: HTTP ${response.status}`);
      const envelope = await response.json();
      if (envelope?.ok !== true) throw new Error(envelope?.error?.message ?? "DSH Chat request failed");
      return envelope;
    }

    /**
     * Resolve the room node for one conversation owner.
     *
     * On the current client the chat nodes live in the Session's `chat`
     * Conversation view target, reached through the Conversation binding;
     * older runtimes published them on the Session snapshot itself, which
     * stays as the fallback.
     */
    function roomNode(ctx, owner) {
      const sessionId = owner?.sessionId;
      if (typeof sessionId === "string") {
        let nodes;
        try {
          nodes = ctx.uiConversation?.binding?.(sessionId)?.target?.("chat")?.getSnapshot?.()?.nodes;
        } catch {
          // binding() throws until the client has loaded that Session; fall through to the legacy shape.
          nodes = undefined;
        }
        const node = Array.isArray(nodes) ? nodes.find((item) => item.kind === "dsh-chat-room") : undefined;
        if (node) return node;
      }
      const legacy = owner?.session?.chat?.nodes?.values?.() ?? [];
      const legacyNodes = Array.isArray(legacy) ? legacy : [];
      return legacyNodes.find((node) => node.kind === "dsh-chat-room") ?? null;
    }

    function initials(value) {
      const words = String(value).replace(/^session-/, "").split(/[-_\s]+/).filter(Boolean);
      const letters = words.map((word) => word.match(/[a-z]/i)?.[0]).filter(Boolean);
      return (letters.length > 1 ? `${letters[0]}${letters[1]}` : words[0]?.slice(0, 2) ?? "?").toUpperCase();
    }

    function memberReference(member) {
      return `session:${encodeURIComponent(member.sessionId)}`;
    }

    function runtimeState(value) {
      return value?.state ?? (value?.running === true ? "idle" : value?.running === false ? "offline" : "unknown");
    }

    function stateColor(state) {
      if (state === "idle") return "var(--dsw-alias-state-success-primary)";
      if (state === "running" || state === "waking" || state === "connecting") return "var(--dsw-alias-state-business-primary)";
      if (state === "offline" || state === "host-offline") return "var(--dsw-alias-label-tertiary)";
      return "var(--dsw-alias-label-tertiary)";
    }

    function identityColor(value) {
      let hash = 0;
      for (const character of String(value)) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
      const tones = ["var(--dsw-alias-state-business-primary)", "var(--dsw-alias-state-success-primary)", "var(--dsw-alias-state-warn-primary)", "var(--dsw-alias-label-secondary)"];
      const color = tones[Math.abs(hash) % tones.length];
      return { background: `color-mix(in srgb, ${color} 12%, var(--dsw-alias-bg-layer-1))`, color };
    }

    // 本地补丁 2026-09-28：支持图片头像。`src` 来自房间级 `avatars` 映射（见服务端
    // loadChatAvatars）；没有映射或图片加载失败时，完整回落原来的首字母/别名色块。
    function Avatar({ id, label, size = 34, title, src }) {
      const [failed, setFailed] = React.useState(false);
      const frame = {
        width: size, height: size, flex: `0 0 ${size}px`, borderRadius: "50%",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontSize: Math.max(10, Math.round(size * 0.34)), fontWeight: 500, letterSpacing: "0.02em",
        border: "2px solid var(--dsw-alias-bg-layer-1)",
        boxShadow: "0 0 0 1px var(--dsw-alias-border-l1)"
      };
      if (typeof src === "string" && src !== "" && !failed) {
        return h("span", { title: title ?? id, "aria-label": title ?? id, style: { ...frame, overflow: "hidden", background: "var(--dsw-alias-bg-layer-2)" } },
          h("img", { src, alt: "", draggable: false, onError: () => setFailed(true), style: { width: "100%", height: "100%", objectFit: "cover", display: "block" } }));
      }
      return h("span", {
        title: title ?? id,
        "aria-label": title ?? id,
        style: {
          ...identityColor(id), width: size, height: size, flex: `0 0 ${size}px`, borderRadius: "50%",
          display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: Math.max(10, Math.round(size * 0.34)),
          fontWeight: 500, letterSpacing: "0.02em", border: "2px solid var(--dsw-alias-bg-layer-1)",
          boxShadow: "0 0 0 1px var(--dsw-alias-border-l1)"
        }
      }, initials(label ?? id));
    }

    function GearIcon() {
      return h("svg", { width: 17, height: 17, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, "aria-hidden": true },
        h("circle", { cx: 12, cy: 12, r: 3 }),
        h("path", { d: "M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.5v-.1A1.7 1.7 0 0 0 8 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 3.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2V9.5h.1A1.7 1.7 0 0 0 3.6 8a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.06 3.2l.06.06A1.7 1.7 0 0 0 8 3.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2h4.1v.1A1.7 1.7 0 0 0 15 3.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 8a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4.1h-.1A1.7 1.7 0 0 0 19.4 15Z" })
      );
    }

    function ensureStyles() {
      if (typeof document === "undefined" || document.querySelector('style[data-plugin-css="dsh-chat/controls"]')) return;
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-chat";
      style.dataset.pluginCss = "dsh-chat/controls";
      style.textContent = `
        .dshChatField { display: flex; flex-direction: column; gap: 6px; margin: 0 0 12px; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; line-height: 18px; }
        .dshChatControl { box-sizing: border-box; width: 100%; height: 44px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background-color: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); padding: 0 12px; font: inherit; font-size: 14px; line-height: 22px; outline: none; }
        .dshChatControl::placeholder { color: var(--dsw-alias-label-tertiary); }
        .dshChatControl:focus-visible { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent); }
        .dshChatControl:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; opacity: .6; }
        select.dshChatControl { appearance: auto; cursor: pointer; padding-right: 12px; font-weight: 500; }
        .dshChatSearch { height: 40px; }
        .dshChatQuietButton { box-sizing: border-box; min-height: 36px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 18px; background: transparent; color: var(--dsw-alias-label-primary); padding: 0 14px; font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
        .dshChatRoom button:disabled { opacity: .45; cursor: default; }
        .dshChatRoom :is(button,textarea):focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
        .dshChatQuietButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
        .dshChatQuietButton:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
        .dshChatComposer { border-color: var(--dsw-alias-border-l2); transition: border-color .15s, box-shadow .15s; }
        .dshChatComposer:focus-within { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent), var(--dsw-shadow-lv1); }
        .dshChatComposer textarea::placeholder { color: var(--dsw-alias-label-tertiary); }
        :has(> * > [data-slot="conversation.chat.node"] > [data-dsh-chat-room-timeline]) > *:not(:has([data-dsh-chat-room-timeline])) { display: none !important; }
        @media (prefers-reduced-motion: reduce) { .dshChatComposer { transition: none; } }
      `;
      document.head.appendChild(style);
      return () => style.remove();
    }

    function apply(ctx) {
      ctx.effect(ensureStyles, `${NS}: styles`);
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, dictionaries), `${NS}: dictionaries`);
    function displayName(value) {
      const id = String(value);
      if (id.startsWith("dsh-chat-room-")) return t("you");
      if (id.startsWith("session-")) return `${t("session")} ${id.slice(8, 12)}`;
      return id;
    }

    function stateLabel(state) {
      return t(({ idle: "idle", running: "running", waking: "waking", offline: "offline", "host-offline": "hostOffline", archived: "archived", missing: "missing", connecting: "connecting" })[state] ?? "unknown");
    }


      const call = async (method, args = {}, signal) => result(await postSettings(method, args, signal));
      const readWorkspaceRows = () => {
        const sessionList = ctx.sessions.list.getSnapshot();
        const workspaceList = ctx.workspaces.list.getSnapshot();
        const archived = new Set(workspaceList.archivedSessionIds ?? []);
        return (workspaceList.items ?? []).filter((workspace) => workspace.archived !== true && workspace.title !== "Chatrooms" && !String(workspace.path ?? "").endsWith("/Chatrooms")).map((workspace) => ({
          id: String(workspace.workspaceId), title: workspace.title, path: workspace.path,
          sessions: workspace.sessionIds.map((id) => sessionList.byId[id]).filter((session) => session && !archived.has(session.id) && !String(session.id).startsWith("dsh-chat-room-"))
        })).filter((workspace) => workspace.sessions.length > 0);
      };
      const definition = {
        kind: "dsh-chat-room",
        target: "chat",
        match(event) { return event.type === "chat/room-link" ? { id: String(event.data.roomId), role: "start" } : null; },
        start(_context, match) { return { roomId: String(match.event.data.roomId), name: String(match.event.data.name) }; },
        update(context) { return context.state; },
        publication: () => "immediate",
        buildViewNode(context) {
          if (!context.state) return null;
          // 本地补丁 2026-09-28：房间卡片必须独立于「已完成回合的步骤折叠」渲染。
          // 房间会话由 room-store 的 ensureRoomSessions() 以 turn/start…turn/end 作种子，
          // 于是 chat/room-link 落在 turn 内；DSH 0.1.7 的 ChatNodeSeat 会把回合内
          // 非独立节点当作 turn-process 成员，回合折叠后整张房间卡片被 hidden 收进
          // 「已完成分析」里，宽度也随折叠容器收窄；折叠容器的 `contain: layout` +
          // `overflow: hidden` 还会让设置弹层的 position:fixed 认错包含块（只剩遮罩）。
          // 这里把 location 声明为 unresolved——turnProcessPresentations() 只处理
          // location.kind 为 turn/step 的节点，该节点因此不再属于任何回合的步骤折叠，
          // 以普通流条目渲染；anchorSeq 保持原值，排序/分页/搜索不受影响。
          return { key: context.key, kind: "dsh-chat-room", id: context.id, target: "chat", anchorSeq: context.start?.event.seq ?? 0, location: { kind: "unresolved" }, visibility: "visible", data: context.state };
        }
      };
      ctx.effect(() => ctx.uiConversation.events.register(definition), "dsh-chat: room node definition");

      // 本地补丁 2026-09-30（补丁 12）：静默广播在**成员会话**时间线里的可见卡片。
      // 官方 Chat 时间线对插件来源的消息有两道闸（均已取证）：
      //   · dsh-client-ui-chat client.js:9208 —— source.kind !== "user" 的 user/message
      //     一律分类成 context 节点；
      //   · client.js:7650 isVisibleChatNode —— context 节点被排除在可见行之外
      //     （只有含 tool-addition/tool-removal 的例外）。
      // 唯一的例外是 :9237：该消息若从 next-turn 队列被 claim（waking === true）会升级成
      // 可见的 turn-trigger 行——但那等于「它成了下一个回合的提示词」，会抢走定向 @ 的回合，
      // 不能用。所以这里自己注册一个节点：kind 不是 context、自报 visibility: "visible"、
      // location 声明 unresolved（不参与回合折叠），并配一条自己的渲染器。
      // 只匹配 BROADCAST_SOURCE_KIND，避免与定向投递重复渲染。
      const broadcastDefinition = {
        kind: "dsh-chat-broadcast",
        target: "chat",
        match(event) {
          return event.type === "user/message" && event.data?.source?.kind === BROADCAST_SOURCE_KIND
            ? { id: String(event.data.id), role: "start" } : null;
        },
        start(_context, match) {
          const blocks = Array.isArray(match.event.data?.content) ? match.event.data.content : [];
          const block = blocks.find((item) => item?.type === "text");
          const raw = typeof block?.text === "string" ? block.text : "";
          const cut = raw.indexOf(BROADCAST_TEXT_MARK);
          return { id: String(match.event.data?.id ?? ""), time: match.event.time ?? Date.now(), text: cut >= 0 ? raw.slice(0, cut) : raw };
        },
        update(context) { return context.state; },
        publication: () => "immediate",
        buildViewNode(context) {
          if (!context.state) return null;
          return { key: context.key, kind: "dsh-chat-broadcast", id: context.id, target: "chat", anchorSeq: context.start?.event.seq ?? 0, location: { kind: "unresolved" }, visibility: "visible", data: context.state };
        }
      };
      ctx.effect(() => ctx.uiConversation.events.register(broadcastDefinition), "dsh-chat: broadcast node definition");

      /** 本地补丁 2026-09-30（补丁 12）：广播卡片（纯文本，不依赖 UI 原语，取不到也不影响房间）。 */
      const BroadcastNotice = ({ node }) => {
        const data = node?.data ?? {};
        const stamp = typeof data.time === "number" ? data.time : Date.now();
        return h("section", { "data-dsh-chat-broadcast": String(data.id ?? ""), "aria-label": t("broadcast"), style: { width: "min(780px, calc(100% - 32px))", margin: "0 auto", border: "0.5px solid var(--dsw-alias-border-l1)", borderRadius: 12, background: "var(--dsw-alias-markdown-code-block)", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6 } },
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } },
            h("span", { "aria-hidden": true }, "📣"),
            h("span", null, t("broadcast")),
            h("time", { dateTime: new Date(stamp).toISOString(), style: { marginLeft: "auto" } }, new Date(stamp).toLocaleTimeString(ctx.locale.getLocale?.().active ?? undefined, { hour: "2-digit", minute: "2-digit" }))),
          h("div", { style: { color: "var(--dsw-alias-label-primary)", fontSize: 14, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, String(data.text ?? "")));
      };

      /** 本地补丁 2026-09-30（补丁 8）：纯文本回落样式（原样保留改造前的排版）。 */
      const PLAIN_TEXT_STYLE = { whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.55, fontSize: 15 };
      /** 本地补丁 2026-09-30（补丁 9）：圆形图标按钮，样式照抄 DSH 会话视图的「回到底部」按钮。 */
      const ROUND_ICON_STYLE = { width: 34, height: 34, borderRadius: 100, border: 0, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto", cursor: "pointer", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-button-floating-fill)", boxShadow: "var(--dsw-elevation-panel)" };

      /**
       * 本地补丁 2026-09-30（补丁 8）：markdown 渲染的错误边界。
       * MarkdownText 依赖一整棵渲染子树，任何一处抛错都会冒泡成整块房间白屏；
       * 这里把它兜住并退回纯文本（= 打补丁之前的样子），最坏情况只是"没有 md 样式"。
       */
      class MarkdownBoundary extends React.Component {
        constructor(props) { super(props); this.state = { failed: false }; }
        static getDerivedStateFromError() { return { failed: true }; }
        componentDidCatch() { /* 静默降级：纯文本也能读 */ }
        render() { return this.state.failed ? h("div", { style: PLAIN_TEXT_STYLE }, this.props.text) : this.props.children; }
      }

      // ─── 本地补丁 2026-10-04（补丁 14）：不严格换行 ─────────────────────────────
      // DSH 的 MarkdownText 解析器是硬编码的 CommonMark 严格模式（primitives 的 parse.js：
      // fromMarkdown(text, { extensions: [gfm(), cjkFriendlyStrong()] }) 没有 breaks 扩展），
      // 段内的单个换行只会被折成空格。官方包不能改，所以这里在交给它之前把「软换行」
      // 改写成 CommonMark 的硬换行（行尾两个空格）—— 等价于 remark-breaks / GFM breaks：
      // 渲染出来是真实 <br>。
      // 认证标尺是 mdast-util-newline-to-break（remark-breaks 的实现）：判据是「本函数输出
      // 解析出的 mdast」与「原文套用标尺后的 mdast」深度相等（差集见定向用例）。
      // 任何**原样内容**内部都不加东西：围栏代码块、缩进代码块、未闭合的行内代码 span、
      // $$ 数学块、HTML 块（本渲染器把 html 当字面文本输出）。
      // 行尾已是奇数个反斜杠（本身就是硬换行）时不再追加，免得把 `\` 变成字面内容。
      // 注意：换行标记只加在渲染用的副本上，rooms.json 里的原文一个字节都不动。
      function loosenLineBreaks(text) {
        const source = String(text ?? "");
        if (!/[\r\n]/.test(source)) return source;
        // 只把 CRLF / LF 当行分隔符；**单独的 \r 原样留在行内**（主流客户端不产生它，
        // 而把它当分隔符会改动围栏代码的字节内容 —— 代码逐字节保留优先）。
        const lines = source.split(/\r\n|\n/);
        const out = [];
        let fence = null;        // 围栏代码块 {char, len}
        let indentCode = false;  // 缩进代码块
        let mathBlock = false;   // $$ 数学块
        let htmlBlock = false;   // HTML 块
        let codeSpan = null;     // 未闭合的行内代码 span（反引号刻度数）
        let previousBlank = true;
        let previousIndented = false;
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          const blank = line.trim() === "";
          // ① 围栏代码块内部：逐字节原样。
          if (fence) {
            out.push(line);
            const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
            if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
            previousBlank = blank; previousIndented = false;
            continue;
          }
          // ② $$ 数学块内部：原样（多一个空格都会变成 TeX 正文）。
          if (mathBlock) {
            out.push(line);
            if (line.includes("$$")) mathBlock = false;
            previousBlank = blank; previousIndented = false;
            continue;
          }
          // ③ HTML 块内部：原样。空行结束该块。
          if (htmlBlock) {
            if (blank) htmlBlock = false;
            else { out.push(line); previousBlank = false; previousIndented = false; continue; }
          }
          // ④ 缩进代码块：4 空格（或制表符）起始，且前面是空行/文件头/上一行也在其中。
          const indented = /^(?: {4}|\t)/.test(line) && !blank;
          if (indented && (indentCode || previousBlank || previousIndented)) {
            indentCode = true;
            out.push(line);
            previousBlank = false; previousIndented = true;
            continue;
          }
          indentCode = false;
          // ⑤ 围栏开始（≤3 空格缩进；反引号围栏的信息串里不能有反引号）。
          const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
          if (open && (open[1][0] === "~" || !open[2].includes("`"))) {
            fence = { char: open[1][0], len: open[1].length };
            out.push(line);
            previousBlank = false; previousIndented = false;
            continue;
          }
          // ⑥ $$ 数学块开始（奇数个 $$ 说明本行没闭合）。
          if (line.trim().startsWith("$$") && (line.split("$$").length - 1) % 2 === 1) {
            mathBlock = true;
            out.push(line);
            previousBlank = false; previousIndented = false;
            continue;
          }
          // ⑦ HTML 块开始（≤3 空格缩进、以标签/注释/声明开头）。
          if (/^ {0,3}<[A-Za-z!/?]/.test(line)) {
            htmlBlock = true;
            out.push(line);
            previousBlank = false; previousIndented = false;
            continue;
          }
          // ⑧ 扫描本行的行内代码 span，判断这一行是否结束在未闭合的代码 span 里。
          const scan = scanInlineCode(line, codeSpan);
          codeSpan = scan.openRun;
          // ⑨ 追加硬换行标记：空行、代码 span 内部、已是硬换行的行都不动。
          if (blank || scan.endsInside || /(^|[^\\])(\\\\)*\\$/.test(line)) out.push(line);
          else out.push(`${line}  `);
          previousBlank = blank; previousIndented = false;
        }
        return out.join("\n");
      }

      /**
       * 逐字符找反引号 run，返回本行结束后仍未闭合的代码 span 刻度数。
       * `openRun` 为 null 表示本行结束时不在代码 span 里。
       */
      function scanInlineCode(line, incoming) {
        let open = incoming ?? null;
        let index = 0;
        while (index < line.length) {
          if (line[index] !== "`") { index += 1; continue; }
          let end = index;
          while (end < line.length && line[end] === "`") end += 1;
          const run = end - index;
          if (open === null) open = run;
          else if (run === open) open = null;
          index = end;
        }
        return { openRun: open, endsInside: open !== null };
      }
      // ── end loosenLineBreaks ──

      /**
       * 同上，但按原文缓存结果：房间时间线每秒轮询重渲染一次，若每次生成新字符串，
       * MarkdownText 的 memo（按 text 身份比较）会失效、每条消息都被重新解析一遍。
       * 没有换行的文本原样返回，身份不变。
       */
      const LOOSE_BREAK_CACHE = new Map();
      function loosenLineBreaksCached(text) {
        const key = String(text ?? "");
        const hit = LOOSE_BREAK_CACHE.get(key);
        if (hit !== undefined) return hit;
        const value = loosenLineBreaks(key);
        if (LOOSE_BREAK_CACHE.size >= 800) LOOSE_BREAK_CACHE.clear();
        LOOSE_BREAK_CACHE.set(key, value);
        return value;
      }

      function RoomTimeline({ node }) {
        const room = node.data;
        // 本地补丁 2026-10-05（补丁 24）：房间标题跟随 rooms.json，不再用建群那一刻冻结在
        // `chat/room-link` 事件里的名字（client.js:414 的 start() 取 event.data.name，而该事件
        // 只在 room-store.js:681 首次物化会话时写入，之后永不更新 ⇒ 改 rooms.json / 归档 /
        // 会话标题都不会反映到卡片上）。下面 refreshRoom 每次轮询用 listRooms 返回的 name 覆盖
        // 显示值；拿不到时保留 node.data.name（远端房间等）。
        const [roomName, setRoomName] = React.useState(room.name);
        const [messages, setMessages] = React.useState([]);
        const [loaded, setLoaded] = React.useState(false);
        const [memberBusy, setMemberBusy] = React.useState(false);
        const action = React.useRef(null);
        const dialog = React.useRef(null);
        const [members, setMembers] = React.useState([]);
        const [workspaceRows, setWorkspaceRows] = React.useState(readWorkspaceRows);
        const [workspaceId, setWorkspaceId] = React.useState("");
        const [sessionQuery, setSessionQuery] = React.useState("");
        // 本地补丁 2026-09-28：图片头像映射（服务端 avatars 端点；无映射则回落首字母徽章）。
        const [avatars, setAvatars] = React.useState({});
        const [settingsOpen, setSettingsOpen] = React.useState(false);
        const [error, setError] = React.useState("");
        // 本地补丁 2026-10-04（补丁 15）：房间内容合并面板。
        // mergeArmed 记「哪个动作已经点过一次」——破坏性动作要点两次（第二次的按钮文案变成确认）。
        const [mergeOpen, setMergeOpen] = React.useState(false);
        const [mergeList, setMergeList] = React.useState([]);
        const [mergeSources, setMergeSources] = React.useState([]);
        const [mergeTarget, setMergeTarget] = React.useState("");
        const [mergeArmed, setMergeArmed] = React.useState("");
        const [mergeBusy, setMergeBusy] = React.useState(false);
        const [mergeNotice, setMergeNotice] = React.useState("");
        // 局部改动 2026-10-12（补丁 32）：「新增冷存房间」的状态（入口在**合并面板**里，不在设置面板）。
        // newColdNotice 记上一次成功创建的名字（成功收起表单，回执留在面板上）；
        // newColdError 单独一份，**不共用 error** —— 共用的话，任何一次输入都会把
        // 别的段落（成员操作、远端会话拉取）报的错一起抹掉。
        const [newColdOpen, setNewColdOpen] = React.useState(false);
        const [newColdName, setNewColdName] = React.useState("");
        const [newColdBusy, setNewColdBusy] = React.useState(false);
        const [newColdError, setNewColdError] = React.useState("");
        const [newColdNotice, setNewColdNotice] = React.useState("");
        // 本地补丁 2026-10-21（补丁 33）：删除房间（入口在**设置面板**底部）。
        // 与合并同一个二次确认口径：第一次点击只把按钮换成「确认删除」，第二次才发请求；
        // deleted 一旦为真，房间视图换成一行「已删除」并停掉轮询（房间条目与归档都没了）。
        const [deleteArmed, setDeleteArmed] = React.useState(false);
        const [deleteBusy, setDeleteBusy] = React.useState(false);
        const [deleted, setDeleted] = React.useState(false);
        // 本地补丁 2026-10-04（补丁 16）：分页。pinned=null 表示跟随最新（轮询窗口）；
        // 钉住某页时时间线只渲染那一页，轮询仍在后台跑（回到最新是瞬时的）。
        const [pageInfo, setPageInfo] = React.useState({ roomId: "", total: 0, pageCount: 1, size: PAGE_SIZE });
        const [pinned, setPinned] = React.useState(null);
        // 补丁 18：pinned 的同步镜像 —— 异步回调里要判断「现在是不是钉着某页」，不能读渲染期的闭包值。
        const pinnedRef = React.useRef(null);
        const [pinnedPage, setPinnedPage] = React.useState(1);
        const [pageBusy, setPageBusy] = React.useState(false);
        // 本地补丁 2026-10-04（补丁 18）：房间是否冷存（只有 listRooms 知道）＋「默认页只定一次」的记账。
        const [coldStored, setColdStored] = React.useState(null);
        const defaultedPage = React.useRef("");
        // 本地补丁 2026-09-30（补丁 6）：往回翻页。older 只存「比轮询窗口更早」的消息，
        // 轮询路径（messages，limit 200）保持不变；翻页走独立的 history 端点。
        const [older, setOlder] = React.useState([]);
        const [hasMore, setHasMore] = React.useState(false);
        const [olderBusy, setOlderBusy] = React.useState(false);
        const olderRef = React.useRef(null);
        const pendingScroll = React.useRef(null);
        // 本地补丁 2026-10-04（补丁 16/18）：问一次总页数。报数带上本房间的 roomId ——
        // 默认页的判定必须只认本房间的新鲜数据，不能吃上一个房间的陈旧值。
        const refreshPages = async (signal) => {
          const info = await call("roomPages", { roomId: room.roomId, size: PAGE_SIZE }, signal);
          if (info) setPageInfo({ ...info, roomId: room.roomId });
        };
        React.useEffect(() => {
          // 换房间：清空已翻出来的旧页，并问一次「还有没有更早的内容」。
          // 翻页按消息 id 定位，前端不需要知道任何全局序号。
          setOlder([]); setHasMore(false); setOlderBusy(false);
          pinnedRef.current = null; setPinned(null); setPinnedPage(1);   // 本地补丁 2026-10-04（补丁 16）
          setColdStored(null); defaultedPage.current = "";       // 本地补丁 2026-10-04（补丁 18）：新房间重新定默认页
          setPageInfo({ roomId: "", total: 0, pageCount: 1, size: PAGE_SIZE });   // 清掉上一个房间的报数
          const controller = new AbortController();
          void call("history", { roomId: room.roomId, limit: 200 }, controller.signal)
            // 补丁 18：钉住某页时 hasMore 由那一页决定，别被「最新窗口」的结论覆盖（两道写入之间只是时序关系，
            // 这里用同步的 ref 兜住，不依赖谁先落地）。
            .then((page) => { if (!controller.signal.aborted && pinnedRef.current === null) setHasMore(page?.hasMore === true); })
            .catch(() => { /* 能不能翻页只是增强：拿不到就不显示按钮 */ });
          // 本地补丁 2026-10-04（补丁 16）：顺手问一次总页数（只报数，很便宜）。
          // 补丁 18：走 refreshPages，好让报数带上本房间的 roomId（默认页判定靠它）。
          void refreshPages(controller.signal).catch(() => { /* 报数拿不到就不显示页数选框 */ });
          return () => controller.abort();
        }, [room.roomId]);
        const findScroller = () => {
          let element = olderRef.current?.parentElement;
          while (element) { if (element.scrollHeight > element.clientHeight + 1) return element; element = element.parentElement; }
          return null;
        };
        React.useLayoutEffect(() => {
          // 往前插内容会把整块往下顶，这里把滚动位置补回去，避免视口跳动。
          const pending = pendingScroll.current;
          if (!pending) return;
          pendingScroll.current = null;
          const scroller = findScroller();
          if (scroller) scroller.scrollTop = pending.top + (scroller.scrollHeight - pending.height);
        }, [older]);
        const loadEarlier = async () => {
          if (olderBusy || !hasMore) return;
          // 本地补丁 2026-10-04（补丁 16）：钉住某页时，锚点是那一页的第一条（不是轮询窗口的）。
          const anchor = older[0] ?? (pinned ?? messages)[0];
          if (!anchor) return;
          setOlderBusy(true); setError("");
          const controller = new AbortController();
          const scroller = findScroller();
          pendingScroll.current = scroller ? { height: scroller.scrollHeight, top: scroller.scrollTop } : null;
          try {
            const page = await call("history", { roomId: room.roomId, beforeId: anchor.id, limit: 200 }, controller.signal);
            const known = new Set([...older, ...(pinned ?? messages)].map((item) => item.id));
            const fresh = (page?.messages ?? []).filter((item) => item?.id && !known.has(item.id));
            // 一页读不出新内容就收起按钮：宁可不给入口，也不让用户对着没反应的按钮点。
            if (fresh.length === 0) { pendingScroll.current = null; setHasMore(false); }
            else setOlder((items) => [...fresh, ...items]);
            if (page?.hasMore !== true) setHasMore(false);
          } catch (cause) {
            pendingScroll.current = null;
            if (!controller.signal.aborted) setError(String(cause.message ?? cause));
          } finally { setOlderBusy(false); }
        };
        // ─── 本地补丁 2026-10-04（补丁 16 / 补丁 18）：按页跳转 ───────────────────
        // 页码文案由 i18n 的前后缀拼成（数字不需要翻译）：zh「第 3 / 5 页」、en「Page 3 / 5」。
        // 本地补丁 2026-10-04（补丁 18，用户口径）：**界面上的第 1 页 = 最早的一页**，
        // 数字越大越接近最新（服务端 `roomPage` 的 page 仍是「1 = 最新」，这里一处换算）。
        const pageLabel = (page, count) => `${t("pagePrefix")}${page} / ${count}${t("pageSuffix")}`;
        /** 未钉住时界面停在「最后一页」（= 最新那一屏，也就是轮询窗口）。 */
        const displayPage = () => (pinned ? pinnedPage : Math.max(1, pageInfo.pageCount || 1));
        const jumpToPage = async (page, options = {}) => {
          if (pageBusy) return;
          const count = Math.max(1, pageInfo.pageCount || 1);
          const wanted = Math.min(Math.max(1, Math.floor(Number(page)) || 1), count);
          if (!options.force && !options.pin && wanted === displayPage()) { if (!options.silent) setSettingsOpen(false); return; }
          // 最后一页 == 最新那一屏 == 轮询窗口：直接回到「跟随最新」，不必钉住一份副本。
          // `options.pin` 是例外：老房间进房要**真的钉住第 1 页**（只有一页也一样）——
          // 否则时间线会落回聊天视图「跟随底部」的默认位置，看不见最顶上那条。
          if (wanted === count && !options.pin) {
            backToLatest();
            if (!options.silent) setSettingsOpen(false);
            return;
          }
          setPageBusy(true); setError("");
          const controller = new AbortController();
          try {
            const serverPage = count - wanted + 1;                // 界面口径（1=最早）→ 服务端口径（1=最新）
            const result = await call("roomPage", { roomId: room.roomId, page: serverPage, size: PAGE_SIZE }, controller.signal);
            pinnedRef.current = result?.messages ?? []; setPinned(pinnedRef.current);
            setPinnedPage(wanted);
            setPageInfo({ total: result?.total ?? 0, pageCount: result?.pageCount ?? count, size: result?.size ?? PAGE_SIZE, roomId: room.roomId });
            setOlder([]);
            setHasMore(wanted > 1);                               // 第 1 页是最早的一页，没有更早的了
            if (!options.silent) setSettingsOpen(false);
            const scroller = findScroller();
            if (scroller) scroller.scrollTop = 0;
          } catch (cause) { setError(String(cause.message ?? cause)); }
          finally { setPageBusy(false); }
        };
        const backToLatest = () => {
          pinnedRef.current = null; setPinned(null); setPinnedPage(1); setOlder([]);
          // 跟随最新 = 界面上的最后一页 ⇒ 还有更早的内容当且仅当不止一页。
          setHasMore(Math.max(1, pageInfo.pageCount || 1) > 1);
          void refreshPages().catch(() => { /* 报数失败不影响回到最新 */ });
          const scroller = findScroller();
          if (scroller) { try { scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" }); } catch { scroller.scrollTop = scroller.scrollHeight; } }
        };
        // 本地补丁 2026-10-11（补丁 26）：「加载更晚的消息」—— 时间线**底部**的往下翻页入口。
        // 动作与设置里选下一页**完全相同**（同一个 jumpToPage）：跳到下一页的**顶部**，
        // 而不是把下一页接在当前页后面 —— 两页连在一起就分不清该从哪条开始读了（用户 2026-10-11 报的正是这个）。
        // 只在钉住某页时给入口（跟随最新＝最新就在眼前），且下面还有页（钉的页号 < 总页数）。
        const canLoadLater = pinned !== null && pinnedPage < Math.max(1, pageInfo.pageCount || 1);
        // 本地补丁 2026-10-04（补丁 18）：进房间时定默认页 —— **老房间（冷存）停在最早那页（第 1 页）**，
        // 活跃房间不动（= 跟随最新 = 最后一页）。房间是不是冷存只有 listRooms 才知道，
        // 所以等它和 roomPages 都报回来再定；两个值都必须属于**本房间**（带 roomId 标记 + 换房时清空），
        // 否则会吃到上一个房间的陈旧值、把「只定一次」的额度白白用掉。
        React.useEffect(() => {
          if (defaultedPage.current === room.roomId) return;
          if (typeof coldStored !== "boolean") return;
          if (pageInfo.roomId !== room.roomId) return;
          defaultedPage.current = room.roomId;
          // 老房间一律钉住第 1 页（**只有一页也钉**）：单页房间若走「最后一页 = 跟随最新」的捷径，
          // 就会落回聊天视图跟随底部的默认位置，看不到最顶上那条 —— 用户 2026-10-04 报的正是这个。
          if (coldStored) void jumpToPage(1, { silent: true, pin: true });
        }, [room.roomId, coldStored, pageInfo.roomId, pageInfo.pageCount]);
        // 本地补丁 2026-10-04（补丁 18）：钉在老房间第 1 页时，等内容真正渲染出来后再兜一次滚到顶部
        // （上面那次 scrollTop=0 可能发生在消息还没进 DOM 之前；轮询把内容换了一遍也要重新定位）。
        React.useEffect(() => {
          if (coldStored !== true || pinnedRef.current === null || pinnedPage !== 1) return;
          const scroller = findScroller();
          if (scroller) scroller.scrollTop = 0;
        }, [coldStored, room.roomId, pinned, pinnedPage, loaded]);
        // 本地补丁 2026-09-30（补丁 8）：MarkdownText 需要的界面文案。形状照抄 ui-chat：
        // 渲染期只会读 labels.code.{copyLabel,copiedLabel,toolbarLabels} 与 labels.footnotes，
        // 缺键会直接抛错，所以这四个键必须齐全。
        const markdownLabels = React.useMemo(() => ({
          code: {
            copyLabel: t("copy"),
            copiedLabel: t("copied"),
            toolbarLabels: { codeLabel: t("codeBlock"), wrapLabel: t("wrapLines"), unwrapLabel: t("unwrapLines") }
          },
          footnotes: t("footnotes")
        }), [t]);
        // 本地补丁 2026-09-30（补丁 9）：跟 DSH 会话的「回到底部」对称 —— 离开顶部才出现「回到顶部」。
        const [atTop, setAtTop] = React.useState(true);
        React.useEffect(() => {
          const scroller = findScroller();
          if (!scroller) return undefined;
          const update = () => setAtTop(scroller.scrollTop <= 24);
          update();
          scroller.addEventListener("scroll", update, { passive: true });
          return () => scroller.removeEventListener("scroll", update);
        }, [room.roomId, loaded, older.length]);
        const scrollToTop = () => {
          const scroller = findScroller();
          if (!scroller) return;
          try { scroller.scrollTo({ top: 0, behavior: "smooth" }); } catch { scroller.scrollTop = 0; }
        };
        const refreshRoom = React.useCallback(async (signal) => {
          // 本地补丁 2026-09-30（补丁 10）：只列当前房间 —— 下面本来就只 find 它一个。
          const rooms = await call("listRooms", { roomId: room.roomId }, signal);
          if (signal.aborted) return;
          const current = rooms.find((item) => item.id === room.roomId);
          // 本地补丁 2026-10-05（补丁 24）：标题以 rooms.json 为准（远端/查不到时保留原值）。
          if (current?.name) setRoomName(String(current.name));
          setMembers(current?.members ?? []);
          // 本地补丁 2026-10-04（补丁 18）：顺便记住这房间是不是冷存（默认页要按它选）。
          setColdStored(current?.coldStored === true);
        }, [room.roomId]);
        React.useEffect(() => {
          if (deleted) return undefined;   // 本地补丁 33：房间已删除，停掉轮询
          const controller = new AbortController(); const signal = controller.signal;
          let timer;
          setMessages([]); setLoaded(false);
          const poll = async () => {
            let delay = 1_000;
            try {
              const next = await call("messages", { roomId: room.roomId, limit: 200 }, signal);
              if (!signal.aborted) { setMessages(next); setLoaded(true); await refreshRoom(signal); }
            } catch (cause) {
              delay = 2_000;
              if (!signal.aborted) setError(String(cause.message ?? cause));
            } finally { if (!signal.aborted) timer = setTimeout(poll, delay); }
          };
          void poll();
          return () => { controller.abort(); clearTimeout(timer); action.current?.abort(); action.current = null; };
        }, [room.roomId, refreshRoom, deleted]);
        React.useEffect(() => {
          const refresh = () => setWorkspaceRows(readWorkspaceRows());
          refresh();
          const unsubscribeSessions = ctx.sessions.list.subscribe(refresh);
          const unsubscribeWorkspaces = ctx.workspaces.list.subscribe(refresh);
          return () => { unsubscribeSessions(); unsubscribeWorkspaces(); };
        }, []);
        // 本地补丁 2026-09-28：头像映射只在挂载时取一次；失败就静默用首字母徽章。
        React.useEffect(() => {
          const controller = new AbortController();
          void call("avatars", {}, controller.signal)
            .then((map) => { if (!controller.signal.aborted) setAvatars(map !== null && typeof map === "object" ? map : {}); })
            .catch(() => { /* 头像是装饰，取不到不影响房间 */ });
          return () => controller.abort();
        }, []);
        const avatarSrc = (id, label) => avatars[String(id)] ?? (label === undefined || label === null ? undefined : avatars[String(label)]);
        React.useEffect(() => {
          if (!settingsOpen) return;
          const controller = new AbortController();
          const previousFocus = typeof document === "undefined" ? null : document.activeElement;
          dialog.current?.focus();
          setMemberBusy(false);
          return () => { controller.abort(); action.current?.abort(); action.current = null; previousFocus?.focus?.(); };
        }, [settingsOpen, room.roomId]);
        const changeMember = async (endpoint, member) => {
          if (action.current) return;
          const controller = new AbortController(); action.current = controller;
          setMemberBusy(true); setError("");
          try {
            await call(endpoint, { roomId: room.roomId, member }, controller.signal);
            await refreshRoom(controller.signal);
          } catch (cause) { if (!controller.signal.aborted) setError(String(cause.message ?? cause)); }
          finally { if (action.current === controller) { action.current = null; setMemberBusy(false); } }
        };
        const addMember = (session, workspace) => changeMember("addMember", { kind: "session", sessionId: String(session.id), alias: session.displayTitle ?? session.title ?? session.id, workspaceTitle: workspace?.title });
        const removeMember = (member) => changeMember("removeMember", { kind: "session", sessionId: member.sessionId });
        const openSettings = () => {
          setSettingsOpen(true); setWorkspaceId(workspaceRows[0]?.id ?? "");
          setDeleteArmed(false);   // 本地补丁 33：每次打开设置都从「删除房间」回到未确认态
          // 本地补丁 2026-10-04（补丁 16）：打开设置时刷新一次页数（房间可能刚长了新消息）。
          void refreshPages().catch(() => { /* 报数拿不到就不显示页数选框 */ });
        };
        // 本地补丁 2026-10-04（补丁 15）：合并面板。目标是单选且只认老房间（冷存），
        // 默认选「上一个老房间」= createdAt 最新的冷存房间；来源可多选，默认不选。
        // 本地改动 2026-10-10（用户口径）：列表**只列老房间 + 当前房间**，其余活跃房间不显示 ——
        // 它们当不了目标（目标必须是冷存），要拿它当来源也只能先切过去用「把本房间并入目标」。
        const mergeRows = (list) => list.filter((item) => item.coldStored === true || item.id === room.roomId);
        // 本地改动 2026-10-10：本房间自己是冷存（只读）时，「保留源房间」那一档不成立 ——
        // 服务端只允许保留**活跃**源房间（对冷存源会拒绝；硬放开的话归档文件不会被清掉，
        // 结果是「内容没清、只是复制了一份」的假成功）。所以这里把这条路径写暗，
        // 并给一句指路文案：要并掉这个老房间，走上面的「合并到目标房间（删除源房间）」。
        const selfCold = mergeList.find((item) => item.id === room.roomId)?.coldStored === true || coldStored === true;
        const openMerge = async () => {
          setError(""); setMergeNotice(""); setMergeArmed(""); setMergeOpen(true);
          const controller = new AbortController();
          try {
            const rooms = mergeRows(await call("listRooms", {}, controller.signal));
            setMergeList(rooms);
            const cold = rooms.filter((item) => item.coldStored === true).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
            setMergeTarget(cold[0]?.id ?? "");
            setMergeSources([]);
          } catch (cause) { setError(String(cause.message ?? cause)); }
        };
        const toggleMergeSource = (id) => {
          setMergeArmed("");
          setMergeSources((value) => value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);
        };
        const chooseMergeTarget = (id) => {
          setMergeArmed("");
          setMergeTarget(id);
          setMergeSources((value) => value.filter((item) => item !== id));
        };
        const runMerge = async (drainSelf) => {
          if (mergeBusy) return;
          const sources = drainSelf ? [room.roomId] : mergeSources.filter((id) => id !== mergeTarget);
          if (!mergeTarget) { setError(t("mergeNeedTarget")); return; }
          if (sources.length === 0) { setError(t("mergeNeedSource")); return; }
          // 破坏性动作二次确认：第一次点击只是把按钮文案换成「确认合并」。
          if (mergeArmed !== (drainSelf ? "drain" : "merge")) { setMergeArmed(drainSelf ? "drain" : "merge"); return; }
          setMergeBusy(true); setError(""); setMergeNotice(""); setMergeArmed("");
          const controller = new AbortController();
          try {
            const outcome = await call("mergeRooms", { sources, target: mergeTarget, deleteSources: !drainSelf }, controller.signal);
            const done = `${t("mergeDone")} · ${outcome.messages} ${t("mergeCount")} → ${outcome.name}`;
            setMergeSources([]);
            // 本房间被掏空时，之前翻出来的旧页还留在 older 里 —— 不清掉的话时间线会继续显示
            // 已经搬走的那些消息（轮询只覆盖 messages）。
            if (drainSelf) { setOlder([]); setHasMore(false); setMessages([]); }
            setMergeList(mergeRows(await call("listRooms", {}, controller.signal)));
            // 本房间是源时给出后果提示：被删了要切房间，被掏空了内容会变空。
            setMergeNotice(drainSelf ? `${done} · ${t("mergeDrainedSelf")}` : sources.includes(room.roomId) ? `${done} · ${t("mergeDeletedSelf")}` : done);
          } catch (cause) { setError(String(cause.message ?? cause)); }
          finally { setMergeBusy(false); }
        };
        // 局部改动 2026-10-12（补丁 32）：新增冷存房间。三态在一个处理函数里，与用户口径一一对应：
        //   ① 表单没用开 → 「新增冷存房间」只把表单摊开（不执行任何动作）；
        //   ② 表单开着、名字空 → 不执行，提示补名字（输入框当然留着）；
        //   ③ 名字非空 → 提交；成功就清空输入并留下回执，失败原样留着输入框与名字，等用户改。
        // 重名不在这边先判：服务端 createColdRoom 会拒（活跃房间与老房间都算占名），
        // 前端只负责把它的错误原文显示出来 —— 判据只有服务端一份，不会两边漂。
        // onCreated：入口搬进合并面板后加的回调（收到刚建好的房间对象）—— 建完要就地刷新那个面板的候选列表，
        // 新房间才能立刻被选成目标（不刷新的话得关掉面板重开才看得见）。
        const submitColdRoom = async (onCreated) => {
          if (newColdBusy) return;
          const name = newColdName.trim();
          setNewColdError(""); setNewColdNotice("");
          if (name === "") { setNewColdError(t("newColdRoomNeedName")); return; }
          setNewColdBusy(true);
          try {
            const created = await call("createColdRoom", { name });
            // 用户口径：建成之后**输入框消失** —— 表单收起，回执留在面板里。
            setNewColdOpen(false);
            setNewColdName(""); setNewColdNotice(`${t("newColdRoomDone")}${created?.name ?? name}`);
            if (typeof onCreated === "function") await onCreated(created);
          } catch (cause) { setNewColdError(String(cause.message ?? cause)); }
          finally { setNewColdBusy(false); }
        };
        // 本地补丁 2026-10-21（补丁 33）：删除房间。两次点击与其他破坏性动作一致；
        // 成功后关掉设置面板并切到「已删除」态（房间条目、归档、Chatrooms 会话都已清掉）。
        const runDeleteRoom = async () => {
          if (deleteBusy) return;
          setError("");
          if (!deleteArmed) { setDeleteArmed(true); return; }
          const controller = new AbortController();
          action.current = controller;
          setDeleteBusy(true);
          try {
            await call("deleteRoom", { roomId: room.roomId }, controller.signal);
            setDeleted(true);
            setSettingsOpen(false);
          } catch (cause) {
            setDeleteArmed(false);
            if (!controller.signal.aborted) setError(String(cause.message ?? cause));
          } finally {
            if (action.current === controller) action.current = null;
            setDeleteBusy(false);
          }
        };
        const dialogKeys = (event) => {
          if (event.key === "Escape") { event.preventDefault(); setSettingsOpen(false); }
          if (event.key !== "Tab") return;
          const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')];
          const first = controls[0]; const last = controls.at(-1);
          if (!first) { event.preventDefault(); return; }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        };
        const selectedWorkspace = workspaceRows.find((workspace) => workspace.id === workspaceId) ?? workspaceRows[0];
        const memberName = (member) => {
          const local = ctx.sessions.list.getSnapshot().byId[member.sessionId];
          if (local) return local.displayTitle ?? local.title ?? member.alias ?? displayName(member.sessionId);
          for (const workspace of workspaceRows) {
            const session = workspace.sessions.find((item) => String(item.id) === member.sessionId);
            if (session) return session.displayTitle ?? session.title ?? displayName(member.sessionId);
          }
          return member.alias ?? displayName(member.sessionId);
        };
        const authorName = (message) => String(message.author).startsWith("dsh-chat-room-") ? t("you") : message.authorAlias ?? memberName(members.find((member) => member.sessionId === message.author) ?? { kind: "session", sessionId: message.author });
        const query = sessionQuery.trim().toLowerCase();
        const selectableSessions = (selectedWorkspace?.sessions ?? []).filter((session) => {
          const alreadyMember = members.some((member) => member.sessionId === String(session.id));
          const title = session.displayTitle ?? session.title ?? session.id;
          return !alreadyMember && (!query || `${title} ${session.id}`.toLowerCase().includes(query));
        });
        // 本地补丁 2026-09-30（补丁 6）：展示「翻出来的旧页 + 轮询窗口」，按 id 去重。
        // 本地补丁 2026-10-04（补丁 16）：钉住某页时，那一页取代轮询窗口（older 仍可在它前面继续翻）。
        const head = pinned ?? messages;
        const headIds = new Set(head.map((message) => message.id));
        const shown = [...older.filter((message) => !headIds.has(message.id)), ...head];
        // 本地补丁 2026-10-21（补丁 33）：房间已被删除 —— 轮询已停，只剩一行提示。
        // 放在所有 hooks 之后，hook 顺序不受影响。
        if (deleted) return h("section", { className: "dshChatRoom", style: { width: "min(780px, calc(100% - 32px))", margin: "0 auto", padding: "24px 0 36px" } }, h("p", { role: "status", style: { padding: "10px 12px", borderRadius: 9, background: "var(--dsw-alias-bg-layer-2)", fontSize: 13 } }, t("deleteRoomDone")));
        return h("section", { "data-dsh-chat-room-timeline": "", className: "dshChatRoom", style: { width: "min(780px, calc(100% - 32px))", margin: "0 auto", padding: "24px 0 36px" } },
          // 本地补丁 2026-09-30（补丁 7）：标题栏吸顶 —— 长房间里不必再滚回顶部才能点「设置」。
          // 半透明底 + 背景模糊，内容从下方滚过时不会糊在一起；负数横向 margin 让吸顶条
          // 比内容略宽，滚动时两侧不留缝。
          h("header", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, position: "sticky", top: 0, zIndex: 5, margin: "0 -12px 24px", padding: "10px 12px", borderRadius: 14, background: "color-mix(in srgb, var(--dsw-alias-bg-layer-1) 92%, transparent)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" } },
            h("div", { style: { minWidth: 0 } },
              h("h2", { style: { margin: "0 0 8px", fontSize: 21, lineHeight: 1.25, fontWeight: 600, letterSpacing: "-0.015em" } }, roomName),
              h("div", { style: { display: "flex", alignItems: "center", minHeight: 28 } },
                h("div", { "aria-label": `${members.length} ${t("roomMembers")}`, style: { display: "flex", paddingLeft: members.length ? 3 : 0 } },
                  members.slice(0, 5).map((member, index) => h("span", { key: member.sessionId, style: { display: "inline-flex", marginLeft: index ? -8 : 0, zIndex: 10 - index } }, h(Avatar, { id: member.sessionId, label: memberName(member), title: memberName(member), size: 28, src: avatarSrc(member.sessionId, memberName(member)) }))),
                  members.length > 5 && h("span", { style: { width: 28, height: 28, marginLeft: -8, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--dsw-alias-bg-layer-2)", border: "2px solid var(--dsw-alias-bg-layer-1)", fontSize: 10, fontWeight: 500 } }, `+${members.length - 5}`)
                ),
                h("span", { style: { marginLeft: 10, color: "var(--dsw-alias-label-secondary)", fontSize: 13 } }, `${members.length} ${t("roomMembers")}`)
              )
            ),
            h("div", { style: { display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" } },
              // 本地补丁 2026-09-30（补丁 9）：只在离开顶部时出现，点一下直接回到房间最顶行。
              atTop ? null : h("button", { type: "button", onClick: scrollToTop, style: ROUND_ICON_STYLE, "aria-label": t("toTop"), title: t("toTop") }, IconChevronUp ? h(IconChevronUp, {}) : "↑"),
              // 本地补丁 2026-10-04（补丁 15）：房间内容合并入口（远端主办的房间是只读镜像，不给入口）。
              h("button", { type: "button", onClick: openMerge, className: "dshChatQuietButton", "aria-label": t("merge"), title: t("merge") }, h("span", null, t("merge"))),
              h("button", { type: "button", onClick: openSettings, className: "dshChatQuietButton", "aria-label": t("roomSettings") }, h(GearIcon), h("span", null, t("settings")))
            )
          ),
          error && h("p", { role: "alert", style: { padding: "10px 12px", borderRadius: 9, background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-state-error-primary)", fontSize: 13 } }, error),
          h("div", { "aria-label": t("roomMessages"), style: { display: "grid", gap: 22 } },
            // 本地补丁 2026-10-04（补丁 16）：钉住某页时的状态行 + 回到最新。
            pinned && h("div", { role: "status", style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 10, background: "var(--dsw-alias-bg-layer-2)", fontSize: 13 } },
              h("span", null, `${t("viewing")} ${pageLabel(pinnedPage, pageInfo.pageCount)}`),
              h("button", { type: "button", onClick: backToLatest, className: "dshChatQuietButton", style: { marginLeft: "auto", minHeight: 28 } }, t("backToLatest"))
            ),
            h("div", { ref: olderRef }),
            // 本地补丁 2026-09-30（补丁 6）：往回翻页入口；没有更早内容时不渲染。
            hasMore && h("div", { style: { display: "flex", justifyContent: "center" } },
              h("button", { type: "button", disabled: olderBusy, onClick: loadEarlier, className: "dshChatQuietButton", "aria-label": t("loadEarlier") }, olderBusy ? t("working") : t("loadEarlier"))
            ),
            shown.map((message) => h("article", { key: message.id, style: { display: "grid", gridTemplateColumns: "38px minmax(0,1fr)", gap: 12, alignItems: "start" } },
              h(Avatar, { id: message.author, label: authorName(message), size: 36, title: authorName(message), src: avatarSrc(message.author, authorName(message)) }),
              // 本地补丁 2026-09-28：把「消息行」标记给 dsh-meme 用。它在把
              // [表情: …] 文本换成图片后，会把图片提到 row.firstChild，而 row 取自
              // closest('[data-time-hover-root],[data-chat-flow-key]')。房间时间轴整体
              // 就是一个 data-chat-flow-key 流条目，最近祖先只能是它 → 所有表情图都被
              // 提到整段群聊的最上方。标在这里后，最近祖先变成该条消息自身。
              h("div", { style: { minWidth: 0, paddingTop: 1 } },
                h("div", { style: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 } },
                  h("strong", { title: authorName(message), style: { fontSize: 14, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, authorName(message)),
                  h("time", { dateTime: new Date(message.sentAt).toISOString(), style: { flex: "0 0 auto", color: "var(--dsw-alias-label-tertiary)", fontSize: 11 } }, new Date(message.sentAt).toLocaleTimeString(ctx.locale.getLocale?.().active ?? undefined, { hour: "2-digit", minute: "2-digit" }))
                ),
                // 本地补丁 2026-10-05（补丁 17）：表情图的提升锚点必须落在**正文块**上，不能落在这条
                // 消息的外层列上 —— dsh-meme 是把 <img> insertBefore 到锚点的 firstChild，锚点若含
                // 「名字 + 时间」那一行，图就跑到名字**上面**去了。包一层只装正文的 div 后，
                // 最近祖先变成它 ⇒ 图落在名字行**下面**、正文顶部（与官方会话里的观感一致）。
                // （全 @deepseek-ai 包里 data-time-hover-root 0 处引用，纯 dsh-meme 标记。）
                h("div", { "data-time-hover-root": "", style: { minWidth: 0 } },
                  // 本地补丁 2026-09-30（补丁 8）：正文走 DSH 自己的 markdown 渲染器（与主会话同一实例）；
                  // 拿不到原语、或渲染抛错时由 MarkdownBoundary 退回纯文本。
                  // 本地补丁 2026-10-04（补丁 14）：交给它之前先做「不严格换行」改写（只改渲染副本）。
                  MarkdownText
                    ? h(MarkdownBoundary, { text: message.text }, h(MarkdownText, { text: loosenLineBreaksCached(message.text), labels: markdownLabels }))
                    : h("div", { style: PLAIN_TEXT_STYLE }, message.text)
                )
              )
            )),
            // 本地补丁 2026-10-11（补丁 26）：往下翻页入口 —— 跳到下一页顶部（与选页同一个 jumpToPage）。
            // silent：时间线里那个按钮不该顺手关掉用户可能开着的设置面板。
            // pageBusy 时才真的禁用：跳页期间再点会被 jumpToPage 的重入守卫吞掉，看起来像坏按钮。
            canLoadLater && h("div", { style: { display: "flex", justifyContent: "center" } },
              h("button", { type: "button", disabled: pageBusy, onClick: () => void jumpToPage(pinnedPage + 1, { silent: true }), className: "dshChatQuietButton", "aria-label": t("loadLater") }, pageBusy ? t("working") : t("loadLater"))
            ),
            shown.length === 0 && h("div", { style: { padding: "48px 20px", textAlign: "center", color: "var(--dsw-alias-label-secondary)" } }, h("p", { style: { margin: "0 0 5px", fontWeight: 600, color: "inherit" } }, loaded ? t("startConversation") : t("loadingMessages")), loaded && h("small", null, t("quietHint")))
          ),
          // 本地补丁 2026-10-04（补丁 15）：合并面板。左列勾来源、右列选目标（只认老房间），
          // 底部两个动作；破坏性动作点两次。合并后本房间若被删/被清空，在本面板给出后果提示。
          mergeOpen && h("div", { role: "presentation", onClick: (event) => { if (event.target === event.currentTarget) setMergeOpen(false); }, style: { position: "fixed", inset: 0, zIndex: 100, background: "var(--dsw-alias-bg-mask-1)", display: "flex", justifyContent: "flex-end" } },
            h("aside", { tabIndex: -1, onKeyDown: (event) => { if (event.key === "Escape") { event.preventDefault(); setMergeOpen(false); } }, role: "dialog", "aria-modal": true, "aria-label": t("merge"), style: { width: "min(470px, 94vw)", height: "100%", boxSizing: "border-box", padding: 26, overflow: "auto", background: "var(--dsw-alias-bg-layer-1)", boxShadow: "var(--dsw-shadow-lv2)" } },
              h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 } },
                h("h3", { style: { margin: 0, fontSize: 18 } }, t("merge")),
                h("button", { type: "button", onClick: () => setMergeOpen(false), className: "dshChatQuietButton", style: { width: 36, padding: 0 }, "aria-label": t("mergeClose") }, "×")
              ),
              h("p", { style: { margin: "0 0 14px", color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, t("mergeHint")),
              // 局部改动 2026-10-12（补丁 32，GUI 改动）：新增冷存房间的入口**从这个面板里出**（原先在设置面板）。
              // 理由：它唯一的用途就是当合并目标（服务端要求目标必须冷存），而这里正是「找不到目标」的地方；
              // 缺目标时不必再折回设置。按钮点一下把表单摊开；摊开态按钮＝「收起」。
              h("section", { "aria-busy": newColdBusy, style: { marginBottom: 16, paddingBottom: 14, borderBottom: "1px solid var(--dsw-alias-border-l1)" } },
                h("button", {
                  type: "button",
                  onClick: () => {
                    setNewColdError(""); setNewColdNotice("");
                    // 收起态：按钮只负责摊开表单；摊开态：按钮＝「收起」（不再执行创建，创建只在确定/回车那条路上）。
                    if (!newColdOpen) { setNewColdName(""); setNewColdOpen(true); return; }
                    setNewColdOpen(false); setNewColdName("");
                  },
                  disabled: newColdBusy,
                  className: "dshChatQuietButton",
                  "aria-label": newColdOpen ? t("newColdRoomClose") : t("createColdRoom"),
                  title: newColdOpen ? t("newColdRoomClose") : t("createColdRoom")
                }, newColdOpen ? t("newColdRoomClose") : t("createColdRoom")),
                newColdOpen && h("p", { style: { margin: "10px 0 0", color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, t("newColdRoomHint")),
                newColdOpen && h("div", { style: { display: "grid", gap: 8, marginTop: 12 } },
                  h("label", { className: "dshChatField" }, t("newColdRoomName"),
                    h("input", {
                      type: "text", value: newColdName, disabled: newColdBusy,
                      onChange: (event) => { setNewColdName(event.target.value); setNewColdError(""); setNewColdNotice(""); },
                      onKeyDown: (event) => { if (event.key === "Enter") { event.preventDefault(); void submitColdRoom(); } },
                      placeholder: t("newColdRoomPlaceholder"), "aria-label": t("newColdRoomName"),
                      className: "dshChatControl"
                    })
                  ),
                  h("div", { style: { display: "flex", gap: 8 } },
                    h("button", {
                      type: "button", disabled: newColdBusy,
                      onClick: () => { setNewColdOpen(false); setNewColdName(""); setNewColdError(""); setNewColdNotice(""); },
                      className: "dshChatQuietButton"
                    }, t("newColdRoomCancel")),
                    h("button", {
                      type: "button", disabled: newColdBusy,
                      onClick: () => void submitColdRoom(async (created) => {
                        // 就地刷新候选列表（与 openMerge 同一套过滤），并把新房间预设成目标 —— 这就是建它的原因。
                        const list = mergeRows(await call("listRooms", {}));
                        setMergeList(list);
                        if (created?.id !== undefined) { setMergeTarget(created.id); setMergeArmed(""); }
                      }),
                      className: "dshChatQuietButton"
                    }, newColdBusy ? t("newColdRoomBusy") : t("newColdRoomConfirm"))
                  )
                ),
                // 回执与报错放在**表单之外**：成功时表单会收起，回执若包在表单里就跟着没了。
                // 报错（重名）则与「输入框留着」配对出现 —— 用户要能一边看着原因一边改名字。
                newColdNotice && h("small", { role: "status", style: { display: "block", marginTop: 10, color: "var(--dsw-alias-label-secondary)" } }, newColdNotice),
                newColdError && h("small", { role: "alert", style: { display: "block", marginTop: 10, color: "var(--dsw-alias-state-error-primary)" } }, newColdError)
              ),
              h("div", { style: { display: "grid", gridTemplateColumns: "26px 26px minmax(0,1fr)", gap: 8, marginBottom: 6, color: "var(--dsw-alias-label-secondary)", fontSize: 12 } },
                h("span", null, t("mergeSource")), h("span", null, t("mergeTarget")), h("span", null)
              ),
              h("div", { role: "list", "aria-label": t("merge"), style: { display: "grid", gap: 6 } },
                mergeList.map((item) => {
                  const old = item.coldStored === true;
                  const isSource = mergeSources.includes(item.id);
                  const isTarget = mergeTarget === item.id;
                  return h("div", { key: item.id, style: { display: "grid", gridTemplateColumns: "26px 26px minmax(0,1fr)", alignItems: "center", gap: 8, padding: "8px 9px", borderRadius: 10, background: "var(--dsw-alias-bg-layer-2)" } },
                    h("input", { type: "checkbox", checked: isSource, disabled: mergeBusy || isTarget, "aria-label": `${t("mergeSource")}: ${item.name}`, onChange: () => toggleMergeSource(item.id) }),
                    h("input", { type: "radio", name: "dshChatMergeTarget", checked: isTarget, disabled: mergeBusy || !old, "aria-label": `${t("mergeTarget")}: ${item.name}`, onChange: () => chooseMergeTarget(item.id) }),
                    h("div", { style: { minWidth: 0 } },
                      h("div", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 } },
                        h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, item.name),
                        item.id === room.roomId && h("span", { style: { flex: "0 0 auto", color: "var(--dsw-alias-label-tertiary)", fontSize: 11, fontWeight: 400 } }, t("thisRoom")),
                        h("span", { style: { flex: "0 0 auto", padding: "1px 7px", borderRadius: 100, fontSize: 11, fontWeight: 500, background: old ? "var(--dsw-alias-bg-layer-1)" : "var(--dsw-alias-state-business-primary)", color: old ? "var(--dsw-alias-label-secondary)" : "var(--dsw-alias-bg-layer-1)" } }, old ? t("mergeOld") : t("mergeLive"))
                      ),
                      h("small", { style: { color: "var(--dsw-alias-label-secondary)" } }, `${item.messageCount ?? 0} ${t("mergeCount")} · ${t("mergeCreatedAt")} ${new Date(item.createdAt ?? 0).toLocaleString(ctx.locale.getLocale?.().active ?? undefined)}`)
                    )
                  );
                })
              ),
              mergeList.filter((item) => item.coldStored === true).length === 0 && h("small", { style: { color: "var(--dsw-alias-label-secondary)" } }, t("mergeNone")),
              mergeNotice && h("p", { role: "status", style: { margin: "14px 0 0", fontSize: 13 } }, mergeNotice),
              error && h("p", { role: "alert", style: { margin: "14px 0 0", color: "var(--dsw-alias-state-error-primary)", fontSize: 13 } }, error),
              h("div", { style: { display: "grid", gap: 8, marginTop: 18 } },
                h("button", { type: "button", disabled: mergeBusy || !mergeTarget || mergeSources.filter((id) => id !== mergeTarget).length === 0, onClick: () => runMerge(false), className: "dshChatQuietButton", style: mergeArmed === "merge" ? { color: "var(--dsw-alias-state-error-primary)", fontWeight: 600 } : undefined }, mergeBusy ? t("mergeBusy") : mergeArmed === "merge" ? t("mergeConfirm") : t("mergeToTarget")),
                h("small", { style: { color: "var(--dsw-alias-label-secondary)" } }, t("mergeRemoveSources")),
                h("button", { type: "button", disabled: mergeBusy || !mergeTarget || mergeTarget === room.roomId || selfCold, title: selfCold ? t("mergeDrainSelfCold") : undefined, onClick: () => runMerge(true), className: "dshChatQuietButton", style: mergeArmed === "drain" ? { color: "var(--dsw-alias-state-error-primary)", fontWeight: 600 } : undefined }, mergeArmed === "drain" ? t("mergeConfirm") : t("mergeDrainSelf")),
                selfCold && h("small", { style: { color: "var(--dsw-alias-label-secondary)" } }, t("mergeDrainSelfCold"))
              )
            )
          ),
          settingsOpen && h("div", { role: "presentation", onClick: (event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }, style: { position: "fixed", inset: 0, zIndex: 100, background: "var(--dsw-alias-bg-mask-1)", display: "flex", justifyContent: "flex-end" } },
            h("aside", { ref: dialog, tabIndex: -1, onKeyDown: dialogKeys, role: "dialog", "aria-modal": true, "aria-label": t("roomSettings"), style: { width: "min(470px, 94vw)", height: "100%", boxSizing: "border-box", padding: 26, overflow: "auto", background: "var(--dsw-alias-bg-layer-1)", boxShadow: "var(--dsw-shadow-lv2)" } },
              h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 26 } },
                h("div", null, h("h3", { style: { margin: "0 0 3px", fontSize: 18 } }, t("roomSettings")), h("small", { style: { color: "var(--dsw-alias-label-secondary)" } }, roomName)),
                h("button", { type: "button", onClick: () => setSettingsOpen(false), className: "dshChatQuietButton", style: { width: 36, padding: 0 }, "aria-label": t("closeSettings") }, "×")
              ),
              error && h("p", { role: "alert", style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 13 } }, error),
              memberBusy && h("p", { role: "status" }, t("working")),
              h("section", { "aria-busy": memberBusy, style: { marginBottom: 28 } },
                h("h4", { style: { margin: "0 0 12px", fontSize: 13, color: "var(--dsw-alias-label-secondary)" } }, t("members")),
                h("div", { style: { display: "grid", gap: 9 } }, members.map((member) =>
                  h("div", { key: member.sessionId, title: member.sessionId, style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 9px", borderRadius: 10, background: "var(--dsw-alias-bg-layer-2)" } },
                    h(Avatar, { id: member.sessionId, label: memberName(member), title: memberName(member), size: 32, src: avatarSrc(member.sessionId, memberName(member)) }),
                    h("div", { style: { minWidth: 0, flex: 1 } },
                      h("div", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 600 } }, memberName(member)),
                      h("small", { style: { color: "var(--dsw-alias-label-secondary)" } }, member.workspaceTitle ?? t("workspace"))
                    ),
                    h("small", { style: { display: "inline-flex", alignItems: "center", gap: 5, color: "var(--dsw-alias-label-secondary)", flex: "0 0 auto" } },
                      h("span", { style: { width: 7, height: 7, borderRadius: "50%", background: stateColor(runtimeState(member)) } }),
                      stateLabel(runtimeState(member))
                    ),
                    h("button", { type: "button", disabled: memberBusy, onClick: () => removeMember(member), "aria-label": `${t("removeMember")}: ${memberName(member)}`, title: t("removeMember"), style: { flex: "0 0 auto", width: 26, height: 26, borderRadius: "50%", border: 0, background: "transparent", color: "var(--dsw-alias-label-tertiary)", font: "inherit", fontSize: 15, lineHeight: 1, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" } }, "×")
                  )
                )),
                members.length === 0 && h("small", { style: { color: "var(--dsw-alias-label-secondary)" } }, t("noMembers"))
              ),
              h("section", { "aria-busy": memberBusy, style: { marginBottom: 28 } },
                h("h4", { style: { margin: "0 0 4px", fontSize: 14 } }, t("addSession")),
                h("p", { style: { margin: "0 0 12px", color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, t("addHint")),
                h("label", { className: "dshChatField" }, t("workspace"),
                  h("select", { value: selectedWorkspace?.id ?? "", onChange: (event) => setWorkspaceId(event.target.value), disabled: workspaceRows.length === 0, className: "dshChatControl" }, workspaceRows.length ? workspaceRows.map((workspace) => h("option", { key: workspace.id, value: workspace.id }, workspace.title)) : h("option", { value: "" }, t("noWorkspaces")))
                ),
                h("input", { type: "search", value: sessionQuery, onChange: (event) => setSessionQuery(event.target.value), placeholder: t("searchSessions"), "aria-label": t("searchSessions"), className: "dshChatControl dshChatSearch" }),
                h("div", { role: "list", "aria-label": t("availableSessions"), style: { display: "grid", gap: 6, maxHeight: 260, marginTop: 9, overflow: "auto" } },
                  selectableSessions.slice(0, 50).map((session) => { const title = session.displayTitle ?? session.title ?? session.id; return h("button", { key: session.id, type: "button", disabled: memberBusy, onClick: () => addMember(session, selectedWorkspace), style: { display: "grid", gridTemplateColumns: "34px minmax(0,1fr) auto", alignItems: "center", gap: 10, width: "100%", padding: "8px 9px", border: 0, borderRadius: 10, background: "var(--dsw-alias-bg-layer-2)", color: "inherit", textAlign: "left", cursor: "pointer" } },
                    h(Avatar, { id: String(session.id), label: title, size: 32, src: avatarSrc(session.id, title) }),
                    h("span", { style: { minWidth: 0 } }, h("span", { style: { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 600 } }, title), h("small", { style: { color: "var(--dsw-alias-label-secondary)" } }, `${selectedWorkspace?.title ?? t("workspace")}`)),
                    h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, h("span", { style: { width: 7, height: 7, borderRadius: "50%", background: stateColor(runtimeState(session)) } }), stateLabel(runtimeState(session)))
                  ); }),
                  selectableSessions.length === 0 && h("small", { style: { padding: "12px 4px", color: "var(--dsw-alias-label-secondary)" } }, selectedWorkspace ? (query ? t("noMatching") : t("allMembers")) : t("noWorkspaces"))
                ),
              ),
              // 本地补丁 2026-10-04（补丁 16）：按页跳转（每页 200 条）。
              // 本地补丁 2026-10-04（补丁 18）：界面口径 **第 1 页 = 最早**，数字越大越接近最新；
              // 老房间进来默认停在第 1 页，活跃房间默认停在最后一页（= 跟随最新）。
              h("section", { "aria-busy": pageBusy, style: { marginBottom: 28 } },
                h("h4", { style: { margin: "0 0 4px", fontSize: 14 } }, t("pages")),
                h("p", { style: { margin: "0 0 12px", color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, t("pagesHint")),
                h("label", { className: "dshChatField" }, t("jumpPage"),
                  h("select", {
                    value: String(displayPage()), className: "dshChatControl",
                    disabled: pageBusy || pageInfo.pageCount <= 1,
                    "aria-label": t("pages"),
                    onChange: (event) => { void jumpToPage(Number(event.target.value), { force: true }); }
                  }, Array.from({ length: Math.max(1, pageInfo.pageCount) }, (_, index) => index + 1).map((page) =>
                    h("option", { key: page, value: String(page) }, pageLabel(page, Math.max(1, pageInfo.pageCount)))
                  ))
                ),
                pageBusy && h("small", { style: { color: "var(--dsw-alias-label-secondary)" } }, t("working")),
              ),
              // 本地补丁 2026-10-21（补丁 33）：危险操作 —— 删除本房间（二次确认）。
              h("section", { "aria-busy": deleteBusy },
                h("h4", { style: { margin: "0 0 4px", fontSize: 14, color: "var(--dsw-alias-state-error-primary)" } }, t("deleteRoom")),
                h("p", { style: { margin: "0 0 12px", color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, t("deleteRoomHint")),
                h("button", { type: "button", disabled: deleteBusy, onClick: runDeleteRoom, className: "dshChatQuietButton", style: deleteArmed ? { color: "var(--dsw-alias-state-error-primary)", fontWeight: 600 } : undefined }, deleteBusy ? t("deleteRoomBusy") : deleteArmed ? t("deleteRoomConfirm") : t("deleteRoom"))
              )
            )
          )
        );
      }

      function RoomComposer({ matched, sessionId }) {
        const [draft, setDraft] = React.useState("");
        const [members, setMembers] = React.useState([]);
        const [selectedMentions, setSelectedMentions] = React.useState([]);
        // 本地补丁 2026-10-09（补丁 25）：@all 芯片上的「唤醒」勾选（默认关、发完**不**重置）。
        // 勾上 = 这次 @all 连「全员名单」一起发（服务端在发送那一刻展开），每个人都真的被叫醒；
        // 不勾 = 现状：只投递、不唤醒。
        const [wakeAll, setWakeAll] = React.useState(false);
        const [sending, setSending] = React.useState(false);
        const [error, setError] = React.useState("");
        // 本地补丁 2026-10-04（补丁 20）：本房间的「发言框接管」提示（外部适配器给的只读前缀）。
        // 本地补丁 2026-10-05（补丁 22）：同一个端点还带回**动作条**（按钮 / 勾选框）。
        const [rule, setRule] = React.useState(null);
        const [actionValues, setActionValues] = React.useState({});
        const [actionBusy, setActionBusy] = React.useState(false);
        // 本地补丁 2026-10-05（补丁 23）：本房间是不是**老房间（冷存、只读）**。这件事只有
        // `listRooms` 知道（补丁 18 同款判据）；为 true 时整条发言框换成一行只读提示 ——
        // 冷存房间的 `send()` 会被服务端直接拒绝，任何控件都是空承诺。
        // `null` = 还没问到（第一帧），按「不是老房间」画，问到后立刻收敛。
        const [coldStored, setColdStored] = React.useState(null);
        // 本地补丁 2026-10-05（补丁 24）：发言框里的房间名同样跟随 rooms.json —— 复用下面那次
        // 每 2 秒一次的 listRooms 轮询，不新增请求。初始值仍是 select 给的 matched.name。
        const [roomName, setRoomName] = React.useState(matched.name);
        const sendController = React.useRef(null);
        // 拿不到提示一律当「没有」，并且永不抛错 —— 提示坏了绝不能影响发言。
        // 返回 null = 既没有提示条、也没有动作条（这个房间没有任何外部贡献）。
        const loadRule = async (signal) => {
          try {
            const next = await call("composerRule", { roomId: matched.roomId }, signal);
            if (!next || typeof next !== "object") return null;
            const actions = Array.isArray(next.actions) ? next.actions : [];
            const prefix = typeof next.prefix === "string" ? next.prefix : "";
            if (prefix === "" && actions.length === 0) return null;
            return { prefix, hint: next.hint, actions };
          } catch { return null; }
        };
        // 勾选框的当前值 = 本地覆盖 ?? 适配器声明的默认值。
        // ⚠ 不用 effect 播种：那样会先按「未勾选」画一帧、再纠正（而且用户改过之后不该被轮询覆盖）。
        const actionValueOf = (action) => {
          const id = String(action?.id ?? "");
          return id in actionValues ? actionValues[id] === true : action?.value === true;
        };
        React.useEffect(() => {
          const controller = new AbortController(); const signal = controller.signal;
          let timer;
          const refresh = async () => {
            // 本地补丁 2026-10-04（补丁 20）：顺手问一次发言框提示/动作条（2 秒一次，很便宜）。
            const next = await loadRule(signal);
            if (!signal.aborted) setRule(next);
            // 本地补丁 2026-09-30（补丁 10）：同上，只列当前房间。
            // 本地补丁 2026-10-05（补丁 23）：同一次响应里顺手记住这房间是不是冷存（老房间）——
            // 不新增请求，判据与服务端只读判据同源。
            try { const rooms = await call("listRooms", { roomId: matched.roomId }, signal); const current = rooms.find((room) => room.id === matched.roomId); if (!signal.aborted) { if (current?.name) setRoomName(String(current.name)); setMembers(current?.members ?? []); setColdStored(current?.coldStored === true); } }
            catch (cause) { if (!signal.aborted) setError(String(cause.message ?? cause)); }
            finally { if (!signal.aborted) timer = setTimeout(refresh, 2_000); }
          };
          void refresh();
          return () => { controller.abort(); clearTimeout(timer); sendController.current?.abort(); sendController.current = null; };
        }, [matched.roomId]);
        const nameOf = (member) => {
          const current = ctx.sessions.list.getSnapshot().byId[member.sessionId];
          return current?.displayTitle ?? current?.title ?? member.alias ?? displayName(member.sessionId);
        };
        const mentionable = members.filter((member) => !(member.kind === "session" && member.sessionId === String(sessionId)) && runtimeState(member) !== "archived");
        // 本地补丁 2026-10-09（补丁 25）：勾了「唤醒」但**这条不会生效**的两种情形 ——
        // ① 正文里没有 @all（勾选框只对 @all 生效）；② 有外部接管方在场（前缀条显示中）：点名归它算，
        // 我们的 members 记号会被它替换掉。只把这一块画暗 + 换 tooltip，**不拦着点** ——
        // 正常操作顺序本来就是「先勾、再点 @all」。
        const wakeIdle = wakeAll && (!/(^|\s)@all\b/i.test(draft) || (rule !== null && rule.prefix !== ""));
        const insertMention = (member) => {
          const token = `@${nameOf(member)}`;
          setDraft((value) => `${value}${value && !/\s$/.test(value) ? " " : ""}${token} `);
          const reference = memberReference(member);
          setSelectedMentions((value) => value.some((item) => item.reference === reference) ? value : [...value, { reference, token }]);
        };
        // 本地补丁 2026-09-28：@all 全员广播。
        // 投递层本来就认这个引用：room-store 的 #mentions 对 "all" 原样放行、
        // #deliver 在 mentions 含 "all" 时把 recipients 取成整间房的成员。
        // 缺的只是前端产生 "all" 这个引用的入口——文本从不被解析（chat_send 的
        // 契约就是"Message text is never parsed for delivery"），所以手打 @all
        // 过去是空提及。这里补一个按钮，并在发送时把正文里手打的 @all 也算上。
        const insertAllMention = () => {
          const token = "@all";
          setDraft((value) => `${value}${value && !/\s$/.test(value) ? " " : ""}${token} `);
          setSelectedMentions((value) => value.some((item) => item.reference === "all") ? value : [...value, { reference: "all", token }]);
        };
        const send = async (event) => {
          event.preventDefault(); if (!draft.trim() || sendController.current) return;
          const controller = new AbortController(); sendController.current = controller;
          setSending(true); setError("");
          try {
            const selected = selectedMentions.filter((item) => draft.includes(item.token)).map((item) => item.reference);
            // 本地补丁 2026-09-28：手打的 @all 也视为广播（写成 \b 边界，
            // 中文字符在 JS 正则里属非单词字符，所以 "@all 各位" / "@all，" 都命中）。
            if (/(^|\s)@all\b/i.test(draft)) selected.push("all");
            const mentions = [...new Set(selected)];
            // 本地补丁 2026-10-09（补丁 25）：勾了「唤醒」且这次确实是 @all 广播 ⇒ 带上保留记号
            // `members` —— 服务端在**发送那一刻**把它展开成房间当前全部成员引用（名单不会陈旧，
            // 也避免了「成员刚被移出 ⇒ 这条发送被拒」）。勾了但没 @all ⇒ 等同没勾。
            if (wakeAll && mentions.includes("all")) mentions.push("members");
            const current = ctx.sessions.list.getSnapshot().byId[String(sessionId)];
            const authorAlias = String(sessionId).startsWith("dsh-chat-room-") ? "You" : current?.displayTitle ?? current?.title ?? displayName(sessionId);
            await call("send", { request: { roomId: matched.roomId, author: String(sessionId), authorAlias, text: draft, mentions } }, controller.signal);
            if (controller.signal.aborted) return;
            // 本地补丁 2026-10-04（补丁 20）：话已出口就不再轮到你 —— 先把提示收掉，
            // 2 秒后的那次轮询会带回真实状态（例如下一轮又是你）。
            setRule(null);
            setDraft(""); setSelectedMentions([]); setError("");
          } catch (cause) { if (!controller.signal.aborted) setError(String(cause.message ?? cause)); }
          finally { if (sendController.current === controller) { sendController.current = null; setSending(false); } }
        };
        // 本地补丁 2026-10-05（补丁 22）：动作条。`toggle` 只改本地勾选状态（真正执行发生在
        // 按下按钮时，随 `values` 一起交给适配器）；`button` 立刻回宿主执行，**失败原因显示给人看**。
        const runAction = async (action) => {
          const id = String(action?.id ?? "");
          if (id === "") return;
          if (action.kind === "toggle") {
            setActionValues((current) => {
              const was = id in current ? current[id] === true : action.value === true;
              return { ...current, [id]: !was };
            });
            return;
          }
          if (actionBusy) return;
          setActionBusy(true); setError("");
          try {
            // 勾选框的**当前**取值随动作一起回宿主（宿主不掌握本地勾选状态）。
            const values = {};
            for (const item of (rule?.actions ?? [])) {
              const itemId = String(item?.id ?? "");
              if (itemId !== "" && item.kind === "toggle") values[itemId] = actionValueOf(item);
            }
            const result = await call("composerAction", { roomId: matched.roomId, id, values }, undefined);
            if (result?.ok === false) setError(String(result.text ?? "") || t("composerActionFailed"));
            const next = await loadRule(undefined);
            setRule(next);
          } catch (cause) { setError(String(cause.message ?? cause)); }
          finally { setActionBusy(false); }
        };
        // 本地补丁 2026-10-05（补丁 23）：**老房间（冷存、只读）不发任何发言控件**。
        // 一次收掉三样：@all / 成员 @ 那一排、外部适配器的动作条（本机是庄家的「开局 / 真人 /
        // 随机」）、以及输入框本身 —— 冷存房间的 `send()` 会被服务端拒绝，留着输入框只会让人
        // 白打一段再吃一个报错。老房间只剩「翻阅历史」这一个用途（与补丁 18 的默认第 1 页同口径）。
        if (coldStored === true) {
          return h("div", { className: "dshChatRoom", style: { width: "min(780px, calc(100% - 32px))", margin: "0 auto", padding: "10px 0 18px" } },
            error && h("small", { role: "alert", style: { display: "block", margin: "0 12px 7px", color: "var(--dsw-alias-state-error-primary)" } }, error),
            h("section", { "data-dsh-chat-archived": String(matched.roomId), "aria-label": t("roomArchived"), style: { padding: "11px 13px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 19, background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-secondary)", fontSize: 13, lineHeight: 1.5 } }, t("roomArchived"))
          );
        }
        return h("div", { className: "dshChatRoom", style: { width: "min(780px, calc(100% - 32px))", margin: "0 auto", padding: "10px 0 18px" } },
          error && h("small", { role: "alert", style: { display: "block", margin: "0 12px 7px", color: "var(--dsw-alias-state-error-primary)" } }, error),
          h("form", { onSubmit: send, className: "dshChatComposer", style: { padding: "12px 12px 9px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 19, background: "var(--dsw-alias-bg-layer-1)", boxShadow: "var(--dsw-shadow-lv1)" } },
            // 本地补丁 2026-10-04（补丁 20）：外部接管方（例如狼人杀庄家）声明「这条发言的前缀与点名
            // 由我代填」时，在输入框上方显示一段**只读前缀**。这里只是提示：发送时交上去的仍是正文，
            // 真正的改写发生在服务端落盘之前（room-store 的 setComposerAdapter.rewrite）。
            rule !== null && rule.prefix !== "" && h("div", { "aria-label": t("composerTakeover"), title: t("composerTakeoverHint"), style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, padding: "0 2px 9px", fontSize: 12 } }, [
              h("span", { key: "prefix", style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", padding: "2px 7px", borderRadius: 7, background: "color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, var(--dsw-alias-bg-layer-1))", color: "var(--dsw-alias-state-business-primary)", fontWeight: 600 } }, String(rule.prefix)),
              h("span", { key: "hint", style: { color: "var(--dsw-alias-label-secondary)" } }, t("composerTakeoverHint")),
              rule.hint ? h("span", { key: "extra", style: { color: "var(--dsw-alias-label-tertiary)" } }, String(rule.hint)) : null
            ]),
            // 本地补丁 2026-10-05（补丁 22）：与提及按钮同一排，**右对齐**（占满整排时贴到最右边）。
            (mentionable.length > 0 || (rule !== null && rule.actions.length > 0)) && h("div", { "aria-label": t("mentionSession"), style: { display: "flex", alignItems: "center", gap: 6, padding: "0 2px 9px", overflowX: "auto" } }, [
              // 本地补丁 2026-09-28：@all 全员广播按钮，排在成员按钮之前，用主题色
              // 强调以便与普通成员按钮区分。
              // 本地补丁 2026-10-09（补丁 25）：整块改成「[✓ 唤醒] @all」芯片 —— 点 @all 照旧只插入
              // 正文 token，勾选框只翻本地状态（发送时才生效，见上面的 mentions 拼装）。
              h("span", { key: "__all__", style: { flex: "0 0 auto", display: "inline-flex", alignItems: "stretch", border: "1px solid var(--dsw-alias-state-business-primary)", borderRadius: 14, background: "color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, var(--dsw-alias-bg-layer-1))", color: "var(--dsw-alias-state-business-primary)", overflow: "hidden" } }, [
                h("label", { key: "__wake__", title: wakeIdle ? t("wakeAllIdle") : t("wakeAllHint"), style: { flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px 3px 9px", font: "inherit", fontSize: 12, fontWeight: 600, opacity: wakeIdle ? ".5" : "1", cursor: sending ? "default" : "pointer", borderRight: "1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, transparent)" } }, [
                  h("input", { type: "checkbox", checked: wakeAll, disabled: sending, onChange: () => setWakeAll((value) => !value), "aria-label": t("wakeAll"), title: wakeIdle ? t("wakeAllIdle") : t("wakeAllHint"), style: { margin: 0, cursor: sending ? "default" : "pointer" } }),
                  t("wakeAll")
                ]),
                h("button", { key: "__allToken__", type: "button", disabled: sending, onClick: insertAllMention, title: t("mentionAllHint"), "aria-label": t("mentionAllHint"), style: { flex: "0 0 auto", border: 0, background: "transparent", color: "inherit", font: "inherit", fontSize: 12, fontWeight: 600, padding: "3px 9px", cursor: sending ? "default" : "pointer" } }, "@all")
              ]),
              ...mentionable.map((member) => {
              const state = runtimeState(member);
              const label = nameOf(member);
              return h("button", { key: member.sessionId, type: "button", disabled: sending, onClick: () => insertMention(member), title: `${label} · ${stateLabel(state)}`, "aria-label": `${t("mention")} ${label}, ${stateLabel(state)}`, style: { flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 14, background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-secondary)", padding: "3px 9px", font: "inherit", fontSize: 12, cursor: "pointer" } },
                h("span", { "aria-hidden": true, style: { width: 7, height: 7, flex: "0 0 7px", borderRadius: "50%", background: stateColor(state), boxShadow: state === "running" || state === "waking" ? `0 0 0 2px color-mix(in srgb, ${stateColor(state)} 18%, transparent)` : "none" } }),
                `@${label}`
              );
            }),
              // 本地补丁 2026-10-05（补丁 22）：动作条 —— 贴到这一排的最右边。
              rule !== null && rule.actions.length > 0 && h("div", { key: "__actions__", "aria-label": t("composerActions"), style: { marginLeft: "auto", flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8 } },
                rule.actions.map((action) => {
                  const id = String(action?.id ?? "");
                  const label = String(action?.label ?? id);
                  const disabled = sending || actionBusy || action.disabled === true;
                  const title = action.hint === undefined ? label : String(action.hint);
                  if (action.kind === "toggle") {
                    return h("label", { key: id, title, style: { flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 14, background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-secondary)", padding: "3px 9px", font: "inherit", fontSize: 12, cursor: disabled ? "default" : "pointer", opacity: disabled ? ".45" : "1" } },
                      h("input", { type: "checkbox", checked: actionValueOf(action), disabled, onChange: () => runAction(action), style: { margin: 0, cursor: disabled ? "default" : "pointer" } }),
                      label
                    );
                  }
                  return h("button", { key: id, type: "button", disabled, onClick: () => runAction(action), title, "aria-label": title, style: { flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid var(--dsw-alias-state-business-primary)", borderRadius: 14, background: "color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, var(--dsw-alias-bg-layer-1))", color: "var(--dsw-alias-state-business-primary)", padding: "3px 11px", font: "inherit", fontSize: 12, fontWeight: 600, cursor: disabled ? "default" : "pointer", opacity: disabled ? ".45" : "1" } }, actionBusy ? "…" : label);
                })
              )
            ]),
            h("textarea", { disabled: sending, "aria-label": `${t("message")} ${roomName}`, value: draft, onChange: (event) => { const value = event.target.value; setDraft(value); setSelectedMentions((items) => items.filter((item) => value.includes(item.token))); }, rows: 2, placeholder: `${t("message")} ${roomName}`, style: { width: "100%", minHeight: 44, maxHeight: 160, resize: "vertical", boxSizing: "border-box", padding: "2px 4px 8px", border: 0, outline: 0, background: "transparent", color: "inherit", font: "inherit", lineHeight: 1.45 } }),
            h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } },
              h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, h("span", { style: { width: 25, height: 25, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--dsw-alias-bg-layer-2)", fontWeight: 500 } }, "@"), t("mentionHint")),
              h("button", { type: "submit", disabled: sending || !draft.trim(), "aria-label": t("send"), style: { width: 36, height: 36, border: 0, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", background: draft.trim() && !sending ? "var(--dsw-alias-button-primary-fill)" : "var(--dsw-alias-bg-layer-3)", color: draft.trim() && !sending ? "var(--dsw-alias-label-primary-foreground)" : "var(--dsw-alias-label-tertiary)", cursor: draft.trim() && !sending ? "pointer" : "default", fontSize: 19, transition: "transform .15s ease, background .15s ease" } }, sending ? "…" : "↑")
            )
          )
        );
      }

      ctx.effect(() => {
        const disposeNode = ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({ name: "conversation.chat.node", key: "dsh-chat-room" }, RoomTimeline));
        // 本地补丁 2026-09-30（补丁 12）：静默广播在成员会话里的可见卡片。
        const disposeBroadcast = ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({ name: "conversation.chat.node", key: "dsh-chat-broadcast" }, BroadcastNotice));
        const disposeComposer = ctx.slots.inject("conversation.composer", () => ctx.slots.register({
          name: "conversation.composer",
          priority: -20,
          select: (owner) => {
            const node = roomNode(ctx, owner);
            if (node) return { roomId: node.data.roomId, name: node.data.name };
            // The chain is selected before the Chat target activates. The room's
            // durable session id is available immediately, so the regular agent
            // composer must never become the fallback for a known room.
            const prefix = "dsh-chat-room-v3-";
            if (typeof owner?.sessionId === "string" && owner.sessionId.startsWith(prefix)) {
              const row = ctx.sessions?.list?.getSnapshot?.()?.byId?.[owner.sessionId];
              return { roomId: owner.sessionId.slice(prefix.length), name: row?.displayTitle ?? row?.title ?? t("roomMessages") };
            }
            return null;
          }
        }, RoomComposer));
        return () => { disposeNode(); disposeBroadcast(); disposeComposer(); };
      }, "dsh-chat: conversation contributions");
    }
    exports.apply = apply;
    exports.inject = inject;
      return module.exports;
    })();

    // ── 庄家半边（私聊卡片、弹窗信箱）────────────────────────────────────────────────
    const dealerHalf = (() => {
      const module = { exports: {} };
      const exports = module.exports;
      const React = require("react");
      const h = React.createElement;


		/**
		 * 本插件私聊消息的 producer kind。
		 * ⚠ 与 Host 半边 `index.js` 的 `SOURCE_KIND` 必须一致：那边写进消息的 `source.kind`，
		 * 这边据此认领。改一处必须改两处，否则卡片不渲染（消息回落到不可见的 context 行）。
		 */
		const SOURCE_KIND = 'plugin:dsh-werewolf-dealer';
		/** 本插件自己的 Chat 节点 kind（不在官方 ChatNodeKind 表里，与 dsh-chat 的做法一致）。 */
		const NODE_KIND = 'werewolf-dealer-mail';
		const NS = 'dsh-werewolf-dealer';

		/** 可见文本一律走 locale（本插件只提供 zh / en 两本字典，与 dsh-chat 同口径）。 */
		const dictionaries = {
			zh: {
				title: '庄家私聊',
				hint: '用 `/ww-reply <回答>` 回复',
				popupTitle: '庄家私聊',
				popupDrag: '按住这一行可以拖动浮层',
				popupAck: '知道了',
				popupHint: '在房间发言框里直接回 `/ww-reply <回答>`；这条不会出现在房间时间线上。',
				// v1.31.0（2026-10-18）：**需要作答的卡不再画「知道了」** —— 底部换成这句话，只能点选项作答。
				popupAnswerHint: '这张卡要先作答：点上面的按钮，答完自动收起；也可以手打 `/ww-reply <回答>`。',
				// 逃生口：只有庄家**明确拒收**这张卡（如"这张卡已经过期了"）之后才出现。
				popupDismiss: '关闭这张卡',
				popupFailed: '暂时连不上庄家（这是弹窗通道的问题，不影响对局状态）',
				popupAnswerFailed: '这个回答没送到庄家（不影响对局状态，可以再点一次或改用 /ww-reply）',
				settingsTitle: '狼人杀庄家',
				settingsIntro: '这些设置写进 profile 的 `cordis.patch.yml`（`- id: werewolf-dealer`），保存后由宿主重载生效；与 `/ww-config` 报的是同一份。',
				settingsLoading: '正在读取配置…',
				settingsLoadFailed: '读不到配置',
				settingsSave: '保存',
				settingsSaving: '保存中…',
				settingsSaved: '已保存',
				settingsSaveFailed: '保存失败',
				settingsRestartHint: '路径类设置（状态目录 / 导出目录 / 房间文件）在下次加载时生效；对局数据不受影响。',
				fExportDir: '导出目录（赛后复盘 raw；留空 = 不导出）',
				fStateDir: '状态目录（私有；留空 = 平台默认）',
				fAvatarFile: '头像映射 JSON（留空 = 房间数据同目录）',
				fHumanName: '真人席位名',
				fChatstyle: '复盘 Chatbox 样式',
				fReminderMs: '空转提醒（毫秒；0 = 关）',
				fAppealReplayLines: '上诉回放条数（0 = 只回执）',
				fAiPauseTool: 'AI 叫停键 wolf_pause',
				fVoteDeadlineMs: '投票催票（毫秒；0 = 关）',
				fVoteGraceMs: '投票宽限（毫秒；0 = 关）',
				fPath: '房间数据文件（一般不用改）',
				fWorkspacePath: '房间工作区（一般不用改）'
			},
			en: {
				title: 'Dealer PM',
				hint: 'Reply with `/ww-reply <answer>`',
				popupTitle: 'Dealer PM',
				popupDrag: 'Drag this row to move the popup',
				popupAck: 'Got it',
				popupHint: 'Answer with `/ww-reply <answer>` in the room composer; it never reaches the room timeline.',
				popupAnswerHint: 'Answer with the buttons above (or type `/ww-reply <answer>`); the card closes when the dealer accepts it.',
				popupDismiss: 'Close this card',
				popupFailed: 'Cannot reach the dealer right now (popup channel only; the game state is unaffected)',
				popupAnswerFailed: 'That answer did not reach the dealer (the game state is unaffected; click again or use /ww-reply)',
				settingsTitle: 'Werewolf dealer',
				settingsIntro: 'These values are written into the profile `cordis.patch.yml` (`- id: werewolf-dealer`) and take effect when the host reloads the plugin; same source as `/ww-config`.',
				settingsLoading: 'Loading configuration…',
				settingsLoadFailed: 'Cannot load configuration',
				settingsSave: 'Save',
				settingsSaving: 'Saving…',
				settingsSaved: 'Saved',
				settingsSaveFailed: 'Save failed',
				settingsRestartHint: 'Path settings (state dir / export dir / room file) apply on the next load; game data is unaffected.',
				fExportDir: 'Export directory (recap raw; empty = do not export)',
				fStateDir: 'State directory (private; empty = platform default)',
				fAvatarFile: 'Avatar map JSON (empty = next to the room data)',
				fHumanName: 'Human seat name',
				fChatstyle: 'Recap Chatbox style',
				fReminderMs: 'Idle reminder (ms; 0 = off)',
				fAppealReplayLines: 'Appeal replay lines (0 = receipt only)',
				fAiPauseTool: 'AI pause tool (wolf_pause)',
				fVoteDeadlineMs: 'Vote prompt (ms; 0 = off)',
				fVoteGraceMs: 'Vote grace (ms; 0 = off)',
				fPath: 'Room data file (rarely changed)',
				fWorkspacePath: 'Room workspace (rarely changed)'
			}
		};

		/**
		 * v2.0.0：设置页（`settings.section`）的字段表。kind 决定输入控件与保存时的类型转换。
		 * 后端只接受这 12 个键（`/api/dsh-werewolf` 的 `config-set`），未知键会被忽略。
		 */
		const SETTINGS_FIELDS = [
			{ key: 'exportDir', label: 'fExportDir', kind: 'text' },
			{ key: 'stateDir', label: 'fStateDir', kind: 'text' },
			{ key: 'avatarFile', label: 'fAvatarFile', kind: 'text' },
			{ key: 'humanName', label: 'fHumanName', kind: 'text' },
			{ key: 'chatstyle', label: 'fChatstyle', kind: 'select', options: ['qqchat', 'wechat', 'bbs', 'pop', 'linshe', 'baker'] },
			{ key: 'reminderMs', label: 'fReminderMs', kind: 'number' },
			{ key: 'appealReplayLines', label: 'fAppealReplayLines', kind: 'number' },
			{ key: 'aiPauseTool', label: 'fAiPauseTool', kind: 'boolean' },
			{ key: 'voteDeadlineMs', label: 'fVoteDeadlineMs', kind: 'number' },
			{ key: 'voteGraceMs', label: 'fVoteGraceMs', kind: 'number' },
			{ key: 'path', label: 'fPath', kind: 'text' },
			{ key: 'workspacePath', label: 'fWorkspacePath', kind: 'text' }
		];
		const SETTINGS_LABEL_STYLE = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' };
		const SETTINGS_INPUT_STYLE = { boxSizing: 'border-box', width: '100%', height: 34, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', padding: '0 10px', font: 'inherit', fontSize: 13 };
		const SETTINGS_BUTTON_STYLE = { alignSelf: 'flex-start', minHeight: 32, padding: '0 16px', borderRadius: 16, border: 0, background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)', font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer' };

		/** 走本插件自己的 `/api/dsh-werewolf`（与弹窗信箱同一个端点、同一道 `/api` 围栏）。 */
		async function settingsRequest(endpoint, args) {
			const response = await fetch('/api/dsh-werewolf', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, args }) });
			const body = await response.json().catch(() => null);
			if (body === null) throw new Error(`HTTP ${response.status}`);
			if (body.ok !== true) throw new Error(String(body?.error?.message ?? 'request failed'));
			return body.value;
		}

		/**
		 * 设置页本体：读 → 改 → 保存（写 profile 补丁层）。字段少且都是标量，直接手写表单，
		 * 不引第三方表单库（客户端半边只允许 require react）。
		 */
		function WerewolfSettings(props) {
			const t = props?.t ?? ((key) => key);
			const [config, setConfig] = React.useState(undefined);
			const [error, setError] = React.useState('');
			const [status, setStatus] = React.useState('');
			const [busy, setBusy] = React.useState(false);
			React.useEffect(() => {
				let alive = true;
				settingsRequest('config').then((value) => { if (alive) setConfig(value?.config ?? {}); }, (reason) => { if (alive) setError(String(reason?.message ?? reason)); });
				return () => { alive = false; };
			}, []);
			const update = (key, value) => setConfig((current) => ({ ...(current ?? {}), [key]: value }));
			const save = async () => {
				setBusy(true);
				setStatus('');
				setError('');
				try {
					const patch = {};
					for (const field of SETTINGS_FIELDS) {
						const raw = config?.[field.key];
						patch[field.key] = field.kind === 'number' ? Number(raw ?? 0) : field.kind === 'boolean' ? raw === true : String(raw ?? '');
					}
					await settingsRequest('config-set', { patch });
					setStatus(t('settingsSaved'));
				} catch (reason) {
					setError(String(reason?.message ?? reason));
				} finally {
					setBusy(false);
				}
			};
			if (config === undefined) {
				return h('p', { role: 'status', style: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } },
					error === '' ? t('settingsLoading') : `${t('settingsLoadFailed')}：${error}`);
			}
			return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 } },
				h('p', { style: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t('settingsIntro')),
				...SETTINGS_FIELDS.map((field) => field.kind === 'boolean'
					// v2.0.0：勾选框与文案同一行（列布局会把方框甩到文本下面/居中）。
					? h('label', { key: field.key, style: { ...SETTINGS_LABEL_STYLE, flexDirection: 'row', alignItems: 'center', gap: 8 } },
						h('input', { type: 'checkbox', checked: config[field.key] === true, onChange: (event) => update(field.key, event.target.checked) }),
						h('span', null, t(field.label)))
					: h('label', { key: field.key, style: SETTINGS_LABEL_STYLE },
						h('span', null, t(field.label)),
						field.kind === 'select'
							? h('select', { value: String(config[field.key] ?? ''), onChange: (event) => update(field.key, event.target.value), style: SETTINGS_INPUT_STYLE },
								field.options.map((option) => h('option', { key: option, value: option }, option)))
							: h('input', { type: field.kind === 'number' ? 'number' : 'text', value: String(config[field.key] ?? ''), onChange: (event) => update(field.key, field.kind === 'number' ? Number(event.target.value) : event.target.value), style: SETTINGS_INPUT_STYLE })
					)),
				h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
					h('button', { type: 'button', disabled: busy, onClick: save, style: SETTINGS_BUTTON_STYLE }, busy ? t('settingsSaving') : t('settingsSave')),
					status === '' ? null : h('span', { role: 'status', style: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' } }, status),
					error === '' ? null : h('span', { role: 'alert', style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, `${t('settingsSaveFailed')}：${error}`)
				),
				h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('settingsRestartHint'))
			);
		}

		/**
		 * 剥掉 dsh-bridge 的信封行。
		 * 桥接层落盘时会在正文前加一行 `[dsh-bridge <transport> message <id> from <from>]`
		 * （那是给模型看的投递说明），卡片上只该显示庄家的原文。
		 * 只剥「整行形如信封」的第一行，其余原样保留（私聊正文本身可能多行）。
		 */
		function stripEnvelope(text) {
			const raw = String(text ?? '');
			const cut = raw.indexOf('\n');
			if (cut < 0) return raw;
			const head = raw.slice(0, cut);
			return head.startsWith('[dsh-bridge ') && head.endsWith(']') ? raw.slice(cut + 1) : raw;
		}

		/** 取事件里的第一段文本（结构异常时返回空串，绝不抛）。 */
		function firstText(event) {
			const blocks = Array.isArray(event?.data?.content) ? event.data.content : [];
			const block = blocks.find((item) => item?.type === 'text');
			return typeof block?.text === 'string' ? block.text : '';
		}

		const PLAIN_STYLE = {
			whiteSpace: 'pre-wrap',
			overflowWrap: 'anywhere',
			lineHeight: 1.55,
			fontSize: 14,
			color: 'var(--dsw-alias-label-primary)'
		};

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, dictionaries), `${NS}: dictionaries`);

			// v2.0.0：设置页（侧栏「设置」里的一项）。契约照 dsh-comfyui / dsh-meme：
			// `settings.section` + { id, order, label }，组件自己读写本插件的配置端点。
			ctx.effect(
				() => ctx.slots.inject('settings.section', () => ctx.slots.register({
					name: 'settings.section',
					id: 'werewolf',
					order: 25,
					label: () => t('settingsTitle')
				}, (props) => h(WerewolfSettings, { t, ...(props ?? {}) }))),
				`${NS}: settings section`
			);

			/**
			 * v1.16.12：这条消息是被**哪个 inbox 队列** claim 的。
			 *
			 * - `inbox-next-step`（官方注释：`messages admitted into a running Turn`）= dsh-bridge 的 `inject` 路径
			 *   ⇒ 官方 `messageDefinition.match()` 要求 `isAppendSurfaceEvent(event)`，**不认它 ⇒ 官方不渲染**
			 *   ⇒ 由我们补一张卡片（用户 2026-10-05：事后单独查看 AI 会话复盘时，要看得到当时的消息窗口）。
			 * - `inbox-next-turn`（唤醒一个新 Turn）⇒ 官方渲染 `turn-trigger` 行 ⇒ 我们**不画**（v1.7.7 双气泡教训）。
			 *
			 * ⚠ 这里依赖官方 inbox 节点 kind 名（`inbox-next-step` / `inbox-next-turn`，见
			 * `@deepseek-ai/dsh-client-ui-chat/lib/types/client/conversation-nodes/inbox.d.ts`）⇒
			 * 全程 try/catch，读不到就返回 `undefined`，调用方退回"只画落表面"的老行为。
			 * @param reader - definition `start()` 的第三参数（官方 `messageDefinition` 同样用它）。
			 * @param id - 消息 id。
			 * @returns `{ step, turn }`：`true` = 被该队列的当前 claim 收下；`false` = 明确没被收；`undefined` = 读不到。
			 */
			function claimedBy(reader, id) {
				const read = (kind) => {
					try {
						const state = reader?.previous?.(kind)?.state;
						if (state === undefined || state === null) return undefined;
						const set = state.currentClaimed;
						if (set === undefined || typeof set.has !== "function") return undefined;
						return set.has(id) === true;
					} catch {
						return undefined;
					}
				};
				return { step: read("inbox-next-step"), turn: read("inbox-next-turn") };
			}

			/**
			 * 事件定义：一条 `user/message`（源是我们的 producer kind）= 一张卡片。
			 * `publication: 'immediate'` 让它不等回合边界立刻出现（dsh-chat 同款）。
			 */
			const definition = {
				kind: NODE_KIND,
				target: 'chat',
				/**
				 * 源与类型对得上就是候选；**官方会不会自己画**的判定挪到 `start()`（那里能读 inbox claim 状态）。
				 *
				 * ⚠ 会**唤醒**会话的消息（`wake:true`）走 `next-turn`：它成为该回合的触发输入，官方渲染器把它升级成
				 * 可见的 `turn-trigger` 行（判定见 `dsh-client-ui-chat/lib/client.js:9284/9305`）。那种消息**本来就看得见**，
				 * 我们再画一张卡 = 同一个气泡画两遍（用户 2026-10-04 真机："狼只发一条信息，但有两个气泡框"）。
				 */
				match(event) {
					if (event.type !== 'user/message') return null;
					if (event.data?.source?.kind !== SOURCE_KIND) return null;
					return { id: String(event.data.id), role: 'start' };
				},
				start(_context, match, reader) {
					const event = match.event;
					const id = String(event.data?.id ?? '');
					const onSurface = event.surfaceOp === 'append';
					const claimed = claimedBy(reader, id);
					// 唤醒类：官方会画 `turn-trigger` ⇒ 我们不画。
					if (claimed.turn === true) return null;
					// 既没落表面、也读不到 `next-step` claim（reader 不可用 / 官方改了 kind 名）⇒ 保守不画。
					if (onSurface !== true && claimed.step !== true) return null;
					return {
						id,
						time: event.time ?? Date.now(),
						text: stripEnvelope(firstText(event))
					};
				},
				update(context) {
					return context.state;
				},
				publication: () => 'immediate',
				buildViewNode(context) {
					if (!context.state) return null;
					return {
						key: context.key,
						kind: NODE_KIND,
						id: context.id,
						target: 'chat',
						anchorSeq: context.start?.event.seq ?? 0,
						// 不参与「已完成回合的步骤折叠」：私聊卡片必须独立成行。
						location: { kind: 'unresolved' },
						visibility: 'visible',
						data: context.state
					};
				}
			};
			ctx.effect(() => ctx.uiConversation.events.register(definition), `${NS}: mail node definition`);

			/**
			 * 错误边界：槽位里的组件抛错会让**整块槽位空白**（console 报
			 * `slot entry crashed in '<slot>'`）。这里兜住并退回纯文本——最坏只是「没样式」。
			 */
			class MailBoundary extends React.Component {
				constructor(props) {
					super(props);
					this.state = { failed: false };
				}
				static getDerivedStateFromError() {
					return { failed: true };
				}
				componentDidCatch() {
					/* 静默降级：纯文本也能读，私聊内容不能因为渲染失败而消失 */
				}
				render() {
					return this.state.failed
						? h('div', { style: PLAIN_STYLE }, this.props.text)
						: this.props.children;
				}
			}

			/** 卡片本体：标题「📨 庄家私聊」+ 正文 + 一句怎么回。 */
			function DealerMail({ node }) {
				const data = node?.data ?? {};
				const stamp = typeof data.time === 'number' ? data.time : Date.now();
				const text = String(data.text ?? '');
				return h(
					MailBoundary,
					{ text },
					h(
						'section',
						{
							'data-dsh-werewolf-mail': String(data.id ?? ''),
							'aria-label': t('title'),
							style: {
								width: 'min(780px, calc(100% - 32px))',
								margin: '0 auto',
								border: '0.5px solid var(--dsw-alias-border-l1)',
								borderRadius: 12,
								background: 'var(--dsw-alias-bg-layer-2)',
								padding: '12px 16px',
								display: 'flex',
								flexDirection: 'column',
								gap: 6
							}
						},
						h(
							'div',
							{
								style: {
									display: 'flex',
									alignItems: 'center',
									gap: 8,
									color: 'var(--dsw-alias-label-secondary)',
									fontSize: 12
								}
							},
							h('span', { 'aria-hidden': true }, '📨'),
							h('span', null, t('title')),
							h(
								'time',
								{
									dateTime: new Date(stamp).toISOString(),
									style: { marginLeft: 'auto' }
								},
								new Date(stamp).toLocaleTimeString(ctx.locale.getLocale?.().active ?? undefined, {
									hour: '2-digit',
									minute: '2-digit'
								})
							)
						),
						h('div', { style: { ...PLAIN_STYLE, fontSize: 15 } }, text),
						h(
							'div',
							{
								style: {
									borderTop: '0.5px solid var(--dsw-alias-border-l1)',
									paddingTop: 6,
									color: 'var(--dsw-alias-label-secondary)',
									fontSize: 12
								}
							},
							t('hint')
						)
					)
				);
			}

			ctx.effect(
				() =>
					ctx.slots.inject('conversation.chat.node', () =>
						ctx.slots.register({ name: 'conversation.chat.node', key: NODE_KIND }, DealerMail)
					),
				`${NS}: conversation contributions`
			);

			// ------------------------------------------------------------ 弹窗信箱（v1.11.0）

			/**
			 * v1.11.0：**浮层弹窗**。用户 2026-10-04 的要求：「所有命令直接在房间里执行，信息用弹窗给我」。
			 *
			 * 牌面 / 验人结果 / 夜序提问 / 命令回执**不落任何会话**：Host 半边把它们写进局内弹窗信箱
			 * （`<gameId>.mail.jsonl`），由 `/api/dsh-werewolf` 的 `inbox` 端点吐出来，这里画成一张
			 * 全局浮层卡片（`shell.overlay` —— 帧级浮层，人在哪个页面都能看到）。
			 *
			 * ⚠ **游标只在「知道了」/答完一张卡之后才推进**：关掉浏览器再回来，没看过的还会再弹（宁重复、不丢）。
			 * v1.31.0：**必答卡（带 options）没有「知道了」** —— 唯一的收起方式是作答成功；否则误点一次
			 * 就把题目永久丢掉（确认阶段会因此整局静默停住，见下方 `actionable` 那段）。
			 * 端点与 `/api/dsh-chat` 同款（POST + `{ok,value|error}` 信封 + `/api` 浏览器围栏）。
			 */
			const MAILBOX_PATH = '/api/dsh-werewolf';
			const CURSOR_KEY = `${NS}:mail-cursor`;

			async function fetchMailbox(since, signal) {
				const response = await fetch(MAILBOX_PATH, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					credentials: 'same-origin',
					signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
					body: JSON.stringify({ endpoint: 'inbox', args: { since } })
				});
				if (!response.ok) throw new Error(`werewolf mailbox failed: HTTP ${response.status}`);
				const envelope = await response.json();
				if (envelope?.ok !== true) throw new Error(envelope?.error?.message ?? 'werewolf mailbox failed');
				return envelope.value ?? { records: [], seq: since, more: false };
			}

			/**
			 * 一张浮层卡片：把这一批未读私密内容一次显示完。
			 *
			 * v1.14.0：**提问卡上带按钮**（`record.options` = `[{ label, text }]`）—— 真人顺着按钮点
			 * 就能答完夜序，不必手打 `/ww-reply`。按钮回的是选项里写好的 `text`，与手打那条命令
			 * **同一条入口**（`/api/dsh-werewolf` 的 `reply` 端点 → `game.onPrivateReply`），
			 * 所以「点按钮」与「打字」在庄家那边完全等价；打字永远是保底。
			 */
			function DealerMailPopup() {
				const [records, setRecords] = React.useState([]);
				const [failed, setFailed] = React.useState(false);
				// v1.14.0：正在回答的那条记录的 seq（那排按钮先禁用，防连点）与失败原因。
				const [answering, setAnswering] = React.useState(null);
				const [answerFailed, setAnswerFailed] = React.useState('');
				// v1.31.0：被庄家**明确拒收**的那张卡（seq）—— 只有它才给「关闭这张卡」的逃生口。
				// 网络失败（fetch 抛）不设它：卡还能再点一次，不该被误关。
				const [rejectedSeq, setRejectedSeq] = React.useState(null);
				const cursor = React.useRef(null);
				// v1.29.0：已确认读过 / 已成功回答的 seq —— advanceTo 只丢这些，
				// 不再把"seq 更旧的未答卡"一刀切吞掉（游标本身保持单调，旧卡靠这个集合过滤）。
				const doneSeqs = React.useRef(null);
				if (doneSeqs.current === null) doneSeqs.current = new Set();
				// v1.16.11（用户 2026-10-05：皮肤下半透明浮层压着对话、字看不清）：
				// 浮层**可拖动** —— 拖动只改 left/top 的偏移量，`transform: translate(-50%,-50%)` 不动，
				// 所以"居中"的几何不变、只是整体平移；初始偏移 0 时与以前逐像素一致。
				const [drag, setDrag] = React.useState({ dx: 0, dy: 0 });
				/** 一次拖动的起点（按下时的指针位置 + 当时的偏移）；null = 没在拖。 */
				const dragStart = React.useRef(null);
				if (cursor.current === null) {
					let saved = 0;
					try { saved = Number(globalThis.localStorage?.getItem(CURSOR_KEY) ?? 0) || 0; } catch { saved = 0; }
					cursor.current = saved;
				}
				React.useEffect(() => {
					const controller = new AbortController();
					let timer;
					const tick = async () => {
						try {
							const value = await fetchMailbox(cursor.current, controller.signal);
							if (controller.signal.aborted) return;
							setFailed(false);
							const incoming = Array.isArray(value?.records) ? value.records : [];
							if (incoming.length > 0) {
								setRecords((current) => {
									const seen = new Set(current.map((item) => item.seq));
									return [...current, ...incoming.filter((item) => !seen.has(item.seq))].sort((a, b) => a.seq - b.seq);
								});
							}
						} catch {
							if (!controller.signal.aborted) setFailed(true);
						} finally {
							if (!controller.signal.aborted) timer = setTimeout(tick, 2_000);
						}
					};
					void tick();
					return () => { controller.abort(); clearTimeout(timer); };
				}, []);
				/** 把游标推到 `seq`（= 这条已读）并丢掉更旧的；比它新的留着（可能是刚冒出来的下一个问题）。 */
				const advanceTo = (seq) => {
					if (typeof seq !== 'number') return;
					doneSeqs.current.add(seq);
					cursor.current = Math.max(cursor.current, seq);
					// 写不进去（无痕模式 / 存储被禁）不影响这一局：只是下次刷新会再弹一遍。
					try { globalThis.localStorage?.setItem(CURSOR_KEY, String(cursor.current)); } catch { /* 忽略 */ }
					// v1.29.0：只丢「已确认/已回答」的那一条 —— 旧实现 seq <= cursor 的一刀切会把
					// 更旧的未答卡（刚冒出来的上一题）一起静默吞掉。
					setRecords((current) => current.filter((item) => item.seq > cursor.current || !doneSeqs.current.has(item.seq)));
				};
				const acknowledge = () => {
					const top = records.length > 0 ? records[records.length - 1] : undefined;
					if (top !== undefined) advanceTo(top.seq);
					setRecords([]);
				};
				/**
				 * v1.14.0：点一个选项 —— 把它写好的 `text` 交给 `reply` 端点（与 `/ww-reply` 同路）。
				 * v1.15.0：`channel` 原样回传（投票卡 = `'room'` ⇒ 庄家把这条**公开**投进房间；
				 * 缺省 = 夜间私聊回答）。`undefined` 会被 JSON.stringify 丢掉，庄家按缺省处理。
				 */
				const answer = async (record, option) => {
					if (answering !== null) return;
					setAnswering(record.seq);
					setAnswerFailed('');
					setRejectedSeq(null);
					try {
						const response = await fetch(MAILBOX_PATH, {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							credentials: 'same-origin',
							signal: AbortSignal.timeout(15_000),
							body: JSON.stringify({ endpoint: 'reply', args: { gameId: record.gameId, to: record.to, text: String(option?.text ?? ''), channel: record.channel } })
						});
						if (!response.ok) throw new Error(`werewolf reply failed: HTTP ${response.status}`);
						const envelope = await response.json();
						if (envelope?.ok !== true) throw new Error(envelope?.error?.message ?? 'werewolf reply failed');
						const value = envelope.value ?? {};
						// 庄家说「没送到」（答非所问 / 找不到局 / 卡片已过期）⇒ 保留这张卡并说明；
						// v1.31.0：同时**记下是哪一张**被拒 —— 必答卡没有「知道了」，只有它才给关闭入口。
						// 成功则推进游标（这一张收起，下一张由轮询带来）。
						if (value.ok === false) {
							setAnswerFailed(String(value.text ?? '') || t('popupAnswerFailed'));
							setRejectedSeq(record.seq);
						} else advanceTo(record.seq);
					} catch {
						setAnswerFailed(t('popupAnswerFailed'));
					} finally {
						setAnswering(null);
					}
				};
				if (records.length === 0) return null;
				/**
				 * v1.31.0（2026-10-18 用户真机反馈）：**带 options 的卡 = 必答卡**，底部不再画「知道了」。
				 * 旧实现给每张卡都画它：点一下 = `acknowledge()` —— 游标推进 + 写 localStorage + 清空整叠卡
				 * ⇒ 这张卡**永久消失**（`inbox` 只回 `seq > since` 的记录）。确认阶段（READY）对真人只有这一张卡、
				 * host 侧又不限时、也不自动催 ⇒ 误点一次整局静默停住（用户实测，最后靠手打 `/ww-reply 是` 才继续）。
				 * 现在：通知卡（发牌/读数/回执）照旧只有「知道了」；必答卡只能作答，答完自动收起。
				 */
				const actionable = records.some((record) => Array.isArray(record.options) && record.options.length > 0);
				return h(
					'section',
					{
						'data-dsh-werewolf-popup': String(records[records.length - 1].seq),
						'aria-label': t('popupTitle'),
						style: {
							// v1.16.6：浮层从右下角挪到**屏幕正中**；v1.16.11：位置 += 可拖动偏移（拖开就看得清）。
							position: 'fixed',
							left: `calc(50% + ${drag.dx}px)`,
							top: `calc(50% + ${drag.dy}px)`,
							transform: 'translate(-50%, -50%)',
							zIndex: 60,
							width: 'min(420px, calc(100vw - 40px))',
							maxHeight: 'min(70vh, 560px)',
							overflowY: 'auto',
							border: '0.5px solid var(--dsw-alias-border-l1)',
							borderRadius: 14,
							// v1.16.11：用官方 **overlay/popover** 背景 token（与"弹出来问你"的那种框同浓度）。
							// 旧值 `--dsw-alias-bg-layer-1` 在用户皮肤下是半透明的 ⇒ 后面全是对话、字看不清。
							background: 'var(--dsw-alias-bg-overlay)',
							boxShadow: 'var(--dsw-elevation-panel)',
							padding: '13px 16px 11px',
							display: 'flex',
							flexDirection: 'column',
							gap: 8
						}
					},
					h(
						'header',
						{
							// v1.16.11：header 兼作拖动把手 —— 用 **pointer capture**（不用全局监听）：
							// 指针移出 header 也仍由它收 onPointerMove，松手前一直跟手。
							title: t('popupDrag'),
							onPointerDown: (event) => {
								dragStart.current = { x: event.clientX, y: event.clientY, dx: drag.dx, dy: drag.dy };
								event.currentTarget?.setPointerCapture?.(event.pointerId);
							},
							onPointerMove: (event) => {
								const start = dragStart.current;
								if (start === null) return;
								setDrag({ dx: start.dx + (event.clientX - start.x), dy: start.dy + (event.clientY - start.y) });
							},
							onPointerUp: (event) => {
								dragStart.current = null;
								event.currentTarget?.releasePointerCapture?.(event.pointerId);
							},
							// v1.29.0：取消/被系统夺走捕获也要收尾 —— 残留的 dragStart 会让"未按下时悬停
							// header"也持续拖动浮层（下次完整 down+up 才自愈）。
							onPointerCancel: () => { dragStart.current = null; },
							onLostPointerCapture: () => { dragStart.current = null; },
							style: {
								display: 'flex',
								alignItems: 'center',
								gap: 8,
								color: 'var(--dsw-alias-label-secondary)',
								fontSize: 12,
								cursor: 'grab',
								userSelect: 'none',
								touchAction: 'none'
							}
						},
						h('span', { 'aria-hidden': true }, '📨'),
						h('span', null, t('popupTitle')),
						failed ? h('span', { style: { marginLeft: 'auto' } }, t('popupFailed')) : null
					),
					...records.map((record) => h(MailBoundary, { key: record.seq, text: String(record.text ?? '') },
						h('div', { style: { ...PLAIN_STYLE, fontSize: 15 } }, String(record.text ?? '')),
						// v1.14.0：提问卡上的按钮（选项由庄家给：`{ label, text }`）。
						// 没有 options 的卡（发牌 / 读数 / 回执）与以前一模一样，只有文字。
						Array.isArray(record.options) && record.options.length > 0
							? h('div', {
								'data-dsh-werewolf-options': String(record.seq),
								style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 9 }
							}, record.options.map((option, index) => h('button', {
								key: `${record.seq}-${index}`,
								type: 'button',
								disabled: answering === record.seq,
								onClick: () => { void answer(record, option); },
								title: String(option?.text ?? ''),
								style: {
									flex: '0 0 auto',
									border: '1px solid var(--dsw-alias-state-business-primary)',
									borderRadius: 14,
									background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, var(--dsw-alias-bg-layer-1))',
									color: 'var(--dsw-alias-state-business-primary)',
									padding: '4px 11px',
									font: 'inherit',
									fontSize: 12,
									fontWeight: 600,
									cursor: answering === record.seq ? 'default' : 'pointer',
									opacity: answering === record.seq ? '.45' : '1'
								}
							}, String(option?.label ?? option?.text ?? ''))))
							: null)),
					answerFailed ? h('div', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } }, answerFailed) : null,
					h('div', { style: { borderTop: '0.5px solid var(--dsw-alias-border-l1)', paddingTop: 7, display: 'flex', alignItems: 'center', gap: 10 } },
						h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, actionable ? t('popupAnswerHint') : t('popupHint')),
						// v1.31.0 逃生口：只有庄家**明确拒收**这张卡之后才出现 —— 否则过期卡关不掉
						// （游标不推进 ⇒ 刷新页面它还会被 inbox 再吐出来，只能一直贴在屏幕上）。
						rejectedSeq === null ? null : h('button', {
							type: 'button',
							onClick: () => {
								const seq = rejectedSeq;
								setAnswerFailed('');
								setRejectedSeq(null);
								if (typeof seq === 'number') advanceTo(seq);
							},
							style: { marginLeft: 'auto', flex: '0 0 auto', border: '0.5px solid var(--dsw-alias-state-error-primary)', borderRadius: 9, background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', padding: '4px 10px', font: 'inherit', fontSize: 12, cursor: 'pointer' }
						}, t('popupDismiss')),
						// 必答卡没有「知道了」（v1.31.0）：唯一的出口是上面的选项按钮。
						actionable ? null : h('button', {
							type: 'button',
							onClick: acknowledge,
							style: { marginLeft: 'auto', flex: '0 0 auto', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 9, background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', padding: '4px 10px', font: 'inherit', fontSize: 12, cursor: 'pointer' }
						}, t('popupAck')))
				);
			}

			ctx.effect(
				() =>
					ctx.slots.inject('shell.overlay', () =>
						ctx.slots.register({ name: 'shell.overlay', id: `${NS}-mail`, label: () => t('popupTitle') }, DealerMailPopup)
					),
				`${NS}: mailbox popup`
			);
		}

		exports.apply = apply;
		exports.inject = ['slots', 'uiConversation', 'locale'];
      return module.exports;
    })();

    exports.apply = (ctx) => {
      // 顺序：先房间 UI，再庄家卡片/浮层（后者依赖房间视图已注册的槽位键）。
      chatHalf.apply(ctx);
      dealerHalf.apply(ctx);
    };
    exports.inject = [...new Set([...chatHalf.inject, ...dealerHalf.inject])];
    return module.exports;
  }
});
