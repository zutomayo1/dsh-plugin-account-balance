# dsh-plugin-account-balance

中文 | [English](README.en.md)

在会话 composer 的状态行里显示已登录 DeepSeek 账号的余额。

状态行就是截图里这一行——`3 轮 190 步 · 294 tok/s　26.7M tok · 缓存命中 99.7%　◔23%`。
它是 `@deepseek-ai/dsh-client-ui-conversation` 的 composer dock（slot
`conversation.composer.dock`）：统计组由 `@deepseek-ai/dsh-client-ui-chat` 以
`id: "stats"`、`order: 0` 注册，尾部的 23% 圆环是同一个 dock 里的 `ContextMeter`。
本插件以 `id: "account-balance"`、`order: 10` 注册到同一 slot，于是余额落在统计组
之后、上下文圆环之前，样式与统计 pill 一致（同字号、同留白、同
`--dsw-alias-label-tertiary` 颜色），悬停浮层用产品的 `Tooltip` 基元。

```text
  3 轮 190 步 · 294 tok/s   26.7M tok · 缓存命中 99.7%   🪙 余额 ¥5.36   ◔23%
                                                         └─ 本插件
```

## 它显示什么

| 账号状态 | 状态行表现 |
|---|---|
| 已登录、读到余额 | 每个出现的币种一枚 pill（`余额 ¥5.36` / `余额 $1.50`），跨币种绝不求和；悬停显示该币种的明细：`充值余额 ¥5.36` / `赠送余额 ¥3.00`（为 0 的赠送钱包不显示）/ `更新于 14:32` / `点击刷新` |
| 未登录（或只有 API Key） | 什么都不渲染，不占位、不闪烁；也不再请求 Platform |
| 读取失败、已知已登录 | `余额不可用`，悬停提示 `点击重试` |
| 读取失败、登录态未知 | **不报错**，保持静默并在控制台留一条诊断 |
| 读取失败、此前读到过 | 保留上一次的数额（悬停的 `更新于` 说明它有多旧） |
| 点击 pill | 立即重读，期间 `aria-busy` 且文案变淡，悬停显示 `正在刷新…` |

金额规则与「设置 → 账号」页一致：向下取整到两位、不足一分显示 `<$0.01`、零显示
`¥0.00`、负数显示 `-¥0.01`。实现是**字符串十进制**（不经过浮点），因此
`1234567890123456789012` 这类超长整数也能精确显示，不会漏出 `e+21` 或 `NaN`。

## 数据从哪来

插件自己不碰凭据、也不直接请求 Platform，而是走 DSH 已有的 Host 服务：

```text
浏览器插件  ctx.remote.account.getState()
            ctx.remote.account.getBalance({version, locale, timezoneOffsetSeconds})
      │  Remote（@deepseek-ai/dsh-api-account-controller，命名空间 account）
      ▼
Host 服务   ctx.deepseekAccount.getState() / getBalance(client)
      │  GET {platformOrigin}/api/v0/users/get_user_summary  ← x-dsh-auth-token
      ▼
Platform    { normal_wallets: [{currency, balance}], bonus_wallets: [...] }
```

- `null` 是权威的"没有账号授权"：插件据此把登录态定为否，之后不再请求 Platform。
- `getState()` 是本地 Host 调用（不触达 Platform），每个周期都读，用来决定"要不要
  读余额"以及"失败时该不该报错"。
- **按需取数**：没有订阅者（没有活动会话、pill 未挂载）或标签页在后台时，一个请求
  都不发；第一个订阅者出现、窗口重新可见、账号状态流推进时立刻同步。
- 刷新节奏：挂载时一次、每 60 秒一次、重新可见时一次、账号状态流每次推进时一次；
  并发调用合并为一次。

## 已知限制

- **只覆盖平台账号余额**（`platform.deepseek.com` 的充值/赠送钱包）。只用 API Key
  的部署没有对应的 Host 读法，pill 保持隐藏——这是当前 DSH 的能力边界，不是本插件的
  缺陷。
- **依赖 `remote.account`**：装配里缺少 `@deepseek-ai/dsh-api-account-controller` 或
  `@deepseek-ai/dsh-api-remotes` 时 `inject` 不满足，插件不激活（不报错）。
- **只注册新行**：`conversation.composer.dock` 是 `kind: list`、`replaceRisk: none`
  的扩展位，新 id 只会被加在既有条目旁边。
- **状态流断开后不重连**：只记一条诊断并退回定时读取；登录态转变最多晚一个周期。
- **负数分支与设置页差 0.01**：官方实现对负数走 big.js `toFixed`（四舍五入），本插件
  统一向下取整。负数余额实际不可达，这里选择单一规则。
- **整数位超过 30 位即判为不可渲染**：该钱包被跳过并记一条诊断，避免为荒谬取值分配
  巨大字符串。

## 调参

`lib/client.js` 的常量可以通过页面注入的接缝覆盖，不必改 bundle：

```js
window.__DSH_ACCOUNT_BALANCE_CONFIG__ = { refreshMs: 30000, clientVersion: "0.1.7-rc.2" };
```

- `refreshMs`：轮询间隔，下限 5000，默认 60000；
- `clientVersion`：作为 `AccountClientMetadata.version` 上报 Platform。产品包在打包期
  把 `DSH_CLIENT_VERSION` 内联进各自的 bundle，手写 bundle 没有这一步，所以本插件按
  `globalThis.__DSH_CLIENT_VERSION__` → 该接缝 → 兜底常量 依次取值。

> **为什么不做成正式 Config**：客户端插件拿不到自己的 Loader config（`apply` 只收到
> `ctx`），正式路径是 Host 侧导出 `Config` schema + 客户端 `ctx.configForms.get(ns)`
> （ui-chat 的 `performanceUsage` 就是这么读的：`getSnapshot().value`）。这条路径要求
> 本包引入 `@deepseek-ai/schemastery` 依赖并声明 DSH peer，而 DSH 的启动检查会因为
> **不兼容的 peer 声明直接跳过整个组合包**——为了两个常量换来"升级后可能被静默跳过"
> 的风险不划算，因此这里选了零依赖的显式接缝。

## 目录结构

| 路径 | 作用 |
|---|---|
| `package.json` | 包身份、`dsh.client`（Web 半侧声明：`platform` + 需要先加载的提供方）、`dsh.bundle.patch`（组合包 patch 声明） |
| `lib/index.js` | Host 半侧：空 `apply`，只为让插件作为 Loader 条目存在 |
| `lib/client.js` | 浏览器半侧：已构建的 bundle，**无需构建工具链** |
| `lib/types/**` | 插件自己拥有的类型面（调参接缝、服务 inject、apply） |
| `cordis.patch.yml` | 组合包 patch 层：`insert` 本插件自己的 Loader 行 |
| `install.ps1` / `uninstall.ps1` | 手工安装 / 卸载（不依赖 pnpm）；安装前会先跑冒烟测试，卸载在组合包安装时会拒绝执行 |
| `test/smoke.cjs` | 离线冒烟测试：在 vm 里执行 bundle，54 条断言覆盖模块形态、渲染矩阵、金额边界、按需取数与诊断 |
| `tools/probe-balance.mjs` | 只读诊断：直接向 Platform 读一次余额（需显式 `--allow-credential-read`；只打印状态与钱包，绝不打印凭据） |

## 为什么 `lib/client.js` 是手写产物

`@deepseek-ai/dsh-client-modules` 只认已构建的客户端 bundle：宿主扫描 Loader 条目
对应包的 `dsh.client` 声明，把 `./client` 导出作为 `/plugins` 下的 bundle 下发。
随产品发布的插件由 tsdown 产出该文件，其形态就是一个自包含的 CJS factory：

```js
window.__ModuleLoader__.load({
  id: "<包名>",
  factory: (require) => { /* … */ return module.exports; },
});
```

本插件因此直接手写这个 bundle，只 `require("react")` 与
`@deepseek-ai/dsh-client-ui-primitives`（两者都在外壳的静态模块表里，无需任何
`dsh.client.external` 声明），不引入构建链依赖。代价是：没有 TS 源码、sourcemap 与
类型检查，语法/require 错误只在页面加载时暴露——所以 `install.ps1` 会先跑
`test/smoke.cjs`，页面加载失败也会被客户端模块系统记为该条目的导入失败。

## 安装 / 卸载

本包是**组合包（bundle）**：`dsh.bundle.patch` 指向 `cordis.patch.yml`，该 patch 层用
`insert:` 插入自己的 Loader 行。

```powershell
# 安装（推荐：写 profile 清单并立即重新组合）
#   工具   plugin_manager install_bundle  target = 本目录绝对路径
#   CLI    dsh plugin --profile desktop add <本目录绝对路径>
#          dsh plugin --profile desktop add https://github.com/zutomayo1/dsh-plugin-account-balance

# 卸载 / 停用
#   工具   plugin_manager remove_bundle / set_bundle(enabled: false)
#   CLI    dsh plugin --profile desktop remove dsh-plugin-account-balance
```

`dsh plugin` 只自己解析 `version-exemptions`、`allow-version`、`revoke-version` 三个子命令，
其余参数**原样交给 profile 目录里的 pnpm**，所以安装动词是 pnpm 的 `add`。用 git 地址安装时
pnpm 会抓取仓库并执行包的构建脚本；本包没有依赖也没有 `prepare` 脚本，因此不该出现待授权项——
若 pnpm 仍然打印了一个待授权的键，按提示加进 profile 的 `pnpm-workspace.yaml` 的
`allowBuilds` 再重跑。

安装后 `<profile>/node_modules/dsh-plugin-account-balance` 是指向本目录的符号链接，
**改这里的文件就是改已安装的插件**；客户端 bundle 变更后刷新页面（或等客户端 HMR）。

不用 pnpm 的手工安装：`powershell -ExecutionPolicy Bypass -File .\install.ps1`
（先跑冒烟测试，再复制到 `<profile>/node_modules`，并在 profile 的 `cordis.patch.yml`
追加一条 `insert` 行），`.\uninstall.ps1` 反向收拾。两个脚本：

- 是 **UTF-8 with BOM**，所以 Windows PowerShell 5.1 也能正确解析其中的中文（5.1 会把
  无 BOM 的 UTF-8 当 ANSI，中文随即变成乱码并导致解析失败）；
- 写回 `cordis.patch.yml` 时用**不带 BOM 的 UTF-8**（`.NET WriteAllText` + `UTF8Encoding($false)`），
  不给 YAML 引入 BOM；
- 写进 patch 的注释是 **ASCII**：这个文件用户会手工编辑，而很多 Windows 编辑器默认按
  ANSI 打开，中文注释在那里就是乱码；
- `uninstall.ps1` 检测到组合包方式安装时会**拒绝执行**并指向管理器——手工删掉
  `node_modules` 链接只会让 profile 停在"已选择但装不上"的坏状态。

### 两个必须知道的坑

1. **新增行必须写在 `insert:` 之下。** patch 里顶层的 `- id: <new>` 是"按 id 覆盖
   已有行"的形式；目标行不存在时该条会被丢弃（只在 stderr 打印一条警告，配置不变），
   看起来就像插件根本没装。正确写法：

   ```yaml
   - insert:
       - id: account-balance
         name: dsh-plugin-account-balance
   ```

2. **profile 的 `cordis.patch.yml` 手工改不实时生效。** 本机实测：改这个文件不会让新
   行挂载（改完 `list_plugins` 仍是旧树），而插件管理器的安装/启停会立即重新组合
   （返回 `"application": "applied"`，`list_plugins` 立刻出现 `include:account-balance`）。
   优先走管理器的路径。

## 验证

```powershell
node test/smoke.cjs                                  # 54 条断言，离线
node tools/probe-balance.mjs --allow-credential-read # 端到端确认数据源
```

排障顺序：

1. 状态行没有 pill → 先看 pill 是否该出现（未登录/API Key 部署本来就不显示）；
2. 控制台 `[account-balance]` 前缀的诊断会说明是状态读取失败、状态流结束、还是金额
   不可解析；
3. 仍然没头绪 → 跑 `probe-balance.mjs` 确认账号本身能读到余额。
