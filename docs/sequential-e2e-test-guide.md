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

## 3. 人工复核与不可自动化边界

本文件验证异步函数串行化包装。自动脚本能覆盖顺序、异常传播和调用上下文；人工复核用于确认并发压力下没有乱序。

人工操作：

1. 执行第 2 节脚本，生成 `result.json`。
2. 打开 `D:\tmp\free-code-sequential-e2e\result.json`。
3. 人工确认：
   - `events` 严格按照 `start-a,end-a,start-b,end-b,start-c,end-c` 排列。
   - 第二个任务抛错后第三个任务仍继续执行。
   - `this.prefix` 在包装函数中没有丢失。
4. 如需压力复核，把脚本中的任务数量扩展为 50 个，随机延迟 1 到 30 毫秒，确认所有 `start-N` 和 `end-N` 仍按入队顺序成对出现。

通过标准：

- 自动脚本全绿。
- 单个任务失败不影响后续队列消费。
- 包装函数作为对象方法调用时仍保留调用上下文。

不可自动化边界：

- 高并发压力用例耗时和随机性更高，默认不作为每次验证必跑项；人工执行时需要记录任务数量、随机延迟范围和最终事件序列。
