/**
 * 同步文件读取的轻量实现。
 *
 * 这个文件从 `file.ts` 中拆出纯读取路径，避免 settings 等底层模块为了同步读文件而引入日志、命令、工具注册等较重依赖链。
 * 这里仅依赖文件系统抽象和 debug 日志；带错误日志包装的编码/换行检测仍保留在 `file.ts`。
 */

import { logForDebugging } from './debug.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'

/** 文件原始换行风格；写回文件时用于保留 CRLF/LF 习惯。 */
export type LineEndingType = 'CRLF' | 'LF'

/**
 * 基于已解析路径探测文件编码。
 *
 * @param resolvedPath 已经过安全解析的真实文件路径。
 * @returns 文件读取应使用的 Node Buffer 编码。
 */
export function detectEncodingForResolvedPath(
  resolvedPath: string,
): BufferEncoding {
  // 1. 只读取文件头部样本，避免为了判断编码而读完整文件。
  const { buffer, bytesRead } = getFsImplementation().readSync(resolvedPath, {
    length: 4096,
  })

  // 2. 空文件默认按 UTF-8 处理，后续写入中文或 emoji 时不会被 ASCII 语义污染。
  if (bytesRead === 0) {
    return 'utf8'
  }

  // 3. UTF-16LE BOM 明确存在时按 UTF-16LE 读取。
  if (bytesRead >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le'
  }

  // 4. UTF-8 BOM 存在时仍使用 UTF-8，让 Node 负责按文本读取。
  if (
    bytesRead >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return 'utf8'
  }

  // 5. 其他非空文件默认 UTF-8；它覆盖 ASCII，并能正确承载 Unicode 内容。
  return 'utf8'
}

/**
 * 根据字符串样本判断主要换行风格。
 *
 * @param content 文件内容或文件头部样本。
 * @returns CRLF 数量更多时返回 `CRLF`，否则返回 `LF`。
 */
export function detectLineEndingsForString(content: string): LineEndingType {
  // 1. 分别统计 Windows CRLF 和 Unix LF 的出现次数。
  let crlfCount = 0
  let lfCount = 0

  // 2. 扫描所有换行符，`\r\n` 算 CRLF，单独 `\n` 算 LF。
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      if (i > 0 && content[i - 1] === '\r') {
        crlfCount++
      } else {
        lfCount++
      }
    }
  }

  // 3. 默认偏向 LF，只有 CRLF 明显更多时才保留 Windows 风格。
  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

/**
 * 同步读取文件，并同时返回编码和原始换行风格。
 *
 * @param filePath 调用方传入的文件路径，可以是符号链接或相对路径。
 * @returns 归一化为 LF 的文本内容、检测到的编码和原始换行风格。
 */
export function readFileSyncWithMetadata(filePath: string): {
  content: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
} {
  // 1. 使用文件系统抽象解析路径，统一处理符号链接和安全路径规则。
  const fs = getFsImplementation()
  const { resolvedPath, isSymlink } = safeResolvePath(fs, filePath)

  // 2. 符号链接读取只写 debug，避免把正常链接访问当成错误。
  if (isSymlink) {
    logForDebugging(`Reading through symlink: ${filePath} -> ${resolvedPath}`)
  }

  // 3. 先检测编码，再按该编码读取完整文本。
  const encoding = detectEncodingForResolvedPath(resolvedPath)
  const raw = fs.readFileSync(resolvedPath, { encoding })
  // 4. 在 CRLF 被归一化前截取头部样本判断原始换行风格。
  const lineEndings = detectLineEndingsForString(raw.slice(0, 4096))
  return {
    // 5. 内部统一使用 LF，写回时再依据 lineEndings 恢复原风格。
    content: raw.replaceAll('\r\n', '\n'),
    encoding,
    lineEndings,
  }
}

/**
 * 同步读取文件文本内容。
 *
 * @param filePath 调用方传入的文件路径。
 * @returns 归一化为 LF 的文件内容。
 */
export function readFileSync(filePath: string): string {
  // 1. 复用带元数据的读取路径，保证编码和换行处理一致。
  return readFileSyncWithMetadata(filePath).content
}
