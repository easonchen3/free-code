import { mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { type AgentMemoryScope, getAgentMemoryDir } from './agentMemory.js'

/**
 * Agent 记忆快照模块。
 *
 * 该文件负责把项目级快照同步到本地 Agent 记忆目录，并记录同步时间，
 * 用于在 Agent 第一次使用或项目快照更新后，提示或执行本地记忆初始化。
 */

/** 项目目录下保存 Agent 记忆快照的固定子目录名。 */
const SNAPSHOT_BASE = 'agent-memory-snapshots'

/** 快照目录中的元数据文件名，记录快照最近更新时间。 */
const SNAPSHOT_JSON = 'snapshot.json'

/** 本地 Agent 记忆目录中的同步标记文件名，记录当前本地记忆来自哪个快照版本。 */
const SYNCED_JSON = '.snapshot-synced.json'

/** 快照元数据 schema，用于确认快照至少包含有效的更新时间。 */
const snapshotMetaSchema = lazySchema(() =>
  z.object({
    updatedAt: z.string().min(1),
  }),
)

/** 本地同步元数据 schema，用于确认本地记忆已经对齐到哪个快照时间。 */
const syncedMetaSchema = lazySchema(() =>
  z.object({
    syncedFrom: z.string().min(1),
  }),
)

/** 本地同步标记的数据结构，表示本地 Agent 记忆来源的快照时间。 */
type SyncedMeta = z.infer<ReturnType<typeof syncedMetaSchema>>

/**
 * 返回当前项目中某个 Agent 类型的快照目录。
 *
 * @param agentType Agent 类型名，会作为快照目录的最后一级路径。
 * @returns 快照目录的绝对路径，形如 `<cwd>/.claude/agent-memory-snapshots/<agentType>/`。
 */
export function getSnapshotDirForAgent(agentType: string): string {
  // 1. 使用当前项目目录作为根，确保快照跟随项目而不是全局用户目录。
  return join(getCwd(), '.claude', SNAPSHOT_BASE, agentType)
}

/**
 * 返回某个 Agent 类型的快照元数据文件路径。
 *
 * @param agentType Agent 类型名。
 * @returns `snapshot.json` 的绝对路径。
 */
function getSnapshotJsonPath(agentType: string): string {
  // 1. 在 Agent 快照目录下拼出固定元数据文件名。
  return join(getSnapshotDirForAgent(agentType), SNAPSHOT_JSON)
}

/**
 * 返回某个 Agent 在指定记忆作用域下的同步标记文件路径。
 *
 * @param agentType Agent 类型名。
 * @param scope Agent 记忆作用域，用于区分本地、项目等不同存储位置。
 * @returns `.snapshot-synced.json` 的绝对路径。
 */
function getSyncedJsonPath(agentType: string, scope: AgentMemoryScope): string {
  // 1. 同步标记写在实际本地记忆目录中，便于和记忆文件一起迁移或清理。
  return join(getAgentMemoryDir(agentType, scope), SYNCED_JSON)
}

/**
 * 读取并校验 JSON 文件，读取失败或结构不符合预期时返回空值。
 *
 * @param path 待读取的 JSON 文件路径。
 * @param schema 用于校验解析结果的 zod schema。
 * @returns 校验通过的数据；文件不存在、解析失败或 schema 不匹配时返回 `null`。
 */
async function readJsonFile<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    // 1. 按 UTF-8 读取文本，避免平台默认编码影响 JSON 解析。
    const content = await readFile(path, { encoding: 'utf-8' })
    // 2. 先解析再校验结构，只有两步都成功才把数据交给调用方。
    const result = schema.safeParse(jsonParse(content))
    return result.success ? result.data : null
  } catch {
    // 3. 快照文件缺失、内容损坏或读取异常都按“没有可用元数据”处理。
    return null
  }
}

/**
 * 将项目快照中的普通文件复制到指定作用域的本地 Agent 记忆目录。
 *
 * @param agentType Agent 类型名。
 * @param scope 目标 Agent 记忆作用域。
 * @returns 复制完成后返回；复制失败会记录调试日志但不向外抛出。
 */
async function copySnapshotToLocal(
  agentType: string,
  scope: AgentMemoryScope,
): Promise<void> {
  // 1. 计算快照来源目录和本地目标目录。
  const snapshotMemDir = getSnapshotDirForAgent(agentType)
  const localMemDir = getAgentMemoryDir(agentType, scope)

  // 2. 先确保目标目录存在，避免后续逐文件写入失败。
  await mkdir(localMemDir, { recursive: true })

  try {
    // 3. 只复制快照中的普通记忆文件，跳过记录快照版本的元数据文件。
    const files = await readdir(snapshotMemDir, { withFileTypes: true })
    for (const dirent of files) {
      if (!dirent.isFile() || dirent.name === SNAPSHOT_JSON) continue
      const content = await readFile(join(snapshotMemDir, dirent.name), {
        encoding: 'utf-8',
      })
      // 4. 保留原文件名写入本地目录，使本地记忆结构与快照保持一致。
      await writeFile(join(localMemDir, dirent.name), content)
    }
  } catch (e) {
    // 5. 快照复制属于初始化辅助能力，失败时记录日志，由上层继续决定是否提示用户。
    logForDebugging(`Failed to copy snapshot to local agent memory: ${e}`)
  }
}

/**
 * 保存本地 Agent 记忆已经同步到指定快照时间的标记。
 *
 * @param agentType Agent 类型名。
 * @param scope Agent 记忆作用域。
 * @param snapshotTimestamp 快照元数据中的更新时间。
 * @returns 同步标记写入完成后返回；写入失败会记录调试日志。
 */
async function saveSyncedMeta(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  // 1. 同步标记和本地记忆放在同一目录，表示这一份本地记忆的来源版本。
  const syncedPath = getSyncedJsonPath(agentType, scope)
  const localMemDir = getAgentMemoryDir(agentType, scope)
  // 2. 先创建目录，再写入精简的同步来源时间。
  await mkdir(localMemDir, { recursive: true })
  const meta: SyncedMeta = { syncedFrom: snapshotTimestamp }
  try {
    // 3. 使用项目统一的慢操作 JSON 序列化，保持输出格式一致。
    await writeFile(syncedPath, jsonStringify(meta))
  } catch (e) {
    // 4. 同步标记失败不会破坏已复制的记忆，但会影响下次是否再次提示更新。
    logForDebugging(`Failed to save snapshot sync metadata: ${e}`)
  }
}

/**
 * 检查项目快照和本地 Agent 记忆的同步状态。
 *
 * @param agentType Agent 类型名。
 * @param scope Agent 记忆作用域。
 * @returns 返回下一步动作：无操作、首次初始化，或提示用户用新快照更新。
 */
export async function checkAgentMemorySnapshot(
  agentType: string,
  scope: AgentMemoryScope,
): Promise<{
  action: 'none' | 'initialize' | 'prompt-update'
  snapshotTimestamp?: string
}> {
  // 1. 读取项目快照元数据，没有合法快照时不触发任何动作。
  const snapshotMeta = await readJsonFile(
    getSnapshotJsonPath(agentType),
    snapshotMetaSchema(),
  )

  if (!snapshotMeta) {
    return { action: 'none' }
  }

  // 2. 检查本地记忆目录中是否已经存在 Markdown 记忆文件。
  const localMemDir = getAgentMemoryDir(agentType, scope)

  let hasLocalMemory = false
  try {
    const dirents = await readdir(localMemDir, { withFileTypes: true })
    hasLocalMemory = dirents.some(d => d.isFile() && d.name.endsWith('.md'))
  } catch {
    // 3. 本地目录不存在等同于没有任何本地记忆。
  }

  if (!hasLocalMemory) {
    // 4. 没有本地记忆时，可以直接用项目快照初始化。
    return { action: 'initialize', snapshotTimestamp: snapshotMeta.updatedAt }
  }

  // 5. 有本地记忆时再读取同步标记，判断项目快照是否比本地来源更新。
  const syncedMeta = await readJsonFile(
    getSyncedJsonPath(agentType, scope),
    syncedMetaSchema(),
  )

  if (
    !syncedMeta ||
    new Date(snapshotMeta.updatedAt) > new Date(syncedMeta.syncedFrom)
  ) {
    return {
      action: 'prompt-update',
      snapshotTimestamp: snapshotMeta.updatedAt,
    }
  }

  // 6. 本地记忆已经同步到当前或更新的快照版本，不需要提示用户。
  return { action: 'none' }
}

/**
 * 使用项目快照初始化本地 Agent 记忆。
 *
 * @param agentType Agent 类型名。
 * @param scope Agent 记忆作用域。
 * @param snapshotTimestamp 用于写入同步标记的快照更新时间。
 * @returns 初始化和同步标记写入完成后返回。
 */
export async function initializeFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  // 1. 记录初始化动作，便于排查快照来源问题。
  logForDebugging(
    `Initializing agent memory for ${agentType} from project snapshot`,
  )
  // 2. 复制快照文件，再记录本地记忆对应的快照版本。
  await copySnapshotToLocal(agentType, scope)
  await saveSyncedMeta(agentType, scope, snapshotTimestamp)
}

/**
 * 用项目快照替换本地 Agent 记忆中的 Markdown 文件。
 *
 * @param agentType Agent 类型名。
 * @param scope Agent 记忆作用域。
 * @param snapshotTimestamp 用于写入同步标记的快照更新时间。
 * @returns 替换和同步标记写入完成后返回。
 */
export async function replaceFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  // 1. 记录替换动作，方便区分首次初始化和覆盖更新。
  logForDebugging(
    `Replacing agent memory for ${agentType} with project snapshot`,
  )
  // 2. 复制前先删除已有 Markdown 记忆，避免快照中已删除的文件在本地残留。
  const localMemDir = getAgentMemoryDir(agentType, scope)
  try {
    const existing = await readdir(localMemDir, { withFileTypes: true })
    for (const dirent of existing) {
      if (dirent.isFile() && dirent.name.endsWith('.md')) {
        await unlink(join(localMemDir, dirent.name))
      }
    }
  } catch {
    // 3. 本地目录可能尚未创建，后续复制流程会负责创建目标目录。
  }
  // 4. 写入快照文件并更新同步标记。
  await copySnapshotToLocal(agentType, scope)
  await saveSyncedMeta(agentType, scope, snapshotTimestamp)
}

/**
 * 仅记录本地记忆已确认当前快照，不改动实际记忆文件。
 *
 * @param agentType Agent 类型名。
 * @param scope Agent 记忆作用域。
 * @param snapshotTimestamp 用于写入同步标记的快照更新时间。
 * @returns 同步标记写入完成后返回。
 */
export async function markSnapshotSynced(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  // 1. 用于用户选择跳过更新时，避免同一个快照版本反复提示。
  await saveSyncedMeta(agentType, scope, snapshotTimestamp)
}
