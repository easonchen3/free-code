# src/utils/settings/permissionValidation.ts 黑盒端到端测试说明

本文档指导 agent 验证权限规则校验逻辑是否能正确接受合法规则、拒绝常见误写，并给出可读的错误建议。

约束：
- 不在仓库中新建 `*.test.ts`。
- 所有临时脚本和输出写入 `D:\tmp\free-code-permission-validation-e2e`。
- 从仓库根目录运行，使用 Bun 直接调用公开导出。

## 1. 验证目标

- 空规则、括号不配对、空括号应失败。
- MCP 规则不允许括号模式。
- 普通工具名必须首字母大写。
- Bash 的 `:*` 旧前缀语法只能出现在末尾。
- 文件类工具应拒绝 Bash 风格 `:*`。
- WebSearch、WebFetch 的专属规则应生效。
- `PermissionRuleSchema` 应把校验错误合并为 Zod issue。

## 2. 初始化

```powershell
cd D:\Code\free-code
npm run build

$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-permission-validation-e2e"
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null
```

## 3. 编写临时验证脚本

```powershell
$Script = @'
import { validatePermissionRule, PermissionRuleSchema } from "D:/Code/free-code/src/utils/settings/permissionValidation.ts";

const cases = [
  ["empty", "", false],
  ["mismatched", "Bash(npm install", false],
  ["empty-parens", "Bash()", false],
  ["mcp-no-pattern", "mcp__server(*)", false],
  ["lower-tool", "bash(echo hi)", false],
  ["bash-prefix-valid", "Bash(npm run:*)", true],
  ["bash-prefix-middle", "Bash(npm:* run)", false],
  ["file-valid", "Read(src/**)", true],
  ["file-bash-prefix", "Read(src:*)", false],
  ["websearch-wildcard", "WebSearch(claude*)", false],
  ["webfetch-domain", "WebFetch(domain:example.com)", true],
  ["webfetch-url", "WebFetch(https://example.com)", false],
];

const results = [];
for (const [name, rule, expected] of cases) {
  const actual = validatePermissionRule(rule).valid;
  results.push({ name, rule, expected, actual, passed: actual === expected });
}

const schemaBad = PermissionRuleSchema().safeParse(["Bash()"]);
results.push({
  name: "schema-issue",
  expected: false,
  actual: schemaBad.success,
  passed: schemaBad.success === false,
  message: schemaBad.success ? "" : schemaBad.error.issues[0]?.message,
});

console.log(JSON.stringify(results, null, 2));
if (results.some(r => !r.passed)) process.exit(1);
'@
Set-Content -Path "$env:FREE_CODE_E2E_ROOT\verify.ts" -Value $Script -Encoding UTF8
```

## 4. 执行

```powershell
bun run "$env:FREE_CODE_E2E_ROOT\verify.ts" | Tee-Object "$env:FREE_CODE_E2E_ROOT\result.json"
```

## 5. 期望输出

- 所有结果的 `passed` 都为 `true`。
- `schema-issue.message` 包含错误原因和建议。
- 失败规则不会抛异常，而是返回 `{ valid: false }`。

## 6. 清理

```powershell
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:\FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
```
