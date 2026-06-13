# src/tools/FileWriteTool/FileWriteTool.ts 功能说明与黑盒端到端测试指导

本文档参考 `docs\session-management-e2e-validation.md` 的组织方式，说明 `src/tools/FileWriteTool/FileWriteTool.ts` 的主要功能，并给出完全模拟用户使用 free-code 的黑盒测试步骤。

约束：

- 不切换 Git 分支。
- 不写单元测试或临时 `*.test.ts` 文件。
- 所有测试数据写入 `D:\tmp`。
- 从当前项目目录构建并定位 CLI，后续在测试项目目录中通过 `$env:FREE_CODE_CLI` 调用。
- 使用独立 `CLAUDE_CONFIG_DIR`，避免污染真实用户配置和项目仓库下的 `.claude`。

## 1. 文件功能说明

`src/tools/FileWriteTool/FileWriteTool.ts` 定义 free-code 的 `Write` 工具。它用于创建新文件或完整覆盖已有文件。与 `Edit` 不同，`Write` 接收完整文件内容，因此风险更高，工具内部有多层保护。

主要功能点：

1. 输入 schema：接收 `file_path` 和完整 `content`。
2. 路径展开：`backfillObservableInput()` 会把 `~` 或相对路径展开成绝对路径，便于权限和 hook 判断。
3. 写权限检查：通过 `checkWritePermissionForTool()` 走写权限体系。
4. deny 规则检查：如果路径被权限设置拒绝，返回 `File is in a directory that is denied by your permission settings.`。
5. 团队记忆敏感内容保护：`checkTeamMemSecrets()` 会阻止把疑似密钥写入 team memory 文件。
6. 已存在文件必须先完整读取：如果目标文件存在但没有先 Read，返回 `File has not been read yet. Read it first before writing to it.`。
7. 新鲜度检查：如果文件在 Read 后被用户或工具修改，拒绝覆盖，避免静默丢失外部修改。
8. 父目录创建：写入前会创建父目录。
9. 动态技能发现和条件技能激活：写入路径可能触发 `.claude\skills` 发现和 paths 条件技能激活。
10. 写入执行：通过 `writeTextContent()` 写入文件。
11. 写入后更新：通知 LSP、VS Code MCP、诊断系统、文件历史、读取状态。
12. 输出映射：新建返回 `File created successfully at: ...`；更新返回 `The file ... has been updated successfully.`。
13. UI 展示：新建文件最多预览前 10 行；更新文件展示结构化 diff。

重点调用链：

- `src/tools/FileWriteTool/FileWriteTool.ts`
- `src/tools/FileWriteTool/UI.tsx`
- `src/utils/file.ts`
- `src/utils/fileRead.ts`
- `src/utils/fileHistory.ts`
- `src/skills/loadSkillsDir.ts`
- `src/utils/permissions/filesystem.ts`

## 2. 公共前置条件

### 2.1 环境要求

- 操作系统：Windows
- Shell：PowerShell
- 当前工作目录：本仓库根目录
- 已具备 CLI 认证能力：
  - 已设置模型提供商 API key
  - 或已经通过当前目录下构建出的 CLI 完成登录

### 2.2 初始化测试环境

在当前项目根目录执行：

```powershell
npm run build

if (!(Test-Path .\cli.exe)) {
  throw "未找到 .\cli.exe，请确认构建是否成功。"
}

$env:FREE_CODE_CLI = (Resolve-Path .\cli.exe).Path
$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-file-write-tool-e2e"
$env:CLAUDE_CONFIG_DIR = Join-Path $env:FREE_CODE_E2E_ROOT "claude-config"

Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null
New-Item -ItemType Directory -Force $env:CLAUDE_CONFIG_DIR | Out-Null

$Project = Join-Path $env:FREE_CODE_E2E_ROOT "project"
New-Item -ItemType Directory -Force "$Project\src" | Out-Null
New-Item -ItemType Directory -Force "$Project\.claude\skills\write-trigger-skill" | Out-Null

& $env:FREE_CODE_CLI --version
```

期望输出：

- `npm run build` 成功。
- `.\cli.exe` 存在。
- `$env:FREE_CODE_CLI` 指向当前项目目录下的构建产物。
- `$env:CLAUDE_CONFIG_DIR` 指向 `D:\tmp\free-code-file-write-tool-e2e\claude-config`。
- 版本号正常输出。

### 2.3 准备测试项目文件

```powershell
Set-Content -Path "$Project\src\existing.txt" -Value "line one`nline two`nline three" -NoNewline -Encoding UTF8
[System.IO.File]::WriteAllText("$Project\src\crlf-existing.txt", "one`r`ntwo`r`nthree`r`n", [System.Text.UTF8Encoding]::new($false))
Set-Content -Path "$Project\src\conflict.txt" -Value "original conflict content" -NoNewline -Encoding UTF8

@'
---
description: Skill activated when generated TypeScript files are written
paths: generated/**/*.ts
user-invocable: true
---

When active, this skill contributes:

WRITE_TOOL_CONDITIONAL_SKILL_ACTIVE
'@ | Set-Content -Encoding UTF8 "$Project\.claude\skills\write-trigger-skill\SKILL.md"

Get-ChildItem -Recurse $Project
Set-Location $Project
```

期望输出：

- `src\existing.txt` 存在。
- `src\crlf-existing.txt` 存在。
- `src\conflict.txt` 存在。
- `.claude\skills\write-trigger-skill\SKILL.md` 存在。

## 3. 用例 1：创建新文件

### 验证目标

验证 Write 工具能创建不存在的文件，并返回 create 类型结果。

### 操作步骤

```powershell
$Target = Join-Path $Project "src\created.txt"
& $env:FREE_CODE_CLI --print --output-format text --max-turns 5 --allowed-tools "Write,Read" --permission-mode acceptEdits "请使用 Write 工具创建文件 $Target，内容必须只有一行：WRITE_CREATE_OK。创建后读取它确认。"
Get-Content $Target
```

### 期望输出

```text
WRITE_CREATE_OK
```

说明：

- 新文件不存在时，`validateInput()` 允许创建。
- `call()` 返回 create 结果。
- 磁盘文件真实存在。

## 4. 用例 2：创建嵌套目录中的新文件

### 验证目标

验证 Write 工具写入前会创建父目录。

### 操作步骤

```powershell
$NestedTarget = Join-Path $Project "generated\nested\deep\created.ts"
& $env:FREE_CODE_CLI --print --output-format text --max-turns 5 --allowed-tools "Write,Read" --permission-mode acceptEdits "请使用 Write 工具创建文件 $NestedTarget，内容必须是：export const nestedWrite = 'WRITE_NESTED_OK'。创建后读取它确认。"
Get-Content $NestedTarget
Test-Path (Split-Path $NestedTarget)
```

### 期望输出

文件内容包含：

```text
WRITE_NESTED_OK
```

目录检查输出：

```text
True
```

说明：

- 覆盖 `getFsImplementation().mkdir(dir)` 创建父目录的路径。

## 5. 用例 3：覆盖已存在文件前必须先 Read

### 验证目标

验证已存在文件如果没有先完整读取，Write 应被拒绝。

### 操作步骤

只允许 Write，不允许 Read，迫使模型无法先读取：

```powershell
$Existing = Join-Path $Project "src\existing.txt"
& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 --allowed-tools "Write" --permission-mode acceptEdits "请直接使用 Write 工具把 $Existing 的完整内容覆盖为 SHOULD_NOT_WRITE，不要读取文件。请总结工具结果。"
Get-Content $Existing
```

### 期望输出

CLI 输出应说明：

```text
File has not been read yet
```

文件内容仍应包含：

```text
line one
line two
line three
```

说明：

- 覆盖 `validateInput()` 中 `readFileState` 缺失分支。
- 文件不应被覆盖为 `SHOULD_NOT_WRITE`。

## 6. 用例 4：先 Read 后完整覆盖已有文件

### 验证目标

验证已有文件在先完整读取后，可以使用 Write 完整覆盖，并返回 update 类型结果。

### 操作步骤

```powershell
$Existing = Join-Path $Project "src\existing.txt"
& $env:FREE_CODE_CLI --print --output-format text --max-turns 6 --allowed-tools "Read,Write" --permission-mode acceptEdits "请先读取 $Existing，然后使用 Write 工具把它完整覆盖为三行：UPDATED_ONE、UPDATED_TWO、UPDATED_THREE。完成后读取文件确认。"
Get-Content $Existing
```

### 期望输出

```text
UPDATED_ONE
UPDATED_TWO
UPDATED_THREE
```

说明：

- 覆盖 `oldContent` 非空的 update 路径。
- 写入结果应有结构化 diff。
- `readFileState` 会被更新为新内容和新 mtime。

## 7. 用例 5：Read 后外部修改，Write 应拒绝覆盖

### 验证目标

验证新鲜度检查能阻止覆盖用户或外部工具在 Read 之后做出的修改。

### 操作步骤

1. 重置文件：

```powershell
Set-Content -Path "$Project\src\conflict.txt" -Value "original conflict content" -NoNewline -Encoding UTF8
```

2. 启动交互式 CLI：

```powershell
& $env:FREE_CODE_CLI
```

3. 在 CLI 中输入：

```text
请先读取 src/conflict.txt，然后等我确认后，再使用 Write 工具把完整内容改成 model write content。
```

4. 等 CLI 已经读取文件但尚未写入时，在另一个 PowerShell 窗口执行：

```powershell
Set-Content -Path "D:\tmp\free-code-file-write-tool-e2e\project\src\conflict.txt" -Value "external changed content" -NoNewline -Encoding UTF8
```

5. 回到 CLI，让它继续写入。

### 期望输出

- CLI 应提示文件自读取后已经被修改，或要求重新读取。
- 文件最终不应被静默覆盖。

检查：

```powershell
Get-Content "$Project\src\conflict.txt"
```

期望仍能看到：

```text
external changed content
```

说明：

- 覆盖 `lastWriteTime > readTimestamp.timestamp` 或同步区间二次校验分支。

## 8. 用例 6：CRLF 旧文件被 Write 覆盖后的换行行为

### 验证目标

验证 FileWriteTool 调用 `writeTextContent(fullFilePath, content, enc, 'LF')`，覆盖写入时使用模型提供内容的 LF 风格，而不是保留旧文件 CRLF。

### 操作步骤

```powershell
$Crlf = Join-Path $Project "src\crlf-existing.txt"
& $env:FREE_CODE_CLI --print --output-format text --max-turns 6 --allowed-tools "Read,Write" --permission-mode acceptEdits "请先读取 $Crlf，然后使用 Write 工具把它完整覆盖为三行：LF_ONE、LF_TWO、LF_THREE。"

$bytes = [System.IO.File]::ReadAllBytes($Crlf)
($bytes | Where-Object { $_ -eq 13 }).Count
($bytes | Where-Object { $_ -eq 10 }).Count
Get-Content $Crlf
```

### 期望输出

- 文件内容包含 `LF_ONE`、`LF_TWO`、`LF_THREE`。
- CR 字节数量通常为 `0`。
- LF 字节数量大于等于 `2`。

说明：

- 这与 Edit 工具不同：FileWriteTool 的完整覆盖路径明确传入 `'LF'`。

## 9. 用例 7：写入触发条件技能 paths 激活

### 验证目标

验证 FileWriteTool 写入路径后会调用 `activateConditionalSkillsForPaths()`，使匹配 `paths` 的条件技能在后续上下文中可见。

### 操作步骤

条件技能激活状态属于同一会话，因此使用交互式 CLI：

```powershell
& $env:FREE_CODE_CLI
```

依次输入：

```text
/context
请使用 Write 工具创建 generated/from-write.ts，内容为 export const fromWrite = true。
/context
```

### 期望输出

- 文件 `generated\from-write.ts` 被创建。
- 第二次 `/context` 的 Skills 区域应出现 `write-trigger-skill`，或至少不应出现 frontmatter/YAML 解析错误。

检查文件：

```powershell
Test-Path "$Project\generated\from-write.ts"
```

期望：

```text
True
```

说明：

- 覆盖写入路径触发条件技能激活的链路。

## 10. 用例 8：Write 不应通过 PowerShell/Bash 旁路写文件

### 验证目标

验证在只允许 Write/Read 的情况下，用户要求创建文件时模型应使用 Write 工具，而不是 Shell 重定向等旁路方式。

### 操作步骤

```powershell
$Target = Join-Path $Project "src\write-tool-only.txt"
& $env:FREE_CODE_CLI --print --output-format text --max-turns 5 --allowed-tools "Write,Read" --permission-mode acceptEdits "请创建 $Target，内容只有 WRITE_TOOL_ONLY_OK。不要使用 Bash 或 PowerShell。创建后读取确认。"
Get-Content $Target
```

### 期望输出

```text
WRITE_TOOL_ONLY_OK
```

说明：

- 该用例验证实际用户路径中 Write 工具可完成创建任务。
- `--allowed-tools "Write,Read"` 限制了 shell 工具。

## 11. 用例 9：长文件创建结果会被 UI 截断，但磁盘内容完整

### 验证目标

验证 FileWrite UI 对新建长文件只预览部分内容，但写入到磁盘的内容完整。

### 操作步骤

```powershell
$LongTarget = Join-Path $Project "src\long-created.txt"
$Prompt = "请使用 Write 工具创建文件 $LongTarget，内容为 20 行，依次是 LINE_01 到 LINE_20。创建后只回答是否创建成功。"
& $env:FREE_CODE_CLI --print --output-format text --max-turns 5 --allowed-tools "Write" --permission-mode acceptEdits $Prompt

(Get-Content $LongTarget).Count
Get-Content $LongTarget
```

### 期望输出

行数：

```text
20
```

文件内容应包含：

```text
LINE_01
LINE_20
```

说明：

- UI 的 `isResultTruncated()` 只影响展示，不影响真实写入内容。

## 12. 清理

```powershell
Set-Location (Split-Path $env:FREE_CODE_CLI)
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:\FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:\FREE_CODE_CLI -ErrorAction SilentlyContinue
Remove-Item Env:\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
```

## 13. 验收标准

- 所有用例的测试文件只出现在 `D:\tmp\free-code-file-write-tool-e2e` 下。
- 当前仓库根目录不新增测试 `.claude` 数据。
- 新建文件、嵌套目录创建、未 Read 拒绝覆盖、Read 后覆盖、外部修改冲突、LF 覆盖行为、条件技能激活、长内容完整写入均符合预期。
