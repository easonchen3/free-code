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

## 4. 人工复核与不可自动化边界

本文件通过 CLI 验证 Hook 配置快照策略。自动命令能覆盖普通启用、非托管禁用和 `--bare`；人工复核用于确认托管策略、插件专用策略和配置缓存刷新在真实配置来源中生效。

人工操作：

1. 执行第 3 节全部命令，记录三个 `Test-Path` 结果。
2. 打开 `D:\tmp\free-code-hooks-config-snapshot-e2e\logs`，确认：
   - 普通启用时存在 `snapshot-hook.ndjson`。
   - 非托管 `disableAllHooks` 时日志不存在。
   - `--bare` 时日志不存在。
3. 人工复核配置缓存刷新：

   ```powershell
   Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue
   $settings.disableAllHooks = $false
   $settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8
   & $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --max-turns 1 -- "只回答 OK"
   Test-Path "$env:FREE_CODE_E2E_ROOT\logs\snapshot-hook.ndjson"

   Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue
   $settings.disableAllHooks = $true
   $settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8
   & $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --max-turns 1 -- "只回答 OK"
   Test-Path "$env:FREE_CODE_E2E_ROOT\logs\snapshot-hook.ndjson"
   ```

4. 如果环境支持托管配置，使用真实 managed settings 分别设置：
   - `disableAllHooks = true`
   - `allowManagedHooksOnly = true`
   然后重复普通启用命令，记录 Hook 是否被允许。

通过标准：

- 普通配置启用 Hook。
- 非托管禁用和 `--bare` 都阻止 Hook 执行。
- 修改 settings 后再次运行能反映最新配置，不复用旧快照。

不可自动化边界：

- 托管策略来源通常依赖企业或本机 managed settings 路径，默认临时脚本不能可靠写入；需要人工在目标环境配置并保存证据。
- 插件专用策略需要真实插件注册通道，不能只靠普通 settings 文件模拟。

### 3.3 bare 模式对照

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue
$settings.disableAllHooks = $false
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8
& $env:FREE_CODE_CLI --settings $settingsFile --bare --print --no-session-persistence --max-turns 1 -- "只回答 OK"
Test-Path "$env:FREE_CODE_E2E_ROOT\logs\snapshot-hook.ndjson"
```

期望：返回 `False`。
