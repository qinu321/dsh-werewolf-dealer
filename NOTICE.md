# NOTICE —— 第三方代码归属

本包（`dsh-werewolf-dealer` v2.0.0）内含两段以 MIT 许可发布的第三方代码的**本地魔改版**。
原始版权归各自作者所有；完整许可原文见 `vendor/` 下的对应文件。

| 目录 | 来源 | 作者 / 许可 | 基线版本 | 本地快照 |
|---|---|---|---|---|
| `lib/chat/`（宿主半边）与 `client.js` 的群聊半边 | https://github.com/baixianger/dsh-chat | Xiang Bai / MIT（`vendor/dsh-chat.LICENSE`） | 0.1.0-rc.36 | 本地 fork 提交 `46118cb`（含 local.1–34 补丁） |
| `lib/bridge/` | https://github.com/baixianger/dsh-bridge | Xiang Bai / MIT（`vendor/dsh-bridge.LICENSE`） | 0.1.0-rc.17 | 本地 fork 提交 `f08df40`（含本地补丁） |

改动说明：两份源码并入本包时只做了**接线层改动**——`apply()` 末尾各增加一个返回值，
由本插件的 `index.js` 在自己的 ctx 上调用它们（服务名保持 `dshChat` / `dshBridge`，行为不变）。
`client.js` 由 `tools/merge-client.mjs` 把两边的浏览器半边包进同一个模块（各自独立作用域）。

上游这两个项目已停止更新；本包的这两份是快照，**以本包内的版本为准**。
