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

## 4. 人工复核与不可自动化边界

本文件验证错误对象的分类和格式化。自动脚本能构造常见错误形状；人工复核用于确认真实系统错误和网络错误在当前平台上仍能被归类。

人工操作：

1. 执行第 3 节脚本，生成 `result.json`。
2. 打开 `D:\tmp\free-code-errors-utils-e2e\result.json`，确认所有 `passed` 为 `true`。
3. 人工触发一个真实文件不存在错误：

   ```powershell
   $Script = @'
   import { readFileSync } from "node:fs";
   import { getErrnoCode, getErrnoPath, isENOENT, isFsInaccessible } from "D:/Code/free-code/src/utils/errors.ts";
   try {
     readFileSync("D:/tmp/free-code-errors-utils-e2e/not-found.txt");
   } catch (e) {
     console.log(JSON.stringify({
       code: getErrnoCode(e),
       path: getErrnoPath(e),
       enoent: isENOENT(e),
       inaccessible: isFsInaccessible(e),
     }, null, 2));
   }
   '@
   Set-Content "$env:FREE_CODE_E2E_ROOT\real-fs-error.ts" $Script -Encoding UTF8
   bun run "$env:FREE_CODE_E2E_ROOT\real-fs-error.ts"
   ```

4. 如果要复核真实网络错误，使用一个不可访问域名或本地关闭端口构造请求库错误，并记录 `classifyAxiosError()` 结果。

通过标准：

- 合成错误和真实文件系统错误都能被稳定归类。
- 不存在路径返回 `ENOENT`，且 `isFsInaccessible()` 为 true。
- `shortErrorStack()` 不泄漏过多堆栈帧。

不可自动化边界：

- 真实网络错误依赖网络环境和代理设置，不应作为默认必跑项；人工执行时必须记录目标地址、代理环境和错误对象摘要。
- 遥测安全错误的“消息是否不含路径/代码”需要人工审查调用方传入内容，脚本只能验证字段保存行为。
