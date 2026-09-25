<#
.SYNOPSIS
  卸载本插件：移除 profile cordis.patch.yml 里的手工 insert 行，并删除手工部署的包目录。

.DESCRIPTION
  组合包方式安装的包不在这里处理——那需要同时改 profile 的 package.json 依赖与
  dsh.profile.bundles 选择，交给插件管理器更安全：

    plugin_manager remove_bundle  target = dsh-plugin-account-balance
    dsh plugin --profile desktop remove dsh-plugin-account-balance

  本脚本只收拾手工安装留下的两处痕迹：patch 里的 insert 行与 node_modules 下的副本。
  指向源码目录的链接只删除链接本身。

  本文件是 UTF-8（带 BOM），因此 Windows PowerShell 5.1 也能正确解析其中的中文；
  写回 profile 的 patch 文件时使用不带 BOM 的 UTF-8。
#>
[CmdletBinding()]
param(
  [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }),
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' })
)

$ErrorActionPreference = 'Stop'
$profileDir = Join-Path $DshHome "profiles\$Profile"
$target = Join-Path $profileDir 'node_modules\dsh-plugin-account-balance'
$patch = Join-Path $profileDir 'cordis.patch.yml'
$manifest = Join-Path $profileDir 'package.json'
$pluginId = 'account-balance'
$packageName = 'dsh-plugin-account-balance'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# 组合包方式安装的包不能在这里删：手工删掉 node_modules 链接只会让 profile 停在
# "已选择但装不上"的坏状态。
if (Test-Path $manifest) {
  $json = Get-Content $manifest -Raw | ConvertFrom-Json
  $declared = $null -ne $json.dependencies -and $null -ne $json.dependencies.$packageName
  $selected = $null -ne $json.dsh.profile.bundles -and @($json.dsh.profile.bundles) -contains $packageName
  if ($declared -or $selected) {
    Write-Host "$packageName 是组合包方式安装的（package.json 依赖 / dsh.profile.bundles）。"
    Write-Host '请用它自己的移除路径，本脚本不会改动 profile 清单：'
    Write-Host "  plugin_manager remove_bundle  target = $packageName"
    Write-Host "  dsh plugin --profile $Profile remove $packageName"
    return
  }
}

if (Test-Path $patch) {
  $lines = [System.IO.File]::ReadAllText($patch) -split "`n"
  $kept = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*-\s*id:\s*$([regex]::Escape($pluginId))\s*$") {
      # 先吞掉承载它的 `- insert:`，再吞掉其上的注释与多余空行，最后吞掉紧随的 name 行
      if ($kept.Count -gt 0 -and $kept[$kept.Count - 1] -match '^\s*-\s*insert:\s*$') { $kept.RemoveAt($kept.Count - 1) }
      while ($kept.Count -gt 0 -and $kept[$kept.Count - 1] -match '^\s*#') { $kept.RemoveAt($kept.Count - 1) }
      while ($kept.Count -gt 1 -and $kept[$kept.Count - 1].Trim() -eq '' -and $kept[$kept.Count - 2].Trim() -eq '') { $kept.RemoveAt($kept.Count - 1) }
      if ($i + 1 -lt $lines.Count -and $lines[$i + 1] -match '^\s*name:\s*') { $i++ }
      continue
    }
    $kept.Add($lines[$i])
  }
  [System.IO.File]::WriteAllText($patch, ($kept -join "`n"), $utf8NoBom)
  Write-Host "已从 patch 移除插件行：$patch"
}

$existing = Get-Item $target -Force -ErrorAction SilentlyContinue
if ($existing) {
  if ($existing.LinkType) {
    # 只删链接，不动它指向的源码目录
    $existing.Delete()
    Write-Host "已删除链接：$target"
  } else {
    Remove-Item $target -Recurse -Force
    Write-Host "已删除：$target"
  }
}
Write-Host '卸载完成；用插件管理器的启停路径或重启 DSH 后生效。'
