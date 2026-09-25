# dsh-plugin-account-balance

English | [中文](README.zh.md)

Shows the signed-in DeepSeek account balance in the DeepSeek Harness (DSH) conversation
status row.

That row is the one under the composer — `3 turns 190 steps · 294 tok/s　26.7M tok · cache hit 99.7%　◔23%`.
It is the composer dock of `@deepseek-ai/dsh-client-ui-conversation` (slot
`conversation.composer.dock`): `@deepseek-ai/dsh-client-ui-chat` registers the stats group
there as `id: "stats"`, `order: 0`, and the trailing 23% ring is that same dock's
`ContextMeter`. This plugin registers into the same slot as `id: "account-balance"`,
`order: 10`, so the balance lands after the stats group and before the context ring, with
the same typography, padding and `--dsw-alias-label-tertiary` color as the shipped pills;
its hover panel is the product's own `Tooltip` primitive.

```text
  3 turns 190 steps · 294 tok/s   26.7M tok · cache hit 99.7%   🪙 Balance ¥5.36   ◔23%
                                                                └─ this plugin
```

## What it shows

| Account state | What the status row does |
|---|---|
| Signed in, balance read | One pill per currency that exists (`Balance ¥5.36`, `Balance $1.50`); currencies are never summed together. Hover shows that currency's detail: `Recharge balance ¥5.36`, `Bonus balance ¥3.00` (zero bonus wallets are omitted), `Updated 14:32`, `Click to refresh` |
| Not signed in (or API key only) | Renders nothing at all — no placeholder, no flicker, and no further Platform requests |
| Read failed, known signed in | `Balance unavailable`, hover says `Click to retry` |
| Read failed, sign-in state unknown | **No error**: stays silent and leaves one console diagnostic |
| Read failed, but read succeeded before | Keeps the last known amount (the hover `Updated …` says how old it is) |
| Click the pill | Re-reads immediately with `aria-busy` and a dimmed label, hover says `Refreshing…` |

Amounts follow the same rules as the product's Settings → Account page: truncated to two
decimals, sub-cent values render as `<$0.01`, zero as `¥0.00`, negatives as `-¥0.01`. The
implementation is **string decimal arithmetic** (no floats), so a 22-digit balance still
renders exactly instead of leaking `e+21` or `NaN`.

## Where the data comes from

The plugin never touches credentials and never calls the Platform itself — it goes through
the Host service DSH already has:

```text
browser plugin  ctx.remote.account.getState()
                ctx.remote.account.getBalance({version, locale, timezoneOffsetSeconds})
      │  Remote (@deepseek-ai/dsh-api-account-controller, namespace `account`)
      ▼
Host service    ctx.deepseekAccount.getState() / getBalance(client)
      │  GET {platformOrigin}/api/v0/users/get_user_summary  ← x-dsh-auth-token
      ▼
Platform        { normal_wallets: [{currency, balance}], bonus_wallets: [...] }
```

- `null` is the authoritative "no account grant": the plugin takes it as signed out and
  stops asking the Platform.
- `getState()` is a local Host call (it never reaches the Platform). It is read every cycle
  to decide *whether to read the balance at all* and *whether a failure may be shown*.
- **On demand**: with no subscribers (no active session, pill not mounted) or a hidden tab,
  not a single request is made. The first subscriber, the window becoming visible again, or
  an account-state transition triggers a sync.
- Cadence: once on mount, every 60s, on becoming visible, and on every account-state frame;
  concurrent calls collapse into one request.

## Known limitations

- **Platform account balance only** (the recharge/bonus wallets of
  `platform.deepseek.com`). An API-key-only setup has no Host read for its balance, so the
  pill stays hidden — that is a current DSH boundary, not a plugin defect.
- **Requires `remote.account`**: without `@deepseek-ai/dsh-api-account-controller` or
  `@deepseek-ai/dsh-api-remotes` the `inject` list is unsatisfied and the plugin simply does
  not activate (no error).
- **Additive only**: `conversation.composer.dock` is a `kind: list`, `replaceRisk: none`
  seat; a fresh id is appended beside the shipped entries.
- **No stream reconnect**: a closed account stream logs one diagnostic and falls back to the
  timer, so a sign-in/out transition can lag by up to one cycle.
- **Negatives differ by one cent from Settings**: the official code runs big.js `toFixed`
  (half-up) for negatives while this plugin truncates consistently. Negative balances are
  unreachable in practice; one rule was chosen over two.
- **Integers beyond 30 digits are treated as unrenderable**: that wallet is skipped with one
  diagnostic instead of allocating an absurd string.

## Configuration

The constants in `lib/client.js` can be overridden through a page-injected seam, without
editing the bundle:

```js
window.__DSH_ACCOUNT_BALANCE_CONFIG__ = { refreshMs: 30000, clientVersion: "0.1.7-rc.2" };
```

- `refreshMs` — poll interval, floor 5000, default 60000.
- `clientVersion` — reported to the Platform as `AccountClientMetadata.version`. Shipped
  plugins inline `DSH_CLIENT_VERSION` into their bundle at build time; a hand-written bundle
  has no such step, so this plugin resolves the value as
  `globalThis.__DSH_CLIENT_VERSION__` → this seam → built-in fallback.

> **Why not a real Config schema**: a client plugin does not receive its own Loader config
> (`apply` only gets `ctx`); the official route is a Host-side `Config` schema plus
> `ctx.configForms.get(ns)` on the client (that is how ui-chat reads `performanceUsage`:
> `getSnapshot().value`). Taking that route would require adding an
> `@deepseek-ai/schemastery` dependency and a DSH peer declaration, and DSH's startup check
> **skips an entire bundle whose declared peer is incompatible** — trading a silent skip
> after a DSH upgrade for two tunable constants is a bad deal, so this plugin uses a
> zero-dependency explicit seam instead.

## Layout

| Path | Purpose |
|---|---|
| `package.json` | Package identity, `dsh.client` (web-half declaration: `platform` plus the providers to load first), `dsh.bundle.patch` |
| `lib/index.js` | Host half: an empty `apply` that exists so the package is a Loader row |
| `lib/client.js` | Browser half: the built bundle, **no toolchain required** |
| `lib/types/**` | The type surface this plugin owns (config seam, service inject, apply) |
| `cordis.patch.yml` | Bundle patch layer: `insert`s this plugin's own Loader row |
| `install.ps1` / `uninstall.ps1` | Manual install / uninstall (no pnpm). Install runs the smoke test first; uninstall refuses on a bundle-managed install |
| `test/smoke.cjs` | Offline smoke test: executes the bundle in a vm, 54 assertions over module shape, render matrix, amount edges, on-demand fetching and diagnostics |
| `tools/probe-balance.mjs` | Read-only diagnostic: reads the balance straight from the Platform (requires an explicit `--allow-credential-read`; prints status and wallets only, never credentials) |

## Why `lib/client.js` is a hand-written artifact

`@deepseek-ai/dsh-client-modules` only recognizes a built client bundle: the host scans the
`dsh.client` declaration of the package behind a Loader row and serves its `./client` export
as a bundle under `/plugins`. Shipped plugins produce that file with tsdown; its shape is a
self-contained CJS factory:

```js
window.__ModuleLoader__.load({
  id: "<package name>",
  factory: (require) => { /* … */ return module.exports; },
});
```

This plugin therefore writes that bundle by hand and requires only `react` and
`@deepseek-ai/dsh-client-ui-primitives` (both live in the shell's static module table, so no
`dsh.client.external` entry is needed) — no build-chain dependency. The price: no TypeScript
source, no source map, no type checking, and a syntax/require mistake only surfaces when the
page loads. That is why `install.ps1` runs `test/smoke.cjs` first, and why a failed load is
recorded by the client module system as that row's import failure.

## Install / uninstall

This package is a **bundle**: `dsh.bundle.patch` points at `cordis.patch.yml`, whose layer
`insert`s its own Loader row.

```powershell
# Install (recommended: writes the profile manifest and recomposes immediately)
#   tool   plugin_manager install_bundle  target = absolute path to this directory
#   CLI    dsh plugin --profile desktop add <absolute path>
#          dsh plugin --profile desktop add https://github.com/zutomayo1/dsh-plugin-account-balance

# Uninstall / disable
#   tool   plugin_manager remove_bundle / set_bundle(enabled: false)
#   CLI    dsh plugin --profile desktop remove dsh-plugin-account-balance
```

`dsh plugin` hands every argument that is not one of its own subcommands
(`version-exemptions`, `allow-version`, `revoke-version`) straight to pnpm in the profile
directory, so the install verb is pnpm's `add`. Installing from the git URL makes pnpm fetch
the repository and run the package's build scripts; this package has no dependencies and no
`prepare` script, so nothing should need an `allowBuilds` grant — if pnpm prints a key to
allow anyway, add it under `allowBuilds` in the profile's `pnpm-workspace.yaml` and re-run.

After installation `<profile>/node_modules/dsh-plugin-account-balance` is a symlink to this
directory, so **editing files here edits the installed plugin**; refresh the page (or wait
for client HMR) after changing the browser half.

Without pnpm: `powershell -ExecutionPolicy Bypass -File .\install.ps1` runs the smoke test,
copies the package into `<profile>/node_modules` and appends one `insert` row to the
profile's `cordis.patch.yml`; `.\uninstall.ps1` reverses it. Both scripts:

- are **UTF-8 with BOM**, so Windows PowerShell 5.1 parses their Chinese text correctly
  (5.1 reads BOM-less UTF-8 as ANSI, which turns the text into mojibake and fails to parse);
- write `cordis.patch.yml` back as **BOM-less UTF-8** (`.NET WriteAllText` +
  `UTF8Encoding($false)`), never introducing a BOM into YAML;
- write an **ASCII** comment into the patch: that file is edited by hand, and many Windows
  editors open it as ANSI, where Chinese comments are mojibake;
- make `uninstall.ps1` **refuse** on a bundle-managed install and point at the manager —
  deleting the `node_modules` link by hand leaves the profile in a "selected but not
  installable" state.

### Two traps worth knowing

1. **A new row must live under `insert:`.** A top-level `- id: <new>` in a patch is the
   "override the row with this id" form; when no such row exists the entry is dropped (one
   stderr warning, configuration unchanged), which looks exactly like a plugin that never
   installed. The correct form:

   ```yaml
   - insert:
       - id: account-balance
         name: dsh-plugin-account-balance
   ```

2. **Hand-editing a profile's `cordis.patch.yml` is not applied live.** Measured on this
   machine: editing that file does not mount the new row (`list_plugins` still shows the old
   tree), while the plugin manager's install/enable operations recompose immediately
   (`"application": "applied"`, and `list_plugins` shows `include:account-balance` right
   away). Prefer the manager.

## Verification

```powershell
node test/smoke.cjs                                  # 54 assertions, offline
node tools/probe-balance.mjs --allow-credential-read # end-to-end data source check
```

Troubleshooting order:

1. No pill in the status row → first check whether it *should* appear (not signed in, or an
   API-key-only deployment, hides it by design);
2. Console diagnostics prefixed `[account-balance]` say whether the state read failed, the
   state stream ended, or an amount could not be parsed;
3. Still stuck → run `probe-balance.mjs` to confirm the account itself can read a balance.

## License

MIT — see [LICENSE](LICENSE).
