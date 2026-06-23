# src/utils/hooks/sessionHooks.ts 黑盒端到端测试说明

本文档验证会话态 Hook 注册、读取、删除、function hook 分离和成功回调查找逻辑。该文件没有直接 CLI 配置入口，因此通过临时脚本模拟 AppState 中的 `sessionHooks` Map。

## 1. 验证目标

- 普通 Hook 能按 session、event、matcher 注册和读取。
- function hook 能注册、返回 ID，并从普通 Hook 视图中排除。
- function hook 可按 ID 删除。
- 普通 Hook 可按配置等价性删除。
- `getSessionHookCallback()` 能找回成功回调。
- `clearSessionHooks()` 能清空指定会话。

## 2. 执行脚本

```powershell
cd D:\Code\free-code
$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-session-hooks-e2e"
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null

$Script = @'
import {
  addFunctionHook,
  addSessionHook,
  clearSessionHooks,
  getSessionFunctionHooks,
  getSessionHookCallback,
  getSessionHooks,
  removeFunctionHook,
  removeSessionHook,
} from "D:/Code/free-code/src/utils/hooks/sessionHooks.ts";

const appState = { sessionHooks: new Map() };
const setAppState = updater => updater(appState);
const sessionId = "s1";
const hook = { type: "command", command: "echo ok" };
let successCalled = false;
const onHookSuccess = () => { successCalled = true; };

addSessionHook(setAppState, sessionId, "UserPromptSubmit", "", hook, onHookSuccess);
const fnId = addFunctionHook(setAppState, sessionId, "Stop", "", async () => true, "blocked", { id: "fn-1", timeout: 123 });

const normalHooks = getSessionHooks(appState, sessionId);
const functionHooks = getSessionFunctionHooks(appState, sessionId);
const callbackEntry = getSessionHookCallback(appState, sessionId, "UserPromptSubmit", "", hook);
callbackEntry?.onHookSuccess?.(hook, {});

removeFunctionHook(setAppState, sessionId, "Stop", fnId);
const afterFunctionRemove = getSessionFunctionHooks(appState, sessionId, "Stop");

removeSessionHook(setAppState, sessionId, "UserPromptSubmit", hook);
const afterNormalRemove = getSessionHooks(appState, sessionId, "UserPromptSubmit");

addSessionHook(setAppState, sessionId, "UserPromptSubmit", "Read", hook);
clearSessionHooks(setAppState, sessionId);

const checks = [
  { name: "normal-registered", passed: normalHooks.get("UserPromptSubmit")?.[0]?.hooks.length === 1 },
  { name: "function-registered", passed: functionHooks.get("Stop")?.[0]?.hooks[0]?.id === "fn-1" },
  { name: "function-not-normal", passed: !normalHooks.has("Stop") || normalHooks.get("Stop")?.[0]?.hooks.length === 0 },
  { name: "callback-found", passed: !!callbackEntry && successCalled },
  { name: "function-removed", passed: !afterFunctionRemove.has("Stop") },
  { name: "normal-removed", passed: !afterNormalRemove.has("UserPromptSubmit") },
  { name: "cleared", passed: !appState.sessionHooks.has(sessionId) },
];

console.log(JSON.stringify(checks, null, 2));
if (checks.some(c => !c.passed)) process.exit(1);
'@
Set-Content -Path "$env:FREE_CODE_E2E_ROOT\verify.ts" -Value $Script -Encoding UTF8
bun run "$env:FREE_CODE_E2E_ROOT\verify.ts" | Tee-Object "$env:FREE_CODE_E2E_ROOT\result.json"
```

验收标准：所有 `passed` 为 `true`，且 function hook 不出现在普通 Hook 视图中。

## 3. 人工复核与不可自动化边界

本文件没有直接 settings/CLI 黑盒入口，上面的脚本是面向公开导出的会话态 Hook API 的端到端行为验证。人工复核需要明确区分“API 级验证通过”和“产品入口真实触发通过”。

人工操作：

1. 执行第 2 节脚本，生成 `result.json`。
2. 打开 `D:\tmp\free-code-session-hooks-e2e\result.json`。
3. 人工确认：
   - 普通 Hook 注册后能在 `getSessionHooks()` 中读到。
   - function hook 注册后只出现在 `getSessionFunctionHooks()`。
   - `getSessionHookCallback()` 返回成功回调，且回调被执行。
   - 删除普通 Hook 和 function hook 后对应事件视图为空。
   - `clearSessionHooks()` 删除整个 session。
4. 产品入口人工补充：
   - 找到当前产品中调用 `addSessionHook()` 或 `addFunctionHook()` 的入口，例如 teammate、swarm、SDK 或 bridge 初始化流程。
   - 通过该入口注册一个 function hook，触发 `Stop` 或对应事件。
   - 记录 hook 输入、返回值和阻断/放行结果。

通过标准：

- API 级脚本所有 `passed` 为 `true`。
- function hook 不泄漏到普通 Hook 视图。
- 如果产品入口存在，真实事件触发时 function hook 能收到消息历史或事件输入。

不可自动化边界：

- 会话态 Hook 依赖内存中的 `AppState` 和产品注册入口，普通 settings 文件无法表达。
- 如果当前构建没有暴露注册入口，记录 `rg "addFunctionHook|addSessionHook"` 的搜索结果和不可达原因，不能把内部脚本验证写成完整 CLI 黑盒通过。
