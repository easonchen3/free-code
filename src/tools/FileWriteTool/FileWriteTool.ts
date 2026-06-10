import { dirname, sep } from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import { z } from 'zod/v4'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js'
import { checkTeamMemSecrets } from '../../services/teamMemorySync/teamMemSecretGuard.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { countLinesChanged, getPatchForDisplay } from '../../utils/diff.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import { getFileModificationTime, writeTextContent } from '../../utils/file.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from '../../utils/fileHistory.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import { readFileSyncWithMetadata } from '../../utils/fileRead.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import {
  fetchSingleFileGitDiff,
  type ToolUseDiff,
} from '../../utils/gitDiff.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import {
  checkWritePermissionForTool,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../FileEditTool/constants.js'
import { gitDiffSchema, hunkSchema } from '../FileEditTool/types.js'
import { FILE_WRITE_TOOL_NAME, getWriteToolDescription } from './prompt.js'
import {
  getToolUseSummary,
  isResultTruncated,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'

/**
 * 文件写入工具定义。
 *
 * 这个文件负责声明写文件工具的输入输出结构、权限校验、并发防护、
 * 实际写入流程以及结果展示映射。它会在写入前检查路径权限、文件
 * 新鲜度和敏感内容，写入后同步诊断、编辑历史、diff 展示和外部编辑器通知。
 */
const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z
      .string()
      .describe(
        'The absolute path to the file to write (must be absolute, not relative)',
      ),
    content: z.string().describe('The content to write to the file'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    type: z
      .enum(['create', 'update'])
      .describe(
        'Whether a new file was created or an existing file was updated',
      ),
    filePath: z.string().describe('The path to the file that was written'),
    content: z.string().describe('The content that was written to the file'),
    structuredPatch: z
      .array(hunkSchema())
      .describe('Diff patch showing the changes'),
    originalFile: z
      .string()
      .nullable()
      .describe(
        'The original file content before the write (null for new files)',
      ),
    gitDiff: gitDiffSchema().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>
export type FileWriteToolInput = InputSchema

export const FileWriteTool = buildTool({
  name: FILE_WRITE_TOOL_NAME,
  searchHint: 'create or overwrite files',
  maxResultSizeChars: 100_000,
  strict: true,
  /**
   * 返回工具能力的简要说明。
   *
   * @returns 面向模型和工具系统的能力描述。
   */
  async description() {
    return 'Write a file to the local filesystem.'
  },
  userFacingName,
  getToolUseSummary,
  /**
   * 根据本次输入生成活动状态文案。
   *
   * @param input 工具调用输入，包含目标文件路径和写入内容。
   * @returns 用于界面展示的当前活动描述。
   */
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Writing ${summary}` : 'Writing file'
  },
  /**
   * 提供模型调用该工具时使用的提示说明。
   *
   * @returns 写文件工具的提示文本。
   */
  async prompt() {
    return getWriteToolDescription()
  },
  renderToolUseMessage,
  isResultTruncated,
  /**
   * 提供工具输入结构。
   *
   * @returns 文件路径和文件内容的输入 schema。
   */
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  /**
   * 提供工具输出结构。
   *
   * @returns 写入结果、补丁和原始内容的输出 schema。
   */
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /**
   * 将输入转换为自动分类器可分析的文本。
   *
   * @param input 工具调用输入，包含文件路径和完整内容。
   * @returns 拼接后的路径与内容文本。
   */
  toAutoClassifierInput(input) {
    return `${input.file_path}: ${input.content}`
  },
  /**
   * 取得本次写入对应的文件路径。
   *
   * @param input 工具调用输入。
   * @returns 输入中的文件路径。
   */
  getPath(input): string {
    return input.file_path
  },
  /**
   * 规范化可观察输入中的文件路径。
   *
   * @param input 可能包含未展开路径的工具输入。
   * @returns 无返回值，直接更新输入对象中的路径字段。
   */
  backfillObservableInput(input) {
    // 1. 将 ~ 或相对路径展开为绝对路径，避免 hook allowlist 被路径写法绕过。
    if (typeof input.file_path === 'string') {
      input.file_path = expandPath(input.file_path)
    }
  },
  /**
   * 构建权限规则匹配函数。
   *
   * @param file_path 待写入的文件路径。
   * @returns 用于判断规则是否匹配该路径的函数。
   */
  async preparePermissionMatcher({ file_path }) {
    return pattern => matchWildcardPattern(pattern, file_path)
  },
  /**
   * 检查当前调用是否拥有写入权限。
   *
   * @param input 工具调用输入。
   * @param context 工具运行上下文，提供应用权限状态。
   * @returns 权限系统给出的允许、拒绝或需确认结果。
   */
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkWritePermissionForTool(
      FileWriteTool,
      input,
      appState.toolPermissionContext,
    )
  },
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  /**
   * 提供可索引的搜索文本。
   *
   * @returns 空字符串，避免把未展示的完整内容加入搜索索引。
   */
  extractSearchText() {
    // 1. 创建文件时界面展示内容，更新文件时界面展示结构化 diff；这里不额外索引原始内容，避免搜索命中用户看不到的文本。
    // 2. 路径已经由 tool_use 索引覆盖，少记内容比记录幽灵内容更可控。
    return ''
  },
  /**
   * 校验写入输入是否满足安全和一致性要求。
   *
   * @param param0 文件路径和待写入内容。
   * @param toolUseContext 工具运行上下文，提供权限状态和文件读取记录。
   * @returns 校验结果；失败时包含面向调用方的错误信息和错误码。
   */
  async validateInput({ file_path, content }, toolUseContext: ToolUseContext) {
    const fullFilePath = expandPath(file_path)

    // 1. 阻止把疑似密钥内容写入团队记忆文件。
    const secretError = checkTeamMemSecrets(fullFilePath, content)
    if (secretError) {
      return { result: false, message: secretError, errorCode: 0 }
    }

    // 2. 按文件系统权限配置检查该路径是否被显式拒绝编辑。
    const appState = toolUseContext.getAppState()
    const denyRule = matchingRuleForInput(
      fullFilePath,
      appState.toolPermissionContext,
      'edit',
      'deny',
    )
    if (denyRule !== null) {
      return {
        result: false,
        message:
          'File is in a directory that is denied by your permission settings.',
        errorCode: 1,
      }
    }

    // 3. Windows UNC 路径可能触发 SMB 认证，跳过本地 stat，交给权限层处理以避免凭据泄露。
    if (fullFilePath.startsWith('\\\\') || fullFilePath.startsWith('//')) {
      return { result: true }
    }

    // 4. 读取当前文件状态；不存在的文件允许继续走创建流程。
    const fs = getFsImplementation()
    let fileMtimeMs: number
    try {
      const fileStat = await fs.stat(fullFilePath)
      fileMtimeMs = fileStat.mtimeMs
    } catch (e) {
      if (isENOENT(e)) {
        return { result: true }
      }
      throw e
    }

    // 5. 已存在文件必须先完整读取，避免模型在不了解当前内容时覆盖用户改动。
    const readTimestamp = toolUseContext.readFileState.get(fullFilePath)
    if (!readTimestamp || readTimestamp.isPartialView) {
      return {
        result: false,
        message:
          'File has not been read yet. Read it first before writing to it.',
        errorCode: 2,
      }
    }

    // 6. 复用前面的 mtime，确认文件没有在读取后被用户或格式化工具改过。
    const lastWriteTime = Math.floor(fileMtimeMs)
    if (lastWriteTime > readTimestamp.timestamp) {
      return {
        result: false,
        message:
          'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
        errorCode: 3,
      }
    }

    return { result: true }
  },
  /**
   * 执行文件创建或覆盖写入。
   *
   * @param param0 文件路径和待写入的完整内容。
   * @param param1 工具运行状态，包含读取记录、文件历史状态和动态技能触发集合。
   * @param _ 保留参数，当前实现不使用。
   * @param parentMessage 触发本次工具调用的父消息，用于关联文件历史。
   * @returns 写入结果数据，包含创建/更新类型、补丁信息和可选 git diff。
   */
  async call(
    { file_path, content },
    { readFileState, updateFileHistoryState, dynamicSkillDirTriggers },
    _,
    parentMessage,
  ) {
    const fullFilePath = expandPath(file_path)
    const dir = dirname(fullFilePath)

    // 1. 根据目标文件路径发现可能相关的技能目录，供后续上下文和附件展示使用。
    const cwd = getCwd()
    const newSkillDirs = await discoverSkillDirsForPaths([fullFilePath], cwd)
    if (newSkillDirs.length > 0) {
      // 2. 记录新发现的目录，让界面能展示本次写入触发了哪些动态技能。
      for (const dir of newSkillDirs) {
        dynamicSkillDirTriggers?.add(dir)
      }
      // 3. 技能加载不阻塞写文件主流程；失败也不影响文件写入。
      addSkillDirectories(newSkillDirs).catch(() => {})
    }

    // 4. 激活路径规则匹配的条件技能，让后续步骤能使用对应能力。
    activateConditionalSkillsForPaths([fullFilePath], cwd)

    await diagnosticTracker.beforeFileEdited(fullFilePath)

    // 5. 在关键读写区间之前创建父目录，避免在新鲜度检查和实际写盘之间插入异步等待。
    await getFsImplementation().mkdir(dir)
    if (fileHistoryEnabled()) {
      // 6. 写入前保存历史快照；如果后续新鲜度检查失败，只会留下未使用备份，不会破坏状态。
      await fileHistoryTrackEdit(
        updateFileHistoryState,
        fullFilePath,
        parentMessage.uuid,
      )
    }

    // 7. 进入同步读写段，重新读取当前内容并确认它仍然是模型之前看过的版本。
    let meta: ReturnType<typeof readFileSyncWithMetadata> | null
    try {
      meta = readFileSyncWithMetadata(fullFilePath)
    } catch (e) {
      if (isENOENT(e)) {
        meta = null
      } else {
        throw e
      }
    }

    if (meta !== null) {
      const lastWriteTime = getFileModificationTime(fullFilePath)
      const lastRead = readFileState.get(fullFilePath)
      if (!lastRead || lastWriteTime > lastRead.timestamp) {
        // 8. 时间戳显示文件更新时，再用完整内容兜底比较，减少云同步或杀毒软件造成的误报。
        const isFullRead =
          lastRead &&
          lastRead.offset === undefined &&
          lastRead.limit === undefined
        // 9. meta.content 已按读取状态的规则做过换行归一化，因此可以直接比较。
        if (!isFullRead || meta.content !== lastRead.content) {
          throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
        }
      }
    }

    const enc = meta?.encoding ?? 'utf8'
    const oldContent = meta?.content ?? null

    // 10. 按模型给出的完整内容直接覆盖写入，保留 content 中明确携带的换行形式。
    writeTextContent(fullFilePath, content, enc, 'LF')

    // 11. 通知 LSP 文件已修改并保存，让诊断和语言服务状态跟随最新内容。
    const lspManager = getLspServerManager()
    if (lspManager) {
      // 12. 清空旧诊断的已投递记录，避免新诊断被当成重复内容过滤。
      clearDeliveredDiagnosticsForFile(`file://${fullFilePath}`)
      // 13. 发送 didChange，告诉语言服务内存中的文件内容已变化。
      lspManager.changeFile(fullFilePath, content).catch((err: Error) => {
        logForDebugging(
          `LSP: Failed to notify server of file change for ${fullFilePath}: ${err.message}`,
        )
        logError(err)
      })
      // 14. 发送 didSave，触发依赖保存事件的诊断刷新。
      lspManager.saveFile(fullFilePath).catch((err: Error) => {
        logForDebugging(
          `LSP: Failed to notify server of file save for ${fullFilePath}: ${err.message}`,
        )
        logError(err)
      })
    }

    // 15. 通知 VS Code 侧文件变化，便于差异视图展示新旧内容。
    notifyVscodeFileUpdated(fullFilePath, oldContent, content)

    // 16. 更新读取状态中的内容和时间戳，后续写入可据此判断是否过期。
    readFileState.set(fullFilePath, {
      content,
      timestamp: getFileModificationTime(fullFilePath),
      offset: undefined,
      limit: undefined,
    })

    // 17. 单独记录 CLAUDE.md 写入事件，供产品分析使用。
    if (fullFilePath.endsWith(`${sep}CLAUDE.md`)) {
      logEvent('tengu_write_claudemd', {})
    }

    // 18. 远程环境并且实验开关开启时，补充计算单文件 git diff。
    let gitDiff: ToolUseDiff | undefined
    if (
      isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_quartz_lantern', false)
    ) {
      const startTime = Date.now()
      const diff = await fetchSingleFileGitDiff(fullFilePath)
      if (diff) gitDiff = diff
      logEvent('tengu_tool_use_diff_computed', {
        isWriteTool: true,
        durationMs: Date.now() - startTime,
        hasDiff: !!diff,
      })
    }

    // 19. 已有旧内容说明本次是更新文件，需要生成结构化补丁并记录更新事件。
    if (oldContent) {
      const patch = getPatchForDisplay({
        filePath: file_path,
        fileContents: oldContent,
        edits: [
          {
            old_string: oldContent,
            new_string: content,
            replace_all: false,
          },
        ],
      })

      const data = {
        type: 'update' as const,
        filePath: file_path,
        content,
        structuredPatch: patch,
        originalFile: oldContent,
        ...(gitDiff && { gitDiff }),
      }
      // 20. 在返回前统计更新产生的增删行数。
      countLinesChanged(patch)

      logFileOperation({
        operation: 'write',
        tool: 'FileWriteTool',
        filePath: fullFilePath,
        type: 'update',
      })

      return {
        data,
      }
    }

    // 21. 没有旧内容说明本次是创建文件，返回空补丁并把所有内容计为新增。
    const data = {
      type: 'create' as const,
      filePath: file_path,
      content,
      structuredPatch: [],
      originalFile: null,
      ...(gitDiff && { gitDiff }),
    }

    // 22. 新建文件没有旧补丁，直接按写入内容统计新增行数。
    countLinesChanged([], content)

    logFileOperation({
      operation: 'write',
      tool: 'FileWriteTool',
      filePath: fullFilePath,
      type: 'create',
    })

    return {
      data,
    }
  },
  /**
   * 将内部工具结果映射为模型协议中的 tool_result 块。
   *
   * @param param0 写入结果中的文件路径和操作类型。
   * @param toolUseID 当前工具调用的唯一标识。
   * @returns 可发送给模型的工具结果消息块。
   */
  mapToolResultToToolResultBlockParam({ filePath, type }, toolUseID) {
    switch (type) {
      case 'create':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `File created successfully at: ${filePath}`,
        }
      case 'update':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `The file ${filePath} has been updated successfully.`,
        }
    }
  },
} satisfies ToolDef<InputSchema, Output>)
