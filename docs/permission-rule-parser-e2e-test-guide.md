# src/utils/permissions/permissionRuleParser.ts 黑盒端到端测试说明

本文档验证权限规则字符串和结构化值之间的转换是否稳定，重点覆盖转义括号、反斜杠、旧工具名归一化和异常格式回退。

## 1. 验证目标

- `Tool` 解析为工具级规则。
- `Tool(content)` 解析出 `ruleContent`。
- `\(`、`\)`、`\\` 能正确还原。
- 空内容和 `*` 按工具级规则处理。
- 旧工具名 `Task`、`KillShell`、`BashOutputTool` 能归一化。
- 反向查询旧工具名能返回兼容别名。
- 序列化时内容里的括号会被转义。

## 2. 初始化

```powershell
cd D:\Code\free-code
$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-permission-rule-parser-e2e"
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null
```

## 3. 编写临时验证脚本

```powershell
$Script = @'
import {
  escapeRuleContent,
  unescapeRuleContent,
  permissionRuleValueFromString,
  permissionRuleValueToString,
  normalizeLegacyToolName,
  getLegacyToolNames,
} from "D:/Code/free-code/src/utils/permissions/permissionRuleParser.ts";

const checks = [];
const add = (name, passed, detail = {}) => checks.push({ name, passed, ...detail });

add("tool-only", permissionRuleValueFromString("Bash").toolName === "Bash");
add("content", permissionRuleValueFromString("Bash(npm install)").ruleContent === "npm install");
add("escaped-parens", permissionRuleValueFromString('Bash(node -e "fn\\(1\\)")').ruleContent.includes("fn(1)"));
add("empty-content", permissionRuleValueFromString("Bash()").ruleContent === undefined);
add("wildcard-content", permissionRuleValueFromString("Bash(*)").ruleContent === undefined);
add("serialize-parens", permissionRuleValueToString({ toolName: "Bash", ruleContent: "fn(1)" }) === "Bash(fn\\(1\\))");
add("escape-roundtrip", unescapeRuleContent(escapeRuleContent("a\\b(c)")) === "a\\b(c)");
add("legacy-task", normalizeLegacyToolName("Task") !== "Task");
add("legacy-list", getLegacyToolNames(normalizeLegacyToolName("Task")).includes("Task"));
add("malformed-fallback", permissionRuleValueFromString("(missing)").toolName === "(missing)");

console.log(JSON.stringify(checks, null, 2));
if (checks.some(c => !c.passed)) process.exit(1);
'@
Set-Content -Path "$env:FREE_CODE_E2E_ROOT\verify.ts" -Value $Script -Encoding UTF8
```

## 4. 执行与验收

```powershell
bun run "$env:FREE_CODE_E2E_ROOT\verify.ts" | Tee-Object "$env:FREE_CODE_E2E_ROOT\result.json"
```

验收标准：
- 每项 `passed` 为 `true`。
- malformed 输入不会抛异常。
- 转义内容能完成 parse/stringify 往返。

## 5. 人工复核与不可自动化边界

本文件验证的是权限规则字符串的解析和序列化，脚本可以覆盖主要黑盒输入；人工复核用于确认“保守回退”不会被误读成授权成功。

人工操作：

1. 执行第 4 节生成 `result.json`。
2. 打开 `D:\tmp\free-code-permission-rule-parser-e2e\result.json`。
3. 对以下记录做人工确认：
   - `malformed-fallback`：非法结构应整体当作工具名，不应产生 `ruleContent`。
   - `empty-content` 和 `wildcard-content`：空内容和单独 `*` 应等价于工具级规则。
   - `serialize-parens`：括号必须被转义，避免写回后改变规则边界。
   - `legacy-task` 和 `legacy-list`：历史工具名应归一化，同时旧名仍能被查询到。

通过标准：

- 所有 `passed` 为 `true`。
- `Tool(content)` 往返后不会丢失反斜杠或括号语义。
- 非法输入不会抛异常，也不会被解析成更宽的权限。

不可自动化边界：

- 是否需要兼容新增历史工具名依赖产品演进，无法由当前脚本自动发现；新增工具重命名时必须人工补充别名用例。
