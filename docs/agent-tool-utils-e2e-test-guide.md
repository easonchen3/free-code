# src/tools/AgentTool/agentToolUtils.ts 黑盒端到端测试说明

本文档验证 Agent 工具辅助逻辑的黑盒行为，覆盖工具过滤、工具声明解析、消息统计、结果收口、交接分类入口和异步 Agent 生命周期。该文件多数能力没有独立 CLI 命令入口，因此测试分为“可脚本化公开 API 验证”和“真实 Agent 调度入口人工验证”两部分。

## 1. 文件功能说明

`src/tools/AgentTool/agentToolUtils.ts` 是 AgentTool 的运行辅助模块，主要职责是：

1. 根据 Agent 类型、运行方式和权限模式过滤工具集合。
2. 解析 Agent 定义中的 `tools`、`disallowedTools` 和 `Agent(<types>)` 规则。
3. 统计 Agent 消息中的工具调用次数，并提取最近工具名或部分结果。
4. 将 Agent 消息流收口为 AgentTool 返回结果，附带 usage、耗时和分析事件。
5. 在自动权限模式下对 Agent 交接结果执行安全分类。
6. 驱动后台 Agent 的完整生命周期：消息流消费、进度更新、完成通知、终止通知、失败通知和清理。

## 2. 黑盒覆盖矩阵

| 分支类别 | 需要覆盖的行为 | 验证方式 |
| --- | --- | --- |
| 工具过滤 | MCP 工具保留、计划模式退出工具保留、全局禁用工具过滤、自定义 Agent 禁用工具过滤、异步 Agent 白名单过滤 | 自动脚本用例 1 |
| 工具解析 | `tools` 为空或 `*`、显式工具有效/无效、`disallowedTools` 移除、重复工具去重 | 自动脚本用例 2 |
| Agent 工具规则 | `Agent(worker,researcher)` 解析 allowedAgentTypes，子 Agent 场景只记录类型限制 | 自动脚本用例 3 |
| 消息统计 | 统计多个 assistant `tool_use`、读取最后工具名、非 assistant 返回空 | 自动脚本用例 4 |
| 结果收口 | 正常最终文本、最后一条只有工具调用时回退文本、没有 assistant 时抛错 | 自动脚本用例 5 |
| 部分结果 | 从后往前提取最新 assistant 文本，没有文本返回空 | 自动脚本用例 6 |
| 交接分类 | feature 未开、非 auto 模式、无法构造 transcript、允许、阻断、分类器不可用 | 自动脚本覆盖跳过分支；阻断/不可用走人工用例 7 |
| 异步生命周期 | 正常完成、AbortError 终止、普通异常失败、retain 消息追加、通知包含工作树信息、finally 清理 | 人工用例 8 |

## 3. 自动化公开 API 验证

在仓库根目录执行：

```powershell
cd D:\Code\free-code
$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-agent-tool-utils-e2e"
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null

$Script = @'
import {
  ASYNC_AGENT_ALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
} from "D:/Code/free-code/src/constants/tools.ts";
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from "D:/Code/free-code/src/tools/ExitPlanModeTool/constants.ts";
import { AGENT_TOOL_NAME } from "D:/Code/free-code/src/tools/AgentTool/constants.ts";
// 先加载 AgentTool 入口，避免直接导入工具辅助模块时触发循环依赖的初始化顺序问题。
import "D:/Code/free-code/src/tools/AgentTool/AgentTool.tsx";
import {
  classifyHandoffIfNeeded,
  countToolUses,
  extractPartialResult,
  filterToolsForAgent,
  finalizeAgentTool,
  getLastToolUseName,
  resolveAgentTools,
} from "D:/Code/free-code/src/tools/AgentTool/agentToolUtils.ts";

const tool = name => ({
  name,
  description: name,
  inputSchema: {},
  userFacingName: () => name,
});

const usage = {
  input_tokens: 3,
  output_tokens: 5,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  server_tool_use: null,
  service_tier: null,
  cache_creation: null,
};

const assistant = (id, content, requestId = undefined) => ({
  type: "assistant",
  requestId,
  message: {
    id,
    type: "message",
    role: "assistant",
    model: "test-model",
    stop_reason: "end_turn",
    stop_sequence: null,
    content,
    usage,
  },
});

const checks = [];
const record = (name, passed, details = {}) => checks.push({ name, passed, details });

const customDeniedName = [...CUSTOM_AGENT_DISALLOWED_TOOLS][0] ?? "NotebookEdit";
const asyncAllowedName = [...ASYNC_AGENT_ALLOWED_TOOLS][0] ?? "Read";

const filtered = filterToolsForAgent({
  tools: [
    tool("mcp__demo__tool"),
    tool(EXIT_PLAN_MODE_V2_TOOL_NAME),
    tool(customDeniedName),
    tool(asyncAllowedName),
    tool("DefinitelyAsyncBlockedTool"),
  ],
  isBuiltIn: false,
  isAsync: true,
  permissionMode: "plan",
}).map(t => t.name);

record(
  "用例 1: filterToolsForAgent 保留 MCP、计划退出工具和异步白名单，过滤自定义禁用和异步禁用工具",
  filtered.includes("mcp__demo__tool") &&
    filtered.includes(EXIT_PLAN_MODE_V2_TOOL_NAME) &&
    filtered.includes(asyncAllowedName) &&
    !filtered.includes(customDeniedName) &&
    !filtered.includes("DefinitelyAsyncBlockedTool"),
  { filtered, customDeniedName, asyncAllowedName },
);

const availableTools = [tool("Read"), tool("Write"), tool("Bash"), tool(AGENT_TOOL_NAME)];

const wildcard = resolveAgentTools(
  { tools: ["*"], disallowedTools: ["Write"], source: "project", permissionMode: "default" },
  availableTools,
  false,
  true,
);
record(
  "用例 2a: tools 为 * 时返回过滤后的全部工具",
  wildcard.hasWildcard === true &&
    wildcard.resolvedTools.some(t => t.name === "Read") &&
    !wildcard.resolvedTools.some(t => t.name === "Write"),
  { names: wildcard.resolvedTools.map(t => t.name) },
);

const explicit = resolveAgentTools(
  { tools: ["Read", "Read", "MissingTool"], disallowedTools: [], source: "project", permissionMode: "default" },
  availableTools,
  false,
  true,
);
record(
  "用例 2b: 显式工具解析有效、无效和去重",
  explicit.hasWildcard === false &&
    explicit.validTools.length === 2 &&
    explicit.invalidTools[0] === "MissingTool" &&
    explicit.resolvedTools.length === 1 &&
    explicit.resolvedTools[0].name === "Read",
  explicit,
);

const agentRule = resolveAgentTools(
  { tools: [`${AGENT_TOOL_NAME}(worker, researcher)`], disallowedTools: [], source: "project", permissionMode: "default" },
  availableTools,
  false,
  false,
);
record(
  "用例 3: 子 Agent 场景解析 Agent 规则中的 allowedAgentTypes",
  agentRule.validTools.length === 1 &&
    agentRule.allowedAgentTypes?.join("|") === "worker|researcher" &&
    agentRule.resolvedTools.length === 0,
  agentRule,
);

const messages = [
  { type: "user", message: { content: [{ type: "text", text: "go" }] } },
  assistant("a1", [
    { type: "text", text: "working" },
    { type: "tool_use", id: "tu1", name: "Read", input: {} },
  ]),
  assistant("a2", [
    { type: "tool_use", id: "tu2", name: "Bash", input: {} },
    { type: "tool_use", id: "tu3", name: "Write", input: {} },
  ]),
];

record(
  "用例 4: 统计工具调用次数并读取最后工具名",
  countToolUses(messages) === 3 &&
    getLastToolUseName(messages[2]) === "Write" &&
    getLastToolUseName(messages[0]) === undefined,
);

const finalized = finalizeAgentTool(
  [
    assistant("a1", [{ type: "text", text: "fallback text" }]),
    assistant("a2", [{ type: "tool_use", id: "tu4", name: "Read", input: {} }], "req-final"),
  ],
  "agent-1",
  {
    prompt: "verify",
    resolvedAgentModel: "test-model",
    isBuiltInAgent: false,
    startTime: Date.now() - 10,
    agentType: "worker",
    isAsync: false,
  },
);
record(
  "用例 5a: finalizeAgentTool 在最后一条无文本时回退到最近文本",
  finalized.agentId === "agent-1" &&
    finalized.agentType === "worker" &&
    finalized.content[0]?.text === "fallback text" &&
    finalized.totalToolUseCount === 1 &&
    finalized.totalTokens === 8,
  finalized,
);

let noAssistantError = "";
try {
  finalizeAgentTool([], "agent-empty", {
    prompt: "empty",
    resolvedAgentModel: "test-model",
    isBuiltInAgent: false,
    startTime: Date.now(),
    agentType: "worker",
    isAsync: false,
  });
} catch (e) {
  noAssistantError = e instanceof Error ? e.message : String(e);
}
record(
  "用例 5b: finalizeAgentTool 没有 assistant 消息时抛出明确错误",
  noAssistantError === "No assistant messages found",
  { noAssistantError },
);

record(
  "用例 6: extractPartialResult 返回最近 assistant 文本",
  extractPartialResult([
    assistant("a1", [{ type: "text", text: "old" }]),
    assistant("a2", [{ type: "tool_use", id: "tu5", name: "Bash", input: {} }]),
    assistant("a3", [{ type: "text", text: "latest" }]),
  ]) === "latest" &&
    extractPartialResult([assistant("a4", [{ type: "tool_use", id: "tu6", name: "Read", input: {} }])]) === undefined,
);

const skippedHandoff = await classifyHandoffIfNeeded({
  agentMessages: messages,
  tools: availableTools,
  toolPermissionContext: { mode: "default" },
  abortSignal: new AbortController().signal,
  subagentType: "worker",
  totalToolUseCount: 3,
});
record(
  "用例 7a: 非 auto 权限模式不触发交接分类",
  skippedHandoff === null,
  { skippedHandoff },
);

console.log(JSON.stringify(checks, null, 2));
if (checks.some(c => !c.passed)) process.exit(1);
'@

Set-Content -Path "$env:FREE_CODE_E2E_ROOT\verify-agent-tool-utils.ts" -Value $Script -Encoding UTF8
bun run "$env:FREE_CODE_E2E_ROOT\verify-agent-tool-utils.ts" | Tee-Object "$env:FREE_CODE_E2E_ROOT\result.json"
```

通过标准：

- 命令退出码为 0。
- `D:\tmp\free-code-agent-tool-utils-e2e\result.json` 中所有 `passed` 都为 `true`。
- 用例输出能看到过滤后的工具名、解析出的 `allowedAgentTypes`、`finalizeAgentTool()` 汇总结果。

## 4. 交接分类人工用例

该分支依赖 `TRANSCRIPT_CLASSIFIER` feature、真实工具权限上下文和分类器服务，无法只靠本文件稳定构造。人工验证步骤：

1. 启用 transcript classifier 对应运行环境。
2. 在 auto 权限模式下启动一个子 Agent，让子 Agent 执行一个会触发权限审查的文件或命令操作。
3. 观察父 Agent 接收的子 Agent 最终消息。
4. 分别构造三类场景：
   - 分类器允许：父 Agent 收到原始结果，不追加警告。
   - 分类器阻断：父 Agent 收到 `SECURITY WARNING:` 开头的警告和阻断原因。
   - 分类器不可用：父 Agent 收到 `Note: The safety classifier was unavailable...` 警告。
5. 记录完整命令、权限模式、子 Agent 类型、工具调用次数和最终消息。

通过标准：

- auto 模式下才触发分类。
- 分类器允许时返回 `null`。
- 阻断或不可用时返回清晰警告，且不会吞掉子 Agent 已完成的文本结果。

## 5. 异步 Agent 生命周期人工用例

`runAsyncAgentLifecycle()` 依赖任务状态、Agent 消息流、摘要服务、通知队列和工作树结果。推荐通过真实后台 Agent 入口验证：

1. 准备临时项目目录 `D:\tmp\free-code-agent-tool-utils-lifecycle`。
2. 通过 CLI 或产品入口启动一个后台 Agent，任务描述使用容易识别的文本，例如 `agent-tool-utils lifecycle happy path`。
3. 正常完成场景：
   - 让后台 Agent 输出文本并至少调用一次只读工具。
   - 观察任务列表中状态变为 completed。
   - 使用 TaskOutput 或对应 UI 查看最终消息、token、toolUses、durationMs。
4. 用户终止场景：
   - 启动一个长时间运行的后台 Agent。
   - 在它输出至少一条 assistant 文本后执行停止任务操作。
   - 观察状态变为 killed，通知中保留部分结果。
5. 普通失败场景：
   - 让后台 Agent 进入一个会抛出非 AbortError 的错误路径。
   - 观察状态变为 failed，通知中包含标准化错误消息。
6. retain 消息场景：
   - 打开任务详情或使任务处于 retain 状态。
   - 在消息流过程中确认任务消息列表按顺序追加，不出现重复前缀或顺序反转。
7. 清理场景：
   - 任务结束后再次触发同一个 Agent。
   - 确认上一次的技能调用状态和 dump 状态没有泄漏到新任务。

通过标准：

- completed、killed、failed 三类终态都能解除阻塞式 TaskOutput。
- 终止和失败路径都会发送最终通知。
- 工作树路径或分支信息如果存在，应出现在通知里。
- 生命周期结束后不会残留上一轮 Agent 的临时状态。

## 6. 不可自动化边界

- `isAgentSwarmsEnabled()`、`isInProcessTeammate()` 和真实 teammate 场景依赖运行时上下文，脚本只能覆盖普通过滤分支；队友专属分支需要在 swarm/teammate 产品入口中复核。
- `classifyYoloAction()` 需要真实分类器服务和 feature flag；纯脚本只能验证跳过分支。
- `runAsyncAgentLifecycle()` 的完整价值在任务状态和 UI/通知副作用，必须通过真实后台 Agent 入口补充验证。
