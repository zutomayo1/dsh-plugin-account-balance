//#region lib/index.js
/**
 * 会话状态行余额插件（Host 半侧）。
 *
 * 这是一个纯 UI 插件：空 apply 的存在只为让该包作为 Loader 条目出现在 profile
 * 的插件树中；浏览器半侧由 exports["./client"] 提供，经 package.json 的
 * dsh.client 声明被 dsh-client-modules 扫描并作为 /plugins bundle 下发。
 *
 * 余额数据来自既有的 Host 服务 `ctx.deepseekAccount`：客户端通过
 * `ctx.remote.account.getBalance()`（由 @deepseek-ai/dsh-api-account-controller
 * 暴露的 Remote 命名空间）读取，本包不自行持有任何凭据，也不发起到 Platform 的请求。
 */

/** Host 插件体——该界面插件没有任何 Host 侧行为。 */
function apply() {}
//#endregion

export { apply };
