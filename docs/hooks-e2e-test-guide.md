# src/utils/hooks.ts 功能说明与黑盒端到端测试指导

本文档面向执行端到端验证的 agent，说明如何只通过 CLI、配置文件、Hook 脚本和本地 HTTP 服务验证 `src/utils/hooks.ts` 的主要黑盒分支。

约束：
- 不切换 Git 分支。
- 不新增单元测试或临时 `*.test.ts` 文件。
- 所有测试数据写入 `D:\tmp\free-code-hooks-e2e`。
- Hook 配置通过 `--settings $settingsFile` 显式传给 CLI，避免污染仓库或用户默认配置。
- 默认使用当前机器已经登录的 CLI 配置；不要临时指定一个空的 `CLAUDE_CONFIG_DIR`，否则 `--print` 可能报 `Not logged in`。
- `--print` 命令统一使用 `--no-session-persistence`，避免把测试会话写入历史记录。
- 交互式用例需要 agent 明确记录输入、可见输出和生成的日志文件，不要只记录主观判断。

## 1. 文件功能说明

`src/utils/hooks.ts` 是 free-code 的 Hook 执行中枢。用户在 settings、插件、技能或会话中配置的 Hook，会在工具调用、提示提交、会话生命周期、压缩、权限、工作区变化、状态栏和文件建议等事件上被匹配并执行。

主要能力：

1. 生成 Hook 输入：为不同事件补充 `session_id`、`cwd`、`transcript_path`、`permission_mode`、工具名、工具参数、工具结果等上下文。
2. 匹配 Hook：按事件名、matcher、正则、管道分隔列表、旧工具名兼容和 `if` 条件筛选要执行的 Hook。
3. 执行 Hook：支持 `command`、`http`、`prompt`、`agent`、`callback`、`function` 等类型，其中 settings 文件可直接覆盖 `command`、`http`、`prompt`、`agent`。
4. 解析结果：兼容纯文本输出、同步 JSON 输出、异步 JSON 输出、退出码 2 阻断、非 0 退出码提示、非法 JSON 和事件专属输出。
5. 汇总副作用：把 Hook 的消息、阻断原因、工具输入修改、工具输出修改、权限决策、系统消息、监听路径和 elicitation 响应合并给上层。
6. 执行 REPL 外 Hook：支持 `Notification`、`SessionEnd`、`PreCompact`、`PostCompact`、`ConfigChange`、`InstructionsLoaded`、`CwdChanged`、`FileChanged`、`WorktreeCreate`、`WorktreeRemove` 等不依赖普通工具循环的事件。
7. 执行状态栏和文件建议命令：通过独立配置驱动状态栏文本和文件补全候选。

## 2. 黑盒覆盖矩阵

| 分支类别 | 需要覆盖的行为 | 对应用例 |
| --- | --- | --- |
| 配置加载 | settings 中的 `hooks`、`statusLine`、`fileSuggestion` 被读取 | 用例 1、14、15 |
| matcher | 空 matcher、精确匹配、管道列表、正则、非法正则、旧工具名兼容 | 用例 2、3 |
| `if` 条件 | 条件命中、条件不命中、非工具事件无法评估条件 | 用例 4、13 |
| command Hook | 纯文本成功、退出码 1、退出码 2、超时、PowerShell shell | 用例 5、6、7 |
| JSON 解析 | 同步 JSON、非法 JSON、事件名不匹配、`suppressOutput`、`continue:false` | 用例 8、9 |
| 事件专属输出 | `PreToolUse` 修改输入、阻断工具；`PostToolUse` 修改输出；`UserPromptSubmit` 增加上下文 | 用例 10、11、12 |
| 异步 Hook | 配置 `async:true`、stdout 首行 `{ "async": true }`、`asyncRewake` | 用例 16 |
| HTTP Hook | 2xx JSON、2xx 非 JSON、非 2xx、环境变量 header、异步响应 | 用例 17 |
| REPL 外事件 | SessionStart、Setup、SessionEnd、PreCompact、PostCompact、ConfigChange | 用例 18、19 |
| 环境事件 | InstructionsLoaded、CwdChanged、FileChanged 的系统消息和 watchPaths | 用例 20 |
| 权限事件 | PermissionRequest、PermissionDenied 的允许、拒绝、重试 | 用例 21 |
| 工作树事件 | WorktreeCreate 返回路径、WorktreeRemove 执行清理 | 用例 22 |
| UI 命令 | statusLine、fileSuggestion 命令输出 | 用例 14、15 |
| SDK/会话态分支 | callback、function、prompt、agent、Elicitation、Subagent/Task/Teammate | 用例 23 |

## 3. 公共前置条件

### 3.1 初始化环境

在仓库根目录执行：

```powershell
cd D:\Code\free-code
npm run build

if (!(Test-Path .\cli.exe)) {
  throw "未找到 .\cli.exe，请确认构建是否成功。"
}

$env:FREE_CODE_CLI = (Resolve-Path .\cli.exe).Path
$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-hooks-e2e"
Remove-Item Env:\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue

Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null
New-Item -ItemType Directory -Force "$env:FREE_CODE_E2E_ROOT\hooks" | Out-Null
New-Item -ItemType Directory -Force "$env:FREE_CODE_E2E_ROOT\logs" | Out-Null
New-Item -ItemType Directory -Force "$env:FREE_CODE_E2E_ROOT\project" | Out-Null
New-Item -ItemType Directory -Force "$env:FREE_CODE_E2E_ROOT\http" | Out-Null
New-Item -ItemType Directory -Force "$env:FREE_CODE_E2E_ROOT\worktrees" | Out-Null

$Project = Join-Path $env:FREE_CODE_E2E_ROOT "project"
Set-Location $Project
& $env:FREE_CODE_CLI --version
```

期望输出：
- `npm run build` 成功。
- `$env:FREE_CODE_CLI` 指向当前仓库构建出的 `cli.exe`。
- `$Project` 是空的测试项目目录。
- 所有临时文件都位于 `D:\tmp\free-code-hooks-e2e`。

### 3.2 准备通用测试文件

```powershell
$Project = Join-Path $env:FREE_CODE_E2E_ROOT "project"
New-Item -ItemType Directory -Force "$Project\src" | Out-Null
Set-Content -Path "$Project\src\alpha.txt" -Value "ALPHA_ORIGINAL" -NoNewline -Encoding UTF8
Set-Content -Path "$Project\src\beta.txt" -Value "BETA_ORIGINAL" -NoNewline -Encoding UTF8
Set-Content -Path "$Project\src\script.ps1" -Value "Write-Output 'SCRIPT_OK'" -Encoding UTF8
Set-Location $Project
```

### 3.3 写入通用 Hook 脚本

这些脚本只写入 `D:\tmp`，用于观察 Hook 输入、输出和执行顺序。

```powershell
$HookDir = Join-Path $env:FREE_CODE_E2E_ROOT "hooks"
$LogDir = Join-Path $env:FREE_CODE_E2E_ROOT "logs"

$logger = @'
param(
  [string]$Name = "hook",
  [string]$Stdout = "",
  [int]$ExitCode = 0,
  [int]$SleepMs = 0
)
$root = $env:FREE_CODE_E2E_ROOT
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
$stdin = [Console]::In.ReadToEnd()
$entry = [ordered]@{
  name = $Name
  time = [DateTimeOffset]::Now.ToString("o")
  cwd = (Get-Location).Path
  input = $stdin
}
($entry | ConvertTo-Json -Depth 20 -Compress) | Add-Content -Path (Join-Path $logDir "$Name.ndjson") -Encoding UTF8
if ($SleepMs -gt 0) {
  Start-Sleep -Milliseconds $SleepMs
  "done:$Name" | Add-Content -Path (Join-Path $logDir "async-markers.txt") -Encoding UTF8
}
if ($Stdout.Length -gt 0) {
  [Console]::Out.Write($Stdout)
}
exit $ExitCode
'@
Set-Content -Path "$HookDir\logger.ps1" -Value $logger -Encoding UTF8

$jsonHook = @'
param([string]$Mode)
$stdin = [Console]::In.ReadToEnd()
$root = $env:FREE_CODE_E2E_ROOT
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
$stdin | Add-Content -Path (Join-Path $logDir "json-hook-inputs.ndjson") -Encoding UTF8

switch ($Mode) {
  "user-context" {
    [Console]::Out.Write('{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"HOOK_ADDITIONAL_CONTEXT_OK"}}')
  }
  "pretool-approve" {
    [Console]::Out.Write('{"decision":"approve","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"HOOK_ALLOW_OK"}}')
  }
  "pretool-block" {
    [Console]::Out.Write('{"decision":"block","reason":"HOOK_BLOCKED_BY_JSON"}')
  }
  "pretool-update" {
    [Console]::Out.Write('{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"file_path":"src/beta.txt"}}}')
  }
  "posttool-output" {
    [Console]::Out.Write('{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedMCPToolOutput":"HOOK_REPLACED_TOOL_OUTPUT"}}')
  }
  "continue-false" {
    [Console]::Out.Write('{"continue":false,"stopReason":"HOOK_CONTINUE_FALSE_STOP"}')
  }
  "suppress" {
    [Console]::Out.Write('{"suppressOutput":true,"systemMessage":"HOOK_SUPPRESSED_SYSTEM_MESSAGE"}')
  }
  "wrong-event" {
    [Console]::Out.Write('{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"WRONG_EVENT"}}')
  }
  "bad-json" {
    [Console]::Out.Write('{"decision":123}')
  }
  "async-first-line" {
    [Console]::Out.WriteLine('{"async":true}')
    Start-Sleep -Milliseconds 1200
    "done:async-first-line" | Add-Content -Path (Join-Path $logDir "async-markers.txt") -Encoding UTF8
  }
  "watchpaths" {
    [Console]::Out.Write('{"systemMessage":"HOOK_ENV_MESSAGE_OK","hookSpecificOutput":{"hookEventName":"FileChanged","watchPaths":["src/alpha.txt"]}}')
  }
}
'@
Set-Content -Path "$HookDir\json-hook.ps1" -Value $jsonHook -Encoding UTF8
```

期望输出：
- `logger.ps1` 和 `json-hook.ps1` 已创建。
- 后续每个用例可以通过 `logs\*.ndjson` 或 `logs\async-markers.txt` 判断 Hook 是否执行。

### 3.4 写入 settings 文件的通用方法

后续用例都用 `$settingsFile` 指向独立配置。每个用例开始前建议清空日志：

```powershell
$settingsFile = Join-Path $env:FREE_CODE_E2E_ROOT "settings.json"
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue
```

## 4. 用例 1：空 matcher 匹配所有 UserPromptSubmit

### 验证目标

验证 settings 中的普通 command Hook 能被加载；空 matcher 可以匹配该事件的所有输入；Hook 能收到 JSON stdin 并写入日志。

### 操作步骤

```powershell
$settings = @{
  hooks = @{
    UserPromptSubmit = @(
      @{
        hooks = @(
          @{
            type = "command"
            shell = "powershell"
            command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name userprompt-all -Stdout HOOK_USERPROMPT_TEXT"
          }
        )
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --output-format text --max-turns 1 -- "只回答 OK"
Get-Content "$env:FREE_CODE_E2E_ROOT\logs\userprompt-all.ndjson"
```

### 期望输出

- CLI 正常完成。
- `userprompt-all.ndjson` 存在。
- 日志中的 `input` 包含 `"hook_event_name":"UserPromptSubmit"` 和用户输入文本。
- CLI 输出或调试信息中能观察到 `HOOK_USERPROMPT_TEXT`，如果界面未显示，也以日志文件存在为准。

## 5. 用例 2：matcher 精确匹配、管道列表和正则

### 验证目标

验证工具事件会使用工具名作为匹配值，并覆盖三种 matcher 形式：`Read`、`Read|Write`、`R.*d`。

### 操作步骤

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$settings = @{
  hooks = @{
    PreToolUse = @(
      @{
        matcher = "Read"
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name matcher-exact"
        })
      },
      @{
        matcher = "Read|Write"
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name matcher-pipe"
        })
      },
      @{
        matcher = "R.*d"
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name matcher-regex"
        })
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --output-format text --max-turns 3 --allowed-tools "Read" -- "请读取 src/alpha.txt，只回答文件内容。"

Get-ChildItem "$env:FREE_CODE_E2E_ROOT\logs" -Filter "matcher-*.ndjson" | Select-Object Name
```

### 期望输出

- `matcher-exact.ndjson`、`matcher-pipe.ndjson`、`matcher-regex.ndjson` 都存在。
- 三个日志文件中的 `input` 都包含 `"tool_name":"Read"`。
- 文件内容 `ALPHA_ORIGINAL` 能被正常读取。

## 6. 用例 3：非法正则 matcher 不应阻断 CLI

### 验证目标

验证 matcher 是非法正则时不会导致 CLI 崩溃；该 Hook 不应被执行。

### 操作步骤

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue
$debugLog = Join-Path $env:FREE_CODE_E2E_ROOT "logs\invalid-regex-debug.log"

$settings = @{
  hooks = @{
    PreToolUse = @(
      @{
        matcher = "[invalid"
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name invalid-regex"
        })
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --debug hooks --debug-file $debugLog --print --no-session-persistence --output-format text --max-turns 3 --allowed-tools "Read" -- "请读取 src/alpha.txt，只回答文件内容。"

Test-Path "$env:FREE_CODE_E2E_ROOT\logs\invalid-regex.ndjson"
Select-String -Path $debugLog -Pattern "Invalid regex|invalid" -SimpleMatch
```

### 期望输出

- CLI 正常输出 `ALPHA_ORIGINAL`。
- `invalid-regex.ndjson` 不存在。
- debug 日志里能看到非法 matcher 被跳过或匹配失败的记录。

## 7. 用例 4：`if` 条件命中和不命中

### 验证目标

验证 `if` 使用权限规则语法按工具输入过滤 Hook，只有匹配的工具调用才会启动子进程。

### 操作步骤

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$settings = @{
  hooks = @{
    PreToolUse = @(
      @{
        matcher = "Read"
        hooks = @(
          @{
            type = "command"
            shell = "powershell"
            if = "Read(src/alpha.txt)"
            command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name if-alpha"
          },
          @{
            type = "command"
            shell = "powershell"
            if = "Read(src/not-matched.txt)"
            command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name if-notmatched"
          }
        )
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --output-format text --max-turns 3 --allowed-tools "Read" -- "请读取 src/alpha.txt，只回答文件内容。"

Test-Path "$env:FREE_CODE_E2E_ROOT\logs\if-alpha.ndjson"
Test-Path "$env:FREE_CODE_E2E_ROOT\logs\if-notmatched.ndjson"
```

### 期望输出

- `if-alpha.ndjson` 输出 `True`。
- `if-notmatched.ndjson` 输出 `False`。
- 工具读取不受未命中的 Hook 影响。

## 8. 用例 5：command Hook 的退出码 0、1、2

### 验证目标

验证 command Hook 的退出码语义：0 成功，1 记录失败但通常不按阻断处理，2 表示阻断。

### 操作步骤

先验证退出码 0 和 1：

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$settings = @{
  hooks = @{
    PostToolUse = @(
      @{
        matcher = "Read"
        hooks = @(
          @{
            type = "command"
            shell = "powershell"
            command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name exit-zero -Stdout EXIT_ZERO_OK -ExitCode 0"
          },
          @{
            type = "command"
            shell = "powershell"
            command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name exit-one -Stdout EXIT_ONE_VISIBLE -ExitCode 1"
          }
        )
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --output-format text --max-turns 3 --allowed-tools "Read" -- "请读取 src/alpha.txt，只回答文件内容。"

Test-Path "$env:FREE_CODE_E2E_ROOT\logs\exit-zero.ndjson"
Test-Path "$env:FREE_CODE_E2E_ROOT\logs\exit-one.ndjson"
```

再验证退出码 2：

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$settings = @{
  hooks = @{
    PreToolUse = @(
      @{
        matcher = "Read"
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name exit-two -Stdout HOOK_EXIT_TWO_BLOCK -ExitCode 2"
        })
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --output-format text --max-turns 3 --allowed-tools "Read" -- "请读取 src/alpha.txt，并告诉我是否读到了内容。"
Test-Path "$env:FREE_CODE_E2E_ROOT\logs\exit-two.ndjson"
```

### 期望输出

- 退出码 0、1 两个日志文件都存在。
- 退出码 1 不应阻止 Read 完成。
- 退出码 2 应阻止 Read 工具真正读取文件，CLI 输出包含 `HOOK_EXIT_TWO_BLOCK` 或等价阻断说明。

## 9. 用例 6：command Hook 超时

### 验证目标

验证单个 Hook 的 `timeout` 按秒生效，超时后 CLI 不会无限等待。

### 操作步骤

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$settings = @{
  hooks = @{
    PostToolUse = @(
      @{
        matcher = "Read"
        hooks = @(@{
          type = "command"
          shell = "powershell"
          timeout = 1
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name timeout-hook -SleepMs 3000 -Stdout SHOULD_TIMEOUT"
        })
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

$start = Get-Date
& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --output-format text --max-turns 3 --allowed-tools "Read" -- "请读取 src/alpha.txt，只回答文件内容。"
$elapsed = ((Get-Date) - $start).TotalSeconds
$elapsed
```

### 期望输出

- CLI 不会等待 3 秒以上太久；实际耗时应接近模型调用时间加 1 秒 Hook 超时。
- 输出中可能包含 Hook 超时提示。
- `timeout-hook.ndjson` 可以存在，但 `async-markers.txt` 不应稳定出现 `done:timeout-hook`。

## 10. 用例 7：同步 JSON、非法 JSON 和事件名不匹配

### 验证目标

验证 JSON 输出会走结构校验；非法 JSON 或事件名不匹配不会被当作正常事件专属结果。

### 操作步骤

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$settings = @{
  hooks = @{
    UserPromptSubmit = @(
      @{
        hooks = @(
          @{
            type = "command"
            shell = "powershell"
            command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\json-hook.ps1`" -Mode user-context"
          },
          @{
            type = "command"
            shell = "powershell"
            command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\json-hook.ps1`" -Mode bad-json"
          },
          @{
            type = "command"
            shell = "powershell"
            command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\json-hook.ps1`" -Mode wrong-event"
          }
        )
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --output-format text --max-turns 2 -- "如果系统上下文里包含 HOOK_ADDITIONAL_CONTEXT_OK，请回答它；否则回答 NO_CONTEXT。"
Get-Content "$env:FREE_CODE_E2E_ROOT\logs\json-hook-inputs.ndjson"
```

### 期望输出

- `user-context` 的 `additionalContext` 被模型看见，输出应包含 `HOOK_ADDITIONAL_CONTEXT_OK`。
- 非法 JSON 和事件名不匹配不应让 CLI 崩溃。
- debug 模式下应能看到 JSON 校验或事件名不匹配提示。

## 11. 用例 8：`continue:false` 停止后续流程

### 验证目标

验证同步 JSON 中的 `continue:false` 会让 Hook 汇总结果要求停止当前流程。

### 操作步骤

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$settings = @{
  hooks = @{
    UserPromptSubmit = @(
      @{
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\json-hook.ps1`" -Mode continue-false"
        })
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --output-format text --max-turns 2 -- "请回答 SHOULD_NOT_REACH_MODEL"
```

### 期望输出

- 模型不应正常回答 `SHOULD_NOT_REACH_MODEL`。
- CLI 输出或 debug 日志包含 `HOOK_CONTINUE_FALSE_STOP` 或等价停止原因。

## 12. 用例 9：`suppressOutput:true` 隐藏 Hook 输出

### 验证目标

验证 Hook 执行成功但要求隐藏输出时，不把 Hook 文本作为普通可见消息注入给模型。

### 操作步骤

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$settings = @{
  hooks = @{
    UserPromptSubmit = @(
      @{
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\json-hook.ps1`" -Mode suppress"
        })
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --output-format text --max-turns 1 -- "如果你能看到 HOOK_SUPPRESSED_SYSTEM_MESSAGE，请回答 VISIBLE；否则回答 HIDDEN。"
```

### 期望输出

- 输出应为 `HIDDEN` 或不包含 `HOOK_SUPPRESSED_SYSTEM_MESSAGE`。
- Hook 输入日志仍应证明命令执行过。

## 13. 用例 10：PreToolUse 修改工具输入

### 验证目标

验证 `PreToolUse` 的 `updatedInput` 能把即将读取的文件从 `src/alpha.txt` 改为 `src/beta.txt`。

### 操作步骤

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$settings = @{
  hooks = @{
    PreToolUse = @(
      @{
        matcher = "Read"
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\json-hook.ps1`" -Mode pretool-update"
        })
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --output-format text --max-turns 3 --allowed-tools "Read" -- "请读取 src/alpha.txt，只回答实际读到的文件内容。"
```

### 期望输出

- 输出包含 `BETA_ORIGINAL`。
- 输出不应包含 `ALPHA_ORIGINAL`。
- 这证明工具调用已被 Hook 从黑盒层面改写。

## 14. 用例 11：PreToolUse JSON 阻断和批准

### 验证目标

验证 `PreToolUse` 的 JSON 决策可以允许或阻断工具调用。

### 操作步骤

先验证批准：

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$settings = @{
  hooks = @{
    PreToolUse = @(
      @{
        matcher = "Read"
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\json-hook.ps1`" -Mode pretool-approve"
        })
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --output-format text --max-turns 3 --allowed-tools "Read" -- "请读取 src/alpha.txt，只回答文件内容。"
```

再验证阻断：

```powershell
$settings.hooks.PreToolUse[0].hooks[0].command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\json-hook.ps1`" -Mode pretool-block"
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --output-format text --max-turns 3 --allowed-tools "Read" -- "请读取 src/alpha.txt，并告诉我是否读到了文件内容。"
```

### 期望输出

- 批准时输出包含 `ALPHA_ORIGINAL`。
- 阻断时不应读到 `ALPHA_ORIGINAL`，输出包含 `HOOK_BLOCKED_BY_JSON` 或等价阻断说明。

## 15. 用例 12：PostToolUse 修改工具输出

### 验证目标

验证 `PostToolUse` 的 `updatedMCPToolOutput` 能改变模型看到的工具结果。

### 操作步骤

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$settings = @{
  hooks = @{
    PostToolUse = @(
      @{
        matcher = "Read"
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\json-hook.ps1`" -Mode posttool-output"
        })
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --output-format text --max-turns 3 --allowed-tools "Read" -- "请读取 src/alpha.txt，只回答你看到的工具结果。"
```

### 期望输出

- 输出包含 `HOOK_REPLACED_TOOL_OUTPUT`。
- 输出不应直接依赖 `ALPHA_ORIGINAL`。

## 16. 用例 13：非工具事件配置 `if` 条件

### 验证目标

验证带 `if` 的 Hook 放到非工具事件上时不会执行，因为没有工具输入可用于评估条件。

### 操作步骤

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue
$debugLog = Join-Path $env:FREE_CODE_E2E_ROOT "logs\non-tool-if-debug.log"

$settings = @{
  hooks = @{
    UserPromptSubmit = @(
      @{
        hooks = @(@{
          type = "command"
          shell = "powershell"
          if = "Read(src/alpha.txt)"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name non-tool-if"
        })
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --debug hooks --debug-file $debugLog --print --no-session-persistence --output-format text --max-turns 1 -- "只回答 OK"

Test-Path "$env:FREE_CODE_E2E_ROOT\logs\non-tool-if.ndjson"
Select-String -Path $debugLog -Pattern "cannot be evaluated for non-tool event"
```

### 期望输出

- `non-tool-if.ndjson` 不存在。
- debug 日志说明该 `if` 不能用于非工具事件。
- CLI 仍能正常回答。

## 17. 用例 14：statusLine 命令

### 验证目标

验证 `statusLine` 配置能调用 command，并把 stdout 作为状态栏内容。

### 操作步骤

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$statusScript = @'
$stdin = [Console]::In.ReadToEnd()
$root = $env:FREE_CODE_E2E_ROOT
$stdin | Set-Content -Path (Join-Path $root "logs\statusline-input.json") -Encoding UTF8
[Console]::Out.Write("HOOK_STATUSLINE_OK")
'@
Set-Content -Path "$HookDir\statusline.ps1" -Value $statusScript -Encoding UTF8

$settings = @{
  statusLine = @{
    type = "command"
    command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\statusline.ps1`""
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile
```

进入交互式 CLI 后等待状态栏刷新。

### 期望输出

- 终端状态栏显示 `HOOK_STATUSLINE_OK`。
- `logs\statusline-input.json` 存在，内容是状态栏输入 JSON。
- 退出 CLI 后继续后续用例。

## 18. 用例 15：fileSuggestion 命令

### 验证目标

验证 `fileSuggestion` 配置能在文件补全时调用 command，并把命令输出作为候选来源。

### 操作步骤

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$suggestScript = @'
$stdin = [Console]::In.ReadToEnd()
$root = $env:FREE_CODE_E2E_ROOT
$stdin | Set-Content -Path (Join-Path $root "logs\filesuggestion-input.json") -Encoding UTF8
[Console]::Out.WriteLine("src/alpha.txt")
[Console]::Out.WriteLine("src/beta.txt")
'@
Set-Content -Path "$HookDir\filesuggestion.ps1" -Value $suggestScript -Encoding UTF8

$settings = @{
  fileSuggestion = @{
    type = "command"
    command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\filesuggestion.ps1`""
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile
```

在交互式 CLI 中输入 `@src/` 或触发文件路径补全。

### 期望输出

- 文件候选包含 `src/alpha.txt` 和 `src/beta.txt`。
- `logs\filesuggestion-input.json` 存在。
- 如果当前终端无法展示补全 UI，至少需要记录输入日志，以证明命令入口被调用。

## 19. 用例 16：异步 Hook

### 验证目标

覆盖两条异步路径：配置 `async:true` 后直接后台执行；stdout 首行返回 `{ "async": true }` 后转为后台执行。

### 操作步骤

配置 `async:true`：

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$settings = @{
  hooks = @{
    UserPromptSubmit = @(
      @{
        hooks = @(@{
          type = "command"
          shell = "powershell"
          async = $true
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name async-config -SleepMs 1500 -Stdout ASYNC_CONFIG_SHOULD_NOT_BLOCK"
        })
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

$start = Get-Date
& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --output-format text --max-turns 1 -- "只回答 OK"
$elapsed = ((Get-Date) - $start).TotalSeconds
Start-Sleep -Milliseconds 2000
Get-Content "$env:FREE_CODE_E2E_ROOT\logs\async-markers.txt"
```

配置 stdout 首行异步：

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$settings = @{
  hooks = @{
    UserPromptSubmit = @(
      @{
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\json-hook.ps1`" -Mode async-first-line"
        })
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --output-format text --max-turns 1 -- "只回答 OK"
Start-Sleep -Milliseconds 2000
Get-Content "$env:FREE_CODE_E2E_ROOT\logs\async-markers.txt"
```

### 期望输出

- CLI 不等待完整 1500ms Hook 完成才返回。
- 延迟后 `async-markers.txt` 包含 `done:async-config` 或 `done:async-first-line`。
- 异步 Hook 的 stdout 不应作为同步附加上下文影响模型回答。

## 20. 用例 17：HTTP Hook 的成功、错误和异步响应

### 验证目标

验证 HTTP Hook 会 POST Hook 输入，支持 JSON 响应、非 JSON 响应、非 2xx 响应和异步响应。

### 操作步骤

启动本地 HTTP 服务：

```powershell
$serverFile = Join-Path $env:FREE_CODE_E2E_ROOT "http\server.mjs"
$serverCode = @'
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = process.env.FREE_CODE_E2E_ROOT;
const logDir = path.join(root, "logs");
fs.mkdirSync(logDir, { recursive: true });

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    fs.appendFileSync(path.join(logDir, "http-hook.ndjson"), JSON.stringify({ url: req.url, body }) + "\n");
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "HTTP_CONTEXT_OK" } }));
      return;
    }
    if (req.url === "/async") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ async: true }));
      return;
    }
    if (req.url === "/non-json") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("NOT_JSON_HTTP_BODY");
      return;
    }
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("HTTP_500_BODY");
  });
});

server.listen(17890, "127.0.0.1", () => {
  fs.writeFileSync(path.join(logDir, "http-server-ready.txt"), "ready");
});
'@
Set-Content -Path $serverFile -Value $serverCode -Encoding UTF8
Start-Process -FilePath "node" -ArgumentList $serverFile -WindowStyle Hidden
Start-Sleep -Milliseconds 800
Test-Path "$env:FREE_CODE_E2E_ROOT\logs\http-server-ready.txt"
```

验证 2xx JSON：

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\http-hook.ndjson" -Force -ErrorAction SilentlyContinue

$settings = @{
  hooks = @{
    UserPromptSubmit = @(
      @{
        hooks = @(@{
          type = "http"
          url = "http://127.0.0.1:17890/ok"
        })
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --output-format text --max-turns 2 -- "如果上下文包含 HTTP_CONTEXT_OK，请回答它。"
Get-Content "$env:FREE_CODE_E2E_ROOT\logs\http-hook.ndjson"
```

验证非 JSON、非 2xx 和异步响应时，只需要替换 URL：

```powershell
$settings.hooks.UserPromptSubmit[0].hooks[0].url = "http://127.0.0.1:17890/non-json"
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8
& $env:FREE_CODE_CLI --settings $settingsFile --debug hooks --debug-file "$env:FREE_CODE_E2E_ROOT\logs\http-non-json-debug.log" --print --no-session-persistence --output-format text --max-turns 1 -- "只回答 OK"

$settings.hooks.UserPromptSubmit[0].hooks[0].url = "http://127.0.0.1:17890/error"
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8
& $env:FREE_CODE_CLI --settings $settingsFile --debug hooks --debug-file "$env:FREE_CODE_E2E_ROOT\logs\http-error-debug.log" --print --no-session-persistence --output-format text --max-turns 1 -- "只回答 OK"

$settings.hooks.UserPromptSubmit[0].hooks[0].url = "http://127.0.0.1:17890/async"
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8
& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --output-format text --max-turns 1 -- "只回答 OK"
```

### 期望输出

- `/ok` 时模型能看到 `HTTP_CONTEXT_OK`。
- `http-hook.ndjson` 记录了 POST body，body 中包含 Hook 输入 JSON。
- `/non-json` 不应崩溃，debug 日志说明 HTTP Hook 返回了非 JSON。
- `/error` 不应崩溃，debug 日志说明 HTTP 状态码失败。
- `/async` 不阻塞主流程，也不把普通文本注入给模型。

## 21. 用例 18：Setup 和 SessionStart

### 验证目标

验证 CLI 初始化阶段会执行 `Setup` 和 `SessionStart`，并且 `--init-only` 不需要进入普通对话。

### 操作步骤

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$settings = @{
  hooks = @{
    Setup = @(
      @{
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name setup-event"
        })
      }
    )
    SessionStart = @(
      @{
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name session-start-event"
        })
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --init-only --debug hooks --debug-file "$env:FREE_CODE_E2E_ROOT\logs\setup-session-debug.log"

Test-Path "$env:FREE_CODE_E2E_ROOT\logs\setup-event.ndjson"
Test-Path "$env:FREE_CODE_E2E_ROOT\logs\session-start-event.ndjson"
```

### 期望输出

- 两个日志文件都存在。
- `setup-event.ndjson` 中的事件名是 `Setup`。
- `session-start-event.ndjson` 中的事件名是 `SessionStart`。

## 22. 用例 19：SessionEnd、PreCompact 和 PostCompact

### 验证目标

验证 REPL 外 Hook 能在退出、清空或压缩流程中执行。

### 操作步骤

配置三个事件：

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$settings = @{
  hooks = @{
    SessionEnd = @(
      @{
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name session-end-event"
        })
      }
    )
    PreCompact = @(
      @{
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name precompact-event -Stdout PRECOMPACT_TEXT"
        })
      }
    )
    PostCompact = @(
      @{
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name postcompact-event -Stdout POSTCOMPACT_TEXT"
        })
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile
```

在交互式 CLI 中：
1. 输入一条普通消息，例如 `只回答 OK`。
2. 输入 `/compact` 触发压缩。
3. 输入 `/exit` 或按正常方式退出。
4. 回到 PowerShell 后检查：

```powershell
Test-Path "$env:FREE_CODE_E2E_ROOT\logs\precompact-event.ndjson"
Test-Path "$env:FREE_CODE_E2E_ROOT\logs\postcompact-event.ndjson"
Test-Path "$env:FREE_CODE_E2E_ROOT\logs\session-end-event.ndjson"
```

### 期望输出

- `/compact` 前后分别出现 `precompact-event.ndjson` 和 `postcompact-event.ndjson`。
- 正常退出后出现 `session-end-event.ndjson`。
- 对于 `PreCompact`，如果 Hook 输出被展示，应能看到 `PRECOMPACT_TEXT`。

## 23. 用例 20：ConfigChange、InstructionsLoaded、CwdChanged、FileChanged

### 验证目标

验证环境类 Hook 可以执行，并能返回 `systemMessage` 和 `watchPaths`。

### 操作步骤

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$settings = @{
  hooks = @{
    ConfigChange = @(
      @{
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name config-change-event"
        })
      }
    )
    InstructionsLoaded = @(
      @{
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name instructions-loaded-event"
        })
      }
    )
    CwdChanged = @(
      @{
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\logger.ps1`" -Name cwd-changed-event"
        })
      }
    )
    FileChanged = @(
      @{
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\json-hook.ps1`" -Mode watchpaths"
        })
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --debug hooks --debug-file "$env:FREE_CODE_E2E_ROOT\logs\env-events-debug.log"
```

在交互式 CLI 中：
1. 等待启动完成，检查是否生成 `instructions-loaded-event.ndjson`。
2. 修改 `settings.json` 或项目指令文件，触发配置或指令重载。
3. 让 CLI 切换当前工作目录，例如使用内置目录切换能力或让模型执行会改变会话 cwd 的命令。
4. 修改 `src/alpha.txt`，触发文件变化。

检查日志：

```powershell
Get-ChildItem "$env:FREE_CODE_E2E_ROOT\logs" -Filter "*event*.ndjson" | Select-Object Name
Select-String -Path "$env:FREE_CODE_E2E_ROOT\logs\env-events-debug.log" -Pattern "HOOK_ENV_MESSAGE_OK|watchPaths|ConfigChange|CwdChanged|FileChanged|InstructionsLoaded"
```

### 期望输出

- 对应事件的日志文件出现。
- `FileChanged` 分支返回的 `systemMessage` 能在 debug 日志或系统消息中观察到。
- `watchPaths` 包含 `src/alpha.txt`，后续文件监听应继续关注该路径。
- 如果当前 CLI 版本没有暴露稳定的 cwd 切换入口，需要记录无法触发的原因，但不把它当作 Hook 执行失败。

## 24. 用例 21：PermissionRequest 和 PermissionDenied

### 验证目标

验证权限请求前后的 Hook 事件：请求时可以批准或拒绝；被拒后可以记录拒绝事件并选择重试语义。

### 操作步骤

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$permissionScript = @'
param([string]$Mode)
$stdin = [Console]::In.ReadToEnd()
$root = $env:FREE_CODE_E2E_ROOT
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
$stdin | Add-Content -Path (Join-Path $logDir "$Mode.ndjson") -Encoding UTF8
if ($Mode -eq "permission-request-allow") {
  [Console]::Out.Write('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":"allow","reason":"HOOK_PERMISSION_ALLOW"}}')
} elseif ($Mode -eq "permission-request-deny") {
  [Console]::Out.Write('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":"deny","reason":"HOOK_PERMISSION_DENY"}}')
} else {
  [Console]::Out.Write('{"hookSpecificOutput":{"hookEventName":"PermissionDenied","retry":false,"reason":"HOOK_PERMISSION_DENIED_LOGGED"}}')
}
'@
Set-Content -Path "$HookDir\permission.ps1" -Value $permissionScript -Encoding UTF8

$settings = @{
  hooks = @{
    PermissionRequest = @(
      @{
        matcher = "Bash"
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\permission.ps1`" -Mode permission-request-deny"
        })
      }
    )
    PermissionDenied = @(
      @{
        matcher = "Bash"
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\permission.ps1`" -Mode permission-denied"
        })
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8

& $env:FREE_CODE_CLI --settings $settingsFile --print --no-session-persistence --output-format text --max-turns 5 --allowed-tools "" -- "请用 Bash 执行 echo permission-test，并说明是否执行成功。"

Test-Path "$env:FREE_CODE_E2E_ROOT\logs\permission-request-deny.ndjson"
Test-Path "$env:FREE_CODE_E2E_ROOT\logs\permission-denied.ndjson"
```

### 期望输出

- 权限请求 Hook 日志存在。
- 权限拒绝 Hook 日志存在。
- Bash 命令不应真正执行成功。
- 输出包含 `HOOK_PERMISSION_DENY`、`HOOK_PERMISSION_DENIED_LOGGED` 或等价拒绝说明。

## 25. 用例 22：WorktreeCreate 和 WorktreeRemove

### 验证目标

验证没有 Git 工作树或需要自定义工作树时，Hook 可以提供工作树路径，并在移除时执行清理。

### 操作步骤

```powershell
Remove-Item "$env:FREE_CODE_E2E_ROOT\logs\*" -Force -ErrorAction SilentlyContinue

$worktreeCreate = @'
$stdin = [Console]::In.ReadToEnd()
$root = $env:FREE_CODE_E2E_ROOT
$target = Join-Path $root "worktrees\hook-created-worktree"
New-Item -ItemType Directory -Force $target | Out-Null
$stdin | Set-Content -Path (Join-Path $root "logs\worktree-create-input.json") -Encoding UTF8
[Console]::Out.Write($target)
'@
Set-Content -Path "$HookDir\worktree-create.ps1" -Value $worktreeCreate -Encoding UTF8

$worktreeRemove = @'
$stdin = [Console]::In.ReadToEnd()
$root = $env:FREE_CODE_E2E_ROOT
$stdin | Set-Content -Path (Join-Path $root "logs\worktree-remove-input.json") -Encoding UTF8
"removed" | Set-Content -Path (Join-Path $root "logs\worktree-remove-marker.txt") -Encoding UTF8
'@
Set-Content -Path "$HookDir\worktree-remove.ps1" -Value $worktreeRemove -Encoding UTF8

$settings = @{
  hooks = @{
    WorktreeCreate = @(
      @{
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\worktree-create.ps1`""
        })
      }
    )
    WorktreeRemove = @(
      @{
        hooks = @(@{
          type = "command"
          shell = "powershell"
          command = "powershell -ExecutionPolicy Bypass -File `"$HookDir\worktree-remove.ps1`""
        })
      }
    )
  }
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsFile -Encoding UTF8
```

在需要工作树的入口运行 CLI，例如 bridge 或 spawn/worktree 模式。当前版本可先用下面命令探测入口是否可用：

```powershell
& $env:FREE_CODE_CLI --settings $settingsFile --help | Select-String -Pattern "worktree|spawn"
```

根据帮助信息选择对应命令后，检查：

```powershell
Test-Path "$env:FREE_CODE_E2E_ROOT\logs\worktree-create-input.json"
Test-Path "$env:FREE_CODE_E2E_ROOT\worktrees\hook-created-worktree"
Test-Path "$env:FREE_CODE_E2E_ROOT\logs\worktree-remove-marker.txt"
```

### 期望输出

- 创建阶段 stdout 的路径被当作工作树路径使用。
- 创建日志包含 `hook_event_name` 为 `WorktreeCreate`。
- 移除阶段生成 `worktree-remove-marker.txt`。
- 如果当前 CLI 构建没有暴露 worktree 入口，记录 `--help` 输出作为不可触发证据。

## 26. 用例 23：SDK、会话态和高级事件分支

### 验证目标

覆盖无法仅靠 settings 文件稳定触发的分支：`callback`、`function`、`prompt`、`agent`、`Elicitation`、`ElicitationResult`、`SubagentStart`、`SubagentStop`、`TaskCreated`、`TaskCompleted`、`TeammateIdle`。

### 操作步骤

这组分支需要使用对应产品入口触发，不能只靠 `--print` 伪造。agent 执行时按以下顺序验证：

1. SDK callback Hook：
   - 使用项目内 SDK 或 bridge 入口注册 callback Hook。
   - 触发 `UserPromptSubmit` 或 `PreToolUse`。
   - callback 返回同步 JSON，验证输出被合并。
   - callback 返回 `{ "async": true }`，验证被记录为异步。

2. function Hook：
   - 通过会话态 API 注册 function Hook。
   - 触发 `Stop`。
   - 验证 function 能收到 messages；当 messages 缺失时应返回错误消息。

3. prompt Hook：
   - 在 settings 中配置 `type: "prompt"`，prompt 内容包含 `$ARGUMENTS`。
   - 触发 `UserPromptSubmit`。
   - 验证模型返回的 Hook JSON 或文本被合并。

4. agent Hook：
   - 在 settings 中配置 `type: "agent"`。
   - 触发 `PostToolUse` 或 `Stop`。
   - 验证 agent Hook 的输出参与后续决策。

5. Elicitation：
   - 配置会触发 elicitation 的 MCP 服务。
   - 在 `Elicitation` Hook 中返回带 `hookSpecificOutput.hookEventName` 的 JSON。
   - 验证 `allow`、`deny`、`response` 和阻断路径。
   - 触发 `ElicitationResult`，验证结果事件收到前一步的选择。

6. Subagent、Task、Teammate：
   - 使用支持子 agent、任务或协作队列的入口。
   - 分别触发开始、停止、任务创建、任务完成和 teammate idle。
   - 验证各事件日志中的 `hook_event_name` 与事件一致，阻断码 2 能阻止对应流程继续。

### 期望输出

- 每个高级入口都必须留下事件日志。
- 如果当前构建没有暴露对应入口，记录具体不可用命令、帮助信息或错误文本。
- 不允许用直接调用内部 TypeScript 函数替代黑盒触发；只能通过 CLI、SDK、bridge、MCP 或产品入口触发。

## 27. 清理

```powershell
Set-Location D:\Code\free-code
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:\FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:\FREE_CODE_CLI -ErrorAction SilentlyContinue
```

## 28. 验收标准

- 新增测试数据只出现在 `D:\tmp\free-code-hooks-e2e`。
- settings、Hook 脚本、HTTP 服务和日志都可由文档步骤重建。
- command Hook 覆盖成功、失败、阻断、超时、同步 JSON、非法 JSON、异步和输出隐藏。
- matcher 覆盖空匹配、精确匹配、管道匹配、正则匹配和非法正则。
- 工具事件覆盖 `PreToolUse`、`PostToolUse`、`PermissionRequest`、`PermissionDenied`。
- 非工具事件覆盖 `UserPromptSubmit`、`Setup`、`SessionStart`、`SessionEnd`、`PreCompact`、`PostCompact`。
- 环境和工作树事件有明确触发步骤；无法在当前构建触发时，要记录可复现的不可用证据。
- 所有验证都以 CLI 可见输出、日志文件、debug 文件或实际文件系统变化为准，不依赖读取 `src/utils/hooks.ts` 内部实现。
