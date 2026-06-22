# src/utils/errors.ts 黑盒端到端测试说明

本文档验证错误类型和错误归类工具函数的外部行为，确保调用方能稳定区分取消、文件系统错误、Axios 错误和遥测安全错误。

## 1. 验证目标

- 自定义错误类的 `name`、字段和 message 正确。
- `isAbortError()` 识别本地 AbortError 和标准 AbortError。
- errno 工具函数能提取 code/path。
- `shortErrorStack()` 能截断长 stack。
- `classifyAxiosError()` 能区分 auth、timeout、network、http、other。

## 2. 执行脚本

```powershell
cd D:\Code\free-code
$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-errors-utils-e2e"
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null

$Script = @'
import {
  ClaudeError,
  AbortError,
  ConfigParseError,
  ShellError,
  TeleportOperationError,
  TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  isAbortError,
  hasExactErrorMessage,
  toError,
  errorMessage,
  getErrnoCode,
  isENOENT,
  getErrnoPath,
  shortErrorStack,
  isFsInaccessible,
  classifyAxiosError,
} from "D:/Code/free-code/src/utils/errors.ts";

const checks = [];
const add = (name, passed, detail = {}) => checks.push({ name, passed, ...detail });

add("claude-name", new ClaudeError("x").name === "ClaudeError");
add("abort-local", isAbortError(new AbortError("x")));
add("abort-dom-name", isAbortError(Object.assign(new Error("x"), { name: "AbortError" })));
add("config-fields", new ConfigParseError("bad", "a.json", {}).filePath === "a.json");
add("shell-fields", new ShellError("out", "err", 2, false).code === 2);
add("teleport-formatted", new TeleportOperationError("x", "shown").formattedMessage === "shown");
add("telemetry-message", new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS("full", "safe").telemetryMessage === "safe");
add("exact-message", hasExactErrorMessage(new Error("same"), "same"));
add("to-error", toError("x") instanceof Error);
add("message", errorMessage("x") === "x");

const enoent = { code: "ENOENT", path: "missing.txt" };
add("errno-code", getErrnoCode(enoent) === "ENOENT");
add("is-enoent", isENOENT(enoent));
add("errno-path", getErrnoPath(enoent) === "missing.txt");
add("fs-inaccessible", isFsInaccessible(enoent));

const long = new Error("boom");
long.stack = "Error: boom\\n" + Array.from({ length: 20 }, (_, i) => `    at f${i}`).join("\\n");
add("short-stack", shortErrorStack(long, 3).split("\\n").length === 4);

add("axios-auth", classifyAxiosError({ isAxiosError: true, response: { status: 403 }, message: "forbidden" }).kind === "auth");
add("axios-timeout", classifyAxiosError({ isAxiosError: true, code: "ECONNABORTED", message: "timeout" }).kind === "timeout");
add("axios-network", classifyAxiosError({ isAxiosError: true, code: "ENOTFOUND", message: "dns" }).kind === "network");
add("axios-http", classifyAxiosError({ isAxiosError: true, response: { status: 500 }, message: "server" }).kind === "http");
add("axios-other", classifyAxiosError(new Error("plain")).kind === "other");

console.log(JSON.stringify(checks, null, 2));
if (checks.some(c => !c.passed)) process.exit(1);
'@
Set-Content -Path "$env:FREE_CODE_E2E_ROOT\verify.ts" -Value $Script -Encoding UTF8
bun run "$env:FREE_CODE_E2E_ROOT\verify.ts" | Tee-Object "$env:FREE_CODE_E2E_ROOT\result.json"
```

验收标准：所有 `passed` 为 `true`。
