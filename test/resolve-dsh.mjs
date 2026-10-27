/**
 * 测试引导：把裸包名解析到本机 DSH 安装目录。
 *
 * v2.0.0 起宿主半边 import 了 `@deepseek-ai/*`（chat/bridge 的既有写法），而本仓是
 * 零 node_modules 的链接安装包 —— 正式运行时由 DSH 的 linked 层按 `peerDependencies`
 * 路由（见 `关键机制.md` §1），测试期间用 Node 的 `registerHooks` 补同一条路由。
 *
 * 用法：`node --import ./test/resolve-dsh.mjs --test "test/*.test.mjs"`（见 package.json scripts）。
 * 安装根可用环境变量 `DSH_INSTALL` 覆盖；默认自动探测全局安装，再兜底 npx 缓存。
 */
import { createRequire, registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 安装根候选：全局安装优先（2026-10-27 起本机 DSH 装到 npm_global），npx 缓存作兜底。
 * 判据是「该目录的 node_modules 里真有 dsh-tools」——只认目录存在不够。
 */
const DSH_INSTALL = [
	process.env.DSH_INSTALL,
	'E:\\node_env\\npm_global\\node_modules\\@deepseek-ai\\dsh',
	'E:\\node_env\\npm_cache\\_npx\\a3a60f53b42a237b'
].filter(Boolean).find((dir) => existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')));

if (DSH_INSTALL === undefined) {
	throw new Error('resolve-dsh: 找不到 DSH 安装目录（可设 DSH_INSTALL 指到含 node_modules/@deepseek-ai/dsh-tools 的那一层）');
}

const requireFromDsh = createRequire(join(DSH_INSTALL, 'package.json'));

/** 哪些裸包名交给 DSH 安装目录解析（其余保持默认，避免影响本地相对导入）。 */
const routed = (specifier) => specifier.startsWith('@deepseek-ai/') || specifier === 'react';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (routed(specifier)) {
			try {
				return nextResolve(pathToFileURL(requireFromDsh.resolve(specifier)).href, context);
			} catch {
				// 解析不到就落回默认链路：让 Node 报它原本该报的错，别把引导层的问题伪装成插件问题。
			}
		}
		return nextResolve(specifier, context);
	}
});
