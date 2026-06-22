# src/utils/sequential.ts 黑盒端到端测试说明

本文档验证 `sequential()` 包装器能把并发调用按进入顺序串行执行，并且正确传递返回值、异常和 `this`。

## 1. 验证目标

- 并发触发的调用按顺序开始和结束。
- 每个调用拿到自己的返回值。
- 某个调用抛错时，只拒绝对应 Promise，不破坏后续队列。
- 包装对象方法时保留 `this`。

## 2. 执行脚本

```powershell
cd D:\Code\free-code
$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-sequential-e2e"
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null

$Script = @'
import { sequential } from "D:/Code/free-code/src/utils/sequential.ts";

const events = [];
const wait = ms => new Promise(r => setTimeout(r, ms));

const obj = {
  prefix: "P",
  run: sequential(async function (id, ms, fail = false) {
    events.push(`start-${id}-${this.prefix}`);
    await wait(ms);
    events.push(`end-${id}`);
    if (fail) throw new Error(`fail-${id}`);
    return `${this.prefix}-${id}`;
  }),
};

const p1 = obj.run("a", 30);
const p2 = obj.run("b", 1, true).catch(e => e.message);
const p3 = obj.run("c", 1);
const values = await Promise.all([p1, p2, p3]);

const checks = [
  { name: "order", passed: events.join(",") === "start-a-P,end-a,start-b-P,end-b,start-c-P,end-c" },
  { name: "values", passed: values.join(",") === "P-a,fail-b,P-c" },
  { name: "this", passed: events[0].endsWith("-P") },
];

console.log(JSON.stringify({ events, values, checks }, null, 2));
if (checks.some(c => !c.passed)) process.exit(1);
'@
Set-Content -Path "$env:FREE_CODE_E2E_ROOT\verify.ts" -Value $Script -Encoding UTF8
bun run "$env:FREE_CODE_E2E_ROOT\verify.ts" | Tee-Object "$env:FREE_CODE_E2E_ROOT\result.json"
```

验收标准：所有 `checks.passed` 为 `true`。
