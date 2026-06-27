# src/utils/bash/ast.ts 黑盒端到端测试说明

本文档验证 Bash AST 安全分析模块的黑盒行为，覆盖解析器可用性、简单命令抽取、复杂语法降级，以及 argv 后置语义检查。当前环境如果未启用 tree-sitter Bash 特性，解析入口会返回 `parse-unavailable`；文档同时提供可稳定自动化的语义检查用例。

## 1. 文件功能说明

`src/utils/bash/ast.ts` 使用 Bash AST 把命令拆成可校验的简单命令列表，并在解析成功后继续检查 argv 层面的危险语义。它的核心目标不是执行命令，而是在权限判断前证明命令结构足够静态；无法证明时返回 too-complex 或 parse-unavailable，让上游走更保守的权限流程。

主要覆盖：

1. 解析 Bash 命令并抽取 `SimpleCommand`、环境变量和重定向。
2. 对命令替换、变量展开、循环、条件、子 shell、重定向等结构做保守静态分析。
3. 拒绝会导致 Bash 与 tree-sitter 分词不一致的字符和 zsh 特有展开。
4. 在 argv 层阻断 eval/source/exec、zsh 内建、jq system、`/proc/*/environ`、数组下标求值等语义风险。
5. 当解析器未启用或不可用时，明确返回 `parse-unavailable`。

## 2. 黑盒覆盖矩阵

| 分支类别 | 需要覆盖的行为 | 验证方式 |
| --- | --- | --- |
| 解析器可用性 | 特性关闭时返回 `parse-unavailable`，特性开启时返回 simple/too-complex | 自动脚本用例 1 + 人工用例 6 |
| 预检查 | Unicode 空白、zsh `=cmd`、花括号/控制字符风险应过不了自动放行 | 人工用例 6 |
| 节点编号 | `nodeTypeId(undefined)`、`nodeTypeId("ERROR")` 返回固定哨兵值 | 自动脚本用例 2 |
| 后置语义安全 | 普通命令通过，eval/zsh 内建/jq/proc/env/newline 等危险命令失败 | 自动脚本用例 3 |
| 包装命令剥离 | timeout/nice/env/stdbuf 后必须检查真实命令 | 自动脚本用例 4 |
| NAME 下标求值 | printf/read/test 中 NAME 参数包含数组下标时失败 | 自动脚本用例 5 |

## 3. 初始化

```powershell
cd D:\Code\free-code
npm run build

$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-bash-ast-e2e"
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null
```

## 4. 编写临时验证脚本

```powershell
$Script = @'
import {
  checkSemantics,
  nodeTypeId,
  parseForSecurity,
} from "D:/Code/free-code/src/utils/bash/ast.ts";

const cmd = (argv, text = argv.join(" "), envVars = [], redirects = []) => ({
  argv,
  envVars,
  redirects,
  text,
});

const checks = [];
const record = (name, passed, details = {}) => checks.push({ name, passed, details });

const parsed = await parseForSecurity("git status && echo ok");
record(
  "用例 1: 解析入口返回明确状态",
  ["simple", "too-complex", "parse-unavailable"].includes(parsed.kind),
  parsed,
);

const nodeIds = {
  undefinedNode: nodeTypeId(undefined),
  errorNode: nodeTypeId("ERROR"),
  commandNode: nodeTypeId("command"),
};
record(
  "用例 2: nodeTypeId 对未知节点、错误节点和普通节点返回稳定编码",
  nodeIds.undefinedNode === -2 && nodeIds.errorNode === -1 && nodeIds.commandNode === 0,
  nodeIds,
);

const semanticCases = [
  ["用例 3a: 普通 cat 命令通过", [cmd(["cat", "README.md"])], true],
  ["用例 3b: eval 执行字符串代码应失败", [cmd(["eval", "echo hi"])], false],
  ["用例 3c: zsh 内建能力应失败", [cmd(["zmodload"])], false],
  ["用例 3d: jq system() 应失败", [cmd(["jq", "system(\"id\")"])], false],
  ["用例 3e: jq 读取文件类危险 flag 应失败", [cmd(["jq", "--from-file=filter.jq"])], false],
  ["用例 3f: argv 读取 /proc/self/environ 应失败", [cmd(["cat", "/proc/self/environ"])], false],
  ["用例 3g: 重定向读取 /proc/self/environ 应失败", [cmd(["cat"], "cat < /proc/self/environ", [], [{ op: "<", target: "/proc/self/environ" }])], false],
  ["用例 3h: argv 中换行后注释应失败", [cmd(["echo", "a\\n# hidden"])], false],
  ["用例 3i: env 值中换行后注释应失败", [cmd(["echo"], "X=... echo", [{ name: "X", value: "a\\n# hidden" }])], false],
  ["用例 4a: timeout 包装 eval 时应继续检查真实命令", [cmd(["timeout", "-k", "5", "10", "eval", "echo hi"])], false],
  ["用例 4b: env -S 会重新拆 argv，应失败", [cmd(["env", "-S", "eval echo hi"])], false],
  ["用例 4c: stdbuf 空格分离长参数无法定位真实命令，应失败", [cmd(["stdbuf", "--output", "0", "eval", "echo hi"])], false],
  ["用例 4d: nice 优先级来自展开时应失败", [cmd(["nice", "$((0-5))", "jq", "system(\"id\")"])], false],
  ["用例 5a: printf -v NAME 下标求值应失败", [cmd(["printf", "-v", "a[$(id)]", "x"])], false],
  ["用例 5b: [[ ]] 算术比较两侧下标求值应失败", [cmd(["[[", "a[$(id)]", "-eq", "0"])], false],
  ["用例 5c: read 裸 NAME 下标求值应失败", [cmd(["read", "a[$(id)]"])], false],
  ["用例 5d: command -v 只是查询路径，应通过", [cmd(["command", "-v", "node"])], true],
  ["用例 5e: fc -l 只是列历史，应通过", [cmd(["fc", "-l"])], true],
  ["用例 5f: compgen -c 只是列补全，应通过", [cmd(["compgen", "-c"])], true],
];

for (const [name, commands, expected] of semanticCases) {
  const result = checkSemantics(commands);
  record(name, result.ok === expected, { expected, result, commands });
}

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
- 当前构建未启用 tree-sitter Bash 时，用例 1 的 `parsed.kind` 可以是 `parse-unavailable`，这属于预期环境分支。
- `nodeTypeId(undefined)` 返回 `-2`，`nodeTypeId("ERROR")` 返回 `-1`，`nodeTypeId("command")` 返回稳定编码 `0`。
- `checkSemantics` 的危险命令均返回 `{ ok: false, reason: "..." }`。
- `command -v`、`fc -l`、`compgen -c` 这类只查询、不执行字符串代码的白名单例外返回 `{ ok: true }`。

## 7. 人工复核与不可自动化边界

人工用例 6：解析器启用后的真实 AST 分支

1. 使用启用了 `TREE_SITTER_BASH` 或 `TREE_SITTER_BASH_SHADOW` 的构建运行第 4 节脚本。
2. 将 `parseForSecurity("git status && echo ok")` 的结果和 `result.json` 对照。
3. 期望解析器可用时返回 `kind: "simple"`，并抽取出 `git` 与 `echo` 两个简单命令。
4. 追加输入 `echo\u00A0ok`、`=curl example.com`、`echo {a,b}`。
5. 期望这些输入返回 `too-complex`，原因分别对应 Unicode 空白、zsh 等号展开和花括号展开风险。
6. 追加输入 `echo "$(git rev-parse HEAD)"`。
7. 期望解析器可用时内部 `git` 命令被抽取，并继续进入权限规则检查。

不可自动化边界：

- 当前普通 Bun 直接导入环境可能没有启用 tree-sitter Bash 特性，因此不能强行要求解析用例返回 `simple`。
- 真正 AST 节点树来自 native/WASM parser，启用方式和发布构建参数相关；如果环境只返回 `parse-unavailable`，应记录为环境分支，而不是把语义检查判为失败。
- 后置语义检查不依赖 parser，可通过构造 `SimpleCommand` 稳定覆盖，是本文档的自动化主路径。
