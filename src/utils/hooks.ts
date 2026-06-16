// biome-ignore-all assist/source/organizeImports: ANT-ONLY 导入标记依赖当前顺序，不能自动重排。
/**
 * Hook 工具函数集合。
 *
 * 本文件负责把用户、插件、技能和会话注册的 hook 配置统一匹配、执行、解析和聚合。
 * hook 可以在工具调用、会话启动/结束、压缩、权限请求、文件变化等生命周期节点运行。
 * 这些 hook 会执行外部命令、HTTP 调用或回调，因此所有入口都需要关注信任状态、超时、
 * 权限策略、输出协议和阻塞语义。
 */
import { basename } from 'path'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { pathExists } from './file.js'
import { wrapSpawn } from './ShellCommand.js'
import { TaskOutput } from './task/TaskOutput.js'
import { getCwd } from './cwd.js'
import { randomUUID } from 'crypto'
import { formatShellPrefixCommand } from './bash/shellPrefix.js'
import {
  getHookEnvFilePath,
  invalidateSessionEnvCache,
} from './sessionEnvironment.js'
import { subprocessEnv } from './subprocessEnv.js'
import { getPlatform } from './platform.js'
import { findGitBashPath, windowsPathToPosixPath } from './windowsPaths.js'
import { getCachedPowerShellPath } from './shell/powershellDetection.js'
import { DEFAULT_HOOK_SHELL } from './shell/shellProvider.js'
import { buildPowerShellArgs } from './shell/powershellProvider.js'
import {
  loadPluginOptions,
  substituteUserConfigVariables,
} from './plugins/pluginOptionsStorage.js'
import { getPluginDataDir } from './plugins/pluginDirectories.js'
import {
  getSessionId,
  getProjectRoot,
  getIsNonInteractiveSession,
  getRegisteredHooks,
  getStatsStore,
  addToTurnHookDuration,
  getOriginalCwd,
  getMainThreadAgentType,
} from '../bootstrap/state.js'
import { checkHasTrustDialogAccepted } from './config.js'
import {
  getHooksConfigFromSnapshot,
  shouldAllowManagedHooksOnly,
  shouldDisableAllHooksIncludingManaged,
} from './hooks/hooksConfigSnapshot.js'
import {
  getTranscriptPathForSession,
  getAgentTranscriptPath,
} from './sessionStorage.js'
import type { AgentId } from '../types/ids.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from './settings/settings.js'
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { logOTelEvent } from './telemetry/events.js'
import { ALLOWED_OFFICIAL_MARKETPLACE_NAMES } from './plugins/schemas.js'
import {
  startHookSpan,
  endHookSpan,
  isBetaTracingEnabled,
} from './telemetry/sessionTracing.js'
import {
  hookJSONOutputSchema,
  promptRequestSchema,
  type HookCallback,
  type HookCallbackMatcher,
  type PromptRequest,
  type PromptResponse,
  isAsyncHookJSONOutput,
  isSyncHookJSONOutput,
  type PermissionRequestResult,
} from '../types/hooks.js'
import type {
  HookEvent,
  HookInput,
  HookJSONOutput,
  NotificationHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  PermissionDeniedHookInput,
  PreCompactHookInput,
  PostCompactHookInput,
  PreToolUseHookInput,
  SessionStartHookInput,
  SessionEndHookInput,
  SetupHookInput,
  StopHookInput,
  StopFailureHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  TeammateIdleHookInput,
  TaskCreatedHookInput,
  TaskCompletedHookInput,
  ConfigChangeHookInput,
  CwdChangedHookInput,
  FileChangedHookInput,
  InstructionsLoadedHookInput,
  UserPromptSubmitHookInput,
  PermissionRequestHookInput,
  ElicitationHookInput,
  ElicitationResultHookInput,
  PermissionUpdate,
  ExitReason,
  SyncHookJSONOutput,
  AsyncHookJSONOutput,
} from 'src/entrypoints/agentSdkTypes.js'
import type { StatusLineCommandInput } from '../types/statusLine.js'
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import type { FileSuggestionCommandInput } from '../types/fileSuggestion.js'
import type { HookResultMessage } from 'src/types/message.js'
import chalk from 'chalk'
import type {
  HookMatcher,
  HookCommand,
  PluginHookMatcher,
  SkillHookMatcher,
} from './settings/types.js'
import { getHookDisplayText } from './hooks/hooksSettings.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { firstLineOf } from './stringUtils.js'
import {
  normalizeLegacyToolName,
  getLegacyToolNames,
  permissionRuleValueFromString,
} from './permissions/permissionRuleParser.js'
import { logError } from './log.js'
import { createCombinedAbortSignal } from './combinedAbortSignal.js'
import type { PermissionResult } from './permissions/PermissionResult.js'
import { registerPendingAsyncHook } from './hooks/AsyncHookRegistry.js'
import { enqueuePendingNotification } from './messageQueueManager.js'
import {
  extractTextContent,
  getLastAssistantMessage,
  wrapInSystemReminder,
} from './messages.js'
import {
  emitHookStarted,
  emitHookResponse,
  startHookProgressInterval,
} from './hooks/hookEvents.js'
import { createAttachmentMessage } from './attachments.js'
import { all } from './generators.js'
import { findToolByName, type Tools, type ToolUseContext } from '../Tool.js'
import { execPromptHook } from './hooks/execPromptHook.js'
import type { Message, AssistantMessage } from '../types/message.js'
import { execAgentHook } from './hooks/execAgentHook.js'
import { execHttpHook } from './hooks/execHttpHook.js'
import type { ShellCommand } from './ShellCommand.js'
import {
  getSessionHooks,
  getSessionFunctionHooks,
  getSessionHookCallback,
  clearSessionHooks,
  type SessionDerivedHookMatcher,
  type FunctionHook,
} from './hooks/sessionHooks.js'
import type { AppState } from '../state/AppState.js'
import { jsonStringify, jsonParse } from './slowOperations.js'
import { isEnvTruthy } from './envUtils.js'
import { errorMessage, getErrnoCode } from './errors.js'

/**
 * 工具类 hook 的默认执行超时时间。
 *
 * 场景：PreToolUse、PostToolUse 等围绕工具调用运行的 hook。
 * 单位：毫秒；当前值为 10 分钟。
 */
const TOOL_HOOK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000

/**
 * SessionEnd hook 的默认超时时间。
 *
 * 场景：会话关闭或清理时运行的收尾脚本，需要比工具 hook 更短的等待窗口。
 * 单位：毫秒；调用方会同时把它作为单个 hook 默认超时和整体 AbortSignal 上限。
 * 可以通过 CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS 覆盖。
 */
const SESSION_END_HOOK_TIMEOUT_MS_DEFAULT = 1500
/**
 * 读取 SessionEnd hook 的超时时间配置。
 *
 * @returns 有效环境变量覆盖值，或默认的 SessionEnd 超时时间，单位为毫秒。
 */
export function getSessionEndHookTimeoutMs(): number {
  const raw = process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : SESSION_END_HOOK_TIMEOUT_MS_DEFAULT
}

/**
 * 把异步 hook 交给后台流程继续执行。
 *
 * @param param0 后台执行所需的进程、hook 元数据和命令信息。
 * @returns 是否成功转入后台执行；失败时调用方需要继续按同步路径处理。
 */
function executeInBackground({
  processId,
  hookId,
  shellCommand,
  asyncResponse,
  hookEvent,
  hookName,
  command,
  asyncRewake,
  pluginId,
}: {
  processId: string
  hookId: string
  shellCommand: ShellCommand
  asyncResponse: AsyncHookJSONOutput
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  hookName: string
  command: string
  asyncRewake?: boolean
  pluginId?: string
}): boolean {
  if (asyncRewake) {
    // 1. asyncRewake 不进入普通异步注册表；完成后如果返回阻塞码 2，就转成任务通知唤醒模型。
    // 2. 这里刻意不调用 background()，因为它会把输出落盘，导致内存中的 stdout/stderr 无法读取。
    // 3. interrupt 场景允许 hook 跨用户新消息继续运行；硬取消仍会通过 abort 结束进程。
    void shellCommand.result.then(async result => {
      // 4. 进程 exit 后 stdio 事件可能还没完全排空，先让出一次事件循环再读取输出。
      await new Promise(resolve => setImmediate(resolve))
      const stdout = await shellCommand.taskOutput.getStdout()
      const stderr = shellCommand.taskOutput.getStderr()
      shellCommand.cleanup()
      emitHookResponse({
        hookId,
        hookName,
        hookEvent,
        output: stdout + stderr,
        stdout,
        stderr,
        exitCode: result.code,
        outcome: result.code === 0 ? 'success' : 'error',
      })
      if (result.code === 2) {
        enqueuePendingNotification({
          value: wrapInSystemReminder(
            `Stop hook blocking error from command "${hookName}": ${stderr || stdout}`,
          ),
          mode: 'task-notification',
        })
      }
    })
    return true
  }

  // 1. 普通异步 hook 由 ShellCommand 自己累积输出，不需要额外挂流监听器。
  if (!shellCommand.background(processId)) {
    return false
  }

  // 2. 注册待完成的异步 hook，后续由异步 hook 注册表统一回收和展示。
  registerPendingAsyncHook({
    processId,
    hookId,
    asyncResponse,
    hookEvent,
    hookName,
    command,
    shellCommand,
    pluginId,
  })

  return true
}

/**
 * 判断当前是否应该因为工作区未受信任而跳过 hook。
 *
 * 所有 hook 都可能执行来自配置文件的任意命令，因此交互模式下必须先确认工作区信任。
 * 该检查用于防止信任弹窗前、用户拒绝信任后或未来新增路径中意外执行 hook。
 *
 * @returns true 表示应跳过 hook；false 表示可以继续执行。
 */
export function shouldSkipHookDueToTrust(): boolean {
  // 1. 非交互 SDK 模式默认由调用方承担信任边界，因此不阻止 hook。
  const isInteractive = !getIsNonInteractiveSession()
  if (!isInteractive) {
    return false
  }

  // 2. 交互模式下必须等用户接受工作区信任后才能执行任意 hook。
  const hasTrust = checkHasTrustDialogAccepted()
  return !hasTrust
}

/**
 * 创建所有 hook 共享的基础输入字段。
 *
 * @param permissionMode 当前权限模式，可为空。
 * @param sessionId 指定会话 ID；未传入时使用当前主会话 ID。
 * @param agentInfo 可选代理信息，用于区分主线程和子代理 hook。
 * @returns 包含会话、转录文件、工作目录、权限模式和代理信息的基础输入。
 */
export function createBaseHookInput(
  permissionMode?: string,
  sessionId?: string,
  // 1. 这里保持窄类型，调用方可以用结构类型直接传入 toolUseContext，而不让本函数依赖 Tool.ts。
  agentInfo?: { agentId?: string; agentType?: string },
): {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} {
  const resolvedSessionId = sessionId ?? getSessionId()
  // 2. 子代理类型优先于会话级 --agent 标记，hook 可通过 agent_id 判断调用来自子代理还是主线程。
  const resolvedAgentType = agentInfo?.agentType ?? getMainThreadAgentType()
  return {
    session_id: resolvedSessionId,
    transcript_path: getTranscriptPathForSession(resolvedSessionId),
    cwd: getCwd(),
    permission_mode: permissionMode,
    agent_id: agentInfo?.agentId,
    agent_type: resolvedAgentType,
  }
}

/**
 * hook 阻塞错误信息。
 *
 * 场景：hook 明确阻止后续流程时，携带给模型或调用方的错误说明和来源命令。
 */
export interface HookBlockingError {
  /** hook 输出的阻塞原因。 */
  blockingError: string
  /** 产生阻塞结果的命令名称或命令内容。 */
  command: string
}

/** 为兼容旧调用方，把 MCP SDK 的 ElicitResult 重新命名为 ElicitationResponse。 */
export type ElicitationResponse = ElicitResult

/**
 * 单个 hook 的执行结果。
 *
 * 场景：executeHooks 内部对 command、prompt、agent、http、callback、function hook 的统一结果模型。
 * 其中 outcome 表示执行状态，其他字段按 hook 类型按需携带。
 */
export interface HookResult {
  /** 需要展示给用户的附件消息。 */
  message?: HookResultMessage
  /** 需要注入为系统提示的文本。 */
  systemMessage?: string
  /** 阻塞后续流程的错误信息。 */
  blockingError?: HookBlockingError
  /** hook 执行结论。 */
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
  /** 是否阻止后续对话或流程继续。 */
  preventContinuation?: boolean
  /** 停止原因，通常来自 hook JSON 输出。 */
  stopReason?: string
  /** hook 对权限请求的处理方式。 */
  permissionBehavior?: 'ask' | 'deny' | 'allow' | 'passthrough'
  /** hook 给出的权限决策说明。 */
  hookPermissionDecisionReason?: string
  /** hook 追加到上下文中的文本。 */
  additionalContext?: string
  /** hook 修改后的首条用户消息。 */
  initialUserMessage?: string
  /** hook 修改后的工具输入。 */
  updatedInput?: Record<string, unknown>
  /** PostToolUse hook 修改后的 MCP 工具输出。 */
  updatedMCPToolOutput?: unknown
  /** PermissionRequest hook 的结构化处理结果。 */
  permissionRequestResult?: PermissionRequestResult
  /** Elicitation hook 的响应结果。 */
  elicitationResponse?: ElicitationResponse
  /** FileChanged hook 需要继续观察的路径列表。 */
  watchPaths?: string[]
  /** ElicitationResult hook 的响应结果。 */
  elicitationResultResponse?: ElicitationResponse
  /** PermissionDenied hook 请求重试时使用。 */
  retry?: boolean
  /** 产生该结果的 hook 定义。 */
  hook: HookCommand | HookCallback | FunctionHook
}

/**
 * 多个 hook 结果聚合后的输出。
 *
 * 场景：异步生成器对外逐步产出 hook 消息、阻塞状态、权限行为和上下文更新。
 */
export type AggregatedHookResult = {
  /** 需要展示给用户的附件消息。 */
  message?: HookResultMessage
  /** 聚合后的阻塞错误。 */
  blockingError?: HookBlockingError
  /** 是否阻止后续流程继续。 */
  preventContinuation?: boolean
  /** 聚合后的停止原因。 */
  stopReason?: string
  /** 权限决策说明。 */
  hookPermissionDecisionReason?: string
  /** hook 来源，通常是 settings、plugin 或 skill。 */
  hookSource?: string
  /** 聚合后的权限行为。 */
  permissionBehavior?: PermissionResult['behavior']
  /** hook 追加的上下文集合。 */
  additionalContexts?: string[]
  /** hook 修改后的首条用户消息。 */
  initialUserMessage?: string
  /** hook 修改后的工具输入。 */
  updatedInput?: Record<string, unknown>
  /** hook 修改后的 MCP 工具输出。 */
  updatedMCPToolOutput?: unknown
  /** PermissionRequest hook 的结构化结果。 */
  permissionRequestResult?: PermissionRequestResult
  /** 需要继续观察的文件路径列表。 */
  watchPaths?: string[]
  /** Elicitation hook 的聚合响应。 */
  elicitationResponse?: ElicitationResponse
  /** ElicitationResult hook 的聚合响应。 */
  elicitationResultResponse?: ElicitationResponse
  /** 是否请求重试。 */
  retry?: boolean
}

/**
 * 按 hook 输出 schema 解析并校验 JSON 字符串。
 *
 * @param jsonString hook 输出的 JSON 字符串。
 * @returns 校验后的 JSON 输出，或格式化后的校验错误文本。
 */
function validateHookJson(
  jsonString: string,
): { json: HookJSONOutput } | { validationError: string } {
  // 1. 先用统一 JSON 解析器读取字符串，再交给 Zod schema 校验协议字段。
  const parsed = jsonParse(jsonString)
  const validation = hookJSONOutputSchema().safeParse(parsed)
  if (validation.success) {
    logForDebugging('Successfully parsed and validated hook JSON output')
    return { json: validation.data }
  }
  // 2. 校验失败时把每个字段错误展开成可读文本，便于 hook 作者定位输出问题。
  const errors = validation.error.issues
    .map(err => `  - ${err.path.join('.')}: ${err.message}`)
    .join('\n')
  return {
    validationError: `Hook JSON output validation failed:\n${errors}\n\nThe hook's output was: ${jsonStringify(parsed, null, 2)}`,
  }
}

/**
 * 解析命令类 hook 的 stdout 输出。
 *
 * @param stdout hook 进程写到标准输出的完整文本。
 * @returns JSON 协议输出、普通文本输出或 JSON 校验错误。
 */
function parseHookOutput(stdout: string): {
  json?: HookJSONOutput
  plainText?: string
  validationError?: string
} {
  const trimmed = stdout.trim()
  // 1. 非对象开头的输出按普通文本处理，保留原始 stdout。
  if (!trimmed.startsWith('{')) {
    logForDebugging('Hook output does not start with {, treating as plain text')
    return { plainText: stdout }
  }

  try {
    // 2. 对 JSON 输出做协议校验；成功时直接返回结构化结果。
    const result = validateHookJson(trimmed)
    if ('json' in result) {
      return result
    }
    // 3. 命令 hook 校验失败时追加期望 schema，帮助用户修正脚本输出。
    const errorMessage = `${result.validationError}\n\nExpected schema:\n${jsonStringify(
      {
        continue: 'boolean (optional)',
        suppressOutput: 'boolean (optional)',
        stopReason: 'string (optional)',
        decision: '"approve" | "block" (optional)',
        reason: 'string (optional)',
        systemMessage: 'string (optional)',
        permissionDecision: '"allow" | "deny" | "ask" (optional)',
        hookSpecificOutput: {
          'for PreToolUse': {
            hookEventName: '"PreToolUse"',
            permissionDecision: '"allow" | "deny" | "ask" (optional)',
            permissionDecisionReason: 'string (optional)',
            updatedInput: 'object (optional) - Modified tool input to use',
          },
          'for UserPromptSubmit': {
            hookEventName: '"UserPromptSubmit"',
            additionalContext: 'string (required)',
          },
          'for PostToolUse': {
            hookEventName: '"PostToolUse"',
            additionalContext: 'string (optional)',
          },
        },
      },
      null,
      2,
    )}`
    logForDebugging(errorMessage)
    return { plainText: stdout, validationError: errorMessage }
  } catch (e) {
    // 4. JSON 解析异常不阻断流程，降级为普通文本输出。
    logForDebugging(`Failed to parse hook output as JSON: ${e}`)
    return { plainText: stdout }
  }
}

/**
 * 解析 HTTP hook 的响应体。
 *
 * @param body HTTP hook 返回的响应体文本。
 * @returns 合法 JSON 输出或校验错误；HTTP hook 不接受普通文本协议。
 */
function parseHttpHookOutput(body: string): {
  json?: HookJSONOutput
  validationError?: string
} {
  const trimmed = body.trim()

  // 1. 空响应体等价于空 JSON 对象，允许 HTTP hook 只表示成功。
  if (trimmed === '') {
    const validation = hookJSONOutputSchema().safeParse({})
    if (validation.success) {
      logForDebugging(
        'HTTP hook returned empty body, treating as empty JSON object',
      )
      return { json: validation.data }
    }
  }

  // 2. HTTP hook 必须返回 JSON，非 JSON 响应直接作为协议错误。
  if (!trimmed.startsWith('{')) {
    const validationError = `HTTP hook must return JSON, but got non-JSON response body: ${trimmed.length > 200 ? trimmed.slice(0, 200) + '\u2026' : trimmed}`
    logForDebugging(validationError)
    return { validationError }
  }

  try {
    // 3. 对 JSON 响应做统一 schema 校验。
    const result = validateHookJson(trimmed)
    if ('json' in result) {
      return result
    }
    logForDebugging(result.validationError)
    return result
  } catch (e) {
    // 4. JSON 解析失败时返回可展示的校验错误。
    const validationError = `HTTP hook must return valid JSON, but parsing failed: ${e}`
    logForDebugging(validationError)
    return { validationError }
  }
}

/**
 * 把同步 hook 的 JSON 输出转换为内部 HookResult 字段。
 *
 * @param param0 hook JSON、命令信息、事件类型、输出和耗时等执行上下文。
 * @returns 可合并进 HookResult 的局部结果。
 */
function processHookJSONOutput({
  json,
  command,
  hookName,
  toolUseID,
  hookEvent,
  expectedHookEvent,
  stdout,
  stderr,
  exitCode,
  durationMs,
}: {
  json: SyncHookJSONOutput
  command: string
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  expectedHookEvent?: HookEvent
  stdout?: string
  stderr?: string
  exitCode?: number
  durationMs?: number
}): Partial<HookResult> {
  const result: Partial<HookResult> = {}

  // 1. 进入本函数时已经确认这是同步响应。
  const syncJson = json

  // 2. 处理通用控制字段，例如是否继续和停止原因。
  if (syncJson.continue === false) {
    result.preventContinuation = true
    if (syncJson.stopReason) {
      result.stopReason = syncJson.stopReason
    }
  }

  // 3. 处理旧版 decision 字段，把 approve/block 映射为权限 allow/deny。
  if (json.decision) {
    switch (json.decision) {
      case 'approve':
        result.permissionBehavior = 'allow'
        break
      case 'block':
        result.permissionBehavior = 'deny'
        result.blockingError = {
          blockingError: json.reason || 'Blocked by hook',
          command,
        }
        break
      default:
        // 4. 未知 decision 类型说明 hook 协议不合法，需要抛错暴露配置问题。
        throw new Error(
          `Unknown hook decision type: ${json.decision}. Valid types are: approve, block`,
        )
    }
  }

  // 5. 透传 hook 想注入的系统消息。
  if (json.systemMessage) {
    result.systemMessage = json.systemMessage
  }

  // 6. 处理 PreToolUse 专属的权限决策字段。
  if (
    json.hookSpecificOutput?.hookEventName === 'PreToolUse' &&
    json.hookSpecificOutput.permissionDecision
  ) {
    switch (json.hookSpecificOutput.permissionDecision) {
      case 'allow':
        result.permissionBehavior = 'allow'
        break
      case 'deny':
        result.permissionBehavior = 'deny'
        result.blockingError = {
          blockingError: json.reason || 'Blocked by hook',
          command,
        }
        break
      case 'ask':
        result.permissionBehavior = 'ask'
        break
      default:
        // 7. 未知 permissionDecision 类型同样视为协议错误。
        throw new Error(
          `Unknown hook permissionDecision type: ${json.hookSpecificOutput.permissionDecision}. Valid types are: allow, deny, ask`,
        )
    }
  }
  if (result.permissionBehavior !== undefined && json.reason !== undefined) {
    result.hookPermissionDecisionReason = json.reason
  }

  // 8. 处理按事件细分的 hookSpecificOutput。
  if (json.hookSpecificOutput) {
    // 9. 如果调用方声明了期望事件，hook 输出必须和该事件一致。
    if (
      expectedHookEvent &&
      json.hookSpecificOutput.hookEventName !== expectedHookEvent
    ) {
      throw new Error(
        `Hook returned incorrect event name: expected '${expectedHookEvent}' but got '${json.hookSpecificOutput.hookEventName}'. Full stdout: ${jsonStringify(json, null, 2)}`,
      )
    }

    switch (json.hookSpecificOutput.hookEventName) {
      case 'PreToolUse':
        // 10. PreToolUse 可以用更具体的 permissionDecision 覆盖通用 decision。
        if (json.hookSpecificOutput.permissionDecision) {
          switch (json.hookSpecificOutput.permissionDecision) {
            case 'allow':
              result.permissionBehavior = 'allow'
              break
            case 'deny':
              result.permissionBehavior = 'deny'
              result.blockingError = {
                blockingError:
                  json.hookSpecificOutput.permissionDecisionReason ||
                  json.reason ||
                  'Blocked by hook',
                command,
              }
              break
            case 'ask':
              result.permissionBehavior = 'ask'
              break
          }
        }
        result.hookPermissionDecisionReason =
          json.hookSpecificOutput.permissionDecisionReason
        // 11. PreToolUse 可返回修改后的工具输入。
        if (json.hookSpecificOutput.updatedInput) {
          result.updatedInput = json.hookSpecificOutput.updatedInput
        }
        // 12. PreToolUse 还可以追加给后续模型可见的上下文。
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'UserPromptSubmit':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'SessionStart':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        result.initialUserMessage = json.hookSpecificOutput.initialUserMessage
        if (
          'watchPaths' in json.hookSpecificOutput &&
          json.hookSpecificOutput.watchPaths
        ) {
          result.watchPaths = json.hookSpecificOutput.watchPaths
        }
        break
      case 'Setup':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'SubagentStart':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'PostToolUse':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        // 13. PostToolUse 可以改写后续看到的 MCP 工具输出。
        if (json.hookSpecificOutput.updatedMCPToolOutput) {
          result.updatedMCPToolOutput =
            json.hookSpecificOutput.updatedMCPToolOutput
        }
        break
      case 'PostToolUseFailure':
        result.additionalContext = json.hookSpecificOutput.additionalContext
        break
      case 'PermissionDenied':
        result.retry = json.hookSpecificOutput.retry
        break
      case 'PermissionRequest':
        // 14. PermissionRequest 的决策会同时更新结构化结果和通用权限行为。
        if (json.hookSpecificOutput.decision) {
          result.permissionRequestResult = json.hookSpecificOutput.decision
          result.permissionBehavior =
            json.hookSpecificOutput.decision.behavior === 'allow'
              ? 'allow'
              : 'deny'
          if (
            json.hookSpecificOutput.decision.behavior === 'allow' &&
            json.hookSpecificOutput.decision.updatedInput
          ) {
            result.updatedInput = json.hookSpecificOutput.decision.updatedInput
          }
        }
        break
      case 'Elicitation':
        // 15. Elicitation hook 可直接给出用户征询响应；decline 会转成阻塞结果。
        if (json.hookSpecificOutput.action) {
          result.elicitationResponse = {
            action: json.hookSpecificOutput.action,
            content: json.hookSpecificOutput.content as
              | ElicitationResponse['content']
              | undefined,
          }
          if (json.hookSpecificOutput.action === 'decline') {
            result.blockingError = {
              blockingError: json.reason || 'Elicitation denied by hook',
              command,
            }
          }
        }
        break
      case 'ElicitationResult':
        // 16. ElicitationResult hook 可审查征询结果；decline 会阻断继续处理。
        if (json.hookSpecificOutput.action) {
          result.elicitationResultResponse = {
            action: json.hookSpecificOutput.action,
            content: json.hookSpecificOutput.content as
              | ElicitationResponse['content']
              | undefined,
          }
          if (json.hookSpecificOutput.action === 'decline') {
            result.blockingError = {
              blockingError:
                json.reason || 'Elicitation result blocked by hook',
              command,
            }
          }
        }
        break
    }
  }

  // 17. 根据是否阻塞生成对应附件消息；成功 JSON 输出的正文留空，避免重复噪声。
  return {
    ...result,
    message: result.blockingError
      ? createAttachmentMessage({
          type: 'hook_blocking_error',
          hookName,
          toolUseID,
          hookEvent,
          blockingError: result.blockingError,
        })
      : createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID,
          hookEvent,
          // 18. JSON 输出 hook 的上下文走 additionalContext；这里留空可避免无意义成功提示污染对话。
          content: '',
          stdout,
          stderr,
          exitCode,
          command,
          durationMs,
        }),
  }
}

/**
 * 使用 bash 或 PowerShell 执行命令型 hook。
 *
 * @param hook 命令型 hook 配置。
 * @param hookEvent 当前触发的 hook 事件，也可包含状态栏和文件建议这类特殊事件。
 * @param hookName 用于日志、进度和展示的 hook 名称。
 * @param jsonInput 序列化后的 hook 输入 JSON。
 * @param signal 取消信号，用于中止进程。
 * @param hookId 当前 hook 执行实例 ID。
 * @param hookIndex 同一事件下的 hook 序号，可用于环境文件命名。
 * @param pluginRoot 插件根目录；插件 hook 需要它做变量替换和环境变量。
 * @param pluginId 插件标识；用于插件数据目录和用户配置读取。
 * @param skillRoot 技能根目录；技能 hook 会复用插件根目录环境变量名。
 * @param forceSyncExecution 是否强制等待异步 hook 完整结束。
 * @param requestPrompt 可选交互回调，用于处理 hook 输出的 prompt 请求。
 * @returns hook 进程的 stdout、stderr、合并输出、退出码和异步/取消状态。
 */
async function execCommandHook(
  hook: HookCommand & { type: 'command' },
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion',
  hookName: string,
  jsonInput: string,
  signal: AbortSignal,
  hookId: string,
  hookIndex?: number,
  pluginRoot?: string,
  pluginId?: string,
  skillRoot?: string,
  forceSyncExecution?: boolean,
  requestPrompt?: (request: PromptRequest) => Promise<PromptResponse>,
): Promise<{
  stdout: string
  stderr: string
  output: string
  status: number
  aborted?: boolean
  backgrounded?: boolean
}> {
  // 1. 只对单次会话级事件输出诊断日志，避免高频工具 hook 把日志打爆。
  const shouldEmitDiag =
    hookEvent === 'SessionStart' ||
    hookEvent === 'Setup' ||
    hookEvent === 'SessionEnd'
  const diagStartMs = Date.now()
  let diagExitCode: number | undefined
  let diagAborted = false

  const isWindows = getPlatform() === 'windows'

  // 2. 按 hook.shell 选择 shell；未声明时使用默认 shell，保持历史 bash 行为。
  const shellType = hook.shell ?? DEFAULT_HOOK_SHELL

  const isPowerShell = shellType === 'powershell'

  // 3. Windows bash 使用 Git Bash，需要 POSIX 路径；PowerShell 使用平台原生路径。
  const toHookPath =
    isWindows && !isPowerShell
      ? (p: string) => windowsPathToPosixPath(p)
      : (p: string) => p

  // 4. CLAUDE_PROJECT_DIR 固定指向项目根目录，避免 worktree cwd 变化影响 hook 定位。
  const projectDir = getProjectRoot()

  // 5. 先替换插件目录变量，再替换用户配置变量，避免用户配置值被二次当成模板解释。
  let command = hook.command
  let pluginOpts: ReturnType<typeof loadPluginOptions> | undefined
  if (pluginRoot) {
    // 6. 插件目录缺失时提前失败，否则脚本找不到也可能返回协议阻塞码 2，和真实阻塞无法区分。
    if (!(await pathExists(pluginRoot))) {
      throw new Error(
        `Plugin directory does not exist: ${pluginRoot}` +
          (pluginId ? ` (${pluginId} — run /plugin to reinstall)` : ''),
      )
    }
    // 7. 内联替换插件根目录和数据目录，确保 bash/PowerShell 各自拿到正确路径格式。
    const rootPath = toHookPath(pluginRoot)
    command = command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => rootPath)
    if (pluginId) {
      const dataPath = toHookPath(getPluginDataDir(pluginId))
      command = command.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, () => dataPath)
    }
    if (pluginId) {
      pluginOpts = loadPluginOptions(pluginId)
      // 8. 用户配置缺失会抛错，由上层按 hook 执行失败统一处理。
      command = substituteUserConfigVariables(command, pluginOpts)
    }
  }

  // 9. Windows bash 路径下自动给 .sh 命令补 bash，避免系统用默认文件处理器打开脚本。
  if (isWindows && !isPowerShell && command.trim().match(/\.sh(\s|$|")/)) {
    if (!command.trim().startsWith('bash ')) {
      command = `bash ${command}`
    }
  }

  // 10. bash hook 支持 CLAUDE_CODE_SHELL_PREFIX；PowerShell 不使用 POSIX 前缀包装。
  const finalCommand =
    !isPowerShell && process.env.CLAUDE_CODE_SHELL_PREFIX
      ? formatShellPrefixCommand(process.env.CLAUDE_CODE_SHELL_PREFIX, command)
      : command

  const hookTimeoutMs = hook.timeout
    ? hook.timeout * 1000
    : TOOL_HOOK_EXECUTION_TIMEOUT_MS

  // 11. 构造子进程环境变量；所有路径按 shell 类型转换。
  const envVars: NodeJS.ProcessEnv = {
    ...subprocessEnv(),
    CLAUDE_PROJECT_DIR: toHookPath(projectDir),
  }

  // 12. 插件和技能 hook 都暴露 CLAUDE_PLUGIN_ROOT，便于技能未来迁移成插件。
  if (pluginRoot) {
    envVars.CLAUDE_PLUGIN_ROOT = toHookPath(pluginRoot)
    if (pluginId) {
      envVars.CLAUDE_PLUGIN_DATA = toHookPath(getPluginDataDir(pluginId))
    }
  }
  // 13. 插件配置也写入环境变量，hook 可不经命令模板直接读取配置值。
  if (pluginOpts) {
    for (const [key, value] of Object.entries(pluginOpts)) {
      // 14. 环境变量名只保留标识符字符，防御绕过 schema 的异常 key。
      const envKey = key.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()
      envVars[`CLAUDE_PLUGIN_OPTION_${envKey}`] = String(value)
    }
  }
  if (skillRoot) {
    envVars.CLAUDE_PLUGIN_ROOT = toHookPath(skillRoot)
  }

  // 15. bash hook 可通过 CLAUDE_ENV_FILE 持久化环境变量；PowerShell 语法不同，所以跳过。
  if (
    !isPowerShell &&
    (hookEvent === 'SessionStart' ||
      hookEvent === 'Setup' ||
      hookEvent === 'CwdChanged' ||
      hookEvent === 'FileChanged') &&
    hookIndex !== undefined
  ) {
    envVars.CLAUDE_ENV_FILE = await getHookEnvFilePath(hookEvent, hookIndex)
  }

  // 16. 启动进程前确认 cwd 仍存在；已删除 worktree 会回退到原始工作目录。
  const hookCwd = getCwd()
  const safeCwd = (await pathExists(hookCwd)) ? hookCwd : getOriginalCwd()
  if (safeCwd !== hookCwd) {
    logForDebugging(
      `Hooks: cwd ${hookCwd} not found, falling back to original cwd`,
      { level: 'warn' },
    )
  }

  // 17. 按 shell 类型启动进程：PowerShell 使用显式 argv，bash 交给 shell 解析整条命令。
  let child: ChildProcessWithoutNullStreams
  if (shellType === 'powershell') {
    const pwshPath = await getCachedPowerShellPath()
    if (!pwshPath) {
      throw new Error(
        `Hook "${hook.command}" has shell: 'powershell' but no PowerShell ` +
          `executable (pwsh or powershell) was found on PATH. Install ` +
          `PowerShell, or remove "shell": "powershell" to use bash.`,
      )
    }
    child = spawn(pwshPath, buildPowerShellArgs(finalCommand), {
      env: envVars,
      cwd: safeCwd,
      // 18. Windows 下隐藏控制台窗口，其他平台该参数无影响。
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams
  } else {
    // 19. Windows 明确使用 Git Bash；其他平台让 Node 使用默认 /bin/sh。
    const shell = isWindows ? findGitBashPath() : true
    child = spawn(finalCommand, [], {
      env: envVars,
      cwd: safeCwd,
      shell,
      // 20. Windows 下隐藏控制台窗口，避免 hook 执行弹出黑框。
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams
  }

  // 21. hook 使用 pipe 模式，把 stdout 流入 JS 才能识别首行异步协议。
  const hookTaskOutput = new TaskOutput(`hook_${child.pid}`, null)
  const shellCommand = wrapSpawn(child, signal, hookTimeoutMs, hookTaskOutput)
  // 22. 标记 ShellCommand 是否已交给异步注册表，避免 finally 中重复清理。
  let shellCommandTransferred = false
  // 23. 标记 stdin 是否已经写入，避免后续重复写导致 write after end。
  let stdinWritten = false

  if ((hook.async || hook.asyncRewake) && !forceSyncExecution) {
    const processId = `async_hook_${child.pid}`
    logForDebugging(
      `Hooks: Config-based async hook, backgrounding process ${processId}`,
    )

    // 24. 进入后台前先写入 JSON 输入，并追加换行以兼容 bash read 的行读取语义。
    child.stdin.write(jsonInput + '\n', 'utf8')
    child.stdin.end()
    stdinWritten = true

    const backgrounded = executeInBackground({
      processId,
      hookId,
      shellCommand,
      asyncResponse: { async: true, asyncTimeout: hookTimeoutMs },
      hookEvent,
      hookName,
      command: hook.command,
      asyncRewake: hook.asyncRewake,
      pluginId,
    })
    if (backgrounded) {
      return {
        stdout: '',
        stderr: '',
        output: '',
        status: 0,
        backgrounded: true,
      }
    }
  }

  let stdout = ''
  let stderr = ''
  let output = ''

  // 25. 显式按 UTF-8 读取输出，保证多语言文本和 JSON 内容稳定。
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let initialResponseChecked = false

  let asyncResolve:
    | ((result: {
        stdout: string
        stderr: string
        output: string
        status: number
      }) => void)
    | null = null
  const childIsAsyncPromise = new Promise<{
    stdout: string
    stderr: string
    output: string
    status: number
    aborted?: boolean
  }>(resolve => {
    asyncResolve = resolve
  })

  // 26. 记录已处理的 prompt 请求行，后续从最终 stdout 中剔除，避免协议行泄露给普通解析。
  const processedPromptLines = new Set<string>()
  // 27. 串行化 prompt 响应，保证 hook 收到的回答顺序和请求顺序一致。
  let promptChain = Promise.resolve()
  // 28. 维护行缓冲区，用于从流式 stdout 中识别完整 JSON 请求行。
  let lineBuffer = ''

  child.stdout.on('data', data => {
    stdout += data
    output += data

    // 29. 如果提供交互回调，就逐行解析 stdout 中的 prompt 请求。
    if (requestPrompt) {
      lineBuffer += data
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? '' // 30. 最后一段可能是不完整行，留到下一次 data 事件继续拼接。

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        try {
          const parsed = jsonParse(trimmed)
          const validation = promptRequestSchema().safeParse(parsed)
          if (validation.success) {
            processedPromptLines.add(trimmed)
            logForDebugging(
              `Hooks: Detected prompt request from hook: ${trimmed}`,
            )
            // 31. 将 prompt 响应接到 promise 链上，避免并发写 stdin。
            const promptReq = validation.data
            const reqPrompt = requestPrompt
            promptChain = promptChain.then(async () => {
              try {
                const response = await reqPrompt(promptReq)
                child.stdin.write(jsonStringify(response) + '\n', 'utf8')
              } catch (err) {
                logForDebugging(`Hooks: Prompt request handling failed: ${err}`)
                // 32. 用户取消或 prompt 失败时关闭 stdin，避免 hook 一直等待输入。
                child.stdin.destroy()
              }
            })
            continue
          }
        } catch {
          // 33. 非 JSON 行只是普通输出，继续等待后续内容。
        }
      }
    }

    // 34. 只解析首行异步协议；如果把后续普通输出一起解析，会导致快速进程无法正确后台化。
    if (!initialResponseChecked) {
      const firstLine = firstLineOf(stdout).trim()
      if (!firstLine.includes('}')) return
      initialResponseChecked = true
      logForDebugging(`Hooks: Checking first line for async: ${firstLine}`)
      try {
        const parsed = jsonParse(firstLine)
        logForDebugging(
          `Hooks: Parsed initial response: ${jsonStringify(parsed)}`,
        )
        if (isAsyncHookJSONOutput(parsed) && !forceSyncExecution) {
          const processId = `async_hook_${child.pid}`
          logForDebugging(
            `Hooks: Detected async hook, backgrounding process ${processId}`,
          )

          const backgrounded = executeInBackground({
            processId,
            hookId,
            shellCommand,
            asyncResponse: parsed,
            hookEvent,
            hookName,
            command: hook.command,
            pluginId,
          })
          if (backgrounded) {
            shellCommandTransferred = true
            asyncResolve?.({
              stdout,
              stderr,
              output,
              status: 0,
            })
          }
        } else if (isAsyncHookJSONOutput(parsed) && forceSyncExecution) {
          logForDebugging(
            `Hooks: Detected async hook but forceSyncExecution is true, waiting for completion`,
          )
        } else {
          logForDebugging(
            `Hooks: Initial response is not async, continuing normal processing`,
          )
        }
      } catch (e) {
        logForDebugging(`Hooks: Failed to parse initial response as JSON: ${e}`)
      }
    }
  })

  child.stderr.on('data', data => {
    stderr += data
    output += data
  })

  const stopProgressInterval = startHookProgressInterval({
    hookId,
    hookName,
    hookEvent,
    getOutput: async () => ({ stdout, stderr, output }),
  })

  // 35. 等 stdout/stderr 流真正结束，避免 close 先到导致输出不完整。
  const stdoutEndPromise = new Promise<void>(resolve => {
    child.stdout.on('end', () => resolve())
  })

  const stderrEndPromise = new Promise<void>(resolve => {
    child.stderr.on('end', () => resolve())
  })

  // 36. 写入 hook 输入时处理 EPIPE；配置型异步 hook 已写过 stdin 时直接跳过。
  const stdinWritePromise = stdinWritten
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        child.stdin.on('error', err => {
          // 37. prompt 流程中 stdin 会保持打开，进程提前退出后的 EPIPE 属于预期噪声。
          if (!requestPrompt) {
            reject(err)
          } else {
            logForDebugging(
              `Hooks: stdin error during prompt flow (likely process exited): ${err}`,
            )
          }
        })
        // 38. 明确使用 UTF-8 写入 JSON 输入，避免 Unicode 内容被错误编码。
        child.stdin.write(jsonInput + '\n', 'utf8')
        // 39. 没有交互 prompt 时立即关闭 stdin；有 prompt 时继续等待后续回答。
        if (!requestPrompt) {
          child.stdin.end()
        }
        resolve()
      })

  // 40. 子进程 error 事件单独建 promise，参与后面的竞速等待。
  const childErrorPromise = new Promise<never>((_, reject) => {
    child.on('error', reject)
  })

  // 41. close 事件到达后仍等待输出流结束，再解析最终 stdout/stderr。
  const childClosePromise = new Promise<{
    stdout: string
    stderr: string
    output: string
    status: number
    aborted?: boolean
  }>(resolve => {
    let exitCode: number | null = null

    child.on('close', code => {
      exitCode = code ?? 1

      // 42. stdout/stderr 都结束后才形成最终结果。
      void Promise.all([stdoutEndPromise, stderrEndPromise]).then(() => {
        // 43. 剔除已消费的 prompt 请求行，让后续 hook 输出解析只看到真正结果。
        const finalStdout =
          processedPromptLines.size === 0
            ? stdout
            : stdout
                .split('\n')
                .filter(line => !processedPromptLines.has(line.trim()))
                .join('\n')

        resolve({
          stdout: finalStdout,
          stderr,
          output,
          status: exitCode!,
          aborted: signal.aborted,
        })
      })
    })
  })

  // 44. 在输入写入、异步识别和进程完成之间竞速，谁先决定结果就先返回。
  try {
    if (shouldEmitDiag) {
      logForDiagnosticsNoPII('info', 'hook_spawn_started', {
        hook_event_name: hookEvent,
        index: hookIndex,
      })
    }
    await Promise.race([stdinWritePromise, childErrorPromise])

    // 45. 等待异步协议、进程关闭或进程错误中的任一结果。
    const result = await Promise.race([
      childIsAsyncPromise,
      childClosePromise,
      childErrorPromise,
    ])
    // 46. 返回前确保所有排队的 prompt 响应都已写出。
    await promptChain
    diagExitCode = result.status
    diagAborted = result.aborted ?? false
    return result
  } catch (error) {
    // 47. 统一处理 stdin 写入或子进程启动/运行错误。
    const code = getErrnoCode(error)
    diagExitCode = 1

    if (code === 'EPIPE') {
      logForDebugging(
        'EPIPE error while writing to hook stdin (hook command likely closed early)',
      )
      const errMsg =
        'Hook command closed stdin before hook input was fully written (EPIPE)'
      return {
        stdout: '',
        stderr: errMsg,
        output: errMsg,
        status: 1,
      }
    } else if (code === 'ABORT_ERR') {
      diagAborted = true
      return {
        stdout: '',
        stderr: 'Hook cancelled',
        output: 'Hook cancelled',
        status: 1,
        aborted: true,
      }
    } else {
      const errorMsg = errorMessage(error)
      const errOutput = `Error occurred while executing hook command: ${errorMsg}`
      return {
        stdout: '',
        stderr: errOutput,
        output: errOutput,
        status: 1,
      }
    }
  } finally {
    if (shouldEmitDiag) {
      logForDiagnosticsNoPII('info', 'hook_spawn_completed', {
        hook_event_name: hookEvent,
        index: hookIndex,
        duration_ms: Date.now() - diagStartMs,
        exit_code: diagExitCode,
        aborted: diagAborted,
      })
    }
    stopProgressInterval()
    // 48. 未转交给异步注册表时，当前函数负责释放流资源。
    if (!shellCommandTransferred) {
      shellCommand.cleanup()
    }
  }
}

/**
 * 判断 hook 匹配器是否命中当前查询值。
 *
 * @param matchQuery 当前事件提取出的匹配值，例如工具名或事件来源。
 * @param matcher hook 配置中的匹配模式；支持精确值、竖线分隔的多值和正则表达式。
 * @returns true 表示命中该匹配器；false 表示不命中或正则无效。
 */
function matchesPattern(matchQuery: string, matcher: string): boolean {
  if (!matcher || matcher === '*') {
    return true
  }
  // 1. 没有正则特殊字符时，按简单字符串或竖线分隔列表处理。
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    // 2. 竖线分隔表示多个精确匹配值。
    if (matcher.includes('|')) {
      const patterns = matcher
        .split('|')
        .map(p => normalizeLegacyToolName(p.trim()))
      return patterns.includes(matchQuery)
    }
    // 3. 单个值直接和规范化后的工具名比较。
    return matchQuery === normalizeLegacyToolName(matcher)
  }

  // 4. 其他模式按正则表达式处理。
  try {
    const regex = new RegExp(matcher)
    if (regex.test(matchQuery)) {
      return true
    }
    // 5. 兼容旧工具名，让旧正则仍能匹配到新工具名对应的别名。
    for (const legacyName of getLegacyToolNames(matchQuery)) {
      if (regex.test(legacyName)) {
        return true
      }
    }
    return false
  } catch {
    // 6. 正则无效时记录诊断并当作不匹配。
    logForDebugging(`Invalid regex pattern in hook matcher: ${matcher}`)
    return false
  }
}

/**
 * hook if 条件的匹配函数类型。
 *
 * 场景：预先准备好工具输入和权限匹配器后，对每个 hook 的 if 表达式做快速判断。
 */
type IfConditionMatcher = (ifCondition: string) => boolean

/**
 * 准备 hook if 条件匹配器。
 *
 * @param hookInput 当前 hook 输入。
 * @param tools 当前可用工具集合；工具事件会用它校验工具输入并构造权限匹配器。
 * @returns 可复用的 if 条件匹配函数；非工具事件返回 undefined。
 */
async function prepareIfConditionMatcher(
  hookInput: HookInput,
  tools: Tools | undefined,
): Promise<IfConditionMatcher | undefined> {
  // 1. 只有带工具名和工具输入的事件才支持 if 条件匹配。
  if (
    hookInput.hook_event_name !== 'PreToolUse' &&
    hookInput.hook_event_name !== 'PostToolUse' &&
    hookInput.hook_event_name !== 'PostToolUseFailure' &&
    hookInput.hook_event_name !== 'PermissionRequest'
  ) {
    return undefined
  }

  // 2. 提前解析工具输入并构造路径/规则匹配器，避免每个 hook 重复做昂贵工作。
  const toolName = normalizeLegacyToolName(hookInput.tool_name)
  const tool = tools && findToolByName(tools, hookInput.tool_name)
  const input = tool?.inputSchema.safeParse(hookInput.tool_input)
  const patternMatcher =
    input?.success && tool?.preparePermissionMatcher
      ? await tool.preparePermissionMatcher(input.data)
      : undefined

  return ifCondition => {
    // 3. if 条件中的工具名必须和当前事件工具一致。
    const parsed = permissionRuleValueFromString(ifCondition)
    if (normalizeLegacyToolName(parsed.toolName) !== toolName) {
      return false
    }
    if (!parsed.ruleContent) {
      return true
    }
    // 4. 带规则内容时，交给工具自己的权限匹配器判断。
    return patternMatcher ? patternMatcher(parsed.ruleContent) : false
  }
}

/**
 * function hook 的匹配器结构。
 *
 * 场景：会话内注册的函数型 hook 不能持久化成普通 HookMatcher，需要单独保存回调数组。
 */
type FunctionHookMatcher = {
  matcher: string
  hooks: FunctionHook[]
}

/**
 * 附带来源上下文的匹配后 hook。
 *
 * 场景：执行插件或技能 hook 时，需要保留根目录、插件 ID 和来源名称来注入环境变量和日志。
 */
type MatchedHook = {
  hook: HookCommand | HookCallback | FunctionHook
  pluginRoot?: string
  pluginId?: string
  skillRoot?: string
  hookSource?: string
}

/**
 * 判断匹配结果是否为内部 callback hook。
 *
 * @param matched 已匹配的 hook 及来源上下文。
 * @returns true 表示该 hook 是内部 callback，可走更快路径。
 */
function isInternalHook(matched: MatchedHook): boolean {
  return matched.hook.type === 'callback' && matched.hook.internal === true
}

/**
 * 构造带来源命名空间的 hook 去重键。
 *
 * @param m 已匹配的 hook 及来源上下文。
 * @param payload 参与去重的 hook 内容，例如命令、URL 或 prompt。
 * @returns 可放入 Map 的去重键。
 */
function hookDedupKey(m: MatchedHook, payload: string): string {
  return `${m.pluginRoot ?? m.skillRoot ?? ''}\0${payload}`
}

/**
 * 统计匹配 hook 中各插件的 hook 数量。
 *
 * @param hooks 已匹配的 hook 列表。
 * @returns 插件名到 hook 数量的映射；非官方插件统一归为 third-party。
 */
function getPluginHookCounts(
  hooks: MatchedHook[],
): Record<string, number> | undefined {
  const pluginHooks = hooks.filter(h => h.pluginId)
  if (pluginHooks.length === 0) {
    return undefined
  }
  const counts: Record<string, number> = {}
  for (const h of pluginHooks) {
    const atIndex = h.pluginId!.lastIndexOf('@')
    const isOfficial =
      atIndex > 0 &&
      ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(h.pluginId!.slice(atIndex + 1))
    const key = isOfficial ? h.pluginId! : 'third-party'
    counts[key] = (counts[key] || 0) + 1
  }
  return counts
}


/**
 * 统计匹配 hook 中各 hook 类型的数量。
 *
 * @param hooks 已匹配的 hook 列表。
 * @returns hook 类型到数量的映射。
 */
function getHookTypeCounts(hooks: MatchedHook[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const h of hooks) {
    counts[h.hook.type] = (counts[h.hook.type] || 0) + 1
  }
  return counts
}

/**
 * 汇总指定事件可用的 hook 配置。
 *
 * @param appState 当前应用状态；为空时只读取快照和全局注册 hook。
 * @param sessionId 当前会话或代理 ID。
 * @param hookEvent 要查询的 hook 事件。
 * @returns 来自设置快照、注册表和会话态的 hook 匹配器列表。
 */
function getHooksConfig(
  appState: AppState | undefined,
  sessionId: string,
  hookEvent: HookEvent,
): Array<
  | HookMatcher
  | HookCallbackMatcher
  | FunctionHookMatcher
  | PluginHookMatcher
  | SkillHookMatcher
  | SessionDerivedHookMatcher
> {
  // 1. 快照里的 HookMatcher 已经是可执行结构，可以直接作为基础列表。
  const hooks: Array<
    | HookMatcher
    | HookCallbackMatcher
    | FunctionHookMatcher
    | PluginHookMatcher
    | SkillHookMatcher
    | SessionDerivedHookMatcher
  > = [...(getHooksConfigFromSnapshot()?.[hookEvent] ?? [])]

  // 2. 企业托管策略可能要求只运行托管 hook。
  const managedOnly = shouldAllowManagedHooksOnly()

  // 3. 合并 SDK callback 和插件原生注册的 hook。
  const registeredHooks = getRegisteredHooks()?.[hookEvent]
  if (registeredHooks) {
    for (const matcher of registeredHooks) {
      // 4. 托管模式下跳过插件 hook，但保留 SDK callback。
      if (managedOnly && 'pluginRoot' in matcher) {
        continue
      }
      hooks.push(matcher)
    }
  }

  // 5. 合并当前会话自己的 hook，避免一个代理注册的 hook 泄漏到另一个代理。
  // 6. 托管模式或缺少 appState 时跳过会话 hook，防止 frontmatter hook 绕过策略。
  if (!managedOnly && appState !== undefined) {
    const sessionHooks = getSessionHooks(appState, sessionId, hookEvent).get(
      hookEvent,
    )
    if (sessionHooks) {
      // 7. SessionDerivedHookMatcher 已携带可选 skillRoot，可直接加入执行列表。
      for (const matcher of sessionHooks) {
        hooks.push(matcher)
      }
    }

    // 8. function hook 带闭包回调，不能持久化成普通 HookMatcher，需要单独合并。
    const sessionFunctionHooks = getSessionFunctionHooks(
      appState,
      sessionId,
      hookEvent,
    ).get(hookEvent)
    if (sessionFunctionHooks) {
      for (const matcher of sessionFunctionHooks) {
        hooks.push(matcher)
      }
    }
  }

  return hooks
}

/**
 * 快速判断指定事件是否可能存在 hook。
 *
 * @param hookEvent 要检查的 hook 事件。
 * @param appState 当前应用状态；为空时不检查会话态 hook。
 * @param sessionId 当前会话或代理 ID。
 * @returns true 表示可能存在 hook；false 表示可以安全跳过后续匹配。
 */
function hasHookForEvent(
  hookEvent: HookEvent,
  appState: AppState | undefined,
  sessionId: string,
): boolean {
  // 1. 只做轻量存在性检查，宁可误报 true，也不能误报 false 跳过 hook。
  const snap = getHooksConfigFromSnapshot()?.[hookEvent]
  if (snap && snap.length > 0) return true
  const reg = getRegisteredHooks()?.[hookEvent]
  if (reg && reg.length > 0) return true
  if (appState?.sessionHooks.get(sessionId)?.hooks[hookEvent]) return true
  return false
}

/**
 * 获取与当前 hook 输入匹配的 hook 列表。
 *
 * @param appState 当前应用状态；为空时只匹配非会话态 hook。
 * @param sessionId 当前主会话 ID 或代理 ID。
 * @param hookEvent 当前 hook 事件。
 * @param hookInput 用于提取匹配查询值和 if 条件的 hook 输入。
 * @param tools 当前可用工具集合；工具事件的 if 条件会用它做输入校验。
 * @returns 附带插件或技能上下文的匹配 hook 列表。
 */
export async function getMatchingHooks(
  appState: AppState | undefined,
  sessionId: string,
  hookEvent: HookEvent,
  hookInput: HookInput,
  tools?: Tools,
): Promise<MatchedHook[]> {
  try {
    const hookMatchers = getHooksConfig(appState, sessionId, hookEvent)

    // 1. 根据事件类型提取匹配查询值；这里的规则需要和 hooksConfigManager 保持一致。
    let matchQuery: string | undefined = undefined
    switch (hookInput.hook_event_name) {
      case 'PreToolUse':
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionRequest':
      case 'PermissionDenied':
        matchQuery = hookInput.tool_name
        break
      case 'SessionStart':
        matchQuery = hookInput.source
        break
      case 'Setup':
        matchQuery = hookInput.trigger
        break
      case 'PreCompact':
      case 'PostCompact':
        matchQuery = hookInput.trigger
        break
      case 'Notification':
        matchQuery = hookInput.notification_type
        break
      case 'SessionEnd':
        matchQuery = hookInput.reason
        break
      case 'StopFailure':
        matchQuery = hookInput.error
        break
      case 'SubagentStart':
        matchQuery = hookInput.agent_type
        break
      case 'SubagentStop':
        matchQuery = hookInput.agent_type
        break
      case 'TeammateIdle':
      case 'TaskCreated':
      case 'TaskCompleted':
        break
      case 'Elicitation':
        matchQuery = hookInput.mcp_server_name
        break
      case 'ElicitationResult':
        matchQuery = hookInput.mcp_server_name
        break
      case 'ConfigChange':
        matchQuery = hookInput.source
        break
      case 'InstructionsLoaded':
        matchQuery = hookInput.load_reason
        break
      case 'FileChanged':
        matchQuery = basename(hookInput.file_path)
        break
      default:
        break
    }

    logForDebugging(
      `Getting matching hook commands for ${hookEvent} with query: ${matchQuery}`,
      { level: 'verbose' },
    )
    logForDebugging(`Found ${hookMatchers.length} hook matchers in settings`, {
      level: 'verbose',
    })

    // 2. 先按 matcher 过滤，再保留插件/技能来源上下文。
    const filteredMatchers = matchQuery
      ? hookMatchers.filter(
          matcher =>
            !matcher.matcher || matchesPattern(matchQuery, matcher.matcher),
        )
      : hookMatchers

    const matchedHooks: MatchedHook[] = filteredMatchers.flatMap(matcher => {
      // 3. 根据 matcher 上的 root 字段判断来源是插件、技能还是普通设置。
      const pluginRoot =
        'pluginRoot' in matcher ? matcher.pluginRoot : undefined
      const pluginId = 'pluginId' in matcher ? matcher.pluginId : undefined
      const skillRoot = 'skillRoot' in matcher ? matcher.skillRoot : undefined
      const hookSource = pluginRoot
        ? 'pluginName' in matcher
          ? `plugin:${matcher.pluginName}`
          : 'plugin'
        : skillRoot
          ? 'skillName' in matcher
            ? `skill:${matcher.skillName}`
            : 'skill'
          : 'settings'
      return matcher.hooks.map(hook => ({
        hook,
        pluginRoot,
        pluginId,
        skillRoot,
        hookSource,
      }))
    })

    // 4. callback/function hook 天然唯一；如果全是这类 hook，就跳过后面的去重成本。
    if (
      matchedHooks.every(
        m => m.hook.type === 'callback' || m.hook.type === 'function',
      )
    ) {
      return matchedHooks
    }

    // 5. if 条件属于 hook 身份的一部分；条件不同即使命令相同也不能去重。
    const getIfCondition = (hook: { if?: string }): string => hook.if ?? ''

    const uniqueCommandHooks = Array.from(
      new Map(
        matchedHooks
          .filter(
            (
              m,
            ): m is MatchedHook & { hook: HookCommand & { type: 'command' } } =>
              m.hook.type === 'command',
          )
          // 6. shell 类型也参与命令 hook 身份；bash 和 PowerShell 同命令不是同一个 hook。
          .map(m => [
            hookDedupKey(
              m,
              `${m.hook.shell ?? DEFAULT_HOOK_SHELL}\0${m.hook.command}\0${getIfCondition(m.hook)}`,
            ),
            m,
          ]),
      ).values(),
    )
    const uniquePromptHooks = Array.from(
      new Map(
        matchedHooks
          .filter(m => m.hook.type === 'prompt')
          .map(m => [
            hookDedupKey(
              m,
              `${(m.hook as { prompt: string }).prompt}\0${getIfCondition(m.hook as { if?: string })}`,
            ),
            m,
          ]),
      ).values(),
    )
    const uniqueAgentHooks = Array.from(
      new Map(
        matchedHooks
          .filter(m => m.hook.type === 'agent')
          .map(m => [
            hookDedupKey(
              m,
              `${(m.hook as { prompt: string }).prompt}\0${getIfCondition(m.hook as { if?: string })}`,
            ),
            m,
          ]),
      ).values(),
    )
    const uniqueHttpHooks = Array.from(
      new Map(
        matchedHooks
          .filter(m => m.hook.type === 'http')
          .map(m => [
            hookDedupKey(
              m,
              `${(m.hook as { url: string }).url}\0${getIfCondition(m.hook as { if?: string })}`,
            ),
            m,
          ]),
      ).values(),
    )
    const callbackHooks = matchedHooks.filter(m => m.hook.type === 'callback')
    // 7. function hook 的回调实例唯一，不需要按内容去重。
    const functionHooks = matchedHooks.filter(m => m.hook.type === 'function')
    const uniqueHooks = [
      ...uniqueCommandHooks,
      ...uniquePromptHooks,
      ...uniqueAgentHooks,
      ...uniqueHttpHooks,
      ...callbackHooks,
      ...functionHooks,
    ]

    // 8. 再按 if 条件过滤 hook，避免不相关命令也启动进程。
    const hasIfCondition = uniqueHooks.some(
      h =>
        (h.hook.type === 'command' ||
          h.hook.type === 'prompt' ||
          h.hook.type === 'agent' ||
          h.hook.type === 'http') &&
        (h.hook as { if?: string }).if,
    )
    const ifMatcher = hasIfCondition
      ? await prepareIfConditionMatcher(hookInput, tools)
      : undefined
    const ifFilteredHooks = uniqueHooks.filter(h => {
      if (
        h.hook.type !== 'command' &&
        h.hook.type !== 'prompt' &&
        h.hook.type !== 'agent' &&
        h.hook.type !== 'http'
      ) {
        return true
      }
      const ifCondition = (h.hook as { if?: string }).if
      if (!ifCondition) {
        return true
      }
      if (!ifMatcher) {
        logForDebugging(
          `Hook if condition "${ifCondition}" cannot be evaluated for non-tool event ${hookInput.hook_event_name}`,
        )
        return false
      }
      if (ifMatcher(ifCondition)) {
        return true
      }
      logForDebugging(
        `Skipping hook due to if condition "${ifCondition}" not matching`,
      )
      return false
    })

    // 9. SessionStart/Setup 阶段不支持 HTTP hook，避免无头模式下结构化输入消费者尚未启动造成死锁。
    const filteredHooks =
      hookEvent === 'SessionStart' || hookEvent === 'Setup'
        ? ifFilteredHooks.filter(h => {
            if (h.hook.type === 'http') {
              logForDebugging(
                `Skipping HTTP hook ${(h.hook as { url: string }).url} — HTTP hooks are not supported for ${hookEvent}`,
              )
              return false
            }
            return true
          })
        : ifFilteredHooks

    logForDebugging(
      `Matched ${filteredHooks.length} unique hooks for query "${matchQuery || 'no match query'}" (${matchedHooks.length} before deduplication)`,
      { level: 'verbose' },
    )
    return filteredHooks
  } catch {
    return []
  }
}

/**
 * 格式化 PreTool hook 的阻塞错误。
 *
 * @param hookName hook 展示名，例如 PreToolUse:Write。
 * @param blockingError hook 返回的阻塞错误。
 * @returns 传给调用方或模型的阻塞提示文本。
 */
export function getPreToolHookBlockingMessage(
  hookName: string,
  blockingError: HookBlockingError,
): string {
  return `${hookName} hook error: ${blockingError.blockingError}`
}

/**
 * 格式化 Stop hook 的反馈消息。
 *
 * @param blockingError hook 返回的阻塞错误。
 * @returns 反馈给模型的 Stop hook 文本。
 */
export function getStopHookMessage(blockingError: HookBlockingError): string {
  return `Stop hook feedback:\n${blockingError.blockingError}`
}

/**
 * 格式化 TeammateIdle hook 的反馈消息。
 *
 * @param blockingError hook 返回的阻塞错误。
 * @returns 反馈给模型的 TeammateIdle 文本。
 */
export function getTeammateIdleHookMessage(
  blockingError: HookBlockingError,
): string {
  return `TeammateIdle hook feedback:\n${blockingError.blockingError}`
}

/**
 * 格式化 TaskCreated hook 的反馈消息。
 *
 * @param blockingError hook 返回的阻塞错误。
 * @returns 反馈给模型的 TaskCreated 文本。
 */
export function getTaskCreatedHookMessage(
  blockingError: HookBlockingError,
): string {
  return `TaskCreated hook feedback:\n${blockingError.blockingError}`
}

/**
 * 格式化 TaskCompleted hook 的反馈消息。
 *
 * @param blockingError hook 返回的阻塞错误。
 * @returns 反馈给模型的 TaskCompleted 文本。
 */
export function getTaskCompletedHookMessage(
  blockingError: HookBlockingError,
): string {
  return `TaskCompleted hook feedback:\n${blockingError.blockingError}`
}

/**
 * 格式化 UserPromptSubmit hook 的阻塞消息。
 *
 * @param blockingError hook 返回的阻塞错误。
 * @returns 展示给调用方的用户提交阻塞文本。
 */
export function getUserPromptSubmitHookBlockingMessage(
  blockingError: HookBlockingError,
): string {
  return `UserPromptSubmit operation blocked by hook:\n${blockingError.blockingError}`
}
/**
 * 执行 REPL 内 hook 的通用流程。
 *
 * @param param0 hook 输入、匹配条件、超时、上下文和交互回调等执行参数。
 * @returns 异步生成器，逐步产出进度消息、阻塞状态、权限决策和上下文更新。
 */
async function* executeHooks({
  hookInput,
  toolUseID,
  matchQuery,
  signal,
  timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  toolUseContext,
  messages,
  forceSyncExecution,
  requestPrompt,
  toolInputSummary,
}: {
  hookInput: HookInput
  toolUseID: string
  matchQuery?: string
  signal?: AbortSignal
  timeoutMs?: number
  toolUseContext?: ToolUseContext
  messages?: Message[]
  forceSyncExecution?: boolean
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>
  toolInputSummary?: string | null
}): AsyncGenerator<AggregatedHookResult> {
  // 1. 全局禁用 hook 或简单模式下直接跳过。
  if (shouldDisableAllHooksIncludingManaged()) {
    return
  }

  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return
  }

  const hookEvent = hookInput.hook_event_name
  const hookName = matchQuery ? `${hookEvent}:${matchQuery}` : hookEvent

  // 2. 绑定交互回调的 hook 名称和工具输入摘要，方便 UI 展示提问来源。
  const boundRequestPrompt = requestPrompt?.(hookName, toolInputSummary)

  // 3. 交互模式下所有 hook 都必须通过工作区信任检查。
  if (shouldSkipHookDueToTrust()) {
    logForDebugging(
      `Skipping ${hookName} hook execution - workspace trust not accepted`,
    )
    return
  }

  const appState = toolUseContext ? toolUseContext.getAppState() : undefined
  // 4. 优先使用代理会话 ID，避免子代理 hook 和主会话 hook 混用。
  const sessionId = toolUseContext?.agentId ?? getSessionId()
  const matchingHooks = await getMatchingHooks(
    appState,
    sessionId,
    hookEvent,
    hookInput,
    toolUseContext?.options?.tools,
  )
  if (matchingHooks.length === 0) {
    return
  }

  if (signal?.aborted) {
    return
  }

  const userHooks = matchingHooks.filter(h => !isInternalHook(h))
  if (userHooks.length > 0) {
    // 5. 只对用户可见 hook 记录分析事件，内部 callback 不计入用户 hook 数量。
    const pluginHookCounts = getPluginHookCounts(userHooks)
    const hookTypeCounts = getHookTypeCounts(userHooks)
    logEvent(`tengu_run_hook`, {
      hookName:
        hookName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      numCommands: userHooks.length,
      hookTypeCounts: jsonStringify(
        hookTypeCounts,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(pluginHookCounts && {
        pluginHookCounts: jsonStringify(
          pluginHookCounts,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    })
  } else {
    // 6. 全是内部 callback 时走快速路径，跳过 span、进度、输出解析和聚合循环。
    const batchStartTime = Date.now()
    const context = toolUseContext
      ? {
          getAppState: toolUseContext.getAppState,
          updateAttributionState: toolUseContext.updateAttributionState,
        }
      : undefined
    for (const [i, { hook }] of matchingHooks.entries()) {
      if (hook.type === 'callback') {
        await hook.callback(hookInput, toolUseID, signal, i, context)
      }
    }
    const totalDurationMs = Date.now() - batchStartTime
    getStatsStore()?.observe('hook_duration_ms', totalDurationMs)
    addToTurnHookDuration(totalDurationMs)
    logEvent(`tengu_repl_hook_finished`, {
      hookName:
        hookName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      numCommands: matchingHooks.length,
      numSuccess: matchingHooks.length,
      numBlocking: 0,
      numNonBlockingError: 0,
      numCancelled: 0,
      totalDurationMs,
    })
    return
  }

  // 7. 为 beta tracing 收集 hook 定义摘要。
  const hookDefinitionsJson = isBetaTracingEnabled()
    ? jsonStringify(getHookDefinitionsForTelemetry(matchingHooks))
    : '[]'

  // 8. beta tracing 开启时记录 hook 批次开始事件。
  if (isBetaTracingEnabled()) {
    void logOTelEvent('hook_execution_start', {
      hook_event: hookEvent,
      hook_name: hookName,
      num_hooks: String(matchingHooks.length),
      managed_only: String(shouldAllowManagedHooksOnly()),
      hook_definitions: hookDefinitionsJson,
      hook_source: shouldAllowManagedHooksOnly() ? 'policySettings' : 'merged',
    })
  }

  // 9. 为 hook 批次开启 tracing span。
  const hookSpan = startHookSpan(
    hookEvent,
    hookName,
    matchingHooks.length,
    hookDefinitionsJson,
  )

  // 10. 执行前先产出每个 hook 的进度消息。
  for (const { hook } of matchingHooks) {
    yield {
      message: {
        type: 'progress',
        data: {
          type: 'hook_progress',
          hookEvent,
          hookName,
          command: getHookDisplayText(hook),
          ...(hook.type === 'prompt' && { promptText: hook.prompt }),
          ...('statusMessage' in hook &&
            hook.statusMessage != null && {
              statusMessage: hook.statusMessage,
            }),
        },
        parentToolUseID: toolUseID,
        toolUseID,
        timestamp: new Date().toISOString(),
        uuid: randomUUID(),
      },
    }
  }

  // 11. 记录整个 hook 批次的墙钟耗时。
  const batchStartTime = Date.now()

  // 12. hookInput 延迟序列化一次并复用，避免每个命令型 hook 重复 stringify。
  let jsonInputResult:
    | { ok: true; value: string }
    | { ok: false; error: unknown }
    | undefined
  /**
   * 延迟生成 hook 输入 JSON。
   *
   * @returns 序列化成功的 JSON 字符串，或序列化失败的错误对象。
   */
  function getJsonInput() {
    if (jsonInputResult !== undefined) {
      return jsonInputResult
    }
    try {
      return (jsonInputResult = { ok: true, value: jsonStringify(hookInput) })
    } catch (error) {
      logError(
        Error(`Failed to stringify hook ${hookName} input`, { cause: error }),
      )
      return (jsonInputResult = { ok: false, error })
    }
  }

  // 13. 并行执行所有匹配 hook，每个 hook 使用独立超时信号。
  const hookPromises = matchingHooks.map(async function* (
    { hook, pluginRoot, pluginId, skillRoot },
    hookIndex,
  ): AsyncGenerator<HookResult> {
    if (hook.type === 'callback') {
      const callbackTimeoutMs = hook.timeout ? hook.timeout * 1000 : timeoutMs
      const { signal: abortSignal, cleanup } = createCombinedAbortSignal(
        signal,
        { timeoutMs: callbackTimeoutMs },
      )
      yield executeHookCallback({
        toolUseID,
        hook,
        hookEvent,
        hookInput,
        signal: abortSignal,
        hookIndex,
        toolUseContext,
      }).finally(cleanup)
      return
    }

    if (hook.type === 'function') {
      if (!messages) {
        yield {
          message: createAttachmentMessage({
            type: 'hook_error_during_execution',
            hookName,
            toolUseID,
            hookEvent,
            content: 'Messages not provided for function hook',
          }),
          outcome: 'non_blocking_error',
          hook,
        }
        return
      }

      // 14. function hook 来自会话态，直接调用内嵌回调。
      yield executeFunctionHook({
        hook,
        messages,
        hookName,
        toolUseID,
        hookEvent,
        timeoutMs,
        signal,
      })
      return
    }

    // 15. 命令、prompt、agent、HTTP hook 都需要共享 JSON 输入。
    const commandTimeoutMs = hook.timeout ? hook.timeout * 1000 : timeoutMs
    const { signal: abortSignal, cleanup } = createCombinedAbortSignal(signal, {
      timeoutMs: commandTimeoutMs,
    })
    const hookId = randomUUID()
    const hookStartMs = Date.now()
    const hookCommand = getHookDisplayText(hook)

    try {
      const jsonInputRes = getJsonInput()
      if (!jsonInputRes.ok) {
        yield {
          message: createAttachmentMessage({
            type: 'hook_error_during_execution',
            hookName,
            toolUseID,
            hookEvent,
            content: `Failed to prepare hook input: ${errorMessage(jsonInputRes.error)}`,
            command: hookCommand,
            durationMs: Date.now() - hookStartMs,
          }),
          outcome: 'non_blocking_error',
          hook,
        }
        cleanup()
        return
      }
      const jsonInput = jsonInputRes.value

      if (hook.type === 'prompt') {
        if (!toolUseContext) {
          throw new Error(
            'ToolUseContext is required for prompt hooks. This is a bug.',
          )
        }
        const promptResult = await execPromptHook(
          hook,
          hookName,
          hookEvent,
          jsonInput,
          abortSignal,
          toolUseContext,
          messages,
          toolUseID,
        )
        // 16. 为 prompt hook 注入耗时和退出状态，方便结果展示。
        if (promptResult.message?.type === 'attachment') {
          const att = promptResult.message.attachment
          if (
            att.type === 'hook_success' ||
            att.type === 'hook_non_blocking_error'
          ) {
            att.command = hookCommand
            att.durationMs = Date.now() - hookStartMs
          }
        }
        yield promptResult
        cleanup?.()
        return
      }

      if (hook.type === 'agent') {
        if (!toolUseContext) {
          throw new Error(
            'ToolUseContext is required for agent hooks. This is a bug.',
          )
        }
        if (!messages) {
          throw new Error(
            'Messages are required for agent hooks. This is a bug.',
          )
        }
        const agentResult = await execAgentHook(
          hook,
          hookName,
          hookEvent,
          jsonInput,
          abortSignal,
          toolUseContext,
          toolUseID,
          messages,
          'agent_type' in hookInput
            ? (hookInput.agent_type as string)
            : undefined,
        )
        // 17. 为 agent hook 注入耗时和退出状态，方便结果展示。
        if (agentResult.message?.type === 'attachment') {
          const att = agentResult.message.attachment
          if (
            att.type === 'hook_success' ||
            att.type === 'hook_non_blocking_error'
          ) {
            att.command = hookCommand
            att.durationMs = Date.now() - hookStartMs
          }
        }
        yield agentResult
        cleanup?.()
        return
      }

      if (hook.type === 'http') {
        emitHookStarted(hookId, hookName, hookEvent)

        // 18. HTTP hook 自带超时处理，这里传父级信号避免叠加两层超时。
        const httpResult = await execHttpHook(
          hook,
          hookEvent,
          jsonInput,
          signal,
        )
        cleanup?.()

        if (httpResult.aborted) {
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: 'Hook cancelled',
            stdout: '',
            stderr: '',
            exitCode: undefined,
            outcome: 'cancelled',
          })
          yield {
            message: createAttachmentMessage({
              type: 'hook_cancelled',
              hookName,
              toolUseID,
              hookEvent,
            }),
            outcome: 'cancelled' as const,
            hook,
          }
          return
        }

        if (httpResult.error || !httpResult.ok) {
          const stderr =
            httpResult.error || `HTTP ${httpResult.statusCode} from ${hook.url}`
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: stderr,
            stdout: '',
            stderr,
            exitCode: httpResult.statusCode,
            outcome: 'error',
          })
          yield {
            message: createAttachmentMessage({
              type: 'hook_non_blocking_error',
              hookName,
              toolUseID,
              hookEvent,
              stderr,
              stdout: '',
              exitCode: httpResult.statusCode ?? 0,
            }),
            outcome: 'non_blocking_error' as const,
            hook,
          }
          return
        }

        // 19. HTTP hook 必须返回 JSON，并通过统一 schema 校验。
        const { json: httpJson, validationError: httpValidationError } =
          parseHttpHookOutput(httpResult.body)

        if (httpValidationError) {
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: httpResult.body,
            stdout: httpResult.body,
            stderr: `JSON validation failed: ${httpValidationError}`,
            exitCode: httpResult.statusCode,
            outcome: 'error',
          })
          yield {
            message: createAttachmentMessage({
              type: 'hook_non_blocking_error',
              hookName,
              toolUseID,
              hookEvent,
              stderr: `JSON validation failed: ${httpValidationError}`,
              stdout: httpResult.body,
              exitCode: httpResult.statusCode ?? 0,
            }),
            outcome: 'non_blocking_error' as const,
            hook,
          }
          return
        }

        if (httpJson && isAsyncHookJSONOutput(httpJson)) {
          // 20. 异步响应已交给后台流程，当前批次只记录成功。
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: httpResult.body,
            stdout: httpResult.body,
            stderr: '',
            exitCode: httpResult.statusCode,
            outcome: 'success',
          })
          yield {
            outcome: 'success' as const,
            hook,
          }
          return
        }

        if (httpJson) {
          const processed = processHookJSONOutput({
            json: httpJson,
            command: hook.url,
            hookName,
            toolUseID,
            hookEvent,
            expectedHookEvent: hookEvent,
            stdout: httpResult.body,
            stderr: '',
            exitCode: httpResult.statusCode,
          })
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: httpResult.body,
            stdout: httpResult.body,
            stderr: '',
            exitCode: httpResult.statusCode,
            outcome: 'success',
          })
          yield {
            ...processed,
            outcome: 'success' as const,
            hook,
          }
          return
        }

        return
      }

      emitHookStarted(hookId, hookName, hookEvent)

      const result = await execCommandHook(
        hook,
        hookEvent,
        hookName,
        jsonInput,
        abortSignal,
        hookId,
        hookIndex,
        pluginRoot,
        pluginId,
        skillRoot,
        forceSyncExecution,
        boundRequestPrompt,
      )
      cleanup?.()
      const durationMs = Date.now() - hookStartMs

      if (result.backgrounded) {
        yield {
          outcome: 'success' as const,
          hook,
        }
        return
      }

      if (result.aborted) {
        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          outcome: 'cancelled',
        })
        yield {
          message: createAttachmentMessage({
            type: 'hook_cancelled',
            hookName,
            toolUseID,
            hookEvent,
            command: hookCommand,
            durationMs,
          }),
          outcome: 'cancelled' as const,
          hook,
        }
        return
      }

      // 21. 命令输出优先按 JSON 协议解析。
      const { json, plainText, validationError } = parseHookOutput(
        result.stdout,
      )

      if (validationError) {
        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: `JSON validation failed: ${validationError}`,
          exitCode: 1,
          outcome: 'error',
        })
        yield {
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID,
            hookEvent,
            stderr: `JSON validation failed: ${validationError}`,
            stdout: result.stdout,
            exitCode: 1,
            command: hookCommand,
            durationMs,
          }),
          outcome: 'non_blocking_error' as const,
          hook,
        }
        return
      }

      if (json) {
        // 22. 异步响应已在命令执行阶段转入后台，这里不再处理 JSON 内容。
        if (isAsyncHookJSONOutput(json)) {
          yield {
            outcome: 'success' as const,
            hook,
          }
          return
        }

        // 23. 同步 JSON 输出转换为内部 HookResult。
        const processed = processHookJSONOutput({
          json,
          command: hookCommand,
          hookName,
          toolUseID,
          hookEvent,
          expectedHookEvent: hookEvent,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          durationMs,
        })

        // 24. suppressOutput 会隐藏成功输出，但不会隐藏阻塞结果。
        if (
          isSyncHookJSONOutput(json) &&
          !json.suppressOutput &&
          plainText &&
          result.status === 0
        ) {
          // 25. 未抑制时，普通文本输出仍作为 hook 成功附件展示。
          const content = `${chalk.bold(hookName)} completed`
          emitHookResponse({
            hookId,
            hookName,
            hookEvent,
            output: result.output,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.status,
            outcome: 'success',
          })
          yield {
            ...processed,
            message:
              processed.message ||
              createAttachmentMessage({
                type: 'hook_success',
                hookName,
                toolUseID,
                hookEvent,
                content,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.status,
                command: hookCommand,
                durationMs,
              }),
            outcome: 'success' as const,
            hook,
          }
          return
        }

        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          outcome: result.status === 0 ? 'success' : 'error',
        })
        yield {
          ...processed,
          outcome: 'success' as const,
          hook,
        }
        return
      }

      // 26. 非 JSON 输出按传统 stdout/stderr 和退出码规则处理。
      if (result.status === 0) {
        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          outcome: 'success',
        })
        yield {
          message: createAttachmentMessage({
            type: 'hook_success',
            hookName,
            toolUseID,
            hookEvent,
            content: result.stdout.trim(),
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.status,
            command: hookCommand,
            durationMs,
          }),
          outcome: 'success' as const,
          hook,
        }
        return
      }

      // 27. 退出码 2 表示 hook 主动阻塞当前流程。
      if (result.status === 2) {
        emitHookResponse({
          hookId,
          hookName,
          hookEvent,
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          outcome: 'error',
        })
        yield {
          blockingError: {
            blockingError: `[${hook.command}]: ${result.stderr || 'No stderr output'}`,
            command: hook.command,
          },
          outcome: 'blocking' as const,
          hook,
        }
        return
      }

      // 28. 其他非零退出码是非阻塞错误，只展示给用户。
      emitHookResponse({
        hookId,
        hookName,
        hookEvent,
        output: result.output,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.status,
        outcome: 'error',
      })
      yield {
        message: createAttachmentMessage({
          type: 'hook_non_blocking_error',
          hookName,
          toolUseID,
          hookEvent,
          stderr: `Failed with non-blocking status code: ${result.stderr.trim() || 'No stderr output'}`,
          stdout: result.stdout,
          exitCode: result.status,
          command: hookCommand,
          durationMs,
        }),
        outcome: 'non_blocking_error' as const,
        hook,
      }
      return
    } catch (error) {
      // 29. hook 执行异常转成非阻塞错误，避免单个 hook 打断主流程。
      cleanup?.()

      const errorMessage =
        error instanceof Error ? error.message : String(error)
      emitHookResponse({
        hookId,
        hookName,
        hookEvent,
        output: `Failed to run: ${errorMessage}`,
        stdout: '',
        stderr: `Failed to run: ${errorMessage}`,
        exitCode: 1,
        outcome: 'error',
      })
      yield {
        message: createAttachmentMessage({
          type: 'hook_non_blocking_error',
          hookName,
          toolUseID,
          hookEvent,
          stderr: `Failed to run: ${errorMessage}`,
          stdout: '',
          exitCode: 1,
          command: hookCommand,
          durationMs: Date.now() - hookStartMs,
        }),
        outcome: 'non_blocking_error' as const,
        hook,
      }
      return
    }
  })

  // 30. 收集每个 hook 的执行结论，用于日志和追踪。
  const outcomes = {
    success: 0,
    blocking: 0,
    non_blocking_error: 0,
    cancelled: 0,
  }

  let permissionBehavior: PermissionResult['behavior'] | undefined

  // 31. 等待所有 hook 完成后按结果进行聚合产出。
  for await (const result of all(hookPromises)) {
    outcomes[result.outcome]++

    // 32. preventContinuation 需要尽早产出，调用方可据此停止后续流程。
    if (result.preventContinuation) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) requested preventContinuation`,
      )
      yield {
        preventContinuation: true,
        stopReason: result.stopReason,
      }
    }

    // 33. 按结果内容分别产出阻塞错误和普通消息。
    if (result.blockingError) {
      yield {
        blockingError: result.blockingError,
      }
    }

    if (result.message) {
      yield { message: result.message }
    }

    // 34. 系统消息单独产出，避免和普通附件消息混在一起。
    if (result.systemMessage) {
      yield {
        message: createAttachmentMessage({
          type: 'hook_system_message',
          content: result.systemMessage,
          hookName,
          toolUseID,
          hookEvent,
        }),
      }
    }

    // 35. 收集 hook 提供的额外上下文。
    if (result.additionalContext) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) provided additionalContext (${result.additionalContext.length} chars)`,
      )
      yield {
        additionalContexts: [result.additionalContext],
      }
    }

    if (result.initialUserMessage) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) provided initialUserMessage (${result.initialUserMessage.length} chars)`,
      )
      yield {
        initialUserMessage: result.initialUserMessage,
      }
    }

    if (result.watchPaths && result.watchPaths.length > 0) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) provided ${result.watchPaths.length} watchPaths`,
      )
      yield {
        watchPaths: result.watchPaths,
      }
    }

    // 36. PostToolUse 可修改 MCP 工具输出，需要单独产出。
    if (result.updatedMCPToolOutput) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) replaced MCP tool output`,
      )
      yield {
        updatedMCPToolOutput: result.updatedMCPToolOutput,
      }
    }

    // 37. 权限行为按 deny > ask > allow 的优先级聚合。
    if (result.permissionBehavior) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) returned permissionDecision: ${result.permissionBehavior}${result.hookPermissionDecisionReason ? ` (reason: ${result.hookPermissionDecisionReason})` : ''}`,
      )
      // 38. 应用权限优先级规则。
      switch (result.permissionBehavior) {
        case 'deny':
          // 39. deny 永远优先。
          permissionBehavior = 'deny'
          break
        case 'ask':
          // 40. ask 可覆盖 allow，但不能覆盖 deny。
          if (permissionBehavior !== 'deny') {
            permissionBehavior = 'ask'
          }
          break
        case 'allow':
          // 41. allow 只在没有更强决策时生效。
          if (!permissionBehavior) {
            permissionBehavior = 'allow'
          }
          break
        case 'passthrough':
          // 42. passthrough 只允许修改输入，不产生权限决策。
          break
      }
    }

    // 43. allow/ask 场景下同时产出权限行为和可能被 hook 修改的输入。
    if (permissionBehavior !== undefined) {
      const updatedInput =
        result.updatedInput &&
        (result.permissionBehavior === 'allow' ||
          result.permissionBehavior === 'ask')
          ? result.updatedInput
          : undefined
      if (updatedInput) {
        logForDebugging(
          `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) modified tool input keys: [${Object.keys(updatedInput).join(', ')}]`,
        )
      }
      yield {
        permissionBehavior,
        hookPermissionDecisionReason: result.hookPermissionDecisionReason,
        hookSource: matchingHooks.find(m => m.hook === result.hook)?.hookSource,
        updatedInput,
      }
    }

    // 44. passthrough 场景只产出 updatedInput，不改变聚合后的权限决策。
    if (result.updatedInput && result.permissionBehavior === undefined) {
      logForDebugging(
        `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) modified tool input keys: [${Object.keys(result.updatedInput).join(', ')}]`,
      )
      yield {
        updatedInput: result.updatedInput,
      }
    }
    // 45. PermissionRequest hook 可直接产出结构化权限请求结果。
    if (result.permissionRequestResult) {
      yield {
        permissionRequestResult: result.permissionRequestResult,
      }
    }
    // 46. PermissionDenied hook 可请求重试。
    if (result.retry) {
      yield {
        retry: result.retry,
      }
    }
    // 47. Elicitation hook 可产出用户征询响应。
    if (result.elicitationResponse) {
      yield {
        elicitationResponse: result.elicitationResponse,
      }
    }
    // 48. ElicitationResult hook 可产出对征询结果的响应。
    if (result.elicitationResultResponse) {
      yield {
        elicitationResultResponse: result.elicitationResultResponse,
      }
    }

    // 49. 命令、prompt 和 function hook 成功后触发会话 hook 回调。
    if (appState && result.hook.type !== 'callback') {
      const sessionId = getSessionId()
      // 50. 没有 matchQuery 的事件使用空字符串作为回调 matcher。
      const matcher = matchQuery ?? ''
      const hookEntry = getSessionHookCallback(
        appState,
        sessionId,
        hookEvent,
        matcher,
        result.hook,
      )
      // 51. 只有成功结果才调用 onHookSuccess。
      if (hookEntry?.onHookSuccess && result.outcome === 'success') {
        try {
          hookEntry.onHookSuccess(result.hook, result as AggregatedHookResult)
        } catch (error) {
          logError(
            Error('Session hook success callback failed', { cause: error }),
          )
        }
      }
    }
  }

  const totalDurationMs = Date.now() - batchStartTime
  getStatsStore()?.observe('hook_duration_ms', totalDurationMs)
  addToTurnHookDuration(totalDurationMs)

  logEvent(`tengu_repl_hook_finished`, {
    hookName:
      hookName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    numCommands: matchingHooks.length,
    numSuccess: outcomes.success,
    numBlocking: outcomes.blocking,
    numNonBlockingError: outcomes.non_blocking_error,
    numCancelled: outcomes.cancelled,
    totalDurationMs,
  })

  // 52. beta tracing 开启时记录 hook 批次完成事件。
  if (isBetaTracingEnabled()) {
    const hookDefinitionsComplete =
      getHookDefinitionsForTelemetry(matchingHooks)

    void logOTelEvent('hook_execution_complete', {
      hook_event: hookEvent,
      hook_name: hookName,
      num_hooks: String(matchingHooks.length),
      num_success: String(outcomes.success),
      num_blocking: String(outcomes.blocking),
      num_non_blocking_error: String(outcomes.non_blocking_error),
      num_cancelled: String(outcomes.cancelled),
      managed_only: String(shouldAllowManagedHooksOnly()),
      hook_definitions: jsonStringify(hookDefinitionsComplete),
      hook_source: shouldAllowManagedHooksOnly() ? 'policySettings' : 'merged',
    })
  }

  // 53. 结束 tracing span，并写入聚合后的执行结果。
  endHookSpan(hookSpan, {
    numSuccess: outcomes.success,
    numBlocking: outcomes.blocking,
    numNonBlockingError: outcomes.non_blocking_error,
    numCancelled: outcomes.cancelled,
  })
}

/**
 * 非 REPL hook 的执行结果。
 *
 * 场景：通知、会话结束、worktree 和环境变更等不需要流式返回给模型的 hook。
 */
export type HookOutsideReplResult = {
  /** hook 命令、URL 或回调标识。 */
  command: string
  /** 是否成功完成。 */
  succeeded: boolean
  /** 用于调用方消费或展示的输出文本。 */
  output: string
  /** 是否产生阻塞结果。 */
  blocked: boolean
  /** hook 要求继续观察的路径列表。 */
  watchPaths?: string[]
  /** hook 返回的系统消息。 */
  systemMessage?: string
}

/**
 * 判断非 REPL hook 结果中是否存在阻塞项。
 *
 * @param results 非 REPL hook 执行结果列表。
 * @returns true 表示至少有一个 hook 阻塞了流程。
 */
export function hasBlockingResult(results: HookOutsideReplResult[]): boolean {
  return results.some(r => r.blocked)
}

/**
 * 在 REPL 主循环之外执行 hook。
 *
 * 适用于通知、会话结束、worktree 等不需要把进度消息直接流式暴露给模型的场景。
 * 错误默认只写调试日志；如果调用方需要展示给用户，应自行处理返回结果。
 *
 * @param param0 非 REPL hook 的输入、匹配条件、超时、取消信号和可选应用状态。
 * @returns 每个 hook 的命令、成功状态、输出和阻塞标记。
 */
async function executeHooksOutsideREPL({
  getAppState,
  hookInput,
  matchQuery,
  signal,
  timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
}: {
  getAppState?: () => AppState
  hookInput: HookInput
  matchQuery?: string
  signal?: AbortSignal
  timeoutMs: number
}): Promise<HookOutsideReplResult[]> {
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return []
  }

  const hookEvent = hookInput.hook_event_name
  const hookName = matchQuery ? `${hookEvent}:${matchQuery}` : hookEvent
  if (shouldDisableAllHooksIncludingManaged()) {
    logForDebugging(
      `Skipping hooks for ${hookName} due to 'disableAllHooks' managed setting`,
    )
    return []
  }

  // 1. 交互模式下所有 hook 都必须通过工作区信任检查。
  if (shouldSkipHookDueToTrust()) {
    logForDebugging(
      `Skipping ${hookName} hook execution - workspace trust not accepted`,
    )
    return []
  }

  const appState = getAppState ? getAppState() : undefined
  // 2. 非 REPL hook 使用主会话 ID。
  const sessionId = getSessionId()
  const matchingHooks = await getMatchingHooks(
    appState,
    sessionId,
    hookEvent,
    hookInput,
  )
  if (matchingHooks.length === 0) {
    return []
  }

  if (signal?.aborted) {
    return []
  }

  const userHooks = matchingHooks.filter(h => !isInternalHook(h))
  if (userHooks.length > 0) {
    const pluginHookCounts = getPluginHookCounts(userHooks)
    const hookTypeCounts = getHookTypeCounts(userHooks)
    logEvent(`tengu_run_hook`, {
      hookName:
        hookName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      numCommands: userHooks.length,
      hookTypeCounts: jsonStringify(
        hookTypeCounts,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(pluginHookCounts && {
        pluginHookCounts: jsonStringify(
          pluginHookCounts,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    })
  }

  // 3. 先序列化结构化输入，失败时返回单条失败结果。
  let jsonInput: string
  try {
    jsonInput = jsonStringify(hookInput)
  } catch (error) {
    logError(error)
    return []
  }

  // 4. 并行执行匹配到的 hook，每个 hook 使用自己的超时。
  const hookPromises = matchingHooks.map(
    async ({ hook, pluginRoot, pluginId }, hookIndex) => {
      // 5. callback hook 直接执行回调并转换为非 REPL 结果。
      if (hook.type === 'callback') {
        const callbackTimeoutMs = hook.timeout ? hook.timeout * 1000 : timeoutMs
        const { signal: abortSignal, cleanup } = createCombinedAbortSignal(
          signal,
          { timeoutMs: callbackTimeoutMs },
        )

        try {
          const toolUseID = randomUUID()
          const json = await hook.callback(
            hookInput,
            toolUseID,
            abortSignal,
            hookIndex,
          )

          cleanup?.()

          if (isAsyncHookJSONOutput(json)) {
            logForDebugging(
              `${hookName} [callback] returned async response, returning empty output`,
            )
            return {
              command: 'callback',
              succeeded: true,
              output: '',
              blocked: false,
            }
          }

          const output =
            hookEvent === 'WorktreeCreate' &&
            isSyncHookJSONOutput(json) &&
            json.hookSpecificOutput?.hookEventName === 'WorktreeCreate'
              ? json.hookSpecificOutput.worktreePath
              : json.systemMessage || ''
          const blocked =
            isSyncHookJSONOutput(json) && json.decision === 'block'

          logForDebugging(`${hookName} [callback] completed successfully`)

          return {
            command: 'callback',
            succeeded: true,
            output,
            blocked,
          }
        } catch (error) {
          cleanup?.()

          const errorMessage =
            error instanceof Error ? error.message : String(error)
          logForDebugging(
            `${hookName} [callback] failed to run: ${errorMessage}`,
            { level: 'error' },
          )
          return {
            command: 'callback',
            succeeded: false,
            output: errorMessage,
            blocked: false,
          }
        }
      }

      // 6. prompt hook 暂不支持非 REPL 路径，返回非阻塞错误。
      if (hook.type === 'prompt') {
        return {
          command: hook.prompt,
          succeeded: false,
          output: 'Prompt stop hooks are not yet supported outside REPL',
          blocked: false,
        }
      }

      // 7. agent hook 暂不支持非 REPL 路径，返回非阻塞错误。
      if (hook.type === 'agent') {
        return {
          command: hook.prompt,
          succeeded: false,
          output: 'Agent stop hooks are not yet supported outside REPL',
          blocked: false,
        }
      }

      // 8. function hook 需要对话消息，只能走 REPL 路径或专门的 Stop 路径。
      if (hook.type === 'function') {
        logError(
          new Error(
            `Function hook reached executeHooksOutsideREPL for ${hookEvent}. Function hooks should only be used in REPL context (Stop hooks).`,
          ),
        )
        return {
          command: 'function',
          succeeded: false,
          output: 'Internal error: function hook executed outside REPL context',
          blocked: false,
        }
      }

      // 9. HTTP hook 不依赖 ToolUseContext，直接 POST 结构化输入。
      if (hook.type === 'http') {
        try {
          const httpResult = await execHttpHook(
            hook,
            hookEvent,
            jsonInput,
            signal,
          )

          if (httpResult.aborted) {
            logForDebugging(`${hookName} [${hook.url}] cancelled`)
            return {
              command: hook.url,
              succeeded: false,
              output: 'Hook cancelled',
              blocked: false,
            }
          }

          if (httpResult.error || !httpResult.ok) {
            const errMsg =
              httpResult.error ||
              `HTTP ${httpResult.statusCode} from ${hook.url}`
            logForDebugging(`${hookName} [${hook.url}] failed: ${errMsg}`, {
              level: 'error',
            })
            return {
              command: hook.url,
              succeeded: false,
              output: errMsg,
              blocked: false,
            }
          }

          // 10. HTTP hook 必须返回 JSON，并用统一 schema 校验。
          const { json: httpJson, validationError: httpValidationError } =
            parseHttpHookOutput(httpResult.body)
          if (httpValidationError) {
            throw new Error(httpValidationError)
          }
          if (httpJson && !isAsyncHookJSONOutput(httpJson)) {
            logForDebugging(
              `Parsed JSON output from HTTP hook: ${jsonStringify(httpJson)}`,
              { level: 'verbose' },
            )
          }
          const jsonBlocked =
            httpJson &&
            !isAsyncHookJSONOutput(httpJson) &&
            isSyncHookJSONOutput(httpJson) &&
            httpJson.decision === 'block'

          // 11. WorktreeCreate 需要裸路径输出；HTTP hook 从 hookSpecificOutput.worktreePath 取值。
          const output =
            hookEvent === 'WorktreeCreate'
              ? httpJson &&
                isSyncHookJSONOutput(httpJson) &&
                httpJson.hookSpecificOutput?.hookEventName === 'WorktreeCreate'
                ? httpJson.hookSpecificOutput.worktreePath
                : ''
              : httpResult.body

          return {
            command: hook.url,
            succeeded: true,
            output,
            blocked: !!jsonBlocked,
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          logForDebugging(
            `${hookName} [${hook.url}] failed to run: ${errorMessage}`,
            { level: 'error' },
          )
          return {
            command: hook.url,
            succeeded: false,
            output: errorMessage,
            blocked: false,
          }
        }
      }

      // 12. 命令 hook 走标准命令执行路径。
      const commandTimeoutMs = hook.timeout ? hook.timeout * 1000 : timeoutMs
      const { signal: abortSignal, cleanup } = createCombinedAbortSignal(
        signal,
        { timeoutMs: commandTimeoutMs },
      )
      try {
        const result = await execCommandHook(
          hook,
          hookEvent,
          hookName,
          jsonInput,
          abortSignal,
          randomUUID(),
          hookIndex,
          pluginRoot,
          pluginId,
        )

        // 13. hook 完成后清理当前超时控制器。
        cleanup?.()

        if (result.aborted) {
          logForDebugging(`${hookName} [${hook.command}] cancelled`)
          return {
            command: hook.command,
            succeeded: false,
            output: 'Hook cancelled',
            blocked: false,
          }
        }

        logForDebugging(
          `${hookName} [${hook.command}] completed with status ${result.status}`,
        )

        // 14. 尝试解析 JSON 输出，用于获取系统消息、watchPaths 或阻塞决策。
        const { json, validationError } = parseHookOutput(result.stdout)
        if (validationError) {
          // 15. JSON 校验错误作为失败输出返回，供调用方决定是否展示。
          throw new Error(validationError)
        }
        if (json && !isAsyncHookJSONOutput(json)) {
          logForDebugging(
            `Parsed JSON output from hook: ${jsonStringify(json)}`,
            { level: 'verbose' },
          )
        }

        // 16. 退出码 2 或 JSON decision=block 都表示阻塞。
        const jsonBlocked =
          json &&
          !isAsyncHookJSONOutput(json) &&
          isSyncHookJSONOutput(json) &&
          json.decision === 'block'
        const blocked = result.status === 2 || !!jsonBlocked

        // 17. 成功时输出 stdout，失败时优先输出 stderr。
        const output =
          result.status === 0 ? result.stdout || '' : result.stderr || ''

        const watchPaths =
          json &&
          isSyncHookJSONOutput(json) &&
          json.hookSpecificOutput &&
          'watchPaths' in json.hookSpecificOutput
            ? json.hookSpecificOutput.watchPaths
            : undefined

        const systemMessage =
          json && isSyncHookJSONOutput(json) ? json.systemMessage : undefined

        return {
          command: hook.command,
          succeeded: result.status === 0,
          output,
          blocked,
          watchPaths,
          systemMessage,
        }
      } catch (error) {
        // 18. 执行异常转成失败结果，避免非 REPL 调用方直接抛错。
        cleanup?.()

        const errorMessage =
          error instanceof Error ? error.message : String(error)
        logForDebugging(
          `${hookName} [${hook.command}] failed to run: ${errorMessage}`,
          { level: 'error' },
        )
        return {
          command: hook.command,
          succeeded: false,
          output: errorMessage,
          blocked: false,
        }
      }
    },
  )

  // 19. 等待全部 hook 完成并收集结果。
  return await Promise.all(hookPromises)
}

/**
 * 执行工具调用前的 hook。
 *
 * @param toolName 即将调用的工具名。
 * @param toolUseID 工具调用 ID。
 * @param toolInput 即将传给工具的输入。
 * @param permissionMode 当前权限模式，可为空。
 * @param signal 可选取消信号。
 * @param timeoutMs hook 执行超时，单位毫秒。
 * @param toolUseContext 工具调用上下文，prompt/agent hook 需要它。
 * @returns 异步生成器，产出进度、阻塞错误和权限/输入更新。
 */
export async function* executePreToolHooks<ToolInput>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  toolUseContext: ToolUseContext,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>,
  toolInputSummary?: string | null,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('PreToolUse', appState, sessionId)) {
    return
  }

  logForDebugging(`executePreToolHooks called for tool: ${toolName}`, {
    level: 'verbose',
  })

  const hookInput: PreToolUseHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseID,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
    requestPrompt,
    toolInputSummary,
  })
}

/**
 * 执行工具调用成功后的 hook。
 *
 * @param toolName 已调用的工具名。
 * @param toolUseID 工具调用 ID。
 * @param toolInput 传给工具的输入。
 * @param toolResponse 工具返回结果。
 * @param toolUseContext 工具调用上下文。
 * @param permissionMode 当前权限模式，可为空。
 * @param signal 可选取消信号。
 * @param timeoutMs hook 执行超时，单位毫秒。
 * @returns 异步生成器，产出进度、追加上下文和自动反馈所需的阻塞信息。
 */
export async function* executePostToolHooks<ToolInput, ToolResponse>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  toolResponse: ToolResponse,
  toolUseContext: ToolUseContext,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: PostToolUseHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    tool_use_id: toolUseID,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
  })
}

/**
 * 执行工具调用失败后的 hook。
 *
 * @param toolName 失败的工具名。
 * @param toolUseID 工具调用 ID。
 * @param toolInput 传给工具的输入。
 * @param error 工具调用失败信息。
 * @param toolUseContext 工具调用上下文。
 * @param isInterrupt 是否由用户中断导致失败。
 * @param permissionMode 当前权限模式，可为空。
 * @param signal 可选取消信号。
 * @param timeoutMs hook 执行超时，单位毫秒。
 * @returns 异步生成器，产出进度和阻塞错误。
 */
export async function* executePostToolUseFailureHooks<ToolInput>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  error: string,
  toolUseContext: ToolUseContext,
  isInterrupt?: boolean,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('PostToolUseFailure', appState, sessionId)) {
    return
  }

  const hookInput: PostToolUseFailureHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PostToolUseFailure',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseID,
    error,
    is_interrupt: isInterrupt,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
  })
}

/**
 * 执行权限拒绝后的 hook。
 *
 * @param toolName 被拒绝权限的工具名。
 * @param toolUseID 工具调用 ID。
 * @param toolInput 原始工具输入。
 * @param error 权限拒绝原因。
 * @param toolUseContext 工具调用上下文。
 * @param permissionMode 当前权限模式，可为空。
 * @param signal 可选取消信号。
 * @param timeoutMs hook 执行超时，单位毫秒。
 * @returns 异步生成器，产出进度、重试标记和 hook 结果。
 */
export async function* executePermissionDeniedHooks<ToolInput>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  reason: string,
  toolUseContext: ToolUseContext,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('PermissionDenied', appState, sessionId)) {
    return
  }

  const hookInput: PermissionDeniedHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PermissionDenied',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseID,
    reason,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
  })
}

/**
 * 执行通知类 hook。
 *
 * @param notificationData 传给 hook 的通知数据。
 * @param timeoutMs hook 执行超时，单位毫秒。
 * @returns 所有通知 hook 完成后的 Promise。
 */
export async function executeNotificationHooks(
  notificationData: {
    message: string
    title?: string
    notificationType: string
  },
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<void> {
  const { message, title, notificationType } = notificationData
  const hookInput: NotificationHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'Notification',
    message,
    title,
    notification_type: notificationType,
  }

  await executeHooksOutsideREPL({
    hookInput,
    timeoutMs,
    matchQuery: notificationType,
  })
}

/**
 * 执行 StopFailure hook。
 *
 * @param error 停止失败的错误信息，可为空。
 * @param timeoutMs hook 执行超时，单位毫秒。
 * @returns 所有 StopFailure hook 完成后的 Promise。
 */
export async function executeStopFailureHooks(
  lastMessage: AssistantMessage,
  toolUseContext?: ToolUseContext,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<void> {
  const appState = toolUseContext?.getAppState()
  // 1. executeHooksOutsideREPL 固定使用主会话 ID，这里也按主会话检查，避免 agentId 通过预检却执行不到。
  const sessionId = getSessionId()
  if (!hasHookForEvent('StopFailure', appState, sessionId)) return

  const lastAssistantText =
    extractTextContent(lastMessage.message.content, '\n').trim() || undefined

  // 2. 部分调用点没有 error 字段，默认 unknown，确保 matcher 过滤仍有稳定输入。
  const error = lastMessage.error ?? 'unknown'
  const hookInput: StopFailureHookInput = {
    ...createBaseHookInput(undefined, undefined, toolUseContext),
    hook_event_name: 'StopFailure',
    error,
    error_details: lastMessage.errorDetails,
    last_assistant_message: lastAssistantText,
  }

  await executeHooksOutsideREPL({
    getAppState: toolUseContext?.getAppState,
    hookInput,
    timeoutMs,
    matchQuery: error,
  })
}

/**
 * 执行 Stop hook。
 *
 * @param toolUseContext 工具调用上下文，prompt/agent hook 需要它。
 * @param permissionMode 当前权限模式。
 * @param signal 取消信号。
 * @param stopHookActive 当前调用是否发生在另一个 Stop hook 内。
 * @param isSubagent 当前上下文是否为子代理。
 * @param messages prompt/function hook 需要的对话历史。
 * @returns 异步生成器，产出进度和阻塞错误。
 */
export async function* executeStopHooks(
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  stopHookActive: boolean = false,
  subagentId?: AgentId,
  toolUseContext?: ToolUseContext,
  messages?: Message[],
  agentType?: string,
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>,
): AsyncGenerator<AggregatedHookResult> {
  const hookEvent = subagentId ? 'SubagentStop' : 'Stop'
  const appState = toolUseContext?.getAppState()
  const sessionId = toolUseContext?.agentId ?? getSessionId()
  if (!hasHookForEvent(hookEvent, appState, sessionId)) {
    return
  }

  // 1. 提取最后一条助手消息文本，让 hook 不读转录文件也能检查最终回复。
  const lastAssistantMessage = messages
    ? getLastAssistantMessage(messages)
    : undefined
  const lastAssistantText = lastAssistantMessage
    ? extractTextContent(lastAssistantMessage.message.content, '\n').trim() ||
      undefined
    : undefined

  const hookInput: StopHookInput | SubagentStopHookInput = subagentId
    ? {
        ...createBaseHookInput(permissionMode),
        hook_event_name: 'SubagentStop',
        stop_hook_active: stopHookActive,
        agent_id: subagentId,
        agent_transcript_path: getAgentTranscriptPath(subagentId),
        agent_type: agentType ?? '',
        last_assistant_message: lastAssistantText,
      }
    : {
        ...createBaseHookInput(permissionMode),
        hook_event_name: 'Stop',
        stop_hook_active: stopHookActive,
        last_assistant_message: lastAssistantText,
      }

  // 2. 工作区信任检查由 executeHooks 统一处理。
  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal,
    timeoutMs,
    toolUseContext,
    messages,
    requestPrompt,
  })
}

/**
 * 在队友即将进入空闲状态前执行 TeammateIdle hook。
 *
 * @param teammateName 即将空闲的队友名称。
 * @param teamName 队友所属团队名称。
 * @param permissionMode 当前权限模式，可为空。
 * @param signal 可选取消信号。
 * @param timeoutMs hook 执行超时，单位毫秒。
 * @returns 异步生成器；如果 hook 阻塞，调用方应让队友继续工作。
 */
export async function* executeTeammateIdleHooks(
  teammateName: string,
  teamName: string,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: TeammateIdleHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'TeammateIdle',
    teammate_name: teammateName,
    team_name: teamName,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal,
    timeoutMs,
  })
}

/**
 * 创建任务时执行 TaskCreated hook。
 *
 * @param taskId 正在创建的任务 ID。
 * @param taskSubject 任务标题。
 * @param taskDescription 可选任务描述。
 * @param teammateName 创建任务的队友名称，可为空。
 * @param teamName 团队名称，可为空。
 * @param permissionMode 当前权限模式，可为空。
 * @param signal 可选取消信号。
 * @param timeoutMs hook 执行超时，单位毫秒。
 * @param toolUseContext 可选工具上下文，用于解析 appState 和 sessionId。
 * @returns 异步生成器；如果 hook 阻塞，调用方应阻止任务创建并返回反馈。
 */
export async function* executeTaskCreatedHooks(
  taskId: string,
  taskSubject: string,
  taskDescription?: string,
  teammateName?: string,
  teamName?: string,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  toolUseContext?: ToolUseContext,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: TaskCreatedHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'TaskCreated',
    task_id: taskId,
    task_subject: taskSubject,
    task_description: taskDescription,
    teammate_name: teammateName,
    team_name: teamName,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal,
    timeoutMs,
    toolUseContext,
  })
}

/**
 * 标记任务完成时执行 TaskCompleted hook。
 *
 * @param taskId 正在完成的任务 ID。
 * @param taskSubject 任务标题。
 * @param taskDescription 可选任务描述。
 * @param teammateName 完成任务的队友名称，可为空。
 * @param teamName 团队名称，可为空。
 * @param permissionMode 当前权限模式，可为空。
 * @param signal 可选取消信号。
 * @param timeoutMs hook 执行超时，单位毫秒。
 * @param toolUseContext 可选工具上下文，用于解析 appState 和 sessionId。
 * @returns 异步生成器；如果 hook 阻塞，调用方应阻止任务完成并返回反馈。
 */
export async function* executeTaskCompletedHooks(
  taskId: string,
  taskSubject: string,
  taskDescription?: string,
  teammateName?: string,
  teamName?: string,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  toolUseContext?: ToolUseContext,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: TaskCompletedHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'TaskCompleted',
    task_id: taskId,
    task_subject: taskSubject,
    task_description: taskDescription,
    teammate_name: teammateName,
    team_name: teamName,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal,
    timeoutMs,
    toolUseContext,
  })
}

/**
 * 执行用户提交提示词时的 hook。
 *
 * @param prompt 用户提交的提示词。
 * @param permissionMode 当前权限模式。
 * @param toolUseContext 工具调用上下文。
 * @returns 异步生成器，产出进度、阻塞错误和追加上下文。
 */
export async function* executeUserPromptSubmitHooks(
  prompt: string,
  permissionMode: string,
  toolUseContext: ToolUseContext,
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('UserPromptSubmit', appState, sessionId)) {
    return
  }

  const hookInput: UserPromptSubmitHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'UserPromptSubmit',
    prompt,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal: toolUseContext.abortController.signal,
    timeoutMs: TOOL_HOOK_EXECUTION_TIMEOUT_MS,
    toolUseContext,
    requestPrompt,
  })
}

/**
 * 执行会话启动 hook。
 *
 * @param source 会话启动来源，例如启动、恢复或清理后重启。
 * @param sessionId 可选会话 ID；传入时作为 hook 输入。
 * @param agentType 可选代理类型，通常来自 --agent。
 * @param model 当前会话使用的模型名称，可为空。
 * @param signal 可选取消信号。
 * @param timeoutMs hook 执行超时，单位毫秒。
 * @returns 异步生成器，产出进度和 hook 结果。
 */
export async function* executeSessionStartHooks(
  source: 'startup' | 'resume' | 'clear' | 'compact',
  sessionId?: string,
  agentType?: string,
  model?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  forceSyncExecution?: boolean,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: SessionStartHookInput = {
    ...createBaseHookInput(undefined, sessionId),
    hook_event_name: 'SessionStart',
    source,
    agent_type: agentType,
    model,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    matchQuery: source,
    signal,
    timeoutMs,
    forceSyncExecution,
  })
}

/**
 * 执行 setup hook。
 *
 * @param trigger setup 触发类型，例如 init 或 maintenance。
 * @param signal 可选取消信号。
 * @param timeoutMs hook 执行超时，单位毫秒。
 * @param forceSyncExecution 为 true 时，即使 hook 声明异步也强制等待完成。
 * @returns 异步生成器，产出进度和 hook 结果。
 */
export async function* executeSetupHooks(
  trigger: 'init' | 'maintenance',
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  forceSyncExecution?: boolean,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: SetupHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'Setup',
    trigger,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    matchQuery: trigger,
    signal,
    timeoutMs,
    forceSyncExecution,
  })
}

/**
 * 执行子代理启动 hook。
 *
 * @param agentId 子代理唯一 ID。
 * @param agentType 正在启动的子代理类型或名称。
 * @param signal 可选取消信号。
 * @param timeoutMs hook 执行超时，单位毫秒。
 * @returns 异步生成器，产出进度和 hook 结果。
 */
export async function* executeSubagentStartHooks(
  agentId: string,
  agentType: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: SubagentStartHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'SubagentStart',
    agent_id: agentId,
    agent_type: agentType,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    matchQuery: agentType,
    signal,
    timeoutMs,
  })
}

/**
 * 执行压缩前 hook。
 *
 * @param compactData 传给 hook 的压缩输入数据。
 * @param signal 可选取消信号。
 * @param timeoutMs hook 执行超时，单位毫秒。
 * @returns 可能包含新自定义指令和用户展示消息的对象。
 */
export async function executePreCompactHooks(
  compactData: {
    trigger: 'manual' | 'auto'
    customInstructions: string | null
  },
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<{
  newCustomInstructions?: string
  userDisplayMessage?: string
}> {
  const hookInput: PreCompactHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'PreCompact',
    trigger: compactData.trigger,
    custom_instructions: compactData.customInstructions,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    matchQuery: compactData.trigger,
    signal,
    timeoutMs,
  })

  if (results.length === 0) {
    return {}
  }

  // 1. 从成功且有输出的 hook 中提取新的自定义指令。
  const successfulOutputs = results
    .filter(result => result.succeeded && result.output.trim().length > 0)
    .map(result => result.output.trim())

  // 2. 构造包含命令信息的用户展示消息。
  const displayMessages: string[] = []
  for (const result of results) {
    if (result.succeeded) {
      if (result.output.trim()) {
        displayMessages.push(
          `PreCompact [${result.command}] completed successfully: ${result.output.trim()}`,
        )
      } else {
        displayMessages.push(
          `PreCompact [${result.command}] completed successfully`,
        )
      }
    } else {
      if (result.output.trim()) {
        displayMessages.push(
          `PreCompact [${result.command}] failed: ${result.output.trim()}`,
        )
      } else {
        displayMessages.push(`PreCompact [${result.command}] failed`)
      }
    }
  }

  return {
    newCustomInstructions:
      successfulOutputs.length > 0 ? successfulOutputs.join('\n\n') : undefined,
    userDisplayMessage:
      displayMessages.length > 0 ? displayMessages.join('\n') : undefined,
  }
}

/**
 * 执行压缩后 hook。
 *
 * @param compactData 传给 hook 的压缩数据，包含摘要。
 * @param signal 可选取消信号。
 * @param timeoutMs hook 执行超时，单位毫秒。
 * @returns 可能包含用户展示消息的对象。
 */
export async function executePostCompactHooks(
  compactData: {
    trigger: 'manual' | 'auto'
    compactSummary: string
  },
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<{
  userDisplayMessage?: string
}> {
  const hookInput: PostCompactHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'PostCompact',
    trigger: compactData.trigger,
    compact_summary: compactData.compactSummary,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    matchQuery: compactData.trigger,
    signal,
    timeoutMs,
  })

  if (results.length === 0) {
    return {}
  }

  const displayMessages: string[] = []
  for (const result of results) {
    if (result.succeeded) {
      if (result.output.trim()) {
        displayMessages.push(
          `PostCompact [${result.command}] completed successfully: ${result.output.trim()}`,
        )
      } else {
        displayMessages.push(
          `PostCompact [${result.command}] completed successfully`,
        )
      }
    } else {
      if (result.output.trim()) {
        displayMessages.push(
          `PostCompact [${result.command}] failed: ${result.output.trim()}`,
        )
      } else {
        displayMessages.push(`PostCompact [${result.command}] failed`)
      }
    }
  }

  return {
    userDisplayMessage:
      displayMessages.length > 0 ? displayMessages.join('\n') : undefined,
  }
}

/**
 * 执行会话结束 hook。
 *
 * @param reason 会话结束原因。
 * @param options 可选参数，包含应用状态获取函数和取消信号。
 * @returns 所有 SessionEnd hook 完成后的 Promise。
 */
export async function executeSessionEndHooks(
  reason: ExitReason,
  options?: {
    getAppState?: () => AppState
    setAppState?: (updater: (prev: AppState) => AppState) => void
    signal?: AbortSignal
    timeoutMs?: number
  },
): Promise<void> {
  const {
    getAppState,
    setAppState,
    signal,
    timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  } = options || {}

  const hookInput: SessionEndHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'SessionEnd',
    reason,
  }

  const results = await executeHooksOutsideREPL({
    getAppState,
    hookInput,
    matchQuery: reason,
    signal,
    timeoutMs,
  })

  // 1. 关闭阶段 Ink 已卸载，可直接把 hook 失败信息写到 stderr。
  for (const result of results) {
    if (!result.succeeded && result.output) {
      process.stderr.write(
        `SessionEnd hook [${result.command}] failed: ${result.output}\n`,
      )
    }
  }

  // 2. SessionEnd hook 执行后清理会话级 hook，避免泄漏到后续会话。
  if (setAppState) {
    const sessionId = getSessionId()
    clearSessionHooks(setAppState, sessionId)
  }
}

/**
 * 执行权限请求 hook。
 *
 * 当系统本应向用户展示权限弹窗时触发，hook 可以用程序化方式允许或拒绝请求。
 *
 * @param toolName 请求权限的工具名。
 * @param toolUseID 工具调用 ID。
 * @param toolInput 将传给工具的输入。
 * @param toolUseContext 当前工具调用上下文。
 * @param permissionMode 当前权限模式，可为空。
 * @param permissionSuggestions 可选权限建议，例如 always allow 选项。
 * @param signal 可选取消信号。
 * @param timeoutMs hook 执行超时，单位毫秒。
 * @returns 异步生成器，产出进度和聚合后的权限请求结果。
 */
export async function* executePermissionRequestHooks<ToolInput>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  toolUseContext: ToolUseContext,
  permissionMode?: string,
  permissionSuggestions?: PermissionUpdate[],
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>,
  toolInputSummary?: string | null,
): AsyncGenerator<AggregatedHookResult> {
  logForDebugging(`executePermissionRequestHooks called for tool: ${toolName}`)

  const hookInput: PermissionRequestHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PermissionRequest',
    tool_name: toolName,
    tool_input: toolInput,
    permission_suggestions: permissionSuggestions,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
    requestPrompt,
    toolInputSummary,
  })
}

/**
 * 配置变更来源类型。
 *
 * 场景：ConfigChange hook 用它区分变化来自普通设置、策略设置、技能或命令。
 */
export type ConfigChangeSource =
  | 'user_settings'
  | 'project_settings'
  | 'local_settings'
  | 'policy_settings'
  | 'skills'

/**
 * 会话中配置文件变化时执行 ConfigChange hook。
 *
 * 文件监听器发现 settings、skills 或 commands 变化时触发，用于安全审计或日志记录。
 * policySettings 属于企业托管配置，不允许被 hook 阻塞；此时 hook 仍会运行，但阻塞结果会被忽略。
 *
 * @param source 发生变化的配置来源类型。
 * @param filePath 变化文件路径，可为空。
 * @param timeoutMs hook 执行超时，单位毫秒。
 */
export async function executeConfigChangeHooks(
  source: ConfigChangeSource,
  filePath?: string,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<HookOutsideReplResult[]> {
  const hookInput: ConfigChangeHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'ConfigChange',
    source,
    file_path: filePath,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    timeoutMs,
    matchQuery: source,
  })

  // 1. policy_settings 属于企业托管配置，hook 只做审计，不能阻止配置生效。
  if (source === 'policy_settings') {
    return results.map(r => ({ ...r, blocked: false }))
  }

  return results
}

/**
 * 执行环境变化类 hook。
 *
 * @param hookInput CwdChanged 或 FileChanged hook 输入。
 * @returns 非 REPL hook 执行结果列表。
 */
async function executeEnvHooks(
  hookInput: HookInput,
  timeoutMs: number,
): Promise<{
  results: HookOutsideReplResult[]
  watchPaths: string[]
  systemMessages: string[]
}> {
  const results = await executeHooksOutsideREPL({ hookInput, timeoutMs })
  if (results.length > 0) {
    invalidateSessionEnvCache()
  }
  const watchPaths = results.flatMap(r => r.watchPaths ?? [])
  const systemMessages = results
    .map(r => r.systemMessage)
    .filter((m): m is string => !!m)
  return { results, watchPaths, systemMessages }
}

/**
 * 当前工作目录变化时触发 CwdChanged hook。
 *
 * @param oldCwd 变化前的工作目录。
 * @param newCwd 变化后的工作目录。
 * @returns 非 REPL hook 执行结果 Promise。
 */
export function executeCwdChangedHooks(
  oldCwd: string,
  newCwd: string,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<{
  results: HookOutsideReplResult[]
  watchPaths: string[]
  systemMessages: string[]
}> {
  const hookInput: CwdChangedHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'CwdChanged',
    old_cwd: oldCwd,
    new_cwd: newCwd,
  }
  return executeEnvHooks(hookInput, timeoutMs)
}

/**
 * 文件变化时触发 FileChanged hook。
 *
 * @param filePath 发生变化的文件路径。
 * @returns 非 REPL hook 执行结果 Promise。
 */
export function executeFileChangedHooks(
  filePath: string,
  event: 'change' | 'add' | 'unlink',
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<{
  results: HookOutsideReplResult[]
  watchPaths: string[]
  systemMessages: string[]
}> {
  const hookInput: FileChangedHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'FileChanged',
    file_path: filePath,
    event,
  }
  return executeEnvHooks(hookInput, timeoutMs)
}

/**
 * 指令文件加载原因。
 *
 * 场景：InstructionsLoaded hook 用它说明文件是启动加载、压缩后加载还是路径触发加载。
 */
export type InstructionsLoadReason =
  | 'session_start'
  | 'nested_traversal'
  | 'path_glob_match'
  | 'include'
  | 'compact'

/**
 * 指令记忆来源类型。
 *
 * 场景：InstructionsLoaded hook 用它区分用户级、项目级、本地级和托管级指令文件。
 */
export type InstructionsMemoryType = 'User' | 'Project' | 'Local' | 'Managed'

/**
 * 判断是否配置了 InstructionsLoaded hook。
 *
 * @returns true 表示存在配置文件或注册表来源的 InstructionsLoaded hook。
 */
export function hasInstructionsLoadedHook(): boolean {
  const snapshotHooks = getHooksConfigFromSnapshot()?.['InstructionsLoaded']
  if (snapshotHooks && snapshotHooks.length > 0) return true
  const registeredHooks = getRegisteredHooks()?.['InstructionsLoaded']
  if (registeredHooks && registeredHooks.length > 0) return true
  return false
}

/**
 * 指令文件加载到上下文时执行 InstructionsLoaded hook。
 *
 * 该 hook 用于观测和审计，不支持阻塞。常见触发点包括会话启动加载、压缩后重载、
 * 以及访问文件时懒加载嵌套 CLAUDE.md 或规则文件。
 *
 * @param filePath 被加载的指令文件路径。
 * @param memoryType 指令来源类型，例如 User、Project、Local 或 Managed。
 * @param loadReason 加载原因。
 * @param options 可选上下文，包括匹配 glob、触发文件、父文件和超时。
 * @returns hook 完成后的 Promise。
 */
export async function executeInstructionsLoadedHooks(
  filePath: string,
  memoryType: InstructionsMemoryType,
  loadReason: InstructionsLoadReason,
  options?: {
    globs?: string[]
    triggerFilePath?: string
    parentFilePath?: string
    timeoutMs?: number
  },
): Promise<void> {
  const {
    globs,
    triggerFilePath,
    parentFilePath,
    timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  } = options ?? {}

  const hookInput: InstructionsLoadedHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'InstructionsLoaded',
    file_path: filePath,
    memory_type: memoryType,
    load_reason: loadReason,
    globs,
    trigger_file_path: triggerFilePath,
    parent_file_path: parentFilePath,
  }

  await executeHooksOutsideREPL({
    hookInput,
    timeoutMs,
    matchQuery: loadReason,
  })
}

/** Elicitation hook 的非 REPL 执行结果。 */
export type ElicitationHookResult = {
  elicitationResponse?: ElicitationResponse
  blockingError?: HookBlockingError
}

/** ElicitationResult hook 的非 REPL 执行结果。 */
export type ElicitationResultHookResult = {
  elicitationResultResponse?: ElicitationResponse
  blockingError?: HookBlockingError
}

/**
 * 从非 REPL hook 结果中提取征询相关字段。
 *
 * @param result 非 REPL hook 执行结果。
 * @param expectedEventName 期望的征询事件名称。
 * @returns 征询响应或阻塞错误。
 */
function parseElicitationHookOutput(
  result: HookOutsideReplResult,
  expectedEventName: 'Elicitation' | 'ElicitationResult',
): {
  response?: ElicitationResponse
  blockingError?: HookBlockingError
} {
  // 1. 退出码 2 表示阻塞，和 executeHooks 路径保持一致。
  if (result.blocked && !result.succeeded) {
    return {
      blockingError: {
        blockingError: result.output || `Elicitation blocked by hook`,
        command: result.command,
      },
    }
  }

  if (!result.output.trim()) {
    return {}
  }

  // 2. 只有 JSON 输出才可能携带结构化征询响应。
  const trimmed = result.output.trim()
  if (!trimmed.startsWith('{')) {
    return {}
  }

  try {
    const parsed = hookJSONOutputSchema().parse(JSON.parse(trimmed))
    if (isAsyncHookJSONOutput(parsed)) {
      return {}
    }
    if (!isSyncHookJSONOutput(parsed)) {
      return {}
    }

    // 3. 顶层 decision=block 也会转成阻塞错误。
    if (parsed.decision === 'block' || result.blocked) {
      return {
        blockingError: {
          blockingError: parsed.reason || 'Elicitation blocked by hook',
          command: result.command,
        },
      }
    }

    const specific = parsed.hookSpecificOutput
    if (!specific || specific.hookEventName !== expectedEventName) {
      return {}
    }

    if (!specific.action) {
      return {}
    }

    const response: ElicitationResponse = {
      action: specific.action,
      content: specific.content as ElicitationResponse['content'] | undefined,
    }

    const out: {
      response?: ElicitationResponse
      blockingError?: HookBlockingError
    } = { response }

    if (specific.action === 'decline') {
      out.blockingError = {
        blockingError:
          parsed.reason ||
          (expectedEventName === 'Elicitation'
            ? 'Elicitation denied by hook'
            : 'Elicitation result blocked by hook'),
        command: result.command,
      }
    }

    return out
  } catch {
    return {}
  }
}

/**
 * 执行 Elicitation hook。
 *
 * @param param0 MCP 服务名、征询消息、请求 schema、权限模式和展示模式等输入。
 * @returns 征询 hook 的响应或阻塞错误。
 */
export async function executeElicitationHooks({
  serverName,
  message,
  requestedSchema,
  permissionMode,
  signal,
  timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  mode,
  url,
  elicitationId,
}: {
  serverName: string
  message: string
  requestedSchema?: Record<string, unknown>
  permissionMode?: string
  signal?: AbortSignal
  timeoutMs?: number
  mode?: 'form' | 'url'
  url?: string
  elicitationId?: string
}): Promise<ElicitationHookResult> {
  const hookInput: ElicitationHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'Elicitation',
    mcp_server_name: serverName,
    message,
    mode,
    url,
    elicitation_id: elicitationId,
    requested_schema: requestedSchema,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    matchQuery: serverName,
    signal,
    timeoutMs,
  })

  let elicitationResponse: ElicitationResponse | undefined
  let blockingError: HookBlockingError | undefined

  for (const result of results) {
    const parsed = parseElicitationHookOutput(result, 'Elicitation')
    if (parsed.blockingError) {
      blockingError = parsed.blockingError
    }
    if (parsed.response) {
      elicitationResponse = parsed.response
    }
  }

  return { elicitationResponse, blockingError }
}

/**
 * 执行 ElicitationResult hook。
 *
 * @param param0 MCP 服务名、用户动作、内容、权限模式和征询 ID 等输入。
 * @returns 征询结果 hook 的响应或阻塞错误。
 */
export async function executeElicitationResultHooks({
  serverName,
  action,
  content,
  permissionMode,
  signal,
  timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  mode,
  elicitationId,
}: {
  serverName: string
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
  permissionMode?: string
  signal?: AbortSignal
  timeoutMs?: number
  mode?: 'form' | 'url'
  elicitationId?: string
}): Promise<ElicitationResultHookResult> {
  const hookInput: ElicitationResultHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'ElicitationResult',
    mcp_server_name: serverName,
    elicitation_id: elicitationId,
    mode,
    action,
    content,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    matchQuery: serverName,
    signal,
    timeoutMs,
  })

  let elicitationResultResponse: ElicitationResponse | undefined
  let blockingError: HookBlockingError | undefined

  for (const result of results) {
    const parsed = parseElicitationHookOutput(result, 'ElicitationResult')
    if (parsed.blockingError) {
      blockingError = parsed.blockingError
    }
    if (parsed.response) {
      elicitationResultResponse = parsed.response
    }
  }

  return { elicitationResultResponse, blockingError }
}

/**
 * 执行状态栏命令。
 *
 * @param statusLineInput 将序列化为 JSON 的状态栏输入。
 * @param signal 可选取消信号。
 * @param timeoutMs 命令超时，单位毫秒。
 * @param logResult 是否记录执行结果日志。
 * @returns 要展示的状态栏文本；未配置或失败时返回 undefined。
 */
export async function executeStatusLineCommand(
  statusLineInput: StatusLineCommandInput,
  signal?: AbortSignal,
  timeoutMs: number = 5000, // Short timeout for status line
  logResult: boolean = false,
): Promise<string | undefined> {
  // 1. 托管设置禁用所有 hook 时，状态栏命令也不执行。
  if (shouldDisableAllHooksIncludingManaged()) {
    return undefined
  }

  // 2. 交互模式下状态栏命令同样必须通过工作区信任检查。
  if (shouldSkipHookDueToTrust()) {
    logForDebugging(
      `Skipping StatusLine command execution - workspace trust not accepted`,
    )
    return undefined
  }

  // 3. 非托管设置禁用 hook 时，只允许企业托管的 statusLine 继续运行。
  let statusLine
  if (shouldAllowManagedHooksOnly()) {
    statusLine = getSettingsForSource('policySettings')?.statusLine
  } else {
    statusLine = getSettings_DEPRECATED()?.statusLine
  }

  if (!statusLine || statusLine.type !== 'command') {
    return undefined
  }

  // 4. 优先使用外部取消信号，否则按超时创建默认信号。
  const abortSignal = signal || AbortSignal.timeout(timeoutMs)

  try {
    // 5. 将状态输入序列化为 JSON 后写入命令 stdin。
    const jsonInput = jsonStringify(statusLineInput)

    const result = await execCommandHook(
      statusLine,
      'StatusLine',
      'statusLine',
      jsonInput,
      abortSignal,
      randomUUID(),
    )

    if (result.aborted) {
      return undefined
    }

    // 6. 命令成功时使用 stdout 作为状态栏内容。
    if (result.status === 0) {
      // 7. 清理每行空白并移除空行，避免状态栏显示多余换行。
      const output = result.stdout
        .trim()
        .split('\n')
        .flatMap(line => line.trim() || [])
        .join('\n')

      if (output) {
        if (logResult) {
          logForDebugging(
            `StatusLine [${statusLine.command}] completed with status ${result.status}`,
          )
        }
        return output
      }
    } else if (logResult) {
      logForDebugging(
        `StatusLine [${statusLine.command}] completed with status ${result.status}`,
        { level: 'warn' },
      )
    }

    return undefined
  } catch (error) {
    logForDebugging(`Status hook failed: ${error}`, { level: 'error' })
    return undefined
  }
}

/**
 * 执行文件建议命令。
 *
 * @param fileSuggestionInput 将序列化为 JSON 的文件建议输入。
 * @param signal 可选取消信号。
 * @param timeoutMs 命令超时，单位毫秒。
 * @returns 文件路径列表；未配置、失败或取消时返回空数组。
 */
export async function executeFileSuggestionCommand(
  fileSuggestionInput: FileSuggestionCommandInput,
  signal?: AbortSignal,
  timeoutMs: number = 5000, // Short timeout for typeahead suggestions
): Promise<string[]> {
  // 1. 托管设置禁用所有 hook 时，文件建议命令也不执行。
  if (shouldDisableAllHooksIncludingManaged()) {
    return []
  }

  // 2. 交互模式下文件建议命令同样必须通过工作区信任检查。
  if (shouldSkipHookDueToTrust()) {
    logForDebugging(
      `Skipping FileSuggestion command execution - workspace trust not accepted`,
    )
    return []
  }

  // 3. 非托管设置禁用 hook 时，只允许企业托管的 fileSuggestion 继续运行。
  let fileSuggestion
  if (shouldAllowManagedHooksOnly()) {
    fileSuggestion = getSettingsForSource('policySettings')?.fileSuggestion
  } else {
    fileSuggestion = getSettings_DEPRECATED()?.fileSuggestion
  }

  if (!fileSuggestion || fileSuggestion.type !== 'command') {
    return []
  }

  // 4. 优先使用外部取消信号，否则按超时创建默认信号。
  const abortSignal = signal || AbortSignal.timeout(timeoutMs)

  try {
    const jsonInput = jsonStringify(fileSuggestionInput)

    const hook = { type: 'command' as const, command: fileSuggestion.command }

    const result = await execCommandHook(
      hook,
      'FileSuggestion',
      'FileSuggestion',
      jsonInput,
      abortSignal,
      randomUUID(),
    )

    if (result.aborted || result.status !== 0) {
      return []
    }

    return result.stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
  } catch (error) {
    logForDebugging(`File suggestion helper failed: ${error}`, {
      level: 'error',
    })
    return []
  }
}

/**
 * 执行会话内注册的 function hook。
 *
 * @param param0 function hook、消息历史、事件信息、超时和取消信号。
 * @returns function hook 的统一执行结果。
 */
async function executeFunctionHook({
  hook,
  messages,
  hookName,
  toolUseID,
  hookEvent,
  timeoutMs,
  signal,
}: {
  hook: FunctionHook
  messages: Message[]
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  timeoutMs: number
  signal?: AbortSignal
}): Promise<HookResult> {
  const callbackTimeoutMs = hook.timeout ?? timeoutMs
  const { signal: abortSignal, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs: callbackTimeoutMs,
  })

  try {
    // 1. 执行前先检查是否已经被取消，避免启动无意义回调。
    if (abortSignal.aborted) {
      cleanup()
      return {
        outcome: 'cancelled',
        hook,
      }
    }

    // 2. 用合并后的 abort 信号执行回调。
    const passed = await new Promise<boolean>((resolve, reject) => {
      // 3. abort 时让 promise 进入拒绝分支，统一走取消处理。
      const onAbort = () => reject(new Error('Function hook cancelled'))
      abortSignal.addEventListener('abort', onAbort)

      // 4. 执行用户回调，并在完成后移除 abort 监听器。
      Promise.resolve(hook.callback(messages, abortSignal))
        .then(result => {
          abortSignal.removeEventListener('abort', onAbort)
          resolve(result)
        })
        .catch(error => {
          abortSignal.removeEventListener('abort', onAbort)
          reject(error)
        })
    })

    cleanup()

    if (passed) {
      return {
        outcome: 'success',
        hook,
      }
    }
    return {
      blockingError: {
        blockingError: hook.errorMessage,
        command: 'function',
      },
      outcome: 'blocking',
      hook,
    }
  } catch (error) {
    cleanup()

    // 5. 取消类错误转换为 cancelled 结果。
    if (
      error instanceof Error &&
      (error.message === 'Function hook cancelled' ||
        error.name === 'AbortError')
    ) {
      return {
        outcome: 'cancelled',
        hook,
      }
    }

    // 6. 其他异常记录监控日志，并作为非阻塞错误返回。
    logError(error)
    return {
      message: createAttachmentMessage({
        type: 'hook_error_during_execution',
        hookName,
        toolUseID,
        hookEvent,
        content:
          error instanceof Error
            ? error.message
            : 'Function hook execution error',
      }),
      outcome: 'non_blocking_error',
      hook,
    }
  }
}

/**
 * 执行 SDK 或内部注册的 callback hook。
 *
 * @param param0 callback hook、hook 输入、事件信息、取消信号和可选工具上下文。
 * @returns callback hook 的统一执行结果。
 */
async function executeHookCallback({
  toolUseID,
  hook,
  hookEvent,
  hookInput,
  signal,
  hookIndex,
  toolUseContext,
}: {
  toolUseID: string
  hook: HookCallback
  hookEvent: HookEvent
  hookInput: HookInput
  signal: AbortSignal
  hookIndex?: number
  toolUseContext?: ToolUseContext
}): Promise<HookResult> {
  // 1. 为需要访问应用状态的 callback 构造受限上下文。
  const context = toolUseContext
    ? {
        getAppState: toolUseContext.getAppState,
        updateAttributionState: toolUseContext.updateAttributionState,
      }
    : undefined
  const json = await hook.callback(
    hookInput,
    toolUseID,
    signal,
    hookIndex,
    context,
  )
  if (isAsyncHookJSONOutput(json)) {
    return {
      outcome: 'success',
      hook,
    }
  }

  const processed = processHookJSONOutput({
    json,
    command: 'callback',
    // 2. 后续可以在插件来源 callback 中使用插件完整路径增强调试信息。
    hookName: `${hookEvent}:Callback`,
    toolUseID,
    hookEvent,
    expectedHookEvent: hookEvent,
    // 3. callback hook 没有进程 stdout/stderr/exitCode，传空值即可。
    stdout: undefined,
    stderr: undefined,
    exitCode: undefined,
  })
  return {
    ...processed,
    outcome: 'success',
    hook,
  }
}

/**
 * 判断是否配置了 WorktreeCreate hook。
 *
 * 会检查设置快照和注册表来源，但不会真正执行 hook。
 *
 * @returns true 表示存在可执行的 WorktreeCreate hook。
 */
export function hasWorktreeCreateHook(): boolean {
  const snapshotHooks = getHooksConfigFromSnapshot()?.['WorktreeCreate']
  if (snapshotHooks && snapshotHooks.length > 0) return true
  const registeredHooks = getRegisteredHooks()?.['WorktreeCreate']
  if (!registeredHooks || registeredHooks.length === 0) return false
  // 1. 与 getHooksConfig 保持一致：托管模式下跳过插件 hook。
  const managedOnly = shouldAllowManagedHooksOnly()
  return registeredHooks.some(
    matcher => !(managedOnly && 'pluginRoot' in matcher),
  )
}

/**
 * 执行 WorktreeCreate hook。
 *
 * @param name 要创建的 worktree 名称。
 * @returns hook 输出的 worktree 路径。
 * @throws 当 hook 全部失败或没有输出路径时抛出错误。
 */
export async function executeWorktreeCreateHook(
  name: string,
): Promise<{ worktreePath: string }> {
  const hookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'WorktreeCreate' as const,
    name,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    timeoutMs: TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  })

  // 1. 取第一个成功且输出非空的结果作为 worktree 路径。
  const successfulResult = results.find(
    r => r.succeeded && r.output.trim().length > 0,
  )

  if (!successfulResult) {
    const failedOutputs = results
      .filter(r => !r.succeeded)
      .map(r => `${r.command}: ${r.output.trim() || 'no output'}`)
    throw new Error(
      `WorktreeCreate hook failed: ${failedOutputs.join('; ') || 'no successful output'}`,
    )
  }

  const worktreePath = successfulResult.output.trim()
  return { worktreePath }
}

/**
 * 执行 WorktreeRemove hook。
 *
 * @param worktreePath 被移除的 worktree 路径。
 * @returns true 表示存在 hook 且已执行；false 表示没有配置 hook。
 */
export async function executeWorktreeRemoveHook(
  worktreePath: string,
): Promise<boolean> {
  const snapshotHooks = getHooksConfigFromSnapshot()?.['WorktreeRemove']
  const registeredHooks = getRegisteredHooks()?.['WorktreeRemove']
  const hasSnapshotHooks = snapshotHooks && snapshotHooks.length > 0
  const hasRegisteredHooks = registeredHooks && registeredHooks.length > 0
  if (!hasSnapshotHooks && !hasRegisteredHooks) {
    return false
  }

  const hookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'WorktreeRemove' as const,
    worktree_path: worktreePath,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    timeoutMs: TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  })

  if (results.length === 0) {
    return false
  }

  for (const result of results) {
    if (!result.succeeded) {
      logForDebugging(
        `WorktreeRemove hook failed [${result.command}]: ${result.output.trim()}`,
        { level: 'error' },
      )
    }
  }

  return true
}

/**
 * 提取 hook 定义摘要供 telemetry 使用。
 *
 * @param matchedHooks 已匹配的 hook 列表。
 * @returns 仅包含类型和关键标识的轻量定义数组。
 */
function getHookDefinitionsForTelemetry(
  matchedHooks: MatchedHook[],
): Array<{ type: string; command?: string; prompt?: string; name?: string }> {
  return matchedHooks.map(({ hook }) => {
    if (hook.type === 'command') {
      return { type: 'command', command: hook.command }
    } else if (hook.type === 'prompt') {
      return { type: 'prompt', prompt: hook.prompt }
    } else if (hook.type === 'http') {
      return { type: 'http', command: hook.url }
    } else if (hook.type === 'function') {
      return { type: 'function', name: 'function' }
    } else if (hook.type === 'callback') {
      return { type: 'callback', name: 'callback' }
    }
    return { type: 'unknown' }
  })
}
