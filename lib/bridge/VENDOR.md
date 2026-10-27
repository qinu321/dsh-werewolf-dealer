# 来源快照（v2.0.0 合并）

本目录是 dsh-bridge 的**逐字节快照**；并入 dsh-werewolf-dealer 后，**以此处为准维护**，
源仓 `E:\codeVibe\debug\plugins\dsh-bridge` 冻结为历史归档。

- 源仓提交：`f08df40`（「维护：仓库化收尾 —— LOCAL-FORK.md、.gitignore、回归套件收进 test/」）
  - 源仓工作树另有一处 `LOCAL-FORK.md` 文档改动未提交，不涉及代码，未纳入本快照
- 快照日期：2026-10-27
- 快照范围：`lib/index.js`（唯一源码文件）
- 上游基线：dsh-bridge `0.1.0-rc.17`，MIT，作者 Xiang Bai —— LICENSE 见 `vendor/dsh-bridge.LICENSE`

## 不可动的契约（改一个就断历史）

- 服务名 `dshBridge`（旧访问器 `sessionMessaging` 一并保留）
- 工具名 `session_list` / `session_send` / `session_messages`
- 投递幂等键 `transport:from:to:id`
- `sourceKind` 透传（庄家卡片按 `plugin:dsh-werewolf-dealer` 认领；房间侧按 `plugin:dsh-chat`）
- 唤醒通道判定（`wake:true` 走 inject、`wake:false` 落表面 `surfaceOp:append`）
