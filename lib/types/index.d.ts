/**
 * 会话状态行余额插件（Host 半侧）的类型面。
 *
 * 该半侧是纯 UI 插件：空 apply 只为让本包作为 Loader 条目出现在 profile 的插件
 * 树中；浏览器半侧由 exports["./client"] 提供，经 package.json 的 dsh.client
 * 声明被 @deepseek-ai/dsh-client-modules 扫描并作为 /plugins bundle 下发。
 * 余额数据全部来自既有的 Host 服务，本包不持有凭据、不直接请求 Platform。
 */

/** Host 插件体：没有任何 Host 侧行为。 */
export declare function apply(): void;
