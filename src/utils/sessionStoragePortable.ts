/**
 * 可移植的 session 存储模块。
 *
 * 1. 只依赖 Node.js 标准能力和纯工具函数，不依赖日志、实验开关或 CLI 运行时状态。
 * 2. 同时被 CLI 和 VS Code 扩展侧代码复用，所以这里的 API 必须保持环境中立。
 * 3. 负责 UUID 校验、JSONL 轻量读取、项目目录映射、session 文件定位和 transcript 分块加载。
 */

import type { UUID } from 'crypto'
import { open as fsOpen, readdir, realpath, stat } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { getWorktreePathsPortable } from './getWorktreePathsPortable.js'
import { djb2Hash } from './hash.js'

// 本文件是 session 存储的可移植底层工具层：
// 1. 只能依赖 Node.js 标准能力和纯工具函数，避免引入 CLI 专属状态。
// 2. 同时服务 CLI 与 VS Code 扩展侧代码，因此错误处理以“失败返回空值/undefined”为主。
// 3. 主要职责包括 UUID 校验、JSONL 轻量字段提取、session 文件定位和大 transcript 分块读取。

/** 轻量读取 session 元数据时，头尾各读取 64KB，避免为了列表展示加载完整 JSONL 文件。 */
export const LITE_READ_BUF_SIZE = 65536

// ---------------------------------------------------------------------------
// UUID 校验
// ---------------------------------------------------------------------------

// UUID 正则只验证字符串格式；文件是否存在由后续 session 定位逻辑负责。
const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 校验并收窄 UUID 字符串。
 *
 * 该方法用于在定位 session 文件前过滤非法 sessionId，避免把普通字符串当成文件名继续处理。
 */
export function validateUuid(maybeUuid: unknown): UUID | null {
  if (typeof maybeUuid !== 'string') return null
  return uuidRegex.test(maybeUuid) ? (maybeUuid as UUID) : null
}

// ---------------------------------------------------------------------------
// JSON 字符串字段提取：不做完整 JSON 解析，可处理被截断的 JSONL 行
// ---------------------------------------------------------------------------

/**
 * 反转义从 JSON 文本中截取出的字符串字段。
 *
 * 该方法服务于轻量 JSONL 文本扫描，保证截取出来的字段尽量还原成用户可读内容。
 */
export function unescapeJsonString(raw: string): string {
  // 1. 没有反斜杠说明不存在 JSON 转义，直接返回原字符串，避免额外分配。
  if (!raw.includes('\\')) return raw
  try {
    // 2. 有转义时借助 JSON.parse 处理标准 JSON 字符串转义规则。
    return JSON.parse(`"${raw}"`)
  } catch {
    // 3. 字段可能来自截断文本，解析失败时返回原文，保证调用链不中断。
    return raw
  }
}

/**
 * 从原始文本中提取第一个简单 JSON 字符串字段值。
 *
 * 该方法用于从可能不完整的 JSONL 片段中快速读取字段，避免为了列表展示解析完整 JSON。
 */
export function extractJsonStringField(
  text: string,
  key: string,
): string | undefined {
  // 1. 兼容紧凑 JSON 和冒号后带空格的 JSON 输出。
  const patterns = [`"${key}":"`, `"${key}": "`]
  for (const pattern of patterns) {
    const idx = text.indexOf(pattern)
    if (idx < 0) continue

    // 2. 从字段值起点逐字符扫描，避免把转义引号误判为字段结束。
    const valueStart = idx + pattern.length
    let i = valueStart
    while (i < text.length) {
      if (text[i] === '\\') {
        // 3. 跳过转义字符及其后一个字符，保持 JSON 字符串边界判断正确。
        i += 2
        continue
      }
      if (text[i] === '"') {
        // 4. 遇到未转义引号后，返回反转义后的字段值。
        return unescapeJsonString(text.slice(valueStart, i))
      }
      i++
    }
  }
  return undefined
}

/**
 * 从原始文本中提取最后一个简单 JSON 字符串字段值。
 *
 * 该方法适合读取会被后续记录覆盖或追加的元数据，例如标题和标签。
 */
export function extractLastJsonStringField(
  text: string,
  key: string,
): string | undefined {
  // 1. 字段可能被后续逻辑追加多次，因此需要扫描所有候选格式。
  const patterns = [`"${key}":"`, `"${key}": "`]
  let lastValue: string | undefined
  for (const pattern of patterns) {
    let searchFrom = 0
    while (true) {
      const idx = text.indexOf(pattern, searchFrom)
      if (idx < 0) break

      // 2. 每找到一次合法字段值就覆盖 lastValue，最终留下最后一次出现的值。
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
  // 3. 没找到任何合法字段时返回 undefined。
  return lastValue
}

// ---------------------------------------------------------------------------
// 从文件头部片段提取首条有效用户提示词
// ---------------------------------------------------------------------------

/**
 * 自动生成消息的匹配规则。
 * 1. 识别 IDE 上下文、Hook 输出、任务通知等小写 XML 风格标签。
 * 2. 识别用户中断标记。
 * 3. 提取首条真实用户提示词时，这些内容都要跳过。
 */
const SKIP_FIRST_PROMPT_PATTERN =
  /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

// slash command 消息带 command-name 标签；提取首条提示词时会跳过它，但保留命令名作为兜底。
const COMMAND_NAME_RE = /<command-name>(.*?)<\/command-name>/

/**
 * 从 JSONL 文件头部片段中提取第一条有意义的用户提示词。
 *
 * 该方法用于 session 列表或恢复入口展示更接近用户意图的会话摘要。
 */
export function extractFirstPromptFromHead(head: string): string {
  let start = 0
  let commandFallback = ''
  while (start < head.length) {
    // 1. 按行扫描 JSONL 头部片段，避免对不完整文件做整体 JSON 解析。
    const newlineIdx = head.indexOf('\n', start)
    const line =
      newlineIdx >= 0 ? head.slice(start, newlineIdx) : head.slice(start)
    start = newlineIdx >= 0 ? newlineIdx + 1 : head.length

    if (!line.includes('"type":"user"') && !line.includes('"type": "user"'))
      continue
    // 2. 工具结果、元数据和压缩摘要都不是用户真正输入，直接跳过。
    if (line.includes('"tool_result"')) continue
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true'))
      continue
    if (
      line.includes('"isCompactSummary":true') ||
      line.includes('"isCompactSummary": true')
    )
      continue

    try {
      // 3. 只有通过快速字符串过滤的行才做 JSON.parse，降低列表读取成本。
      const entry = JSON.parse(line) as Record<string, unknown>
      if (entry.type !== 'user') continue

      const message = entry.message as Record<string, unknown> | undefined
      if (!message) continue

      const content = message.content
      const texts: string[] = []
      // 4. 兼容 content 为字符串和 content 为 text block 数组两种消息结构。
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

        // 5. slash command 不是自然语言提示词，但可作为没有其它文本时的兜底标题。
        const cmdMatch = COMMAND_NAME_RE.exec(result)
        if (cmdMatch) {
          if (!commandFallback) commandFallback = cmdMatch[1]!
          continue
        }

        // 6. bash 输入是用户意图，先格式化为命令展示，再进入通用 XML 跳过逻辑。
        const bashMatch = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(result)
        if (bashMatch) return `! ${bashMatch[1]!.trim()}`

        if (SKIP_FIRST_PROMPT_PATTERN.test(result)) continue

        // 7. 列表标题只需要摘要，超长提示词截断到 200 字符。
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
// 文件 I/O：读取文件头尾片段
// ---------------------------------------------------------------------------

/**
 * 读取文件头部和尾部各 LITE_READ_BUF_SIZE 字节。
 *
 * 该方法用于批量读取 session 列表时获取必要元数据，避免加载完整 transcript。
 */
export async function readHeadAndTail(
  filePath: string,
  fileSize: number,
  buf: Buffer,
): Promise<{ head: string; tail: string }> {
  try {
    const fh = await fsOpen(filePath, 'r')
    try {
      // 1. 先读文件头部；空文件没有有效 session 内容，直接返回空结果。
      const headResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, 0)
      if (headResult.bytesRead === 0) return { head: '', tail: '' }

      const head = buf.toString('utf8', 0, headResult.bytesRead)

      // 2. 文件超过 64KB 时再补读尾部；否则尾部和头部是同一段内容。
      const tailOffset = Math.max(0, fileSize - LITE_READ_BUF_SIZE)
      let tail = head
      if (tailOffset > 0) {
        const tailResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, tailOffset)
        tail = buf.toString('utf8', 0, tailResult.bytesRead)
      }

      // 3. 返回头尾文本，供上层提取 title、summary 等轻量信息。
      return { head, tail }
    } finally {
      // 4. 文件句柄必须在成功和异常路径都关闭，避免批量读取时耗尽 fd。
      await fh.close()
    }
  } catch {
    return { head: '', tail: '' }
  }
}

/**
 * 轻量 session 文件信息。
 * 1. mtime/size 来自文件 stat，用于列表排序和后续加载判断。
 * 2. head/tail 是文件头尾文本，供上层快速提取元数据而不读取全文。
 */
export type LiteSessionFile = {
  // 文件最后修改时间的毫秒时间戳，用于 session 列表排序。
  mtime: number
  // 文件大小；上层据此判断是否需要走大文件读取路径。
  size: number
  // 文件开头片段，通常包含 session 起始元数据和第一条用户消息。
  head: string
  // 文件末尾片段，通常包含最近消息、标题、tag 等后追加元数据。
  tail: string
}

/**
 * 打开单个 session 文件，并在同一个 fd 上读取 stat、head 和 tail。
 *
 * 该方法返回 session 列表展示所需的最小文件信息，不可用文件以 null 表示。
 */
export async function readSessionLite(
  filePath: string,
): Promise<LiteSessionFile | null> {
  try {
    const fh = await fsOpen(filePath, 'r')
    try {
      // 1. stat 记录文件大小和修改时间，后续判断尾部偏移也依赖 size。
      const stat = await fh.stat()
      const buf = Buffer.allocUnsafe(LITE_READ_BUF_SIZE)
      // 2. 读取头部；如果没有读到字节，说明文件为空或无效。
      const headResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, 0)
      if (headResult.bytesRead === 0) return null

      const head = buf.toString('utf8', 0, headResult.bytesRead)
      // 3. 文件较小时复用 head 作为 tail；大文件再额外读取最后 64KB。
      const tailOffset = Math.max(0, stat.size - LITE_READ_BUF_SIZE)
      let tail = head
      if (tailOffset > 0) {
        const tailResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, tailOffset)
        tail = buf.toString('utf8', 0, tailResult.bytesRead)
      }

      // 4. 返回列表视图所需的最小信息，避免加载完整 transcript。
      return { mtime: stat.mtime.getTime(), size: stat.size, head, tail }
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 路径清洗
// ---------------------------------------------------------------------------

/**
 * 单个文件系统路径片段的清洗后最大长度。
 * 1. ext4、APFS、NTFS 等常见文件系统通常限制单个片段不超过 255 字节。
 * 2. 这里保留 200 字符，给后续 hash 后缀和连接符留空间。
 */
export const MAX_SANITIZED_LENGTH = 200

/**
 * 在没有 Bun.hash 的 Node 环境中生成稳定短 hash。
 *
 * 该方法用于保证路径清洗在纯 Node 运行环境中仍能生成稳定后缀。
 */
function simpleHash(str: string): string {
  return Math.abs(djb2Hash(str)).toString(36)
}

/**
 * 把任意字符串清洗成可作为目录名或文件名的安全片段。
 *
 * 该方法用于把真实项目路径映射到跨平台可用的 session 存储目录名。
 */
export function sanitizePath(name: string): string {
  // 1. 路径、插件名、server 名都可能包含平台保留字符，统一替换成连字符。
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    // 2. 短路径不会触发文件系统片段长度限制，直接使用清洗后的名称。
    return sanitized
  }
  // 3. Bun 环境优先使用 Bun.hash；纯 Node 环境使用 simpleHash 兜底。
  const hash =
    typeof Bun !== 'undefined' ? Bun.hash(name).toString(36) : simpleHash(name)
  // 4. 截断后的前缀保留可读性，hash 后缀用于降低不同长路径的碰撞概率。
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}

// ---------------------------------------------------------------------------
// 项目目录发现：listSessions 和 getSessionMessages 共享
// ---------------------------------------------------------------------------

/**
 * 返回 Claude 配置目录下的 projects 根目录。
 *
 * 该目录是所有项目 session JSONL 文件的统一上级目录。
 */
export function getProjectsDir(): string {
  return join(getClaudeConfigHomeDir(), 'projects')
}

/**
 * 根据真实项目路径计算对应的 session 项目目录。
 *
 * 该方法用于把当前工作目录稳定映射到对应的 session 文件夹。
 */
export function getProjectDir(projectDir: string): string {
  return join(getProjectsDir(), sanitizePath(projectDir))
}

/**
 * 将目录路径规范化为稳定的项目路径。
 *
 * 该方法用于减少符号链接和 Unicode 表示差异带来的 session 目录重复。
 */
export async function canonicalizePath(dir: string): Promise<string> {
  try {
    // 1. realpath 会解析符号链接和平台特有别名路径。
    return (await realpath(dir)).normalize('NFC')
  } catch {
    // 2. 目录不存在或不可访问时仍做 Unicode 归一化，保持目录名计算稳定。
    return dir.normalize('NFC')
  }
}

/**
 * 查找某个项目路径对应的 session 项目目录。
 *
 * 该方法兼容不同运行时生成的长路径 hash 后缀，尽量找到已有 session 目录。
 */
export async function findProjectDir(
  projectPath: string,
): Promise<string | undefined> {
  // 1. 优先查找按当前 hash 实现计算出的精确目录。
  const exact = getProjectDir(projectPath)
  try {
    await readdir(exact)
    return exact
  } catch {
    // 2. 精确匹配失败：短路径没有 hash 后缀差异，直接认为不存在。
    const sanitized = sanitizePath(projectPath)
    if (sanitized.length <= MAX_SANITIZED_LENGTH) {
      return undefined
    }
    // 3. 长路径目录名由“前缀 + hash”组成；扫描同前缀目录兼容不同 hash 实现。
    const prefix = sanitized.slice(0, MAX_SANITIZED_LENGTH)
    const projectsDir = getProjectsDir()
    try {
      // 4. 只枚举目录项，不读取文件内容，保持长路径 fallback 的成本可控。
      const dirents = await readdir(projectsDir, { withFileTypes: true })
      const match = dirents.find(
        d => d.isDirectory() && d.name.startsWith(prefix + '-'),
      )
      // 5. 找到同前缀目录就认为是同一长路径 session 目录；否则返回 undefined。
      return match ? join(projectsDir, match.name) : undefined
    } catch {
      // 6. projects 根目录不存在或不可读时，视为没有可用 session 目录。
      return undefined
    }
  }
}

/**
 * 将 sessionId 解析为磁盘上的 JSONL 文件路径。
 *
 * 该方法用于 resume/load 场景定位有效 session，并返回后续读取 transcript 所需的文件大小。
 */
export async function resolveSessionFilePath(
  sessionId: string,
  dir?: string,
): Promise<
  | { filePath: string; projectPath: string | undefined; fileSize: number }
  | undefined
> {
  // 1. session 文件名固定为 UUID.jsonl。
  const fileName = `${sessionId}.jsonl`

  if (dir) {
    // 2. 有项目目录时，优先查找当前规范化项目路径下的 session 文件。
    const canonical = await canonicalizePath(dir)
    const projectDir = await findProjectDir(canonical)
    if (projectDir) {
      const filePath = join(projectDir, fileName)
      try {
        const s = await stat(filePath)
        if (s.size > 0)
          return { filePath, projectPath: canonical, fileSize: s.size }
      } catch {
        // 3. 当前项目目录下找不到或无权限时不中断，继续尝试 worktree fallback。
      }
    }
    // 4. session 可能创建在同仓库的其它 worktree 根目录下，因此继续查 sibling worktree。
    let worktreePaths: string[]
    try {
      worktreePaths = await getWorktreePathsPortable(canonical)
    } catch {
      // 4.1 获取 worktree 信息失败不能影响当前项目查找结果，退化为空列表。
      worktreePaths = []
    }
    for (const wt of worktreePaths) {
      // 4.2 当前 canonical 已经查过，避免重复 stat 同一个项目目录。
      if (wt === canonical) continue
      const wtProjectDir = await findProjectDir(wt)
      // 4.3 worktree 下没有 session 目录时继续检查下一个 worktree。
      if (!wtProjectDir) continue
      const filePath = join(wtProjectDir, fileName)
      try {
        const s = await stat(filePath)
        if (s.size > 0) return { filePath, projectPath: wt, fileSize: s.size }
      } catch {
        // 5. 单个 worktree 未命中不影响其它 worktree 的扫描。
      }
    }
    return undefined
  }

  // 6. 没有项目目录上下文时，只能扫描 projects 根目录下所有项目。
  const projectsDir = getProjectsDir()
  let dirents: string[]
  try {
    dirents = await readdir(projectsDir)
  } catch {
    // 6.1 projects 根目录不存在时，说明当前机器没有可扫描的历史 session。
    return undefined
  }
  for (const name of dirents) {
    // 6.2 这里不预先判断 name 是否目录，直接 stat 目标文件并在失败时继续。
    const filePath = join(projectsDir, name, fileName)
    try {
      const s = await stat(filePath)
      if (s.size > 0)
        return { filePath, projectPath: undefined, fileSize: s.size }
    } catch {
      // 7. 当前项目目录没有目标文件或不是目录，继续扫描下一个项目。
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// compact boundary 分块读取：loadTranscriptFile 和 SDK getSessionMessages 共享
// ---------------------------------------------------------------------------

/** transcript 正向分块读取大小；1MB 用于平衡 I/O 次数和内存 buffer 增长。 */
const TRANSCRIPT_READ_CHUNK_SIZE = 1024 * 1024

/**
 * 跳过 precompact 过滤的文件大小阈值。
 * 1. 小于 5MB 的 session 通常不需要 compact boundary 过滤。
 * 2. 大 session 更可能经历自动 compact，因此需要走分块扫描逻辑。
 */
export const SKIP_PRECOMPACT_THRESHOLD = 5 * 1024 * 1024

/** compact boundary 的 marker 缓存；按需初始化，避免模块加载时为大多数不 resume 的场景分配 Buffer。 */
let _compactBoundaryMarker: Buffer | undefined
/**
 * 获取 compact boundary marker 的 Buffer。
 *
 * 该方法为 transcript 扫描提供可复用的字节 marker，避免重复创建相同 Buffer。
 */
function compactBoundaryMarker(): Buffer {
  return (_compactBoundaryMarker ??= Buffer.from('"compact_boundary"'))
}

/**
 * 校验包含 marker 的行是否真的是 compact_boundary 系统行。
 *
 * 该方法用于区分真实 compact boundary 和普通消息文本中的同名字符串。
 */
function parseBoundaryLine(
  line: string,
): { hasPreservedSegment: boolean } | null {
  try {
    // 1. 只在 marker 命中的行上做 JSON.parse，避免大文件扫描时频繁解析普通行。
    const parsed = JSON.parse(line) as {
      type?: string
      subtype?: string
      compactMetadata?: { preservedSegment?: unknown }
    }
    if (parsed.type !== 'system' || parsed.subtype !== 'compact_boundary') {
      // 2. 用户文本中也可能包含 compact_boundary 字符串，类型不匹配时必须忽略。
      return null
    }
    return {
      hasPreservedSegment: Boolean(parsed.compactMetadata?.preservedSegment),
    }
  } catch {
    // 3. 跨 chunk 或损坏行可能导致解析失败，按非 boundary 处理。
    return null
  }
}

// resume 加载路径使用单次正向分块读取：
// 1. attribution-snapshot 行在读取过程中剥离，只保留最后一条并在 EOF 追加。
// 2. compact boundary 会在流式扫描中截断输出，避免把 compact 前内容继续加载进会话。
// 3. 峰值内存接近输出大小，而不是原始文件大小。

/** 输出缓冲区状态；len 表示已写入长度，cap 是允许增长的上限。 */
type Sink = {
  // 实际承载输出内容的 Buffer；可能随着写入增长而替换。
  buf: Buffer
  // 当前已经写入的有效字节数。
  len: number
  // 允许增长到的最大容量，防止异常情况下超过原始文件大小太多。
  cap: number
}

/**
 * 向输出缓冲区写入一段字节。
 *
 * 该方法封装可增长输出缓冲区，供 transcript 分块加载过程复用。
 */
function sinkWrite(s: Sink, src: Buffer, start: number, end: number): void {
  const n = end - start
  if (n <= 0) return
  if (s.len + n > s.buf.length) {
    // 2.1 扩容目标取“当前两倍”和“刚好容纳写入”中的较大值，再受 cap 限制。
    const grown = Buffer.allocUnsafe(
      Math.min(Math.max(s.buf.length * 2, s.len + n), s.cap),
    )
    // 2.2 复制已有输出后替换 buffer；调用方只通过 s.buf/s.len 读取有效内容。
    s.buf.copy(grown, 0, 0, s.len)
    s.buf = grown
  }
  src.copy(s.buf, s.len, start, end)
  s.len += n
}

/**
 * 判断 src 的指定范围是否以 prefix 开头。
 *
 * 该方法用于在 transcript 扫描中快速识别特殊 JSONL 行前缀。
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

// attribution snapshot 行前缀；扫描时会跳过中间 snapshot，仅保留最后一条。
const ATTR_SNAP_PREFIX = Buffer.from('{"type":"attribution-snapshot"')
// system 行前缀；只有 system 行才可能是 compact boundary。
const SYSTEM_PREFIX = Buffer.from('{"type":"system"')
// JSONL 行分隔符 LF。
const LF = 0x0a
// 追加最后一条 attribution snapshot 时可能需要补一个 LF。
const LF_BYTE = Buffer.from([LF])
// boundary marker 通常在行首 28 字节左右；256 给字段顺序和空格留冗余。
const BOUNDARY_SEARCH_BOUND = 256

/**
 * transcript 分块加载的全局状态。
 * 1. out 保存过滤和截断后的输出内容。
 * 2. boundaryStartOffset 记录最后一次 compact boundary 在原文件中的偏移。
 * 3. carry* 保存跨 chunk 的半行，straddle* 专门记录跨 chunk 的 attribution snapshot。
 */
type LoadState = {
  // 输出缓冲区，只包含 compact 后仍需要加载的 transcript 内容。
  out: Sink
  // 最近一次有效 compact boundary 在原始文件中的偏移；没有命中时为 0。
  boundaryStartOffset: number
  // boundary 如果自带 preservedSegment，说明旧消息已被保留，不需要清空输出。
  hasPreservedSegment: boolean
  lastSnapSrc: Buffer | null // 最近一条 attribution snapshot，最终追加到 EOF。
  // lastSnapSrc 的有效长度；lastSnapSrc 可能指向比实际内容更大的缓存。
  lastSnapLen: number
  // 复制 snapshot 的专用缓存，避免复用读取 chunk 后数据被覆盖。
  lastSnapBuf: Buffer | undefined
  bufFileOff: number // 当前扫描 buffer 的首字节在原文件中的偏移。
  // 上一轮留下的未闭合 JSONL 半行长度。
  carryLen: number
  // 上一轮未闭合半行的字节缓存。
  carryBuf: Buffer | undefined
  straddleSnapCarryLen: number // 当前 chunk 的跨边界 snapshot 前半段长度，由 processStraddle 重置。
  // 跨 chunk snapshot 在当前 chunk 中延伸到的位置。
  straddleSnapTailEnd: number
}

/**
 * 处理跨 chunk 边界的半行。
 *
 * 该方法用于保证分块读取时跨边界 JSONL 行仍按完整行语义处理。
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
  // 2. 当前 chunk 的第一个 LF 决定上一轮 carry 是否已经拼成完整行。
  const firstNl = chunk.indexOf(LF)
  if (firstNl === -1 || firstNl >= bytesRead) return 0
  const tailEnd = firstNl + 1
  // 3. carry 已经能确认是 attribution snapshot 时，记录跨 chunk 的 snapshot 并从输出中剥离。
  if (hasPrefix(cb, ATTR_SNAP_PREFIX, 0, s.carryLen)) {
    s.straddleSnapCarryLen = s.carryLen
    s.straddleSnapTailEnd = tailEnd
    s.lastSnapSrc = null
  } else if (s.carryLen < ATTR_SNAP_PREFIX.length) {
    return 0 // carry 太短，暂时无法排除 attribution snapshot，交给拼接扫描处理。
  } else {
    // 4. system 跨边界行可能是 compact boundary，需要拼成完整行后解析确认。
    if (hasPrefix(cb, SYSTEM_PREFIX, 0, s.carryLen)) {
      const hit = parseBoundaryLine(
        cb.toString('utf-8', 0, s.carryLen) +
          chunk.toString('utf-8', 0, firstNl),
      )
      if (hit?.hasPreservedSegment) {
        s.hasPreservedSegment = true
      } else if (hit) {
        // 5. 普通 compact boundary 表示边界前内容已失效，清空输出并记录边界偏移。
        s.out.len = 0
        s.boundaryStartOffset = s.bufFileOff
        s.hasPreservedSegment = false
        s.lastSnapSrc = null
      }
    }
    // 6. 非 snapshot 的跨边界行需要保留，分别写入 carry 前半段和当前 chunk 后半段。
    sinkWrite(s.out, cb, 0, s.carryLen)
    sinkWrite(s.out, chunk, 0, tailEnd)
  }
  // 7. 已处理完 carry 后推进文件偏移，并清空 carry 状态。
  s.bufFileOff += s.carryLen + tailEnd
  s.carryLen = 0
  return tailEnd
}

/**
 * 扫描一个完整 buffer 中的 JSONL 行。
 *
 * 该方法用于过滤 transcript 中的特殊行，并保留最终需要加载的消息内容。
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
  // 1.1 nl 指向当前 buffer 中下一条完整 JSONL 行的换行符。
  let nl = buf.indexOf(LF)
  while (nl !== -1) {
    const lineEnd = nl + 1
    // 2. boundaryAt 落在当前行之前时，继续向后寻找下一处 marker。
    if (boundaryAt !== -1 && boundaryAt < lineStart) {
      boundaryAt = buf.indexOf(boundaryMarker, lineStart)
    }
    // 3. attribution snapshot 行不进入输出；先写入它之前的普通 run。
    if (hasPrefix(buf, ATTR_SNAP_PREFIX, lineStart, lineEnd)) {
      sinkWrite(s.out, buf, runStart, lineStart)
      lastSnapStart = lineStart
      lastSnapEnd = lineEnd
      // 3.1 snapshot 本行被跳过，因此下一段普通 run 从 snapshot 后面开始。
      runStart = lineEnd
    } else if (
      boundaryAt >= lineStart &&
      boundaryAt < Math.min(lineStart + BOUNDARY_SEARCH_BOUND, lineEnd)
    ) {
      // 4. marker 命中后再解析整行，防止用户文本里包含 compact_boundary 时误截断。
      const hit = parseBoundaryLine(buf.toString('utf-8', lineStart, nl))
      if (hit?.hasPreservedSegment) {
        s.hasPreservedSegment = true // preservedSegment 已保留旧消息，因此不截断输出。
      } else if (hit) {
        // 5. 普通 compact boundary 命中时清空之前输出，并从该 boundary 行重新开始保留。
        s.out.len = 0
        s.boundaryStartOffset = s.bufFileOff + lineStart
        s.hasPreservedSegment = false
        s.lastSnapSrc = null
        lastSnapStart = -1
        s.straddleSnapCarryLen = 0
        // 5.1 从 boundary 行开始重新写入，保留 boundary 后的 transcript 内容。
        runStart = lineStart
      }
      // 4.1 当前 marker 已检查完，继续寻找下一个 marker。
      boundaryAt = buf.indexOf(
        boundaryMarker,
        boundaryAt + boundaryMarker.length,
      )
    }
    lineStart = lineEnd
    nl = buf.indexOf(LF, lineStart)
  }
  // 6. 将最后一个完整换行前的普通 run 写入输出；尾部半行由调用方保存。
  sinkWrite(s.out, buf, runStart, lineStart)
  return { lastSnapStart, lastSnapEnd, trailStart: lineStart }
}

/**
 * 捕获当前扫描过程中发现的最后一条 attribution snapshot。
 *
 * 该方法用于把 attribution snapshot 延后到 transcript 输出末尾统一追加。
 */
function captureSnap(
  s: LoadState,
  buf: Buffer,
  chunk: Buffer,
  lastSnapStart: number,
  lastSnapEnd: number,
): void {
  if (lastSnapStart !== -1) {
    // 1. 当前 buffer 内 snapshot 更靠后，作为最终候选。
    s.lastSnapLen = lastSnapEnd - lastSnapStart
    if (s.lastSnapBuf === undefined || s.lastSnapLen > s.lastSnapBuf.length) {
      s.lastSnapBuf = Buffer.allocUnsafe(s.lastSnapLen)
    }
    buf.copy(s.lastSnapBuf, 0, lastSnapStart, lastSnapEnd)
    s.lastSnapSrc = s.lastSnapBuf
  } else if (s.straddleSnapCarryLen > 0) {
    // 2. 当前 buffer 内没有 snapshot，但上一轮记录了跨 chunk snapshot，需要拼接保存。
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
 * 保存当前 buffer 末尾未遇到 LF 的半行。
 *
 * 该方法用于把未闭合 JSONL 行留到下一轮读取后继续处理。
 */
function captureCarry(s: LoadState, buf: Buffer, trailStart: number): void {
  s.carryLen = buf.length - trailStart
  if (s.carryLen > 0) {
    // 2.1 carryBuf 会复用；只有当前半行超过已有容量时才重新分配。
    if (s.carryBuf === undefined || s.carryLen > s.carryBuf.length) {
      s.carryBuf = Buffer.allocUnsafe(s.carryLen)
    }
    buf.copy(s.carryBuf, 0, trailStart, buf.length)
  }
}

/**
 * 完成 transcript 输出收尾。
 *
 * 该方法用于处理文件末尾残留内容，并确保最后的 attribution snapshot 出现在输出末尾。
 */
function finalizeOutput(s: LoadState): void {
  if (s.carryLen > 0) {
    const cb = s.carryBuf!
    if (hasPrefix(cb, ATTR_SNAP_PREFIX, 0, s.carryLen)) {
      // 1.1 文件最后一行是 snapshot 时，不写入原位置，统一作为最后 snapshot 追加。
      s.lastSnapSrc = cb
      s.lastSnapLen = s.carryLen
    } else {
      // 1.2 文件最后一行不是 snapshot，即使缺少换行也应保留到输出。
      sinkWrite(s.out, cb, 0, s.carryLen)
    }
  }
  if (s.lastSnapSrc) {
    if (s.out.len > 0 && s.out.buf[s.out.len - 1] !== LF) {
      // 3.1 crash 截断时最后一行可能没有 LF，追加 snapshot 前补齐 JSONL 分隔符。
      sinkWrite(s.out, LF_BYTE, 0, 1)
    }
    sinkWrite(s.out, s.lastSnapSrc, 0, s.lastSnapLen)
  }
}

/**
 * 为 session resume/load 读取 transcript 文件。
 *
 * 该方法用于 resume/load 时读取可继续恢复的 transcript 内容，并返回 compact 相关元信息。
 */
export async function readTranscriptForLoad(
  filePath: string,
  fileSize: number,
): Promise<{
  boundaryStartOffset: number
  postBoundaryBuf: Buffer
  hasPreservedSegment: boolean
}> {
  // 1. 准备 boundary marker 和固定 chunk 大小，后续循环复用这些对象。
  const boundaryMarker = compactBoundaryMarker()
  const CHUNK_SIZE = TRANSCRIPT_READ_CHUNK_SIZE

  // 2. 初始化分块读取状态；out 只保存过滤和 compact 后仍需要加载的内容。
  const s: LoadState = {
    out: {
      // 2.1 初始 buffer 取 min(fileSize, 8MB)：小文件正好够用，大文件最多少量扩容。
      buf: Buffer.allocUnsafe(Math.min(fileSize, 8 * 1024 * 1024)),
      len: 0,
      // 2.2 cap 多 1 字节，用于崩溃截断文件中给最后 snapshot 前补 LF。
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

  // 3. chunk buffer 在整个读取过程中复用，减少大文件加载时的内存分配。
  const chunk = Buffer.allocUnsafe(CHUNK_SIZE)
  const fd = await fsOpen(filePath, 'r')
  try {
    let filePos = 0
    while (filePos < fileSize) {
      // 4. 从当前 filePos 顺序读取一块，最后一块按剩余文件大小裁剪。
      const { bytesRead } = await fd.read(
        chunk,
        0,
        Math.min(CHUNK_SIZE, fileSize - filePos),
        filePos,
      )
      if (bytesRead === 0) break
      filePos += bytesRead

      // 5. 先处理上一块遗留的半行；返回值表示当前 chunk 已被消费到的位置。
      const chunkOff = processStraddle(s, chunk, bytesRead)

      let buf: Buffer
      if (s.carryLen > 0) {
        // 6. 如果半行还不能独立处理，把 carry 与当前 chunk 剩余部分拼成连续 buffer 再扫描。
        const bufLen = s.carryLen + (bytesRead - chunkOff)
        buf = Buffer.allocUnsafe(bufLen)
        s.carryBuf!.copy(buf, 0, 0, s.carryLen)
        chunk.copy(buf, s.carryLen, chunkOff, bytesRead)
      } else {
        // 7. 没有 carry 时直接使用当前 chunk 的有效片段，避免复制。
        buf = chunk.subarray(chunkOff, bytesRead)
      }

      // 8. 扫描完整行：过滤 snapshot、识别 compact boundary，并返回尾部半行位置。
      const r = scanChunkLines(s, buf, boundaryMarker)
      // 9. 保存本轮最后 snapshot，再保存未闭合半行供下一轮处理。
      captureSnap(s, buf, chunk, r.lastSnapStart, r.lastSnapEnd)
      captureCarry(s, buf, r.trailStart)
      // 10. bufFileOff 跟随已扫描完整行推进，用于记录 boundary 原始偏移。
      s.bufFileOff += r.trailStart
    }
    // 11. 循环结束后处理最后的 carry，并把最后 snapshot 追加到输出末尾。
    finalizeOutput(s)
  } finally {
    // 12. 无论读取成功还是抛错，都关闭 fd。
    await fd.close()
  }

  // 13. 返回已写入部分的 subarray，不暴露未使用的 buffer 容量。
  return {
    boundaryStartOffset: s.boundaryStartOffset,
    postBoundaryBuf: s.out.buf.subarray(0, s.out.len),
    hasPreservedSegment: s.hasPreservedSegment,
  }
}
