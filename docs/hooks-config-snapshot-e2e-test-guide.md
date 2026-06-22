# src/utils/hooks/hooksConfigSnapshot.ts 黑盒端到端测试说明

本文档通过 CLI settings 和 Hook 执行结果验证 Hook 配置快照策略，重点覆盖普通 settings Hook、非托管禁用、托管优先的可观察行为。

## 1. 验证目标

- `--settings` 中的 Hook 能进入快照并执行。
- 非托管 `disableAllHooks` 会禁用非托管 Hook。
- 快照更新后新 Hook 配置能被读取。
- `--bare` 简化模式会跳过 Hook，作为对照。

## 2. 初始化

```powershell
cd D:\Code\free-code
npm run build

$env:FREE_CODE_CLI = (Resolve-Path .\cli.exe).Path
$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-hooks-config-snapshot-e2e"
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$env:FREE_CODE_E2E_ROOT\project","$env:FREE_CODE_E2E_ROOT\logs","$env:FREE_CODE_E2E_ROOT\hooks" | Out-Null

$Hook = @'
$stdin = [Console]::In.ReadToEnd()
$root = $env:FREE_CODE_E2E_ROOT
$stdin | Add-Content -Path (Join-Path $root "logs\snapshot-hook.ndjson") -Encoding UTF8
[Console]::Out.Write("SNAPSHOT_HOOK_CONTEXT")
'@
Set-Content -Path "$env:FREE_CODE_E2E_ROOT\hooks\hook.ps1" -Value $Hook -Encoding UTF8
$settingsFile = Join-Path $env:FREE_CODE_E2E_ROOT "settings.json"
Set-Location "$env:FREE_CODE_E2E_ROOT\project"
```

## 3. 用例

### 3.1 Hook 正常执行

```powershell
$settings = @{
  hooks = @{
    UserPromptSubmit = @(@{ hooks = @(@{
      type = "command"; shell = "powershell";
      command = "powershell -ExecutionPolicy Bypass -File `"$env:FREE_CODE_E2E_ROOT\hooks\hook.ps1`""
    })})
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8
& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --max-turns 1 -- "只回答 OK"
Test-Path "$env:FREE_CODE_E2E_ROOT\logs\snapshot-hook.ndjson"
```

期望：返回 `True`。

### 3.2 非托管禁用 Hook

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue
$settings.disableAllHooks = $true
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8
& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --max-turns 1 -- "只回答 OK"
Test-Path "$env:FREE_CODE_E2E_ROOT\logs\snapshot-hook.ndjson"
```

期望：返回 `False`。

### 3.3 bare 模式对照

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue
$settings.disableAllHooks = $false
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8
& $env:FREE_CODE_CLI --settings $settingsFile --bare --print --no-session-persistence --max-turns 1 -- "只回答 OK"
Test-Path "$env:FREE_CODE_E2E_ROOT\logs\snapshot-hook.ndjson"
```

期望：返回 `False`。
