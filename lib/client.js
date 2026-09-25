/**
 * 会话状态行余额插件（浏览器半侧，已构建的 bundle）。v0.2.0
 *
 * 形态与随产品发布的客户端插件一致：bundle 只做一件事——向
 * window.__ModuleLoader__ 注册 factory；factory 被物化时返回模块导出
 * （apply / inject）。因此本文件既是源码也是产物，无需任何构建工具链。
 *
 * 渲染位置：ui-conversation 的 InputBar 尾部（composer dock），即截图中
 * “3 轮 190 步 · 294 tok/s  26.7M tok · 缓存命中 99.7%  ◔23%” 那一行。
 * ui-chat 以 id: "stats"、order: 0 注册同一 slot，本插件取 order: 10，
 * 于是余额跟在统计组之后、上下文占用环之前。
 *
 * 数据来源：ctx.remote.account（Host 服务 ctx.deepseekAccount 的 Remote 面）
 *   getState()  → { status: 'signed-out' | 'credential-stored', ... }
 *   getBalance(metadata) → null
 *                        | { status: 'ready', value: Wallet[], bonusWallets: Wallet[] }
 *                        | { status: 'failed' }
 *   其中 Wallet = { currency: 'CNY' | 'USD', balance: string }（十进制字符串，
 *   允许 0E-16、1e+3 这类指数写法），null 表示当前没有已保存的账号授权。
 *
 * 设计要点见 README.md：登录态优先、认不出的帧不当作登出、无订阅者/后台标签页
 * 不打扰 Host、金额用字符串十进制精确渲染、诊断走 console.info。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-account-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region \0dsh-css:dsh-plugin-account-balance/BalancePill.module.css
		const css = ".dsh-balance-root{box-sizing:border-box;min-width:0;max-width:100%;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));justify-content:center;gap:12px;display:flex}.dsh-balance-anchor{min-width:0;display:inline-flex}.dsh-balance-pill{box-sizing:border-box;corner-shape:round;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}.dsh-balance-pill svg{flex:none;width:14px;height:14px}.dsh-balance-label{text-overflow:ellipsis;min-width:0;overflow:hidden}.dsh-balance-pill[aria-busy=true] .dsh-balance-label{opacity:.65}button.dsh-balance-pill{cursor:pointer}button.dsh-balance-pill:hover,button.dsh-balance-pill:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}button.dsh-balance-pill:focus-visible{outline:var(--dsh-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}";
		const tagId = "dsh-plugin-account-balance/BalancePill.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-account-balance";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region 配置接缝
		/**
		 * 客户端插件拿不到自己的 Loader config（apply 只收到 ctx；产品包用
		 * ctx.configForms 或外壳注入的全局量读配置），因此这里读一个显式接缝：
		 * 部署方可在页面注入
		 *   window.__DSH_ACCOUNT_BALANCE_CONFIG__ = { refreshMs: 30000, clientVersion: "x.y.z" }
		 * 来调参，而不必改这个 bundle。正式做法（Host 侧 Config schema + 客户端
		 * ctx.configForms.get(ns)）被有意放弃：它会给这个 bundle 引入 schemastery
		 * 依赖与 DSH peer 声明，反而让它在 DSH 升级时更容易被跳过。
		 */
		const FALLBACK_REFRESH_MS = 60000;
		const MIN_REFRESH_MS = 5000;
		const FALLBACK_CLIENT_VERSION = "0.1.7-rc.2";
		const injected = typeof globalThis !== "undefined" && globalThis.__DSH_ACCOUNT_BALANCE_CONFIG__ !== void 0 && globalThis.__DSH_ACCOUNT_BALANCE_CONFIG__ !== null ? globalThis.__DSH_ACCOUNT_BALANCE_CONFIG__ : {};
		const REFRESH_MS = typeof injected.refreshMs === "number" && Number.isFinite(injected.refreshMs) && injected.refreshMs >= MIN_REFRESH_MS ? injected.refreshMs : FALLBACK_REFRESH_MS;
		/**
		 * 客户端构建版本，作为 AccountClientMetadata.version 上报（Platform 客户端
		 * 请求头之一）。产品包在打包期把 DSH_CLIENT_VERSION 内联进各自的 bundle，
		 * 手写 bundle 没有这一步，因此这里按 运行时全局量 → 配置接缝 → 兜底常量 取值。
		 */
		const CLIENT_VERSION = typeof globalThis !== "undefined" && typeof globalThis.__DSH_CLIENT_VERSION__ === "string" && globalThis.__DSH_CLIENT_VERSION__ !== "" ? globalThis.__DSH_CLIENT_VERSION__ : typeof injected.clientVersion === "string" && injected.clientVersion !== "" ? injected.clientVersion : FALLBACK_CLIENT_VERSION;
		//#endregion
		//#region locales
		/** Locale 命名空间；注册到 slot 后组件即获得该命名空间的 t()。 */
		const NS = "account-balance";
		const zh = {
			"balance.value": "余额 {amount}",
			"balance.aria": "账号余额 {amount}",
			"balance.unavailable": "余额不可用",
			"balance.aria.unavailable": "账号余额不可用",
			"balance.row.recharge": "充值余额 {amount}",
			"balance.row.bonus": "赠送余额 {amount}",
			"balance.row.updated": "更新于 {time}",
			"balance.row.refresh": "点击刷新",
			"balance.row.retry": "点击重试",
			"balance.row.pending": "正在刷新…"
		};
		const en = {
			"balance.value": "Balance {amount}",
			"balance.aria": "Account balance {amount}",
			"balance.unavailable": "Balance unavailable",
			"balance.aria.unavailable": "Account balance unavailable",
			"balance.row.recharge": "Recharge balance {amount}",
			"balance.row.bonus": "Bonus balance {amount}",
			"balance.row.updated": "Updated {time}",
			"balance.row.refresh": "Click to refresh",
			"balance.row.retry": "Click to retry",
			"balance.row.pending": "Refreshing…"
		};
		//#endregion
		//#region 十进制金额
		/**
		 * Platform 交给 big.js 的十进制文法（与 Host 侧 zod 校验同一套）：允许省略
		 * 整数或小数部分以及十进制指数，因此 0E-16、1e+3、.5、12. 都是合法值。
		 */
		const DECIMAL_GRAMMAR = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
		/** 整数部分千分位分组（纯字符串，任意位数都精确）。 */
		const GROUPING = /\B(?=(\d{3})+(?!\d))/g;
		/** 整数位超过该位数即视为不可渲染，避免为荒谬取值分配巨大字符串。 */
		const MAX_INTEGER_DIGITS = 30;
		/** @param currency - Platform 钱包币种。 @returns 展示用货币符号。 */
		function symbolFor(currency) {
			return currency === "USD" ? "$" : "¥";
		}
		/**
		 * 把十进制字符串解析成"截断到两位小数"的精确分量，全程不经过浮点。
		 * 与产品设置页一致：正数向下取整（big.js 的 roundDown）。
		 * @param raw - Platform 返回的余额字符串。
		 * @returns { negative, zero, subCent, integer, fraction }；非法或过大时 null。
		 */
		function parseAmount(raw) {
			if (typeof raw !== "string") return null;
			const text = raw.trim();
			if (text === "" || !DECIMAL_GRAMMAR.test(text)) return null;
			const negative = text.charCodeAt(0) === 45;
			const body = negative ? text.slice(1) : text;
			const exponentAt = body.search(/[eE]/);
			const mantissa = exponentAt < 0 ? body : body.slice(0, exponentAt);
			const exponent = exponentAt < 0 ? 0 : Number.parseInt(body.slice(exponentAt + 1), 10);
			if (!Number.isSafeInteger(exponent)) return null;
			const dot = mantissa.indexOf(".");
			const intText = dot < 0 ? mantissa : mantissa.slice(0, dot);
			const fracText = dot < 0 ? "" : mantissa.slice(dot + 1);
			const digits = intText + fracText;
			const zero = !/[1-9]/.test(digits);
			const pointPos = intText.length + exponent;
			if (pointPos > MAX_INTEGER_DIGITS) return null;
			// 首个有效位落在小数点后第 3 位之后：截断到两位小数必然是 0.00
			if (!zero && pointPos < -2) return {
				negative,
				zero: false,
				subCent: true,
				integer: "0",
				fraction: "00"
			};
			let integer;
			let fraction;
			if (pointPos <= 0) {
				integer = "0";
				fraction = ("0".repeat(-pointPos) + digits).slice(0, 2).padEnd(2, "0");
			} else {
				integer = digits.slice(0, pointPos).padEnd(pointPos, "0");
				fraction = digits.slice(pointPos).padEnd(2, "0").slice(0, 2);
			}
			const canonical = integer.replace(/^0+/, "") || "0";
			return {
				negative,
				zero,
				subCent: !zero && canonical === "0" && fraction === "00",
				integer: canonical,
				fraction
			};
		}
		/**
		 * 渲染金额：零显示 0.00，不足一分显示 <¥0.01，负数按产品规则显示 -¥0.01 /
		 * 绝对值。与设置页的唯一差异：负数分支这里同样向下取整，而官方那支的
		 * big.js toFixed 是四舍五入（负数余额实际不可达，此处选择单一规则，见 README）。
		 * @param raw - 十进制余额字符串。
		 * @param symbol - 货币符号。
		 * @returns 金额文本；无法精确表示时 null（调用方跳过该钱包，绝不回显原文）。
		 */
		function formatAmount(raw, symbol) {
			const amount = parseAmount(raw);
			if (amount === null) return null;
			if (amount.zero) return symbol + "0.00";
			const grouped = amount.integer.replace(GROUPING, ",");
			if (amount.negative) return "-" + symbol + (amount.subCent ? "0.01" : grouped + "." + amount.fraction);
			if (amount.subCent) return "<" + symbol + "0.01";
			return symbol + grouped + "." + amount.fraction;
		}
		/** @param timestamp - 毫秒时间戳。 @returns 本地 HH:mm；失败返回空串。 */
		function formatClock(timestamp) {
			try {
				return new Date(timestamp).toLocaleTimeString(void 0, {
					hour: "2-digit",
					minute: "2-digit",
					hour12: false
				});
			} catch (_error) {
				return "";
			}
		}
		//#endregion
		//#region 诊断
		/**
		 * 每类问题只报一次的控制台诊断：状态行只显示“余额不可用”，没有日志就无法排查。
		 * 前缀与产品的 [deepseek-account] 诊断同风格，且不包含凭据、响应正文或原始异常。
		 * @returns 各类诊断入口；成功的读取会重置“读取失败”的抑制。
		 */
		function createDiagnostics() {
			const reported = /* @__PURE__ */ new Set();
			const emit = (key, message, detail) => {
				if (reported.has(key)) return;
				reported.add(key);
				console.info("[account-balance] " + message, detail);
			};
			const reason = (error) => error instanceof Error ? error.message : String(error);
			return {
				readSucceeded: () => {
					reported.delete("read-failed");
				},
				readFailed: (error) => emit("read-failed", "余额读取失败，保留上一次结果", { reason: reason(error) }),
				statusFailed: (error) => emit("status-failed", "账号状态读取失败，暂不判断登录态", { reason: reason(error) }),
				streamFailed: (error) => emit("stream-failed", "账号状态流结束，改用定时读取", { reason: reason(error) }),
				unknownStatus: (status) => emit("unknown-status:" + String(status), "无法识别的账号状态，已忽略该帧", { status: String(status) }),
				amountUnreadable: (currency, kind) => emit("amount:" + kind + ":" + currency, "无法精确表示的余额，已跳过该钱包", {
					currency,
					kind
				})
			};
		}
		//#endregion
		//#region store
		/**
		 * 插件私有的余额快照源；通过 slot 的 hooks share 交给组件。
		 * 它同时是“有没有人在看”的判据：第一个订阅者出现时才去打扰 Host。
		 * @param onActivate - 订阅者数量从 0 变 1 时调用（首次挂载立即取一次）。
		 * @returns 满足 { getSnapshot, subscribe, active, publish } 的快照源。
		 */
		function createBalanceStore(onActivate) {
			let snapshot = {
				phase: "idle",
				signedIn: void 0,
				wallets: [],
				bonusWallets: [],
				updatedAt: null,
				pending: false
			};
			const listeners = /* @__PURE__ */ new Set();
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					if (listeners.size === 1) onActivate();
					return () => {
						listeners.delete(listener);
					};
				},
				active: () => listeners.size > 0,
				publish: (next) => {
					snapshot = next;
					for (const listener of [...listeners]) listener();
				}
			};
		}
		//#endregion
		//#region 渲染
		/** 钱包图标：描边圆角矩形加一枚实心卡扣。 */
		function WalletIcon() {
			return react.createElement("svg", {
				viewBox: "0 0 16 16",
				"aria-hidden": true,
				focusable: false
			}, react.createElement("rect", {
				x: 1.6,
				y: 3.6,
				width: 12.8,
				height: 8.8,
				rx: 2.4,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.2
			}), react.createElement("circle", {
				cx: 11.2,
				cy: 8,
				r: 1.1,
				fill: "currentColor"
			}));
		}
		/**
		 * 按币种归并充值钱包与赠送钱包：每个出现过的币种一枚 pill，跨币种绝不求和。
		 * @param state - 余额快照。
		 * @returns 有序的币种分组（含已格式化的金额文本）。
		 */
		function groupWallets(state) {
			const groups = /* @__PURE__ */ new Map();
			const ordered = [];
			const touch = (currency) => {
				let group = groups.get(currency);
				if (group === void 0) {
					group = {
						currency,
						symbol: symbolFor(currency),
						rechargeText: null,
						bonusTexts: []
					};
					groups.set(currency, group);
					ordered.push(group);
				}
				return group;
			};
			for (const wallet of state.wallets) {
				const text = formatAmount(wallet.balance, symbolFor(wallet.currency));
				if (text !== null) touch(wallet.currency).rechargeText = text;
			}
			for (const wallet of state.bonusWallets) {
				const amount = parseAmount(wallet.balance);
				if (amount === null || amount.zero) continue;
				const text = formatAmount(wallet.balance, symbolFor(wallet.currency));
				if (text !== null) touch(wallet.currency).bonusTexts.push(text);
			}
			return ordered;
		}
		/**
		 * 渲染一枚 pill：按钮 + 产品 Tooltip（label 支持换行，white-space: pre-line）。
		 * @param props - 组件内部传参。
		 * @returns 该币种的 pill。
		 */
		function BalancePill(props) {
			const { group, title, label, ariaLabel, pending, refresh } = props;
			const button = react.createElement("button", {
				type: "button",
				className: "dsh-balance-pill",
				"aria-label": ariaLabel,
				"aria-busy": pending ? "true" : void 0,
				"data-currency": group === null ? void 0 : group.currency,
				onClick: refresh
			}, [react.createElement(WalletIcon, { key: "icon" }), react.createElement("span", {
				key: "label",
				className: "dsh-balance-label"
			}, label)]);
			const Tooltip = primitives.Tooltip;
			if (typeof Tooltip !== "function") return react.createElement("span", { className: "dsh-balance-anchor" }, button);
			return react.createElement(Tooltip, {
				label: title,
				side: "top",
				delayMs: 500
			}, button);
		}
		/**
		 * composer dock 条目：每个有余额的币种一枚 pill；读取失败且已知已登录时显示
		 * “余额不可用”；未登录、登录态未知或尚无结果时完全不渲染（不占位、不闪烁）。
		 * @param props - 框架 share（标准工具包）、本插件注入的余额快照源与刷新动作。
		 * @returns 状态行中的余额 pill 组，或 null。
		 */
		function AccountBalancePill(props) {
			const { useAccountBalance, t, refresh } = props;
			const state = useAccountBalance((value) => value);
			if (state.phase !== "ready" && state.phase !== "failed") return null;
			const tail = t(state.pending ? "balance.row.pending" : state.phase === "failed" ? "balance.row.retry" : "balance.row.refresh");
			const updated = state.updatedAt === null ? null : t("balance.row.updated", { time: formatClock(state.updatedAt) });
			if (state.phase === "failed") {
				// 只有“已知已登录”才报错：否则只会对没有平台账号的部署喊狼来了
				if (state.signedIn !== true) return null;
				return react.createElement("div", {
					className: "dsh-balance-root",
					"data-account-balance": ""
				}, react.createElement(BalancePill, {
					group: null,
					title: [t("balance.aria.unavailable"), tail].join("\n"),
					label: t("balance.unavailable"),
					ariaLabel: t("balance.aria.unavailable"),
					pending: state.pending,
					refresh
				}));
			}
			const pills = [];
			for (const group of groupWallets(state)) {
				const amountText = group.rechargeText ?? group.bonusTexts[0] ?? null;
				if (amountText === null) continue;
				const lines = [];
				if (group.rechargeText !== null) lines.push(t("balance.row.recharge", { amount: group.rechargeText }));
				for (const bonusText of group.bonusTexts) lines.push(t("balance.row.bonus", { amount: bonusText }));
				if (updated !== null) lines.push(updated);
				lines.push(tail);
				const label = t("balance.value", { amount: amountText });
				pills.push(react.createElement(BalancePill, {
					key: group.currency,
					group,
					title: lines.join("\n"),
					label,
					ariaLabel: t("balance.aria", { amount: amountText }),
					pending: state.pending,
					refresh
				}));
			}
			if (pills.length === 0) return null;
			return react.createElement("div", {
				className: "dsh-balance-root",
				"data-account-balance": ""
			}, pills);
		}
		//#endregion
		//#region plugin
		/**
		 * 必需服务：slot 注册表、locale 字典、Remote 服务与其 account 命名空间
		 * （余额与账号状态由 @deepseek-ai/dsh-api-account-controller 转发到 Host 账号服务）。
		 */
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.account"
		];
		/** @returns 当前是否处于后台标签页（无 document 时视为可见）。 */
		function isHidden() {
			return typeof document !== "undefined" && document.visibilityState === "hidden";
		}
		/**
		 * 客户端插件体：注册字典、账号状态流 + 定时同步（只按需打扰 Host），并把
		 * pill 注册进 composer dock。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "account-balance: dictionaries");
			const diagnostics = createDiagnostics();
			/** undefined = 还不知道；true/false = 最近一次确认的登录态。 */
			let signedIn;
			let generation = 0;
			let inflight;
			const store = createBalanceStore(() => {
				void sync();
			});
			/** @returns 每次调用现读的调用方身份，携带当下生效的语言与时区。 */
			const metadata = () => ({
				version: CLIENT_VERSION,
				locale: ctx.locale.getSnapshot().active,
				timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
			});
			/**
			 * 读取一次登录态。它是本地 Host 调用（不触达 Platform），因此可以每个周期都读。
			 * @returns true/false，或读不到时的 undefined（此时保持既有判断）。
			 */
			const readStatus = async () => {
				let result;
				try {
					result = await ctx.remote.account.getState();
				} catch (error) {
					diagnostics.statusFailed(error);
					return void 0;
				}
				if (result === void 0 || result === null || result.ok !== true || result.value === void 0 || result.value === null) return void 0;
				const status = result.value.status;
				if (status === "credential-stored") return true;
				if (status === "signed-out") return false;
				diagnostics.unknownStatus(status);
				return void 0;
			};
			/**
			 * 读取一次余额（不等待资料等其他账号字段）。
			 * @returns 余额查询结果；null 表示当前没有可用的账号授权。
			 */
			const readBalance = async () => {
				const result = await ctx.remote.account.getBalance(metadata());
				if (result === void 0 || result === null || result.ok !== true) throw (result === null || result === void 0 ? void 0 : result.error) !== void 0 ? result.error : new Error("account balance request failed");
				return result.value;
			};
			/**
			 * 丢弃无法精确表示的钱包条目（并在控制台报一次），让渲染层只处理可信数据。
			 * @param wallets - Remote 返回的钱包数组。
			 * @param kind - 诊断用的钱包种类。
			 * @returns 只含可精确表示金额的数组。
			 */
			const usableWallets = (wallets, kind) => {
				const list = Array.isArray(wallets) ? wallets : [];
				const usable = [];
				for (const wallet of list) {
					if (wallet === void 0 || wallet === null) continue;
					if (parseAmount(wallet.balance) === null) {
						diagnostics.amountUnreadable(wallet.currency, kind);
						continue;
					}
					usable.push(wallet);
				}
				return usable;
			};
			/**
			 * 一个同步周期：登录态 → 余额 → 快照。并发调用复用同一次请求；没有订阅者
			 * 或处于后台标签页时直接返回，不打扰 Host。
			 * @param options - userInitiated 为真时立即给出“正在刷新”反馈。
			 * @returns 本次（或进行中的）同步任务。
			 */
			const sync = (options) => {
				const userInitiated = options !== void 0 && options.userInitiated === true;
				const markPending = () => {
					if (!userInitiated) return;
					const current = store.getSnapshot();
					if (!current.pending) store.publish({
						...current,
						pending: true
					});
				};
				if (inflight !== void 0) {
					markPending();
					return inflight;
				}
				if (!store.active() || isHidden()) return Promise.resolve();
				const startedAt = generation;
				if (userInitiated) markPending();
				else {
					const current = store.getSnapshot();
					if (current.phase === "idle") store.publish({
						...current,
						phase: "loading"
					});
				}
				const task = (async () => {
					const status = await readStatus();
					if (startedAt !== generation) return;
					if (status !== void 0) signedIn = status;
					if (signedIn === false) {
						store.publish({
							phase: "signed-out",
							signedIn: false,
							wallets: [],
							bonusWallets: [],
							updatedAt: null,
							pending: false
						});
						return;
					}
					let balance;
					try {
						balance = await readBalance();
					} catch (error) {
						if (startedAt !== generation) return;
						diagnostics.readFailed(error);
						const latest = store.getSnapshot();
						store.publish({
							...latest,
							phase: latest.wallets.length > 0 ? "ready" : "failed",
							signedIn,
							pending: false
						});
						return;
					}
					diagnostics.readSucceeded();
					if (startedAt !== generation) return;
					if (balance === void 0 || balance === null) {
						// null 是权威的“没有账号授权”：登录态就此确定为否
						signedIn = false;
						store.publish({
							phase: "signed-out",
							signedIn: false,
							wallets: [],
							bonusWallets: [],
							updatedAt: null,
							pending: false
						});
						return;
					}
					if (balance.status !== "ready") {
						const latest = store.getSnapshot();
						store.publish({
							...latest,
							phase: latest.wallets.length > 0 ? "ready" : "failed",
							signedIn,
							pending: false
						});
						return;
					}
					signedIn = true;
					store.publish({
						phase: "ready",
						signedIn: true,
						wallets: usableWallets(balance.value, "recharge"),
						bonusWallets: usableWallets(balance.bonusWallets, "bonus"),
						updatedAt: Date.now(),
						pending: false
					});
				})();
				inflight = task;
				task.then(() => {
					if (inflight === task) inflight = void 0;
				}, () => {
					if (inflight === task) inflight = void 0;
				});
				return task;
			};
			ctx.effect(() => {
				const timer = setInterval(() => {
					void sync();
				}, REFRESH_MS);
				const onVisible = () => {
					if (!isHidden()) void sync();
				};
				if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
				return () => {
					clearInterval(timer);
					if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
					generation++;
					inflight = void 0;
				};
			}, "account-balance: refresh loop");
			ctx.effect(() => {
				if (typeof ctx.remote.$stream !== "function") return;
				let stream;
				try {
					stream = ctx.remote.$stream({
						name: "account",
						open: (signal) => ctx.remote.account.watch(signal),
						ended: () => new Error("account stream ended")
					});
				} catch (error) {
					diagnostics.streamFailed(error);
					return;
				}
				(async () => {
					for await (const frame of stream) {
						const status = frame !== void 0 && frame !== null && frame.value !== void 0 && frame.value !== null ? frame.value.status : void 0;
						try {
							frame.accept();
						} catch (_error) {}
						if (status === "credential-stored") {
							signedIn = true;
							void sync();
							continue;
						}
						if (status === "signed-out") {
							signedIn = false;
							if (store.getSnapshot().phase !== "signed-out") store.publish({
								phase: "signed-out",
								signedIn: false,
								wallets: [],
								bonusWallets: [],
								updatedAt: null,
								pending: false
							});
							continue;
						}
						// 认不出的帧既不清空余额也不触发读取：不确定时保持现状，只记账
						diagnostics.unknownStatus(status);
					}
				})().catch((error) => {
					diagnostics.streamFailed(error);
				});
				return () => {
					void stream.dispose();
				};
			}, "account-balance: account state stream");
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "account-balance",
				order: 10,
				locale: NS,
				inject: () => ({
					hooks: { accountBalance: store },
					refresh: () => {
						void sync({ userInitiated: true });
					}
				})
			}, AccountBalancePill));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
