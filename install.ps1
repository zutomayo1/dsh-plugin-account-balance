<#
.SYNOPSIS
  手工安装本插件（不依赖 pnpm 与网络），或在检测到"组合包安装"时给出说明。

.DESCRIPTION
  手工安装是两步：
    1. 把本包复制到 <profile>/node_modules/dsh-plugin-account-balance（Node 从
       profile 目录向上解析裸包名即可命中它）；
    2. 在 <profile>/cordis.patch.yml 追加一条 `insert` 条目（幂等）。

  注意：新增行必须写在 `insert:` 之下。顶层的 `- id: <new>` 是"按 id 覆盖已有行"
  的形式，目标行不存在时会被丢弃，看起来就像插件没装。

  若 profile 已通过 plugin_manager / dsh plugin 以组合包方式安装本包（package.json
  里带 link: 依赖且 dsh.profile.bundles 含本包名），本脚本只做检查，不再改动文件。

  本文件是 UTF-8（带 BOM），因此 Windows PowerShell 5.1 也能正确解析其中的中文；
  写回 profile 的 patch 文件时使用不带 BOM 的 UTF-8，避免给 YAML 加 BOM。

.PARAMETER Profile
  profile 名称，默认取 $env:DSH_PROFILE，再退化为 desktop。

.PARAMETER DshHome
  DSH home 目录，默认取 $env:DSH_HOME，再退化为 %USERPROFILE%\.dsh。
#>
[CmdletBinding()]
param(
  [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }),
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' })
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$profileDir = Join-Path $DshHome "profiles\$Profile"
$target = Join-Path $profileDir 'node_modules\dsh-plugin-account-balance'
$patch = Join-Path $profileDir 'cordis.patch.yml'
$manifest = Join-Path $profileDir 'package.json'
$pluginId = 'account-balance'
$packageName = 'dsh-plugin-account-balance'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path $profileDir)) { throw "profile 目录不存在：$profileDir" }

# 0. 部署前先跑离线冒烟测试：bundle 里的语法/require 错误要挡在安装之前
$smoke = Join-Path $source 'test\smoke.cjs'
if (Test-Path $smoke) {
  if (Get-Command node -ErrorAction SilentlyContinue) {
    & node $smoke
    if ($LASTEXITCODE -ne 0) { throw '冒烟测试失败，已中止安装。' }
  } else {
    Write-Warning 'PATH 里没有 node，跳过冒烟测试（bundle 语法错误将只在页面加载时暴露）。'
  }
}

# 1. 已经是组合包安装就不动文件
$managed = $false
if (Test-Path $manifest) {
  $json = Get-Content $manifest -Raw | ConvertFrom-Json
  $declared = $null -ne $json.dependencies -and $null -ne $json.dependencies.$packageName
  $selected = $null -ne $json.dsh.profile.bundles -and @($json.dsh.profile.bundles) -contains $packageName
  $managed = $declared -and $selected
}
if ($managed) {
  Write-Host "$packageName 已由组合包方式安装（package.json 依赖 + dsh.profile.bundles）。"
  Write-Host '无需手工 patch；启用/停用请用 plugin_manager 或 dsh plugin，页面刷新后生效。'
  return
}

# 2. 部署包文件。目标已是链接（pnpm link 安装）时不要覆盖，那会写到源码目录自身。
$existing = Get-Item $target -Force -ErrorAction SilentlyContinue
if ($existing -and $existing.LinkType) {
  Write-Host "目标已是指向 $($existing.Target) 的链接，跳过复制。"
} else {
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  foreach ($item in 'package.json', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE') {
    $from = Join-Path $source $item
    if (Test-Path $from) { Copy-Item $from (Join-Path $target $item) -Force }
  }
  Copy-Item (Join-Path $source 'lib') $target -Recurse -Force
  Write-Host "已部署：$target"
}

# 3. 插入 Loader 行（幂等）
$text = if (Test-Path $patch) { [System.IO.File]::ReadAllText($patch) } else { '' }
if ($text -match "(?m)^\s*-\s*id:\s*$([regex]::Escape($pluginId))\s*$") {
  Write-Host "patch 中已存在插件行 id: $pluginId，跳过。"
} else {
  $entry = @(
    '',
    '# account-balance plugin (dsh-plugin-account-balance): balance pill in the composer status row',
    '- insert:',
    "    - id: $pluginId",
    "      name: $packageName"
  ) -join "`n"
  [System.IO.File]::WriteAllText($patch, $text.TrimEnd() + "`n" + $entry + "`n", $utf8NoBom)
  Write-Host "已写入插件行：$patch"
}

Write-Host ''
Write-Host '完成。优先用 plugin_manager / dsh plugin 的启动路径生效；否则请重启 DSH，再刷新 Web 页面。'
