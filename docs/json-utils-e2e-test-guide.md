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

## 4. 人工复核与不可自动化边界

本文件的自动验证覆盖 JSON、JSONC、JSONL 和 JSONC 数组追加。人工复核用于确认坏数据被跳过或降级后，没有吞掉后续有效数据。

人工操作：

1. 执行第 3 节脚本，生成 `result.json`。
2. 打开 `D:\tmp\free-code-json-utils-e2e\result.json`。
3. 人工确认：
   - `json-invalid` 返回 `null`，不是抛异常。
   - `jsonl-string-skip-bad` 和 `jsonl-buffer-skip-bad` 的数量为 2，说明坏行被跳过但后续行保留。
   - `jsonc-array-append` 保留数组结构并包含新元素。
   - `jsonc-non-array` 和 `jsonc-bad` 回退为新数组，不复用坏结构。
4. 如需验证大文件尾部读取，手动生成超过 100 MB 的 JSONL 文件，并检查只读取尾部最多 100 MB：

   ```powershell
   $big = "$env:FREE_CODE_E2E_ROOT\big.jsonl"
   1..1200000 | ForEach-Object { '{"i":' + $_ + '}' } | Set-Content $big -Encoding UTF8
   ```

   然后补脚本调用 `readJSONLFile($big)`，记录返回行数和执行耗时。

通过标准：

- 自动脚本全绿。
- 坏 JSON/JSONC/JSONL 不导致进程退出。
- JSONL 坏行只影响当前行，不影响后续行。

不可自动化边界：

- 100 MB 尾部读取属于资源型用例，默认不在每次验证中执行；需要人工确认机器磁盘和时间预算后再跑。
- Bun 原生 JSONL 解析和兼容解析路径取决于运行时能力，跨运行时验证需要分别记录 Bun 版本和 Node/非 Bun 环境。
