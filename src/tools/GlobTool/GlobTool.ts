import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import {
  FILE_NOT_FOUND_CWD_NOTE,
  suggestPathUnderCwd,
} from '../../utils/file.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { glob } from '../../utils/glob.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { expandPath, toRelativePath } from '../../utils/path.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { DESCRIPTION, GLOB_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

/**
 * 文件通配搜索工具定义。
 *
 * 这个文件负责声明 glob 搜索工具的输入输出结构、目录校验、读取权限检查、
 * 搜索执行和结果消息映射。该工具只查找匹配路径，不读取文件内容，因此可并发执行。
 */
const inputSchema = lazySchema(() =>
  z.strictObject({
    pattern: z.string().describe('The glob pattern to match files against'),
    path: z
      .string()
      .optional()
      .describe(
        'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    durationMs: z
      .number()
      .describe('Time taken to execute the search in milliseconds'),
    numFiles: z.number().describe('Total number of files found'),
    filenames: z
      .array(z.string())
      .describe('Array of file paths that match the pattern'),
    truncated: z
      .boolean()
      .describe('Whether results were truncated (limited to 100 files)'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const GlobTool = buildTool({
  name: GLOB_TOOL_NAME,
  searchHint: 'find files by name pattern or wildcard',
  maxResultSizeChars: 100_000,
  /**
   * 返回工具能力的简要说明。
   *
   * @returns 面向模型和工具系统的 glob 搜索描述。
   */
  async description() {
    return DESCRIPTION
  },
  userFacingName,
  getToolUseSummary,
  /**
   * 根据搜索输入生成活动状态文案。
   *
   * @param input 工具调用输入，包含 glob 模式和可选搜索目录。
   * @returns 用于界面展示的当前活动描述。
   */
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Finding ${summary}` : 'Finding files'
  },
  /**
   * 提供工具输入结构。
   *
   * @returns glob 模式和可选目录的输入 schema。
   */
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  /**
   * 提供工具输出结构。
   *
   * @returns 搜索耗时、文件数量、文件列表和截断状态的输出 schema。
   */
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /**
   * 标记该工具可安全并发执行。
   *
   * @returns 始终返回 true，表示搜索不会修改外部状态。
   */
  isConcurrencySafe() {
    return true
  },
  /**
   * 标记该工具为只读工具。
   *
   * @returns 始终返回 true，表示该工具只查找路径。
   */
  isReadOnly() {
    return true
  },
  /**
   * 将输入转换为自动分类器可分析的文本。
   *
   * @param input 工具调用输入。
   * @returns 用户提供的 glob 匹配模式。
   */
  toAutoClassifierInput(input) {
    return input.pattern
  },
  /**
   * 声明该工具属于搜索类命令。
   *
   * @returns 搜索和读取类型标记。
   */
  isSearchOrReadCommand() {
    return { isSearch: true, isRead: false }
  },
  /**
   * 取得本次搜索的根目录。
   *
   * @param param0 工具输入中的可选目录。
   * @returns 展开后的搜索目录；未传入时返回当前工作目录。
   */
  getPath({ path }): string {
    return path ? expandPath(path) : getCwd()
  },
  /**
   * 构建权限规则匹配函数。
   *
   * @param pattern 用户传入的 glob 匹配模式。
   * @returns 用于判断权限规则是否匹配该模式的函数。
   */
  async preparePermissionMatcher({ pattern }) {
    return rulePattern => matchWildcardPattern(rulePattern, pattern)
  },
  /**
   * 校验搜索目录是否可用于 glob 搜索。
   *
   * @param param0 工具输入中的可选搜索目录。
   * @returns 校验结果；失败时包含面向调用方的错误信息和错误码。
   */
  async validateInput({ path }): Promise<ValidationResult> {
    // 1. 只有显式传入 path 时才检查目录；省略 path 时使用当前工作目录。
    if (path) {
      const fs = getFsImplementation()
      const absolutePath = expandPath(path)

      // 2. Windows UNC 路径可能触发 SMB 认证，跳过本地 stat 以避免凭据泄露。
      if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
        return { result: true }
      }

      // 3. 检查目录是否存在；不存在时尝试给出当前工作目录下的相近路径建议。
      let stats
      try {
        stats = await fs.stat(absolutePath)
      } catch (e: unknown) {
        if (isENOENT(e)) {
          const cwdSuggestion = await suggestPathUnderCwd(absolutePath)
          let message = `Directory does not exist: ${path}. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`
          if (cwdSuggestion) {
            message += ` Did you mean ${cwdSuggestion}?`
          }
          return {
            result: false,
            message,
            errorCode: 1,
          }
        }
        throw e
      }

      // 4. glob 的搜索根必须是目录，不能是普通文件。
      if (!stats.isDirectory()) {
        return {
          result: false,
          message: `Path is not a directory: ${path}`,
          errorCode: 2,
        }
      }
    }

    return { result: true }
  },
  /**
   * 检查当前调用是否拥有读取搜索结果的权限。
   *
   * @param input 工具调用输入。
   * @param context 工具运行上下文，提供应用权限状态。
   * @returns 权限系统给出的允许、拒绝或需确认结果。
   */
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkReadPermissionForTool(
      GlobTool,
      input,
      appState.toolPermissionContext,
    )
  },
  /**
   * 提供模型调用该工具时使用的提示说明。
   *
   * @returns glob 搜索工具的提示文本。
   */
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  /**
   * 提供可索引的搜索结果文本。
   *
   * @param param0 搜索命中的文件名列表。
   * @returns 使用换行拼接的文件路径文本。
   */
  extractSearchText({ filenames }) {
    // 1. 复用 Grep 结果展示的文本形态，只把文件路径加入搜索索引。
    return filenames.join('\n')
  },
  /**
   * 执行 glob 文件路径搜索。
   *
   * @param input 工具调用输入，包含 glob 模式和可选搜索目录。
   * @param param1 工具运行状态，包含中止信号、应用状态和结果数量限制。
   * @returns 搜索结果数据，包含匹配路径、耗时、数量和截断状态。
   */
  async call(input, { abortController, getAppState, globLimits }) {
    const start = Date.now()
    const appState = getAppState()
    const limit = globLimits?.maxResults ?? 100
    // 1. 使用权限上下文执行 glob 搜索，并按工具限制控制最多返回的结果数量。
    const { files, truncated } = await glob(
      input.pattern,
      GlobTool.getPath(input),
      { limit, offset: 0 },
      abortController.signal,
      appState.toolPermissionContext,
    )
    // 2. 将当前工作目录下的路径转为相对路径，减少结果消息消耗的 token。
    const filenames = files.map(toRelativePath)
    // 3. 汇总文件列表、耗时、命中数量和是否截断，形成标准输出。
    const output: Output = {
      filenames,
      durationMs: Date.now() - start,
      numFiles: filenames.length,
      truncated,
    }
    return {
      data: output,
    }
  },
  /**
   * 将内部搜索结果映射为模型协议中的 tool_result 块。
   *
   * @param output glob 搜索的输出数据。
   * @param toolUseID 当前工具调用的唯一标识。
   * @returns 可发送给模型的工具结果消息块。
   */
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (output.filenames.length === 0) {
      // 1. 没有命中文件时返回简短空结果，避免输出空列表。
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'No files found',
      }
    }
    // 2. 命中结果按行输出；如果被截断，在末尾提示用户缩小路径或模式。
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
        ...output.filenames,
        ...(output.truncated
          ? [
              '(Results are truncated. Consider using a more specific path or pattern.)',
            ]
          : []),
      ].join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
