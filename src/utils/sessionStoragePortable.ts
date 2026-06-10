/**
 * Session 存储的可移植工具层。
 *
 * 1. 这份代码同时服务 CLI 和 VS Code 扩展，不能绑定 CLI 专属状态。
 * 2. 对外暴露的能力集中在 session 文件发现、轻量元数据读取和大 transcript 恢复加载。
 */

import type { UUID } from 'crypto'
import { open as fsOpen, readdir, realpath, stat } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { getWorktreePathsPortable } from './getWorktreePathsPortable.js'
import { djb2Hash } from './hash.js'

/** Session 列表只需要少量头尾信息，64KB 可以覆盖首条提示词和尾部标题等常见元数据。 */
export const LITE_READ_BUF_SIZE = 65536

// ---------------------------------------------------------------------------
// Session ID 校验
// ---------------------------------------------------------------------------

// Session 文件以 UUID 命名；这里先做格式门禁，后续再判断磁盘文件是否存在。
const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 判断输入是否可以作为 sessionId 使用。
 *
 * 1. 非 UUID 字符串不继续进入文件定位流程，避免把任意用户输入拼成磁盘路径。
 */
export function validateUuid(maybeUuid: unknown): UUID | null {
  if (typeof maybeUuid !== 'string') return null
  return uuidRegex.test(maybeUuid) ? (maybeUuid as UUID) : null
}

// ---------------------------------------------------------------------------
// JSONL 片段字段提取
// ---------------------------------------------------------------------------

/**
 * 还原从 JSON 字符串字段中截取出的文本。
 *
 * 1. 轻量扫描可能拿到的是文件片段而不是完整 JSON。
 * 2. 解析失败时保留原文，比中断 session 列表更合适。
 */
export function unescapeJsonString(raw: string): string {
  // 1. 常见字段没有转义字符，直接返回可以减少 session 列表批量扫描时的分配。
  if (!raw.includes('\\')) return raw
  try {
    // 2. 复用 JSON.parse 处理标准转义，避免维护一套容易遗漏边界的手写反转义规则。
    return JSON.parse(`"${raw}"`)
  } catch {
    // 3. 文件头尾片段可能截断在转义序列中；列表展示宁可降级显示原文。
    return raw
  }
}

/**
 * 从 JSONL 文本片段中读取第一次出现的字符串字段。
 *
 * 1. 用于读取较早写入的元数据或消息字段。
 * 2. 只做局部扫描，适合处理不完整片段。
 */
export function extractJsonStringField(
  text: string,
  key: string,
): string | undefined {
  // 1. 历史 session 中同时存在紧凑 JSON 和带空格 JSON，两个格式都要兼容。
  const patterns = [`"${key}":"`, `"${key}": "`]
  for (const pattern of patterns) {
    const idx = text.indexOf(pattern)
    if (idx < 0) continue

    // 2. JSONL 可能很长，局部扫描比整行解析更适合列表元数据读取。
    const valueStart = idx + pattern.length
    let i = valueStart
    while (i < text.length) {
      if (text[i] === '\\') {
        // 3. 转义引号仍属于字段内容，不能当作字段结束。
        i += 2
        continue
      }
      if (text[i] === '"') {
        return unescapeJsonString(text.slice(valueStart, i))
      }
      i++
    }
  }
  return undefined
}

/**
 * 从 JSONL 文本片段中读取最后一次出现的字符串字段。
 *
 * 1. 标题、标签等字段可能在会话后期被追加覆盖。
 * 2. 列表展示应优先使用最新值。
 */
export function extractLastJsonStringField(
  text: string,
  key: string,
): string | undefined {
  // 1. 同一个字段可能有多次记录，保留最后一次能更贴近当前会话状态。
  const patterns = [`"${key}":"`, `"${key}": "`]
  let lastValue: string | undefined
  for (const pattern of patterns) {
    let searchFrom = 0
    while (true) {
      const idx = text.indexOf(pattern, searchFrom)
      if (idx < 0) break

      const valueStart = idx + pattern.length
      let i = valueStart
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        if (text[i] === '"') {
          lastValue = unescapeJsonString(text.slice(valueStart, i))
          break
        }
        i++
      }
      searchFrom = i + 1
    }
  }
  return lastValue
}

// ---------------------------------------------------------------------------
// 从文件头部片段提取首条可展示的用户意图
// ---------------------------------------------------------------------------

/**
 * 1. 这些内容通常由系统、IDE 或 Hook 自动写入。
 * 2. 它们不适合作为会话列表标题。
 */
const SKIP_FIRST_PROMPT_PATTERN =
  /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

// Slash command 不算自然语言提示词；没有其它文本时，命令名仍可作为可读兜底标题。
const COMMAND_NAME_RE = /<command-name>(.*?)<\/command-name>/

/**
 * 从 session 开头提取适合展示给用户看的首条意图。
 *
 * 1. 会话文件开头可能混有工具结果、IDE 上下文和压缩摘要。
 * 2. 列表标题应尽量取真实用户输入。
 */
export function extractFirstPromptFromHead(head: string): string {
  let start = 0
  let commandFallback = ''
  while (start < head.length) {
    // 1. 头部片段可能不是完整文件，只能按 JSONL 行逐条尝试。
    const newlineIdx = head.indexOf('\n', start)
    const line =
      newlineIdx >= 0 ? head.slice(start, newlineIdx) : head.slice(start)
    start = newlineIdx >= 0 ? newlineIdx + 1 : head.length

    if (!line.includes('"type":"user"') && !line.includes('"type": "user"'))
      continue
    // 2. 这些 user 行由系统流程写入，不能代表用户最初想做什么。
    if (line.includes('"tool_result"')) continue
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true'))
      continue
    if (
      line.includes('"isCompactSummary":true') ||
      line.includes('"isCompactSummary": true')
    )
      continue

    try {
      // 3. 字符串预筛后再解析，可以降低大量 session 列表扫描时的 CPU 消耗。
      const entry = JSON.parse(line) as Record<string, unknown>
      if (entry.type !== 'user') continue

      const message = entry.message as Record<string, unknown> | undefined
      if (!message) continue

      const content = message.content
      const texts: string[] = []
      // 4. 历史格式和新版 block 格式都可能出现在本地 session 中。
      if (typeof content === 'string') {
        texts.push(content)
      } else if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text as string)
          }
        }
      }

      for (const raw of texts) {
        let result = raw.replace(/\n/g, ' ').trim()
        if (!result) continue

        // 5. 命令本身不是自然语言问题，但比空标题更有信息量。
        const cmdMatch = COMMAND_NAME_RE.exec(result)
        if (cmdMatch) {
          if (!commandFallback) commandFallback = cmdMatch[1]!
          continue
        }

        // 6. Bash 输入是明确的用户动作，用命令形式展示比保留 XML 标签更直观。
        const bashMatch = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(result)
        if (bashMatch) return `! ${bashMatch[1]!.trim()}`

        if (SKIP_FIRST_PROMPT_PATTERN.test(result)) continue

        // 7. 列表标题只需要概览，过长文本会挤压其它 session 信息。
        if (result.length > 200) {
          result = result.slice(0, 200).trim() + '\u2026'
        }
        return result
      }
    } catch {
      continue
    }
  }
  if (commandFallback) return commandFallback
  return ''
}

// ---------------------------------------------------------------------------
// 文件 I/O：为列表视图读取最小必要信息
// ---------------------------------------------------------------------------

/**
 * 读取 session 文件头尾片段。
 *
 * 1. 头部通常有首条用户输入，尾部通常有最近追加的标题和标签。
 * 2. 列表页不需要完整 transcript。
 */
export async function readHeadAndTail(
  filePath: string,
  fileSize: number,
  buf: Buffer,
): Promise<{ head: string; tail: string }> {
  try {
    const fh = await fsOpen(filePath, 'r')
    try {
      // 1. 空文件没有可展示的 session 信息，直接让上层按空元数据处理。
      const headResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, 0)
      if (headResult.bytesRead === 0) return { head: '', tail: '' }

      const head = buf.toString('utf8', 0, headResult.bytesRead)

      // 2. 小文件头部已经覆盖全部内容，不需要再做一次尾部读取。
      const tailOffset = Math.max(0, fileSize - LITE_READ_BUF_SIZE)
      let tail = head
      if (tailOffset > 0) {
        const tailResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, tailOffset)
        tail = buf.toString('utf8', 0, tailResult.bytesRead)
      }

      return { head, tail }
    } finally {
      // 3. 列表页可能并发读取大量 session，任何路径都要及时释放 fd。
      await fh.close()
    }
  } catch {
    return { head: '', tail: '' }
  }
}

/**
 * Session 列表视图需要的文件摘要。
 *
 * 1. 这里不包含完整消息内容。
 * 2. 这样可以避免打开列表时把所有历史会话都加载进内存。
 */
export type LiteSessionFile = {
  // 会话列表按最近活跃时间排序，直接使用文件修改时间。
  mtime: number
  // 文件大小既用于展示判断，也用于后续选择轻量读取或分块加载。
  size: number
  // 文件开头通常能提取首条用户意图。
  head: string
  // 文件末尾通常能提取最新标题、标签和最近消息信息。
  tail: string
}

/**
 * 读取单个 session 文件的列表摘要。
 *
 * 1. 文件可能被其它进程同时写入或删除。
 * 2. 读取失败时返回 null，让列表扫描继续处理其它文件。
 */
export async function readSessionLite(
  filePath: string,
): Promise<LiteSessionFile | null> {
  try {
    const fh = await fsOpen(filePath, 'r')
    try {
      // 1. stat 与内容读取共用同一个 fd，避免文件在两次打开之间发生变化。
      const stat = await fh.stat()
      const buf = Buffer.allocUnsafe(LITE_READ_BUF_SIZE)
      // 2. 空 JSONL 不具备恢复价值，也不应出现在可选 session 列表里。
      const headResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, 0)
      if (headResult.bytesRead === 0) return null

      const head = buf.toString('utf8', 0, headResult.bytesRead)
      // 3. 大文件才需要额外读取尾部，小文件复用 head 可减少 I/O。
      const tailOffset = Math.max(0, stat.size - LITE_READ_BUF_SIZE)
      let tail = head
      if (tailOffset > 0) {
        const tailResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, tailOffset)
        tail = buf.toString('utf8', 0, tailResult.bytesRead)
      }

      return { mtime: stat.mtime.getTime(), size: stat.size, head, tail }
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 项目路径到 session 目录名的映射
// ---------------------------------------------------------------------------

/**
 * 清洗后的目录名主体长度。
 *
 * 1. 常见文件系统对单个路径片段有长度限制。
 * 2. 这里预留空间给 hash 后缀，降低超长项目路径失败概率。
 */
export const MAX_SANITIZED_LENGTH = 200

/**
 * 为纯 Node 环境提供稳定短 hash。
 *
 * 1. CLI 运行时可能有 Bun.hash，扩展侧可能没有。
 * 2. 兜底 hash 保证两侧都能处理长路径。
 */
function simpleHash(str: string): string {
  return Math.abs(djb2Hash(str)).toString(36)
}

/**
 * 把项目路径转换成可落盘的目录名片段。
 *
 * 1. Windows 的盘符、分隔符和不同平台的保留字符都不能直接作为目录名使用。
 */
export function sanitizePath(name: string): string {
  // 1. 统一替换为连字符，让同一套 session 目录规则跨平台可用。
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized
  }
  // 2. 超长路径保留可读前缀，再追加 hash 区分不同项目。
  const hash =
    typeof Bun !== 'undefined' ? Bun.hash(name).toString(36) : simpleHash(name)
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}

// ---------------------------------------------------------------------------
// 项目 session 目录发现
// ---------------------------------------------------------------------------

/**
 * 获取所有项目 session 的根目录。
 *
 * 1. 当前实现沿用 Claude 配置目录结构。
 * 2. 这样便于复用已有历史 session。
 */
export function getProjectsDir(): string {
  return join(getClaudeConfigHomeDir(), 'projects')
}

/**
 * 根据项目路径计算该项目的 session 目录。
 *
 * 1. 每个项目目录下保存该项目的 JSONL 会话文件。
 */
export function getProjectDir(projectDir: string): string {
  return join(getProjectsDir(), sanitizePath(projectDir))
}

/**
 * 规范化项目路径，减少同一目录产生多个 session 目录的情况。
 *
 * 1. 符号链接、平台别名和 Unicode 组合形式差异都会影响目录名计算。
 */
export async function canonicalizePath(dir: string): Promise<string> {
  try {
    return (await realpath(dir)).normalize('NFC')
  } catch {
    // 1. 目录不可访问时仍保持可预测结果，调用方可以继续做 session 查找。
    return dir.normalize('NFC')
  }
}

/**
 * 查找项目实际使用的 session 目录。
 *
 * 1. 长路径 hash 可能因 Bun 和 Node 环境不同而不一致。
 * 2. 因此这里需要兼容已有目录。
 */
export async function findProjectDir(
  projectPath: string,
): Promise<string | undefined> {
  // 1. 大多数路径可以直接命中当前运行时计算出的目录名。
  const exact = getProjectDir(projectPath)
  try {
    await readdir(exact)
    return exact
  } catch {
    const sanitized = sanitizePath(projectPath)
    if (sanitized.length <= MAX_SANITIZED_LENGTH) {
      return undefined
    }
    // 2. 只有超长路径才存在 hash 后缀差异，按前缀回退查找可兼容历史数据。
    const prefix = sanitized.slice(0, MAX_SANITIZED_LENGTH)
    const projectsDir = getProjectsDir()
    try {
      // 3. 只看目录名，不读取 session 内容，避免 fallback 影响列表性能。
      const dirents = await readdir(projectsDir, { withFileTypes: true })
      const match = dirents.find(
        d => d.isDirectory() && d.name.startsWith(prefix + '-'),
      )
      return match ? join(projectsDir, match.name) : undefined
    } catch {
      return undefined
    }
  }
}

/**
 * 定位 sessionId 对应的 JSONL 文件。
 *
 * 1. 恢复会话时优先按当前项目查找；没有项目上下文时才扫描所有项目目录。
 * 2. 只返回非空文件，避免把创建失败或被截断的空 session 当成可恢复会话。
 */
export async function resolveSessionFilePath(
  sessionId: string,
  dir?: string,
): Promise<
  | { filePath: string; projectPath: string | undefined; fileSize: number }
  | undefined
> {
  // 1. 磁盘上的 session 文件名固定由 UUID 派生。
  const fileName = `${sessionId}.jsonl`

  if (dir) {
    // 2. 有项目上下文时优先命中当前项目，避免全局扫描带来的歧义。
    const canonical = await canonicalizePath(dir)
    const projectDir = await findProjectDir(canonical)
    if (projectDir) {
      const filePath = join(projectDir, fileName)
      try {
        const s = await stat(filePath)
        if (s.size > 0)
          return { filePath, projectPath: canonical, fileSize: s.size }
      } catch {
        // 3. 当前项目未命中时继续尝试 worktree；单点失败不应结束整个查找。
      }
    }
    // 4. 同一仓库的不同 worktree 可能共享用户想恢复的会话，需要额外兼容。
    let worktreePaths: string[]
    try {
      worktreePaths = await getWorktreePathsPortable(canonical)
    } catch {
      worktreePaths = []
    }
    for (const wt of worktreePaths) {
      if (wt === canonical) continue
      const wtProjectDir = await findProjectDir(wt)
      if (!wtProjectDir) continue
      const filePath = join(wtProjectDir, fileName)
      try {
        const s = await stat(filePath)
        if (s.size > 0) return { filePath, projectPath: wt, fileSize: s.size }
      } catch {
        // 5. 某个 worktree 没有目标文件很常见，继续看其它候选目录。
      }
    }
    return undefined
  }

  // 6. 没有项目上下文时，只能退化为全局扫描，主要用于只知道 sessionId 的恢复入口。
  const projectsDir = getProjectsDir()
  let dirents: string[]
  try {
    dirents = await readdir(projectsDir)
  } catch {
    return undefined
  }
  for (const name of dirents) {
    // 7. 直接 stat 目标文件比先判断目录再拼路径更少一次 I/O，失败即跳过。
    const filePath = join(projectsDir, name, fileName)
    try {
      const s = await stat(filePath)
      if (s.size > 0)
        return { filePath, projectPath: undefined, fileSize: s.size }
    } catch {
      // 8. 当前候选目录没有目标 session，继续扫描其它项目。
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Compact 后 transcript 的恢复读取
// ---------------------------------------------------------------------------

/** 大 transcript 采用 1MB 顺序读取，兼顾 I/O 次数、内存占用和跨行处理复杂度。 */
const TRANSCRIPT_READ_CHUNK_SIZE = 1024 * 1024

/**
 * 进入 compact 预处理的文件大小阈值。
 *
 * 1. 小 session 直接加载成本更低。
 * 2. 大 session 更可能经历过 compact，需要先剥离无效历史片段。
 */
export const SKIP_PRECOMPACT_THRESHOLD = 5 * 1024 * 1024

/** compact boundary marker 只在恢复大 transcript 时才需要，按需缓存即可。 */
let _compactBoundaryMarker: Buffer | undefined
/**
 * 获取 compact boundary 的字节 marker。
 *
 * 1. 扫描过程频繁使用该 marker，缓存能减少重复分配。
 */
function compactBoundaryMarker(): Buffer {
  return (_compactBoundaryMarker ??= Buffer.from('"compact_boundary"'))
}

/**
 * 判断某行是否为真正的 compact boundary。
 *
 * 1. 用户消息里也可能包含 compact_boundary 字样。
 * 2. 因此必须确认 JSONL 行的 type 和 subtype。
 */
function parseBoundaryLine(
  line: string,
): { hasPreservedSegment: boolean } | null {
  try {
    // 1. 只有 marker 命中的行才解析 JSON，避免大文件扫描时对每一行做高成本解析。
    const parsed = JSON.parse(line) as {
      type?: string
      subtype?: string
      compactMetadata?: { preservedSegment?: unknown }
    }
    if (parsed.type !== 'system' || parsed.subtype !== 'compact_boundary') {
      return null
    }
    return {
      hasPreservedSegment: Boolean(parsed.compactMetadata?.preservedSegment),
    }
  } catch {
    // 2. 损坏行或被截断行不能作为可靠边界，按普通内容处理。
    return null
  }
}

// 1. Resume 只需要 compact 后仍有效的 transcript。
// 2. 读取时会剥离中间 attribution snapshot、保留最后一条，并在 boundary 后重新累积输出。

/** 分块读取时的输出缓冲区，只保存最终要交给恢复流程的内容。 */
type Sink = {
  // 承载有效输出的 Buffer，容量不足时会替换为更大的 Buffer。
  buf: Buffer
  // buf 中已写入的有效字节长度。
  len: number
  // 防止异常扩容超过原始文件规模。
  cap: number
}

/**
 * 向恢复输出中追加一段字节。
 *
 * 1. 输出内容可能在 compact boundary 后重新开始累积。
 * 2. 因此这里集中封装容量增长逻辑。
 */
function sinkWrite(s: Sink, src: Buffer, start: number, end: number): void {
  const n = end - start
  if (n <= 0) return
  if (s.len + n > s.buf.length) {
    const grown = Buffer.allocUnsafe(
      Math.min(Math.max(s.buf.length * 2, s.len + n), s.cap),
    )
    s.buf.copy(grown, 0, 0, s.len)
    s.buf = grown
  }
  src.copy(s.buf, s.len, start, end)
  s.len += n
}

/**
 * 判断 buffer 某个位置是否命中特定 JSONL 行前缀。
 *
 * 1. 使用字节比较可以避免把大块 Buffer 频繁转成字符串。
 */
function hasPrefix(
  src: Buffer,
  prefix: Buffer,
  at: number,
  end: number,
): boolean {
  return (
    end - at >= prefix.length &&
    src.compare(prefix, 0, prefix.length, at, at + prefix.length) === 0
  )
}

// 中间 attribution snapshot 不参与恢复上下文，只保留最后一条。
const ATTR_SNAP_PREFIX = Buffer.from('{"type":"attribution-snapshot"')
// compact boundary 只会出现在 system 行里。
const SYSTEM_PREFIX = Buffer.from('{"type":"system"')
// JSONL 使用 LF 分隔消息行。
const LF = 0x0a
// 如果 transcript 崩溃截断在半行，追加 snapshot 前需要补齐行分隔。
const LF_BYTE = Buffer.from([LF])
// 只在行首附近识别 boundary，避免用户正文里的同名字符串触发误判。
const BOUNDARY_SEARCH_BOUND = 256

/**
 * 大 transcript 分块恢复时共享的扫描状态。
 *
 * 1. 状态同时跟踪有效输出、compact 边界、跨 chunk 半行和最后一条 attribution snapshot。
 */
type LoadState = {
  // 只包含恢复流程仍需要加载的 transcript 内容。
  out: Sink
  // 最近一次有效 compact boundary 在原始文件中的偏移。
  boundaryStartOffset: number
  // preservedSegment 表示 compact 已显式保留旧片段，不应再把前文清空。
  hasPreservedSegment: boolean
  // 最近一条 attribution snapshot，最终统一追加到输出末尾。
  lastSnapSrc: Buffer | null
  // lastSnapSrc 可能指向复用缓存，因此需要单独记录有效长度。
  lastSnapLen: number
  // snapshot 专用缓存，避免复用 chunk 后内容被下一轮读取覆盖。
  lastSnapBuf: Buffer | undefined
  // 当前扫描 buffer 的首字节在原文件中的偏移。
  bufFileOff: number
  // 上一轮留下的未闭合 JSONL 半行。
  carryLen: number
  carryBuf: Buffer | undefined
  // 跨 chunk snapshot 的前半段长度。
  straddleSnapCarryLen: number
  // 跨 chunk snapshot 在当前 chunk 中结束的位置。
  straddleSnapTailEnd: number
}

/**
 * 处理跨 chunk 的未闭合 JSONL 行。
 *
 * 1. 文件分块不等于消息分行。
 * 2. 跨块消息必须拼回完整行后才能判断是否是 snapshot 或 boundary。
 */
function processStraddle(
  s: LoadState,
  chunk: Buffer,
  bytesRead: number,
): number {
  s.straddleSnapCarryLen = 0
  s.straddleSnapTailEnd = 0
  if (s.carryLen === 0) return 0
  const cb = s.carryBuf!
  // 1. 只有遇到换行符，上一块遗留的半行才具备完整 JSONL 语义。
  const firstNl = chunk.indexOf(LF)
  if (firstNl === -1 || firstNl >= bytesRead) return 0
  const tailEnd = firstNl + 1
  // 2. snapshot 可能被切在两个 chunk 之间，仍然要按“只保留最后一条”的规则处理。
  if (hasPrefix(cb, ATTR_SNAP_PREFIX, 0, s.carryLen)) {
    s.straddleSnapCarryLen = s.carryLen
    s.straddleSnapTailEnd = tailEnd
    s.lastSnapSrc = null
  } else if (s.carryLen < ATTR_SNAP_PREFIX.length) {
    return 0 // 3. 半行太短时先交给后续拼接扫描，避免误把 snapshot 写入输出。
  } else {
    // 4. 跨块 system 行可能正好是 compact boundary，必须拼完整后再确认。
    if (hasPrefix(cb, SYSTEM_PREFIX, 0, s.carryLen)) {
      const hit = parseBoundaryLine(
        cb.toString('utf-8', 0, s.carryLen) +
          chunk.toString('utf-8', 0, firstNl),
      )
      if (hit?.hasPreservedSegment) {
        s.hasPreservedSegment = true
      } else if (hit) {
        // 5. 普通 boundary 表示此前上下文已被 compact 替代，恢复时应从这里重新开始。
        s.out.len = 0
        s.boundaryStartOffset = s.bufFileOff
        s.hasPreservedSegment = false
        s.lastSnapSrc = null
      }
    }
    // 6. 普通跨块消息仍是有效 transcript 内容，需要补回输出。
    sinkWrite(s.out, cb, 0, s.carryLen)
    sinkWrite(s.out, chunk, 0, tailEnd)
  }
  // 7. 已经消费掉上一块遗留内容，后续偏移从当前 chunk 的剩余部分继续计算。
  s.bufFileOff += s.carryLen + tailEnd
  s.carryLen = 0
  return tailEnd
}

/**
 * 扫描当前 buffer 中已经闭合的 JSONL 行。
 *
 * 1. 这里负责识别 compact boundary 和 attribution snapshot。
 * 2. 普通消息会被累积进恢复输出。
 */
function scanChunkLines(
  s: LoadState,
  buf: Buffer,
  boundaryMarker: Buffer,
): { lastSnapStart: number; lastSnapEnd: number; trailStart: number } {
  // 1. 先用字节搜索定位 boundary marker，避免每一行都 JSON.parse。
  let boundaryAt = buf.indexOf(boundaryMarker)
  let runStart = 0
  let lineStart = 0
  let lastSnapStart = -1
  let lastSnapEnd = -1
  let nl = buf.indexOf(LF)
  while (nl !== -1) {
    const lineEnd = nl + 1
    // 2. marker 可能位于后续行，扫描过程中需要持续推进候选位置。
    if (boundaryAt !== -1 && boundaryAt < lineStart) {
      boundaryAt = buf.indexOf(boundaryMarker, lineStart)
    }
    // 3. 中间 snapshot 不进入恢复上下文，但它之前的普通消息需要先落入输出。
    if (hasPrefix(buf, ATTR_SNAP_PREFIX, lineStart, lineEnd)) {
      sinkWrite(s.out, buf, runStart, lineStart)
      lastSnapStart = lineStart
      lastSnapEnd = lineEnd
      // 3.1 下一段普通消息从 snapshot 之后重新开始累计。
      runStart = lineEnd
    } else if (
      boundaryAt >= lineStart &&
      boundaryAt < Math.min(lineStart + BOUNDARY_SEARCH_BOUND, lineEnd)
    ) {
      // 4. 只有 marker 位于行首附近时才可能是系统 boundary，避免正文误判。
      const hit = parseBoundaryLine(buf.toString('utf-8', lineStart, nl))
      if (hit?.hasPreservedSegment) {
        s.hasPreservedSegment = true // 4.1 compact 已保留旧片段，不需要清空当前输出。
      } else if (hit) {
        // 5. 普通 boundary 之前的内容已经被 compact 取代，恢复输出从 boundary 行重新开始。
        s.out.len = 0
        s.boundaryStartOffset = s.bufFileOff + lineStart
        s.hasPreservedSegment = false
        s.lastSnapSrc = null
        lastSnapStart = -1
        s.straddleSnapCarryLen = 0
        runStart = lineStart
      }
      boundaryAt = buf.indexOf(
        boundaryMarker,
        boundaryAt + boundaryMarker.length,
      )
    }
    lineStart = lineEnd
    nl = buf.indexOf(LF, lineStart)
  }
  // 6. 末尾未闭合半行不能在这里判断，留给下一轮拼接。
  sinkWrite(s.out, buf, runStart, lineStart)
  return { lastSnapStart, lastSnapEnd, trailStart: lineStart }
}

/**
 * 保存当前已知的最后一条 attribution snapshot。
 *
 * 1. 恢复输出只需要最后一次 attribution 状态。
 * 2. 中间 snapshot 会被丢弃。
 */
function captureSnap(
  s: LoadState,
  buf: Buffer,
  chunk: Buffer,
  lastSnapStart: number,
  lastSnapEnd: number,
): void {
  if (lastSnapStart !== -1) {
    // 1. 当前 buffer 的 snapshot 晚于跨块候选，优先级更高。
    s.lastSnapLen = lastSnapEnd - lastSnapStart
    if (s.lastSnapBuf === undefined || s.lastSnapLen > s.lastSnapBuf.length) {
      s.lastSnapBuf = Buffer.allocUnsafe(s.lastSnapLen)
    }
    buf.copy(s.lastSnapBuf, 0, lastSnapStart, lastSnapEnd)
    s.lastSnapSrc = s.lastSnapBuf
  } else if (s.straddleSnapCarryLen > 0) {
    // 2. snapshot 被切在两个 chunk 中时，需要复制拼接后的完整行。
    s.lastSnapLen = s.straddleSnapCarryLen + s.straddleSnapTailEnd
    if (s.lastSnapBuf === undefined || s.lastSnapLen > s.lastSnapBuf.length) {
      s.lastSnapBuf = Buffer.allocUnsafe(s.lastSnapLen)
    }
    s.carryBuf!.copy(s.lastSnapBuf, 0, 0, s.straddleSnapCarryLen)
    chunk.copy(s.lastSnapBuf, s.straddleSnapCarryLen, 0, s.straddleSnapTailEnd)
    s.lastSnapSrc = s.lastSnapBuf
  }
}

/**
 * 缓存当前 buffer 末尾尚未闭合的 JSONL 行。
 *
 * 1. 下一个 chunk 到来前，这段内容还不能判断类型。
 * 2. 因此它暂时不能写入恢复输出。
 */
function captureCarry(s: LoadState, buf: Buffer, trailStart: number): void {
  s.carryLen = buf.length - trailStart
  if (s.carryLen > 0) {
    // 1. carryBuf 可复用，只有遇到更长半行时才扩容。
    if (s.carryBuf === undefined || s.carryLen > s.carryBuf.length) {
      s.carryBuf = Buffer.allocUnsafe(s.carryLen)
    }
    buf.copy(s.carryBuf, 0, trailStart, buf.length)
  }
}

/**
 * 完成 transcript 恢复输出的收尾。
 *
 * 1. 文件可能没有以换行结尾。
 * 2. 收尾阶段需要处理最后半行，并把最后 snapshot 放回末尾。
 */
function finalizeOutput(s: LoadState): void {
  if (s.carryLen > 0) {
    const cb = s.carryBuf!
    if (hasPrefix(cb, ATTR_SNAP_PREFIX, 0, s.carryLen)) {
      // 1. 文件最后一行如果是 snapshot，也按统一规则延后追加。
      s.lastSnapSrc = cb
      s.lastSnapLen = s.carryLen
    } else {
      // 2. 普通半行可能是崩溃前最后一条消息，恢复时仍应保留。
      sinkWrite(s.out, cb, 0, s.carryLen)
    }
  }
  if (s.lastSnapSrc) {
    if (s.out.len > 0 && s.out.buf[s.out.len - 1] !== LF) {
      // 3. 保证追加 snapshot 后仍是合法 JSONL，而不是粘在上一行末尾。
      sinkWrite(s.out, LF_BYTE, 0, 1)
    }
    sinkWrite(s.out, s.lastSnapSrc, 0, s.lastSnapLen)
  }
}

/**
 * 为 resume/load 场景读取可恢复的 transcript 内容。
 *
 * 1. 大文件会在读取过程中应用 compact boundary 语义。
 * 2. 这样可以避免把已压缩的旧上下文重新加载进会话。
 */
export async function readTranscriptForLoad(
  filePath: string,
  fileSize: number,
): Promise<{
  boundaryStartOffset: number
  postBoundaryBuf: Buffer
  hasPreservedSegment: boolean
}> {
  const boundaryMarker = compactBoundaryMarker()
  const CHUNK_SIZE = TRANSCRIPT_READ_CHUNK_SIZE

  // 1. 初始输出缓冲不按完整文件大小分配，避免大 session 恢复时立即占用大量内存。
  const s: LoadState = {
    out: {
      buf: Buffer.allocUnsafe(Math.min(fileSize, 8 * 1024 * 1024)),
      len: 0,
      // 1.1 额外 1 字节用于在截断文件中给最后 snapshot 补换行。
      cap: fileSize + 1,
    },
    boundaryStartOffset: 0,
    hasPreservedSegment: false,
    lastSnapSrc: null,
    lastSnapLen: 0,
    lastSnapBuf: undefined,
    bufFileOff: 0,
    carryLen: 0,
    carryBuf: undefined,
    straddleSnapCarryLen: 0,
    straddleSnapTailEnd: 0,
  }

  // 2. 读取 buffer 全程复用，降低大 transcript 顺序扫描时的 GC 压力。
  const chunk = Buffer.allocUnsafe(CHUNK_SIZE)
  const fd = await fsOpen(filePath, 'r')
  try {
    let filePos = 0
    while (filePos < fileSize) {
      const { bytesRead } = await fd.read(
        chunk,
        0,
        Math.min(CHUNK_SIZE, fileSize - filePos),
        filePos,
      )
      if (bytesRead === 0) break
      filePos += bytesRead

      const chunkOff = processStraddle(s, chunk, bytesRead)

      let buf: Buffer
      if (s.carryLen > 0) {
        // 3. 半行仍未闭合时，先拼成连续 buffer，避免特殊行被 chunk 边界拆散后误判。
        const bufLen = s.carryLen + (bytesRead - chunkOff)
        buf = Buffer.allocUnsafe(bufLen)
        s.carryBuf!.copy(buf, 0, 0, s.carryLen)
        chunk.copy(buf, s.carryLen, chunkOff, bytesRead)
      } else {
        // 4. 无跨块遗留时直接复用 chunk 视图，减少不必要的内存复制。
        buf = chunk.subarray(chunkOff, bytesRead)
      }

      const r = scanChunkLines(s, buf, boundaryMarker)
      captureSnap(s, buf, chunk, r.lastSnapStart, r.lastSnapEnd)
      captureCarry(s, buf, r.trailStart)
      // 5. boundaryStartOffset 需要对应原文件偏移，所以扫描进度要跟随完整行推进。
      s.bufFileOff += r.trailStart
    }
    finalizeOutput(s)
  } finally {
    // 6. 恢复路径可能在异常中断时退出，fd 仍必须关闭。
    await fd.close()
  }

  // 7. 只暴露有效字节范围，避免调用方误读未初始化容量。
  return {
    boundaryStartOffset: s.boundaryStartOffset,
    postBoundaryBuf: s.out.buf.subarray(0, s.out.len),
    hasPreservedSegment: s.hasPreservedSegment,
  }
}
