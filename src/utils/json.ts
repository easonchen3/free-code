import { open, readFile, stat } from 'fs/promises'
import {
  applyEdits,
  modify,
  parse as parseJsonc,
} from 'jsonc-parser/lib/esm/main.js'
import { stripBOM } from './jsonRead.js'
import { logError } from './log.js'
import { memoizeWithLRU } from './memoize.js'
import { jsonStringify } from './slowOperations.js'

/** JSON 解析缓存的内部结果；用 ok 区分合法 JSON、非法 JSON 和 JSON null。 */
type CachedParse = { ok: true; value: unknown } | { ok: false }

/** 小 JSON 字符串才进入解析缓存；单位为字符数，避免大文件内容长期占用内存。 */
const PARSE_CACHE_MAX_KEY_BYTES = 8 * 1024

/**
 * 不经过缓存地解析 JSON 字符串。
 *
 * @param json 原始 JSON 文本。
 * @param shouldLogError 解析失败时是否写错误日志。
 * @returns 带 ok 标记的解析结果，避免把合法 `null` 和解析失败混在一起。
 */
function parseJSONUncached(
  json: string,
  shouldLogError: boolean,
): CachedParse {
  try {
    // 1. 先去掉 BOM，再交给原生 JSON.parse。
    return { ok: true, value: JSON.parse(stripBOM(json)) }
  } catch (e) {
    // 2. 解析失败可选择记录日志；某些调用方会主动探测，不希望刷日志。
    if (shouldLogError) {
      logError(e)
    }
    // 3. 用失败标记表示解析失败，和 JSON 文本 `null` 区分开。
    return { ok: false }
  }
}

/** 小输入的最近最少使用 JSON 解析缓存；缓存失败结果可避免重复解析同一段坏 JSON。 */
const parseJSONCached = memoizeWithLRU(parseJSONUncached, json => json, 50)

/**
 * 安全解析 JSON 字符串。
 *
 * @param json 可能为空的 JSON 文本。
 * @param shouldLogError 解析失败时是否写错误日志。
 * @returns 解析成功时返回 JSON 值；空输入或解析失败时返回 null。
 */
export const safeParseJSON = Object.assign(
  function safeParseJSON(
    json: string | null | undefined,
    shouldLogError: boolean = true,
  ): unknown {
    // 1. 空输入按无数据处理，和历史调用约定保持一致。
    if (!json) return null
    // 2. 大文本不进入缓存，避免把完整配置或日志内容固定在缓存键中。
    const result =
      json.length > PARSE_CACHE_MAX_KEY_BYTES
        ? parseJSONUncached(json, shouldLogError)
        : parseJSONCached(json, shouldLogError)
    // 3. 解析失败统一返回 null；合法 JSON null 也会返回 null，但不会记为失败日志之外的异常。
    return result.ok ? result.value : null
  },
  { cache: parseJSONCached.cache },
)

/**
 * 安全解析 JSONC 字符串。
 *
 * @param json 可能包含注释、尾逗号或 BOM 的 JSONC 文本。
 * @returns 解析成功时返回值；空输入或解析失败时返回 null。
 */
export function safeParseJSONC(json: string | null | undefined): unknown {
  // 1. 空输入没有可解析内容，直接返回 null。
  if (!json) {
    return null
  }
  try {
    // 2. 先去掉命令行工具可能写入的 UTF-8 字节序标记，再解析 JSONC。
    return parseJsonc(stripBOM(json))
  } catch (e) {
    // 3. JSONC 解析失败属于配置问题，记录后以 null 降级。
    logError(e)
    return null
  }
}

/** Bun 原生 JSONL 分块解析函数签名；不可用时走本文件的兼容实现。 */
type BunJSONLParseChunk = (
  data: string | Buffer,
  offset?: number,
) => { values: unknown[]; error: null | Error; read: number; done: boolean }

/** Bun 运行时可用时使用原生 JSONL 解析能力，否则为 false。 */
const bunJSONLParse: BunJSONLParseChunk | false = (() => {
  // 1. 非 Bun 环境没有 Bun.JSONL，直接使用兼容解析器。
  if (typeof Bun === 'undefined') return false
  // 2. 运行时检查分块解析入口，避免类型假设导致启动失败。
  const b = Bun as Record<string, unknown>
  const jsonl = b.JSONL as Record<string, unknown> | undefined
  if (!jsonl?.parseChunk) return false
  // 3. 返回原生解析函数，后续解析可以减少复制和分割成本。
  return jsonl.parseChunk as BunJSONLParseChunk
})()

/**
 * 使用 Bun 原生解析器解析 JSONL。
 *
 * @param data JSONL 字符串或 Buffer。
 * @returns 成功解析出的 JSON 行；格式错误的行会被跳过。
 */
function parseJSONLBun<T>(data: string | Buffer): T[] {
  // 1. 先从开头解析一次，快路径会一次性完成整个输入。
  const parse = bunJSONLParse as BunJSONLParseChunk
  const len = data.length
  const result = parse(data)
  if (!result.error || result.done || result.read >= len) {
    return result.values as T[]
  }
  // 2. 如果中途遇到坏行，保留已解析值，并从下一个换行后继续。
  let values = result.values as T[]
  let offset = result.read
  while (offset < len) {
    const newlineIndex =
      typeof data === 'string'
        ? data.indexOf('\n', offset)
        : data.indexOf(0x0a, offset)
    if (newlineIndex === -1) break
    offset = newlineIndex + 1
    const next = parse(data, offset)
    if (next.values.length > 0) {
      values = values.concat(next.values as T[])
    }
    if (!next.error || next.done || next.read >= len) break
    offset = next.read
  }
  // 3. 返回所有成功解析的行，坏行不影响后续数据。
  return values
}

/**
 * 从 Buffer 中解析 JSONL。
 *
 * @param buf 包含 JSONL 内容的 Buffer。
 * @returns 成功解析出的 JSON 行。
 */
function parseJSONLBuffer<T>(buf: Buffer): T[] {
  // 1. 识别并跳过 UTF-8 BOM。
  const bufLen = buf.length
  let start = 0

  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    start = 3
  }

  // 2. 按换行边界切片，逐行解析。
  const results: T[] = []
  while (start < bufLen) {
    let end = buf.indexOf(0x0a, start)
    if (end === -1) end = bufLen

    const line = buf.toString('utf8', start, end).trim()
    start = end + 1
    if (!line) continue
    try {
      results.push(JSON.parse(line) as T)
    } catch {
      // 3. JSONL 日志允许出现损坏行，解析器跳过坏行继续处理后续内容。
    }
  }
  return results
}

/**
 * 从字符串中解析 JSONL。
 *
 * @param data JSONL 字符串。
 * @returns 成功解析出的 JSON 行。
 */
function parseJSONLString<T>(data: string): T[] {
  // 1. 字符串路径同样先去掉 BOM，再按换行扫描。
  const stripped = stripBOM(data)
  const len = stripped.length
  let start = 0

  // 2. 避免整段切分产生大量中间数组，直接按换行位置逐段解析。
  const results: T[] = []
  while (start < len) {
    let end = stripped.indexOf('\n', start)
    if (end === -1) end = len

    const line = stripped.substring(start, end).trim()
    start = end + 1
    if (!line) continue
    try {
      results.push(JSON.parse(line) as T)
    } catch {
      // 3. 单行损坏不影响其他行。
    }
  }
  return results
}

/**
 * 解析 JSONL 数据，跳过损坏行。
 *
 * @param data JSONL 字符串或 Buffer。
 * @returns 成功解析出的 JSON 行。
 */
export function parseJSONL<T>(data: string | Buffer): T[] {
  // 1. Bun 原生解析器可用时优先使用，性能和内存占用更好。
  if (bunJSONLParse) {
    return parseJSONLBun<T>(data)
  }
  // 2. 字符串和 Buffer 分别使用无额外复制的扫描实现。
  if (typeof data === 'string') {
    return parseJSONLString<T>(data)
  }
  // 3. 二进制输入保持二进制路径，避免先整体转字符串。
  return parseJSONLBuffer<T>(data)
}

/** 读取 JSONL 文件时最多读取尾部 100 MB；单位为字节。 */
const MAX_JSONL_READ_BYTES = 100 * 1024 * 1024

/**
 * 读取并解析 JSONL 文件。
 *
 * @param filePath JSONL 文件路径。
 * @returns 成功解析出的 JSON 行；大文件只读取尾部最多 100 MB。
 */
export async function readJSONLFile<T>(filePath: string): Promise<T[]> {
  // 1. 小文件直接整体读取，避免复杂的尾部切片逻辑。
  const { size } = await stat(filePath)
  if (size <= MAX_JSONL_READ_BYTES) {
    return parseJSONL<T>(await readFile(filePath))
  }
  // 2. 大文件只读取尾部窗口，足以覆盖当前支持的上下文窗口。
  await using fd = await open(filePath, 'r')
  const buf = Buffer.allocUnsafe(MAX_JSONL_READ_BYTES)
  let totalRead = 0
  const fileOffset = size - MAX_JSONL_READ_BYTES
  while (totalRead < MAX_JSONL_READ_BYTES) {
    const { bytesRead } = await fd.read(
      buf,
      totalRead,
      MAX_JSONL_READ_BYTES - totalRead,
      fileOffset + totalRead,
    )
    if (bytesRead === 0) break
    totalRead += bytesRead
  }
  // 3. 尾部窗口可能从一行中间开始，找到第一个换行后再解析完整行。
  const newlineIndex = buf.indexOf(0x0a)
  if (newlineIndex !== -1 && newlineIndex < totalRead - 1) {
    return parseJSONL<T>(buf.subarray(newlineIndex + 1, totalRead))
  }
  // 4. 找不到换行时只能解析已读内容，兼容单行或异常格式文件。
  return parseJSONL<T>(buf.subarray(0, totalRead))
}

/**
 * 向 JSONC 数组文本中追加一个元素，并尽量保留注释和格式。
 *
 * @param content 原 JSONC 文本。
 * @param newItem 要追加到数组末尾的新元素。
 * @returns 修改后的 JSONC 文本；原内容不是数组或解析失败时返回只包含新元素的新数组。
 */
export function addItemToJSONCArray(content: string, newItem: unknown): string {
  try {
    // 1. 空文件没有现有格式可保留，直接创建标准四空格缩进数组。
    if (!content || content.trim() === '') {
      return jsonStringify([newItem], null, 4)
    }

    // 2. 去掉字节序标记，避免 JSONC 解析器把标记当成内容处理。
    const cleanContent = stripBOM(content)

    // 3. 先解析确认顶层结构，只有数组才适合做保留注释的增量编辑。
    const parsedContent = parseJsonc(cleanContent)

    if (Array.isArray(parsedContent)) {
      // 4. 空数组插入到 0，非空数组插入到当前长度位置。
      const arrayLength = parsedContent.length
      const isEmpty = arrayLength === 0
      const insertPath = isEmpty ? [0] : [arrayLength]

      // 5. 使用 JSONC 编辑器生成变更，最大限度保留原注释和排版。
      const edits = modify(cleanContent, insertPath, newItem, {
        formattingOptions: { insertSpaces: true, tabSize: 4 },
        isArrayInsertion: true,
      })

      // 6. 如果库无法生成编辑，退回普通 JSON 数组序列化。
      if (!edits || edits.length === 0) {
        const copy = [...parsedContent, newItem]
        return jsonStringify(copy, null, 4)
      }

      // 7. 应用编辑并返回无 BOM 的内容。
      return applyEdits(cleanContent, edits)
    } else {
      // 8. 顶层不是数组时，以新数组替换，避免把元素插到未知结构里。
      return jsonStringify([newItem], null, 4)
    }
  } catch (e) {
    // 9. 解析或编辑异常时记录错误，并返回可用的新数组文本。
    logError(e)
    return jsonStringify([newItem], null, 4)
  }
}
