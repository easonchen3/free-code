# src/utils/frontmatterParser.ts 功能说明与黑盒端到端测试指导

本文档参考 `docs\session-management-e2e-validation.md` 的组织方式，说明 `src/utils/frontmatterParser.ts` 的主要功能，并给出完全模拟用户使用 free-code 的黑盒测试步骤。

约束：

- 不切换 Git 分支。
- 不写单元测试或临时 `*.test.ts` 文件。
- 所有测试数据写入 `D:\tmp`。
- 从当前项目目录构建并定位 CLI，后续在测试项目目录中通过 `$env:FREE_CODE_CLI` 调用。
- 使用独立 `CLAUDE_CONFIG_DIR`，避免污染真实用户配置和项目仓库下的 `.claude`。

## 1. 文件功能说明

`src/utils/frontmatterParser.ts` 是 free-code 解析 Markdown frontmatter 的统一入口。项目中很多 `.md` 文件会在开头使用 YAML frontmatter 声明元信息，例如技能、命令、agent、输出风格、CLAUDE.md 路径条件和记忆文件类型。

典型格式：

```markdown
---
description: Review TypeScript files
paths: src/*.{ts,tsx}
shell: powershell
user-invocable: true
---

正文内容
```

主要功能点：

1. `parseFrontmatter()`：提取文件开头的 YAML frontmatter，并返回去掉 frontmatter 后的正文。
2. YAML 容错：当 `paths: src/*.{ts,tsx}`、`description: value has colon: detail` 这类未加引号的值导致 YAML 初次解析失败时，会自动 quote 后重试。
3. `splitPathInFrontmatter()`：支持逗号拆分、brace 展开和 YAML list。
4. `parsePositiveIntFromFrontmatter()`：解析正整数。number 必须是正整数，string 使用 `parseInt`。
5. `coerceDescriptionToString()`：description 支持字符串、数字、布尔；数组和对象会被视为无效。
6. `parseBooleanFrontmatter()`：只有布尔 `true` 和字符串 `"true"` 返回 true。
7. `parseShellFrontmatter()`：只接受 `bash` 和 `powershell`，非法值回退默认行为。

重点调用链：

- `src/skills/loadSkillsDir.ts`
- `src/utils/plugins/loadPluginCommands.ts`
- `src/utils/plugins/loadPluginAgents.ts`
- `src/utils/claudemd.ts`
- `src/memdir/memoryScan.ts`
- `src/utils/plugins/validatePlugin.ts`

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
$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-frontmatter-e2e"
$env:CLAUDE_CONFIG_DIR = Join-Path $env:FREE_CODE_E2E_ROOT "claude-config"

Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null
New-Item -ItemType Directory -Force $env:CLAUDE_CONFIG_DIR | Out-Null

$Project = Join-Path $env:FREE_CODE_E2E_ROOT "project"
New-Item -ItemType Directory -Force "$Project\.claude\skills\frontmatter-visible" | Out-Null
New-Item -ItemType Directory -Force "$Project\.claude\skills\frontmatter-hidden" | Out-Null
New-Item -ItemType Directory -Force "$Project\.claude\skills\frontmatter-paths" | Out-Null
New-Item -ItemType Directory -Force "$Project\.claude\commands" | Out-Null
New-Item -ItemType Directory -Force "$Project\src" | Out-Null
New-Item -ItemType Directory -Force "$Project\docs" | Out-Null

& $env:FREE_CODE_CLI --version
```

期望输出：

- `npm run build` 成功。
- `.\cli.exe` 存在。
- `$env:FREE_CODE_CLI` 指向当前项目目录下的构建产物。
- `$env:CLAUDE_CONFIG_DIR` 指向 `D:\tmp\free-code-frontmatter-e2e\claude-config`。
- 版本号正常输出。

### 2.3 准备测试项目文件

```powershell
Set-Content -Path "$Project\src\app.ts" -Value "export const appMarker = 'frontmatter paths should activate';" -Encoding UTF8
Set-Content -Path "$Project\docs\note.md" -Value "# Note" -Encoding UTF8

@'
---
description: Visible skill with colon: detail and # marker
shell: powershell
user-invocable: true
---

When this skill is invoked, answer exactly:

FRONTMATTER_VISIBLE_OK
'@ | Set-Content -Encoding UTF8 "$Project\.claude\skills\frontmatter-visible\SKILL.md"

@'
---
description: Hidden skill
user-invocable: false
---

If this body appears from direct slash invocation, the user-invocable flag failed.
'@ | Set-Content -Encoding UTF8 "$Project\.claude\skills\frontmatter-hidden\SKILL.md"

@'
---
description: Conditional TypeScript skill
paths: src/*.{ts,tsx}
user-invocable: true
---

When active, this skill contributes the marker:

FRONTMATTER_PATHS_ACTIVE
'@ | Set-Content -Encoding UTF8 "$Project\.claude\skills\frontmatter-paths\SKILL.md"

@'
---
description: Legacy command with glob src/*.{ts,tsx}
argument-hint: <any text>
---

Reply exactly:

FRONTMATTER_COMMAND_OK
'@ | Set-Content -Encoding UTF8 "$Project\.claude\commands\frontmatter-command.md"

Get-ChildItem -Recurse $Project
Set-Location $Project
```

期望输出：

- `.claude\skills\frontmatter-visible\SKILL.md` 存在。
- `.claude\skills\frontmatter-hidden\SKILL.md` 存在。
- `.claude\skills\frontmatter-paths\SKILL.md` 存在。
- `.claude\commands\frontmatter-command.md` 存在。
- `src\app.ts` 和 `docs\note.md` 存在。

## 3. 用例 1：可调用技能正常加载

### 验证目标

验证 `parseFrontmatter()` 能解析技能 frontmatter，并且 `user-invocable: true` 允许用户通过 slash 命令调用技能。

### 操作步骤

```powershell
& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 "/frontmatter-visible"
```

### 期望输出

```text
FRONTMATTER_VISIBLE_OK
```

说明：

- `description` 中的 `colon: detail` 和 `# marker` 不应导致 YAML 解析失败。
- `shell: powershell` 是合法值。
- frontmatter 被剥离后，正文进入模型上下文。

## 4. 用例 2：user-invocable false 不暴露为用户 slash 命令

### 验证目标

验证 `parseBooleanFrontmatter()` 的严格布尔语义会让 `user-invocable: false` 生效。

### 操作步骤

```powershell
& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 "/frontmatter-hidden"
```

### 期望输出

- 不应输出 hidden 技能正文中的失败提示。
- 不应包含：

```text
If this body appears from direct slash invocation
```

说明：

- CLI 可以提示未知命令或命令不可用。
- 只要 hidden 技能正文没有被执行，即为通过。

## 5. 用例 3：legacy command 正常加载

### 验证目标

验证 `.claude\commands\*.md` 的 frontmatter 能被 legacy command loader 解析，正文能作为命令内容使用。

### 操作步骤

```powershell
& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 "/frontmatter-command test"
```

### 期望输出

```text
FRONTMATTER_COMMAND_OK
```

说明：

- `description` 和 `argument-hint` 被解析。
- `paths: src/*.{ts,tsx}` 这种 glob 字符不会破坏命令加载。

## 6. 用例 4：paths glob 不加引号也能解析并激活条件技能

### 验证目标

验证 `paths: src/*.{ts,tsx}` 会经过 YAML 容错和 brace 展开，并在触碰匹配文件后激活条件技能。

### 操作步骤

条件技能激活状态属于同一个会话，因此使用交互式 CLI：

```powershell
& $env:FREE_CODE_CLI
```

依次输入：

```text
/context
请读取 src/app.ts，并告诉我 appMarker 的值。
/context
```

### 期望输出

- 读取 `src/app.ts` 成功。
- 输出能看到 `frontmatter paths should activate`。
- 第二次 `/context` 的 Skills 区域应出现 `frontmatter-paths`，或至少不应出现 frontmatter/YAML 解析错误。

说明：

- `splitPathInFrontmatter()` 应把 `src/*.{ts,tsx}` 展开为 `src/*.ts` 和 `src/*.tsx`。
- 条件技能只应在匹配路径被触碰后激活。

## 7. 用例 5：paths 不匹配时不激活条件技能

### 验证目标

验证条件技能不会因为读取不匹配路径而激活。

### 操作步骤

创建干净副本：

```powershell
$Project2 = Join-Path $env:FREE_CODE_E2E_ROOT "project-nonmatch"
Remove-Item -Recurse -Force $Project2 -ErrorAction SilentlyContinue
Copy-Item $Project $Project2 -Recurse
Set-Location $Project2
```

启动交互式 CLI：

```powershell
& $env:FREE_CODE_CLI
```

依次输入：

```text
请读取 docs/note.md，然后回答标题。
/context
```

### 期望输出

- `docs/note.md` 读取成功。
- `/context` 中不应因为读取 `docs/note.md` 激活 `frontmatter-paths`。

## 8. 用例 6：非法 shell 值降级但不崩溃

### 验证目标

验证 `parseShellFrontmatter()` 对非法值返回默认行为，不导致整个技能加载失败。

### 操作步骤

```powershell
Set-Location $Project
New-Item -ItemType Directory -Force ".claude\skills\frontmatter-bad-shell" | Out-Null

@'
---
description: Bad shell should fall back
shell: zsh
user-invocable: true
---

Reply exactly:

FRONTMATTER_BAD_SHELL_LOADED
'@ | Set-Content -Encoding UTF8 ".claude\skills\frontmatter-bad-shell\SKILL.md"

& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 "/frontmatter-bad-shell"
```

### 期望输出

```text
FRONTMATTER_BAD_SHELL_LOADED
```

说明：

- `shell: zsh` 不被识别，但不应让 CLI 崩溃。

## 9. 用例 7：数组 description 被忽略但正文仍可用

### 验证目标

验证 `coerceDescriptionToString()` 会丢弃数组 description，但不影响 Markdown 正文被使用。

### 操作步骤

```powershell
New-Item -ItemType Directory -Force ".claude\skills\frontmatter-bad-description" | Out-Null

@'
---
description:
  - invalid
  - array
user-invocable: true
---

Reply exactly:

FRONTMATTER_BAD_DESCRIPTION_BODY_OK
'@ | Set-Content -Encoding UTF8 ".claude\skills\frontmatter-bad-description\SKILL.md"

& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 "/frontmatter-bad-description"
```

### 期望输出

```text
FRONTMATTER_BAD_DESCRIPTION_BODY_OK
```

## 10. 用例 8：损坏 YAML 不导致 CLI 整体崩溃

### 验证目标

验证 `parseFrontmatter()` 在首次解析失败、quote 重试仍失败后，会降级为空 frontmatter，并且不会导致 CLI 整体崩溃。

### 操作步骤

```powershell
New-Item -ItemType Directory -Force ".claude\skills\frontmatter-broken-yaml" | Out-Null

@'
---
description: ok
broken:
  - [unterminated
---

Reply exactly:

FRONTMATTER_BROKEN_YAML_BODY_VISIBLE
'@ | Set-Content -Encoding UTF8 ".claude\skills\frontmatter-broken-yaml\SKILL.md"

& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 "/context"
```

### 期望输出

- `/context` 正常返回上下文信息。
- CLI 不崩溃。
- 其它有效技能仍可使用。

说明：

- 损坏 YAML 的技能不一定能作为 slash command 暴露。
- 本用例关注降级和整体可用性。

## 11. 用例 9：无 frontmatter 的命令正文仍可执行

### 验证目标

验证没有 frontmatter 时，Markdown 正文保持原样。

### 操作步骤

```powershell
@'
Reply exactly:

FRONTMATTER_NO_METADATA_COMMAND_OK
'@ | Set-Content -Encoding UTF8 ".claude\commands\no-frontmatter-command.md"

& $env:FREE_CODE_CLI --print --output-format text --max-turns 3 "/no-frontmatter-command"
```

### 期望输出

```text
FRONTMATTER_NO_METADATA_COMMAND_OK
```

## 12. 清理

```powershell
Set-Location (Split-Path $env:FREE_CODE_CLI)
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:\FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:\FREE_CODE_CLI -ErrorAction SilentlyContinue
Remove-Item Env:\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
```

## 13. 验收标准

- 所有用例的测试文件只出现在 `D:\tmp\free-code-frontmatter-e2e` 下。
- 当前仓库根目录不新增测试 `.claude` 数据。
- 可调用技能、隐藏技能、legacy command、paths 条件技能、非法 shell、无效 description、损坏 YAML、无 frontmatter 命令均符合预期。
