# src/utils/file.ts 功能说明与黑盒端到端测试指导

本文档参考 `docs\session-management-e2e-validation.md` 的组织方式，说明 `src/utils/file.ts` 的主要功能，并给出完全模拟用户使用 free-code 的黑盒测试步骤。

约束：

- 不切换 Git 分支。
- 不写单元测试或临时 `*.test.ts` 文件。
- 所有测试数据写入 `D:\tmp`。
- 从当前项目目录构建并定位 CLI，后续在测试项目目录中通过 `$env:FREE_CODE_CLI` 调用。
- 使用独立 `CLAUDE_CONFIG_DIR`，避免污染真实用户配置和项目仓库下的 `.claude`。

## 1. 文件功能说明

`src/utils/file.ts` 是 free-code 的通用文件系统工具层。用户在 CLI 中读取文件、编辑文件、写文件、访问不存在路径、处理 CRLF 文件、读取大文件、展示路径时，都会间接走到这个文件中的能力。

主要功能点：

1. 文件存在性与安全读取：`pathExists()`、`readFileSafe()`、`readFileSyncCached()`。
2. 文件修改时间：`getFileModificationTime()`、`getFileModificationTimeAsync()`，用于编辑前后冲突检测。
3. 文本写入、编码和换行：`writeTextContent()`、`detectFileEncoding()`、`detectLineEndings()`，用于保留原文件编码和 LF/CRLF 风格。
4. 文本展示：`convertLeadingTabsToSpaces()`、`addLineNumbers()`、`stripLineNumberPrefix()`，用于 Read/Edit 工具面向模型的内容格式。
5. 路径处理：`getDisplayPath()`、`findSimilarFile()`、`suggestPathUnderCwd()`、`normalizePathForComparison()`、`pathsEqual()`。
6. 目录和大小限制：`isDirEmpty()`、`isFileWithinReadSizeLimit()`、`getDesktopPath()`。

重点调用链：

- `src/tools/FileReadTool/FileReadTool.ts`
- `src/tools/FileEditTool/FileEditTool.ts`
- `src/tools/FileWriteTool/FileWriteTool.ts`
- `src/tools/BashTool/BashTool.tsx`
- `src/tools/NotebookEditTool/NotebookEditTool.ts`
- 多个 UI 组件中的路径展示逻辑

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
$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-file-utils-e2e"
$env:CLAUDE_CONFIG_DIR = Join-Path $env:FREE_CODE_E2E_ROOT "claude-config"

Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null
New-Item -ItemType Directory -Force $env:CLAUDE_CONFIG_DIR | Out-Null
New-Item -ItemType Directory -Force (Join-Path $env:FREE_CODE_E2E_ROOT "project\src") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $env:FREE_CODE_E2E_ROOT "project\empty-dir") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $env:FREE_CODE_E2E_ROOT "project\non-empty-dir") | Out-Null

& $env:FREE_CODE_CLI --version
```

期望输出：

- `npm run build` 成功。
- `.\cli.exe` 存在。
- `$env:FREE_CODE_CLI` 指向当前项目目录下的构建产物。
- `$env:CLAUDE_CONFIG_DIR` 指向 `D:\tmp\free-code-file-utils-e2e\claude-config`。
- 版本号正常输出。

### 2.3 准备测试项目文件

```powershell
$Project = Join-Path $env:FREE_CODE_E2E_ROOT "project"

Set-Content -Path "$Project\src\sample-lf.txt" -Value "alpha`nbeta`ngamma" -NoNewline -Encoding UTF8
[System.IO.File]::WriteAllText("$Project\src\sample-crlf.txt", "one`r`ntwo`r`nthree`r`n", [System.Text.UTF8Encoding]::new($false))
Set-Content -Path "$Project\src\module.ts" -Value "export const marker = 'similar-file-ts';" -Encoding UTF8
Set-Content -Path "$Project\src\tabs.txt" -Value "`tfirst`n`t`tsecond`nmid`tline" -NoNewline -Encoding UTF8
Set-Content -Path "$Project\src\target.txt" -Value "cwd-correction-ok" -NoNewline -Encoding UTF8
Set-Content -Path "$Project\non-empty-dir\item.txt" -Value "not empty" -Encoding UTF8

$large = "0123456789abcdef" * 20000
Set-Content -Path "$Project\src\large.txt" -Value $large -NoNewline -Encoding UTF8

Get-ChildItem -Recurse $Project
Set-Location $Project
```

期望输出：

- `src\sample-lf.txt`、`src\sample-crlf.txt`、`src\module.ts`、`src\tabs.txt`、`src\target.txt`、`src\large.txt` 存在。
- `empty-dir` 为空。
- `non-empty-dir` 非空。

## 3. 用例 1：正常读取 LF 文件

### 验证目标

验证 FileRead 链路能读取普通 UTF-8 LF 文件，并通过 `addLineNumbers()` 把内容提供给模型。

### 操作步骤

```powershell
& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 --allowed-tools "Read" "请读取 src/sample-lf.txt，并只回答文件的三行内容。不要改文件。"
```

### 期望输出

输出包含：

```text
alpha
beta
gamma
```

说明：

- `pathExists()` 或底层 stat 路径正常。
- Read 工具可读取 cwd 内相对路径。
- 文件不应被修改。

## 4. 用例 2：不存在文件触发相似文件提示

### 验证目标

验证 `findSimilarFile()` 能在读取不存在文件时，提示同目录同 basename 的其它扩展名文件。

### 操作步骤

```powershell
& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 --allowed-tools "Read" "请尝试读取 src/module.js。如果工具提示有相似文件，请说明它提示了哪个文件；不要读取其它文件。"
```

### 期望输出

输出应提到：

```text
module.ts
```

说明：

- `src/module.js` 不存在。
- `src/module.ts` 存在。
- CLI 不应崩溃。

## 5. 用例 3：漏掉项目目录名时给出 cwd 修正路径

### 验证目标

验证 `suggestPathUnderCwd()` 能处理“绝对路径漏掉当前项目目录名”的情况。

### 操作步骤

当前真实文件是：

```text
D:\tmp\free-code-file-utils-e2e\project\src\target.txt
```

故意读取漏掉 `project` 的路径：

```powershell
& $env:FREE_CODE_CLI --print --output-format text --max-turns 5 --allowed-tools "Read" "请读取 D:\tmp\free-code-file-utils-e2e\src\target.txt。如果工具提示当前工作目录下存在修正路径，请继续读取修正后的文件，并只回答最终文件内容。"
```

### 期望输出

输出包含：

```text
cwd-correction-ok
```

说明：

- 第一次请求路径不存在。
- CLI 应能提示或使用 cwd 下的修正路径。

## 6. 用例 4：编辑 CRLF 文件并保留换行符

### 验证目标

验证 `detectLineEndings()` 和 `writeTextContent()` 能在编辑 CRLF 文件时保留 CRLF，并避免产生 `\r\r\n`。

### 操作步骤

```powershell
& $env:FREE_CODE_CLI --print --output-format text --max-turns 5 --allowed-tools "Read,Edit" --permission-mode acceptEdits "请把 src/sample-crlf.txt 中的 two 改成 TWO_EDITED，只做这一处修改。"
```

检查文件内容和 CR/LF 数量：

```powershell
$file = Join-Path $Project "src\sample-crlf.txt"
[System.IO.File]::ReadAllText($file)
$bytes = [System.IO.File]::ReadAllBytes($file)
($bytes | Where-Object { $_ -eq 13 }).Count
($bytes | Where-Object { $_ -eq 10 }).Count
```

### 期望输出

- 文件内容包含 `TWO_EDITED`。
- CR 字节数量等于 LF 字节数量。
- 不应出现 CR 数量大于 LF 数量。

说明：

- CRLF 被保留。
- 没有写出 `\r\r\n`。

## 7. 用例 5：外部修改冲突保护

### 验证目标

验证 FileEdit 使用 `getFileModificationTime()` 检测文件读取后被外部修改的情况，避免静默覆盖。

### 操作步骤

1. 准备文件。

```powershell
Set-Content -Path "$Project\src\conflict.txt" -Value "start" -NoNewline -Encoding UTF8
```

2. 启动交互式 CLI。

```powershell
& $env:FREE_CODE_CLI
```

3. 在 CLI 中输入：

```text
请先读取 src/conflict.txt，然后等我下一步确认后再把 start 改成 model-edit。
```

4. 当 CLI 已经读取文件、但尚未编辑时，另开 PowerShell 窗口执行：

```powershell
Set-Content -Path "D:\tmp\free-code-file-utils-e2e\project\src\conflict.txt" -Value "external-edit" -NoNewline -Encoding UTF8
```

5. 回到 CLI，让它继续编辑。

### 期望输出

- CLI 应提示文件自读取后已被外部修改，或要求重新读取后再编辑。
- 文件不应被静默覆盖成错误内容。

## 8. 用例 6：读取行首 tab 文件

### 验证目标

验证 `convertLeadingTabsToSpaces()` 只影响展示给模型的内容，不修改磁盘文件。

### 操作步骤

```powershell
& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 --allowed-tools "Read" "请读取 src/tabs.txt，并说明第一行、第二行、第三行的可见文本。不要改文件。"
```

检查磁盘文件仍包含 tab：

```powershell
$raw = [System.IO.File]::ReadAllText("$Project\src\tabs.txt")
$raw.Contains("`t")
```

### 期望输出

```text
True
```

说明：

- CLI 可以理解带 tab 的内容。
- 磁盘文件没有被展示层逻辑改写。

## 9. 用例 7：大文件读取限制

### 验证目标

验证 `isFileWithinReadSizeLimit()` 能阻止或限制过大文件读取。

### 操作步骤

```powershell
& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 --allowed-tools "Read" "请读取 src/large.txt，并告诉我是否可以完整读取。不要使用 Bash。"
```

### 期望输出

- CLI 不应完整输出整个 `large.txt`。
- 应说明文件过大、无法完整读取，或只读取部分内容。

## 10. 用例 8：创建新文件

### 验证目标

验证 FileWrite 通过 `writeTextContent()` 创建新文件，并记录新的文件状态。

### 操作步骤

```powershell
& $env:FREE_CODE_CLI --print --output-format text --max-turns 5 --allowed-tools "Write,Read" --permission-mode acceptEdits "请创建 src/generated-by-freecode.txt，内容只有一行：created by free-code file utils e2e。创建后读取它确认。"
```

检查文件：

```powershell
Get-Content "$Project\src\generated-by-freecode.txt"
```

### 期望输出

```text
created by free-code file utils e2e
```

## 11. 用例 9：Windows 大小写路径读取

### 验证目标

验证 Windows 下大小写和斜杠差异不会导致正常文件读取失败。

### 操作步骤

```powershell
& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 --allowed-tools "Read" "请读取 SRC/SAMPLE-LF.TXT，并回答它是否等价于 src/sample-lf.txt。"
```

### 期望输出

输出包含：

```text
alpha
beta
gamma
```

说明：

- Windows 文件系统通常大小写不敏感。
- 路径归一化相关逻辑应保持稳定。

## 12. 清理

```powershell
Set-Location (Split-Path $env:FREE_CODE_CLI)
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:\FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:\FREE_CODE_CLI -ErrorAction SilentlyContinue
Remove-Item Env:\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
```

## 13. 验收标准

- 所有用例的测试文件只出现在 `D:\tmp\free-code-file-utils-e2e` 下。
- 当前仓库根目录不新增测试 `.claude` 数据。
- 普通读取、缺失文件提示、cwd 路径纠正、CRLF 编辑、外部修改冲突、大文件限制、新文件写入均符合预期。
