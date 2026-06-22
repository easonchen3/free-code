# src/utils/settings/toolValidationConfig.ts 黑盒端到端测试说明

本文档验证工具分类配置和工具专属校验函数是否能被权限规则校验层正确使用。

## 1. 验证目标

- 文件模式工具集合包含 `Read`、`Write`、`Edit`、`Glob` 等。
- Bash 模式工具只包含 `Bash`。
- WebSearch 拒绝 `*` 和 `?`。
- WebFetch 拒绝 URL，要求 `domain:` 前缀。
- 未配置专属校验的工具返回 undefined。

## 2. 初始化和脚本

```powershell
cd D:\Code\free-code
$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-tool-validation-config-e2e"
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null

$Script = @'
import {
  TOOL_VALIDATION_CONFIG,
  isFilePatternTool,
  isBashPrefixTool,
  getCustomValidation,
} from "D:/Code/free-code/src/utils/settings/toolValidationConfig.ts";

const checks = [];
const add = (name, passed, detail = {}) => checks.push({ name, passed, ...detail });

add("read-file-pattern", isFilePatternTool("Read"));
add("glob-file-pattern", isFilePatternTool("Glob"));
add("bash-prefix", isBashPrefixTool("Bash"));
add("read-not-bash", !isBashPrefixTool("Read"));
add("unknown-no-custom", getCustomValidation("Read") === undefined);

const webSearch = getCustomValidation("WebSearch");
const webFetch = getCustomValidation("WebFetch");
add("websearch-wildcard", webSearch("*query").valid === false);
add("websearch-exact", webSearch("claude ai").valid === true);
add("webfetch-url", webFetch("https://example.com").valid === false);
add("webfetch-no-prefix", webFetch("example.com").valid === false);
add("webfetch-domain", webFetch("domain:*.example.com").valid === true);
add("config-shape", Array.isArray(TOOL_VALIDATION_CONFIG.filePatternTools));

console.log(JSON.stringify(checks, null, 2));
if (checks.some(c => !c.passed)) process.exit(1);
'@
Set-Content -Path "$env:FREE_CODE_E2E_ROOT\verify.ts" -Value $Script -Encoding UTF8
```

## 3. 执行与验收

```powershell
bun run "$env:FREE_CODE_E2E_ROOT\verify.ts" | Tee-Object "$env:FREE_CODE_E2E_ROOT\result.json"
```

所有 `passed` 必须为 `true`。
