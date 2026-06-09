# Session 管理端到端验证用例

本文档基于以下两个文件设计端到端验证步骤：

- `src/utils/sessionStart.ts`
- `src/utils/sessionStoragePortable.ts`

验证目标：

1. 验证 `Setup`、`SessionStart` Hook 的启动、恢复、清空会话触发链路。
2. 验证 `--bare` 模式会跳过 Hook 加载和执行。
3. 验证 session 文件定位、轻量读取、首条用户提示词提取。
4. 验证大 transcript 读取时 compact boundary 截断、preservedSegment 保留、attribution snapshot 处理。

## 1. 公共前置条件

### 1.1 环境要求

- 操作系统：Windows
- Shell：PowerShell
- 仓库目录：`D:\Code\free-code`
- 已安装 `bun`
- 已具备 CLI 运行所需认证：
  - 已设置 `ANTHROPIC_API_KEY`
  - 或已通过 `.\cli-dev.exe /login` 登录

### 1.2 初始化验证环境

```powershell
cd D:\Code\free-code

bun install
bun run build:dev

$env:CLAUDE_CONFIG_DIR = "$env:TEMP\free-code-e2e-claude"
Remove-Item -Recurse -Force $env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:CLAUDE_CONFIG_DIR | Out-Null
New-Item -ItemType Directory -Force .claude\hooks | Out-Null
```

期望输出：

- `bun install` 成功。
- `bun run build:dev` 成功，并生成 `.\cli-dev.exe`。
- `$env:CLAUDE_CONFIG_DIR` 指向隔离目录，避免污染真实用户 session。

## 2. 用例 1：Setup 和 SessionStart startup Hook 正常执行

### 验证目标

验证 `processSetupHooks('init')` 和 `processSessionStartHooks('startup')` 能通过 CLI 启动路径被端到端触发。

### 输入

- `.claude/settings.json`
- `.claude/hooks/setup.ps1`
- `.claude/hooks/session-start.ps1`

### 操作步骤

1. 创建 `Setup` Hook 脚本。

```powershell
@'
$inputJson = [Console]::In.ReadToEnd()
$inputJson | Set-Content -Encoding UTF8 ".\.claude\hook-setup-input.json"
Write-Output '{"hookSpecificOutput":{"hookEventName":"Setup","additionalContext":"E2E_SETUP_CONTEXT"}}'
'@ | Set-Content -Encoding UTF8 .\.claude\hooks\setup.ps1
```

2. 创建 `SessionStart` Hook 脚本。

```powershell
@'
$inputJson = [Console]::In.ReadToEnd()
$inputJson | Set-Content -Encoding UTF8 ".\.claude\hook-sessionstart-input.json"
Write-Output '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"E2E_SESSION_CONTEXT","initialUserMessage":"E2E_INITIAL_PROMPT","watchPaths":[]}}'
'@ | Set-Content -Encoding UTF8 .\.claude\hooks\session-start.ps1
```

3. 创建 `.claude/settings.json`。

```powershell
@'
{
  "hooks": {
    "Setup": [
      {
        "hooks": [
          {
            "type": "command",
            "shell": "powershell",
            "command": ".\\.claude\\hooks\\setup.ps1"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "shell": "powershell",
            "command": ".\\.claude\\hooks\\session-start.ps1"
          }
        ]
      }
    ]
  }
}
'@ | Set-Content -Encoding UTF8 .\.claude\settings.json
```

4. 执行 `init-only` 启动路径。

```powershell
.\cli-dev.exe --init-only --debug hooks --debug-file .\.claude\e2e-hooks.log
```

5. 检查 Hook 输入文件。

```powershell
Get-Content .\.claude\hook-setup-input.json
Get-Content .\.claude\hook-sessionstart-input.json
Get-Content .\.claude\e2e-hooks.log
```

### 期望输出

- CLI 进程退出码为 `0`。
- `.claude\hook-setup-input.json` 存在。
- `.claude\hook-setup-input.json` 包含：

```json
"hook_event_name":"Setup"
```

- `.claude\hook-sessionstart-input.json` 存在。
- `.claude\hook-sessionstart-input.json` 包含：

```json
"hook_event_name":"SessionStart"
```

- debug log 中能看到 Hook 加载或执行相关日志。
- 说明 `processSetupHooks()` 和 `processSessionStartHooks('startup')` 都已被触发。

## 3. 用例 2：--bare 模式跳过所有 Hook

### 验证目标

验证 `sessionStart.ts` 中 `isBareMode()` 分支生效，`--bare` 模式不会加载插件 Hook，也不会执行 `Setup` 或 `SessionStart` Hook。

### 输入

沿用用例 1 的 `.claude/settings.json` 和 Hook 脚本。

### 操作步骤

1. 删除上一次 Hook 输出。

```powershell
Remove-Item .\.claude\hook-setup-input.json -ErrorAction SilentlyContinue
Remove-Item .\.claude\hook-sessionstart-input.json -ErrorAction SilentlyContinue
```

2. 以 `--bare` 模式启动。

```powershell
.\cli-dev.exe --bare --init-only --debug hooks --debug-file .\.claude\e2e-bare.log
```

3. 检查 Hook 输出文件。

```powershell
Test-Path .\.claude\hook-setup-input.json
Test-Path .\.claude\hook-sessionstart-input.json
```

### 期望输出

```text
False
False
```

说明：

- `Setup` Hook 没有执行。
- `SessionStart` Hook 没有执行。
- `processSetupHooks()` 和 `processSessionStartHooks()` 在 bare 模式下直接返回空数组。

## 4. 用例 3：创建 session 文件并验证轻量读取

### 验证目标

验证 `sessionStoragePortable.ts` 中以下能力：

- `getProjectsDir()`
- `getProjectDir()`
- `sanitizePath()`
- `resolveSessionFilePath(sessionId, dir)`
- `readSessionLite()`
- `extractFirstPromptFromHead()`

### 输入

手工创建一个 JSONL session 文件。

### 操作步骤

1. 设置 sessionId。

```powershell
$sessionId = "11111111-1111-4111-8111-111111111111"
```

2. 计算当前项目对应的 session 存储目录。

```powershell
$projectDir = bun -e "import { getProjectDir } from './src/utils/sessionStoragePortable.ts'; console.log(getProjectDir(process.cwd()))"
New-Item -ItemType Directory -Force $projectDir | Out-Null
```

3. 写入 JSONL session 文件。

```powershell
@'
{"type":"user","message":{"content":"E2E first prompt from portable storage"}}
{"type":"assistant","message":{"content":"E2E assistant reply"}}
'@ | Set-Content -Encoding UTF8 "$projectDir\$sessionId.jsonl"
```

4. 执行验证脚本。

```powershell
bun -e "import { resolveSessionFilePath, readSessionLite, extractFirstPromptFromHead } from './src/utils/sessionStoragePortable.ts'; const id='11111111-1111-4111-8111-111111111111'; const r=await resolveSessionFilePath(id, process.cwd()); const lite=await readSessionLite(r.filePath); console.log(JSON.stringify({found:!!r, size:r.fileSize>0, first:extractFirstPromptFromHead(lite.head)}))"
```

### 期望输出

```json
{"found":true,"size":true,"first":"E2E first prompt from portable storage"}
```

说明：

- `resolveSessionFilePath()` 能根据当前目录定位到 session 文件。
- `readSessionLite()` 能读取文件头尾内容。
- `extractFirstPromptFromHead()` 能提取第一条真实用户输入。

## 5. 用例 4：无 dir 参数时扫描所有 project session

### 验证目标

验证 `resolveSessionFilePath(sessionId)` 未传 `dir` 时，可以扫描 `$CLAUDE_CONFIG_DIR\projects` 下所有项目目录。

### 输入

沿用用例 3 创建的 session 文件。

### 操作步骤

```powershell
bun -e "import { resolveSessionFilePath } from './src/utils/sessionStoragePortable.ts'; const r=await resolveSessionFilePath('11111111-1111-4111-8111-111111111111'); console.log(JSON.stringify({found:!!r, projectPath:r?.projectPath}))"
```

### 期望输出

```json
{"found":true}
```

说明：

- `found` 必须为 `true`。
- `projectPath` 应为 `undefined` 或不出现在 JSON 中。
- 说明没有目录上下文时，全局扫描逻辑可用。

## 6. 用例 5：首条 prompt 提取跳过 meta、compact summary 和 slash command

### 验证目标

验证 `extractFirstPromptFromHead()` 会跳过非真实用户输入，并保留 slash command 作为兜底。

### 输入

构造包含 meta、compact summary、slash command、真实文本的 head 内容。

### 操作步骤

```powershell
bun -e "import { extractFirstPromptFromHead } from './src/utils/sessionStoragePortable.ts'; const head=[JSON.stringify({type:'user',isMeta:true,message:{content:'META_SHOULD_SKIP'}}), JSON.stringify({type:'user',isCompactSummary:true,message:{content:'SUMMARY_SHOULD_SKIP'}}), JSON.stringify({type:'user',message:{content:'<command-name>help</command-name>'}}), JSON.stringify({type:'user',message:{content:'REAL_USER_PROMPT'}})].join('\n'); console.log(extractFirstPromptFromHead(head));"
```

### 期望输出

```text
REAL_USER_PROMPT
```

说明：

- meta 消息被跳过。
- compact summary 被跳过。
- slash command 不作为首条自然语言 prompt。
- 存在真实用户输入时返回真实输入。

## 7. 用例 6：只有 slash command 时返回 command fallback

### 验证目标

验证 `extractFirstPromptFromHead()` 在没有自然语言 prompt 时，会返回第一个 slash command 的命令名。

### 输入

只包含 slash command 的 user 消息。

### 操作步骤

```powershell
bun -e "import { extractFirstPromptFromHead } from './src/utils/sessionStoragePortable.ts'; const head=JSON.stringify({type:'user',message:{content:'<command-name>status</command-name>'}}); console.log(extractFirstPromptFromHead(head));"
```

### 期望输出

```text
status
```

## 8. 用例 7：bash 输入格式化为感叹号命令

### 验证目标

验证 `extractFirstPromptFromHead()` 对 `<bash-input>` 内容返回 `! command` 展示格式。

### 输入

包含 bash input 的 user 消息。

### 操作步骤

```powershell
bun -e "import { extractFirstPromptFromHead } from './src/utils/sessionStoragePortable.ts'; const head=JSON.stringify({type:'user',message:{content:'<bash-input>git status</bash-input>'}}); console.log(extractFirstPromptFromHead(head));"
```

### 期望输出

```text
! git status
```

## 9. 用例 8：compact boundary 截断大 transcript

### 验证目标

验证 `readTranscriptForLoad()` 在遇到普通 compact boundary 时：

- 删除 boundary 前旧内容。
- 保留 boundary 后内容。
- 只保留最后一条 attribution snapshot。
- 返回有效 `boundaryStartOffset`。

### 输入

一个超过 5MB 的 JSONL transcript 文件。

### 操作步骤

```powershell
$largeFile = "$env:TEMP\free-code-e2e-large.jsonl"
$pad = "x" * (6 * 1024 * 1024)

@(
  '{"type":"user","message":{"content":"BEFORE_BOUNDARY"}}',
  ('{"type":"assistant","message":{"content":"' + $pad + '"}}'),
  '{"type":"system","subtype":"compact_boundary"}',
  '{"type":"user","message":{"content":"AFTER_BOUNDARY"}}',
  '{"type":"attribution-snapshot","snapshot":{"id":"last"}}'
) | Set-Content -Encoding UTF8 $largeFile

bun -e "import { readTranscriptForLoad } from './src/utils/sessionStoragePortable.ts'; import { stat } from 'fs/promises'; const file=process.env.TEMP+'\\\\free-code-e2e-large.jsonl'; const s=await stat(file); const r=await readTranscriptForLoad(file,s.size); const text=r.postBoundaryBuf.toString('utf8'); console.log(JSON.stringify({hasBefore:text.includes('BEFORE_BOUNDARY'), hasAfter:text.includes('AFTER_BOUNDARY'), hasSnapshot:text.includes('attribution-snapshot'), boundary:r.boundaryStartOffset>0, preserved:r.hasPreservedSegment}))"
```

### 期望输出

```json
{"hasBefore":false,"hasAfter":true,"hasSnapshot":true,"boundary":true,"preserved":false}
```

说明：

- `BEFORE_BOUNDARY` 被截断。
- `AFTER_BOUNDARY` 被保留。
- attribution snapshot 被保留到输出末尾。
- `boundaryStartOffset > 0`。
- `hasPreservedSegment` 为 `false`。

## 10. 用例 9：preservedSegment boundary 不截断旧内容

### 验证目标

验证 compact boundary 带 `compactMetadata.preservedSegment` 时不会清空已有输出。

### 输入

一个包含 preservedSegment compact boundary 的 JSONL 文件。

### 操作步骤

```powershell
$preservedFile = "$env:TEMP\free-code-e2e-preserved.jsonl"

@(
  '{"type":"user","message":{"content":"BEFORE_PRESERVED"}}',
  '{"type":"system","subtype":"compact_boundary","compactMetadata":{"preservedSegment":[{"type":"user"}]}}',
  '{"type":"user","message":{"content":"AFTER_PRESERVED"}}'
) | Set-Content -Encoding UTF8 $preservedFile

bun -e "import { readTranscriptForLoad } from './src/utils/sessionStoragePortable.ts'; import { stat } from 'fs/promises'; const file=process.env.TEMP+'\\\\free-code-e2e-preserved.jsonl'; const s=await stat(file); const r=await readTranscriptForLoad(file,s.size); const text=r.postBoundaryBuf.toString('utf8'); console.log(JSON.stringify({hasBefore:text.includes('BEFORE_PRESERVED'), hasAfter:text.includes('AFTER_PRESERVED'), preserved:r.hasPreservedSegment}))"
```

### 期望输出

```json
{"hasBefore":true,"hasAfter":true,"preserved":true}
```

说明：

- `BEFORE_PRESERVED` 被保留。
- `AFTER_PRESERVED` 被保留。
- `hasPreservedSegment` 为 `true`。

## 11. 用例 10：跨 chunk 半行和 attribution snapshot 收尾

### 验证目标

验证 `processStraddle()`、`captureCarry()`、`captureSnap()` 和 `finalizeOutput()` 能处理跨 chunk 半行，以及文件末尾 snapshot。

### 输入

构造一个大文件，让 snapshot 出现在文件末尾且没有额外内容。

### 操作步骤

```powershell
$snapFile = "$env:TEMP\free-code-e2e-snapshot-tail.jsonl"
$pad = "x" * (1024 * 1024 + 128)

@(
  ('{"type":"assistant","message":{"content":"' + $pad + '"}}'),
  '{"type":"user","message":{"content":"TAIL_USER_MESSAGE"}}',
  '{"type":"attribution-snapshot","snapshot":{"id":"tail-snapshot"}}'
) | Set-Content -Encoding UTF8 $snapFile

bun -e "import { readTranscriptForLoad } from './src/utils/sessionStoragePortable.ts'; import { stat } from 'fs/promises'; const file=process.env.TEMP+'\\\\free-code-e2e-snapshot-tail.jsonl'; const s=await stat(file); const r=await readTranscriptForLoad(file,s.size); const text=r.postBoundaryBuf.toString('utf8'); console.log(JSON.stringify({hasUser:text.includes('TAIL_USER_MESSAGE'), snapCount:(text.match(/attribution-snapshot/g)||[]).length, endsWithSnapshot:text.trimEnd().endsWith('}}')}))"
```

### 期望输出

```json
{"hasUser":true,"snapCount":1,"endsWithSnapshot":true}
```

说明：

- 用户消息被保留。
- attribution snapshot 只出现一次。
- snapshot 位于输出末尾。

## 12. 用例 11：/resume 触发 SessionStart Hook

### 验证目标

验证交互式 `/resume` 会触发 `processSessionStartHooks('resume')`。

### 输入

沿用用例 1 的 Hook 配置，以及用例 3 创建的 session 文件。

### 操作步骤

1. 删除旧 Hook 输出。

```powershell
Remove-Item .\.claude\hook-sessionstart-input.json -ErrorAction SilentlyContinue
```

2. 启动 CLI。

```powershell
.\cli-dev.exe
```

3. 在交互界面输入：

```text
/resume 11111111-1111-4111-8111-111111111111
```

4. 退出 CLI 后检查 Hook 输入。

```powershell
Get-Content .\.claude\hook-sessionstart-input.json
```

### 期望输出

- `.claude\hook-sessionstart-input.json` 存在。
- 内容包含：

```json
"hook_event_name":"SessionStart"
```

- 输入 JSON 中应体现 resume 触发来源。
- 说明 `REPL.tsx -> processSessionStartHooks('resume')` 链路可用。

## 13. 用例 12：/clear 后重新执行 SessionStart Hook

### 验证目标

验证交互式 `/clear` 会触发 `processSessionStartHooks('clear')`。

### 输入

沿用用例 1 的 Hook 配置。

### 操作步骤

1. 删除旧 Hook 输出。

```powershell
Remove-Item .\.claude\hook-sessionstart-input.json -ErrorAction SilentlyContinue
```

2. 启动 CLI。

```powershell
.\cli-dev.exe
```

3. 在交互界面输入：

```text
/clear
```

4. 退出 CLI 后检查 Hook 输入。

```powershell
Get-Content .\.claude\hook-sessionstart-input.json
```

### 期望输出

- `.claude\hook-sessionstart-input.json` 存在。
- 内容包含：

```json
"hook_event_name":"SessionStart"
```

- 输入 JSON 中应体现 clear 触发来源。
- 说明 `/clear -> processSessionStartHooks('clear')` 链路可用。

## 14. 用例 13：非法 UUID 不进入 session 定位

### 验证目标

验证 `validateUuid()` 对非法 sessionId 返回 `null`。

### 输入

非法 UUID 字符串。

### 操作步骤

```powershell
bun -e "import { validateUuid } from './src/utils/sessionStoragePortable.ts'; console.log(JSON.stringify({bad:validateUuid('not-a-uuid'), good:!!validateUuid('11111111-1111-4111-8111-111111111111')}))"
```

### 期望输出

```json
{"bad":null,"good":true}
```

说明：

- 非法 UUID 不会被当成 sessionId。
- 合法 UUID 会通过格式校验。

## 15. 回归验证命令

完成以上端到端验证后，执行以下回归命令：

```powershell
bun test src\utils\sessionStorage.test.ts
bun run build
```

期望输出：

- `sessionStorage.test.ts` 全部通过。
- `bun run build` 成功生成 `.\cli` 或相关构建产物。

## 16. 清理验证环境

```powershell
Remove-Item -Recurse -Force $env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
Remove-Item .\.claude\hook-setup-input.json -ErrorAction SilentlyContinue
Remove-Item .\.claude\hook-sessionstart-input.json -ErrorAction SilentlyContinue
Remove-Item .\.claude\e2e-hooks.log -ErrorAction SilentlyContinue
Remove-Item .\.claude\e2e-bare.log -ErrorAction SilentlyContinue
```

注意：

- 如果 `.claude/settings.json` 是临时创建的验证配置，验证完成后请按需要删除或恢复。
- 本文档中的 session 文件全部写入 `$env:CLAUDE_CONFIG_DIR` 指向的隔离目录，不应影响真实用户历史会话。
