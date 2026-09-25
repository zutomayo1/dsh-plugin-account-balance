/**
 * 会话状态行余额插件（浏览器半侧）的对外契约。
 *
 * lib/client.js 是已构建的 bundle（window.__ModuleLoader__.load({ id, factory })），
 * 这里声明的是插件自己拥有的接口，不重复框架类型：服务的就绪由模块导出的 inject
 * 数组声明，组件渲染由 slot 注册完成。
 */

/** 部署方可选的调参接缝：页面注入 window.__DSH_ACCOUNT_BALANCE_CONFIG__。 */
export interface AccountBalanceConfig {
  /** 轮询间隔（毫秒，下限 5000）；默认 60000。 */
  readonly refreshMs?: number;
  /** 上报给 Platform 的 AccountClientMetadata.version；默认 bundle 内的兜底常量。 */
  readonly clientVersion?: string;
}

declare global {
  /** 部署方注入的调参接缝（见 README「调参」）。 */
  var __DSH_ACCOUNT_BALANCE_CONFIG__: AccountBalanceConfig | undefined;
  /** 若外壳将来暴露客户端构建版本，本插件优先使用它。 */
  var __DSH_CLIENT_VERSION__: string | undefined;
}

/** 必需的客户端服务：slot 注册表、locale 字典、Remote 服务及其 account 命名空间。 */
export declare const inject: readonly ['slots', 'locale', 'remote', 'remote.account'];

/**
 * 客户端插件体：注册字典与账号状态流/定时同步，并把余额 pill 注册进
 * conversation.composer.dock（id: "account-balance"，order: 10）。
 * @param ctx - 客户端根上下文（由客户端模块系统注入）。
 */
export declare function apply(ctx: unknown): void;
