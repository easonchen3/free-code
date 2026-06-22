# src/utils/json.ts 黑盒端到端测试说明

本文档验证 JSON、JSONC、JSONL 解析和 JSONC 数组追加逻辑，重点关注坏输入容错、大文件尾部读取和格式保留。

## 1. 验证目标

- `safeParseJSON()` 对合法 JSON 返回对象，对坏 JSON 返回 null。
- JSON BOM 会被剥离。
- `safeParseJSONC()` 支持注释。
- JSONL 解析跳过坏行。
- `readJSONLFile()` 可读取文件。
- `addItemToJSONCArray()` 能向数组追加元素，非数组或坏 JSONC 时创建新数组。

## 2. 初始化和执行

```powershell
cd D:\Code\free-code
$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-json-utils-e2e"
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null

Set-Content -Path "$env:FREE_CODE_E2E_ROOT\data.jsonl" -Value "{`"a`":1}`nnot-json`n{`"b`":2}" -Encoding UTF8

$Script = @'
import {
  safeParseJSON,
  safeParseJSONC,
  parseJSONL,
  readJSONLFile,
  addItemToJSONCArray,
} from "D:/Code/free-code/src/utils/json.ts";

const root = "D:/tmp/free-code-json-utils-e2e";
const checks = [];
const add = (name, passed, detail = {}) => checks.push({ name, passed, ...detail });

add("json-valid", safeParseJSON('{"ok":true}').ok === true);
add("json-null", safeParseJSON("null") === null);
add("json-invalid", safeParseJSON("{bad", false) === null);
add("json-bom", safeParseJSON("\\uFEFF{\\"a\\":1}").a === 1);
add("jsonc-comment", safeParseJSONC("{// c\\n\\"a\\":1}").a === 1);
add("jsonl-string-skip-bad", parseJSONL('{"a":1}\\nbad\\n{"b":2}').length === 2);
add("jsonl-buffer-skip-bad", parseJSONL(Buffer.from('{"a":1}\\nbad\\n{"b":2}')).length === 2);

const fileRows = await readJSONLFile(`${root}/data.jsonl`);
add("jsonl-file", fileRows.length === 2);
add("jsonc-array-append", addItemToJSONCArray("[1]", 2).includes("2"));
add("jsonc-empty", addItemToJSONCArray("", "x").includes('"x"'));
add("jsonc-non-array", addItemToJSONCArray('{"a":1}', "x").startsWith("["));
add("jsonc-bad", addItemToJSONCArray("{bad", "x").startsWith("["));

console.log(JSON.stringify(checks, null, 2));
if (checks.some(c => !c.passed)) process.exit(1);
'@
Set-Content -Path "$env:FREE_CODE_E2E_ROOT\verify.ts" -Value $Script -Encoding UTF8
bun run "$env:FREE_CODE_E2E_ROOT\verify.ts" | Tee-Object "$env:FREE_CODE_E2E_ROOT\result.json"
```

验收标准：所有 `passed` 为 `true`，且坏 JSON/JSONL 不导致脚本崩溃。
