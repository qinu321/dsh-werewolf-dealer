/**
 * 私有存储层（需求说明 §8）。
 *
 * - 状态与审计落**工作区之外**的私有目录（默认 `%APPDATA%\dsh-werewolf`）。
 * - 持牌期零落盘到任何记忆文件（`.dsh-memory` / `MEMORY.md` / `AGENTS.md`），本模块不引用它们。
 * - 审计日志为 JSONL，一行一条；`secret:true` 的记录含牌面，回放时会被剔除。
 *
 * @module dsh-werewolf-dealer/store
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { T } from './templates.js';

/**
 * 默认私有状态目录（工作区之外）。
 * Windows 用 `%APPDATA%`，其余平台回落 `~/.dsh-werewolf`。
 * @returns 绝对路径。
 */
export function defaultStateDir() {
	const appData = process.env.APPDATA;
	if (appData !== undefined && appData.trim() !== '') return join(appData, 'dsh-werewolf');
	return join(homedir(), '.dsh-werewolf');
}

/**
 * v1.27.0（用户 2026-10-07 选 B）：**作废局的归档子目录**。
 *
 * 提前终止的局不写复盘 raw ⇒ 它在复盘目录里不占号，但局号是**开局**就算好并写进 gameId（= 三件套文件名）的
 * ⇒ 号若不释放，同一个房间的下一局会拿到**同一个号**、撞上这份记录（覆盖状态 + 审计追加混在一起）。
 * 处置：作废局结束即把三件套挪进 `<stateDir>/voided/` —— 记录留着可查，号空出来给下一局复用。
 */
export const VOIDED_DIR = 'voided';

/** 私有存储。 */
export class PrivateStore {
	/**
	 * @param options - `{ stateDir }`。
	 */
	constructor(options = {}) {
		this.stateDir = resolve(options.stateDir ?? defaultStateDir());
		mkdirSync(this.stateDir, { recursive: true });
		/**
		 * v1.27.0：**本进程内已归档**的局（`gameId → 归档基线名`，决定三件套写哪儿、叫什么）。
		 *
		 * ⚠ 刻意用显式 Map 而不是"看 `voided/` 里有没有同名文件"：作废局的**号会被下一局复用**，
		 * 同一个 gameId 会先后属于两局 ⇒ 只能按"当前持有者"记，嗅探文件名会把新局也写进归档目录。
		 */
		this.archived = new Map();
	}

	/** 三件套的落盘位置：已归档的作废局 ⇒ `voided/` 下的归档名，其余 ⇒ 顶层原名。 */
	#paths(gameId) {
		const base = this.archived.get(gameId);
		if (base === undefined) return { dir: this.stateDir, base: gameId };
		return { dir: join(this.stateDir, VOIDED_DIR), base };
	}

	/** 状态文件路径。 */
	statePath(gameId) {
		const slot = this.#paths(gameId);
		return join(slot.dir, `${slot.base}.json`);
	}

	/** 审计文件路径。 */
	auditPath(gameId) {
		const slot = this.#paths(gameId);
		return join(slot.dir, `${slot.base}.audit.jsonl`);
	}

	/** v1.11.0：弹窗信箱文件路径（真人席位的私密内容不落任何会话，只走这里 + 浏览器浮层）。 */
	mailPath(gameId) {
		const slot = this.#paths(gameId);
		return join(slot.dir, `${slot.base}.mail.jsonl`);
	}

	/**
	 * v1.27.0（用户 2026-10-07 选 B）：**作废局不占局号** —— 三件套挪进 `<stateDir>/voided/`。
	 *
	 * 不挪走的话：作废局不写 raw ⇒ 复盘目录里的最大号没变 ⇒ **同一个房间的下一局会拿到同一个局号**，
	 * 而 gameId = `<房间id>-第N局` 正是三件套的文件名 ⇒ 新局会覆盖旧状态、并把审计追加进同一个文件。
	 *
	 * ⚠ **归档名 = `<开局时间戳>-<原 gameId>`**：号被复用 ⇒ 同一个房间"开局→作废"两轮就会同名，
	 * 直接叫 `<gameId>.json` 的话第二次归档会把第一份**覆盖**掉。同名（同一分钟同号）再加 `.2`、`.3`。
	 * @param gameId - 局 id。
	 * @param startedAt - 开局时刻（毫秒），给归档名去重（缺省用当前时刻）。
	 * @returns 本次归档基线名（重复调用返回上次那个）。
	 */
	archiveVoided(gameId, startedAt = Date.now()) {
		const done = this.archived.get(gameId);
		if (done !== undefined) return done;
		const dir = join(this.stateDir, VOIDED_DIR);
		const stamp = localTime(startedAt).replace(/[-: ]/gu, '').slice(0, 12);
		const suffixes = ['.json', '.audit.jsonl', '.mail.jsonl'];
		// v1.29.0：基名选择要**可恢复** —— 上次归档挪到一半失败（Windows 文件锁 EPERM 之类）时，
		// 重试必须续用同一个基名把剩余件挪完，而不是另起 `.2` 把三件套劈成两个基名
		// （劈开 ⇒ 状态与审计分家；号复用后新局还会往顶层残件上追加审计，两局混线）。
		// 判据：基名下已有件、且这些件对应的顶层文件都已不在 ⇒ 那是上次归档的残局，续用；
		// 顶层对应文件还在 ⇒ 真冲突（同一分钟同号的新归档，v1.27.0 的原始场景）⇒ 让位 `.2`。
		let base = `${stamp}-${gameId}`;
		for (let n = 2; ; n += 1) {
			const present = suffixes.filter((suffix) => existsSync(join(dir, `${base}${suffix}`)));
			if (present.length === 0) break;
			const resumable = present.every((suffix) => !existsSync(join(this.stateDir, `${gameId}${suffix}`)));
			if (resumable) break;
			base = `${stamp}-${gameId}.${n}`;
		}
		for (const suffix of suffixes) {
			const from = join(this.stateDir, `${gameId}${suffix}`);
			if (!existsSync(from)) continue;
			mkdirSync(dir, { recursive: true });
			renameSync(from, join(dir, `${base}${suffix}`));
		}
		this.archived.set(gameId, base);
		return base;
	}

	/**
	 * v1.27.0：新局**接手**一个可复用的局号 ⇒ 停止把该 id 的写入路由到归档。
	 * （号是复用的，同一个 gameId 此刻已属于新局；归档里那份留在 `voided/` 不动。）
	 */
	claimGameId(gameId) {
		this.archived.delete(gameId);
	}

	/** 追加一条弹窗消息（append-only ⇒ 进程崩了也不丢已发出的私密内容）。 */
	appendMail(gameId, record) {
		appendFileSync(this.mailPath(gameId), `${JSON.stringify(record)}\n`, 'utf8');
	}

	/** 读取弹窗消息：`seq > since` 的那些，按 seq 升序（坏行直接跳过，不拖垮整个信箱）。 */
	readMail(gameId, since = 0) {
		return this.#readMailFile(this.mailPath(gameId), since);
	}

	/** 从一个具体的信箱文件读（`maxMailSeq` 要跨目录读，不能走 `mailPath` 的目录选择）。 */
	#readMailFile(path, since = 0) {
		if (!existsSync(path)) return [];
		const floor = Number.isFinite(since) ? since : 0;
		const out = [];
		for (const line of readFileSync(path, 'utf8').split('\n')) {
			if (line.trim() === '') continue;
			try {
				const record = JSON.parse(line);
				if (typeof record?.seq === 'number' && record.seq > floor) out.push(record);
			} catch {
				// 半截行（写入过程中被强杀）跳过即可。
			}
		}
		return out.sort((a, b) => a.seq - b.seq);
	}

	/**
	 * 所有局里出现过的最大弹窗序号 —— 进程重启后用它把**全局单调序号**接上。
	 * 不接的话新消息的 seq 会从 1 重来，而客户端记着旧游标 ⇒ 新消息永远拉不到。
	 *
	 * ⚠ v1.27.0：**必须连 `voided/` 一起扫** —— 作废局的信箱挪进去之后，若它的 seq 最高而这里看不见，
	 * 重启后序号会往回退，客户端那个更大的游标就再也拉不到新卡片了。
	 */
	maxMailSeq() {
		let max = 0;
		for (const dir of [this.stateDir, join(this.stateDir, VOIDED_DIR)]) {
			let names;
			try {
				names = readdirSync(dir);
			} catch {
				continue; // 归档目录还不存在是正常的
			}
			for (const name of names) {
				if (!name.endsWith('.mail.jsonl')) continue;
				try {
					const last = this.#readMailFile(join(dir, name), 0).at(-1);
					if (typeof last?.seq === 'number' && last.seq > max) max = last.seq;
				} catch {
					// 读不到就跳过：宁可序号从头开始，也不要因为一个坏文件起不来。
				}
			}
		}
		return max;
	}

	/** 原子写状态（临时文件 + rename），失败不破坏旧状态。 */
	saveState(game) {
		const target = this.statePath(game.gameId);
		const tmp = `${target}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(game.toJSON(), null, '\t')}\n`, 'utf8');
		renameSync(tmp, target);
		return target;
	}

	/** 追加审计记录。 */
	appendAudit(gameId, record) {
		appendFileSync(this.auditPath(gameId), `${JSON.stringify(record)}\n`, 'utf8');
	}

	/** 读取审计记录。 */
	readAudit(gameId) {
		const path = this.auditPath(gameId);
		if (!existsSync(path)) return [];
		return readFileSync(path, 'utf8')
			.split('\n')
			.filter((line) => line.trim() !== '')
			.map((line) => {
				try { return JSON.parse(line); } catch { return { type: 'unparsable', raw: line }; }
			});
	}

	/** 列出未结束的对局状态。 */
	listResumable() {
		const out = [];
		for (const name of readdirSync(this.stateDir)) {
			if (!name.endsWith('.json')) continue;
			const path = join(this.stateDir, name);
			try {
				const data = JSON.parse(readFileSync(path, 'utf8'));
				if (data?.phase === 'settled' || data?.phase === 'ended') continue;
				if (typeof data?.gameId !== 'string' || !Array.isArray(data?.players)) continue;
				out.push(data);
			} catch {
				// 坏文件不参与续局，保留在盘上供人工查看。
			}
		}
		return out;
	}

	/**
	 * v1.29.0：**顶层残留的作废局**（启动补归档用）。
	 * 作废局本该在结束时归档进 `voided/`，但归档挪一半失败、或老版本遗留的残件此后没有任何
	 * 代码路径会处理它们：`listResumable()` 跳过 ended，同号复用的下一局还会往顶层残件上
	 * 追加审计（两局混线）。启动时先扫出来，交给调用方逐个 `archiveVoided()` 补齐。
	 * @returns `[{ gameId, startedAt }]`。
	 */
	listVoidable() {
		const out = [];
		let names;
		try {
			names = readdirSync(this.stateDir);
		} catch {
			return out; // 状态目录还不存在是正常的
		}
		for (const name of names) {
			if (!name.endsWith('.json')) continue;
			try {
				const data = JSON.parse(readFileSync(join(this.stateDir, name), 'utf8'));
				if (data?.voided === true && typeof data.gameId === 'string') {
					out.push({ gameId: data.gameId, startedAt: typeof data.startedAt === 'number' ? data.startedAt : Date.now() });
				}
			} catch {
				continue; // 坏文件不挡启动
			}
		}
		return out;
	}

	/** 清理某局的状态、审计与弹窗信箱（观察员手动清理用，默认不调用）。 */
	drop(gameId) {
		for (const path of [this.statePath(gameId), this.auditPath(gameId), this.mailPath(gameId)]) {
			if (existsSync(path)) unlinkSync(path);
		}
	}
}

/**
 * 复盘 raw 导出的下一个局号（§7-1：现有最大编号 +1，不覆盖）。
 *
 * **必须递归**（v1.8.6）：v1.8.6 起导出文件按日期落在 `<exportDir>/<YYYY>/<MM>/` 子目录里，
 * 只扫顶层会把已经导出的局当成不存在 ⇒ 下一局又从「第1局」开始、覆盖同号文件。
 * 同时仍扫 `<exportDir>` 的**父目录**（那里有人手写的 `第N局-<局型>-<日期>.md`，局号要错开）。
 * @param exportDir - `...\狼人杀复盘\_raw`。
 * @returns 下一个局号。
 */
export function nextGameNo(exportDir) {
	const seen = [];
	const walk = (dir, depth) => {
		if (depth > 3) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.endsWith('.tmp')) continue; // v1.29.0：raw 原子写的 tmp 残件不参与局号扫描
			const match = /第\s*(\d+)\s*局/u.exec(entry.name);
			if (match) seen.push(Number(match[1]));
			if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1);
		}
	};
	for (const root of [resolve(exportDir), dirname(resolve(exportDir))]) walk(root, 0);
	return (seen.length === 0 ? 0 : Math.max(...seen)) + 1;
}

/**
 * 复盘 raw 的落盘路径（v1.8.6）：`<exportDir>/<YYYY>/<MM>/<YYYYMMDDHHMM>_第X局.md`。
 * **v1.16.7 起时间戳取「开局那一刻」**：`writeRawExport()` 传 `game.startedAt` ⇒ 同一局的 raw 路径
 * 从开局起就定死（结算导出与赛后感想重写必然落在同一份文件上）。
 * 本地日期建子目录、时间戳同样用本地时间（**不转 UTC**——用户 2026-10-04 报过时区 bug）。
 * @param exportDir - 导出根目录。
 * @param no - 局号。
 * @param at - 时间戳（毫秒，缺省现在）；调用方应传 `game.startedAt`，测试用它钉住结果。
 * @returns 绝对路径。
 */
export function rawExportPath(exportDir, no, at = Date.now()) {
	const date = at instanceof Date ? at : new Date(at);
	const pad = (number) => String(number).padStart(2, '0');
	const year = String(date.getFullYear());
	const month = pad(date.getMonth() + 1);
	const stamp = `${year}${month}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
	return join(resolve(exportDir), year, month, `${stamp}_第${no}局.md`);
}

/**
 * 本地时间格式 `YYYY-MM-DD HH:mm:ss`（**不是** UTC——用户 2026-10-04 报过：
 * 旧实现用 `toISOString()`，导出的时间比本地早 8 小时）。
 * @param value - 毫秒时间戳或 Date。
 * @returns 本地时间字符串；非法值回 `（时间未知）`。
 */
export function localTime(value) {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return '（时间未知）';
	const pad = (number) => String(number).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 读 dsh-chat 的头像映射（`avatars.json`）：键 = 成员别名 / 会话 id，值 = 图片链接。
 * **v1.24.0：键可以用 `|`（也接受 `、` 与 `,`）分隔多个别名** —— 与 dsh-chat 侧（补丁 2 修订）同一套写法，
 * 一个图片路径就能挂多个名字（如 `"大D(v4.1)|大Dv4.1|大D"`）；每个别名都映到同一个链接。
 * 读不到、坏 JSON、非字符串值一律当"没有头像"，绝不让导出让整局失败。
 * @param path - 文件路径；未给则返回空表。
 * @returns `{ [alias]: string }`（`_` 开头的说明键被剔除）。
 */
export function readAvatars(path) {
	if (path === undefined || path === null || path === '') return {};
	try {
		const parsed = JSON.parse(readFileSync(resolve(path), 'utf8'));
		if (parsed === null || typeof parsed !== 'object') return {};
		const out = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (key.startsWith('_')) continue;
			if (typeof value !== 'string' || value.trim() === '') continue;
			for (const alias of key.split(/[|、,]/u).map((part) => part.trim()).filter((part) => part !== '')) out[alias] = value.trim();
		}
		return out;
	} catch {
		return {};
	}
}

/** 发言正文：优先用解析出来的 `prefix.body`，否则从原文里剥掉 `【R1-1 · 名字】` 前缀。 */
function speechBody(entry) {
	const body = entry.prefix?.body;
	if (typeof body === 'string' && body.trim() !== '') return body.trim();
	return String(entry.text ?? '').replace(/^【[^】]*】\s*/u, '').trim();
}

/**
 * 把正文行开头会被 Markdown 当成**块级语法**的记号转义掉（v1.8.2 起）。
 *
 * 用户在预览里抓到过：发言正文里的 `1. ` 被 Obsidian 解析成**有序列表**，气泡当场断掉、
 * 后面的内容全跑到列表块里 ⇒ 这一条必须转义。
 *
 * `- ` **故意不转义**（用户 2026-10-04 明确要求放开）：
 * `> - 破折项` 在 Chatbox 里会渲染成**一个独立气泡**跟在对话后面，正好起分段作用；
 * 而转义成 `> \- 破折项` 只在气泡里显示一个孤零零的减号，更难看。
 *
 * `+ ` 与 `* ` **要转义**：两者都是 Chatbox 的**方向标记**，裸形时万一出现会翻成一个
 * "没名字没头像"的气泡、还摆在**（相对上一条）不同的方向**。实测本机 1079 行发言里
 * `+ `/`* ` 各出现 0 次（`- ` 76 次）⇒ 转义成本≈0，收益是那种翻边气泡永远不会出现。
 * ⚠ `*` **只在后面跟空白时才算方向标记**：`*斜体*`／`**粗体**` 是正文样式，必须原样保留
 * （用户 2026-10-04 指出："区别只在于有没有与正文空格"）——所以这里用 `\*(\s)` 而不是裸 `\*`。
 *
 * `#`（标题）与 `>`（嵌套引用）也转义：它们渲染出来是标题/灰条，会把正文从气泡里顶出去，
 * 转义后文字**原样留在气泡内**。所有转义都只加一个反斜杠、不删字符。
 * @param line - 一行正文（续行；首行跟在 `` `名字` `` 之后，不在块开头，无需处理）。
 * @returns 处理后的行。
 */
function escapeBlockLeads(line) {
	return line
		.replace(/^(\s*)(\d+)([.)])(\s)/u, '$1$2\\$3$4')
		.replace(/^(\s*)\+(\s)/u, '$1\\+$2')
		.replace(/^(\s*)\*(\s)/u, '$1\\*$2')
		.replace(/^(\s*)(#{1,6})(\s)/u, '$1\\$2$3')
		.replace(/^(\s*)>/u, '$1\\>');
}

/**
 * 把 `raw.day` 折成"每轮一段"的转录稿（v1.8.0）。
 *
 * 轮次旁白来自 `day-open`（第 1 轮）与 `round-advanced`（后续各轮，`round` 是**新**轮次）；
 * 气泡只画**被接受**的发言（`decision === 'accepted'`）——被拒/作废这类判定信息改画成旁白式的
 * 提示行，免得污染对话；理由见 README。
 * @param raw - `game.rawExport()`。
 * @returns `{ rounds, firstSpeaker }`。
 */
function buildTranscript(raw) {
	const seats = new Map(raw.players.map((player) => [player.seat, player]));
	const rounds = [];
	let current = null;
	const ensure = (entry, round) => {
		if (current === null) {
			current = { round, at: entry?.at, rows: [] };
			rounds.push(current);
		}
		return current;
	};
	for (const entry of raw.day ?? []) {
		if (entry.type === 'day-open') {
			current = { round: entry.round ?? 1, at: entry.at, rows: [] };
			rounds.push(current);
			continue;
		}
		if (entry.type === 'round-advanced') {
			current = { round: entry.round ?? 1, at: entry.at, rows: [] };
			rounds.push(current);
			continue;
		}
		const round = ensure(entry, entry.round ?? 1);
		if (entry.type === 'speech') {
			const seat = seats.get(entry.seat);
			if (entry.decision === 'accepted') {
				round.rows.push({ kind: 'bubble', human: seat?.human === true, name: entry.name, text: speechBody(entry) });
			} else {
				const label = entry.decision === 'rejected' ? '未计入' : `判定：${entry.decision ?? '?'}`;
				round.rows.push({ kind: 'note', text: `【${label}】${entry.name}：${speechBody(entry)}${entry.reason ? `（${entry.reason}）` : ''}` });
			}
			continue;
		}
		if (entry.type === 'round-void') round.rows.push({ kind: 'note', text: `【本轮作废】第${entry.round}轮：${entry.reason ?? ''}（第 ${entry.count ?? '?'} 次）` });
		// v1.34.0：观察员 `/ww-close-day` 截止白天发言 —— 被放弃的席位在复盘里要看得见（谁没说话）。
		if (entry.type === 'day-skip') {
			const names = Array.isArray(entry.names) ? entry.names.filter((name) => typeof name === 'string' && name !== '') : [];
			round.rows.push({ kind: 'note', text: `【白天截止】第${entry.round}轮：观察员跳过剩余发言（未发言：${names.length === 0 ? '无' : names.join('、')}）` });
		}
	}
	const firstBubble = rounds.flatMap((round) => round.rows).find((row) => row.kind === 'bubble');
	return { rounds, firstSpeaker: firstBubble ?? null };
}

/**
 * 渲染 Chatbox 气泡转录稿 —— **只用于「## 白天发言链判定」那一段**。
 * 头部元信息与其余小节保持原样（用户 2026-10-04 澄清：他说的"整体在最前面加…"指的是**这一段的最前面**，
 * 不是整份文件；第一版把元信息也塞进 callout 是误解）。
 * 方向：AI = `-`，真人 = `+`；第一句是 AI 时标题带 `-swap`。
 * @param raw - `game.rawExport()`。
 * @param avatars - `readAvatars()` 的结果。
 * @param chatstyle - Chatbox 样式名。
 * @returns 行数组（第一行是 `> [!chatbox|…]+ 第N局`）。
 */
function renderChatboxTranscript(raw, avatars, chatstyle) {
	const { rounds, firstSpeaker } = buildTranscript(raw);
	const swap = firstSpeaker !== null && firstSpeaker.human !== true ? '-swap' : '';
	const lines = [`> [!chatbox|${chatstyle}-long${swap}]+ 第${raw.no ?? '?'}局`];
	const signOf = (row) => (row.human === true ? '+' : '-');
	for (const [index, round] of rounds.entries()) {
		const bubbles = round.rows.filter((row) => row.kind === 'bubble');
		if (index === 0 && bubbles.length === 0 && round.rows.length === 0) continue;
		// 旁白：空一行 + 时间 + 轮次（Chatbox 里"空出一行"才会渲染成旁白）。
		lines.push('> ');
		lines.push(`> ${localTime(round.at)} round ${round.round}`);
		// 方向切换时补一个隐形行（`> \n> <span></span>`），否则下一段气泡会被并到同一边。
		const previous = rounds[index - 1];
		const prevLast = previous === undefined ? null : previous.rows.filter((row) => row.kind === 'bubble').at(-1);
		const nextFirst = bubbles[0];
		if (index > 0 && prevLast !== undefined && prevLast !== null && nextFirst !== undefined && signOf(prevLast) !== signOf(nextFirst)) {
			lines.push('> ');
			lines.push('> <span></span>');
		}
		for (const row of round.rows) {
			if (row.kind === 'note') {
				// v1.29.0：旁白/判定行也可能多行（被拒发言的正文自带换行）——逐行补 "> " 前缀、
				// 续行照气泡路径转义块级记号，否则第二个自然行裸奔进 md，Chatbox callout 当场断裂。
				const parts = String(row.text ?? '').split('\n').map((line) => line.trimEnd());
				lines.push(`> ${parts[0] ?? ''}`);
				for (const line of parts.slice(1)) lines.push(line === '' ? '>' : `> ${escapeBlockLeads(line)}`);
				continue;
			}
			const sign = signOf(row);
			const avatar = avatars[row.human === true ? '你' : row.name];
			const face = avatar === undefined ? '' : `![face](${avatar}) `;
			const body = String(row.text ?? '').split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
			const [head, ...rest] = body.length === 0 ? [''] : body;
			lines.push(`> ${sign} ${face}\`${row.name}\` ${head}`.trimEnd());
			// 续行在块开头 ⇒ 必须转义块级语法，否则 Obsidian 会把 `1. …` 当列表、气泡当场断掉
			for (const line of rest) lines.push(`> ${escapeBlockLeads(line)}`);
		}
	}
	return lines;
}

/**
 * 渲染「## 完赛感想」那一节（v1.16.0，用户 2026-10-05 要求）。
 *
 * 格式（照用户给的样例，Chatbox callout）：
 *   `> [!chatbox|<style>-long]+ 感想`
 *   `> - ![face](头像) \`玩家A\` 感想`（AI 首轮，按座位）
 *   `> + ![face](头像) \`真人名\` 点评`（真人，最多一条）
 *   `> - ![face](头像) \`玩家A\` 回复`（AI 次轮 —— 对点评的回复，v1.28.0 起也进这一节）
 *
 * 方向与白天发言链同一套（真人 `+`、AI `-`、头像按 `avatars[真人 ? '你' : 名字]` 取）。
 * ⚠ **v1.28.0（用户 2026-10-08）起头部不再带 `-swap`**（用户指定 `> [!chatbox|<style>-long]+ 感想`）——
 * 白天那一节的 `-swap` 判据不受影响，仍按"第一句是 AI 就加"。
 *
 * 顺序（v1.28.0）：**AI 首轮（按座位）→ 真人（按座位、无座位的观察员最后）→ AI 次轮（按座位）**，
 * 它复刻房间里的真实时序（AI 先自动发感想 ⇒ 真人点评 ⇒ AI 回第二条）；同档内不看到达顺序、只看座位。
 * 续行同样要转义块级记号（`1. ` 这类会把气泡当场顶断）。
 *
 * v1.16.4：**观察员的点评也进这一节**（AI 局里没有真人席位，那条的作者不是任何座位）——
 * 它的 `name` 是 `null`（引擎不知道他叫什么），渲染时用**配置里的玩家名**兜底（`options.humanName`，默认「观察员」）；
 * 他没有座位 ⇒ 在真人的那一档里排最后。
 * @param raw - `game.rawExport()`。
 * @param avatars - `readAvatars()` 的结果。
 * @param chatstyle - Chatbox 样式名。
 * @param humanName - 配置里的玩家名（给**没有座位**的真人条目兜底；例：观察员的点评）。
 * @returns 行数组（第一行是 callout 头）。
 */
function renderClosingCallout(raw, avatars, chatstyle, humanName) {
	const fallbackName = typeof humanName === 'string' && humanName.trim() !== '' ? humanName.trim() : '观察员';
	// 没有座位的条目（观察员）排在**有座位的真人之后**。
	const seatOf = (entry) => (entry?.seat === undefined || entry?.seat === null ? Number.MAX_SAFE_INTEGER : entry.seat);
	// 轮次 = 同一会话在这一节里的第几条（`closing` 是到达顺序 ⇒ 第一条 = 0、第二条 = 1）。
	const seen = new Map();
	const entries = [...(raw.closing ?? [])]
		.filter((entry) => typeof entry?.text === 'string' && entry.text.trim() !== '')
		.map((entry) => {
			const key = String(entry?.sessionId ?? `#${seatOf(entry)}@${entry?.at ?? 0}`);
			const round = seen.get(key) ?? 0;
			seen.set(key, round + 1);
			return { entry, round };
		})
		// 0 = AI 首轮、1 = 真人、2 = AI 次轮；同档内按座位（观察员没有座位 ⇒ 排最后）。
		.sort((a, b) => {
			const groupOf = (item) => (item.entry.human === true ? 1 : item.round === 0 ? 0 : 2);
			const groupA = groupOf(a);
			const groupB = groupOf(b);
			if (groupA !== groupB) return groupA - groupB;
			return seatOf(a.entry) - seatOf(b.entry);
		});
	// v1.28.0（用户 2026-10-08）：头部不再带 `-swap`。
	const lines = [`> [!chatbox|${chatstyle}-long]+ 感想`];
	for (const { entry } of entries) {
		const sign = entry.human === true ? '+' : '-';
		const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : fallbackName;
		const avatar = avatars[entry.human === true ? '你' : entry.name];
		const face = avatar === undefined ? '' : `![face](${avatar}) `;
		const body = String(entry.text ?? '').split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
		const [head, ...rest] = body.length === 0 ? [''] : body;
		lines.push(`> ${sign} ${face}\`${name}\` ${head}`.trimEnd());
		for (const line of rest) lines.push(`> ${escapeBlockLeads(line)}`);
	}
	return lines;
}

/**
 * 渲染对局 raw 导出（Markdown）。
 *
 * 结构（v1.8.0 定稿；v1.16.0 追加「## 完赛感想」）：头部元信息与 `## 牌面` / `## 票型与结算`
 * **保持原有 bullet/表格形态**，`## 白天发言链判定` 与 `## 完赛感想` 两节是 Chatbox 气泡卡；
 * 「## 夜间（…）」与「## 全量事件」两块已删。感想节**只在有感想时出现**（结算那一刻还没有，之后重写才有）。
 * @param game - 对局。
 * @param options - `{ chatstyle, avatarFile }`。
 * @returns Markdown 文本。
 */
export function renderRaw(game, options = {}) {
	const raw = game.rawExport();
	const avatars = readAvatars(options.avatarFile);
	const chatstyle = typeof options.chatstyle === 'string' && options.chatstyle.trim() !== '' ? options.chatstyle.trim() : 'qqchat';
	const lines = [];
	lines.push(`# 第${raw.no ?? '?'}局 庄家原始记录（${raw.mode}人局）`);
	lines.push('');
	lines.push(`- 局标识：\`${raw.gameId}\``);
	lines.push(`- 房间：${raw.room.name}（\`${raw.room.id}\`）`);
	lines.push(`- 随机种子：\`${raw.seed}\`（同种子可复现同一牌序）`);
	lines.push(`- 开始时间：${localTime(raw.startedAt)}`);
	lines.push(`- 导出时间：${localTime(Date.now())}`);
	lines.push(`- 复盘写手：${raw.recapWriter ?? '（未指派）'}（结算后按双方人数与最后发言判定）`);
	lines.push('');
	lines.push('## 牌面');
	lines.push('');
	lines.push('| 座位 | 玩家 | 被发到的牌 | 现值（换卡后） | 阵营 |');
	lines.push('|---|---|---|---|---|');
	for (const player of raw.players) lines.push(`| ${player.seat} | ${player.name} | ${player.dealt} | ${player.current} | ${player.camp === 'wolf' ? '狼' : '人类'} |`);
	lines.push('');
	lines.push(`牌堆：${raw.pile.join('、')}`);
	lines.push('');
	lines.push('## 白天发言链判定');
	lines.push('');
	lines.push(...renderChatboxTranscript(raw, avatars, chatstyle));
	lines.push('');
	lines.push('## 票型与结算');
	lines.push('');
	if (raw.settlement) {
		for (const entry of raw.settlement.ballot) lines.push(`- ${entry.seat}.${entry.name} → ${entry.targetName}${entry.override ? '（观察员覆写）' : ''}（原文：${entry.raw}）`);
		for (const entry of raw.settlement.abstain) lines.push(`- ${entry.seat}.${entry.name} → 弃票（${entry.reason}）`);
		lines.push('');
		// v1.29.0：误杀同伴的 verdict 不打「狼阵营获胜」括注 —— 与 sentence（人类阵营失败）自相矛盾，
		// 公告侧（#settlementText）已同步收口，这里保持同一口径。
		const outcome = raw.settlement.verdict === 'wolf-mislynch-no-wolf'
			? '人类阵营失败（误杀同伴）'
			: raw.settlement.winner === 'human' ? '人类阵营获胜' : '狼阵营获胜';
		lines.push(`结果：${raw.settlement.verdict}（${outcome}）；${raw.settlement.sentence}`);
	} else {
		lines.push('（未进入结算）');
	}
	lines.push('');
	// v1.16.0：完赛感想（结算之后才收得到 ⇒ 通常由「重写同一个文件」补上；没有就整节不出现）。
	if (Array.isArray(raw.closing) && raw.closing.length > 0) {
		lines.push('## 完赛感想');
		lines.push('');
		lines.push(...renderClosingCallout(raw, avatars, chatstyle, options.humanName));
		lines.push('');
	}
	return lines.join('\n');
}

/**
 * 写出复盘 raw（游戏结束才调用，§7-1）。
 * 落盘路径见 `rawExportPath()`：`<exportDir>/<YYYY>/<MM>/<YYYYMMDDHHMM>_第X局.md`（自动建目录）。
 * @param game - 已结算 / 已终止的对局。
 * @param options - `{ exportDir, chatstyle, avatarFile }`（后两项见 `/ww-config`）。
 * @returns `{ no, path }`。
 */
export function writeRawExport(game, options = {}) {
	// 防御：没配导出目录时不写盘 —— 否则 `resolve('')` 会落回 cwd，把复盘写进工作区。
	const dirHint = typeof options === 'string' ? options : options.exportDir;
	if (typeof dirHint !== 'string' || dirHint.trim() === '') throw new Error('exportDir 未配置：不写复盘 raw');
	const dir = resolve(options.exportDir ?? options);
	const no = game.no ?? nextGameNo(dir);
	// v1.16.0：**重写同一个文件** —— 完赛感想是结算之后才到的，第一条一到就要并进去。
	//   · 给了 `path` ⇒ 就写它（配合 `overwrite: true` 允许覆盖）；
	//   · 没给 ⇒ 照旧按时间戳算路径，且**已存在就抛**（结算导出是幂等的，不该悄悄覆盖）。
	// v1.16.7（用户 2026-10-05 实测：第 8 局导出目录里出现 0724/0726/0727/0730 **四份**）：
	// 时间戳改取**开局那一刻**（`game.startedAt`，定死），不再取"导出时刻"。
	// 为什么：结算后的每条完赛感想都会再跑一次 `exportRaw()`（见 index.js `runEffects` 尾部），
	// 旧实现每次都用 `Date.now()` ⇒ 跨分钟就各写一份新文件；定死开局时间后同一局的路径天然唯一，
	// `already exists` 那条幂等分支才真的生效（改动前它只在"同一分钟内"偶然生效）。
	const at = Number.isFinite(game?.startedAt) ? game.startedAt : Date.now();
	const path = typeof options.path === 'string' && options.path.trim() !== '' ? resolve(options.path) : rawExportPath(dir, no, at);
	mkdirSync(dirname(path), { recursive: true });
	if (existsSync(path) && options.overwrite !== true) throw new Error(`raw export already exists: ${path}`);
	// v1.29.0：原子写（tmp + rename，与 saveState 同款）—— 直写终路径时写一半崩溃会留下截断文件，
	// 且 already-exists 幂等分支会把它**固化**（此后每次结算导出都抛，只有下一条完赛感想的
	// overwrite 重写才自愈）。
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, renderRaw(game, options), 'utf8');
	renameSync(tmp, path);
	return { no, path };
}

/** 路径是否位于某个根之下（隐私验收用）。 */
export function isInside(parent, child) {
	const a = resolve(parent).toLowerCase();
	const b = resolve(child).toLowerCase();
	return b === a || b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`);
}
