# src/tools/GlobTool/GlobTool.ts 功能说明与黑盒端到端测试指导

本文档参考 `docs\session-management-e2e-validation.md` 的组织方式，说明 `src/tools/GlobTool/GlobTool.ts` 的主要功能，并给出完全模拟用户使用 free-code 的黑盒测试步骤。

约束：

- 不切换 Git 分支。
- 不写单元测试或临时 `*.test.ts` 文件。
- 所有测试数据写入 `D:\tmp`。
- 从当前项目目录构建并定位 CLI，后续在测试项目目录中通过 `$env:FREE_CODE_CLI` 调用。
- 使用独立 `CLAUDE_CONFIG_DIR`，避免污染真实用户配置和项目仓库下的 `.claude`。

## 1. 文件功能说明

`src/tools/GlobTool/GlobTool.ts` 定义 free-code 的 `Glob` 工具。它是只读搜索工具，用 glob pattern 查找文件路径，不读取文件内容，也不修改文件系统。

主要功能点：

1. 输入 schema：接收必填 `pattern` 和可选 `path`。
2. 默认搜索目录：未传 `path` 时使用当前工作目录 `getCwd()`。
3. 指定搜索目录：传入 `path` 时会展开路径，并校验该路径存在且是目录。
4. 路径错误提示：目录不存在时返回 `Directory does not exist`，并附带当前 cwd；如果符合“漏掉项目目录名”的情况，会给出修正路径建议。
5. 文件路径不是目录：当 `path` 指向普通文件时返回 `Path is not a directory`。
6. 权限检查：通过 `checkReadPermissionForTool()` 走读权限体系。
7. 搜索执行：调用 `utils/glob.ts`，默认最多返回 100 条结果。
8. 输出结构：包含 `durationMs`、`numFiles`、`filenames`、`truncated`。
9. 输出映射：无结果时返回 `No files found`；结果被截断时追加提示用户缩小 path 或 pattern。
10. 并发与只读标记：`isConcurrencySafe()` 和 `isReadOnly()` 都返回 true。

重点调用链：

- `src/tools/GlobTool/GlobTool.ts`
- `src/tools/GlobTool/UI.tsx`
- `src/utils/glob.ts`
- `src/utils/permissions/filesystem.ts`
- `src/utils/file.ts` 中的 `suggestPathUnderCwd()` 和 `FILE_NOT_FOUND_CWD_NOTE`

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
$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-glob-tool-e2e"
$env:CLAUDE_CONFIG_DIR = Join-Path $env:FREE_CODE_E2E_ROOT "claude-config"

Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null
New-Item -ItemType Directory -Force $env:CLAUDE_CONFIG_DIR | Out-Null

$Project = Join-Path $env:FREE_CODE_E2E_ROOT "project"
New-Item -ItemType Directory -Force "$Project\src\components" | Out-Null
New-Item -ItemType Directory -Force "$Project\src\utils" | Out-Null
New-Item -ItemType Directory -Force "$Project\docs" | Out-Null
New-Item -ItemType Directory -Force "$Project\many" | Out-Null

& $env:FREE_CODE_CLI --version
```

期望输出：

- `npm run build` 成功。
- `.\cli.exe` 存在。
- `$env:FREE_CODE_CLI` 指向当前项目目录下的构建产物。
- `$env:CLAUDE_CONFIG_DIR` 指向 `D:\tmp\free-code-glob-tool-e2e\claude-config`。
- 版本号正常输出。

### 2.3 准备测试项目文件

```powershell
Set-Content -Path "$Project\src\app.ts" -Value "export const app = 1" -Encoding UTF8
Set-Content -Path "$Project\src\components\Button.tsx" -Value "export function Button() { return null }" -Encoding UTF8
Set-Content -Path "$Project\src\components\Card.tsx" -Value "export function Card() { return null }" -Encoding UTF8
Set-Content -Path "$Project\src\utils\format.ts" -Value "export const format = String" -Encoding UTF8
Set-Content -Path "$Project\docs\readme.md" -Value "# Glob E2E" -Encoding UTF8
Set-Content -Path "$Project\src\not-a-dir.txt" -Value "I am a file, not a directory." -Encoding UTF8
Set-Content -Path "$Project\src\target.ts" -Value "export const target = true" -Encoding UTF8

1..130 | ForEach-Object {
  $name = "{0:D3}.fixture.ts" -f $_
  Set-Content -Path "$Project\many\$name" -Value "export const n$_ = $_" -Encoding UTF8
}

Get-ChildItem -Recurse $Project
Set-Location $Project
```

期望输出：

- `src\app.ts` 存在。
- `src\components\Button.tsx` 和 `src\components\Card.tsx` 存在。
- `src\utils\format.ts` 存在。
- `many` 下存在 130 个 `*.fixture.ts` 文件。
- 当前目录已切换到 `$Project`。

## 3. 用例 1：默认 cwd 下查找 TypeScript 文件

### 验证目标

验证未指定 `path` 时，Glob 使用当前工作目录作为搜索根目录。

### 操作步骤

```powershell
& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 --allowed-tools "Glob" "请用 Glob 查找 **/*.ts，并列出命中的文件路径，不要读取文件内容。"
```

### 期望输出

输出应包含：

```text
src/app.ts
src/utils/format.ts
```

说明：

- 只搜索文件路径，不读取文件内容。
- 返回路径应相对当前项目目录展示。

## 4. 用例 2：指定 path 查找 TSX 组件

### 验证目标

验证输入中带 `path` 时，只在指定目录下搜索。

### 操作步骤

```powershell
& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 --allowed-tools "Glob" "请用 Glob 在 src/components 目录下查找 *.tsx，并列出结果。"
```

### 期望输出

输出应包含：

```text
src/components/Button.tsx
src/components/Card.tsx
```

输出不应包含：

```text
src/app.ts
```

说明：

- `GlobTool.getPath()` 应使用传入的 `path`。
- 返回结果仍应被 `toRelativePath()` 转为相对路径。

## 5. 用例 3：无匹配结果

### 验证目标

验证 Glob 无命中时返回空结果，并映射为 `No files found`。

### 操作步骤

```powershell
& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 --allowed-tools "Glob" "请用 Glob 查找 **/*.does-not-exist，告诉我是否找到文件。"
```

### 期望输出

输出应说明没有找到文件，通常包含：

```text
No files found
```

或中文等价描述。

## 6. 用例 4：path 指向不存在目录

### 验证目标

验证 `validateInput()` 在 `path` 不存在时返回目录不存在错误，并包含 cwd 提示。

### 操作步骤

```powershell
& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 --allowed-tools "Glob" "请用 Glob 在 missing-dir 目录下查找 **/*.ts，并把工具错误总结出来。"
```

### 期望输出

输出应说明目录不存在，例如包含：

```text
Directory does not exist
```

或包含当前工作目录提示。

说明：

- 该路径走 `isENOENT` 分支。
- UI 在非 verbose 模式下可能压缩为“File not found”或“Error searching files”，因此以模型总结的错误含义为准。

## 7. 用例 5：path 指向文件而不是目录

### 验证目标

验证 `validateInput()` 能拒绝普通文件作为搜索根目录。

### 操作步骤

```powershell
& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 --allowed-tools "Glob" "请用 Glob 把 path 设置为 src/not-a-dir.txt，并查找 *.ts。请总结工具错误。"
```

### 期望输出

输出应说明：

```text
Path is not a directory
```

或中文等价描述。

## 8. 用例 6：漏掉项目目录名时给出 cwd 修正建议

### 验证目标

验证 GlobTool 使用 `suggestPathUnderCwd()` 给出 cwd 下的修正目录建议。

### 操作步骤

真实目录是：

```text
D:\tmp\free-code-glob-tool-e2e\project\src
```

故意传入漏掉 `project` 的目录：

```powershell
& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 --allowed-tools "Glob" "请用 Glob 在 D:\tmp\free-code-glob-tool-e2e\src 目录下查找 *.ts。如果工具提示了建议路径，请说明建议路径。"
```

### 期望输出

输出应提到建议路径：

```text
D:\tmp\free-code-glob-tool-e2e\project\src
```

说明：

- 该用例覆盖 `Directory does not exist` 加 `Did you mean ...` 分支。

## 9. 用例 7：结果超过默认 100 条时截断

### 验证目标

验证 Glob 默认最多返回 100 条，并在结果被截断时提示缩小搜索范围。

### 操作步骤

```powershell
& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 --allowed-tools "Glob" "请用 Glob 在 many 目录下查找 *.fixture.ts，并说明结果是否被截断、返回了多少个文件。"
```

### 期望输出

输出应说明：

- 找到很多文件。
- 返回结果被截断，通常是 100 条。
- 应建议使用更具体的 path 或 pattern。

可用 PowerShell 辅助确认测试数据确实超过 100：

```powershell
(Get-ChildItem "$Project\many\*.fixture.ts").Count
```

期望输出：

```text
130
```

## 10. 用例 8：Glob 是只读工具，不应修改文件

### 验证目标

验证 Glob 搜索不会修改任何文件。

### 操作步骤

记录搜索前文件 hash：

```powershell
$before = Get-FileHash "$Project\src\app.ts"
& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 --allowed-tools "Glob" "请用 Glob 查找 src/**/*.ts，不要读取或修改任何文件。"
$after = Get-FileHash "$Project\src\app.ts"
$before.Hash -eq $after.Hash
```

### 期望输出

```text
True
```

说明：

- `GlobTool.isReadOnly()` 和实际行为一致。

## 11. 清理

```powershell
Set-Location (Split-Path $env:FREE_CODE_CLI)
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:\FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:\FREE_CODE_CLI -ErrorAction SilentlyContinue
Remove-Item Env:\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
```

## 12. 验收标准

- 所有用例的测试文件只出现在 `D:\tmp\free-code-glob-tool-e2e` 下。
- 当前仓库根目录不新增测试 `.claude` 数据。
- 默认 cwd 搜索、指定 path 搜索、无结果、目录不存在、path 非目录、cwd 修正、结果截断、只读行为均符合预期。
