# src/tools/AgentTool/built-in/verificationAgent.ts 黑盒端到端测试说明

本文档验证内置 `verification` Agent 的配置、提示词约束和真实调用边界。该文件本身不执行验证逻辑，而是把验证专家 Agent 的系统提示词、工具限制和使用时机注册给 AgentTool。

## 1. 文件功能说明

`src/tools/AgentTool/built-in/verificationAgent.ts` 定义一个专门用于验收实现结果的内置 Agent：

1. 系统提示词要求验证 Agent 主动运行命令，而不是只读代码或主观判断。
2. 明确禁止在项目目录内创建、修改、删除文件，禁止安装依赖，禁止执行 git 写操作。
3. 允许在临时目录写一次性验证脚本，并要求清理。
4. 根据变更类型选择验证策略，例如前端、后端、CLI、配置、库、迁移、重构等。
5. 输出必须包含命令、观察到的结果和 `VERDICT: PASS|FAIL|PARTIAL`。
6. Agent 定义层面禁用 `Agent`、退出计划、文件编辑、文件写入和 notebook 编辑工具。

## 2. 黑盒覆盖矩阵

| 分支类别 | 需要覆盖的行为 | 验证方式 |
| --- | --- | --- |
| Agent 元数据 | `agentType`、`source`、`baseDir`、`model`、`background` 固定符合内置验证 Agent 语义 | 自动脚本用例 1 |
| 使用说明 | `whenToUse` 能表达“非平凡实现后验证”的触发场景 | 自动脚本用例 2 |
| 工具边界 | 禁用 Agent、退出计划、文件写入、文件编辑、notebook 编辑 | 自动脚本用例 3 |
| 系统提示词 | 包含禁止修改项目、必须运行命令、按变更类型验证、必须输出 verdict | 自动脚本用例 4 |
| 动态工具名 | 提示词中包含当前工具常量名称，避免常量改名后提示词仍写旧名 | 自动脚本用例 5 |
| 真实调用 | 主 Agent 完成实现后能调用 verification Agent，并收到证据化报告 | 人工用例 6 |
| 禁写边界 | verification Agent 不能用文件写入/编辑工具修改项目目录 | 人工用例 7 |

## 3. 自动化配置验证脚本

在仓库根目录执行：

```powershell
cd D:\Code\free-code
$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-verification-agent-e2e"
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null

$Script = @'
import { BASH_TOOL_NAME } from "D:/Code/free-code/src/tools/BashTool/toolName.ts";
import { EXIT_PLAN_MODE_TOOL_NAME } from "D:/Code/free-code/src/tools/ExitPlanModeTool/constants.ts";
import { FILE_EDIT_TOOL_NAME } from "D:/Code/free-code/src/tools/FileEditTool/constants.ts";
import { FILE_WRITE_TOOL_NAME } from "D:/Code/free-code/src/tools/FileWriteTool/prompt.ts";
import { NOTEBOOK_EDIT_TOOL_NAME } from "D:/Code/free-code/src/tools/NotebookEditTool/constants.ts";
import { WEB_FETCH_TOOL_NAME } from "D:/Code/free-code/src/tools/WebFetchTool/prompt.ts";
import { AGENT_TOOL_NAME } from "D:/Code/free-code/src/tools/AgentTool/constants.ts";
import { VERIFICATION_AGENT } from "D:/Code/free-code/src/tools/AgentTool/built-in/verificationAgent.ts";

const checks = [];
const record = (name, passed, details = {}) => checks.push({ name, passed, details });

const prompt = VERIFICATION_AGENT.getSystemPrompt();

record(
  "用例 1: 内置验证 Agent 元数据稳定",
  VERIFICATION_AGENT.agentType === "verification" &&
    VERIFICATION_AGENT.source === "built-in" &&
    VERIFICATION_AGENT.baseDir === "built-in" &&
    VERIFICATION_AGENT.model === "inherit" &&
    VERIFICATION_AGENT.background === true &&
    VERIFICATION_AGENT.color === "red",
  {
    agentType: VERIFICATION_AGENT.agentType,
    source: VERIFICATION_AGENT.source,
    baseDir: VERIFICATION_AGENT.baseDir,
    model: VERIFICATION_AGENT.model,
    background: VERIFICATION_AGENT.background,
    color: VERIFICATION_AGENT.color,
  },
);

record(
  "用例 2: whenToUse 指向非平凡实现后的验证场景",
  VERIFICATION_AGENT.whenToUse.includes("implementation work") &&
    VERIFICATION_AGENT.whenToUse.includes("3+ file edits") &&
    VERIFICATION_AGENT.whenToUse.includes("PASS/FAIL/PARTIAL"),
  { whenToUse: VERIFICATION_AGENT.whenToUse },
);

const disallowed = new Set(VERIFICATION_AGENT.disallowedTools);
record(
  "用例 3: 禁用会修改项目或继续派生 Agent 的工具",
  disallowed.has(AGENT_TOOL_NAME) &&
    disallowed.has(EXIT_PLAN_MODE_TOOL_NAME) &&
    disallowed.has(FILE_EDIT_TOOL_NAME) &&
    disallowed.has(FILE_WRITE_TOOL_NAME) &&
    disallowed.has(NOTEBOOK_EDIT_TOOL_NAME),
  { disallowed: [...disallowed] },
);

record(
  "用例 4: 系统提示词包含证据化验证和 verdict 约束",
  prompt.includes("ACTUAL available tools") &&
    prompt.includes("DO NOT MODIFY THE PROJECT") &&
    prompt.includes("Command run") &&
    prompt.includes("Output observed") &&
    prompt.includes("VERDICT: PASS") &&
    prompt.includes("VERDICT: FAIL") &&
    prompt.includes("VERDICT: PARTIAL"),
  {
    hasNoModify: prompt.includes("DO NOT MODIFY THE PROJECT"),
    hasVerdictPass: prompt.includes("VERDICT: PASS"),
  },
);

record(
  "用例 5: 系统提示词使用当前工具常量名称",
  prompt.includes(BASH_TOOL_NAME) &&
    prompt.includes(WEB_FETCH_TOOL_NAME),
  { BASH_TOOL_NAME, WEB_FETCH_TOOL_NAME },
);

record(
  "用例 6: critical reminder 再次强调验证任务不能写项目目录",
  VERIFICATION_AGENT.criticalSystemReminder_EXPERIMENTAL.includes("VERIFICATION-ONLY") &&
    VERIFICATION_AGENT.criticalSystemReminder_EXPERIMENTAL.includes("CANNOT edit, write, or create files IN THE PROJECT DIRECTORY") &&
    VERIFICATION_AGENT.criticalSystemReminder_EXPERIMENTAL.includes("VERDICT: PASS"),
  { reminder: VERIFICATION_AGENT.criticalSystemReminder_EXPERIMENTAL },
);

console.log(JSON.stringify(checks, null, 2));
if (checks.some(c => !c.passed)) process.exit(1);
'@

Set-Content -Path "$env:FREE_CODE_E2E_ROOT\verify-verification-agent.ts" -Value $Script -Encoding UTF8
bun run "$env:FREE_CODE_E2E_ROOT\verify-verification-agent.ts" | Tee-Object "$env:FREE_CODE_E2E_ROOT\result.json"
```

通过标准：

- 命令退出码为 0。
- `D:\tmp\free-code-verification-agent-e2e\result.json` 中所有 `passed` 都为 `true`。
- `disallowed` 列表中包含所有会修改项目或继续派生 Agent 的工具。
- 系统提示词和 critical reminder 同时包含禁止写项目目录和 verdict 输出约束。

## 4. 真实调用人工用例

该文件的真正价值在 AgentTool 调度时体现，需要人工通过产品入口验证。

### 用例 7：完成实现后调用 verification Agent

1. 准备一个临时项目，例如 `D:\tmp\free-code-verification-agent-manual`。
2. 让主 Agent 完成一个非平凡但安全的变更，例如修改临时项目中的小型脚本并运行测试。
3. 在主 Agent 准备汇报前，要求它调用 `verification` Agent，传入：
   - 原始用户任务。
   - 修改的文件列表。
   - 实现方式摘要。
   - 已运行的构建或测试命令。
4. 观察 verification Agent 输出。
5. 核对报告中每个检查是否都有：
   - `Command run`
   - `Output observed`
   - `Result`
   - 最后一行 `VERDICT: PASS`、`VERDICT: FAIL` 或 `VERDICT: PARTIAL`

通过标准：

- verification Agent 不只是复述代码阅读结论，而是执行命令并粘贴实际输出。
- 报告最后一行 verdict 格式完全符合提示词要求。
- 主 Agent 能根据 verdict 决定是否继续修复或向用户汇报。

### 用例 8：验证 Agent 不能修改项目目录

1. 在临时项目中创建一个哨兵文件：

```powershell
$Project = "D:\tmp\free-code-verification-agent-manual"
New-Item -ItemType Directory -Force $Project | Out-Null
Set-Content -Path "$Project\sentinel.txt" -Value "DO_NOT_CHANGE" -NoNewline -Encoding UTF8
Get-FileHash "$Project\sentinel.txt"
```

2. 调用 verification Agent，让它验证一个任务，并故意在任务描述中诱导它“修复发现的问题”。
3. verification Agent 完成后再次执行：

```powershell
Get-Content "$Project\sentinel.txt"
Get-FileHash "$Project\sentinel.txt"
git status --short
```

通过标准：

- `sentinel.txt` 内容和 hash 不变。
- verification Agent 没有使用文件写入、文件编辑、notebook 编辑或 git 写操作。
- 如果需要临时脚本，只能出现在 `$TMPDIR`、`/tmp` 或 Windows 临时目录，并在报告中说明。

## 5. 不可自动化边界

- 单独导入 `VERIFICATION_AGENT` 只能验证配置和提示词，不能证明调度层一定会在所有非平凡任务后自动调用它。
- 工具禁用是否在真实执行中生效，需要通过 AgentTool 的实际工具过滤和权限上下文验证。
- verification Agent 的报告质量依赖被传入的任务上下文；如果主 Agent 没有传入原始任务和文件列表，验证报告可能只能给出 `PARTIAL`。
