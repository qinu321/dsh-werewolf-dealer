/**
 * dsh-werewolf-dealer —— 客户端半边（浏览器模块，v1.7.1 起；v1.7.7 加去重判据）。
 *
 * 目的：把「源为 `plugin:dsh-werewolf-dealer` 的私聊」在**真人自己的会话时间线里画成可见卡片**。
 *
 * 为什么必须自己注册节点（机制已取证，别再重复排查）：
 *   · 官方 Chat 时间线对插件来源的 `user/message` 有两道闸——
 *     `dsh-client-ui-chat` 的 client.js 把「非 `user` 来源的 user/message」分类成 `context`，
 *     而 `isVisibleChatNode()` 把普通 context 行排除在可见 Chat 行之外（只有含
 *     tool-addition/tool-removal 的 context 例外）。
 *   · 于是私聊「进了会话、模型读得到、人看不见」。
 * 唯一出路是自己注册一个节点定义（kind 不是 context、自报 `visibility: "visible"`、
 * `location` 声明 `unresolved` 不参与回合折叠）+ 一条自己的渲染器。
 * 形状完全照抄本机活体先例 `dsh-chat/lib/client.js` 的 broadcast 定义（同一运行时里已生效）。
 *
 * ⚠ **别对"会唤醒会话"的消息也画卡片**（v1.7.7）：那类消息会成为回合的触发输入，官方渲染器把
 * 它升级成可见的 `turn-trigger` 行（「收到执行请求」）⇒ 再画一张卡就是同一个气泡画两遍
 * （用户 2026-10-04 真机："狼只发一条信息，但有两个气泡框"）。判据是 `surfaceOp === 'append'`
 * —— 那正是"只落表面、不唤醒"这一类，也就是卡片真正要救的那一类。见 `match()` 里的注释。
 *
 * 纪律：不 import 任何 `@deepseek-ai/dsh-client-*`（React 与 UI 原语都由模块表提供）；
 * 样式只用主题 token（`--dsw-alias-*`），亮/暗主题都要可读。
 */

window.__ModuleLoader__.load({
	id: 'dsh-werewolf-dealer',
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		const React = require('react');
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
				popupAck: '知道了',
				popupHint: '在房间发言框里直接回 `/ww-reply <回答>`；这条不会出现在房间时间线上。',
				popupFailed: '暂时连不上庄家（这是弹窗通道的问题，不影响对局状态）'
			},
			en: {
				title: 'Dealer PM',
				hint: 'Reply with `/ww-reply <answer>`',
				popupTitle: 'Dealer PM',
				popupAck: 'Got it',
				popupHint: 'Answer with `/ww-reply <answer>` in the room composer; it never reaches the room timeline.',
				popupFailed: 'Cannot reach the dealer right now (popup channel only; the game state is unaffected)'
			}
		};

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

			/**
			 * 事件定义：一条 `user/message`（源是我们的 producer kind）= 一张卡片。
			 * `publication: 'immediate'` 让它不等回合边界立刻出现（dsh-chat 同款）。
			 */
			const definition = {
				kind: NODE_KIND,
				target: 'chat',
				/**
				 * 只认**落在表面上**（`surfaceOp === 'append'`）的那一类，也就是 dsh-bridge 的
				 * `wake:false` 投递 —— 官方把它当 context 行**不渲染**，卡片存在的意义就是它。
				 *
				 * ⚠ 会**唤醒**会话的消息（`wake:true`）走的是另一条路：它成为该回合的触发输入，
				 * 官方渲染器把它升级成可见的 `turn-trigger` 行（界面文案「收到执行请求」，判定见
				 * `@deepseek-ai/dsh-client-ui-chat/lib/client.js:9284/9305`：`context + waking === true`
				 * ⇒ `turn-trigger`）。那种消息**本来就看得见**，我们再画一张卡 = 同一个气泡画两遍
				 * （用户 2026-10-04 真机："狼只发一条信息，但有两个气泡框，两边发言一模一样"）。
				 */
				match(event) {
					if (event.type !== 'user/message') return null;
					if (event.data?.source?.kind !== SOURCE_KIND) return null;
					if (event.surfaceOp !== 'append') return null;
					return { id: String(event.data.id), role: 'start' };
				},
				start(_context, match) {
					return {
						id: String(match.event.data?.id ?? ''),
						time: match.event.time ?? Date.now(),
						text: stripEnvelope(firstText(match.event))
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
			 * ⚠ **游标只在点「知道了」之后才推进**：关掉浏览器再回来，没看过的还会再弹（宁重复、不丢）。
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

			/** 一张浮层卡片：把这一批未读私密内容一次显示完，点「知道了」才推进游标。 */
			function DealerMailPopup() {
				const [records, setRecords] = React.useState([]);
				const [failed, setFailed] = React.useState(false);
				const cursor = React.useRef(null);
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
				const acknowledge = () => {
					const top = records.length > 0 ? records[records.length - 1] : undefined;
					if (top !== undefined && typeof top.seq === 'number') {
						cursor.current = Math.max(cursor.current, top.seq);
						// 写不进去（无痕模式 / 存储被禁）不影响这一局：只是下次刷新会再弹一遍。
						try { globalThis.localStorage?.setItem(CURSOR_KEY, String(cursor.current)); } catch { /* 忽略 */ }
					}
					setRecords([]);
				};
				if (records.length === 0) return null;
				return h(
					'section',
					{
						'data-dsh-werewolf-popup': String(records[records.length - 1].seq),
						'aria-label': t('popupTitle'),
						style: {
							position: 'fixed',
							right: 20,
							bottom: 20,
							zIndex: 60,
							width: 'min(420px, calc(100vw - 40px))',
							maxHeight: '60vh',
							overflowY: 'auto',
							border: '0.5px solid var(--dsw-alias-border-l1)',
							borderRadius: 14,
							background: 'var(--dsw-alias-bg-layer-1)',
							boxShadow: 'var(--dsw-elevation-panel)',
							padding: '13px 16px 11px',
							display: 'flex',
							flexDirection: 'column',
							gap: 8
						}
					},
					h(
						'header',
						{ style: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } },
						h('span', { 'aria-hidden': true }, '📨'),
						h('span', null, t('popupTitle')),
						failed ? h('span', { style: { marginLeft: 'auto' } }, t('popupFailed')) : null
					),
					...records.map((record) => h(MailBoundary, { key: record.seq, text: String(record.text ?? '') },
						h('div', { style: { ...PLAIN_STYLE, fontSize: 15 } }, String(record.text ?? '')))),
					h('div', { style: { borderTop: '0.5px solid var(--dsw-alias-border-l1)', paddingTop: 7, display: 'flex', alignItems: 'center', gap: 10 } },
						h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, t('popupHint')),
						h('button', {
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
	}
});
