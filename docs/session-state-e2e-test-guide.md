# src/utils/sessionState.ts 黑盒端到端测试说明

本文档验证会话状态通知、metadata 同步和权限模式通知的公开行为。

## 1. 验证目标

- 初始状态为 `idle`。
- `notifySessionStateChanged()` 会更新当前状态并调用 listener。
- `requires_action` 会写入 `pending_action` metadata。
- 离开阻塞态会用 `pending_action: null` 清理 metadata。
- idle 会清理 `task_summary`。
- 权限模式变更会通知 listener。

## 2. 执行脚本

```powershell
cd D:\Code\free-code
$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-session-state-e2e"
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null

$Script = @'
import {
  getSessionState,
  notifyPermissionModeChanged,
  notifySessionMetadataChanged,
  notifySessionStateChanged,
  setPermissionModeChangedListener,
  setSessionMetadataChangedListener,
  setSessionStateChangedListener,
} from "D:/Code/free-code/src/utils/sessionState.ts";

const states = [];
const metadata = [];
const modes = [];

setSessionStateChangedListener((state, details) => states.push({ state, details }));
setSessionMetadataChangedListener(m => metadata.push(m));
setPermissionModeChangedListener(m => modes.push(m));

const details = {
  tool_name: "Read",
  action_description: "Reading src/a.ts",
  tool_use_id: "tool-1",
  request_id: "req-1",
  input: { file_path: "src/a.ts" },
};

notifySessionStateChanged("running");
notifySessionStateChanged("requires_action", details);
notifySessionStateChanged("idle");
notifySessionMetadataChanged({ model: "test-model" });
notifyPermissionModeChanged("default");

const checks = [
  { name: "final-idle", passed: getSessionState() === "idle" },
  { name: "state-listener", passed: states.map(s => s.state).join(",") === "running,requires_action,idle" },
  { name: "pending-action-set", passed: metadata.some(m => m.pending_action?.tool_name === "Read") },
  { name: "pending-action-clear", passed: metadata.some(m => m.pending_action === null) },
  { name: "task-summary-clear", passed: metadata.some(m => m.task_summary === null) },
  { name: "metadata-direct", passed: metadata.some(m => m.model === "test-model") },
  { name: "permission-mode", passed: modes.includes("default") },
];

console.log(JSON.stringify({ states, metadata, modes, checks }, null, 2));
if (checks.some(c => !c.passed)) process.exit(1);
'@
Set-Content -Path "$env:FREE_CODE_E2E_ROOT\verify.ts" -Value $Script -Encoding UTF8
bun run "$env:FREE_CODE_E2E_ROOT\verify.ts" | Tee-Object "$env:FREE_CODE_E2E_ROOT\result.json"
```

验收标准：`checks` 中所有 `passed` 为 `true`。

## 3. 人工复核与不可自动化边界

本文件的自动脚本验证会话状态监听、外部元数据增量和权限模式通知。人工复核用于确认事件顺序和增量内容是否符合真实客户端消费预期。

人工操作：

1. 执行第 2 节脚本，生成 `result.json`。
2. 打开 `D:\tmp\free-code-session-state-e2e\result.json`。
3. 人工确认：
   - `states` 的顺序是 `running`、`requires_action`、`idle`。
   - 进入 `requires_action` 时出现 `pending_action`。
   - 离开阻塞态时出现 `pending_action: null`。
   - 回到 `idle` 时出现 `task_summary: null`。
   - 权限模式监听器收到 `default`。
4. 如果要验证真实客户端桥接层，启动使用会话状态的产品入口，触发一次需要权限的工具调用，记录外部元数据流中的 `pending_action` 设置和清除。

通过标准：

- 自动脚本全绿。
- 状态顺序和元数据增量符合真实 UI/SDK 订阅方预期。
- 清除事件使用 `null`，不是省略字段。

不可自动化边界：

- 外部客户端如何展示 `external_metadata` 取决于调用入口，默认脚本只能验证本模块发出的增量；真实 UI 或 SDK 消费需要人工在对应产品入口确认。
