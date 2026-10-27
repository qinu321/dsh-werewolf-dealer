/**
 * 一次性构建工具：把 dsh-chat 的客户端半边与庄家的客户端半边合成一个模块。
 *
 * 为什么需要它：DSH 一个包只加载一个 client 模块（`dsh.client`），而 v2.0.0 把群聊并进来了，
 * 两边的 UI 必须住在同一个 `window.__ModuleLoader__.load` 里。两边各自有 `module/exports/React/h`
 * 与同名局部变量（`NS`、`t`、`dictionary`…），所以做法是**各自包一层 IIFE**，不共享词法作用域，
 * 再把两个 `apply` 串起来、`inject` 取并集。
 *
 * 用法（只在需要重新合并时跑一次；合并后 `client.js` 就是唯一真源）：
 *   node tools/merge-client.mjs <dsh-chat 的 client.js> <庄家的 client.js> <输出文件>
 *
 * 幂等保护：输入文件里若已出现 `const chatHalf =`，直接报错退出，避免把合并结果再合一遍。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [chatArg, dealerArg, outArg] = process.argv.slice(2);
if (!chatArg || !dealerArg || !outArg) {
	console.error('用法：node tools/merge-client.mjs <chat/client.js> <dealer/client.js> <输出文件>');
	process.exit(1);
}

const chatPath = resolve(chatArg);
const dealerPath = resolve(dealerArg);
const outPath = resolve(outArg);

const START = 'const h = React.createElement;';
const END = 'return module.exports;';

/** 剥掉外层 `window.__ModuleLoader__.load({...})` 包装，只留 factory 体内的实现。 */
function sliceBody(file, label) {
	const text = readFileSync(file, 'utf8');
	if (text.includes('const chatHalf =')) throw new Error(`${label} 已经是合并后的文件，拒绝二次合并：${file}`);
	const start = text.indexOf(START);
	const end = text.lastIndexOf(END);
	if (start < 0 || end < 0 || end <= start) throw new Error(`${label} 找不到包装锚点（${START} / ${END}）：${file}`);
	const body = text.slice(start + START.length, end).trimEnd();
	if (!body.includes('exports.apply = apply')) throw new Error(`${label} 的 factory 体里没有 exports.apply：${file}`);
	if (!body.includes('exports.inject =')) throw new Error(`${label} 的 factory 体里没有 exports.inject：${file}`);
	return body;
}

const chatBody = sliceBody(chatPath, 'dsh-chat');
const dealerBody = sliceBody(dealerPath, 'dsh-werewolf-dealer');

const header = `/**
 * dsh-werewolf-dealer —— 客户端半边（v2.0.0 起同时承载群聊房间 UI 与庄家卡片/弹窗）。
 *
 * 本文件由 \`tools/merge-client.mjs\` 生成：
 *   · chatHalf   ← dsh-chat 的 \`lib/client.js\`（快照提交 46118cb，来源见 lib/chat/VENDOR.md）
 *   · dealerHalf ← 本插件 v1.36.0 的 \`client.js\`（原文件在 git 历史里）
 * 合并后**本文件就是唯一真源**：改 UI 直接改这里，不要再跑合并脚本（脚本里有二次合并保护）。
 *
 * 两个半边各自一层 IIFE：它们都有各自的 \`module/exports/React/h\`、各自的 i18n 命名空间
 * （\`dsh-chat\` / \`dsh-werewolf-dealer\`）与各自的槽位 key，互不共享词法作用域。
 * 外层只做两件事：按顺序调两个 \`apply\`、把两个 \`inject\` 取并集。
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
${chatBody}
      return module.exports;
    })();

    // ── 庄家半边（私聊卡片、弹窗信箱）────────────────────────────────────────────────
    const dealerHalf = (() => {
      const module = { exports: {} };
      const exports = module.exports;
      const React = require("react");
      const h = React.createElement;
${dealerBody}
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
`;

writeFileSync(outPath, header, 'utf8');
console.log(`ok: ${outPath} (${header.split('\n').length} lines)`);
