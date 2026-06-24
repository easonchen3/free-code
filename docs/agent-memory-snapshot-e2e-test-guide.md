# src/tools/AgentTool/agentMemorySnapshot.ts 黑盒端到端测试说明

本文档验证 Agent 记忆快照从项目快照目录同步到本地 Agent 记忆目录的黑盒行为。测试只使用临时项目目录和公开导出的函数，不改动仓库源码或用户默认记忆目录。

## 1. 文件功能说明

`src/tools/AgentTool/agentMemorySnapshot.ts` 负责管理项目级 Agent 记忆快照：

1. 从当前项目的 `.claude/agent-memory-snapshots/<agentType>/snapshot.json` 读取快照版本。
2. 判断本地 Agent 记忆目录是否为空、是否已经同步过当前快照。
3. 在首次使用时把快照文件复制到本地记忆目录。
4. 在项目快照更新后提示用户是否覆盖本地记忆。
5. 用户确认覆盖时删除本地旧 Markdown 记忆，避免快照中已删除的文件继续残留。
6. 用户选择跳过时只记录同步标记，不改动本地记忆正文。

## 2. 黑盒覆盖矩阵

| 分支类别 | 需要覆盖的行为 | 自动化用例 |
| --- | --- | --- |
| 快照缺失 | 没有 `snapshot.json` 时返回 `none` | 用例 1 |
| 首次初始化 | 有项目快照、本地没有 `.md` 记忆时返回 `initialize` | 用例 2 |
| 初始化复制 | 快照文件复制到本地，并写入 `.snapshot-synced.json` | 用例 3 |
| 已同步 | 本地记忆存在且同步标记不落后时返回 `none` | 用例 4 |
| 快照更新 | 项目快照时间晚于同步标记时返回 `prompt-update` | 用例 5 |
| 跳过更新 | 只更新同步标记，不覆盖本地记忆正文 | 用例 6 |
| 覆盖更新 | 删除本地旧 `.md`，复制新快照，写入新同步标记 | 用例 7 |
| 非 Markdown 文件 | 覆盖时只删除 `.md`，保留非 Markdown 文件 | 用例 7 |

## 3. 自动化验证脚本

在仓库根目录执行：

```powershell
cd D:\Code\free-code
$env:FREE_CODE_E2E_ROOT = "D:\tmp\free-code-agent-memory-snapshot-e2e"
Remove-Item -Recurse -Force $env:FREE_CODE_E2E_ROOT -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:FREE_CODE_E2E_ROOT | Out-Null

$Script = @'
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { runWithCwdOverride } from "D:/Code/free-code/src/utils/cwd.ts";
import {
  checkAgentMemorySnapshot,
  getSnapshotDirForAgent,
  initializeFromSnapshot,
  markSnapshotSynced,
  replaceFromSnapshot,
} from "D:/Code/free-code/src/tools/AgentTool/agentMemorySnapshot.ts";

const root = "D:/tmp/free-code-agent-memory-snapshot-e2e";
const project = join(root, "project");
const agentType = "reviewer";
const scope = "local";

const localDir = join(project, ".claude", "agent-memory-local", agentType);
const snapshotDir = join(project, ".claude", "agent-memory-snapshots", agentType);
const localMemory = join(localDir, "MEMORY.md");
const localExtra = join(localDir, "extra.md");
const localKeep = join(localDir, "keep.txt");
const syncedMeta = join(localDir, ".snapshot-synced.json");

await rm(root, { recursive: true, force: true });
await mkdir(project, { recursive: true });

const checks = [];
const record = (name, passed, details = {}) => checks.push({ name, passed, details });
const writeSnapshot = async (updatedAt, files) => {
  await rm(snapshotDir, { recursive: true, force: true });
  await mkdir(snapshotDir, { recursive: true });
  await writeFile(join(snapshotDir, "snapshot.json"), JSON.stringify({ updatedAt }));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(snapshotDir, name), content);
  }
};

await runWithCwdOverride(project, async () => {
  const missing = await checkAgentMemorySnapshot(agentType, scope);
  record("用例 1: 快照缺失返回 none", missing.action === "none", missing);

  await writeSnapshot("2026-06-24T01:00:00.000Z", {
    "MEMORY.md": "snapshot-v1",
    "extra.md": "extra-v1",
  });
  record(
    "用例 2: 有快照但本地无记忆返回 initialize",
    (await checkAgentMemorySnapshot(agentType, scope)).action === "initialize",
  );

  await initializeFromSnapshot(agentType, scope, "2026-06-24T01:00:00.000Z");
  const copiedMemory = await readFile(localMemory, "utf-8");
  const copiedExtra = await readFile(localExtra, "utf-8");
  const metaV1 = JSON.parse(await readFile(syncedMeta, "utf-8"));
  record(
    "用例 3: 初始化复制快照并写入同步标记",
    copiedMemory === "snapshot-v1" &&
      copiedExtra === "extra-v1" &&
      metaV1.syncedFrom === "2026-06-24T01:00:00.000Z",
    { copiedMemory, copiedExtra, metaV1 },
  );

  record(
    "用例 4: 已同步快照返回 none",
    (await checkAgentMemorySnapshot(agentType, scope)).action === "none",
  );

  await writeSnapshot("2026-06-24T02:00:00.000Z", {
    "MEMORY.md": "snapshot-v2",
  });
  const update = await checkAgentMemorySnapshot(agentType, scope);
  record(
    "用例 5: 新快照返回 prompt-update",
    update.action === "prompt-update" &&
      update.snapshotTimestamp === "2026-06-24T02:00:00.000Z",
    update,
  );

  await markSnapshotSynced(agentType, scope, "2026-06-24T02:00:00.000Z");
  const afterSkipMemory = await readFile(localMemory, "utf-8");
  const metaSkip = JSON.parse(await readFile(syncedMeta, "utf-8"));
  record(
    "用例 6: 跳过更新只写同步标记不覆盖正文",
    afterSkipMemory === "snapshot-v1" &&
      metaSkip.syncedFrom === "2026-06-24T02:00:00.000Z",
    { afterSkipMemory, metaSkip },
  );

  await writeFile(localKeep, "keep-non-md");
  await writeFile(localExtra, "orphan-md");
  await replaceFromSnapshot(agentType, scope, "2026-06-24T02:00:00.000Z");
  const replacedMemory = await readFile(localMemory, "utf-8");
  const keepText = await readFile(localKeep, "utf-8");
  let orphanStillExists = true;
  try {
    await readFile(localExtra, "utf-8");
  } catch {
    orphanStillExists = false;
  }
  const metaReplace = JSON.parse(await readFile(syncedMeta, "utf-8"));
  record(
    "用例 7: 覆盖更新删除旧 Markdown、保留非 Markdown、写入新标记",
    replacedMemory === "snapshot-v2" &&
      keepText === "keep-non-md" &&
      orphanStillExists === false &&
      metaReplace.syncedFrom === "2026-06-24T02:00:00.000Z",
    { replacedMemory, keepText, orphanStillExists, metaReplace },
  );

  record(
    "路径校验: 快照目录位于临时项目内部",
    getSnapshotDirForAgent(agentType).replaceAll("\\\\", "/").includes("/project/.claude/agent-memory-snapshots/reviewer"),
    { snapshotDir: getSnapshotDirForAgent(agentType) },
  );
});

console.log(JSON.stringify(checks, null, 2));
if (checks.some(c => !c.passed)) process.exit(1);
'@

Set-Content -Path "$env:FREE_CODE_E2E_ROOT\verify-agent-memory-snapshot.ts" -Value $Script -Encoding UTF8
bun run "$env:FREE_CODE_E2E_ROOT\verify-agent-memory-snapshot.ts" | Tee-Object "$env:FREE_CODE_E2E_ROOT\result.json"
```

通过标准：

- 命令退出码为 0。
- `D:\tmp\free-code-agent-memory-snapshot-e2e\result.json` 中所有 `passed` 都为 `true`。
- 本地记忆目录只出现在 `D:\tmp\free-code-agent-memory-snapshot-e2e\project\.claude\agent-memory-local\reviewer`。
- `replaceFromSnapshot()` 后旧的 `extra.md` 不存在，但 `keep.txt` 仍存在。

## 4. 人工复核步骤

1. 打开 `D:\tmp\free-code-agent-memory-snapshot-e2e\result.json`。
2. 逐项确认每个用例的 `details` 与预期一致。
3. 打开临时项目的 `.claude` 目录，确认：
   - 快照目录包含 `snapshot.json` 和快照 Markdown。
   - 本地记忆目录包含复制后的 Markdown。
   - `.snapshot-synced.json` 的 `syncedFrom` 与最后一次操作的时间一致。
4. 确认仓库工作区没有新增测试脚本或测试数据。

不可自动化边界：

- 用户界面中“是否用新快照覆盖本地记忆”的确认弹窗不在该文件内；本文件只返回 `prompt-update`，弹窗和用户选择需要由调用方流程验证。
