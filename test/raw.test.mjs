/**
 * 复盘 raw 渲染（`renderRaw`）的单元测试 —— v1.8.0 起是 Chatbox 风格的复盘稿。
 *
 * 钉住的都是用户 2026-10-04 明确要求的点：
 *  - 开头必须是 `> [!chatbox|<样式>-long[-swap]]+ 第N局`，样式来自 `chatstyle` 配置；
 *  - 时间**本地时间**格式（旧实现用 `toISOString()`，比本地早 8 小时被用户抓到）；
 *  - 发言正文**只出现一次**（旧实现把 `text` 与 `prefix.body` 都倒进 JSON ⇒ 正文两遍）；
 *  - `\n\n` 变成**真换行**（同一气泡的续行）；
 *  - AI = `-`、真人 = `+`；头像取 `avatars.json` 同名键（真人是 `你`）；
 *  - 轮次旁白 `> \n> <时间> round N`；方向切换时补 `> \n> <span></span>`；
 *  - 「夜间（…）」与「全量事件」两块机器数据不再出现。
 *
 * @module dsh-werewolf-dealer/test/raw.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Game, ROLES } from '../lib/engine.js';
import { localTime, nextGameNo, rawExportPath, readAvatars, renderRaw, writeRawExport } from '../lib/store.js';
import { removeDir } from './helpers.mjs';

/** 固定时间戳（UTC）——渲染出来必须是**本地时区**的字符串。 */
const AT = Date.UTC(2026, 9, 4, 4, 21, 28);

/** 造一局"已经打完、日志与结算都摆好"的游戏（只喂 rawExport 读的字段）。 */
function makeGame(players, entries) {
	const game = new Game({ roomId: 'room-1', roomName: '测试房', mode: 3, players, seed: 42, gameId: 'room-1-第1局', no: 1, now: () => AT });
	const roles = [ROLES.WOLF, ROLES.VILLAGER, ROLES.SEER];
	game.dealt = new Map(players.map((player, index) => [player.sessionId, roles[index]]));
	game.hand = new Map(game.dealt);
	game.pile = [ROLES.TRICKSTER, ROLES.WOLF];
	game.recapWriter = players[0].name;
	game.log.push(...entries);
	game.settlement = {
		verdict: 'human-single-wolf',
		winner: 'human',
		sentence: '最高票者现值为狼 —— 人类阵营获胜！',
		leaders: [players[0].name],
		max: 2,
		counts: {},
		ballot: [],
		abstain: [],
		eliminated: [1],
		seats: players.map((player, index) => ({ seat: index + 1, name: player.name, dealt: game.dealt.get(player.sessionId), current: game.hand.get(player.sessionId), camp: 'human' })),
		pile: [...game.pile],
		wolvesPresent: true,
		formal: true
	};
	return game;
}

/** 一条被接受的发言日志（`prefix.body` 与 `text` 都在，模拟真实记录）。 */
function speech({ at, seat, name, body }) {
	return { at, type: 'speech', seat, name, text: `【R1-1 · ${name}】\n${body}`, round: 1, position: 0, prefix: { round: 1, index: 1, alias: name, body }, decision: 'accepted' };
}

test('复盘 raw：头部元信息保持原 bullet 形态，只有发言链一段是 chatbox', () => {
	const players = [{ name: '甲', sessionId: 's0' }, { name: '乙', sessionId: 's1', human: true }, { name: '丙', sessionId: 's2' }];
	const game = makeGame(players, [
		{ at: AT, type: 'day-open', round: 1 },
		speech({ at: AT + 1000, seat: 1, name: '甲', body: '正文' })
	]);
	const raw = renderRaw(game, {});
	const lines = raw.split('\n');
	// 头部：标题 + bullet 元信息（用户 2026-10-04 澄清"这些数据保持原样"）
	assert.equal(lines[0], '# 第1局 庄家原始记录（3人局）');
	assert.match(raw, /^- 局标识：`room-1-第1局`$/m);
	assert.match(raw, /^- 房间：测试房（`room-1`）$/m);
	assert.match(raw, /^- 随机种子：`42`（同种子可复现同一牌序）$/m);
	assert.equal(raw.includes(`- 开始时间：${localTime(AT)}`), true, '开始时间用本地时间格式');
	assert.match(raw, /^- 导出时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/m);
	assert.match(raw, /^- 复盘写手：甲（结算后按胜负判定）$/m);
	assert.equal(/T\d{2}:\d{2}:\d{2}\.\d+Z/u.test(raw), false, '不得出现 UTC 的 ISO 时间');
	// 只有「## 白天发言链判定」这一段是 Chatbox；元信息**不在** callout 里
	assert.match(raw, /^## 白天发言链判定$/m);
	assert.match(raw, /^> \[!chatbox\|qqchat-long-swap\]\+ 第1局$/m, '第一句是 AI ⇒ 带 -swap');
	assert.equal(raw.split('\n> 局标识').length - 1, 0, '元信息不得被塞进 callout');
	assert.equal(raw.includes('## 夜间'), false);
	assert.equal(raw.includes('## 全量事件'), false);
	assert.equal(raw.includes('"type":"speech"'), false, '不得把审计 JSON 倒进来');
	assert.match(raw, /## 牌面/);
	assert.match(raw, /## 票型与结算/);
	// chatstyle 可换（默认 qqchat）
	assert.match(renderRaw(game, { chatstyle: 'wechat' }), /^> \[!chatbox\|wechat-long-swap\]\+ 第1局$/m);
});

test('复盘 raw：第一句是真人时**不加** swap', () => {
	const players = [{ name: '甲', sessionId: 's0', human: true }, { name: '乙', sessionId: 's1' }, { name: '丙', sessionId: 's2' }];
	const game = makeGame(players, [
		{ at: AT, type: 'day-open', round: 1 },
		speech({ at: AT + 1000, seat: 1, name: '甲', body: '正文' })
	]);
	assert.match(renderRaw(game, {}), /^> \[!chatbox\|qqchat-long\]\+ 第1局$/m);
});

test('复盘 raw：正文只出现一次，且 \\n\\n 变成真换行（同一气泡的续行）', () => {
	const players = [{ name: '甲', sessionId: 's0' }, { name: '乙', sessionId: 's1', human: true }, { name: '丙', sessionId: 's2' }];
	const body = '第一段\n\n第二段';
	const game = makeGame(players, [
		{ at: AT, type: 'day-open', round: 1 },
		speech({ at: AT + 1000, seat: 1, name: '甲', body }),
		speech({ at: AT + 2000, seat: 2, name: '乙', body: '真人的一段话' })
	]);
	const raw = renderRaw(game, {});
	assert.equal(raw.split('第一段').length - 1, 1, '正文不得被统计两遍');
	assert.equal(raw.split('第二段').length - 1, 1);
	// 第一段在气泡行上，第二段是同一气泡的续行（`> ` 开头、不带 sign）
	assert.match(raw, /^> - `甲` 第一段$/m);
	assert.match(raw, /^> 第二段$/m);
	// 真人 = `+`
	assert.match(raw, /^> \+ `乙` 真人的一段话$/m);
});

test('复盘 raw：转义会顶出/翻边的记号，保留 `- ` 与斜体粗体样式', () => {
	const players = [{ name: '甲', sessionId: 's0' }, { name: '乙', sessionId: 's1', human: true }, { name: '丙', sessionId: 's2' }];
	// 用户 2026-10-04 在预览里抓到的真实形态：正文里的 `1. ` 被 Obsidian 当有序列表 ⇒ 气泡断掉
	const body = ['1. 第一条', '2. 第二条', '- 破折项', '* 星号项', '+ 加号项', '# 像是标题', '> 像是引用', '*斜体*', '**粗体**', '正常一行'].join('\n');
	const game = makeGame(players, [
		{ at: AT, type: 'day-open', round: 1 },
		speech({ at: AT + 1000, seat: 1, name: '甲', body: '第一段\n' + body })
	]);
	const raw = renderRaw(game, {});
	// 必须转义：有序列表（会整段被吞成列表块）、标题、嵌套引用、
	// `+ `／`* `（Chatbox 的方向标记，裸形会翻出无名气泡）
	assert.match(raw, /^> 1\\\. 第一条$/m);
	assert.match(raw, /^> 2\\\. 第二条$/m);
	assert.match(raw, /^> \\# 像是标题$/m);
	assert.match(raw, /^> \\> 像是引用$/m);
	assert.match(raw, /^> \\\+ 加号项$/m, '`+ ` 是方向标记 ⇒ 必须转义');
	assert.match(raw, /^> \\\* 星号项$/m, '`* ` 是方向标记 ⇒ 必须转义（后面跟空格才算）');
	// **不能碰**：`*`/`**` 后面不跟空白时是斜体/粗体样式，属于正文，要原样
	assert.match(raw, /^> \*斜体\*$/m, '斜体必须原样保留');
	assert.match(raw, /^> \*\*粗体\*\*$/m, '粗体必须原样保留');
	// **故意不转义**：`- ` 在 Chatbox 里会渲染成独立气泡，起分段作用
	//（转义成 `\-` 反而只在气泡里戳一个孤零零的减号）
	assert.match(raw, /^> - 破折项$/m, '破折项保持原样 ⇒ 渲染成独立气泡');
	assert.equal(raw.includes('\\- 破折项'), false);
	// 反面：这些"裸"开头不得出现在续行里（否则会被解析成列表/标题/引用，或被当方向标记翻边）
	for (const bad of ['\n> 1. 第一条', '\n> 2. 第二条', '\n> # 像是标题', '\n> > 像是引用', '\n> + 加号项', '\n> * 星号项']) {
		assert.equal(raw.includes(bad), false, `不该出现：${JSON.stringify(bad)}`);
	}
});

test('复盘 raw：轮次旁白 + 方向切换补 <span></span>', () => {
	const players = [{ name: '甲', sessionId: 's0' }, { name: '乙', sessionId: 's1', human: true }, { name: '丙', sessionId: 's2' }];
	// round1 只有 AI（-），round2 只有真人（+）⇒ 方向切换 ⇒ 补隐形行
	const flip = makeGame(players, [
		{ at: AT, type: 'day-open', round: 1 },
		speech({ at: AT + 1000, seat: 1, name: '甲', body: 'A' }),
		{ at: AT + 2000, type: 'round-advanced', round: 2 },
		{ ...speech({ at: AT + 3000, seat: 2, name: '乙', body: 'B' }), round: 2 }
	]);
	const flipRaw = renderRaw(flip, {});
	assert.match(flipRaw, /^> $/m, '旁白前必须空一行（Chatbox 的旁白规则）');
	assert.match(flipRaw, new RegExp(`^> ${localTime(AT)} round 1$`, 'm'));
	assert.match(flipRaw, new RegExp(`^> ${localTime(AT + 2000)} round 2$`, 'm'));
	assert.equal(flipRaw.includes('> <span></span>'), true, '方向切换要补隐形行');

	// 同向（round2 也是 AI）⇒ 不补
	const same = makeGame(players, [
		{ at: AT, type: 'day-open', round: 1 },
		speech({ at: AT + 1000, seat: 1, name: '甲', body: 'A' }),
		{ at: AT + 2000, type: 'round-advanced', round: 2 },
		{ ...speech({ at: AT + 3000, seat: 3, name: '丙', body: 'C' }), round: 2 }
	]);
	assert.equal(renderRaw(same, {}).includes('> <span></span>'), false, '同向不补隐形行');
});

test('复盘 raw：头像取同名键（真人取「你」），读不到就退回不带头像', () => {
	const dir = mkdtempSync(join(tmpdir(), 'werewolf-avatars-'));
	const file = join(dir, 'avatars.json');
	writeFileSync(file, JSON.stringify({ _help: '忽略我', 甲: 'http://x/a.png', 你: 'http://x/you.png' }), 'utf8');
	assert.deepEqual(readAvatars(file), { 甲: 'http://x/a.png', 你: 'http://x/you.png' }, '_ 开头的说明键要被剔除');
	assert.deepEqual(readAvatars(join(dir, 'nope.json')), {}, '读不到就是空表，不得抛');
	const players = [{ name: '甲', sessionId: 's0' }, { name: '乙', sessionId: 's1', human: true }, { name: '丙', sessionId: 's2' }];
	const game = makeGame(players, [
		{ at: AT, type: 'day-open', round: 1 },
		speech({ at: AT + 1000, seat: 1, name: '甲', body: 'A' }),
		speech({ at: AT + 2000, seat: 2, name: '乙', body: 'B' })
	]);
	const withFace = renderRaw(game, { avatarFile: file });
	assert.match(withFace, /^> - !\[face\]\(http:\/\/x\/a\.png\) `甲` A$/m);
	assert.match(withFace, /^> \+ !\[face\]\(http:\/\/x\/you\.png\) `乙` B$/m);
	const noFace = renderRaw(game, { avatarFile: join(dir, 'nope.json') });
	assert.equal(noFace.includes('![face]'), false, '没有头像就不写 ![face]');
	assert.match(noFace, /^> - `甲` A$/m);
});

test('复盘 raw：完赛感想一节 —— 方向 / -swap 判据 / 顺序 / 头像 / 转义（v1.16.0）', () => {
	const dir = mkdtempSync(join(tmpdir(), 'werewolf-closing-'));
	const file = join(dir, 'avatars.json');
	writeFileSync(file, JSON.stringify({ 你: 'http://x/you.png', 甲: 'http://x/a.png' }), 'utf8');
	const players = [{ name: '甲', sessionId: 's0' }, { name: '乙', sessionId: 's1', human: true }, { name: '丙', sessionId: 's2' }];
	const game = makeGame(players, [
		{ at: AT, type: 'day-open', round: 1 },
		speech({ at: AT + 1000, seat: 1, name: '甲', body: '正文' })
	]);

	// 故意乱序喂进去（AI 先到）——渲染必须按「真人优先、其余按座位」排，不看到达顺序
	game.closing = [
		{ seat: 3, name: '丙', sessionId: 's2', human: false, text: '我是丙的感想\n1. 补充一点', at: AT + 4000 },
		{ seat: 2, name: '乙', sessionId: 's1', human: true, text: '我是真人的感想', at: AT + 3000 },
		{ seat: 1, name: '甲', sessionId: 's0', human: false, text: '我是甲的感想', at: AT + 2000 }
	];
	const raw = renderRaw(game, { avatarFile: file });
	assert.match(raw, /^## 完赛感想$/m, '末节标题');
	assert.match(raw, /^> \[!chatbox\|qqchat-long-swap\]\+ 感想$/m, '★ 有真人 ⇒ 加 -swap（与白天那节判据相反）');
	const section = raw.split('## 完赛感想')[1];
	const rows = section.split('\n').filter((line) => /^> [+-] /.test(line));
	assert.equal(rows.length, 3, '三条感想行');
	assert.match(rows[0], /^> \+ !\[face\]\(http:\/\/x\/you\.png\) `乙` 我是真人的感想$/, '★ 真人排第一、用 `+`、头像取「你」');
	assert.match(rows[1], /^> - !\[face\]\(http:\/\/x\/a\.png\) `甲` 我是甲的感想$/, 'AI 用 `-`、头像取同名键');
	assert.match(rows[2], /^> - `丙` 我是丙的感想$/, '没有头像就不写 ![face]');
	assert.match(section, /^> 1\\\. 补充一点$/m, '★ 续行同样转义块级记号（`1. ` 会把气泡顶断）');
	assert.equal(raw.indexOf('## 完赛感想') > raw.indexOf('## 票型与结算'), true, '感想节在最后');

	// v1.16.4：**观察员的点评**（AI 局里那条的作者不是任何座位）—— `seat: null`、`name: null`、`human: true`。
	// 渲染：算真人（`+`、头像取「你」、排玩家之后 AI 之前），名字用**配置里的玩家名**兜底。
	game.closing = [
		{ seat: 1, name: '甲', sessionId: 's0', human: false, text: '我是甲的感想', at: AT + 2000 },
		{ seat: null, name: null, sessionId: 'room-side', human: true, observer: true, text: '我是观察员的点评', at: AT + 3000 }
	];
	const observed = renderRaw(game, { avatarFile: file, humanName: '千野' });
	assert.match(observed, /^> \[!chatbox\|qqchat-long-swap\]\+ 感想$/m, '有真人（观察员）⇒ 带 -swap');
	const observedRows = observed.split('## 完赛感想')[1].split('\n').filter((line) => /^> [+-] /.test(line));
	assert.equal(observedRows.length, 2, '恰好两行');
	assert.match(observedRows[0], /^> \+ !\[face\]\(http:\/\/x\/you\.png\) `千野` 我是观察员的点评$/, '★ 观察员排第一、名字用配置兜底、头像取「你」');
	assert.match(observedRows[1], /^> - !\[face\]\(http:\/\/x\/a\.png\) `甲` 我是甲的感想$/, 'AI 照旧用 `-` 与同名键头像');
	assert.match(renderRaw(game, {}), /^> \+ `观察员` 我是观察员的点评$/m, '没配 humanName ⇒ 兜底写「观察员」');

	// 没有真人 ⇒ 不加 -swap
	game.closing = [{ seat: 1, name: '甲', sessionId: 's0', human: false, text: '我是甲的感想', at: AT }];
	assert.match(renderRaw(game, {}), /^> \[!chatbox\|qqchat-long\]\+ 感想$/m);
	// 没有感想 ⇒ 整节不出现（结算那一刻就是这种状态）
	game.closing = [];
	assert.equal(renderRaw(game, {}).includes('## 完赛感想'), false);
	removeDir(dir);
});

test('复盘 raw：导出路径按日期分目录（YYYY/MM/YYYYMMDDHHMM_第X局.md），局号扫描要递归', () => {
	const base = mkdtempSync(join(tmpdir(), 'werewolf-raw-path-'));
	const exportDir = join(base, '狼人杀复盘', '_raw'); // 真实结构：父目录里还有人手写的复盘文件
	mkdirSync(exportDir, { recursive: true });
	// 路径形态：本地日期建两层子目录 + 本地时间戳文件名（用固定时间戳断言，不受跑测试的时刻影响）
	const at = new Date(2026, 9, 4, 20, 13, 5); // 2026-10-04 20:13:05 本地时间
	assert.equal(rawExportPath(exportDir, 7, at), join(exportDir, '2026', '10', '202610042013_第7局.md'));
	assert.match(rawExportPath(exportDir, 12, new Date(2026, 0, 9, 8, 5)), /[\\/]2026[\\/]01[\\/]202601090805_第12局\.md$/u);

	// ① 落到子目录里的导出文件必须被算进局号（只看顶层的话，下一局会从第1局重来、覆盖同号）
	mkdirSync(join(exportDir, '2026', '10'), { recursive: true });
	writeFileSync(join(exportDir, '2026', '10', '202610042013_第7局.md'), 'x', 'utf8');
	assert.equal(nextGameNo(exportDir), 8, '子目录里的第7局必须被算进去');
	// ② 父目录里人手写的 `第N局-<局型>-<日期>.md` 也要错开
	writeFileSync(join(base, '狼人杀复盘', '第9局-4人局-2026-10-04.md'), 'x', 'utf8');
	assert.equal(nextGameNo(exportDir), 10, '父目录的手写复盘也要算进去');
	removeDir(base);
});

test('复盘 raw：文件名时间戳取**开局时刻**（v1.16.7）—— 与导出时刻无关，同局重导幂等', () => {
	const base = mkdtempSync(join(tmpdir(), 'werewolf-raw-stamp-'));
	const exportDir = join(base, '_raw');
	const startedAt = new Date(2026, 9, 5, 7, 24, 30).getTime(); // 2026-10-05 07:24:30 本地时间
	// 预置：**只有**按「开局时间」算出来的那个路径存在（实现若用 Date.now()，就命不中它）。
	const expected = rawExportPath(exportDir, 8, startedAt);
	mkdirSync(dirname(expected), { recursive: true });
	writeFileSync(expected, 'x', 'utf8');
	// 令渲染必炸 ⇒ 命中预置文件就必须在 `renderRaw` 之前抛 already exists（幂等）。
	// 判据强度：旧实现（`rawExportPath(dir, no)` 缺省 Date.now()）会算出**另一个**路径、不命中，
	// 于是走到渲染 ⇒ 本用例红。2026-10-05 第 8 局实测就是这么多了三份（0726/0727/0730）。
	const game = { no: 8, startedAt, rawExport: () => { throw new Error('不该走到渲染'); } };
	assert.throws(() => writeRawExport(game, { exportDir }), /already exists/u, '★ 路径必须由定死的开局时间决定');
	removeDir(base);
});
