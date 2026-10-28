# 来源快照（v2.0.0 合并）

本目录是 dsh-chat 的**逐字节快照**；并入 dsh-werewolf-dealer 后，**以此处为准维护**，
源仓 `E:\codeVibe\debug\plugins\dsh-chat` 冻结为历史归档。

- 源仓提交：`46118cb`（「补丁 34：删除 dsh-weave 与远程主机能力（只保留本机房间）」）
- 快照日期：2026-10-27
- 快照范围：`lib/index.js`、`lib/room-store.js`（`lib/client.js` 不在此处，前端并入根 `client.js`）
- 上游基线：dsh-chat `0.1.0-rc.36`，MIT，作者 Xiang Bai —— LICENSE 见 `vendor/dsh-chat.LICENSE`
- 本地补丁编号（local.1–34）随源码保留；`LOCAL-FORK.md` 仍在源仓，不在本目录复制
- 合并后新增的补丁从 **35** 起（`补丁 35`，2026-10-29：deleteRoom 连房间会话一起删）。
  这些补丁只在本仓维护，不回写源仓；`room-store.js` / `index.js` 顶部的补丁索引里有逐条说明。

## 不可动的契约（改一个就断历史）

- `/api/dsh-chat` 路由与端点名（`listRooms` / `messages` / `history` / `send` / `mergeRooms` /
  `roomPages` / `roomPage` / `removeMessage` / `composerRule` / `composerAction` / `createColdRoom` /
  `deleteRoom` / `avatars`）
- 房间会话前缀 `dsh-chat-room-v3-`
- 广播 source kind `plugin:dsh-chat` 与节点 key `dsh-chat-room` / `dsh-chat-broadcast`
- 数据目录 `$DSH_HOME/dsh-chat`（`rooms.json` / `Chatrooms` / 归档 / `avatars.json`）
- 工具名 `chat_create` / `chat_join` / `chat_invite` / `chat_send`
