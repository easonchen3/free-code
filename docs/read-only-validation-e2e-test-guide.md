# src/tools/BashTool/readOnlyValidation.ts 黑盒端到端测试说明

本文档验证 BashTool 只读命令自动放行逻辑是否能正确区分安全读取、危险 flag、运行时展开、复合命令和 git 相关绕过。测试不依赖内部私有函数，优先通过公开导出和 BashTool 输入对象观察黑盒结果。

## 1. 文件功能说明

`src/tools/BashTool/readOnlyValidation.ts` 负责在 BashTool 进入普通权限询问前，识别可以自动放行的只读命令，并把存在写入、执行、网络访问或运行时展开风险的命令退回权限检查流程。

主要覆盖：

1. 基于命令白名单和 flag 类型校验安全命令。
2. 拒绝危险 flag、未知 flag、变量展开、花括号展开和换行注入。
3. 对 `date`、`hostname`、`info`、`tree`、`lsof`、`tput`、`ss` 等命令补充专属安全规则。
4. 对 Windows UNC、`cd` + git、裸 git 仓库、git hook 路径写入等复合风险返回 `ask`。
5. 将所有子命令都证明为只读时返回 `allow`，否则返回 `ask`。

## 2. 黑盒覆盖矩阵

| 分支类别 | 需要覆盖的行为 | 验证方式 |
| --- | --- | --- |
| flag 白名单 | `git status`、`date +FORMAT`、`hostname -f` 可通过 | 自动脚本用例 1 |
| 危险 flag | `git diff --output`、`date` 位置参数、`hostname` 位置参数应拒绝 | 自动脚本用例 2 |
| 展开与注入 | `$VAR`、grep/rg 换行、花括号展开混淆应拒绝 | 自动脚本用例 3 |
| xargs 约束 | 目标命令和位置参数无法完全证明时不自动放行 | 自动脚本用例 4 |
| BashTool 返回 | 纯只读命令返回 `allow`，非只读命令返回 `passthrough` 交给后续权限检查 | 自动脚本用例 5 |
| git 复合风险 | `cd` + git、裸仓库、git hook 写入应返回 `passthrough` | 人工用例 6 |
| Windows UNC | UNC/WebDAV 风险路径应返回 `passthrough` | 人工用例 7 |

## 3. 初始化

```powershell
cd D:\Code\free-code
npm run build

$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-read-only-validation-e2e"
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null
```

## 4. 编写临时验证脚本

```powershell
$Script = @'
import {
  checkReadOnlyConstraints,
  isCommandSafeViaFlagParsing,
} from "D:/Code/free-code/src/tools/BashTool/readOnlyValidation.ts";

const checks = [];
const record = (name, actual, expected, details = {}) =>
  checks.push({ name, actual, expected, passed: actual === expected, details });

record("用例 1a: git status 只读 flag 放行", isCommandSafeViaFlagParsing("git status --short"), true);
record("用例 1b: date +FORMAT 展示时间放行", isCommandSafeViaFlagParsing("date +%Y-%m-%d"), true);
record("用例 1c: hostname -f 只展示 FQDN 放行", isCommandSafeViaFlagParsing("hostname -f"), true);

record("用例 2a: git diff --output 会写文件应拒绝", isCommandSafeViaFlagParsing("git diff --output=/tmp/pwn"), false);
record("用例 2b: date 裸位置参数可能设置系统时间应拒绝", isCommandSafeViaFlagParsing("date 010101012026"), false);
record("用例 2c: hostname 裸位置参数会修改主机名应拒绝", isCommandSafeViaFlagParsing("hostname new-name"), false);

record("用例 3a: token 中包含变量展开应拒绝", isCommandSafeViaFlagParsing("rg foo $BAR"), false);
record("用例 3b: grep 模式包含换行应拒绝", isCommandSafeViaFlagParsing("grep \"a\\nb\" file"), false);
record("用例 3c: 花括号混淆危险 flag 应拒绝", isCommandSafeViaFlagParsing("git diff {@{0},--output=/tmp/pwned}"), false);

record("用例 4a: xargs 目标命令无法完整证明时不自动放行", isCommandSafeViaFlagParsing("xargs -I {} echo {}"), false);
record("用例 4b: xargs 执行 shell 目标应拒绝", isCommandSafeViaFlagParsing("xargs sh -c echo"), false);

const allow = checkReadOnlyConstraints({ command: "pwd" }, false);
record("用例 5a: BashTool 只读命令返回 allow", allow.behavior, "allow", allow);

const askWrite = checkReadOnlyConstraints({ command: "echo hi > out.txt" }, false);
record("用例 5b: BashTool 写文件命令返回 passthrough", askWrite.behavior, "passthrough", askWrite);

const gitHook = checkReadOnlyConstraints(
  { command: "mkdir -p hooks && touch hooks/pre-commit && git status" },
  false,
);
record("用例 5c: 写 git hook 路径后运行 git 返回 passthrough", gitHook.behavior, "passthrough", gitHook);

console.log(JSON.stringify(checks, null, 2));
if (checks.some(c => !c.passed)) process.exit(1);
'@
Set-Content -Path "$env:FREE_CODE_E2E_ROOT\verify.ts" -Value $Script -Encoding UTF8
```

## 5. 执行

```powershell
bun run "$env:FREE_CODE_E2E_ROOT\verify.ts" | Tee-Object "$env:FREE_CODE_E2E_ROOT\result.json"
```

## 6. 期望输出

- 所有结果的 `passed` 都为 `true`。
- 安全读取命令的 `isCommandSafeViaFlagParsing` 返回 `true`。
- 危险 flag、运行时展开、xargs 不可证明目标返回 `false`。
- `checkReadOnlyConstraints({ command: "pwd" }, false)` 返回 `behavior: "allow"`。
- 写文件、git hook 写入等命令返回 `behavior: "passthrough"`，并带有可读 `message`，表示交给后续权限检查。

## 7. 人工复核与不可自动化边界

人工用例 6：git 复合风险

1. 在临时目录初始化一个普通 git 仓库。
2. 运行脚本中的 `checkReadOnlyConstraints({ command: "cd .. && git status" }, true)`。
3. 期望返回 `passthrough`，原因是复合命令含 `cd` 且含 git，当前目录可能被切到攻击者控制位置。
4. 在裸 git 仓库目录内运行 `checkReadOnlyConstraints({ command: "git status" }, false)`。
5. 期望返回 `passthrough`，原因是裸仓库内部 hook/config 更敏感。

人工用例 7：Windows UNC/WebDAV 风险

1. 在 Windows 环境执行临时脚本，输入包含 UNC 路径的命令，例如 `dir \\\\example.com\\share`。
2. 期望 `checkReadOnlyConstraints` 返回 `passthrough`。
3. 检查 `message` 是否说明 UNC/WebDAV 风险。

不可自动化边界：

- 裸 git 仓库和 UNC 路径依赖运行环境，脚本可以给出输入，但是否真正命中平台风险需要在目标机器人工确认。
- xargs 的安全目标列表和 flag 消费规则非常严格，测试应以实际返回为准，不按“看起来只读”的直觉修正预期。
