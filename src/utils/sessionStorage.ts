import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import type { Dirent } from 'fs'
// readFileTailSync 需要同步 fs API；这里和上面的 fs/promises 明确分开，
// 并用具名导入避免和异步版本的函数名混淆。
import { closeSync, fstatSync, openSync, readSync } from 'fs'
import {
  appendFile as fsAppendFile,
  open as fsOpen,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { basename, dirname, join } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  getOriginalCwd,
  getPlanSlugCache,
  getPromptId,
  getSessionId,
  getSessionProjectDir,
  isSessionPersistenceDisabled,
  switchSession,
} from '../bootstrap/state.js'
import { builtInCommandNames } from '../commands.js'
import { COMMAND_NAME_TAG, TICK_TAG } from '../constants/xml.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import * as sessionIngress from '../services/api/sessionIngress.js'
import { REPL_TOOL_NAME } from '../tools/REPLTool/constants.js'
import {
  type AgentId,
  asAgentId,
  asSessionId,
  type SessionId,
} from '../types/ids.js'
import type { AttributionSnapshotMessage } from '../types/logs.js'
import {
  type ContentReplacementEntry,
  type ContextCollapseCommitEntry,
  type ContextCollapseSnapshotEntry,
  type Entry,
  type FileHistorySnapshotMessage,
  type LogOption,
  type PersistedWorktreeSession,
  type SerializedMessage,
  sortLogs,
  type TranscriptMessage,
} from '../types/logs.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemCompactBoundaryMessage,
  SystemMessage,
  UserMessage,
} from '../types/message.js'
import type { QueueOperationMessage } from '../types/messageQueueTypes.js'
import { uniq } from './array.js'
import { registerCleanup } from './cleanupRegistry.js'
import { updateSessionName } from './concurrentSessions.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { isFsInaccessible } from './errors.js'
import type { FileHistorySnapshot } from './fileHistory.js'
import { formatFileSize } from './format.js'
import { getFsImplementation } from './fsOperations.js'
import { getWorktreePaths } from './getWorktreePaths.js'
import { getBranch } from './git.js'
import { gracefulShutdownSync, isShuttingDown } from './gracefulShutdown.js'
import { parseJSONL } from './json.js'
import { logError } from './log.js'
import { extractTag, isCompactBoundaryMessage } from './messages.js'
import { sanitizePath } from './path.js'
import {
  extractJsonStringField,
  extractLastJsonStringField,
  LITE_READ_BUF_SIZE,
  readHeadAndTail,
  readTranscriptForLoad,
  SKIP_PRECOMPACT_THRESHOLD,
} from './sessionStoragePortable.js'
import { getSettings_DEPRECATED } from './settings/settings.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'
import { validateUuid } from './uuid.js'

// 在模块加载时缓存版本号，绕开 Bun 在异步上下文里处理 --define 的已知问题。
// 参考：https://github.com/oven-sh/bun/issues/26168
const VERSION = typeof MACRO !== 'undefined' ? MACRO.VERSION : 'unknown'

type Transcript = (
  | UserMessage
  | AssistantMessage
  | AttachmentMessage
  | SystemMessage
)[]

// 不在模块加载时缓存 cwd，而是在每个调用点读取 getOriginalCwd()。
// 导入期间 getCwd() 可能早于 bootstrap 的 realpathSync 归一化执行，
// 这会让会话写入目录和后续读取目录不一致，导致已保存会话不可见。

/**
 * 提取首条提示词时用来跳过“非用户意图”内容的预编译正则。
 * 它会过滤以小写 XML 标签开头的 IDE 上下文、hook 输出、任务通知、
 * channel 消息等内容，以及合成的中断标记。这里使用通用规则并和
 * sessionStoragePortable.ts 保持一致，避免维护一份不断膨胀且容易滞后的白名单。
 */
// tombstone 的慢路径会读取并重写整个 session 文件。文件可能增长到 GB 级，
// 因此超过 50MB 就不走整文件重写，避免 OOM（inc-3930）。
const MAX_TOMBSTONE_REWRITE_BYTES = 50 * 1024 * 1024

const SKIP_FIRST_PROMPT_PATTERN =
  /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

/**
 * 判断 JSONL entry 是否属于对话 transcript。
 * transcript 只包含 user、assistant、attachment、system 四类消息。
 * 这是“哪些 entry 参与对话恢复”的唯一判定入口，loadTranscriptFile()
 * 也依赖它决定哪些消息进入 parentUuid 链。
 *
 * progress 是临时 UI 状态，不应作为 transcript 消息持久化，也不能参与
 * parentUuid 链。历史上把 progress 纳入链会在恢复时制造分叉，使真实
 * 对话消息变成孤儿节点（见 #14373、#23537）。
 */
export function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  return (
    entry.type === 'user' ||
    entry.type === 'assistant' ||
    entry.type === 'attachment' ||
    entry.type === 'system'
  )
}

/**
 * 判断消息是否参与 parentUuid 链。
 * 写入路径（insertMessageChain、useLogMessages）用它跳过 progress；
 * 已经写入旧 transcript 的 progress 链由 loadTranscriptFile() 中的
 * progressBridge 兼容修正。
 */
export function isChainParticipant(m: Pick<Message, 'type'>): boolean {
  return m.type !== 'progress'
}

type LegacyProgressEntry = {
  type: 'progress'
  uuid: UUID
  parentUuid: UUID | null
}

/**
 * 兼容 PR #24099 之前写入的 progress entry。
 * 这些 entry 已不在 Entry 联合类型中，但旧文件里仍可能带 uuid 和 parentUuid；
 * loadTranscriptFile() 会借助它们把链路桥接到真正的父消息上。
 */
function isLegacyProgressEntry(entry: unknown): entry is LegacyProgressEntry {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'type' in entry &&
    entry.type === 'progress' &&
    'uuid' in entry &&
    typeof entry.uuid === 'string'
  )
}

/**
 * 高频工具进度事件，例如 Sleep 每秒一次、Bash 每个输出块一次。
 * 这些事件只用于 UI，不发送给 API，也不会在工具完成后继续渲染。
 * REPL.tsx 用它们做原地替换；loadTranscriptFile() 用它识别并跳过旧日志里的进度 entry。
 */
const EPHEMERAL_PROGRESS_TYPES = new Set([
  'bash_progress',
  'powershell_progress',
  'mcp_progress',
  ...(feature('PROACTIVE') || feature('KAIROS')
    ? (['sleep_progress'] as const)
    : []),
])
export function isEphemeralToolProgress(dataType: unknown): boolean {
  return typeof dataType === 'string' && EPHEMERAL_PROGRESS_TYPES.has(dataType)
}

export function getProjectsDir(): string {
  // 所有项目的 session 文件都挂在 CLAUDE_CONFIG_DIR/projects 下。
  // 具体项目目录名由 getProjectDir() 用 cwd 清洗后得到，避免不同项目互相混写。
  return join(getClaudeConfigHomeDir(), 'projects')
}

export function getTranscriptPath(): string {
  // 当前 session 的 transcript 路径由“session 所属项目目录 + sessionId.jsonl”组成。
  // 普通会话按 originalCwd 推导项目目录；resume/branch/worktree 场景可能通过
  // sessionProjectDir 指定真实文件目录，所以这里必须优先使用它。
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, `${getSessionId()}.jsonl`)
}

export function getTranscriptPathForSession(sessionId: string): string {
  // 查询当前 session 的 transcript 时，必须和 getTranscriptPath() 一样尊重
  // sessionProjectDir。否则 hook 会基于 originalCwd 算出 transcript_path，
  // 但实际文件可能因 resume/branch 写在 sessionProjectDir 下，最终被误判为缺失
  //（gh-30217）。CC-34 已经把 sessionId 和 sessionProjectDir 做成原子切换，
  // 这里也必须同时读取二者，避免路径漂移。
  //
  // 对非当前 session，只能按 originalCwd 推断路径，因为这里没有维护
  // sessionId 到 projectDir 的全量映射。调用方若要写指定 session，应该显式传 fullPath
  //（多数 save* 函数已经支持）。
  if (sessionId === getSessionId()) {
    return getTranscriptPath()
  }
  const projectDir = getProjectDir(getOriginalCwd())
  return join(projectDir, `${sessionId}.jsonl`)
}

// session JSONL 可能增长到 GB 级（inc-3930）。直接读取原始 transcript 的调用方
// 必须在超过该阈值时放弃，避免 OOM。
export const MAX_TRANSCRIPT_READ_BYTES = 50 * 1024 * 1024

// agentId 到子目录的内存映射，用于把相关 subagent transcript 分组存放，
// 例如 workflow 写到 subagents/workflows/<runId>/。agent 启动前写入，
// getAgentTranscriptPath() 计算路径时读取。
const agentTranscriptSubdirs = new Map<string, string>()

export function setAgentTranscriptSubdir(
  agentId: string,
  subdir: string,
): void {
  // agent 启动阶段先登记分组子目录，后续 transcript 路径计算会读取这份映射。
  // 这让 workflow/runId 这类长任务可以把多个 agent 文件归档到同一目录下。
  agentTranscriptSubdirs.set(agentId, subdir)
}

export function clearAgentTranscriptSubdir(agentId: string): void {
  // agent 生命周期结束后清理内存映射，避免同名 agentId 在后续 session 中复用旧路径。
  agentTranscriptSubdirs.delete(agentId)
}

export function getAgentTranscriptPath(agentId: AgentId): string {
  // subagent transcript 和主 session transcript 同属一个 session 目录；
  // 如果主 transcript 使用 sessionProjectDir，subagent 路径也必须跟随。
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  const sessionId = getSessionId()
  const subdir = agentTranscriptSubdirs.get(agentId)
  const base = subdir
    ? join(projectDir, sessionId, 'subagents', subdir)
    : join(projectDir, sessionId, 'subagents')
  return join(base, `agent-${agentId}.jsonl`)
}

function getAgentMetadataPath(agentId: AgentId): string {
  // metadata sidecar 和 agent transcript 放在同一目录，只替换扩展名。
  // 这样移动/分组 subagent 文件时，恢复所需的 agentType/worktreePath 会跟随同一位置。
  return getAgentTranscriptPath(agentId).replace(/\.jsonl$/, '.meta.json')
}

export type AgentMetadata = {
  agentType: string
  /** agent 以 isolation: "worktree" 启动时使用的 worktree 路径。 */
  worktreePath?: string
  /** AgentTool 输入里的原始任务描述。恢复 agent 时用它展示原始任务，
   * 避免通知里只能显示占位文案。旧 metadata 文件可能没有这个字段。 */
  description?: string
}

/**
 * 持久化 subagent 启动时使用的 agentType。
 * resume 时如果没有显式传 subagent_type，就依赖这个 sidecar 文件恢复正确路由。
 * 否则恢复 fork 时会悄悄退化成 general-purpose，只有 4KB 系统提示词且丢失继承历史。
 * 使用 sidecar 文件可以避免修改 JSONL 主 schema。
 *
 * 如果 agent 以 worktree 隔离模式启动，也会保存 worktreePath，
 * 让恢复时能切回正确 cwd。
 */
export async function writeAgentMetadata(
  agentId: AgentId,
  metadata: AgentMetadata,
): Promise<void> {
  // 写 sidecar 前先确保目录存在；JSONL 主 schema 不承载这些恢复路由字段。
  const path = getAgentMetadataPath(agentId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(metadata))
}

export async function readAgentMetadata(
  agentId: AgentId,
): Promise<AgentMetadata | null> {
  // sidecar 缺失是正常情况：旧 session 或未隔离 agent 没有 metadata。
  // 只有真正的非文件访问类错误才继续抛出。
  const path = getAgentMetadataPath(agentId)
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as AgentMetadata
  } catch (e) {
    if (isFsInaccessible(e)) return null
    throw e
  }
}

export type RemoteAgentMetadata = {
  taskId: string
  remoteTaskType: string
  /** CCR session ID；resume 时用它从 Sessions API 拉取实时状态。 */
  sessionId: string
  title: string
  command: string
  spawnedAt: number
  toolUseId?: string
  isLongRunning?: boolean
  isUltraplan?: boolean
  isRemoteReview?: boolean
  remoteTaskMetadata?: Record<string, unknown>
}

function getRemoteAgentsDir(): string {
  // 和 getAgentTranscriptPath() 一样优先使用 sessionProjectDir。
  // 这里返回的是包含 .jsonl 的项目目录，因此还需要再拼接 sessionId。
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, getSessionId(), 'remote-agents')
}

function getRemoteAgentMetadataPath(taskId: string): string {
  // taskId 是 remote-agent 的稳定身份，文件名用它做 key，
  // resume 时无需先读取 transcript 就能扫描出所有待重连任务。
  return join(getRemoteAgentsDir(), `remote-agent-${taskId}.meta.json`)
}

/**
 * 持久化 remote-agent 任务的身份信息，供 session resume 时重连。
 * 每个任务一个 sidecar 文件，位于 subagents 的同级目录；即使
 * hydrateSessionFromRemote 覆盖 .jsonl，也不会丢失这些文件。
 * 状态始终在恢复时从 CCR 新拉取，本地只保存任务身份。
 */
export async function writeRemoteAgentMetadata(
  taskId: string,
  metadata: RemoteAgentMetadata,
): Promise<void> {
  // remote-agent 状态本身来自 CCR/Sessions API，本地只保存重新连接所需的身份索引。
  const path = getRemoteAgentMetadataPath(taskId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(metadata))
}

export async function readRemoteAgentMetadata(
  taskId: string,
): Promise<RemoteAgentMetadata | null> {
  // 删除、旧版本或未成功启动的 remote task 都可能没有 sidecar；调用方按 null 处理。
  const path = getRemoteAgentMetadataPath(taskId)
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as RemoteAgentMetadata
  } catch (e) {
    if (isFsInaccessible(e)) return null
    throw e
  }
}

export async function deleteRemoteAgentMetadata(taskId: string): Promise<void> {
  // 任务完成或确认不可恢复后删除 sidecar。文件已不存在时视为幂等成功。
  const path = getRemoteAgentMetadataPath(taskId)
  try {
    await unlink(path)
  } catch (e) {
    if (isFsInaccessible(e)) return
    throw e
  }
}

/**
 * 扫描 remote-agents/ 目录下所有已持久化的任务 metadata。
 * restoreRemoteAgentTasks 用这些信息重连仍在运行的 CCR session。
 */
export async function listRemoteAgentMetadata(): Promise<
  RemoteAgentMetadata[]
> {
  const dir = getRemoteAgentsDir()
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (e) {
    if (isFsInaccessible(e)) return []
    throw e
  }
  const results: RemoteAgentMetadata[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.meta.json')) continue
    try {
      const raw = await readFile(join(dir, entry.name), 'utf-8')
      results.push(JSON.parse(raw) as RemoteAgentMetadata)
    } catch (e) {
      // 跳过不可读或损坏的文件。崩溃时留下的半截 fire-and-forget 写入
      // 不应该拖垮整个恢复流程。
      logForDebugging(
        `listRemoteAgentMetadata: skipping ${entry.name}: ${String(e)}`,
      )
    }
  }
  return results
}

export function sessionIdExists(sessionId: string): boolean {
  // 这是同步热路径检查，只按当前 originalCwd 推导项目目录。
  // 它用于判断本地是否已有某个 session 文件，不负责跨 projectDir 搜索。
  const projectDir = getProjectDir(getOriginalCwd())
  const sessionFile = join(projectDir, `${sessionId}.jsonl`)
  const fs = getFsImplementation()
  try {
    fs.statSync(sessionFile)
    return true
  } catch {
    return false
  }
}

// 导出给测试使用。
export function getNodeEnv(): string {
  return process.env.NODE_ENV || 'development'
}

// 导出给测试使用。
export function getUserType(): string {
  return process.env.USER_TYPE || 'external'
}

function getEntrypoint(): string | undefined {
  // entrypoint 写入 transcript 后可区分 cli、sdk-ts、sdk-py 等来源，
  // 下游统计和恢复逻辑可以据此识别会话入口。
  return process.env.CLAUDE_CODE_ENTRYPOINT
}

export function isCustomTitleEnabled(): boolean {
  // 当前实现始终启用自定义标题；保留函数边界便于调用方不依赖 feature flag 细节。
  return true
}

// 这里做 memoize 是为了降低热路径开销：hooks.ts 的 createBaseHookInput
// 每轮会调用十余次（PostToolUse 单独约 5 次），各种 save* 函数也会调用。
// 输入只有 cwd；home/env/regex 在一个 session 内稳定，所以同一输入结果稳定。
// worktree 切换只会换一个 key，不需要主动清缓存。
export const getProjectDir = memoize((projectDir: string): string => {
  return join(getProjectsDir(), sanitizePath(projectDir))
})

let project: Project | null = null
let cleanupRegistered = false

function getProject(): Project {
  // Project 是本模块的进程级写入协调器：缓存当前 session metadata、
  // 管理 JSONL 写队列，并在进程退出前做最后一次 flush/re-append。
  if (!project) {
    project = new Project()

    // 只注册一次清理回调，进程退出前把写队列和尾部 metadata 落盘。
    if (!cleanupRegistered) {
      registerCleanup(async () => {
        // 先刷写队列，再把 customTitle、tag 等 session metadata 重新追加到文件尾部。
        // readLiteMetadata 只读最后 64KB；如果 /rename 后又写入大量消息，
        // custom-title 会被挤出尾部窗口，/resume 就只能显示自动生成的 firstPrompt。
        await project?.flush()
        try {
          project?.reAppendSessionMetadata()
        } catch {
          // 尽力而为：metadata 重新追加失败不能影响退出清理。
        }
      })
      cleanupRegistered = true
    }
  }
  return project
}

/**
 * 重置 Project 单例的刷写状态，供测试隔离使用。
 * 避免不同测试通过共享计数器、定时器或队列互相影响。
 */
export function resetProjectFlushStateForTesting(): void {
  project?._resetFlushState()
}

/**
 * 重置整个 Project 单例，供测试切换 CLAUDE_CONFIG_DIR 时使用。
 * 避免旧的 sessionFile 路径残留到下一组测试。
 */
export function resetProjectForTesting(): void {
  project = null
}

export function setSessionFileForTesting(path: string): void {
  getProject().sessionFile = path
}

type InternalEventWriter = (
  eventType: string,
  payload: Record<string, unknown>,
  options?: { isCompaction?: boolean; agentId?: string },
) => Promise<void>

/**
 * 注册 CCR v2 内部事件写入器。
 * 设置后，transcript 消息会写成内部 worker event，而不是走 v1 Session Ingress。
 */
export function setInternalEventWriter(writer: InternalEventWriter): void {
  getProject().setInternalEventWriter(writer)
}

type InternalEventReader = () => Promise<
  { payload: Record<string, unknown>; agent_id?: string }[] | null
>

/**
 * 注册 CCR v2 内部事件读取器。
 * 设置后，hydrateFromCCRv2InternalEvents() 可以读取 foreground 和 subagent 事件，
 * 在重连时重建对话状态。
 */
export function setInternalEventReader(
  reader: InternalEventReader,
  subagentReader: InternalEventReader,
): void {
  getProject().setInternalEventReader(reader)
  getProject().setInternalSubagentEventReader(subagentReader)
}

/**
 * 测试用：给当前 Project 设置远端 ingress URL。
 * 等价于生产环境 hydrateRemoteSession 完成后启用远端持久化。
 */
export function setRemoteIngressUrlForTesting(url: string): void {
  getProject().setRemoteIngressUrl(url)
}

const REMOTE_FLUSH_INTERVAL_MS = 10

class Project {
  // 只缓存当前 session 的展示和恢复 metadata，不缓存所有 session。
  currentSessionTag: string | undefined
  currentSessionTitle: string | undefined
  currentSessionAgentName: string | undefined
  currentSessionAgentColor: string | undefined
  currentSessionLastPrompt: string | undefined
  currentSessionAgentSetting: string | undefined
  currentSessionMode: 'coordinator' | 'normal' | undefined
  // 三态语义：undefined 表示从未进入/不写入，null 表示已退出 worktree，
  // 对象表示当前仍在 worktree。reAppendSessionMetadata 会写 null，
  // 这样 --resume 能区分“正常退出 worktree”和“进程在 worktree 中崩溃”。
  currentSessionWorktree: PersistedWorktreeSession | null | undefined
  currentSessionPrNumber: number | undefined
  currentSessionPrUrl: string | undefined
  currentSessionPrRepository: string | undefined

  sessionFile: string | null = null
  // sessionFile 还未创建时暂存 entry。首次 user/assistant 消息会触发
  // materializeSessionFile 并刷出这些 entry，避免产生只有 metadata 的 session 文件。
  private pendingEntries: Entry[] = []
  private remoteIngressUrl: string | null = null
  private internalEventWriter: InternalEventWriter | null = null
  private internalEventReader: InternalEventReader | null = null
  private internalSubagentEventReader: InternalEventReader | null = null
  private pendingWriteCount: number = 0
  private flushResolvers: Array<() => void> = []
  // 按文件拆分的写队列。每个 entry 都带 resolve 回调，调用方可以等待自己那次写入完成。
  private writeQueues = new Map<
    string,
    Array<{ entry: Entry; resolve: () => void }>
  >()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private activeDrain: Promise<void> | null = null
  private FLUSH_INTERVAL_MS = 100
  private readonly MAX_CHUNK_BYTES = 100 * 1024 * 1024

  constructor() {
    // 构造函数保持无副作用：真正的 session 文件路径要等第一条可持久化消息到来后
    // 才 materialize。这样单纯启动、设置标题或读取列表都不会制造空 JSONL 文件。
  }

  /** @internal 测试用：重置刷写定时器、队列和 pending 计数。 */
  _resetFlushState(): void {
    this.pendingWriteCount = 0
    this.flushResolvers = []
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.activeDrain = null
    this.writeQueues = new Map()
  }

  private incrementPendingWrites(): void {
    // pendingWriteCount 统计所有还没完成的写事务，包括入队写和直接重写文件的操作。
    // flush() 依赖它判断是否还需要等待异步清理。
    this.pendingWriteCount++
  }

  private decrementPendingWrites(): void {
    // 每个 trackWrite 结束后递减；归零时唤醒所有正在 flush() 中等待的调用方。
    // 这样调用方可以在退出、测试或关键流程前确认写入真正落盘。
    this.pendingWriteCount--
    if (this.pendingWriteCount === 0) {
      // 所有 pending 写入完成后，唤醒正在等待 flush() 的调用方。
      for (const resolve of this.flushResolvers) {
        resolve()
      }
      this.flushResolvers = []
    }
  }

  private async trackWrite<T>(fn: () => Promise<T>): Promise<T> {
    // 统一包装所有会改动 transcript 的异步操作，保证异常路径也会释放 pending 计数。
    // 没有这层 finally，写失败可能导致 flush() 永久等待。
    this.incrementPendingWrites()
    try {
      return await fn()
    } finally {
      this.decrementPendingWrites()
    }
  }

  private enqueueWrite(filePath: string, entry: Entry): Promise<void> {
    // 同一个进程可能同时写主 session、subagent sidechain、content replacement 等多个文件。
    // 队列按 filePath 拆分，保证单文件追加顺序稳定，同时允许不同文件共享同一 drain 轮次。
    return new Promise<void>(resolve => {
      let queue = this.writeQueues.get(filePath)
      if (!queue) {
        queue = []
        this.writeQueues.set(filePath, queue)
      }
      queue.push({ entry, resolve })
      this.scheduleDrain()
    })
  }

  private scheduleDrain(): void {
    // 延迟刷写把短时间内产生的大量 JSONL entry 合并成批量 append，
    // 降低频繁 fs append 的系统调用成本。已有 timer 时不重复安排。
    if (this.flushTimer) {
      return
    }
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null
      this.activeDrain = this.drainWriteQueue()
      await this.activeDrain
      this.activeDrain = null
      // drain 期间如果又有新 entry 入队，继续安排下一轮刷写。
      if (this.writeQueues.size > 0) {
        this.scheduleDrain()
      }
    }, this.FLUSH_INTERVAL_MS)
  }

  private async appendToFile(filePath: string, data: string): Promise<void> {
    // 正常路径直接 append；如果目录还没创建，则补建父目录后重试一次。
    // 这样调用方不必在每个写入点都关心 session/subagent 目录是否存在。
    try {
      await fsAppendFile(filePath, data, { mode: 0o600 })
    } catch {
      // 目录可能尚不存在；部分 NFS 类文件系统会返回非标准错误码，
      // 因此不按具体 code 分支，直接补建目录后重试。
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
      await fsAppendFile(filePath, data, { mode: 0o600 })
    }
  }

  private async drainWriteQueue(): Promise<void> {
    // drain 是真正把内存队列写入磁盘的地方：每个文件按入队顺序拼成 chunk，
    // chunk 达到上限就先落盘，避免单次拼接占用过大内存。
    for (const [filePath, queue] of this.writeQueues) {
      if (queue.length === 0) {
        continue
      }
      const batch = queue.splice(0)

      let content = ''
      const resolvers: Array<() => void> = []

      for (const { entry, resolve } of batch) {
        const line = jsonStringify(entry) + '\n'

        if (content.length + line.length >= this.MAX_CHUNK_BYTES) {
          // 当前批次接近上限时先写出 chunk，并释放这些 entry 对应的等待者。
          await this.appendToFile(filePath, content)
          for (const r of resolvers) {
            r()
          }
          resolvers.length = 0
          content = ''
        }

        content += line
        resolvers.push(resolve)
      }

      if (content.length > 0) {
        await this.appendToFile(filePath, content)
        for (const r of resolvers) {
          r()
        }
      }
    }

    // 清理已经 drain 完的空队列，防止 Map 无界增长。
    for (const [filePath, queue] of this.writeQueues) {
      if (queue.length === 0) {
        this.writeQueues.delete(filePath)
      }
    }
  }

  resetSessionFile(): void {
    // 切换 session 时丢弃旧文件指针和旧 pending entry。
    // 新 session 会在第一条 user/assistant 消息到来时重新 materialize。
    this.sessionFile = null
    this.pendingEntries = []
  }

  /**
   * 把缓存的 session metadata 重新追加到 transcript 文件末尾。
   * progressive loading 的 readLiteMetadata 只读取尾部窗口；重新追加可以保证
   * 标题、标签等展示信息仍能被快速扫描到。
   *
   * 这个函数在两个场景调用，文件顺序语义不同：
   * - compaction 期间（compact.ts、reactiveCompact.ts）：在 boundary 写入前追加 metadata。
   *   这些 entry 位于 boundary 前，恢复时由 scanPreBoundaryMetadata 找回。
   * - session 退出时（cleanup handler）：在所有 boundary 后追加到 EOF。
   *   这样 loadTranscriptFile 的 pre-compact skip 不需要前向扫描也能拿到 metadata。
   *
   * 对 custom-title、tag 这类 SDK 也能修改的字段，追加前会先从尾部窗口刷新缓存。
   * 如果外部进程（SDK renameSession/tagSession）写入了更新值，当前进程会吸收它，
   * 再把新值追加到 EOF，而不是把过期 CLI 缓存写回去。尾部窗口里没有值时，
   * 当前缓存就是唯一来源，按原样追加。
   *
   * 即使值已经在尾部窗口里也会无条件追加。compaction 时距离 EOF 40KB 的 title
   * 当前可见，但后续 session 继续增长后很快会掉出窗口；跳过追加会破坏这个函数的目的。
   * SDK 不能修改的字段（last-prompt、agent-*、mode、pr-link）没有外部写入竞争，
   * 当前缓存就是权威值。
   */
  reAppendSessionMetadata(skipTitleRefresh = false): void {
    // metadata re-append 是“尾部索引友好”的补偿机制：
    // /resume 的轻量扫描只读文件头尾，长会话继续增长后，早期 title/tag 可能掉出尾部窗口。
    // 因此这里把当前缓存的展示字段重新盖到 EOF 附近。
    if (!this.sessionFile) return
    const sessionId = getSessionId() as UUID
    if (!sessionId) return

    // 同步读取尾部窗口刷新 SDK 可修改字段。窗口大小和 readLiteMetadata 一致。
    // 读取失败时返回空字符串，解析不到新值，当前缓存自然成为唯一来源。
    const tail = readFileTailSync(this.sessionFile)

    // 吸收 SDK 可能在尾部写入的更新 title/tag。当前进程打开 session 期间，
    // SDK 可能已经写了新值，此时尾部值优先；尾部没有值则继续使用当前缓存。
    //
    // 用 startsWith 只匹配列 0 的顶层 JSONL entry，避免误匹配嵌套 tool_use input
    // 中被序列化出来的 "type":"tag"。
    const tailLines = tail.split('\n')
    if (!skipTitleRefresh) {
      const titleLine = tailLines.findLast(l =>
        l.startsWith('{"type":"custom-title"'),
      )
      if (titleLine) {
        const tailTitle = extractLastJsonStringField(titleLine, 'customTitle')
        // `!== undefined` 用来区分“没匹配到”和“匹配到空字符串”。
        // renameSession 会拒绝空 title，但这里仍做防御：外部写 customTitle:""
        // 应该清掉缓存，避免下面重新追加一个过期 title。
        if (tailTitle !== undefined) {
          this.currentSessionTitle = tailTitle || undefined
        }
      }
    }
    const tagLine = tailLines.findLast(l => l.startsWith('{"type":"tag"'))
    if (tagLine) {
      const tailTag = extractLastJsonStringField(tagLine, 'tag')
      // 同理，tagSession(id, null) 会写入 tag:"" 表示清除。
      if (tailTag !== undefined) {
        this.currentSessionTag = tailTag || undefined
      }
    }

    // 重新追加 lastPrompt，让 readLiteMetadata 能展示用户最近在做什么。
    // 它先写入，这样 customTitle/tag 等更关键字段离 EOF 更近。
    if (this.currentSessionLastPrompt) {
      appendEntryToFile(this.sessionFile, {
        type: 'last-prompt',
        lastPrompt: this.currentSessionLastPrompt,
        sessionId,
      })
    }
    // 无条件追加：上面已经从尾部刷新过缓存；再写到 EOF 可以防止后续 compaction 内容
    // 把该 entry 挤出尾部扫描窗口。
    if (this.currentSessionTitle) {
      appendEntryToFile(this.sessionFile, {
        type: 'custom-title',
        customTitle: this.currentSessionTitle,
        sessionId,
      })
    }
    if (this.currentSessionTag) {
      appendEntryToFile(this.sessionFile, {
        type: 'tag',
        tag: this.currentSessionTag,
        sessionId,
      })
    }
    if (this.currentSessionAgentName) {
      appendEntryToFile(this.sessionFile, {
        type: 'agent-name',
        agentName: this.currentSessionAgentName,
        sessionId,
      })
    }
    if (this.currentSessionAgentColor) {
      appendEntryToFile(this.sessionFile, {
        type: 'agent-color',
        agentColor: this.currentSessionAgentColor,
        sessionId,
      })
    }
    if (this.currentSessionAgentSetting) {
      appendEntryToFile(this.sessionFile, {
        type: 'agent-setting',
        agentSetting: this.currentSessionAgentSetting,
        sessionId,
      })
    }
    if (this.currentSessionMode) {
      appendEntryToFile(this.sessionFile, {
        type: 'mode',
        mode: this.currentSessionMode,
        sessionId,
      })
    }
    if (this.currentSessionWorktree !== undefined) {
      appendEntryToFile(this.sessionFile, {
        type: 'worktree-state',
        worktreeSession: this.currentSessionWorktree,
        sessionId,
      })
    }
    if (
      this.currentSessionPrNumber !== undefined &&
      this.currentSessionPrUrl &&
      this.currentSessionPrRepository
    ) {
      appendEntryToFile(this.sessionFile, {
        type: 'pr-link',
        sessionId,
        prNumber: this.currentSessionPrNumber,
        prUrl: this.currentSessionPrUrl,
        prRepository: this.currentSessionPrRepository,
        timestamp: new Date().toISOString(),
      })
    }
  }

  async flush(): Promise<void> {
    // flush 需要同时处理两类工作：
    // 1. 还没触发 timer 的队列追加，立即 drain。
    // 2. removeMessageByUuid 这类非队列写，通过 pendingWriteCount 等待完成。
    // 取消尚未触发的延迟刷写定时器。
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    // 等待正在执行的 drain 完成，保持写入顺序。
    if (this.activeDrain) {
      await this.activeDrain
    }
    // 立即刷出队列中剩余的 entry。
    await this.drainWriteQueue()

    // 等待非队列类写操作完成，例如 removeMessageByUuid。
    if (this.pendingWriteCount === 0) {
      return
    }
    return new Promise<void>(resolve => {
      this.flushResolvers.push(resolve)
    })
  }

  /**
   * 按 UUID 从 transcript 中移除一条消息。
   * 主要用于清理流式响应失败后留下的孤儿消息（tombstone）。
   *
   * 目标通常是最近追加的 entry，所以优先只读取文件尾部，定位整行后用
   * truncate + 定位写删除它，避免重写整个文件。
   */
  async removeMessageByUuid(targetUuid: UUID): Promise<void> {
    // 删除优先走尾部窗口，因为 tombstone 通常紧跟在失败消息后发生，
    // 目标 entry 大概率是最近写入的行。只有尾部找不到时才考虑整文件重写。
    return this.trackWrite(async () => {
      if (this.sessionFile === null) return
      try {
        let fileSize = 0
        const fh = await fsOpen(this.sessionFile, 'r+')
        try {
          const { size } = await fh.stat()
          fileSize = size
          if (size === 0) return

          const chunkLen = Math.min(size, LITE_READ_BUF_SIZE)
          const tailStart = size - chunkLen
          const buf = Buffer.allocUnsafe(chunkLen)
          const { bytesRead } = await fh.read(buf, 0, chunkLen, tailStart)
          const tail = buf.subarray(0, bytesRead)

          // entry 由 JSON.stringify 序列化，没有键值空格。必须搜索完整
          // `"uuid":"..."`，不能只搜裸 UUID，否则可能误命中子 entry 的 parentUuid。
          // UUID 是纯 ASCII，按字节搜索是安全的。
          const needle = `"uuid":"${targetUuid}"`
          const matchIdx = tail.lastIndexOf(needle)

          if (matchIdx >= 0) {
            // 0x0a 不会出现在 UTF-8 多字节序列内部，因此即使 chunk 从字符中间开始，
            // 按字节找换行边界也是安全的。
            const prevNl = tail.lastIndexOf(0x0a, matchIdx)
            // 如果上一处换行在当前 chunk 之外，且我们不是从文件开头读取，
            // 说明目标行长于尾部窗口，交给慢路径处理。
            if (prevNl >= 0 || tailStart === 0) {
              const lineStart = prevNl + 1 // prevNl === -1 时表示从文件开头开始。
              const nextNl = tail.indexOf(0x0a, matchIdx + needle.length)
              const lineEnd = nextNl >= 0 ? nextNl + 1 : bytesRead

              const absLineStart = tailStart + lineStart
              const afterLen = bytesRead - lineEnd
              // 先截断到目标行开头，再把目标行之后的尾部内容写回。
              // 常见场景下目标就是最后一行，afterLen 为 0，只需要一次 ftruncate。
              await fh.truncate(absLineStart)
              if (afterLen > 0) {
                await fh.write(tail, lineEnd, afterLen, absLineStart)
              }
              return
            }
          }
        } finally {
          await fh.close()
        }

        // 慢路径：目标不在最后 64KB。只有 tombstone 和原写入之间插入了很多大 entry
        // 才会发生。
        if (fileSize > MAX_TOMBSTONE_REWRITE_BYTES) {
          logForDebugging(
            `Skipping tombstone removal: session file too large (${formatFileSize(fileSize)})`,
            { level: 'warn' },
          )
          return
        }
        const content = await readFile(this.sessionFile, { encoding: 'utf-8' })
        const lines = content.split('\n').filter((line: string) => {
          if (!line.trim()) return true
          try {
            const entry = jsonParse(line)
            return entry.uuid !== targetUuid
          } catch {
            return true // 保留格式异常的行，避免误删不可解析内容。
          }
        })
        await writeFile(this.sessionFile, lines.join('\n'), {
          encoding: 'utf8',
        })
      } catch {
        // 静默忽略：session 文件可能尚未创建。
      }
    })
  }

  /**
   * 判断当前是否应完全跳过 transcript 持久化。
   * 测试环境、cleanupPeriodDays=0、--no-session-persistence 或
   * CLAUDE_CODE_SKIP_PROMPT_HISTORY 都会禁写。appendEntry 和
   * materializeSessionFile 共用这个判断，保证行为一致。
   * tmuxSocket.ts 会为 Tungsten 派生的测试 session 设置该 env，
   * 避免污染用户的 --resume 列表。
   */
  private shouldSkipPersistence(): boolean {
    // 所有写入入口最终都会经过这里，保证测试、用户配置和环境变量禁写语义一致。
    // TEST_ENABLE_SESSION_PERSISTENCE 是单元测试显式打开真实磁盘写入的逃生口。
    const allowTestPersistence = isEnvTruthy(
      process.env.TEST_ENABLE_SESSION_PERSISTENCE,
    )
    return (
      (getNodeEnv() === 'test' && !allowTestPersistence) ||
      getSettings_DEPRECATED()?.cleanupPeriodDays === 0 ||
      isSessionPersistenceDisabled() ||
      isEnvTruthy(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY)
    )
  }

  /**
   * 真正创建 session 文件，写入已缓存的启动 metadata，并刷出暂存 entry。
   * 首次 user/assistant 消息到来时才调用，避免创建空 session 文件。
   */
  private async materializeSessionFile(): Promise<void> {
    // 物化是从“只有内存状态”切换到“存在真实 JSONL 文件”的时刻。
    // 它先确定 sessionFile，再补写启动阶段缓存的 metadata，最后回放 pendingEntries。
    // 这里也要检查禁写。reAppendSessionMetadata 走 appendEntryToFile，
    // 不经过 appendEntry 的逐 entry 判断；否则 --no-session-persistence
    // 仍可能创建只有 metadata 的文件。
    if (this.shouldSkipPersistence()) return
    this.ensureCurrentSessionFile()
    // materialize 前 mode/agentSetting 只在缓存里；创建文件时一并写出。
    this.reAppendSessionMetadata()
    if (this.pendingEntries.length > 0) {
      const buffered = this.pendingEntries
      this.pendingEntries = []
      for (const entry of buffered) {
        await this.appendEntry(entry)
      }
    }
  }

  async insertMessageChain(
    messages: Transcript,
    isSidechain: boolean = false,
    agentId?: string,
    startingParentUuid?: UUID | null,
    teamInfo?: { teamName?: string; agentName?: string },
  ) {
    // 把一段内存 Message 转成可恢复的 TranscriptMessage 链。
    // 核心工作是给每条消息补 parentUuid、sessionId、cwd、版本、gitBranch 等持久化字段，
    // 然后交给 appendEntry 做去重和目标文件分流。
    return this.trackWrite(async () => {
      let parentUuid: UUID | null = startingParentUuid ?? null

      // 第一条 user/assistant 消息才会 materialize session 文件。
      // 单独的 hook progress/attachment 仍只进入 pendingEntries。
      if (
        this.sessionFile === null &&
        messages.some(m => m.type === 'user' || m.type === 'assistant')
      ) {
        await this.materializeSessionFile()
      }

      // 每条消息链只读取一次当前 git 分支，避免逐条消息调用 git。
      let gitBranch: string | undefined
      try {
        gitBranch = await getBranch()
      } catch {
        // 不在 git 仓库内，或 git 命令失败；分支信息允许为空。
        gitBranch = undefined
      }

      // 如果当前 session 已有 slug，写入 transcript，供 plan 文件等恢复使用。
      const sessionId = getSessionId()
      const slug = getPlanSlugCache().get(sessionId)

      for (const message of messages) {
        // parentUuid 默认沿顺序链向前推进；compact boundary 作为新链根写 null，
        // 但保留 logicalParentUuid 让后续逻辑知道它逻辑上接在哪条旧链之后。
        const isCompactBoundary = isCompactBoundaryMessage(message)

        // tool_result 消息应挂到对应 assistant tool_use 消息下。
        // 如果创建时记录了 sourceToolAssistantUUID，就用它；否则退回顺序父节点。
        let effectiveParentUuid = parentUuid
        if (
          message.type === 'user' &&
          'sourceToolAssistantUUID' in message &&
          message.sourceToolAssistantUUID
        ) {
          effectiveParentUuid = message.sourceToolAssistantUUID
        }

        const transcriptMessage: TranscriptMessage = {
          // 注意对象字段顺序：parentUuid 放第一位，walkChainBeforeParse 依赖 JSONL
          // 行前缀 `{"parentUuid":` 做大文件字节级预过滤。
          parentUuid: isCompactBoundary ? null : effectiveParentUuid,
          logicalParentUuid: isCompactBoundary ? parentUuid : undefined,
          isSidechain,
          teamName: teamInfo?.teamName,
          agentName: teamInfo?.agentName,
          promptId:
            message.type === 'user' ? (getPromptId() ?? undefined) : undefined,
          agentId,
          ...message,
          // session 标记字段必须放在 spread 后面。--fork-session 和 --resume
          // 传入的消息可能已经是 SerializedMessage，里面带着源 sessionId/cwd 等字段
          //（removeExtraFields 只去掉 parentUuid 和 isSidechain）。如果不在这里重新盖章，
          // 新 JSONL 会出现“消息属于旧 session，content-replacement 属于新 session”的错配，
          // loadFullLog 按 sessionId 查 replacement 时会漏掉记录，进而把内容误判为 FROZEN。
          userType: getUserType(),
          entrypoint: getEntrypoint(),
          cwd: getCwd(),
          sessionId,
          version: VERSION,
          gitBranch,
          slug,
        }
        await this.appendEntry(transcriptMessage)
        if (isChainParticipant(message)) {
          parentUuid = message.uuid
        }
      }

      // 缓存本轮用户提示词，供 reAppendSessionMetadata 写入 last-prompt。
      // /resume picker 用它展示用户最近在做什么；每轮覆盖是预期行为。
      if (!isSidechain) {
        const text = getFirstMeaningfulUserMessageTextContent(messages)
        if (text) {
          const flat = text.replace(/\n/g, ' ').trim()
          this.currentSessionLastPrompt =
            flat.length > 200 ? flat.slice(0, 200).trim() + '…' : flat
        }
      }
    })
  }

  async insertFileHistorySnapshot(
    messageId: UUID,
    snapshot: FileHistorySnapshot,
    isSnapshotUpdate: boolean,
  ) {
    return this.trackWrite(async () => {
      const fileHistoryMessage: FileHistorySnapshotMessage = {
        type: 'file-history-snapshot',
        messageId,
        snapshot,
        isSnapshotUpdate,
      }
      await this.appendEntry(fileHistoryMessage)
    })
  }

  async insertQueueOperation(queueOp: QueueOperationMessage) {
    return this.trackWrite(async () => {
      await this.appendEntry(queueOp)
    })
  }

  async insertAttributionSnapshot(snapshot: AttributionSnapshotMessage) {
    return this.trackWrite(async () => {
      await this.appendEntry(snapshot)
    })
  }

  async insertContentReplacement(
    replacements: ContentReplacementRecord[],
    agentId?: AgentId,
  ) {
    return this.trackWrite(async () => {
      const entry: ContentReplacementEntry = {
        type: 'content-replacement',
        sessionId: getSessionId() as UUID,
        agentId,
        replacements,
      }
      await this.appendEntry(entry)
    })
  }

  async appendEntry(entry: Entry, sessionId: UUID = getSessionId() as UUID) {
    // appendEntry 是本模块的统一落盘分发器。
    // 它负责三件事：
    // 1. 当前 session 尚未物化时先缓存 entry。
    // 2. metadata/快照类 entry 直接追加，消息类 entry 按 UUID 去重。
    // 3. 主线程、subagent sidechain、content replacement 按规则写到不同文件。
    if (this.shouldSkipPersistence()) {
      return
    }

    const currentSessionId = getSessionId() as UUID
    const isCurrentSession = sessionId === currentSessionId

    let sessionFile: string
    if (isCurrentSession) {
      // 当前 session 文件尚未 materialize，先缓存到 pendingEntries。
      if (this.sessionFile === null) {
        // 这里不会创建文件。只有后续 user/assistant 消息触发 materializeSessionFile，
        // 才会把这些缓存 entry 和启动 metadata 一起写出。
        this.pendingEntries.push(entry)
        return
      }
      sessionFile = this.sessionFile
    } else {
      const existing = await this.getExistingSessionFile(sessionId)
      if (!existing) {
        logError(
          new Error(
            `appendEntry: session file not found for other session ${sessionId}`,
          ),
        )
        return
      }
      sessionFile = existing
    }

    // 只有 transcript 消息需要查重；纯 metadata entry 可以直接追加。
    if (entry.type === 'summary') {
      // 以下 metadata 分支多数采用“追加即历史”的策略：
      // 读取时要么 last-wins，要么按 leaf/messageId/sessionId 建索引。
      // 因此不能像 transcript message 一样简单按 UUID 去重。
      // summary 是 leaf 的附加信息，允许重复追加，读取时按 leaf 使用。
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'custom-title') {
      // 用户标题允许重复追加，读取时后写覆盖先写。
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'ai-title') {
      // AI 生成标题允许重复追加，用户标题优先级更高。
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'last-prompt') {
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'task-summary') {
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'tag') {
      // tag 允许重复追加，读取时后写覆盖先写。
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'agent-name') {
      // agent 名称是 session metadata，直接追加即可。
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'agent-color') {
      // agent 颜色是 session metadata，直接追加即可。
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'agent-setting') {
      // agent 设置用于 resume 恢复 agent 类型，直接追加即可。
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'pr-link') {
      // PR 关联信息按 session 保存，直接追加即可。
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'file-history-snapshot') {
      // 文件历史快照按 messageId 恢复，不需要按 transcript UUID 查重。
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'attribution-snapshot') {
      // 归因快照是累积状态记录，不参与 transcript 去重。
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'speculation-accept') {
      // speculation accept 是独立统计事件，直接追加即可。
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'mode') {
      // mode entry 后写生效，直接追加即可。
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'worktree-state') {
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'content-replacement') {
      // content replacement 记录必须保留完整历史。subagent 记录写入对应 sidechain 文件，
      // 供 AgentTool resume 使用；主线程记录写入 session 文件，供 /resume 使用。
      const targetFile = entry.agentId
        ? getAgentTranscriptPath(entry.agentId)
        : sessionFile
      void this.enqueueWrite(targetFile, entry)
    } else if (entry.type === 'marble-origami-commit') {
      // 始终追加。恢复 context-collapse 时 commit 顺序有意义；
      // 后续 commit 可能引用前序 summary，因此必须按写入顺序回放。
      void this.enqueueWrite(sessionFile, entry)
    } else if (entry.type === 'marble-origami-snapshot') {
      // 始终追加。恢复时采用 last-wins，后写 snapshot 覆盖先写。
      void this.enqueueWrite(sessionFile, entry)
    } else {
      const messageSet = await getSessionMessages(sessionId)
      if (entry.type === 'queue-operation') {
        // queue-operation 是命令队列事件，不参与消息 UUID 去重，直接追加。
        void this.enqueueWrite(sessionFile, entry)
      } else {
        // 走到这里时，entry 必然是 TranscriptMessage（user/assistant/attachment/system）；
        // 其他 entry 类型已经在上面处理完。
        const isAgentSidechain =
          entry.isSidechain && entry.agentId !== undefined
        const targetFile = isAgentSidechain
          ? getAgentTranscriptPath(asAgentId(entry.agentId!))
          : sessionFile

        // transcript 消息要按 UUID 去重，但本地 agent sidechain 写入例外。
        // sidechain 写到独立文件；fork 继承的父消息会和主 session 共享 UUID。
        // 如果拿主 session 的 messageSet 去重，会把这些继承消息丢掉，
        // 导致持久化的 sidechain transcript 不完整（resume-of-fork 只加载 10KB，
        // 而不是完整 85KB 继承上下文）。
        //
        // 这个 sidechain 绕过去重只适用于本地文件写入。远端 session-ingress
        // 对每个 sessionId 只有一条 Last-Uuid 链；重复 POST 已存在 UUID 会 409，
        // 最终耗尽重试并触发 gracefulShutdownSync(1)。见 inc-4718。
        const isNewUuid = !messageSet.has(entry.uuid)
        if (isAgentSidechain || isNewUuid) {
          // 主 session 消息写入后会更新 messageSet，后续重复 UUID 直接跳过。
          // sidechain 不更新主 messageSet，因为它可能继承主链 UUID，不能污染主链去重状态。
          // 入队写文件；appendToFile 会在 ENOENT 时创建目录后重试。
          void this.enqueueWrite(targetFile, entry)

          if (!isAgentSidechain) {
            // messageSet 只代表主 session 文件。sidechain entry 写到独立 agent 文件；
            // 如果把它们的 UUID 加进这里，recordTranscript 后续会误以为主线程已经写过，
            // 导致消息永远不会进入主 session 文件。下一条主线程消息的 parentUuid
            // 就会指向只存在于 agent 文件里的 UUID，--resume 的 buildConversationChain
            // 会在悬空引用处截断。远端也有同样约束：sidechain 先持久化主线程尚未写的 UUID，
            // 主线程稍后写同一 UUID 时会遇到 409（见 inc-4718）。
            messageSet.add(entry.uuid)

            if (isTranscriptMessage(entry)) {
              await this.persistToRemote(sessionId, entry)
            }
          }
        }
      }
    }
  }

  /**
   * 懒初始化当前 session 文件路径。
   * 这里只记录目标路径，不创建文件；真正有消息写入时才落盘，
   * 避免生成只有启动 metadata 的空 transcript。
   */
  private ensureCurrentSessionFile(): string {
    // 只在需要写当前 session 时计算一次路径，之后同一 Project 复用该文件指针。
    // switch/reset 会把它清掉，防止继续写入旧 session。
    if (this.sessionFile === null) {
      this.sessionFile = getTranscriptPath()
    }

    return this.sessionFile
  }

  /**
   * 查询指定 session 的 transcript 文件是否已存在。
   * 用于向非当前 session 写入时避免无意创建新文件；命中后缓存路径，
   * 同一个 session 只需要 stat 一次。
   */
  private existingSessionFiles = new Map<string, string>()
  private async getExistingSessionFile(
    sessionId: UUID,
  ): Promise<string | null> {
    // 给“非当前 session 写 metadata”使用，例如 SDK 对历史 session rename/tag。
    // 只允许写已有文件：找不到就返回 null，避免误创建一个没有消息的孤儿 session。
    const cached = this.existingSessionFiles.get(sessionId)
    if (cached) return cached

    const targetFile = getTranscriptPathForSession(sessionId)
    try {
      await stat(targetFile)
      this.existingSessionFiles.set(sessionId, targetFile)
      return targetFile
    } catch (e) {
      if (isFsInaccessible(e)) return null
      throw e
    }
  }

  private async persistToRemote(sessionId: UUID, entry: TranscriptMessage) {
    // 本地 JSONL 写入成功后，按配置把 transcript 同步到远端。
    // CCR v2 优先：写内部 worker event；否则走旧 v1 Session Ingress。
    if (isShuttingDown()) {
      return
    }

    // CCR v2 路径：把 transcript 写成内部 worker event。
    if (this.internalEventWriter) {
      try {
        await this.internalEventWriter(
          'transcript',
          entry as unknown as Record<string, unknown>,
          {
            ...(isCompactBoundaryMessage(entry) && { isCompaction: true }),
            ...(entry.agentId && { agentId: entry.agentId }),
          },
        )
      } catch {
        logEvent('tengu_session_persistence_failed', {})
        logForDebugging('Failed to write transcript as internal event')
      }
      return
    }

    // v1 路径：通过 Session Ingress 远端追加 transcript。
    if (
      !isEnvTruthy(process.env.ENABLE_SESSION_PERSISTENCE) ||
      !this.remoteIngressUrl
    ) {
      return
    }

    const success = await sessionIngress.appendSessionLog(
      sessionId,
      entry,
      this.remoteIngressUrl,
    )

    if (!success) {
      logEvent('tengu_session_persistence_failed', {})
      gracefulShutdownSync(1, 'other')
    }
  }

  setRemoteIngressUrl(url: string): void {
    // hydrateRemoteSession 完成后调用。设置 URL 后，后续本地 transcript 会继续追加到远端；
    // 同时缩短 flush 间隔，降低远端 resume 看到旧状态的窗口。
    this.remoteIngressUrl = url
    logForDebugging(`Remote persistence enabled with URL: ${url}`)
    if (url) {
      // 使用 CCR 时需要更低延迟，避免消息在本地队列里滞留太久。
      this.FLUSH_INTERVAL_MS = REMOTE_FLUSH_INTERVAL_MS
    }
  }

  setInternalEventWriter(writer: InternalEventWriter): void {
    // CCR v2 写入器接管远端持久化后，appendEntry 不再走 HTTP ingress，
    // 而是把 transcript 包成内部事件交给 worker。
    this.internalEventWriter = writer
    logForDebugging(
      'CCR v2 internal event writer registered for transcript persistence',
    )
    // CCR v2 使用更短刷写间隔，提高远端可见性。
    this.FLUSH_INTERVAL_MS = REMOTE_FLUSH_INTERVAL_MS
  }

  setInternalEventReader(reader: InternalEventReader): void {
    // hydrateFromCCRv2InternalEvents 通过这个 reader 拉取主线程事件。
    this.internalEventReader = reader
    logForDebugging(
      'CCR v2 internal event reader registered for session resume',
    )
  }

  setInternalSubagentEventReader(reader: InternalEventReader): void {
    // subagent reader 单独注册，恢复时按 agent_id 分组写回各自 sidechain 文件。
    this.internalSubagentEventReader = reader
    logForDebugging(
      'CCR v2 subagent event reader registered for session resume',
    )
  }

  getInternalEventReader(): InternalEventReader | null {
    return this.internalEventReader
  }

  getInternalSubagentEventReader(): InternalEventReader | null {
    return this.internalSubagentEventReader
  }
}

export type TeamInfo = {
  teamName?: string
  agentName?: string
}

// 调用 insertMessageChain 前先过滤已经写过的消息。
// 如果不先过滤，compaction 后的 messagesToKeep 仍带着 pre-compact 的 UUID：
// appendEntry 会因为去重跳过它们，但 insertMessageChain 的 parentUuid 游标已经前移，
// 导致新消息挂到 compact 前的 UUID，而不是 compact summary 后面，最终让 compact boundary
// 在恢复时变成孤儿。
//
// startingParentUuidHint 由 useLogMessages 传入，用来延续上一段增量 slice 的父节点，
// 避免每次都 O(n) 扫描寻找父节点。
//
// 对“已写消息”的父节点跟踪只在它们构成前缀时生效，也就是出现在任何新消息之前：
// - Growing-array 调用方（QueryEngine、queryHelpers、LocalMainSessionTask、trajectory）：
//   已写消息总是前缀，因此可以作为新消息的正确父节点。
// - Compaction（useLogMessages）：新的 compact boundary/summary 先出现，随后才是
//   已写过的 messagesToKeep；这些不是前缀，不能跟踪，否则 boundary 不会成为新的链根。
export async function recordTranscript(
  messages: Message[],
  teamInfo?: TeamInfo,
  startingParentUuidHint?: UUID,
  allMessages?: readonly Message[],
): Promise<UUID | null> {
  // 公开的主线程 transcript 写入口。
  // 先做日志可见性清理（progress/外部 attachment/REPL 包装），再和已写 UUID 集合比对，
  // 只把真正新增的消息交给 Project 写入。
  const cleanedMessages = cleanMessagesForLogging(messages, allMessages)
  const sessionId = getSessionId() as UUID
  const messageSet = await getSessionMessages(sessionId)
  const newMessages: typeof cleanedMessages = []
  let startingParentUuid: UUID | undefined = startingParentUuidHint
  let seenNewMessage = false
  for (const m of cleanedMessages) {
    // 这里不是简单过滤重复：如果重复消息位于本次 slice 前缀，
    // 它仍然可以作为后续新增消息的 parentUuid。
    if (messageSet.has(m.uuid as UUID)) {
      // 只跟踪位于前缀位置的已写消息。compaction 后 messagesToKeep 位于新的
      // boundary/summary 之后，这里会刻意跳过它们。
      if (!seenNewMessage && isChainParticipant(m)) {
        startingParentUuid = m.uuid as UUID
      }
    } else {
      newMessages.push(m)
      seenNewMessage = true
    }
  }
  if (newMessages.length > 0) {
    await getProject().insertMessageChain(
      newMessages,
      false,
      undefined,
      startingParentUuid,
      teamInfo,
    )
  }
  // 返回本次真正写入的最后一个链参与消息 UUID；如果本次没有新链参与消息，
  // 则返回前缀跟踪到的 UUID。这样 useLogMessages 即使遇到整段 slice 都已写过
  //（rewind、/resume 等场景），也能继续维护正确 parent 链。
  // progress 虽然可能写入 JSONL，但不会有消息链到它（见 isChainParticipant）。
  const lastRecorded = newMessages.findLast(isChainParticipant)
  return (lastRecorded?.uuid as UUID | undefined) ?? startingParentUuid ?? null
}

export async function recordSidechainTranscript(
  messages: Message[],
  agentId?: string,
  startingParentUuid?: UUID | null,
) {
  // subagent transcript 写入独立 sidechain 文件，但仍复用 insertMessageChain 的链路构造。
  // agentId 存在时 appendEntry 会把 entry 分流到 agent-<id>.jsonl。
  await getProject().insertMessageChain(
    cleanMessagesForLogging(messages),
    true,
    agentId,
    startingParentUuid,
  )
}

export async function recordQueueOperation(queueOp: QueueOperationMessage) {
  // queue-operation 是命令队列状态事件，不参与对话链恢复，但需要持久化供队列恢复/分析使用。
  await getProject().insertQueueOperation(queueOp)
}

/**
 * 收到 tombstone 时，按 UUID 从 transcript 中移除对应孤儿消息。
 */
export async function removeTranscriptMessage(targetUuid: UUID): Promise<void> {
  await getProject().removeMessageByUuid(targetUuid)
}

export async function recordFileHistorySnapshot(
  messageId: UUID,
  snapshot: FileHistorySnapshot,
  isSnapshotUpdate: boolean,
) {
  // 文件历史快照按 messageId 关联到对话链；更新型快照会在读取时覆盖同 messageId 的旧值。
  await getProject().insertFileHistorySnapshot(
    messageId,
    snapshot,
    isSnapshotUpdate,
  )
}

export async function recordAttributionSnapshot(
  snapshot: AttributionSnapshotMessage,
) {
  // 归因快照记录当前文件贡献状态，恢复时按写入顺序合并成最新 attribution 状态。
  await getProject().insertAttributionSnapshot(snapshot)
}

export async function recordContentReplacement(
  replacements: ContentReplacementRecord[],
  agentId?: AgentId,
) {
  // content replacement 记录“模型实际看到的替代内容”，resume 时用它重建 prompt cache 稳定状态。
  // agentId 存在时记录写入 subagent sidechain，主线程不消费这些 replacement。
  await getProject().insertContentReplacement(replacements, agentId)
}

/**
 * switchSession/regenerateSessionId 后重置当前 Project 的 session 文件指针。
 * 新文件会在第一条 user/assistant 消息到来时懒创建。
 */
export async function resetSessionFilePointer() {
  // 只重置当前进程内的文件指针，不删除磁盘文件。
  // 下一次 recordTranscript 会按新的 sessionId/cwd 重新计算 transcript 路径。
  getProject().resetSessionFile()
}

/**
 * --continue/--resume（非 fork）后接管已有 session 文件。
 * 调用顺序应在 switchSession + resetSessionFilePointer + restoreSessionMetadata 之后：
 * 此时 getTranscriptPath() 已能基于切换后的 sessionId 算出恢复目标文件，
 * metadata 缓存也已经包含最终值（--name 标题、恢复出的 mode/tag/agent）。
 *
 * 这里直接设置 sessionFile，而不是等第一条用户消息触发 materializeSessionFile，
 * 是为了让退出清理里的 reAppendSessionMetadata 能执行；sessionFile 为 null 时它会直接返回。
 * 否则 `-c -n foo` 后立刻退出会丢失标题：内存缓存正确，但没有任何写回。
 * 恢复的文件已经在磁盘上存在，所以这里不会像全新 --name session 那样制造孤儿文件。
 *
 * skipTitleRefresh 的原因：restoreSessionMetadata 刚从同一次磁盘读取填充缓存，
 * 立刻再读尾部没有意义；如果用户传了 --name，反而会用旧磁盘值覆盖新的 CLI 标题。
 * 这次写完后磁盘和缓存一致，后续 compaction/退出清理仍会正常吸收 SDK 写入。
 */
export function adoptResumedSessionFile(): void {
  const project = getProject()
  project.sessionFile = getTranscriptPath()
  project.reAppendSessionMetadata(true)
}

/**
 * 向 transcript 追加一条 context-collapse commit。
 * 每次 commit 写一条，顺序必须保留；resume 时会按顺序收集后交给
 * restoreFromEntries() 重建 collapse commit log。
 */
export async function recordContextCollapseCommit(commit: {
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
}): Promise<void> {
  // context-collapse commit 是 append-only 日志：每次 collapse 都写一条。
  // 恢复时按顺序回放，才能处理后一个 collapse 引用前一个 summary 的情况。
  const sessionId = getSessionId() as UUID
  if (!sessionId) return
  await getProject().appendEntry({
    type: 'marble-origami-commit',
    sessionId,
    ...commit,
  })
}

/**
 * 保存 context-collapse 的 staged queue 和 spawn 状态快照。
 * 每次 ctx-agent spawn 完成后写入，因为 staged 内容可能变化。
 * 恢复时采用 last-wins，只使用最新 snapshot。
 */
export async function recordContextCollapseSnapshot(snapshot: {
  staged: Array<{
    startUuid: string
    endUuid: string
    summary: string
    risk: number
    stagedAt: number
  }>
  armed: boolean
  lastSpawnTokens: number
}): Promise<void> {
  // snapshot 保存 staged queue 的最新状态，不需要回放全部历史；
  // loadTranscriptFile 读取时采用 last-wins。
  const sessionId = getSessionId() as UUID
  if (!sessionId) return
  await getProject().appendEntry({
    type: 'marble-origami-snapshot',
    sessionId,
    ...snapshot,
  })
}

export async function flushSessionStorage(): Promise<void> {
  // 给退出流程、测试和需要强一致读回的调用方使用。
  // 它会强制把延迟写队列和直接写操作都推进完成。
  await getProject().flush()
}

export async function hydrateRemoteSession(
  sessionId: string,
  ingressUrl: string,
): Promise<boolean> {
  // 从 v1 Session Ingress 恢复远端 session：
  // 先切换本地 sessionId，再用远端日志覆盖本地 JSONL，最后才启用后续远端追加。
  switchSession(asSessionId(sessionId))

  const project = getProject()

  try {
    const remoteLogs =
      (await sessionIngress.getSessionLogs(sessionId, ingressUrl)) || []

    // 确保本地项目目录和 session 文件路径存在。
    const projectDir = getProjectDir(getOriginalCwd())
    await mkdir(projectDir, { recursive: true, mode: 0o700 })

    const sessionFile = getTranscriptPathForSession(sessionId)

    // 用远端日志覆盖本地文件。writeFile 会截断原文件，因此不需要先 unlink；
    // 如果远端为空数组，则写出空文件。
    const content = remoteLogs.map(e => jsonStringify(e) + '\n').join('')
    await writeFile(sessionFile, content, { encoding: 'utf8', mode: 0o600 })

    logForDebugging(`Hydrated ${remoteLogs.length} entries from remote`)
    return remoteLogs.length > 0
  } catch (error) {
    logForDebugging(`Error hydrating session from remote: ${error}`)
    logForDiagnosticsNoPII('error', 'hydrate_remote_session_fail')
    return false
  } finally {
    // hydration 完成后才启用远端 ingress，确保开启后本地已经和远端对齐，
    // 不会把旧本地状态继续追加到远端。
    project.setRemoteIngressUrl(ingressUrl)
  }
}

/**
 * 从 CCR v2 内部事件恢复 session 状态。
 * 通过已注册的 reader 拉取 foreground 和 subagent 事件，把 payload 中的
 * transcript entry 写回本地文件（主 session 文件和各 agent 文件）。
 * compaction 过滤由服务端处理；这里拿到的是从最新 compaction boundary 起的事件。
 */
export async function hydrateFromCCRv2InternalEvents(
  sessionId: string,
): Promise<boolean> {
  // 从 CCR v2 内部事件恢复：
  // foreground 事件写回主 session 文件，subagent 事件按 agent_id 分组写回 sidechain。
  // 这条路径不经过 Session Ingress，适合 worker 内部实时状态恢复。
  const startMs = Date.now()
  switchSession(asSessionId(sessionId))

  const project = getProject()
  const reader = project.getInternalEventReader()
  if (!reader) {
    logForDebugging('No internal event reader registered for CCR v2 resume')
    return false
  }

  try {
    // 拉取主线程 foreground 事件。
    const events = await reader()
    if (!events) {
      logForDebugging('Failed to read internal events for resume')
      logForDiagnosticsNoPII('error', 'hydrate_ccr_v2_read_fail')
      return false
    }

    const projectDir = getProjectDir(getOriginalCwd())
    await mkdir(projectDir, { recursive: true, mode: 0o700 })

    // 写回主 session transcript。
    const sessionFile = getTranscriptPathForSession(sessionId)
    const fgContent = events.map(e => jsonStringify(e.payload) + '\n').join('')
    await writeFile(sessionFile, fgContent, { encoding: 'utf8', mode: 0o600 })

    logForDebugging(
      `Hydrated ${events.length} foreground entries from CCR v2 internal events`,
    )

    // 拉取并写回 subagent transcript。
    let subagentEventCount = 0
    const subagentReader = project.getInternalSubagentEventReader()
    if (subagentReader) {
      const subagentEvents = await subagentReader()
      if (subagentEvents && subagentEvents.length > 0) {
        subagentEventCount = subagentEvents.length
        // 按 agent_id 分组，每个 agent 写独立 transcript 文件。
        const byAgent = new Map<string, Record<string, unknown>[]>()
        for (const e of subagentEvents) {
          const agentId = e.agent_id || ''
          if (!agentId) continue
          let list = byAgent.get(agentId)
          if (!list) {
            list = []
            byAgent.set(agentId, list)
          }
          list.push(e.payload)
        }

        // 每个 agent 的事件写入自己的 transcript 文件。
        for (const [agentId, entries] of byAgent) {
          const agentFile = getAgentTranscriptPath(asAgentId(agentId))
          await mkdir(dirname(agentFile), { recursive: true, mode: 0o700 })
          const agentContent = entries
            .map(p => jsonStringify(p) + '\n')
            .join('')
          await writeFile(agentFile, agentContent, {
            encoding: 'utf8',
            mode: 0o600,
          })
        }

        logForDebugging(
          `Hydrated ${subagentEvents.length} subagent entries across ${byAgent.size} agents`,
        )
      }
    }

    logForDiagnosticsNoPII('info', 'hydrate_ccr_v2_completed', {
      duration_ms: Date.now() - startMs,
      event_count: events.length,
      subagent_event_count: subagentEventCount,
    })
    return events.length > 0
  } catch (error) {
    // epoch mismatch 需要继续抛出，避免 worker 和 gracefulShutdown 竞态。
    if (
      error instanceof Error &&
      error.message === 'CCRClient: Epoch mismatch (409)'
    ) {
      throw error
    }
    logForDebugging(`Error hydrating session from CCR v2: ${error}`)
    logForDiagnosticsNoPII('error', 'hydrate_ccr_v2_fail')
    return false
  }
}

function extractFirstPrompt(transcript: TranscriptMessage[]): string {
  const textContent = getFirstMeaningfulUserMessageTextContent(transcript)
  if (textContent) {
    let result = textContent.replace(/\n/g, ' ').trim()

    // 这里保留较长文本，真正展示时再按终端宽度截断。
    if (result.length > 200) {
      result = result.slice(0, 200).trim() + '…'
    }

    return result
  }

  return 'No prompt'
}

/**
 * 提取 transcript 中第一条有实际意义的用户文本。
 * 它用于判断 session 是否有真实用户交互，也用于 /resume 列表标题。
 */
export function getFirstMeaningfulUserMessageTextContent<T extends Message>(
  transcript: T[],
): string | undefined {
  for (const msg of transcript) {
    if (msg.type !== 'user' || msg.isMeta) continue
    // compact summary 是系统生成内容，不能当作用户第一条提示词。
    if ('isCompactSummary' in msg && msg.isCompactSummary) continue

    const content = msg.message?.content
    if (!content) continue

    // 收集所有 text block。VS Code 等场景常把 IDE metadata 标签放在用户提示前，
    // 所以 array content 不能只看第一个 text，否则会漏掉真正的用户输入。
    const texts: string[] = []
    if (typeof content === 'string') {
      texts.push(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          texts.push(block.text)
        }
      }
    }

    for (const textContent of texts) {
      if (!textContent) continue

      const commandNameTag = extractTag(textContent, COMMAND_NAME_TAG)
      if (commandNameTag) {
        const commandName = commandNameTag.replace(/^\//, '')

        // 内置命令通常不提供有意义的会话主题，例如 `/model sonnet`。
        if (builtInCommandNames().has(commandName)) {
          continue
        } else {
          // 自定义命令只有带参数时才可能表达任务意图，例如 `/review reticulate splines`。
          const commandArgs = extractTag(textContent, 'command-args')?.trim()
          if (!commandArgs) {
            continue
          }
          // 返回干净的命令文本，不暴露内部 XML 包装。
          return `${commandNameTag} ${commandArgs}`
        }
      }

      // bash 模式按用户输入形式加上 ! 前缀。它要早于通用 XML 过滤，
      // 否则 bash-mode session 会丢失有意义标题。
      const bashInput = extractTag(textContent, 'bash-input')
      if (bashInput) {
        return `! ${bashInput}`
      }

      // 跳过不代表用户意图的内容：本地命令输出、hook 输出、自动 tick 提示、
      // 任务通知、纯 IDE metadata 标签等。
      if (SKIP_FIRST_PROMPT_PATTERN.test(textContent)) {
        continue
      }

      return textContent
    }
  }
  return undefined
}

export function removeExtraFields(
  transcript: TranscriptMessage[],
): SerializedMessage[] {
  return transcript.map(m => {
    const { isSidechain, parentUuid, ...serializedMessage } = m
    return serializedMessage
  })
}

/**
 * compaction 后把 preserved segment 重新接回对话链。
 *
 * preserved 消息在 JSONL 中仍保留 compact 前的原始 parentUuid；
 * recordTranscript 因去重跳过了这些消息，无法重写磁盘上的 parentUuid。
 * segment 内部链路（keep[i+1]→keep[i]）本身完整，只需要修补两端：
 * head 接到 anchor，anchor 的其他子节点接到 tail。suffix-preserving 时
 * anchor 是最后一条 summary，prefix-preserving 时 anchor 是 boundary 本身。
 *
 * 只重连最后一个带 segment 的 boundary；更早的 segment 已被汇总进它。
 * 物理上位于绝对最后 boundary 之前的消息，除 preservedUuids 外都会删除，
 * 这样不用为多 boundary 形态写额外分支。
 *
 * 该函数会原地修改 messages Map。
 */
function applyPreservedSegmentRelinks(
  messages: Map<UUID, TranscriptMessage>,
): void {
  type Seg = NonNullable<
    SystemCompactBoundaryMessage['compactMetadata']['preservedSegment']
  >

  // 同时找到绝对最后 boundary 和最后一个带 segment 的 boundary；二者可能不同，
  // 例如 reactive compact 后用户又手动 /compact，此时旧 segment 已经过期。
  let lastSeg: Seg | undefined
  let lastSegBoundaryIdx = -1
  let absoluteLastBoundaryIdx = -1
  const entryIndex = new Map<UUID, number>()
  let i = 0
  for (const entry of messages.values()) {
    entryIndex.set(entry.uuid, i)
    if (isCompactBoundaryMessage(entry)) {
      absoluteLastBoundaryIdx = i
      const seg = entry.compactMetadata?.preservedSegment
      if (seg) {
        lastSeg = seg
        lastSegBoundaryIdx = i
      }
    }
    i++
  }
  // 没有任何 segment 时不处理；findUnresolvedToolUse 等调用方会读取完整 Map。
  if (!lastSeg) return

  // segment 过期时跳过重连，但仍按绝对最后 boundary 做裁剪；
  // 否则旧 preserved 链会变成幽灵 leaf。
  const segIsLive = lastSegBoundaryIdx === absoluteLastBoundaryIdx

  // 修改前先验证 tail→head 能走通。metadata 损坏时应完全 no-op；
  // 这段 walk 会在 headUuid 停止，不依赖后续重连先发生。
  const preservedUuids = new Set<UUID>()
  if (segIsLive) {
    const walkSeen = new Set<UUID>()
    let cur = messages.get(lastSeg.tailUuid)
    let reachedHead = false
    while (cur && !walkSeen.has(cur.uuid)) {
      walkSeen.add(cur.uuid)
      preservedUuids.add(cur.uuid)
      if (cur.uuid === lastSeg.headUuid) {
        reachedHead = true
        break
      }
      cur = cur.parentUuid ? messages.get(cur.parentUuid) : undefined
    }
    if (!reachedHead) {
      // tail→head walk 断开，说明 preserved segment 中某个 UUID 不在 transcript。
      // 这里直接返回并跳过后续裁剪，让 resume 退回加载 compact 前完整历史。
      // 已知原因：turn 中途产生的 attachment 进入 mutableMessages，但还没等到
      // recordTranscript 写盘，SDK 子进程就在下一轮 qe:420 flush 前重启。
      logEvent('tengu_relink_walk_broken', {
        tailInTranscript: messages.has(lastSeg.tailUuid),
        headInTranscript: messages.has(lastSeg.headUuid),
        anchorInTranscript: messages.has(lastSeg.anchorUuid),
        walkSteps: walkSeen.size,
        transcriptSize: messages.size,
      })
      return
    }
  }

  if (segIsLive) {
    const head = messages.get(lastSeg.headUuid)
    if (head) {
      messages.set(lastSeg.headUuid, {
        ...head,
        parentUuid: lastSeg.anchorUuid,
      })
    }
    // 尾部拼接：把 anchor 的其他子节点改挂到 tail。
    // 如果已经指向 tail（useLogMessages 竞态场景），则保持不变。
    for (const [uuid, msg] of messages) {
      if (msg.parentUuid === lastSeg.anchorUuid && uuid !== lastSeg.headUuid) {
        messages.set(uuid, { ...msg, parentUuid: lastSeg.tailUuid })
      }
    }
    // 清零过期 usage：磁盘上的 input_tokens 仍反映 compact 前上下文（可能约 190K）。
    // stripStaleUsage 只修补了内存副本，而这些 preserved 消息因去重没有重写到磁盘。
    // 不清零会导致 resume 后立即进入 auto-compact 循环。
    for (const uuid of preservedUuids) {
      const msg = messages.get(uuid)
      if (msg?.type !== 'assistant') continue
      messages.set(uuid, {
        ...msg,
        message: {
          ...msg.message,
          usage: {
            ...msg.message.usage,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      })
    }
  }

  // 裁掉物理上位于绝对最后 boundary 之前、且不属于 preserved 的所有消息。
  // seg 失效时 preservedUuids 为空，因此会完整裁掉 boundary 前内容。
  const toDelete: UUID[] = []
  for (const [uuid] of messages) {
    const idx = entryIndex.get(uuid)
    if (
      idx !== undefined &&
      idx < absoluteLastBoundaryIdx &&
      !preservedUuids.has(uuid)
    ) {
      toDelete.push(uuid)
    }
  }
  for (const uuid of toDelete) messages.delete(uuid)
}

/**
 * 回放 Snip 执行时从内存消息数组删除的消息，并把 parentUuid 跨过缺口重连。
 *
 * compact_boundary 删除的是前缀，而 snip 删除的是中间范围。JSONL 是追加文件，
 * 被 snip 移除的消息仍在磁盘上，幸存消息的 parentUuid 也仍会穿过这些消息。
 * 如果不在读取时过滤，buildConversationChain 会重建未 snip 的完整历史，
 * resume 后可能立即超出 token 上限（例：界面显示 397K，实际恢复 1.65M）。
 *
 * 仅删除还不够：删除范围之后的幸存消息 parentUuid 会指向缺口内部。
 * buildConversationChain 遇到缺失父节点会停止，导致缺口之前的历史被孤立。
 * 因此删除后还要重连：对每个 parentUuid 悬空的幸存消息，沿被删除区域自身的
 * parent 链追溯到第一个未删除祖先。
 *
 * boundary 在执行时记录 removedUuids，加载时据此精确回放删除。
 * 老 boundary 没有 removedUuids，只能跳过，恢复结果保持修复前行为。
 *
 * 该函数会原地修改 messages Map。
 */
function applySnipRemovals(messages: Map<UUID, TranscriptMessage>): void {
  // 用结构判断识别 snip metadata。这里刻意不写 subtype 字面量，
  // 因为 HISTORY_SNIP 是 ant-only，相关字符串不能泄漏到 external build。
  type WithSnipMeta = { snipMetadata?: { removedUuids?: UUID[] } }
  const toDelete = new Set<UUID>()
  for (const entry of messages.values()) {
    const removedUuids = (entry as WithSnipMeta).snipMetadata?.removedUuids
    if (!removedUuids) continue
    for (const uuid of removedUuids) toDelete.add(uuid)
  }
  if (toDelete.size === 0) return

  // 删除前先记录每个待删 entry 自己的 parentUuid，后续才能穿过连续删除区间。
  // 如果某 entry 已不在 Map 中（例如之前被 compact_boundary 裁掉），它不贡献链接；
  // 重连追溯会在缺口处停下并得到 null，相当于在那里形成新的链根。
  const deletedParent = new Map<UUID, UUID | null>()
  let removedCount = 0
  for (const uuid of toDelete) {
    const entry = messages.get(uuid)
    if (!entry) continue
    deletedParent.set(uuid, entry.parentUuid)
    messages.delete(uuid)
    removedCount++
  }

  // 重连 parentUuid 指向已删除节点的幸存消息。沿 deletedParent 向后追溯，
  // 直到遇到未删除 UUID 或 null。这里顺便做路径压缩：解析后把结果写回 map，
  // 后续共享同一删除链段的消息无需重复追溯。
  const resolve = (start: UUID): UUID | null => {
    const path: UUID[] = []
    let cur: UUID | null | undefined = start
    while (cur && toDelete.has(cur)) {
      path.push(cur)
      cur = deletedParent.get(cur)
      if (cur === undefined) {
        cur = null
        break
      }
    }
    for (const p of path) deletedParent.set(p, cur)
    return cur
  }
  let relinkedCount = 0
  for (const [uuid, msg] of messages) {
    if (!msg.parentUuid || !toDelete.has(msg.parentUuid)) continue
    messages.set(uuid, { ...msg, parentUuid: resolve(msg.parentUuid) })
    relinkedCount++
  }

  logEvent('tengu_snip_resume_filtered', {
    removed_count: removedCount,
    relinked_count: relinkedCount,
  })
}

/**
 * O(n) 单次扫描：找到满足条件且 timestamp 最新的消息。
 * 用它替代 filter + sort 的 O(n log n) 写法，也避免大量 Date 对象分配。
 */
function findLatestMessage<T extends { timestamp: string }>(
  messages: Iterable<T>,
  predicate: (m: T) => boolean,
): T | undefined {
  let latest: T | undefined
  let maxTime = -Infinity
  for (const m of messages) {
    if (!predicate(m)) continue
    const t = Date.parse(m.timestamp)
    if (t > maxTime) {
      maxTime = t
      latest = m
    }
  }
  return latest
}

/**
 * 从 leaf 消息沿 parentUuid 回溯到根节点，构造一条可恢复的对话链。
 * @param messages 当前 transcript 中所有消息的索引
 * @param leafMessage 作为恢复起点的 leaf 消息
 * @returns 按 root 到 leaf 排列的消息数组
 */
export function buildConversationChain(
  messages: Map<UUID, TranscriptMessage>,
  leafMessage: TranscriptMessage,
): TranscriptMessage[] {
  const transcript: TranscriptMessage[] = []
  const seen = new Set<UUID>()
  let currentMsg: TranscriptMessage | undefined = leafMessage
  while (currentMsg) {
    if (seen.has(currentMsg.uuid)) {
      logError(
        new Error(
          `Cycle detected in parentUuid chain at message ${currentMsg.uuid}. Returning partial transcript.`,
        ),
      )
      logEvent('tengu_chain_parent_cycle', {})
      break
    }
    seen.add(currentMsg.uuid)
    transcript.push(currentMsg)
    currentMsg = currentMsg.parentUuid
      ? messages.get(currentMsg.parentUuid)
      : undefined
  }
  transcript.reverse()
  return recoverOrphanedParallelToolResults(messages, transcript, seen)
}

/**
 * buildConversationChain 的后处理：找回单父链遍历遗漏的 sibling assistant block
 * 和对应 tool_result。
 *
 * 流式输出中，每个 content_block_stop 会生成一条 AssistantMessage。
 * N 个并行 tool_use 会形成 N 条消息：uuid 不同，但 message.id 相同。
 * 每个 tool_result 的 sourceToolAssistantUUID 指向自己的 assistant block，
 * insertMessageChain 会把这些 TR 的 parentUuid 写到不同 assistant 上。
 * 这在磁盘上是 DAG；上面的 parentUuid 回溯是链表遍历，只会保留其中一条分支。
 *
 * 生产中见过两类丢失：
 * 1. sibling assistant 被孤立：遍历走 prev → asstA → TR_A → next，
 *    同 message.id 的 asstB 及 TR_B 被丢弃。
 * 2. 旧 progress fork（#23537 前）：每个 tool_use assistant 同时有 progress 子节点
 *    和 tool_result 子节点。遍历跟随 progress，TR 被丢弃。新 transcript 已不再这样写，
 *    但旧文件仍需兼容。
 *
 * 这是读取侧修复：旧 transcript 的拓扑已经落盘，只能在恢复链时补回。
 */
function recoverOrphanedParallelToolResults(
  messages: Map<UUID, TranscriptMessage>,
  chain: TranscriptMessage[],
  seen: Set<UUID>,
): TranscriptMessage[] {
  type ChainAssistant = Extract<TranscriptMessage, { type: 'assistant' }>
  const chainAssistants = chain.filter(
    (m): m is ChainAssistant => m.type === 'assistant',
  )
  if (chainAssistants.length === 0) return chain

  // anchor 是每个 sibling group 中最后一个已经在链上的 assistant。
  // chainAssistants 已按链顺序排列，后写覆盖即可得到最后一个。
  const anchorByMsgId = new Map<string, ChainAssistant>()
  for (const a of chainAssistants) {
    if (a.message.id) anchorByMsgId.set(a.message.id, a)
  }

  // O(n) 预计算 sibling 分组和 tool_result 索引。
  // TR 按 parentUuid 索引；insertMessageChain 已把它写成源 assistant UUID。
  // --fork-session 会去掉 srcUUID，但会保留 parentUuid，因此这里仍能恢复。
  const siblingsByMsgId = new Map<string, TranscriptMessage[]>()
  const toolResultsByAsst = new Map<UUID, TranscriptMessage[]>()
  for (const m of messages.values()) {
    if (m.type === 'assistant' && m.message.id) {
      const group = siblingsByMsgId.get(m.message.id)
      if (group) group.push(m)
      else siblingsByMsgId.set(m.message.id, [m])
    } else if (
      m.type === 'user' &&
      m.parentUuid &&
      Array.isArray(m.message.content) &&
      m.message.content.some(b => b.type === 'tool_result')
    ) {
      const group = toolResultsByAsst.get(m.parentUuid)
      if (group) group.push(m)
      else toolResultsByAsst.set(m.parentUuid, [m])
    }
  }

  // 对每个触达主链的 message.id 分组：先收集链外 sibling，再收集所有成员的链外 TR。
  // 它们会插入到该组最后一个链上成员之后，保证 normalizeMessagesForAPI 合并时分组连续，
  // 且每个 TR 都位于对应 tool_use 之后。
  const processedGroups = new Set<string>()
  const inserts = new Map<UUID, TranscriptMessage[]>()
  let recoveredCount = 0
  for (const asst of chainAssistants) {
    const msgId = asst.message.id
    if (!msgId || processedGroups.has(msgId)) continue
    processedGroups.add(msgId)

    const group = siblingsByMsgId.get(msgId) ?? [asst]
    const orphanedSiblings = group.filter(s => !seen.has(s.uuid))
    const orphanedTRs: TranscriptMessage[] = []
    for (const member of group) {
      const trs = toolResultsByAsst.get(member.uuid)
      if (!trs) continue
      for (const tr of trs) {
        if (!seen.has(tr.uuid)) orphanedTRs.push(tr)
      }
    }
    if (orphanedSiblings.length === 0 && orphanedTRs.length === 0) continue

    // 按 timestamp 排序可保留 content block/完成顺序；时间相同则稳定排序保留 JSONL 写入顺序。
    orphanedSiblings.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    orphanedTRs.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    const anchor = anchorByMsgId.get(msgId)!
    const recovered = [...orphanedSiblings, ...orphanedTRs]
    for (const r of recovered) seen.add(r.uuid)
    recoveredCount += recovered.length
    inserts.set(anchor.uuid, recovered)
  }

  if (recoveredCount === 0) return chain
  logEvent('tengu_chain_parallel_tr_recovered', {
    recovered_count: recoveredCount,
  })

  const result: TranscriptMessage[] = []
  for (const m of chain) {
    result.push(m)
    const toInsert = inserts.get(m.uuid)
    if (toInsert) result.push(...toInsert)
  }
  return result
}

/**
 * 在重建后的链中找到最新 turn_duration checkpoint，并把它记录的 messageCount
 * 与该 checkpoint 在链中的实际位置比较。该指标用于监控写入→读取的往返偏移：
 * 典型问题是 snip/compact/parallel-TR 在内存中改变了消息集，但磁盘上的 parentUuid
 * 回溯恢复出另一套消息（例如界面显示 397K，resume 实际恢复 1.65M）。
 *
 * delta > 0：resume 比会话内加载了更多消息，通常是历史没被正确裁掉。
 * delta < 0：resume 加载更少，通常是链被意外截断（#22453 类问题）。
 * delta = 0：写入和恢复一致。
 *
 * 只在 loadConversationForResume 中调用，每次 resume 触发一次；
 * /share 或日志列表重建链时不记录。
 */
export function checkResumeConsistency(chain: Message[]): void {
  for (let i = chain.length - 1; i >= 0; i--) {
    const m = chain[i]!
    if (m.type !== 'system' || m.subtype !== 'turn_duration') continue
    const expected = m.messageCount
    if (expected === undefined) return
    // i 是 checkpoint 在重建链中的 0 基下标。checkpoint 是在 messageCount 条消息之后追加的，
    // 因此它自己的位置应等于 messageCount，也就是 i === expected。
    const actual = i
    logEvent('tengu_resume_consistency_delta', {
      expected,
      actual,
      delta: actual - expected,
      chain_length: chain.length,
      checkpoint_age_entries: chain.length - 1 - i,
    })
    return
  }
}

/**
 * 按对话链顺序构造文件历史快照链。
 */
function buildFileHistorySnapshotChain(
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>,
  conversation: TranscriptMessage[],
): FileHistorySnapshot[] {
  const snapshots: FileHistorySnapshot[] = []
  // messageId → snapshots[] 中最近位置，用于 O(1) 覆盖 snapshot update。
  const indexByMessageId = new Map<string, number>()
  for (const message of conversation) {
    const snapshotMessage = fileHistorySnapshots.get(message.uuid)
    if (!snapshotMessage) {
      continue
    }
    const { snapshot, isSnapshotUpdate } = snapshotMessage
    const existingIndex = isSnapshotUpdate
      ? indexByMessageId.get(snapshot.messageId)
      : undefined
    if (existingIndex === undefined) {
      indexByMessageId.set(snapshot.messageId, snapshots.length)
      snapshots.push(snapshot)
    } else {
      snapshots[existingIndex] = snapshot
    }
  }
  return snapshots
}

/**
 * 构造归因快照链。
 * 和文件历史快照不同，归因快照使用生成 UUID 而不是消息 UUID，
 * 表示可累积恢复的状态，因此恢复时需要返回完整列表。
 */
function buildAttributionSnapshotChain(
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>,
  _conversation: TranscriptMessage[],
): AttributionSnapshotMessage[] {
  // 返回所有归因快照，恢复阶段会合并成最终状态。
  return Array.from(attributionSnapshots.values())
}

/**
 * 从 JSON 或 JSONL transcript 文件加载消息，并转换成 LogOption。
 * @param filePath transcript 文件路径，支持 .json 和 .jsonl。
 * @returns 包含 transcript 消息及恢复 metadata 的 LogOption。
 * @throws 文件不存在或内容格式无效时抛错。
 */
export async function loadTranscriptFromFile(
  filePath: string,
): Promise<LogOption> {
  if (filePath.endsWith('.jsonl')) {
    const {
      messages,
      summaries,
      customTitles,
      tags,
      fileHistorySnapshots,
      attributionSnapshots,
      contextCollapseCommits,
      contextCollapseSnapshot,
      leafUuids,
      contentReplacements,
      worktreeStates,
    } = await loadTranscriptFile(filePath)

    if (messages.size === 0) {
      throw new Error('No messages found in JSONL file')
    }

    // 使用预计算的 leaf UUID 找到最新 leaf 消息。
    const leafMessage = findLatestMessage(messages.values(), msg =>
      leafUuids.has(msg.uuid),
    )

    if (!leafMessage) {
      throw new Error('No valid conversation chain found in JSONL file')
    }

    // 从 leaf 沿 parentUuid 回溯到根，构造完整对话链。
    const transcript = buildConversationChain(messages, leafMessage)

    const summary = summaries.get(leafMessage.uuid)
    const customTitle = customTitles.get(leafMessage.sessionId as UUID)
    const tag = tags.get(leafMessage.sessionId as UUID)
    const sessionId = leafMessage.sessionId as UUID
    return {
      ...convertToLogOption(
        transcript,
        0,
        summary,
        customTitle,
        buildFileHistorySnapshotChain(fileHistorySnapshots, transcript),
        tag,
        filePath,
        buildAttributionSnapshotChain(attributionSnapshots, transcript),
        undefined,
        contentReplacements.get(sessionId) ?? [],
      ),
      contextCollapseCommits: contextCollapseCommits.filter(
        e => e.sessionId === sessionId,
      ),
      contextCollapseSnapshot:
        contextCollapseSnapshot?.sessionId === sessionId
          ? contextCollapseSnapshot
          : undefined,
      worktreeSession: worktreeStates.has(sessionId)
        ? worktreeStates.get(sessionId)
        : undefined,
    }
  }

  // 兼容旧版 JSON transcript 文件。
  const content = await readFile(filePath, { encoding: 'utf-8' })
  let parsed: unknown

  try {
    parsed = jsonParse(content)
  } catch (error) {
    throw new Error(`Invalid JSON in transcript file: ${error}`)
  }

  let messages: TranscriptMessage[]

  if (Array.isArray(parsed)) {
    messages = parsed
  } else if (parsed && typeof parsed === 'object' && 'messages' in parsed) {
    if (!Array.isArray(parsed.messages)) {
      throw new Error('Transcript messages must be an array')
    }
    messages = parsed.messages
  } else {
    throw new Error(
      'Transcript must be an array of messages or an object with a messages array',
    )
  }

  return convertToLogOption(
    messages,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    filePath,
  )
}

/**
 * 判断 user 消息是否有可见内容。
 * 纯 tool_result 会在折叠组里展示，不算独立消息；meta 消息也不会展示给用户。
 */
function hasVisibleUserContent(message: TranscriptMessage): boolean {
  if (message.type !== 'user') return false

  // meta 消息不展示给用户。
  if (message.isMeta) return false

  const content = message.message?.content
  if (!content) return false

  // 字符串内容只要非空就可见。
  if (typeof content === 'string') {
    return content.trim().length > 0
  }

  // 数组内容只把 text/image/document 视为可见内容，不把 tool_result 算作独立消息。
  if (Array.isArray(content)) {
    return content.some(
      block =>
        block.type === 'text' ||
        block.type === 'image' ||
        block.type === 'document',
    )
  }

  return false
}

/**
 * 判断 assistant 消息是否有可见文本。
 * 纯 tool_use 会在工具调用组里展示，不算独立 assistant 文本消息。
 */
function hasVisibleAssistantContent(message: TranscriptMessage): boolean {
  if (message.type !== 'assistant') return false

  const content = message.message?.content
  if (!content || !Array.isArray(content)) return false

  // 只有非空 text block 才算可见文本；tool_use/thinking 不计入。
  return content.some(
    block =>
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.trim().length > 0,
  )
}

/**
 * 统计 UI 中会作为“对话轮次”展示的消息数量。
 * 排除 system、attachment、progress、隐藏 user 消息、纯 tool_result user 消息、
 * 以及纯 tool_use assistant 消息。
 */
function countVisibleMessages(transcript: TranscriptMessage[]): number {
  let count = 0
  for (const message of transcript) {
    switch (message.type) {
      case 'user':
        // 只统计有可见内容的 user 消息。
        if (hasVisibleUserContent(message)) {
          count++
        }
        break
      case 'assistant':
        // 只统计有文本内容的 assistant 消息。
        if (hasVisibleAssistantContent(message)) {
          count++
        }
        break
      case 'attachment':
      case 'system':
      case 'progress':
        // 这些类型不是独立对话轮次。
        break
    }
  }
  return count
}

function convertToLogOption(
  transcript: TranscriptMessage[],
  value: number = 0,
  summary?: string,
  customTitle?: string,
  fileHistorySnapshots?: FileHistorySnapshot[],
  tag?: string,
  fullPath?: string,
  attributionSnapshots?: AttributionSnapshotMessage[],
  agentSetting?: string,
  contentReplacements?: ContentReplacementRecord[],
): LogOption {
  const lastMessage = transcript.at(-1)!
  const firstMessage = transcript[0]!

  // 提取用于列表展示的首个用户提示词。
  const firstPrompt = extractFirstPrompt(transcript)

  // 用首尾消息时间计算 session 创建和更新时间。
  const created = new Date(firstMessage.timestamp)
  const modified = new Date(lastMessage.timestamp)

  return {
    date: lastMessage.timestamp,
    messages: removeExtraFields(transcript),
    fullPath,
    value,
    created,
    modified,
    firstPrompt,
    messageCount: countVisibleMessages(transcript),
    isSidechain: firstMessage.isSidechain,
    teamName: firstMessage.teamName,
    agentName: firstMessage.agentName,
    agentSetting,
    leafUuid: lastMessage.uuid,
    summary,
    customTitle,
    tag,
    fileHistorySnapshots: fileHistorySnapshots,
    attributionSnapshots: attributionSnapshots,
    contentReplacements,
    gitBranch: lastMessage.gitBranch,
    projectPath: firstMessage.cwd,
  }
}

async function trackSessionBranchingAnalytics(
  logs: LogOption[],
): Promise<void> {
  const sessionIdCounts = new Map<string, number>()
  let maxCount = 0
  for (const log of logs) {
    const sessionId = getSessionIdFromLog(log)
    if (sessionId) {
      const newCount = (sessionIdCounts.get(sessionId) || 0) + 1
      sessionIdCounts.set(sessionId, newCount)
      maxCount = Math.max(newCount, maxCount)
    }
  }

  // 没有重复 sessionId 时无需记录分支统计。
  if (maxCount <= 1) {
    return
  }

  // 统计存在多个分支的 session，并计算分支数量指标。
  const branchCounts = Array.from(sessionIdCounts.values()).filter(c => c > 1)
  const sessionsWithBranches = branchCounts.length
  const totalBranches = branchCounts.reduce((sum, count) => sum + count, 0)

  logEvent('tengu_session_forked_branches_fetched', {
    total_sessions: sessionIdCounts.size,
    sessions_with_branches: sessionsWithBranches,
    max_branches_per_session: Math.max(...branchCounts),
    avg_branches_per_session: Math.round(totalBranches / sessionsWithBranches),
    total_transcript_count: logs.length,
  })
}

export async function fetchLogs(limit?: number): Promise<LogOption[]> {
  const projectDir = getProjectDir(getOriginalCwd())
  const logs = await getSessionFilesLite(projectDir, limit, getOriginalCwd())

  await trackSessionBranchingAnalytics(logs)

  return logs
}

/**
 * 向 session 文件追加一条 entry；父目录不存在时会自动创建。
 */
/* eslint-disable custom-rules/no-sync-fs -- sync callers (exit cleanup, materialize) */
function appendEntryToFile(
  fullPath: string,
  entry: Record<string, unknown>,
): void {
  const fs = getFsImplementation()
  const line = jsonStringify(entry) + '\n'
  try {
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  } catch {
    fs.mkdirSync(dirname(fullPath), { mode: 0o700 })
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  }
}

/**
 * 同步读取文件尾部，供 reAppendSessionMetadata 检查外部写入。
 * 使用已打开 fd 做 fstat，避免额外路径查找；读取窗口和 readLiteMetadata 一致。
 * 任意错误都返回空字符串，让调用方回退到无条件使用缓存的行为。
 */
function readFileTailSync(fullPath: string): string {
  let fd: number | undefined
  try {
    fd = openSync(fullPath, 'r')
    const st = fstatSync(fd)
    const tailOffset = Math.max(0, st.size - LITE_READ_BUF_SIZE)
    const buf = Buffer.allocUnsafe(
      Math.min(LITE_READ_BUF_SIZE, st.size - tailOffset),
    )
    const bytesRead = readSync(fd, buf, 0, buf.length, tailOffset)
    return buf.toString('utf8', 0, bytesRead)
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
          // closeSync 也可能抛错；这里吞掉以保持“失败返回空字符串”的约定。
      }
    }
  }
}
/* eslint-enable custom-rules/no-sync-fs */

export async function saveCustomTitle(
  sessionId: UUID,
  customTitle: string,
  fullPath?: string,
  source: 'user' | 'auto' = 'user',
) {
  // 未传 fullPath 时按 sessionId 计算默认 transcript 路径。
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: 'custom-title',
    customTitle,
    sessionId,
  })
  // 只缓存当前 session，保证 UI 立即可见。
  if (sessionId === getSessionId()) {
    getProject().currentSessionTitle = customTitle
  }
  logEvent('tengu_session_renamed', {
    source:
      source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

/**
 * 将 AI 生成标题以独立的 `ai-title` entry 写入 JSONL。
 *
 * 必须使用单独 entry 类型，不能复用 `custom-title`：
 * - 读取优先级：reader 优先使用 customTitle，所以用户重命名始终胜过 AI 标题。
 * - resume 安全：loadTranscriptFile 只把 custom-title 放入 customTitles Map，
 *   restoreSessionMetadata 不会缓存 AI 标题，reAppendSessionMetadata 也不会在 EOF
 *   重新追加它，避免旧 AI 标题在 resume 后覆盖用户中途重命名。
 * - CAS 语义：VS Code 的 onlyIfNoCustomTitle 只扫描 customTitle 字段，
 *   因此 AI 可以覆盖自己的旧 AI 标题，但不能覆盖用户标题。
 * - 指标语义：AI 标题不会触发 tengu_session_renamed。
 *
 * 该 entry 不会重新追加。消息积累足够多后它会滑出 64KB 尾部窗口；
 * readLiteMetadata、listSessionsImpl、VS Code fetchSessions 会退回扫描头部窗口查找 aiTitle。
 * 头尾读取都有边界（各 64KB），不会全文件扫描。
 *
 * 带 stale-write guard 的调用方（如 VS Code client）应优先给 SDK control 请求传
 * `persist: false`，等自己的 guard 通过后再走 rename 路径持久化，避免 AI 标题
 * 在飞行中的用户重命名之后落盘造成竞态。
 */
export function saveAiGeneratedTitle(sessionId: UUID, aiTitle: string): void {
  appendEntryToFile(getTranscriptPathForSession(sessionId), {
    type: 'ai-title',
    aiTitle,
    sessionId,
  })
}

/**
 * 为 `claude ps` 追加周期性任务摘要。
 * 它不像 ai-title 那样需要 reAppendSessionMetadata 维护；这是 agent 当前状态的滚动快照，
 * 允许过期，ps 只从尾部读取最近一条。
 */
export function saveTaskSummary(sessionId: UUID, summary: string): void {
  appendEntryToFile(getTranscriptPathForSession(sessionId), {
    type: 'task-summary',
    summary,
    sessionId,
    timestamp: new Date().toISOString(),
  })
}

export async function saveTag(sessionId: UUID, tag: string, fullPath?: string) {
  // 未传 fullPath 时按 sessionId 计算默认 transcript 路径。
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, { type: 'tag', tag, sessionId })
  // 只缓存当前 session，保证 UI 立即可见。
  if (sessionId === getSessionId()) {
    getProject().currentSessionTag = tag
  }
  logEvent('tengu_session_tagged', {})
}

/**
 * 将 session 关联到 GitHub PR。
 * 保存 PR 编号、URL 和仓库名，供展示、追踪和跳转使用。
 */
export async function linkSessionToPR(
  sessionId: UUID,
  prNumber: number,
  prUrl: string,
  prRepository: string,
  fullPath?: string,
): Promise<void> {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: 'pr-link',
    sessionId,
    prNumber,
    prUrl,
    prRepository,
    timestamp: new Date().toISOString(),
  })
  // 缓存当前 session 的 PR 信息，便于 compaction 后重新追加到尾部。
  if (sessionId === getSessionId()) {
    const project = getProject()
    project.currentSessionPrNumber = prNumber
    project.currentSessionPrUrl = prUrl
    project.currentSessionPrRepository = prRepository
  }
  logEvent('tengu_session_linked_to_pr', { prNumber })
}

export function getCurrentSessionTag(sessionId: UUID): string | undefined {
  // 只返回当前 session 的 tag，因为内存里只缓存当前 session。
  if (sessionId === getSessionId()) {
    return getProject().currentSessionTag
  }
  return undefined
}

export function getCurrentSessionTitle(
  sessionId: SessionId,
): string | undefined {
  // 只返回当前 session 的标题，因为内存里只缓存当前 session。
  if (sessionId === getSessionId()) {
    return getProject().currentSessionTitle
  }
  return undefined
}

export function getCurrentSessionAgentColor(): string | undefined {
  return getProject().currentSessionAgentColor
}

/**
 * resume 时把 session metadata 恢复到内存缓存。
 * 这些缓存会立即用于 UI 展示（如 agent banner），并在退出时通过
 * reAppendSessionMetadata 重新追加到 transcript 尾部。
 */
export function restoreSessionMetadata(meta: {
  customTitle?: string
  tag?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  mode?: 'coordinator' | 'normal'
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}): void {
  const project = getProject()
  // 使用 ??= 是为了让 --name（cacheSessionTitle）优先于恢复出的旧标题。
  // REPL.tsx 在 /resume 前会先 clear，因此普通 /resume 不受影响。
  if (meta.customTitle) project.currentSessionTitle ??= meta.customTitle
  if (meta.tag !== undefined) project.currentSessionTag = meta.tag || undefined
  if (meta.agentName) project.currentSessionAgentName = meta.agentName
  if (meta.agentColor) project.currentSessionAgentColor = meta.agentColor
  if (meta.agentSetting) project.currentSessionAgentSetting = meta.agentSetting
  if (meta.mode) project.currentSessionMode = meta.mode
  if (meta.worktreeSession !== undefined)
    project.currentSessionWorktree = meta.worktreeSession
  if (meta.prNumber !== undefined)
    project.currentSessionPrNumber = meta.prNumber
  if (meta.prUrl) project.currentSessionPrUrl = meta.prUrl
  if (meta.prRepository) project.currentSessionPrRepository = meta.prRepository
}

/**
 * 清空当前进程缓存的 session metadata。
 * /clear 创建新 session 时调用，避免上一 session 的 title、tag、agent、PR 等信息
 * 泄漏到新 session。
 */
export function clearSessionMetadata(): void {
  const project = getProject()
  project.currentSessionTitle = undefined
  project.currentSessionTag = undefined
  project.currentSessionAgentName = undefined
  project.currentSessionAgentColor = undefined
  project.currentSessionLastPrompt = undefined
  project.currentSessionAgentSetting = undefined
  project.currentSessionMode = undefined
  project.currentSessionWorktree = undefined
  project.currentSessionPrNumber = undefined
  project.currentSessionPrUrl = undefined
  project.currentSessionPrRepository = undefined
}

/**
 * 将缓存的 session metadata 重新追加到 transcript 文件尾部。
 * compaction 后调用它，可以让 metadata 保持在 readLiteMetadata 的尾部扫描窗口内。
 * 否则 compaction 后继续写入足够多消息时，metadata entry 会被挤出窗口，
 * `--resume` 只能显示自动生成的 firstPrompt，而不是用户设置的 session 名称。
 */
export function reAppendSessionMetadata(): void {
  getProject().reAppendSessionMetadata()
}

export async function saveAgentName(
  sessionId: UUID,
  agentName: string,
  fullPath?: string,
  source: 'user' | 'auto' = 'user',
) {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, { type: 'agent-name', agentName, sessionId })
  // 只缓存当前 session，保证 UI 立即可见，不影响其他 session。
  if (sessionId === getSessionId()) {
    getProject().currentSessionAgentName = agentName
    void updateSessionName(agentName)
  }
  logEvent('tengu_agent_name_set', {
    source:
      source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

export async function saveAgentColor(
  sessionId: UUID,
  agentColor: string,
  fullPath?: string,
) {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: 'agent-color',
    agentColor,
    sessionId,
  })
  // 只缓存当前 session，保证 UI 立即可见，不影响其他 session。
  if (sessionId === getSessionId()) {
    getProject().currentSessionAgentColor = agentColor
  }
  logEvent('tengu_agent_color_set', {})
}

/**
 * 缓存当前 session 的 agent setting。
 * 第一条用户消息触发 materializeSessionFile 时写入磁盘，退出时由
 * reAppendSessionMetadata 重新盖到文件尾部。这里只缓存，避免启动阶段创建
 * 只有 metadata 的 session 文件。
 */
export function saveAgentSetting(agentSetting: string): void {
  getProject().currentSessionAgentSetting = agentSetting
}

/**
 * 缓存启动时通过 --name 设置的 session 标题。
 * 第一条用户消息触发 materializeSessionFile 时才写盘；在 sessionId 最终确定前
 * 只保存在内存，避免产生孤立的 metadata-only 文件。
 */
export function cacheSessionTitle(customTitle: string): void {
  getProject().currentSessionTitle = customTitle
}

/**
 * 缓存当前 session mode。
 * 第一条用户消息触发 materializeSessionFile 时写入磁盘，退出时由
 * reAppendSessionMetadata 重新追加。这里只缓存，避免启动时创建 metadata-only 文件。
 */
export function saveMode(mode: 'coordinator' | 'normal'): void {
  getProject().currentSessionMode = mode
}

/**
 * 记录当前 session 的 worktree 状态，供 --resume 恢复 cwd。
 * 第一条用户消息触发 materializeSessionFile 时写入磁盘，退出时由
 * reAppendSessionMetadata 重新追加。退出 worktree 时传 null，
 * 让 --resume 知道不应再 cd 回该 worktree。
 */
export function saveWorktreeState(
  worktreeSession: PersistedWorktreeSession | null,
): void {
  // 去掉调用方可能随完整 WorktreeSession 传入的临时字段
  //（creationDurationMs、usedSparsePaths）。TypeScript 结构化类型允许多带字段，
  // 但这些运行期指标不应序列化进 transcript。
  const stripped: PersistedWorktreeSession | null = worktreeSession
    ? {
        originalCwd: worktreeSession.originalCwd,
        worktreePath: worktreeSession.worktreePath,
        worktreeName: worktreeSession.worktreeName,
        worktreeBranch: worktreeSession.worktreeBranch,
        originalBranch: worktreeSession.originalBranch,
        originalHeadCommit: worktreeSession.originalHeadCommit,
        sessionId: worktreeSession.sessionId,
        tmuxSessionName: worktreeSession.tmuxSessionName,
        hookBased: worktreeSession.hookBased,
      }
    : null
  const project = getProject()
  project.currentSessionWorktree = stripped
  // session 文件已经存在时立即写入，覆盖会话中途进入/退出 worktree 的场景。
  // --worktree 启动初期 sessionFile 为 null，会在第一条消息 materialize 时
  // 通过 reAppendSessionMetadata 写入。
  if (project.sessionFile) {
    appendEntryToFile(project.sessionFile, {
      type: 'worktree-state',
      worktreeSession: stripped,
      sessionId: getSessionId(),
    })
  }
}

/**
 * 从 LogOption 中提取 sessionId。
 * lite log 直接使用 sessionId 字段；full log 从第一条消息读取。
 */
export function getSessionIdFromLog(log: LogOption): UUID | undefined {
  // lite log 已直接携带 sessionId。
  if (log.sessionId) {
    return log.sessionId as UUID
  }
  // full log 从第一条消息回退提取。
  return log.messages[0]?.sessionId as UUID | undefined
}

/**
 * 判断 LogOption 是否为需要延迟加载的 lite log。
 * lite log 的 messages 为空，但会携带 sessionId。
 */
export function isLiteLog(log: LogOption): boolean {
  return log.messages.length === 0 && log.sessionId !== undefined
}

/**
 * 读取 JSONL 文件，把 lite log 补全为 full log。
 * 成功时返回包含 messages 的新 LogOption；如果本来就是 full log 或加载失败，
 * 则返回原始 log。
 */
export async function loadFullLog(log: LogOption): Promise<LogOption> {
  // 已经是 full log 时无需处理。
  if (!isLiteLog(log)) {
    return log
  }

  // 直接使用索引里记录的 fullPath，避免重新猜测路径。
  const sessionFile = log.fullPath
  if (!sessionFile) {
    return log
  }

  try {
    const {
      messages,
      summaries,
      customTitles,
      tags,
      agentNames,
      agentColors,
      agentSettings,
      prNumbers,
      prUrls,
      prRepositories,
      modes,
      worktreeStates,
      fileHistorySnapshots,
      attributionSnapshots,
      contentReplacements,
      contextCollapseCommits,
      contextCollapseSnapshot,
      leafUuids,
    } = await loadTranscriptFile(sessionFile)

    if (messages.size === 0) {
      return log
    }

    // 从 transcript 中找到最新 user/assistant leaf 消息。
    const mostRecentLeaf = findLatestMessage(
      messages.values(),
      msg =>
        leafUuids.has(msg.uuid) &&
        (msg.type === 'user' || msg.type === 'assistant'),
    )
    if (!mostRecentLeaf) {
      return log
    }

    // 从该 leaf 构造恢复用对话链。
    const transcript = buildConversationChain(messages, mostRecentLeaf)
    // 使用 leaf 的 sessionId。fork session 可能复制了源 session 的 chain[0]，
    // 但 custom-title 等 metadata entry 是按当前 sessionId 记录的。
    const sessionId = mostRecentLeaf.sessionId as UUID | undefined
    return {
      ...log,
      messages: removeExtraFields(transcript),
      firstPrompt: extractFirstPrompt(transcript),
      messageCount: countVisibleMessages(transcript),
      summary: mostRecentLeaf
        ? summaries.get(mostRecentLeaf.uuid)
        : log.summary,
      customTitle: sessionId ? customTitles.get(sessionId) : log.customTitle,
      tag: sessionId ? tags.get(sessionId) : log.tag,
      agentName: sessionId ? agentNames.get(sessionId) : log.agentName,
      agentColor: sessionId ? agentColors.get(sessionId) : log.agentColor,
      agentSetting: sessionId ? agentSettings.get(sessionId) : log.agentSetting,
      mode: sessionId ? (modes.get(sessionId) as LogOption['mode']) : log.mode,
      worktreeSession:
        sessionId && worktreeStates.has(sessionId)
          ? worktreeStates.get(sessionId)
          : log.worktreeSession,
      prNumber: sessionId ? prNumbers.get(sessionId) : log.prNumber,
      prUrl: sessionId ? prUrls.get(sessionId) : log.prUrl,
      prRepository: sessionId
        ? prRepositories.get(sessionId)
        : log.prRepository,
      gitBranch: mostRecentLeaf?.gitBranch ?? log.gitBranch,
      isSidechain: transcript[0]?.isSidechain ?? log.isSidechain,
      teamName: transcript[0]?.teamName ?? log.teamName,
      leafUuid: mostRecentLeaf?.uuid ?? log.leafUuid,
      fileHistorySnapshots: buildFileHistorySnapshotChain(
        fileHistorySnapshots,
        transcript,
      ),
      attributionSnapshots: buildAttributionSnapshotChain(
        attributionSnapshots,
        transcript,
      ),
      contentReplacements: sessionId
        ? (contentReplacements.get(sessionId) ?? [])
        : log.contentReplacements,
      // 只保留目标 session 的 context-collapse entry。
      // loadTranscriptFile 按文件顺序读取，数组已经是 commit 顺序；filter 会保持该顺序。
      contextCollapseCommits: sessionId
        ? contextCollapseCommits.filter(e => e.sessionId === sessionId)
        : undefined,
      contextCollapseSnapshot:
        sessionId && contextCollapseSnapshot?.sessionId === sessionId
          ? contextCollapseSnapshot
          : undefined,
    }
  } catch {
    // 加载失败时保持原始 lite log，避免列表整体失败。
    return log
  }
}

/**
 * 按自定义标题搜索 session。
 * 搜索不区分大小写，结果按最近修改时间倒序；同一 sessionId 多次出现时只保留最新一条。
 * 默认会搜索同一 repo 的 worktree。
 */
export async function searchSessionsByCustomTitle(
  query: string,
  options?: { limit?: number; exact?: boolean },
): Promise<LogOption[]> {
  const { limit, exact } = options || {}
  // 使用 worktree-aware 加载，覆盖同一 repo 的其他 worktree session。
  const worktreePaths = await getWorktreePaths(getOriginalCwd())
  const allStatLogs = await getStatOnlyLogsForWorktrees(worktreePaths)
  // 需要 enrich 全部 lite log，才能读取 customTitle metadata。
  const { logs } = await enrichLogs(allStatLogs, 0, allStatLogs.length)
  const normalizedQuery = query.toLowerCase().trim()

  const matchingLogs = logs.filter(log => {
    const title = log.customTitle?.toLowerCase().trim()
    if (!title) return false
    return exact ? title === normalizedQuery : title.includes(normalizedQuery)
  })

  // 按 sessionId 去重。同一对话的不同分支可能共享 sessionId，只保留最新修改的一条。
  const sessionIdToLog = new Map<UUID, LogOption>()
  for (const log of matchingLogs) {
    const sessionId = getSessionIdFromLog(log)
    if (sessionId) {
      const existing = sessionIdToLog.get(sessionId)
      if (!existing || log.modified > existing.modified) {
        sessionIdToLog.set(sessionId, log)
      }
    }
  }
  const deduplicated = Array.from(sessionIdToLog.values())

  // 按最近修改时间排序。
  deduplicated.sort((a, b) => b.modified.getTime() - a.modified.getTime())

  // 如果指定 limit，则截断结果。
  if (limit) {
    return deduplicated.slice(0, limit)
  }

  return deduplicated
}

/**
 * 这些 metadata entry 可能出现在 compact boundary 之前，但恢复时仍必须读取。
 * 它们属于 session 级别，而不是消息级别。这里保留为原始 JSON 片段，
 * 便于流式扫描时做低成本行过滤。
 */
const METADATA_TYPE_MARKERS = [
  '"type":"summary"',
  '"type":"custom-title"',
  '"type":"tag"',
  '"type":"agent-name"',
  '"type":"agent-color"',
  '"type":"agent-setting"',
  '"type":"mode"',
  '"type":"worktree-state"',
  '"type":"pr-link"',
]
const METADATA_MARKER_BUFS = METADATA_TYPE_MARKERS.map(m => Buffer.from(m))
// 最长 marker 为 22 字节，加上开头 `{` 后约 23 字节，留少量余量。
const METADATA_PREFIX_BOUND = 25

// null 表示 carry 跨越了整个 chunk。若能证明 carry 不是 metadata 行，
// 就跳过 concat；metadata marker 固定出现在 `{` 后第 1 字节。
function resolveMetadataBuf(
  carry: Buffer | null,
  chunkBuf: Buffer,
): Buffer | null {
  if (carry === null || carry.length === 0) return chunkBuf
  if (carry.length < METADATA_PREFIX_BOUND) {
    return Buffer.concat([carry, chunkBuf])
  }
  if (carry[0] === 0x7b /* { */) {
    for (const m of METADATA_MARKER_BUFS) {
      if (carry.compare(m, 0, m.length, 1, 1 + m.length) === 0) {
        return Buffer.concat([carry, chunkBuf])
      }
    }
  }
  const firstNl = chunkBuf.indexOf(0x0a)
  return firstNl === -1 ? null : chunkBuf.subarray(firstNl + 1)
}

/**
 * 轻量前向扫描 [0, endOffset)，只收集 metadata entry 行。
 * 使用原始 Buffer chunk 和字节级 marker 匹配；对于绝大多数消息内容行，
 * 不创建 readline，也不做逐行字符串转换。
 *
 * 快路径：如果一个 chunk 不包含任何 marker（常见情况，单个 session 的 metadata
 * entry 通常少于 50 条），整个 chunk 会直接跳过，无需切行。
 */
async function scanPreBoundaryMetadata(
  filePath: string,
  endOffset: number,
): Promise<string[]> {
  const { createReadStream } = await import('fs')
  const NEWLINE = 0x0a

  const stream = createReadStream(filePath, { end: endOffset - 1 })
  const metadataLines: string[] = []
  let carry: Buffer | null = null

  for await (const chunk of stream) {
    const chunkBuf = chunk as Buffer
    const buf = resolveMetadataBuf(carry, chunkBuf)
    if (buf === null) {
      carry = null
      continue
    }

    // 快路径：大多数 chunk 没有 metadata marker，直接跳过切行。
    let hasAnyMarker = false
    for (const m of METADATA_MARKER_BUFS) {
      if (buf.includes(m)) {
        hasAnyMarker = true
        break
      }
    }

    if (hasAnyMarker) {
      let lineStart = 0
      let nl = buf.indexOf(NEWLINE)
      while (nl !== -1) {
        // 有界 marker 检查：只在当前行的字节范围内查找。
        for (const m of METADATA_MARKER_BUFS) {
          const mIdx = buf.indexOf(m, lineStart)
          if (mIdx !== -1 && mIdx < nl) {
            metadataLines.push(buf.toString('utf-8', lineStart, nl))
            break
          }
        }
        lineStart = nl + 1
        nl = buf.indexOf(NEWLINE, lineStart)
      }
      carry = buf.subarray(lineStart)
    } else {
      // 当前 chunk 没有 marker，只保留末尾未完成的一行。
      const lastNl = buf.lastIndexOf(NEWLINE)
      carry = lastNl >= 0 ? buf.subarray(lastNl + 1) : buf
    }

    // 防止异常超长行导致 carry 反复 concat 形成二次增长。
    // 真实 metadata entry 通常小于 1KB；超过 64KB 基本可判定处于消息内容中，直接丢弃。
    if (carry.length > 64 * 1024) carry = null
  }

  // 处理 endOffset 处没有换行结尾的最后一行。
  if (carry !== null && carry.length > 0) {
    for (const m of METADATA_MARKER_BUFS) {
      if (carry.includes(m)) {
        metadataLines.push(carry.toString('utf-8'))
        break
      }
    }
  }

  return metadataLines
}

/**
 * 字节级预过滤：在 parseJSONL 前剔除已经失活的 fork 分支。
 *
 * 每次 rewind/ctrl-z 都会在追加式 JSONL 中永久留下一个孤立分支。
 * buildConversationChain 会从最新 leaf 沿 parentUuid 回溯并丢弃其他分支，
 * 但那时 parseJSONL 已经为全部内容付出了 JSON.parse 成本。fork-heavy session 实测：
 *
 *   41 MB，99% 死分支：parseJSONL 56.0 ms -> 3.9 ms（-93%）
 *   151 MB，92% 死分支：47.3 ms -> 9.4 ms（-80%）
 *
 * 死分支很少的 session（5-7%）收益不明显，索引扫描开销会抵消 parse 节省。
 * 因此该优化只在 buffer 足够大时启用，阈值和 SKIP_PRECOMPACT_THRESHOLD 一致。
 *
 * 该逻辑依赖两个已在本地 25k+ 消息行验证过的约束（0 违例）：
 *
 * 1. TranscriptMessage 序列化时 parentUuid 总是第一个 key。
 *    JSON.stringify 按插入顺序输出 key，而 recordTranscript 的对象字面量把 parentUuid
 *    放在第一位。因此 `{"parentUuid":` 是稳定行前缀，可区分消息行和 metadata 行。
 *
 * 2. 顶层 uuid 通过 suffix 检查 + JSON 深度检查识别（见扫描循环内注释）。
 *    toolUseResult/mcpMeta 会在 uuid 之后序列化任意服务端对象，agent_progress
 *    又会在顶层 uuid 之前序列化嵌套 Message；二者都可能出现嵌套的
 *    `"uuid":"<36>","timestamp":"`。因此只看 suffix 不够，多重匹配时要用
 *    花括号深度区分顶层字段。
 *
 * 追加式写入保证父节点总是位于子节点之前，因此从 EOF 向前沿 parentUuid 追溯是可行的。
 */

/**
 * 当同一行出现多个 `"uuid":"<36>","timestamp":"` 时，选择 JSON 嵌套深度为 1 的候选。
 * 这里的花括号计数会识别字符串：字符串里的 `{`/`}` 不计数，也处理 `\"` 和 `\\`。
 * candidates 按字节顺序升序排列。正常 JSONL 中顶层字段都在深度 1；
 * 若没有深度 1 候选，则退回最后一个候选。
 *
 * 只有存在两个及以上 suffix 匹配时才调用，例如 agent_progress 内嵌 Message，
 * 或 mcpMeta 中碰巧有同形对象。成本是一次前向字节扫描，找到第一个深度 1 候选即停止。
 */
function pickDepthOneUuidCandidate(
  buf: Buffer,
  lineStart: number,
  candidates: number[],
): number {
  const QUOTE = 0x22
  const BACKSLASH = 0x5c
  const OPEN_BRACE = 0x7b
  const CLOSE_BRACE = 0x7d
  let depth = 0
  let inString = false
  let escapeNext = false
  let ci = 0
  for (let i = lineStart; ci < candidates.length; i++) {
    if (i === candidates[ci]) {
      if (depth === 1 && !inString) return candidates[ci]!
      ci++
    }
    const b = buf[i]!
    if (escapeNext) {
      escapeNext = false
    } else if (inString) {
      if (b === BACKSLASH) escapeNext = true
      else if (b === QUOTE) inString = false
    } else if (b === QUOTE) inString = true
    else if (b === OPEN_BRACE) depth++
    else if (b === CLOSE_BRACE) depth--
  }
  return candidates.at(-1)!
}

function walkChainBeforeParse(buf: Buffer): Buffer {
  const NEWLINE = 0x0a
  const OPEN_BRACE = 0x7b
  const QUOTE = 0x22
  const PARENT_PREFIX = Buffer.from('{"parentUuid":')
  const UUID_KEY = Buffer.from('"uuid":"')
  const SIDECHAIN_TRUE = Buffer.from('"isSidechain":true')
  const UUID_LEN = 36
  const TS_SUFFIX = Buffer.from('","timestamp":"')
  const TS_SUFFIX_LEN = TS_SUFFIX.length
  const PREFIX_LEN = PARENT_PREFIX.length
  const KEY_LEN = UUID_KEY.length

  // transcript 消息的 stride-3 扁平索引：[lineStart, lineEnd, parentStart]。
  // parentStart 是父 UUID 首字符的字节偏移；parentUuid 为 null 时记 -1。
  // metadata 行（summary、mode、file-history-snapshot 等）放入 metaRanges，
  // 不做过滤；它们没有 parentUuid 前缀，且下游需要完整读取。
  const msgIdx: number[] = []
  const metaRanges: number[] = []
  const uuidToSlot = new Map<string, number>()

  let pos = 0
  const len = buf.length
  while (pos < len) {
    const nl = buf.indexOf(NEWLINE, pos)
    const lineEnd = nl === -1 ? len : nl + 1
    if (
      lineEnd - pos > PREFIX_LEN &&
      buf[pos] === OPEN_BRACE &&
      buf.compare(PARENT_PREFIX, 0, PREFIX_LEN, pos, pos + PREFIX_LEN) === 0
    ) {
      // 支持 `{"parentUuid":null,` 和 `{"parentUuid":"<36 chars>",` 两种形式。
      const parentStart =
        buf[pos + PREFIX_LEN] === QUOTE ? pos + PREFIX_LEN + 1 : -1
      // user/assistant/attachment 的顶层 uuid 后面紧跟 `","timestamp":"`，
      // 因为 create* helper 会相邻写入二者且二者总是存在。但该 suffix 并不唯一：
      // - agent_progress 的 data.message 内有嵌套 Message，且在顶层 uuid 前序列化；
      //   该内层 Message 也有相邻 uuid/timestamp。
      // - mcpMeta/toolUseResult 位于顶层 uuid 之后，内容来自服务端任意对象；
      //   如果服务端返回 {uuid:"<36>",timestamp:"..."}，也会匹配。
      // 因此先收集所有 suffix 匹配。只有一个时可直接使用；多个时用 JSON 深度挑顶层。
      // 没有 suffix 匹配的 entry（某些 progress 变体 timestamp 在 uuid 前）通常只有一个
      // `"uuid":"`，取第一处是安全的。
      let firstAny = -1
      let suffix0 = -1
      let suffixN: number[] | undefined
      let from = pos
      for (;;) {
        const next = buf.indexOf(UUID_KEY, from)
        if (next < 0 || next >= lineEnd) break
        if (firstAny < 0) firstAny = next
        const after = next + KEY_LEN + UUID_LEN
        if (
          after + TS_SUFFIX_LEN <= lineEnd &&
          buf.compare(
            TS_SUFFIX,
            0,
            TS_SUFFIX_LEN,
            after,
            after + TS_SUFFIX_LEN,
          ) === 0
        ) {
          if (suffix0 < 0) suffix0 = next
          else (suffixN ??= [suffix0]).push(next)
        }
        from = next + KEY_LEN
      }
      const uk = suffixN
        ? pickDepthOneUuidCandidate(buf, pos, suffixN)
        : suffix0 >= 0
          ? suffix0
          : firstAny
      if (uk >= 0) {
        const uuidStart = uk + KEY_LEN
        // UUID 是纯 ASCII；用 latin1 可避免 UTF-8 解码开销。
        const uuid = buf.toString('latin1', uuidStart, uuidStart + UUID_LEN)
        uuidToSlot.set(uuid, msgIdx.length)
        msgIdx.push(pos, lineEnd, parentStart)
      } else {
        metaRanges.push(pos, lineEnd)
      }
    } else {
      metaRanges.push(pos, lineEnd)
    }
    pos = lineEnd
  }

  // leaf 取最后一个非 sidechain entry。isSidechain 通常是第 2 或第 3 个 key
  //（位于 parentUuid、可选 logicalParentUuid 之后），从 lineStart 搜索通常只扫几十字节；
  // 如果不存在而搜索越到下一行，后面的边界检查会拦住。
  let leafSlot = -1
  for (let i = msgIdx.length - 3; i >= 0; i -= 3) {
    const sc = buf.indexOf(SIDECHAIN_TRUE, msgIdx[i]!)
    if (sc === -1 || sc >= msgIdx[i + 1]!) {
      leafSlot = i
      break
    }
  }
  if (leafSlot < 0) return buf

  // 沿 parentUuid 回溯到根。记录保留消息的行起点并累计字节数，
  // 用来判断是否值得重新 concat。悬空 parent（文件里没有该 UUID）是 fork session
  // 和 post-boundary 链的正常终止条件，语义和 buildConversationChain 一致。
  // 防止索引污染的关键是上面的 timestamp suffix 检查：没有 suffix 的嵌套 uuid
  // 不会成为 uk。
  const seen = new Set<number>()
  const chain = new Set<number>()
  let chainBytes = 0
  let slot: number | undefined = leafSlot
  while (slot !== undefined) {
    if (seen.has(slot)) break
    seen.add(slot)
    chain.add(msgIdx[slot]!)
    chainBytes += msgIdx[slot + 1]! - msgIdx[slot]!
    const parentStart = msgIdx[slot + 2]!
    if (parentStart < 0) break
    const parent = buf.toString('latin1', parentStart, parentStart + UUID_LEN)
    slot = uuidToSlot.get(parent)
  }

  // parseJSONL 成本和字节数相关，而不是 entry 数量。某些 session 可能有大量死 entry，
  // 但死分支都是短轮次，真正占字节的是活跃链上的大 assistant 响应。
  // 实测 107MB session 中 69% entry 已死但只占 30% 字节，索引+concat 开销反而超过收益。
  // 因此按字节数设门槛：只有能丢掉至少一半 buffer 时才重组。
  // metadata 很小，len - chainBytes 足以近似死字节。接近盈亏平衡时 concat memcpy
  // 是主要成本，所以保守使用 50% 门槛。
  if (len - chainBytes < len >> 1) return buf

  // 按原文件顺序合并活跃链 entry 和 metadata。msgIdx 与 metaRanges 都已按 offset 排序；
  // 这里交错生成 subarray view，最后只 concat 一次。
  const parts: Buffer[] = []
  let m = 0
  for (let i = 0; i < msgIdx.length; i += 3) {
    const start = msgIdx[i]!
    while (m < metaRanges.length && metaRanges[m]! < start) {
      parts.push(buf.subarray(metaRanges[m]!, metaRanges[m + 1]!))
      m += 2
    }
    if (chain.has(start)) {
      parts.push(buf.subarray(start, msgIdx[i + 1]!))
    }
  }
  while (m < metaRanges.length) {
    parts.push(buf.subarray(metaRanges[m]!, metaRanges[m + 1]!))
    m += 2
  }
  return Buffer.concat(parts)
}

/**
 * 从 transcript 文件加载消息、摘要和各类 session metadata。
 * 返回值是按用途拆分的索引：消息 Map、标题/tag、agent 信息、PR 信息、
 * 文件历史快照、归因快照、content replacement、context-collapse 状态和 leaf 集合。
 */
export async function loadTranscriptFile(
  filePath: string,
  opts?: { keepAllLeaves?: boolean },
): Promise<{
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  tags: Map<UUID, string>
  agentNames: Map<UUID, string>
  agentColors: Map<UUID, string>
  agentSettings: Map<UUID, string>
  prNumbers: Map<UUID, number>
  prUrls: Map<UUID, string>
  prRepositories: Map<UUID, string>
  modes: Map<UUID, string>
  worktreeStates: Map<UUID, PersistedWorktreeSession | null>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>
  contentReplacements: Map<UUID, ContentReplacementRecord[]>
  agentContentReplacements: Map<AgentId, ContentReplacementRecord[]>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
  leafUuids: Set<UUID>
}> {
  const messages = new Map<UUID, TranscriptMessage>()
  const summaries = new Map<UUID, string>()
  const customTitles = new Map<UUID, string>()
  const tags = new Map<UUID, string>()
  const agentNames = new Map<UUID, string>()
  const agentColors = new Map<UUID, string>()
  const agentSettings = new Map<UUID, string>()
  const prNumbers = new Map<UUID, number>()
  const prUrls = new Map<UUID, string>()
  const prRepositories = new Map<UUID, string>()
  const modes = new Map<UUID, string>()
  const worktreeStates = new Map<UUID, PersistedWorktreeSession | null>()
  const fileHistorySnapshots = new Map<UUID, FileHistorySnapshotMessage>()
  const attributionSnapshots = new Map<UUID, AttributionSnapshotMessage>()
  const contentReplacements = new Map<UUID, ContentReplacementRecord[]>()
  const agentContentReplacements = new Map<
    AgentId,
    ContentReplacementRecord[]
  >()
  // 使用数组而不是 Map，因为 commit 顺序有意义，嵌套 collapse 可能引用前序 commit。
  const contextCollapseCommits: ContextCollapseCommitEntry[] = []
  // snapshot 采用 last-wins，后写覆盖先写。
  let contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined

  try {
    // 大 transcript 读取时避免把大量过期内容物化到内存。
    // 单次前向 chunk 读取会在 fd 层跳过 attribution-snapshot 行；
    // 遇到 compact boundary 时在流中截断累积 buffer。峰值分配接近输出大小，
    // 而不是文件大小。151MB session 中如果 84% 是过期 attr-snap，
    // 新路径约分配 32MB，而不是旧路径的 159+64MB。
    // 这很重要，因为 mimalloc 即使在 JS GC 释放 ArrayBuffer 后也未必立刻还页给 OS。
    //
    // boundary 前的 session metadata（agent-setting、mode、pr-link 等）
    // 通过 [0, boundary) 范围内的轻量字节扫描补回。
    let buf: Buffer | null = null
    let metadataLines: string[] | null = null
    let hasPreservedSegment = false
    if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP)) {
      const { size } = await stat(filePath)
      if (size > SKIP_PRECOMPACT_THRESHOLD) {
        const scan = await readTranscriptForLoad(filePath, size)
        buf = scan.postBoundaryBuf
        hasPreservedSegment = scan.hasPreservedSegment
        // >0 表示已截掉 boundary 前字节，需要从该范围恢复 session 级 metadata。
        // preservedSegment boundary 本身不会截断，因为 preserved 消息物理上仍在 boundary 前；
        // 除非更早的非 preserved boundary 已经截断过。此时后续 preserved 消息相对更早
        // boundary 来说位于保留区内，但我们仍需要扫描 metadata。
        if (scan.boundaryStartOffset > 0) {
          metadataLines = await scanPreBoundaryMetadata(
            filePath,
            scan.boundaryStartOffset,
          )
        }
      }
    }
    buf ??= await readFile(filePath)
    // 对大 buffer 来说，此时 attr-snap 已在 fd 层剥离，主要成本变成解析那些
    // buildConversationChain 最终会丢弃的死 fork 分支。
    // 以下场景不能做 pre-parse 链裁剪：
    // - 调用方需要所有 leaf（/insights 会选择用户消息最多的分支，而非最新分支）。
    // - boundary 带 preservedSegment；这些消息磁盘上仍保留 compact 前 parentUuid，
    //   applyPreservedSegmentRelinks 需要在 parse 后内存重连，提前链裁剪会把它们当孤儿丢掉。
    // - 设置了 CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP；该开关语义是“加载全部，不跳过”，
    //   而且 hasPreservedSegment 依赖的扫描也不会执行。
    if (
      !opts?.keepAllLeaves &&
      !hasPreservedSegment &&
      !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP) &&
      buf.length > SKIP_PRECOMPACT_THRESHOLD
    ) {
      buf = walkChainBeforeParse(buf)
    }

    // 第一遍先处理 boundary 扫描收集到的 metadata-only 行。
    // 这些行补全 compact boundary 前写入的 session 级 metadata（agentSettings、
    // modes、prNumbers 等）。如果和 post-boundary buffer 重叠也没关系，后写值会覆盖先写值。
    if (metadataLines && metadataLines.length > 0) {
      const metaEntries = parseJSONL<Entry>(
        Buffer.from(metadataLines.join('\n')),
      )
      for (const entry of metaEntries) {
        if (entry.type === 'summary' && entry.leafUuid) {
          summaries.set(entry.leafUuid, entry.summary)
        } else if (entry.type === 'custom-title' && entry.sessionId) {
          customTitles.set(entry.sessionId, entry.customTitle)
        } else if (entry.type === 'tag' && entry.sessionId) {
          tags.set(entry.sessionId, entry.tag)
        } else if (entry.type === 'agent-name' && entry.sessionId) {
          agentNames.set(entry.sessionId, entry.agentName)
        } else if (entry.type === 'agent-color' && entry.sessionId) {
          agentColors.set(entry.sessionId, entry.agentColor)
        } else if (entry.type === 'agent-setting' && entry.sessionId) {
          agentSettings.set(entry.sessionId, entry.agentSetting)
        } else if (entry.type === 'mode' && entry.sessionId) {
          modes.set(entry.sessionId, entry.mode)
        } else if (entry.type === 'worktree-state' && entry.sessionId) {
          worktreeStates.set(entry.sessionId, entry.worktreeSession)
        } else if (entry.type === 'pr-link' && entry.sessionId) {
          prNumbers.set(entry.sessionId, entry.prNumber)
          prUrls.set(entry.sessionId, entry.prUrl)
          prRepositories.set(entry.sessionId, entry.prRepository)
        }
      }
    }

    const entries = parseJSONL<Entry>(buf)

    // 旧 progress entry 桥接表：progress_uuid → progress_parent_uuid。
    // PR #24099 之后 progress 不再是 transcript message；旧 transcript 如果链到 progress，
    // buildConversationChain 会因 messages.get(progressUuid) 为 undefined 而截断。
    // transcript 是追加式写入，父节点总在子节点前，因此读取时记录每个 progress→parent，
    // 连续 progress 会链式解析，后续任何 parentUuid 指向 progress 的消息都会被改写到真实父节点。
    const progressBridge = new Map<UUID, UUID | null>()

    for (const entry of entries) {
      // 旧 progress 检查必须早于 Entry 类型分支。
      // progress 已不在 Entry 联合类型中；如果放到类型收窄之后，TypeScript 会把它推成 never。
      if (isLegacyProgressEntry(entry)) {
        // 连续 progress 需要链式解析。这样后续消息即使指向 progress 串尾，
        // 也能一次查到最近的非 progress 祖先。
        const parent = entry.parentUuid
        progressBridge.set(
          entry.uuid,
          parent && progressBridge.has(parent)
            ? (progressBridge.get(parent) ?? null)
            : parent,
        )
        continue
      }
      if (isTranscriptMessage(entry)) {
        if (entry.parentUuid && progressBridge.has(entry.parentUuid)) {
          entry.parentUuid = progressBridge.get(entry.parentUuid) ?? null
        }
        messages.set(entry.uuid, entry)
        // compact boundary 之前的 marble-origami-commit 可能引用已不在 post-boundary
        // 链中的消息。大文件后向扫描路径不会读取这些旧字节；小文件路径会读全量，
        // 因此这里遇到 boundary 时清掉旧 commit/snapshot。
        // 否则 /context 的 collapsedSpans 会过计数，尽管 projectView 会静默跳过过期 commit。
        if (isCompactBoundaryMessage(entry)) {
          contextCollapseCommits.length = 0
          contextCollapseSnapshot = undefined
        }
      } else if (entry.type === 'summary' && entry.leafUuid) {
        summaries.set(entry.leafUuid, entry.summary)
      } else if (entry.type === 'custom-title' && entry.sessionId) {
        customTitles.set(entry.sessionId, entry.customTitle)
      } else if (entry.type === 'tag' && entry.sessionId) {
        tags.set(entry.sessionId, entry.tag)
      } else if (entry.type === 'agent-name' && entry.sessionId) {
        agentNames.set(entry.sessionId, entry.agentName)
      } else if (entry.type === 'agent-color' && entry.sessionId) {
        agentColors.set(entry.sessionId, entry.agentColor)
      } else if (entry.type === 'agent-setting' && entry.sessionId) {
        agentSettings.set(entry.sessionId, entry.agentSetting)
      } else if (entry.type === 'mode' && entry.sessionId) {
        modes.set(entry.sessionId, entry.mode)
      } else if (entry.type === 'worktree-state' && entry.sessionId) {
        worktreeStates.set(entry.sessionId, entry.worktreeSession)
      } else if (entry.type === 'pr-link' && entry.sessionId) {
        prNumbers.set(entry.sessionId, entry.prNumber)
        prUrls.set(entry.sessionId, entry.prUrl)
        prRepositories.set(entry.sessionId, entry.prRepository)
      } else if (entry.type === 'file-history-snapshot') {
        fileHistorySnapshots.set(entry.messageId, entry)
      } else if (entry.type === 'attribution-snapshot') {
        attributionSnapshots.set(entry.messageId, entry)
      } else if (entry.type === 'content-replacement') {
        // subagent 的 replacement 决策按 agentId 索引，用于 sidechain resume；
        // 主线程决策按 sessionId 索引，用于 /resume。
        if (entry.agentId) {
          const existing = agentContentReplacements.get(entry.agentId) ?? []
          agentContentReplacements.set(entry.agentId, existing)
          existing.push(...entry.replacements)
        } else {
          const existing = contentReplacements.get(entry.sessionId) ?? []
          contentReplacements.set(entry.sessionId, existing)
          existing.push(...entry.replacements)
        }
      } else if (entry.type === 'marble-origami-commit') {
        contextCollapseCommits.push(entry)
      } else if (entry.type === 'marble-origami-snapshot') {
        contextCollapseSnapshot = entry
      }
    }
  } catch {
    // 文件不存在或不可读时返回空结果，由调用方决定是否忽略。
  }

  applyPreservedSegmentRelinks(messages)
  applySnipRemovals(messages)

  // 加载时一次性计算 leaf UUID。
  // 只有 user/assistant 适合作为 resume 锚点；system、attachment 等属于 metadata
  // 或辅助消息，不应作为对话链 leaf。
  //
  // 主链检测仍使用标准 parent 关系，但要处理最后一条消息是 system/metadata 的情况。
  // 对每条 parent 链来说，leaf 应是该链上最近的 user/assistant 消息。
  const allMessages = [...messages.values()]

  // 基于 parent 关系计算终端节点。
  const parentUuids = new Set(
    allMessages
      .map(msg => msg.parentUuid)
      .filter((uuid): uuid is UUID => uuid !== null),
  )

  // 终端消息指没有任何子节点的消息。
  const terminalMessages = allMessages.filter(msg => !parentUuids.has(msg.uuid))

  const leafUuids = new Set<UUID>()
  let hasCycle = false

  if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_pebble_leaf_prune', false)) {
    // 记录拥有 user/assistant 子节点的 UUID。它们是对话中间节点，不是 dead end。
    const hasUserAssistantChild = new Set<UUID>()
    for (const msg of allMessages) {
      if (msg.parentUuid && (msg.type === 'user' || msg.type === 'assistant')) {
        hasUserAssistantChild.add(msg.parentUuid)
      }
    }

    // 对每个终端消息向上追溯最近的 user/assistant 祖先。
    // 如果该祖先还有 user/assistant 子节点，说明对话已经从那里继续，不应把它当 leaf。
    // 典型场景：assistant tool_use 有一个 terminal progress 子节点，但真正的 tool_result
    // 子节点仍继续了对话。
    for (const terminal of terminalMessages) {
      const seen = new Set<UUID>()
      let current: TranscriptMessage | undefined = terminal
      while (current) {
        if (seen.has(current.uuid)) {
          hasCycle = true
          break
        }
        seen.add(current.uuid)
        if (current.type === 'user' || current.type === 'assistant') {
          if (!hasUserAssistantChild.has(current.uuid)) {
            leafUuids.add(current.uuid)
          }
          break
        }
        current = current.parentUuid
          ? messages.get(current.parentUuid)
          : undefined
      }
    }
  } else {
    // 旧算法：从终端消息无条件向上找最近的 user/assistant 祖先。
    for (const terminal of terminalMessages) {
      const seen = new Set<UUID>()
      let current: TranscriptMessage | undefined = terminal
      while (current) {
        if (seen.has(current.uuid)) {
          hasCycle = true
          break
        }
        seen.add(current.uuid)
        if (current.type === 'user' || current.type === 'assistant') {
          leafUuids.add(current.uuid)
          break
        }
        current = current.parentUuid
          ? messages.get(current.parentUuid)
          : undefined
      }
    }
  }

  if (hasCycle) {
    logEvent('tengu_transcript_parent_cycle', {})
  }

  return {
    messages,
    summaries,
    customTitles,
    tags,
    agentNames,
    agentColors,
    agentSettings,
    prNumbers,
    prUrls,
    prRepositories,
    modes,
    worktreeStates,
    fileHistorySnapshots,
    attributionSnapshots,
    contentReplacements,
    agentContentReplacements,
    contextCollapseCommits,
    contextCollapseSnapshot,
    leafUuids,
  }
}

/**
 * 从当前 projectDir 下的指定 session 文件加载消息、摘要、快照和 metadata。
 */
async function loadSessionFile(sessionId: UUID): Promise<{
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  tags: Map<UUID, string>
  agentSettings: Map<UUID, string>
  worktreeStates: Map<UUID, PersistedWorktreeSession | null>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>
  contentReplacements: Map<UUID, ContentReplacementRecord[]>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
}> {
  const sessionFile = join(
    getSessionProjectDir() ?? getProjectDir(getOriginalCwd()),
    `${sessionId}.jsonl`,
  )
  return loadTranscriptFile(sessionFile)
}

/**
 * 获取指定 session 中已写入的消息 UUID 集合。
 * 该结果会 memoize，避免同一 session 文件在一轮写入中被反复完整读取。
 */
const getSessionMessages = memoize(
  async (sessionId: UUID): Promise<Set<UUID>> => {
    const { messages } = await loadSessionFile(sessionId)
    return new Set(messages.keys())
  },
  (sessionId: UUID) => sessionId,
)

/**
 * 清空 session 消息 UUID 缓存。
 * compaction 后旧 UUID 集合不再能代表当前链，需要调用它。
 */
export function clearSessionMessagesCache(): void {
  getSessionMessages.cache.clear?.()
}

/**
 * 检查某个消息 UUID 是否已存在于 session 存储中。
 */
export async function doesMessageExistInSession(
  sessionId: UUID,
  messageUuid: UUID,
): Promise<boolean> {
  const messageSet = await getSessionMessages(sessionId)
  return messageSet.has(messageUuid)
}

export async function getLastSessionLog(
  sessionId: UUID,
): Promise<LogOption | null> {
  // 单次读取所有 session 数据，避免同一文件读两遍。
  const {
    messages,
    summaries,
    customTitles,
    tags,
    agentSettings,
    worktreeStates,
    fileHistorySnapshots,
    attributionSnapshots,
    contentReplacements,
    contextCollapseCommits,
    contextCollapseSnapshot,
  } = await loadSessionFile(sessionId)
  if (messages.size === 0) return null
  // 预热 getSessionMessages 缓存。REPL 在 --resume 挂载后会调用 recordTranscript，
  // 有缓存可避免第二次完整读大文件（大 session 可省约 170~227ms）。
  // 只在缓存为空时预热：中途调用者（如 IssueFeedback）可能读取当前 session；
  // 如果用磁盘快照覆盖正在使用的缓存，会丢失尚未 flush 的 UUID，破坏去重。
  if (!getSessionMessages.cache.has(sessionId)) {
    getSessionMessages.cache.set(
      sessionId,
      Promise.resolve(new Set(messages.keys())),
    )
  }

  // 找到最新的主线程消息，排除 sidechain。
  const lastMessage = findLatestMessage(messages.values(), m => !m.isSidechain)
  if (!lastMessage) return null

  // 从最新消息构造恢复用对话链。
  const transcript = buildConversationChain(messages, lastMessage)

  const summary = summaries.get(lastMessage.uuid)
  const customTitle = customTitles.get(lastMessage.sessionId as UUID)
  const tag = tags.get(lastMessage.sessionId as UUID)
  const agentSetting = agentSettings.get(sessionId)
  return {
    ...convertToLogOption(
      transcript,
      0,
      summary,
      customTitle,
      buildFileHistorySnapshotChain(fileHistorySnapshots, transcript),
      tag,
      getTranscriptPathForSession(sessionId),
      buildAttributionSnapshotChain(attributionSnapshots, transcript),
      agentSetting,
      contentReplacements.get(sessionId) ?? [],
    ),
    worktreeSession: worktreeStates.get(sessionId),
    contextCollapseCommits: contextCollapseCommits.filter(
      e => e.sessionId === sessionId,
    ),
    contextCollapseSnapshot:
      contextCollapseSnapshot?.sessionId === sessionId
        ? contextCollapseSnapshot
        : undefined,
  }
}

/**
 * 加载当前项目的 session 日志列表。
 * @param limit 限制最多加载多少个 session 文件。
 * @returns 按时间倒序排列的日志列表。
 */
export async function loadMessageLogs(limit?: number): Promise<LogOption[]> {
  const sessionLogs = await fetchLogs(limit)
  // fetchLogs 只返回基于 stat 的轻量日志；这里补充 title、tag、首条提示词等 metadata。
  // enrichLogs 会顺带过滤 sidechain、空 session 等不应出现在 /resume 里的记录。
  const { logs: enriched } = await enrichLogs(
    sessionLogs,
    0,
    sessionLogs.length,
  )

  // enrichLogs 返回的是新对象，可以就地改 value，避免为了重编号反复展开大 LogOption。
  const sorted = sortLogs(enriched)
  sorted.forEach((log, i) => {
    log.value = i
  })
  return sorted
}

/**
 * 加载所有项目目录下的 session 日志。
 * @param limit 每个项目最多加载的 session 文件数；跳过索引全量读取时生效。
 * @returns 按时间倒序排列的日志列表。
 */
export async function loadAllProjectsMessageLogs(
  limit?: number,
  options?: { skipIndex?: boolean; initialEnrichCount?: number },
): Promise<LogOption[]> {
  if (options?.skipIndex) {
    // /insights 等场景需要完整消息链，因此绕过轻量索引读取所有 session 内容。
    return loadAllProjectsMessageLogsFull(limit)
  }
  const result = await loadAllProjectsMessageLogsProgressive(
    limit,
    options?.initialEnrichCount ?? INITIAL_ENRICH_COUNT,
  )
  return result.logs
}

async function loadAllProjectsMessageLogsFull(
  limit?: number,
): Promise<LogOption[]> {
  const projectsDir = getProjectsDir()

  let dirents: Dirent[]
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const projectDirs = dirents
    .filter(dirent => dirent.isDirectory())
    .map(dirent => join(projectsDir, dirent.name))

  const logsPerProject = await Promise.all(
    projectDirs.map(projectDir => getLogsWithoutIndex(projectDir, limit)),
  )
  const allLogs = logsPerProject.flat()

  // 同一个 session+leaf 可能出现在多个项目目录中；这里每个 leaf 都会生成一个 LogOption，
  // 因此用 sessionId+leafUuid 做去重键。
  const deduped = new Map<string, LogOption>()
  for (const log of allLogs) {
    const key = `${log.sessionId ?? ''}:${log.leafUuid ?? ''}`
    const existing = deduped.get(key)
    if (!existing || log.modified.getTime() > existing.modified.getTime()) {
      deduped.set(key, log)
    }
  }

  // getLogsWithoutIndex 返回的是新对象，可以直接就地重编号。
  const sorted = sortLogs([...deduped.values()])
  sorted.forEach((log, i) => {
    log.value = i
  })
  return sorted
}

export async function loadAllProjectsMessageLogsProgressive(
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<SessionLogResult> {
  const projectsDir = getProjectsDir()

  let dirents: Dirent[]
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return { logs: [], allStatLogs: [], nextIndex: 0 }
  }

  const projectDirs = dirents
    .filter(dirent => dirent.isDirectory())
    .map(dirent => join(projectsDir, dirent.name))

  const rawLogs: LogOption[] = []
  for (const projectDir of projectDirs) {
    rawLogs.push(...(await getSessionFilesLite(projectDir, limit)))
  }
  // 同一个 session 可能存在于多个项目目录，先按 sessionId 去重。
  const sorted = deduplicateLogsBySessionId(rawLogs)

  const { logs, nextIndex } = await enrichLogs(sorted, 0, initialEnrichCount)

  // enrichLogs 返回的是新对象，可以安全地就地设置展示索引。
  logs.forEach((log, i) => {
    log.value = i
  })
  return { logs, allStatLogs: sorted, nextIndex }
}

/**
 * 加载同一 git 仓库各 worktree 下的 session 日志。
 * 如果没有传入 worktree 列表，则退回当前项目日志。
 *
 * 初始阶段只读取文件系统 metadata，不解析 JSONL，保证 /resume 打开速度。
 *
 * @param worktreePaths getWorktreePaths 返回的 worktree 路径数组。
 * @param limit 每个项目目录最多加载的 session 文件数。
 * @returns 按时间倒序排列的日志列表。
 */
/**
 * 支持渐进式补全 metadata 的 session 日志加载结果。
 */
export type SessionLogResult = {
  /** 已补全 metadata、可以直接展示的日志。 */
  logs: LogOption[]
  /** 仅含 stat 信息的完整候选列表；继续调用 enrichLogs 可加载更多。 */
  allStatLogs: LogOption[]
  /** 下次渐进加载应从 allStatLogs 的哪个位置继续。 */
  nextIndex: number
}

export async function loadSameRepoMessageLogs(
  worktreePaths: string[],
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<LogOption[]> {
  const result = await loadSameRepoMessageLogsProgressive(
    worktreePaths,
    limit,
    initialEnrichCount,
  )
  return result.logs
}

export async function loadSameRepoMessageLogsProgressive(
  worktreePaths: string[],
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<SessionLogResult> {
  logForDebugging(
    `/resume: loading sessions for cwd=${getOriginalCwd()}, worktrees=[${worktreePaths.join(', ')}]`,
  )
  const allStatLogs = await getStatOnlyLogsForWorktrees(worktreePaths, limit)
  logForDebugging(`/resume: found ${allStatLogs.length} session files on disk`)

  const { logs, nextIndex } = await enrichLogs(
    allStatLogs,
    0,
    initialEnrichCount,
  )

  // enrichLogs 返回的是新对象，可以安全地就地设置展示索引。
  logs.forEach((log, i) => {
    log.value = i
  })
  return { logs, allStatLogs, nextIndex }
}

/**
 * 为一组 worktree 获取只含 stat 信息的日志列表，不读取 JSONL 内容。
 */
async function getStatOnlyLogsForWorktrees(
  worktreePaths: string[],
  limit?: number,
): Promise<LogOption[]> {
  const projectsDir = getProjectsDir()

  if (worktreePaths.length <= 1) {
    const cwd = getOriginalCwd()
    const projectDir = getProjectDir(cwd)
    return getSessionFilesLite(projectDir, undefined, cwd)
  }

  // Windows 上 git worktree 输出的盘符大小写可能和项目目录中保存的不一致，
  // 例如 C:/Users/... 与 c:/Users/...；因此 Windows 下做大小写不敏感匹配。
  const caseInsensitive = process.platform === 'win32'

  // 按清洗后的前缀长度从长到短匹配，让更具体的 worktree 路径优先。
  // 否则 -code-myrepo 这类短前缀可能先匹配到 -code-myrepo-worktree1，
  // 导致对应 session 被归到错误 worktree。
  const indexed = worktreePaths.map(wt => {
    const sanitized = sanitizePath(wt)
    return {
      path: wt,
      prefix: caseInsensitive ? sanitized.toLowerCase() : sanitized,
    }
  })
  indexed.sort((a, b) => b.prefix.length - a.prefix.length)

  const allLogs: LogOption[] = []
  const seenDirs = new Set<string>()

  let allDirents: Dirent[]
  try {
    allDirents = await readdir(projectsDir, { withFileTypes: true })
  } catch (e) {
    // 项目目录不可读时退回当前 project，保证 /resume 至少可用。
    logForDebugging(
      `Failed to read projects dir ${projectsDir}, falling back to current project: ${e}`,
    )
    const projectDir = getProjectDir(getOriginalCwd())
    return getSessionFilesLite(projectDir, limit, getOriginalCwd())
  }

  for (const dirent of allDirents) {
    if (!dirent.isDirectory()) continue
    const dirName = caseInsensitive ? dirent.name.toLowerCase() : dirent.name
    if (seenDirs.has(dirName)) continue

    for (const { path: wtPath, prefix } of indexed) {
      if (dirName === prefix || dirName.startsWith(prefix + '-')) {
        seenDirs.add(dirName)
        allLogs.push(
          ...(await getSessionFilesLite(
            join(projectsDir, dirent.name),
            undefined,
            wtPath,
          )),
        )
        break
      }
    }
  }

  // 同一个 session 可能出现在多个 worktree projectDir；保留 mtime 最新的一份。
  return deduplicateLogsBySessionId(allLogs)
}

/**
 * 按 agentId 读取指定 subagent 的 transcript。
 * 这里直接加载 agent 专属 JSONL 文件，再从其中恢复该 agent 的最新对话链。
 * @param agentId 要查找的 agent ID。
 * @returns 该 agent 的消息链和预算替换记录；找不到或文件不可读时返回 null。
 */
export async function getAgentTranscript(agentId: AgentId): Promise<{
  messages: Message[]
  contentReplacements: ContentReplacementRecord[]
} | null> {
  const agentFile = getAgentTranscriptPath(agentId)

  try {
    const { messages, agentContentReplacements } =
      await loadTranscriptFile(agentFile)

    // 只取该 agentId 的 sidechain 消息，避免混入主线程或其他 agent。
    const agentMessages = Array.from(messages.values()).filter(
      msg => msg.agentId === agentId && msg.isSidechain,
    )

    if (agentMessages.length === 0) {
      return null
    }

    // 找到该 agent 最新的 leaf，作为恢复对话链的锚点。
    const parentUuids = new Set(agentMessages.map(msg => msg.parentUuid))
    const leafMessage = findLatestMessage(
      agentMessages,
      msg => !parentUuids.has(msg.uuid),
    )

    if (!leafMessage) {
      return null
    }

    // 沿 parentUuid 构造完整对话链。
    const transcript = buildConversationChain(messages, leafMessage)

    // buildConversationChain 可能包含继承的父消息；这里再收窄到目标 agent。
    const agentTranscript = transcript.filter(msg => msg.agentId === agentId)

    return {
      // 对外返回普通 Message，去掉 transcript 专用字段。
      messages: agentTranscript.map(
        ({ isSidechain, parentUuid, ...msg }) => msg,
      ),
      contentReplacements: agentContentReplacements.get(agentId) ?? [],
    }
  } catch {
    return null
  }
}

/**
 * 从对话里的 progress 消息提取 agentId。
 * 同步 agent/skill 在执行时会发出 progress 消息，data.type 为
 * agent_progress 或 skill_progress，真实 agentId 存在 data.agentId 中。
 */
export function extractAgentIdsFromMessages(messages: Message[]): string[] {
  const agentIds: string[] = []

  for (const message of messages) {
    if (
      message.type === 'progress' &&
      message.data &&
      typeof message.data === 'object' &&
      'type' in message.data &&
      (message.data.type === 'agent_progress' ||
        message.data.type === 'skill_progress') &&
      'agentId' in message.data &&
      typeof message.data.agentId === 'string'
    ) {
      agentIds.push(message.data.agentId)
    }
  }

  return uniq(agentIds)
}

/**
 * 直接从 AppState tasks 中提取 teammate transcript。
 * in-process teammate 的消息保存在 task.messages；由于每轮 teammate
 * 写盘时可能使用随机 agentId，从内存任务读取比按文件查找更可靠。
 */
export function extractTeammateTranscriptsFromTasks(tasks: {
  [taskId: string]: {
    type: string
    identity?: { agentId: string }
    messages?: Message[]
  }
}): { [agentId: string]: Message[] } {
  const transcripts: { [agentId: string]: Message[] } = {}

  for (const task of Object.values(tasks)) {
    if (
      task.type === 'in_process_teammate' &&
      task.identity?.agentId &&
      task.messages &&
      task.messages.length > 0
    ) {
      transcripts[task.identity.agentId] = task.messages
    }
  }

  return transcripts
}

/**
 * 批量加载指定 agentId 对应的 subagent transcript。
 */
export async function loadSubagentTranscripts(
  agentIds: string[],
): Promise<{ [agentId: string]: Message[] }> {
  const results = await Promise.all(
    agentIds.map(async agentId => {
      try {
        const result = await getAgentTranscript(asAgentId(agentId))
        if (result && result.messages.length > 0) {
          return { agentId, transcript: result.messages }
        }
        return null
      } catch {
        // 单个 transcript 读取失败不影响其他 agent 恢复。
        return null
      }
    }),
  )

  const transcripts: { [agentId: string]: Message[] } = {}
  for (const result of results) {
    if (result) {
      transcripts[result.agentId] = result.transcript
    }
  }
  return transcripts
}

// 直接扫描当前 session 的 subagents 目录；和 AppState.tasks 不同，任务被驱逐后仍能恢复。
export async function loadAllSubagentTranscriptsFromDisk(): Promise<{
  [agentId: string]: Message[]
}> {
  const subagentsDir = join(
    getSessionProjectDir() ?? getProjectDir(getOriginalCwd()),
    getSessionId(),
    'subagents',
  )
  let entries: Dirent[]
  try {
    entries = await readdir(subagentsDir, { withFileTypes: true })
  } catch {
    return {}
  }
  // 文件名解析规则必须和 getAgentTranscriptPath() 的生成规则保持互逆。
  const agentIds = entries
    .filter(
      d =>
        d.isFile() && d.name.startsWith('agent-') && d.name.endsWith('.jsonl'),
    )
    .map(d => d.name.slice('agent-'.length, -'.jsonl'.length))
  return loadSubagentTranscripts(agentIds)
}

// 导出给 useLogMessages 同步计算最后一个可记录消息 UUID，
// 避免等待 recordTranscript 返回造成 parentUuid hint 竞争。
export function isLoggableMessage(m: Message): boolean {
  if (m.type === 'progress') return false
  // 非 ant 用户的多数 attachment 会被过滤，因为其中可能含有不应进入公共训练数据的敏感信息。
  // 显式开启时允许 hook_additional_context，因为它是用户配置的 hook 输出，
  // 对 resume 时恢复上下文有价值。
  if (m.type === 'attachment' && getUserType() !== 'ant') {
    if (
      m.attachment.type === 'hook_additional_context' &&
      isEnvTruthy(process.env.CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT)
    ) {
      return true
    }
    return false
  }
  return true
}

function collectReplIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>()
  for (const m of messages) {
    if (m.type === 'assistant' && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (b.type === 'tool_use' && b.name === REPL_TOOL_NAME) {
          ids.add(b.id)
        }
      }
    }
  }
  return ids
}

/**
 * 对外部用户隐藏持久化 transcript 中的 REPL 包装层：
 * 移除 REPL tool_use/tool_result，并把 isVirtual 消息提升为真实消息。
 * 这样 --resume 时模型看到的是连续的原生工具调用历史，例如 assistant 调 Bash、
 * 收到结果、再调 Read，而不是额外套一层 REPL。ant 用户保留包装层，
 * 便于 /share 训练数据反映 REPL 使用情况。
 *
 * replIds 必须从完整 session 数组预收集，而不是只看当前转换的增量 slice。
 * recordTranscript 接收的是增量消息：REPL tool_use 可能在前一次 render，
 * 对应 tool_result 可能在异步执行后的下一次 render。若每次临时建 Set，
 * 会漏掉旧 id，最终把孤立 tool_result 写到磁盘。
 */
function transformMessagesForExternalTranscript(
  messages: Transcript,
  replIds: Set<string>,
): Transcript {
  return messages.flatMap(m => {
    if (m.type === 'assistant' && Array.isArray(m.message.content)) {
      const content = m.message.content
      const hasRepl = content.some(
        b => b.type === 'tool_use' && b.name === REPL_TOOL_NAME,
      )
      const filtered = hasRepl
        ? content.filter(
            b => !(b.type === 'tool_use' && b.name === REPL_TOOL_NAME),
          )
        : content
      if (filtered.length === 0) return []
      if (m.isVirtual) {
        const { isVirtual: _omit, ...rest } = m
        return [{ ...rest, message: { ...m.message, content: filtered } }]
      }
      if (filtered !== content) {
        return [{ ...m, message: { ...m.message, content: filtered } }]
      }
      return [m]
    }
    if (m.type === 'user' && Array.isArray(m.message.content)) {
      const content = m.message.content
      const hasRepl = content.some(
        b => b.type === 'tool_result' && replIds.has(b.tool_use_id),
      )
      const filtered = hasRepl
        ? content.filter(
            b => !(b.type === 'tool_result' && replIds.has(b.tool_use_id)),
          )
        : content
      if (filtered.length === 0) return []
      if (m.isVirtual) {
        const { isVirtual: _omit, ...rest } = m
        return [{ ...rest, message: { ...m.message, content: filtered } }]
      }
      if (filtered !== content) {
        return [{ ...m, message: { ...m.message, content: filtered } }]
      }
      return [m]
    }
    // 字符串 content 的 user、system、attachment 只需要去掉 isVirtual 标记。
    if ('isVirtual' in m && m.isVirtual) {
      const { isVirtual: _omit, ...rest } = m
      return [rest]
    }
    return [m]
  }) as Transcript
}

export function cleanMessagesForLogging(
  messages: Message[],
  allMessages: readonly Message[] = messages,
): Transcript {
  const filtered = messages.filter(isLoggableMessage) as Transcript
  return getUserType() !== 'ant'
    ? transformMessagesForExternalTranscript(
        filtered,
        collectReplIds(allMessages),
      )
    : filtered
}

/**
 * 按 /resume 列表中的索引获取日志。
 * @param index 已排序日志列表中的 0 基索引。
 * @returns 对应日志；索引不存在时返回 null。
 */
export async function getLogByIndex(index: number): Promise<LogOption | null> {
  const logs = await loadMessageLogs()
  return logs[index] || null
}

/**
 * 根据 tool_use_id 查找尚未收到 tool_result 的工具调用。
 * 如果找到对应 assistant tool_use 且 transcript 中还没有匹配的 tool_result，
 * 返回该 assistant 消息；否则返回 null。
 */
export async function findUnresolvedToolUse(
  toolUseId: string,
): Promise<AssistantMessage | null> {
  try {
    const transcriptPath = getTranscriptPath()
    const { messages } = await loadTranscriptFile(transcriptPath)

    let toolUseMessage = null

    // 先找 tool_use，同时确认后续没有同 id 的 tool_result。
    for (const message of messages.values()) {
      if (message.type === 'assistant') {
        const content = message.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use' && block.id === toolUseId) {
              toolUseMessage = message
              break
            }
          }
        }
      } else if (message.type === 'user') {
        const content = message.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block.type === 'tool_result' &&
              block.tool_use_id === toolUseId
            ) {
              // 已有工具结果，说明调用已闭合，不再返回 unresolved tool_use。
              return null
            }
          }
        }
      }
    }

    return toolUseMessage
  } catch {
    return null
  }
}

/**
 * 获取项目目录下所有 session JSONL 文件及其 stat 信息。
 * 返回 sessionId → {path, mtime, ctime, size} 的映射。
 * stat 通过 Promise.all 批量执行，避免 /resume 热路径串行系统调用。
 */
export async function getSessionFilesWithMtime(
  projectDir: string,
): Promise<
  Map<string, { path: string; mtime: number; ctime: number; size: number }>
> {
  const sessionFilesMap = new Map<
    string,
    { path: string; mtime: number; ctime: number; size: number }
  >()

  let dirents: Dirent[]
  try {
    dirents = await readdir(projectDir, { withFileTypes: true })
  } catch {
    // 目录不存在时视为没有 session 文件。
    return sessionFilesMap
  }

  const candidates: Array<{ sessionId: string; filePath: string }> = []
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.jsonl')) continue
    const sessionId = validateUuid(basename(dirent.name, '.jsonl'))
    if (!sessionId) continue
    candidates.push({ sessionId, filePath: join(projectDir, dirent.name) })
  }

  await Promise.all(
    candidates.map(async ({ sessionId, filePath }) => {
      try {
        const st = await stat(filePath)
        sessionFilesMap.set(sessionId, {
          path: filePath,
          mtime: st.mtime.getTime(),
          ctime: st.birthtime.getTime(),
          size: st.size,
        })
      } catch {
        logForDebugging(`Failed to stat session file: ${filePath}`)
      }
    }),
  )

  return sessionFilesMap
}

/**
 * /resume picker 首次打开时补全 metadata 的 session 数量。
 * 每个 session 最多读取 128KB（head + tail），50 个约 6.4MB I/O；
 * 现代文件系统上足够快，同时比旧的 10 个默认值能展示更多可识别信息。
 */
const INITIAL_ENRICH_COUNT = 50

type LiteMetadata = {
  firstPrompt: string
  gitBranch?: string
  isSidechain: boolean
  projectPath?: string
  teamName?: string
  customTitle?: string
  summary?: string
  tag?: string
  agentSetting?: string
  prNumber?: number
  prUrl?: string
  prRepository?: string
}

/**
 * 从单个 session 文件完整加载消息数据。
 * 文件里每个 leaf 对应一个可恢复分支，因此为每个 leaf 构造一个 LogOption。
 */
export async function loadAllLogsFromSessionFile(
  sessionFile: string,
  projectPathOverride?: string,
): Promise<LogOption[]> {
  const {
    messages,
    summaries,
    customTitles,
    tags,
    agentNames,
    agentColors,
    agentSettings,
    prNumbers,
    prUrls,
    prRepositories,
    modes,
    fileHistorySnapshots,
    attributionSnapshots,
    contentReplacements,
    leafUuids,
  } = await loadTranscriptFile(sessionFile, { keepAllLeaves: true })

  if (messages.size === 0) return []

  const leafMessages: TranscriptMessage[] = []
  // 先建立 parentUuid → children 索引，后续为每个 leaf 查尾随消息时就是 O(1)。
  const childrenByParent = new Map<UUID, TranscriptMessage[]>()
  for (const msg of messages.values()) {
    if (leafUuids.has(msg.uuid)) {
      leafMessages.push(msg)
    } else if (msg.parentUuid) {
      const siblings = childrenByParent.get(msg.parentUuid)
      if (siblings) {
        siblings.push(msg)
      } else {
        childrenByParent.set(msg.parentUuid, [msg])
      }
    }
  }

  const logs: LogOption[] = []

  for (const leafMessage of leafMessages) {
    const chain = buildConversationChain(messages, leafMessage)
    if (chain.length === 0) continue

    // 把 leaf 之后直接挂在它下面的尾随消息一起带上，例如 system/metadata 辅助消息。
    const trailingMessages = childrenByParent.get(leafMessage.uuid)
    if (trailingMessages) {
      // ISO-8601 UTC 时间戳可以按字符串顺序排序。
      trailingMessages.sort((a, b) =>
        a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
      )
      chain.push(...trailingMessages)
    }

    const firstMessage = chain[0]!
    const sessionId = leafMessage.sessionId as UUID

    logs.push({
      date: leafMessage.timestamp,
      messages: removeExtraFields(chain),
      fullPath: sessionFile,
      value: 0,
      created: new Date(firstMessage.timestamp),
      modified: new Date(leafMessage.timestamp),
      firstPrompt: extractFirstPrompt(chain),
      messageCount: countVisibleMessages(chain),
      isSidechain: firstMessage.isSidechain ?? false,
      sessionId,
      leafUuid: leafMessage.uuid,
      summary: summaries.get(leafMessage.uuid),
      customTitle: customTitles.get(sessionId),
      tag: tags.get(sessionId),
      agentName: agentNames.get(sessionId),
      agentColor: agentColors.get(sessionId),
      agentSetting: agentSettings.get(sessionId),
      mode: modes.get(sessionId) as LogOption['mode'],
      prNumber: prNumbers.get(sessionId),
      prUrl: prUrls.get(sessionId),
      prRepository: prRepositories.get(sessionId),
      gitBranch: leafMessage.gitBranch,
      projectPath: projectPathOverride ?? firstMessage.cwd,
      fileHistorySnapshots: buildFileHistorySnapshotChain(
        fileHistorySnapshots,
        chain,
      ),
      attributionSnapshots: buildAttributionSnapshotChain(
        attributionSnapshots,
        chain,
      ),
      contentReplacements: contentReplacements.get(sessionId) ?? [],
    })
  }

  return logs
}

/**
 * 绕过 session 索引，完整读取所有 session 文件来生成日志。
 * 适用于 /insights 这类需要完整消息数据的分析场景。

 */
async function getLogsWithoutIndex(
  projectDir: string,
  limit?: number,
): Promise<LogOption[]> {
  const sessionFilesMap = await getSessionFilesWithMtime(projectDir)
  if (sessionFilesMap.size === 0) return []

  // 如果设置了 limit，只处理 mtime 最新的 N 个文件。
  let filesToProcess: Array<{ path: string; mtime: number }>
  if (limit && sessionFilesMap.size > limit) {
    filesToProcess = [...sessionFilesMap.values()]
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
  } else {
    filesToProcess = [...sessionFilesMap.values()]
  }

  const logs: LogOption[] = []
  for (const fileInfo of filesToProcess) {
    try {
      const fileLogOptions = await loadAllLogsFromSessionFile(fileInfo.path)
      logs.push(...fileLogOptions)
    } catch {
      logForDebugging(`Failed to load session file: ${fileInfo.path}`)
    }
  }

  return logs
}

/**
 * 读取 JSONL 文件开头和结尾各约 64KB，提取 /resume 列表所需的轻量 metadata。
 *
 * 文件头用于判断 isSidechain、projectPath、teamName、firstPrompt。
 * 文件尾用于读取 customTitle、tag、PR 链接和最新 gitBranch。
 *
 * buf 由调用方复用，避免为每个文件重复分配读取缓冲区。
 */
async function readLiteMetadata(
  filePath: string,
  fileSize: number,
  buf: Buffer,
): Promise<LiteMetadata> {
  const { head, tail } = await readHeadAndTail(filePath, fileSize, buf)
  if (!head) return { firstPrompt: '', isSidechain: false }

  // 通过字符串搜索从首行提取稳定字段；即使首条消息超过 64KB 被截断也能工作。
  const isSidechain =
    head.includes('"isSidechain":true') || head.includes('"isSidechain": true')
  const projectPath = extractJsonStringField(head, 'cwd')
  const teamName = extractJsonStringField(head, 'teamName')
  const agentSetting = extractJsonStringField(head, 'agentSetting')

  // 优先使用尾部 last-prompt：它在写入时由 extractFirstPrompt 生成，已经过滤过，
  // 更能代表用户最近在做什么。头部扫描用于兼容没有 last-prompt 的旧 session。
  // 直接抓 content/text 只是最后兜底，可覆盖 VS Code 中 <ide_selection> 等数组内容块。
  const firstPrompt =
    extractLastJsonStringField(tail, 'lastPrompt') ||
    extractFirstPromptFromChunk(head) ||
    extractJsonStringFieldPrefix(head, 'content', 200) ||
    extractJsonStringFieldPrefix(head, 'text', 200) ||
    ''

  // 从尾部按字符串提取 metadata，后写覆盖先写。
  // 用户标题 customTitle 优先于 AI 标题 aiTitle；字段名不同，
  // extractLastJsonStringField 可以自然区分两类来源。
  const customTitle =
    extractLastJsonStringField(tail, 'customTitle') ??
    extractLastJsonStringField(head, 'customTitle') ??
    extractLastJsonStringField(tail, 'aiTitle') ??
    extractLastJsonStringField(head, 'aiTitle')
  const summary = extractLastJsonStringField(tail, 'summary')
  const tag = extractLastJsonStringField(tail, 'tag')
  const gitBranch =
    extractLastJsonStringField(tail, 'gitBranch') ??
    extractJsonStringField(head, 'gitBranch')

  // PR 链接字段里 prNumber 可能是数字而非字符串，因此字符串和数字格式都尝试解析。
  const prUrl = extractLastJsonStringField(tail, 'prUrl')
  const prRepository = extractLastJsonStringField(tail, 'prRepository')
  let prNumber: number | undefined
  const prNumStr = extractLastJsonStringField(tail, 'prNumber')
  if (prNumStr) {
    prNumber = parseInt(prNumStr, 10) || undefined
  }
  if (!prNumber) {
    const prNumMatch = tail.lastIndexOf('"prNumber":')
    if (prNumMatch >= 0) {
      const afterColon = tail.slice(prNumMatch + 11, prNumMatch + 25)
      const num = parseInt(afterColon.trim(), 10)
      if (num > 0) prNumber = num
    }
  }

  return {
    firstPrompt,
    gitBranch,
    isSidechain,
    projectPath,
    teamName,
    customTitle,
    summary,
    tag,
    agentSetting,
    prNumber,
    prUrl,
    prRepository,
  }
}

/**
 * 在文本块中扫描第一条有意义的用户提示词。
 */
function extractFirstPromptFromChunk(chunk: string): string {
  let start = 0
  let hasTickMessages = false
  let firstCommandFallback = ''
  while (start < chunk.length) {
    const newlineIdx = chunk.indexOf('\n', start)
    const line =
      newlineIdx >= 0 ? chunk.slice(start, newlineIdx) : chunk.slice(start)
    start = newlineIdx >= 0 ? newlineIdx + 1 : chunk.length

    if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) {
      continue
    }
    if (line.includes('"tool_result"')) continue
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true'))
      continue

    try {
      const entry = jsonParse(line) as Record<string, unknown>
      if (entry.type !== 'user') continue

      const message = entry.message as Record<string, unknown> | undefined
      if (!message) continue

      const content = message.content
      // 收集 content 中所有文本块。VS Code 场景下 IDE metadata 标签经常排在
      // 用户真实提示词前面，所以数组内容要逐块检查，避免被 <ide_selection>、
      // <ide_opened_file> 这类上下文块挡住真正的提示词。
      const texts: string[] = []
      if (typeof content === 'string') {
        texts.push(content)
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>
          if (b.type === 'text' && typeof b.text === 'string') {
            texts.push(b.text as string)
          }
        }
      }

      for (const text of texts) {
        if (!text) continue

        let result = text.replace(/\n/g, ' ').trim()

        // 跳过 slash command，但记住第一条作为兜底标题。
        // 过滤逻辑与 getFirstMeaningfulUserMessageTextContent 保持一致；
        // 不同之处是这里不会完全丢弃命令，而是格式化成 /clear 这类干净标题，
        // 让 session 仍能出现在 /resume picker 中。
        const commandNameTag = extractTag(result, COMMAND_NAME_TAG)
        if (commandNameTag) {
          const name = commandNameTag.replace(/^\//, '')
          const commandArgs = extractTag(result, 'command-args')?.trim() || ''
          if (builtInCommandNames().has(name) || !commandArgs) {
            if (!firstCommandFallback) {
              firstCommandFallback = commandNameTag
            }
            continue
          }
          // 自定义命令带有效参数时，用命令名和参数作为可读标题。
          return commandArgs
            ? `${commandNameTag} ${commandArgs}`
            : commandNameTag
        }

        // bash-input 要在通用 XML 过滤前处理，并用 ! 前缀展示成命令形式。
        const bashInput = extractTag(result, 'bash-input')
        if (bashInput) return `! ${bashInput}`

        if (SKIP_FIRST_PROMPT_PATTERN.test(result)) {
          if (
            (feature('PROACTIVE') || feature('KAIROS')) &&
            result.startsWith(`<${TICK_TAG}>`)
          )
            hasTickMessages = true
          continue
        }
        if (result.length > 200) {
          result = result.slice(0, 200).trim() + '…'
        }
        return result
      }
    } catch {
      continue
    }
  }
  // session 只执行了 slash command 而没有后续真实消息时，用命令名作为兜底标题。
  if (firstCommandFallback) return firstCommandFallback
  // proactive session 可能只有 tick 消息，给一个合成提示词避免被 enrichLogs 过滤掉。
  if ((feature('PROACTIVE') || feature('KAIROS')) && hasTickMessages)
    return 'Proactive session'
  return ''
}

/**
 * 类似 extractJsonStringField，但即使 buffer 被截断、字符串没有闭合引号，
 * 也会返回字段值前 maxLen 个字符。换行和制表转义会替换为空格并 trim。
 */
function extractJsonStringFieldPrefix(
  text: string,
  key: string,
  maxLen: number,
): string {
  const patterns = [`"${key}":"`, `"${key}": "`]
  for (const pattern of patterns) {
    const idx = text.indexOf(pattern)
    if (idx < 0) continue

    const valueStart = idx + pattern.length
    // 从字段值起点最多截取 maxLen 个字符，遇到闭合引号提前停止。
    let i = valueStart
    let collected = 0
    while (i < text.length && collected < maxLen) {
      if (text[i] === '\\') {
        i += 2 // 跳过转义字符，按一个展示字符计数。
        collected++
        continue
      }
      if (text[i] === '"') break
      i++
      collected++
    }
    const raw = text.slice(valueStart, i)
    return raw.replace(/\\n/g, ' ').replace(/\\t/g, ' ').trim()
  }
  return ''
}

/**
 * 按 sessionId 去重日志，保留 modified 最新的一条。
 * 返回值会重新按时间排序，并分配连续的 value 索引。
 */
function deduplicateLogsBySessionId(logs: LogOption[]): LogOption[] {
  const deduped = new Map<string, LogOption>()
  for (const log of logs) {
    if (!log.sessionId) continue
    const existing = deduped.get(log.sessionId)
    if (!existing || log.modified.getTime() > existing.modified.getTime()) {
      deduped.set(log.sessionId, log)
    }
  }
  return sortLogs([...deduped.values()]).map((log, i) => ({
    ...log,
    value: i,
  }))
}

/**
 * 只基于文件系统 stat 信息生成轻量 LogOption[]。
 * 这里不读取 JSONL 内容，速度接近目录扫描；需要 firstPrompt、gitBranch、
 * customTitle 等展示字段时再调用 enrichLogs 渐进补全。
 */
export async function getSessionFilesLite(
  projectDir: string,
  limit?: number,
  projectPath?: string,
): Promise<LogOption[]> {
  const sessionFilesMap = await getSessionFilesWithMtime(projectDir)

  // 按 mtime 倒序排列，并在需要时截断到 limit。
  let entries = [...sessionFilesMap.entries()].sort(
    (a, b) => b[1].mtime - a[1].mtime,
  )
  if (limit && entries.length > limit) {
    entries = entries.slice(0, limit)
  }

  const logs: LogOption[] = []

  for (const [sessionId, fileInfo] of entries) {
    logs.push({
      date: new Date(fileInfo.mtime).toISOString(),
      messages: [],
      isLite: true,
      fullPath: fileInfo.path,
      value: 0,
      created: new Date(fileInfo.ctime),
      modified: new Date(fileInfo.mtime),
      firstPrompt: '',
      messageCount: 0,
      fileSize: fileInfo.size,
      isSidechain: false,
      sessionId,
      projectPath,
    })
  }

  // logs 都是在上面新建的对象，可以就地重编号。
  const sorted = sortLogs(logs)
  sorted.forEach((log, i) => {
    log.value = i
  })
  return sorted
}

/**
 * 读取 JSONL 头尾信息，为轻量日志补全 metadata。
 * 如果补全后仍没有可展示内容（例如只有 metadata、没有 firstPrompt/customTitle），
 * 或者属于 sidechain/agent session，则返回 null 表示不在 /resume 中展示。
 */
async function enrichLog(
  log: LogOption,
  readBuf: Buffer,
): Promise<LogOption | null> {
  if (!log.isLite || !log.fullPath) return log

  const meta = await readLiteMetadata(log.fullPath, log.fileSize ?? 0, readBuf)

  const enriched: LogOption = {
    ...log,
    isLite: false,
    firstPrompt: meta.firstPrompt,
    gitBranch: meta.gitBranch,
    isSidechain: meta.isSidechain,
    teamName: meta.teamName,
    customTitle: meta.customTitle,
    summary: meta.summary,
    tag: meta.tag,
    agentSetting: meta.agentSetting,
    prNumber: meta.prNumber,
    prUrl: meta.prUrl,
    prRepository: meta.prRepository,
    projectPath: meta.projectPath ?? log.projectPath,
  }

  // 对无法提取首条提示词的 session 给兜底标题，例如首条消息过大超出读取窗口。
  // 旧逻辑会静默丢弃这类 session，导致崩溃后或大上下文场景下无法通过 /resume 找回。
  if (!enriched.firstPrompt && !enriched.customTitle) {
    enriched.firstPrompt = '(session)'
  }
  // /resume 只展示主线程 session，跳过 sidechain 和 agent session。
  if (enriched.isSidechain) {
    logForDebugging(
      `Session ${log.sessionId} filtered from /resume: isSidechain=true`,
    )
    return null
  }
  if (enriched.teamName) {
    logForDebugging(
      `Session ${log.sessionId} filtered from /resume: teamName=${enriched.teamName}`,
    )
    return null
  }

  return enriched
}

/**
 * 从 allLogs[startIndex] 开始渐进补全轻量日志，直到得到 count 条可展示结果。
 * 返回补全后的日志，以及下一次继续扫描的位置。
 */
export async function enrichLogs(
  allLogs: LogOption[],
  startIndex: number,
  count: number,
): Promise<{ logs: LogOption[]; nextIndex: number }> {
  const result: LogOption[] = []
  const readBuf = Buffer.alloc(LITE_READ_BUF_SIZE)
  let i = startIndex

  while (i < allLogs.length && result.length < count) {
    const log = allLogs[i]!
    i++

    const enriched = await enrichLog(log, readBuf)
    if (enriched) {
      result.push(enriched)
    }
  }

  const scanned = i - startIndex
  const filtered = scanned - result.length
  if (filtered > 0) {
    logForDebugging(
      `/resume: enriched ${scanned} sessions, ${filtered} filtered out, ${result.length} visible (${allLogs.length - i} remaining on disk)`,
    )
  }

  return { logs: result, nextIndex: i }
}
