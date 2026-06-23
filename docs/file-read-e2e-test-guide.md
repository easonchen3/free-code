# src/utils/fileRead.ts 黑盒端到端测试说明

本文档验证同步文件读取工具能正确识别编码、检测换行风格、解析符号链接，并返回归一化内容。

## 1. 验证目标

- 空文件编码默认 UTF-8。
- UTF-8 BOM 文件识别为 UTF-8。
- UTF-16LE BOM 文件识别为 UTF-16LE。
- CRLF/LF 统计逻辑能区分主换行风格。
- `readFileSyncWithMetadata()` 返回 LF 归一化内容，同时保留原换行风格。

## 2. 初始化测试文件

```powershell
cd D:\Code\free-code
$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-file-read-e2e"
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null

New-Item -ItemType File -Path "$env:FREE_CODE_E2E_ROOT\empty.txt" | Out-Null
[System.IO.File]::WriteAllBytes("$env:FREE_CODE_E2E_ROOT\utf8bom.txt", [byte[]](0xEF,0xBB,0xBF,0x61,0x0A))
[System.IO.File]::WriteAllBytes("$env:FREE_CODE_E2E_ROOT\utf16le.txt", [byte[]](0xFF,0xFE,0x61,0x00))
[System.IO.File]::WriteAllText("$env:FREE_CODE_E2E_ROOT\crlf.txt", "a`r`nb`r`n", [System.Text.UTF8Encoding]::new($false))
Set-Content -Path "$env:FREE_CODE_E2E_ROOT\lf.txt" -Value "a`nb`n" -NoNewline -Encoding UTF8
```

## 3. 编写脚本并执行

```powershell
$Script = @'
import {
  detectEncodingForResolvedPath,
  detectLineEndingsForString,
  readFileSyncWithMetadata,
  readFileSync,
} from "D:/Code/free-code/src/utils/fileRead.ts";

const root = "D:/tmp/free-code-file-read-e2e";
const checks = [];
const add = (name, passed, detail = {}) => checks.push({ name, passed, ...detail });

add("empty-utf8", detectEncodingForResolvedPath(`${root}/empty.txt`) === "utf8");
add("utf8-bom", detectEncodingForResolvedPath(`${root}/utf8bom.txt`) === "utf8");
add("utf16le-bom", detectEncodingForResolvedPath(`${root}/utf16le.txt`) === "utf16le");
add("line-crlf", detectLineEndingsForString("a\\r\\nb\\r\\n") === "CRLF");
add("line-lf", detectLineEndingsForString("a\\nb\\n") === "LF");

const meta = readFileSyncWithMetadata(`${root}/crlf.txt`);
add("metadata-line-ending", meta.lineEndings === "CRLF");
add("metadata-normalized", meta.content === "a\\nb\\n");
add("read-content", readFileSync(`${root}/lf.txt`) === "a\\nb\\n");

console.log(JSON.stringify(checks, null, 2));
if (checks.some(c => !c.passed)) process.exit(1);
'@
Set-Content -Path "$env:FREE_CODE_E2E_ROOT\verify.ts" -Value $Script -Encoding UTF8
bun run "$env:FREE_CODE_E2E_ROOT\verify.ts" | Tee-Object "$env:FREE_CODE_E2E_ROOT\result.json"
```

验收标准：所有 `passed` 为 `true`。

## 4. 人工复核与不可自动化边界

本文件大部分行为可自动化验证；人工复核主要用于确认磁盘文件的真实字节、换行和符号链接表现符合当前操作系统。

人工操作：

1. 执行第 2 节脚本，生成 `result.json`。
2. 打开 `D:\tmp\free-code-file-read-e2e\result.json`，确认所有 `passed` 为 `true`。
3. 用 PowerShell 检查原始字节：

   ```powershell
   Format-Hex "$env:FREE_CODE_E2E_ROOT\utf8bom.txt" | Select-Object -First 3
   Format-Hex "$env:FREE_CODE_E2E_ROOT\utf16le.txt" | Select-Object -First 3
   Format-Hex "$env:FREE_CODE_E2E_ROOT\crlf.txt" | Select-Object -First 5
   ```

4. 人工确认：
   - UTF-8 BOM 文件以 `EF BB BF` 开头。
   - UTF-16LE 文件以 `FF FE` 开头。
   - CRLF 文件包含 `0D 0A`。
   - `readFileSyncWithMetadata()` 返回内容已经归一化为 `\n`，但 `lineEndings` 保留原风格。

通过标准：

- 自动脚本全绿。
- 原始字节和脚本检测结果一致。
- 读取内容归一化不改变磁盘文件本身。

不可自动化边界：

- Windows 下符号链接创建可能受权限或开发者模式影响；如果补充符号链接用例，需要记录创建命令、权限状态和 `readlink`/`Get-Item` 结果。
- 不同编辑器可能自动改写换行，人工复核时不要用会自动保存格式的编辑器打开测试文件。
