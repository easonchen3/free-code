import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { clearInvokedSkillsForAgent } from '../../bootstrap/state.js'
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  IN_PROCESS_TEAMMATE_ALLOWED_TOOLS,
} from '../../constants/tools.js'
import { startAgentSummarization } from '../../services/AgentSummary/agentSummary.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { clearDumpState } from '../../services/api/dumpPrompts.js'
import type { AppState } from '../../state/AppState.js'
import type {
  Tool,
  ToolPermissionContext,
  Tools,
  ToolUseContext,
} from '../../Tool.js'
import { toolMatchesName } from '../../Tool.js'
import {
  completeAgentTask as completeAsyncAgent,
  createActivityDescriptionResolver,
  createProgressTracker,
  enqueueAgentNotification,
  failAgentTask as failAsyncAgent,
  getProgressUpdate,
  getTokenCountFromTracker,
  isLocalAgentTask,
  killAsyncAgent,
  type ProgressTracker,
  updateAgentProgress as updateAsyncAgentProgress,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { asAgentId } from '../../types/ids.js'
import type { Message as MessageType } from '../../types/message.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { logForDebugging } from '../../utils/debug.js'
import { isInProtectedNamespace } from '../../utils/envUtils.js'
import { AbortError, errorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  extractTextContent,
  getLastAssistantMessage,
} from '../../utils/messages.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { permissionRuleValueFromString } from '../../utils/permissions/permissionRuleParser.js'
import {
  buildTranscriptForClassifier,
  classifyYoloAction,
} from '../../utils/permissions/yoloClassifier.js'
import { emitTaskProgress as emitTaskProgressEvent } from '../../utils/task/sdkProgress.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import { getTokenCountFromUsage } from '../../utils/tokens.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../ExitPlanModeTool/constants.js'
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from './constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'

/**
 * Agent 工具运行辅助模块。
 *
 * 该文件集中处理 Agent 可用工具解析、Agent 结果收口、异步 Agent 生命周期、
 * 进度事件上报以及自动模式下的交接安全分类，避免主 Agent 工具实现堆叠过多流程细节。
 */

/**
 * Agent 工具解析结果，描述配置中的工具声明哪些有效、哪些无效，以及最终可执行的工具集合。
 */
export type ResolvedAgentTools = {
  /** 是否使用 `*` 或未显式声明工具，从而允许当前过滤后的全部工具。 */
  hasWildcard: boolean
  /** 配置中能够匹配到可用工具或特殊 Agent 规则的声明。 */
  validTools: string[]
  /** 配置中无法匹配到当前可用工具集合的声明。 */
  invalidTools: string[]
  /** 经过 Agent 规则、禁用规则和去重处理后的最终工具列表。 */
  resolvedTools: Tools
  /** Agent 工具规则中额外限制允许调用的子 Agent 类型。 */
  allowedAgentTypes?: string[]
}

/**
 * 按 Agent 类型、运行方式和权限模式过滤可交给 Agent 使用的工具。
 *
 * @param params.tools 当前上下文里已经合并好的工具列表。
 * @param params.isBuiltIn 当前 Agent 是否为内置 Agent，内置 Agent 拥有更宽的工具白名单。
 * @param params.isAsync 当前 Agent 是否以后台异步任务运行。
 * @param params.permissionMode 当前权限模式，计划模式下允许特定退出计划工具。
 * @returns 过滤后的工具列表，调用方可以继续叠加 Agent 自身的 allow/deny 配置。
 */
export function filterToolsForAgent({
  tools,
  isBuiltIn,
  isAsync = false,
  permissionMode,
}: {
  tools: Tools
  isBuiltIn: boolean
  isAsync?: boolean
  permissionMode?: PermissionMode
}): Tools {
  return tools.filter(tool => {
    // 1. MCP 工具来自外部连接器，默认对所有 Agent 保持可见。
    if (tool.name.startsWith('mcp__')) {
      return true
    }
    // 2. 计划模式中的 Agent 需要能退出计划，因此该工具绕过通用禁用和异步过滤。
    if (
      toolMatchesName(tool, EXIT_PLAN_MODE_V2_TOOL_NAME) &&
      permissionMode === 'plan'
    ) {
      return true
    }
    // 3. 所有 Agent 都不能使用的工具直接过滤掉。
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    // 4. 自定义 Agent 还要额外应用自定义 Agent 禁用列表，降低非内置定义的能力面。
    if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    // 5. 异步 Agent 只能使用后台安全工具；队友场景保留同步子 Agent 和任务协作能力。
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) {
      if (isAgentSwarmsEnabled() && isInProcessTeammate()) {
        // 6. 进程内队友可以通过 AgentTool 生成同步子 Agent，后台和队友嵌套限制由 AgentTool.call 继续兜底。
        if (toolMatchesName(tool, AGENT_TOOL_NAME)) {
          return true
        }
        // 7. 队友协作依赖共享任务列表，因此保留专门的任务协调工具。
        if (IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has(tool.name)) {
          return true
        }
      }
      return false
    }
    // 8. 没有命中任何限制的工具保留给 Agent 使用。
    return true
  })
}

/**
 * 根据 Agent 定义解析最终可用工具，并同时返回无效工具声明。
 *
 * @param agentDefinition Agent 定义中的工具白名单、禁用列表、来源和权限模式。
 * @param availableTools 当前运行上下文已经提供的工具列表。
 * @param isAsync 当前 Agent 是否以后台异步方式运行。
 * @param isMainThread 是否在主线程解析工具；主线程工具池已经由上游合并完成。
 * @returns 解析结果，包含通配符状态、有效声明、无效声明、最终工具列表和可调用子 Agent 类型。
 */
export function resolveAgentTools(
  agentDefinition: Pick<
    AgentDefinition,
    'tools' | 'disallowedTools' | 'source' | 'permissionMode'
  >,
  availableTools: Tools,
  isAsync = false,
  isMainThread = false,
): ResolvedAgentTools {
  const {
    tools: agentTools,
    disallowedTools,
    source,
    permissionMode,
  } = agentDefinition
  // 1. 主线程工具池已经由上游组装完成；非主线程才应用子 Agent 的工具限制。
  const filteredAvailableTools = isMainThread
    ? availableTools
    : filterToolsForAgent({
        tools: availableTools,
        isBuiltIn: source === 'built-in',
        isAsync,
        permissionMode,
      })

  // 2. 将 Agent 显式禁用的工具声明解析成工具名集合，后续可用 O(1) 判断。
  const disallowedToolSet = new Set(
    disallowedTools?.map(toolSpec => {
      const { toolName } = permissionRuleValueFromString(toolSpec)
      return toolName
    }) ?? [],
  )

  // 3. 在全局过滤结果基础上继续移除 Agent 自身禁用的工具。
  const allowedAvailableTools = filteredAvailableTools.filter(
    tool => !disallowedToolSet.has(tool.name),
  )

  // 4. 未声明工具或只声明 `*` 时，表示允许所有经过过滤的工具。
  const hasWildcard =
    agentTools === undefined ||
    (agentTools.length === 1 && agentTools[0] === '*')
  if (hasWildcard) {
    return {
      hasWildcard: true,
      validTools: [],
      invalidTools: [],
      resolvedTools: allowedAvailableTools,
    }
  }

  // 5. 建立工具名到工具定义的映射，便于校验配置中的工具声明。
  const availableToolMap = new Map<string, Tool>()
  for (const tool of allowedAvailableTools) {
    availableToolMap.set(tool.name, tool)
  }

  const validTools: string[] = []
  const invalidTools: string[] = []
  const resolved: Tool[] = []
  const resolvedToolsSet = new Set<Tool>()
  let allowedAgentTypes: string[] | undefined

  for (const toolSpec of agentTools) {
    // 6. 工具声明可能带权限规则内容，先拆出基础工具名和规则内容。
    const { toolName, ruleContent } = permissionRuleValueFromString(toolSpec)

    // 7. Agent 工具的规则内容用于表达允许调用哪些子 Agent 类型。
    if (toolName === AGENT_TOOL_NAME) {
      if (ruleContent) {
        // 8. 子 Agent 类型使用逗号分隔，解析时顺手清理空白字符。
        allowedAgentTypes = ruleContent.split(',').map(s => s.trim())
      }
      // 9. 子 Agent 默认不能再解析出 AgentTool，但这条声明仍然要作为类型限制保留下来。
      if (!isMainThread) {
        validTools.push(toolSpec)
        continue
      }
      // 10. 主线程解析时 AgentTool 仍在工具池中，继续按普通工具解析。
    }

    // 11. 命中可用工具则加入结果并按工具对象去重；未命中则记录为无效声明。
    const tool = availableToolMap.get(toolName)
    if (tool) {
      validTools.push(toolSpec)
      if (!resolvedToolsSet.has(tool)) {
        resolved.push(tool)
        resolvedToolsSet.add(tool)
      }
    } else {
      invalidTools.push(toolSpec)
    }
  }

  // 12. 返回显式工具声明解析后的完整结果，供 Agent 定义校验和实际执行共同使用。
  return {
    hasWildcard: false,
    validTools,
    invalidTools,
    resolvedTools: resolved,
    allowedAgentTypes,
  }
}

/** AgentTool 返回结果的运行时 schema，用于恢复、序列化和调用方消费时保持结构稳定。 */
export const agentToolResultSchema = lazySchema(() =>
  z.object({
    agentId: z.string(),
    // 1. 老会话持久化结果可能没有 agentType；恢复时不会重新校验，因此这里保持可选。
    // 2. 同步结果尾部提示会依赖该字段，一次性内置 Agent 则跳过 SendMessage 提示。
    agentType: z.string().optional(),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
    totalToolUseCount: z.number(),
    totalDurationMs: z.number(),
    totalTokens: z.number(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().nullable(),
      cache_read_input_tokens: z.number().nullable(),
      server_tool_use: z
        .object({
          web_search_requests: z.number(),
          web_fetch_requests: z.number(),
        })
        .nullable(),
      service_tier: z.enum(['standard', 'priority', 'batch']).nullable(),
      cache_creation: z
        .object({
          ephemeral_1h_input_tokens: z.number(),
          ephemeral_5m_input_tokens: z.number(),
        })
        .nullable(),
    }),
  }),
)

/** AgentTool 对外返回值类型，直接由运行时 schema 推导，避免类型和校验规则分叉。 */
export type AgentToolResult = z.input<ReturnType<typeof agentToolResultSchema>>

/**
 * 统计一组消息中 Assistant 发起的工具调用次数。
 *
 * @param messages Agent 执行过程中累计的消息列表。
 * @returns 所有 assistant 消息中 `tool_use` 内容块的总数。
 */
export function countToolUses(messages: MessageType[]): number {
  // 1. 从 0 开始累计，只统计 Assistant 消息中的工具调用块。
  let count = 0
  for (const m of messages) {
    if (m.type === 'assistant') {
      for (const block of m.message.content) {
        // 2. 非 tool_use 内容块不计入工具使用次数。
        if (block.type === 'tool_use') {
          count++
        }
      }
    }
  }
  // 3. 返回累计结果，用于进度、分析事件和 AgentTool 汇总结果。
  return count
}

/**
 * 将 Agent 消息流收口为 AgentTool 的结构化结果。
 *
 * @param agentMessages Agent 运行期间产生的完整消息列表。
 * @param agentId 当前 Agent 或后台任务的唯一标识。
 * @param metadata Agent 调用的提示词、模型、类型、启动时间和运行方式等元数据。
 * @returns 可写入任务状态或返回给主 Agent 的 AgentTool 结果。
 */
export function finalizeAgentTool(
  agentMessages: MessageType[],
  agentId: string,
  metadata: {
    prompt: string
    resolvedAgentModel: string
    isBuiltInAgent: boolean
    startTime: number
    agentType: string
    isAsync: boolean
  },
): AgentToolResult {
  const {
    prompt,
    resolvedAgentModel,
    isBuiltInAgent,
    startTime,
    agentType,
    isAsync,
  } = metadata

  // 1. 结果必须以至少一条 Assistant 消息为基础，否则无法得到 usage 和最终文本。
  const lastAssistantMessage = getLastAssistantMessage(agentMessages)
  if (lastAssistantMessage === undefined) {
    throw new Error('No assistant messages found')
  }
  // 2. 优先取最后一条 Assistant 文本；如果最后一条只包含工具调用，则回退到最近的文本回复。
  let content = lastAssistantMessage.message.content.filter(
    _ => _.type === 'text',
  )
  if (content.length === 0) {
    for (let i = agentMessages.length - 1; i >= 0; i--) {
      const m = agentMessages[i]!
      if (m.type !== 'assistant') continue
      const textBlocks = m.message.content.filter(_ => _.type === 'text')
      if (textBlocks.length > 0) {
        content = textBlocks
        break
      }
    }
  }

  // 3. 汇总 token 和工具调用次数，作为 Agent 完成事件和结果元数据。
  const totalTokens = getTokenCountFromUsage(lastAssistantMessage.message.usage)
  const totalToolUseCount = countToolUses(agentMessages)

  // 4. 记录 AgentTool 完成事件，便于分析模型、耗时、工具调用和异步执行情况。
  logEvent('tengu_agent_tool_completed', {
    agent_type:
      agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    model:
      resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    prompt_char_count: prompt.length,
    response_char_count: content.length,
    assistant_message_count: agentMessages.length,
    total_tool_uses: totalToolUseCount,
    duration_ms: Date.now() - startTime,
    total_tokens: totalTokens,
    is_built_in_agent: isBuiltInAgent,
    is_async: isAsync,
  })

  // 5. 如果最后一次推理有 requestId，就提示推理侧该子 Agent 缓存链可以释放。
  const lastRequestId = lastAssistantMessage.requestId
  if (lastRequestId) {
    logEvent('tengu_cache_eviction_hint', {
      scope:
        'subagent_end' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      last_request_id:
        lastRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // 6. 返回主 Agent 和后台任务通知都能消费的统一结果结构。
  return {
    agentId,
    agentType,
    content,
    totalDurationMs: Date.now() - startTime,
    totalTokens,
    totalToolUseCount,
    usage: lastAssistantMessage.message.usage,
  }
}

/**
 * 读取一条消息中最后一个工具调用块的工具名。
 *
 * @param message 需要检查的消息。
 * @returns 如果消息是 assistant 且包含工具调用，则返回最后一个工具名；否则返回 `undefined`。
 */
export function getLastToolUseName(message: MessageType): string | undefined {
  // 1. 只有 Assistant 消息可能包含模型发起的 tool_use。
  if (message.type !== 'assistant') return undefined
  // 2. 从内容尾部查找最近一次工具调用，用于进度事件展示当前活动工具。
  const block = message.message.content.findLast(b => b.type === 'tool_use')
  return block?.type === 'tool_use' ? block.name : undefined
}

/**
 * 将后台 Agent 的当前进度转换为 SDK 任务进度事件。
 *
 * @param tracker 后台任务累计的进度跟踪器。
 * @param taskId 后台 Agent 任务 ID。
 * @param toolUseId 触发该 Agent 的工具调用 ID，可能为空。
 * @param description 任务默认描述，在没有更具体活动描述时使用。
 * @param startTime 任务启动时间戳，单位为毫秒。
 * @param lastToolName 最近一次工具调用名称。
 * @returns 无返回值；进度会通过 SDK 事件发送。
 */
export function emitTaskProgress(
  tracker: ProgressTracker,
  taskId: string,
  toolUseId: string | undefined,
  description: string,
  startTime: number,
  lastToolName: string,
): void {
  // 1. 从跟踪器读取当前 token、工具次数和最后活动描述。
  const progress = getProgressUpdate(tracker)
  // 2. 发送标准进度事件，让外部 SDK 或 UI 可以观察后台 Agent 活动。
  emitTaskProgressEvent({
    taskId,
    toolUseId,
    description: progress.lastActivity?.activityDescription ?? description,
    startTime,
    totalTokens: progress.tokenCount,
    toolUses: progress.toolUseCount,
    lastToolName,
  })
}

/**
 * 在自动权限模式下检查子 Agent 交接结果是否需要安全警告。
 *
 * @param params.agentMessages 子 Agent 完整消息列表。
 * @param params.tools 当前可用于构造分类 transcript 的工具集合。
 * @param params.toolPermissionContext 工具权限上下文，只有 auto 模式会触发分类。
 * @param params.abortSignal 用于取消分类请求的信号。
 * @param params.subagentType 子 Agent 类型名，用于分析日志。
 * @param params.totalToolUseCount 子 Agent 总工具调用次数。
 * @returns 没有风险时返回 `null`；分类器阻断或不可用时返回交接警告文本。
 */
export async function classifyHandoffIfNeeded({
  agentMessages,
  tools,
  toolPermissionContext,
  abortSignal,
  subagentType,
  totalToolUseCount,
}: {
  agentMessages: MessageType[]
  tools: Tools
  toolPermissionContext: AppState['toolPermissionContext']
  abortSignal: AbortSignal
  subagentType: string
  totalToolUseCount: number
}): Promise<string | null> {
  // 1. 只有启用 transcript 分类器时才执行交接检查。
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // 2. 交接分类只服务于自动权限模式，其他模式直接跳过。
    if (toolPermissionContext.mode !== 'auto') return null

    // 3. 构造分类器可读的 Agent transcript；无法构造时说明没有足够信息判断。
    const agentTranscript = buildTranscriptForClassifier(agentMessages, tools)
    if (!agentTranscript) return null

    // 4. 调用分类器判断子 Agent 的最终行为是否触碰自动模式阻断规则。
    const classifierResult = await classifyYoloAction(
      agentMessages,
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: "Sub-agent has finished and is handing back control to the main agent. Review the sub-agent's work based on the block rules and let the main agent know if any file is dangerous (the main agent will see the reason).",
          },
        ],
      },
      tools,
      toolPermissionContext as ToolPermissionContext,
      abortSignal,
    )

    // 5. 将分类器结果压缩成分析事件中的决策标签。
    const handoffDecision = classifierResult.unavailable
      ? 'unavailable'
      : classifierResult.shouldBlock
        ? 'blocked'
        : 'allowed'
    logEvent('tengu_auto_mode_decision', {
      decision:
        handoffDecision as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName:
        // 6. 分析口径沿用旧工具名，避免 Task 到 Agent 命名迁移造成指标断层。
        LEGACY_AGENT_TOOL_NAME as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      inProtectedNamespace: isInProtectedNamespace(),
      classifierModel:
        classifierResult.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      agentType:
        subagentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolUseCount: totalToolUseCount,
      isHandoff: true,
      // 7. 交接场景关注子 Agent 最后一条 Assistant 消息，即审查提示前的最终产物。
      agentMsgId: getLastAssistantMessage(agentMessages)?.message
        .id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage:
        classifierResult.stage as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage1RequestId:
        classifierResult.stage1RequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage1MsgId:
        classifierResult.stage1MsgId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage2RequestId:
        classifierResult.stage2RequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage2MsgId:
        classifierResult.stage2MsgId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    // 8. 分类器认为需要阻断时，返回给父 Agent 的不是静默失败，而是显式警告。
    if (classifierResult.shouldBlock) {
      // 9. 分类器不可用时仍交付子 Agent 结果，但要求父 Agent 谨慎复核。
      if (classifierResult.unavailable) {
        logForDebugging(
          'Handoff classifier unavailable, allowing sub-agent output with warning',
          { level: 'warn' },
        )
        return `Note: The safety classifier was unavailable when reviewing this sub-agent's work. Please carefully verify the sub-agent's actions and output before acting on them.`
      }

      // 10. 明确阻断时把原因写入警告文本，父 Agent 可据此决定后续处理。
      logForDebugging(
        `Handoff classifier flagged sub-agent output: ${classifierResult.reason}`,
        { level: 'warn' },
      )
      return `SECURITY WARNING: This sub-agent performed actions that may violate security policy. Reason: ${classifierResult.reason}. Review the sub-agent's actions carefully before acting on its output.`
    }
  }

  // 11. 未启用分类器、模式不匹配或分类器允许通过时，不追加任何交接警告。
  return null
}

/**
 * 从 Agent 已累计消息中提取最近的文本结果。
 *
 * @param messages Agent 运行期间已经产生的消息列表。
 * @returns 最近一条 Assistant 文本内容；没有可用文本时返回 `undefined`。
 */
export function extractPartialResult(
  messages: MessageType[],
): string | undefined {
  // 1. 从后往前找，优先保留异步 Agent 被终止前最新的可读结果。
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    // 2. 用户消息和工具结果不是 Agent 的最终表达，直接跳过。
    if (m.type !== 'assistant') continue
    const text = extractTextContent(m.message.content, '\n')
    if (text) {
      // 3. 找到非空文本后立即返回，避免旧消息覆盖最新进展。
      return text
    }
  }
  // 4. 没有 Assistant 文本时返回空值，调用方据此只发送状态通知。
  return undefined
}

/** React 风格的 AppState 更新函数类型，用于在异步 Agent 生命周期中更新根状态。 */
type SetAppState = (f: (prev: AppState) => AppState) => void

/**
 * 驱动后台 Agent 从消息流消费到最终任务通知的完整生命周期。
 *
 * @param params.taskId 后台任务 ID，同时也作为 Agent 结果 ID。
 * @param params.abortController 控制后台任务取消的控制器。
 * @param params.makeStream 创建 Agent 消息流的函数，可接收缓存安全参数回调。
 * @param params.metadata 收口 Agent 结果所需的模型、类型、提示词和启动时间。
 * @param params.description 后台任务展示描述。
 * @param params.toolUseContext 当前工具调用上下文，包含工具列表、状态读取和工具调用 ID。
 * @param params.rootSetAppState 更新根 AppState 的函数。
 * @param params.agentIdForCleanup 需要清理技能调用状态和 dump 状态的 Agent ID。
 * @param params.enableSummarization 是否为后台 Agent 启动持续摘要。
 * @param params.getWorktreeResult 获取工作树路径和分支信息的函数。
 * @returns 后台 Agent 完成、失败或被终止后的异步流程结果。
 */
export async function runAsyncAgentLifecycle({
  taskId,
  abortController,
  makeStream,
  metadata,
  description,
  toolUseContext,
  rootSetAppState,
  agentIdForCleanup,
  enableSummarization,
  getWorktreeResult,
}: {
  taskId: string
  abortController: AbortController
  makeStream: (
    onCacheSafeParams: ((p: CacheSafeParams) => void) | undefined,
  ) => AsyncGenerator<MessageType, void>
  metadata: Parameters<typeof finalizeAgentTool>[2]
  description: string
  toolUseContext: ToolUseContext
  rootSetAppState: SetAppState
  agentIdForCleanup: string
  enableSummarization: boolean
  getWorktreeResult: () => Promise<{
    worktreePath?: string
    worktreeBranch?: string
  }>
}): Promise<void> {
  let stopSummarization: (() => void) | undefined
  const agentMessages: MessageType[] = []
  try {
    // 1. 初始化进度跟踪器和活动描述解析器，用于把消息流转换为 UI/SDK 可读进度。
    const tracker = createProgressTracker()
    const resolveActivity = createActivityDescriptionResolver(
      toolUseContext.options.tools,
    )
    // 2. 如果启用后台摘要，则在首次收到缓存安全参数时启动摘要任务并保存停止函数。
    const onCacheSafeParams = enableSummarization
      ? (params: CacheSafeParams) => {
          const { stop } = startAgentSummarization(
            taskId,
            asAgentId(taskId),
            params,
            rootSetAppState,
          )
          stopSummarization = stop
        }
      : undefined
    // 3. 消费 Agent 消息流，所有消息都先进入内存数组，后续用于结果收口和异常通知。
    for await (const message of makeStream(onCacheSafeParams)) {
      agentMessages.push(message)
      // 4. 当 UI 需要保留任务消息时立即追加；磁盘前缀会按 UUID 合并，因此实时消息保持为后缀。
      rootSetAppState(prev => {
        const t = prev.tasks[taskId]
        if (!isLocalAgentTask(t) || !t.retain) return prev
        const base = t.messages ?? []
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: { ...t, messages: [...base, message] },
          },
        }
      })
      // 5. 根据新消息更新工具次数、token 估计和最后活动描述。
      updateProgressFromMessage(
        tracker,
        message,
        resolveActivity,
        toolUseContext.options.tools,
      )
      // 6. 将聚合后的进度写回任务状态，驱动界面和 TaskOutput 观察到最新进度。
      updateAsyncAgentProgress(
        taskId,
        getProgressUpdate(tracker),
        rootSetAppState,
      )
      // 7. 如果本条消息包含工具调用，则额外发送 SDK 进度事件。
      const lastToolName = getLastToolUseName(message)
      if (lastToolName) {
        emitTaskProgress(
          tracker,
          taskId,
          toolUseContext.toolUseId,
          description,
          metadata.startTime,
          lastToolName,
        )
      }
    }

    // 8. 消息流正常结束后停止后台摘要，避免任务完成后继续消耗资源。
    stopSummarization?.()

    // 9. 将消息流收口为 AgentTool 结果，包含最终文本、usage、耗时和工具调用次数。
    const agentResult = finalizeAgentTool(agentMessages, taskId, metadata)

    // 10. 先标记任务完成，让阻塞式 TaskOutput 立即解锁；交接分类和 git 信息只作为通知增强。
    completeAsyncAgent(agentResult, rootSetAppState)

    // 11. 提取最终文本，后续可能追加交接安全警告。
    let finalMessage = extractTextContent(agentResult.content, '\n')

    // 12. 启用 transcript 分类器时，在子 Agent 交接给父 Agent 前追加必要警告。
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      const handoffWarning = await classifyHandoffIfNeeded({
        agentMessages,
        tools: toolUseContext.options.tools,
        toolPermissionContext:
          toolUseContext.getAppState().toolPermissionContext,
        abortSignal: abortController.signal,
        subagentType: metadata.agentType,
        totalToolUseCount: agentResult.totalToolUseCount,
      })
      if (handoffWarning) {
        finalMessage = `${handoffWarning}\n\n${finalMessage}`
      }
    }

    // 13. 获取工作树信息并发送完成通知，供任务列表或调用方展示最终状态。
    const worktreeResult = await getWorktreeResult()

    enqueueAgentNotification({
      taskId,
      description,
      status: 'completed',
      setAppState: rootSetAppState,
      finalMessage,
      usage: {
        totalTokens: getTokenCountFromTracker(tracker),
        toolUses: agentResult.totalToolUseCount,
        durationMs: agentResult.totalDurationMs,
      },
      toolUseId: toolUseContext.toolUseId,
      ...worktreeResult,
    })
  } catch (error) {
    // 14. 任意异常都会先停止摘要，避免错误路径留下后台摘要循环。
    stopSummarization?.()
    if (error instanceof AbortError) {
      // 15. 用户终止时先切换任务状态，再做工作树清理和通知，避免 git 阻塞导致 TaskOutput 不解锁。
      killAsyncAgent(taskId, rootSetAppState)
      // 16. 记录用户终止事件，保留 Agent 类型、模型、耗时和异步标记。
      logEvent('tengu_agent_tool_terminated', {
        agent_type:
          metadata.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        model:
          metadata.resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        duration_ms: Date.now() - metadata.startTime,
        is_async: true,
        is_built_in_agent: metadata.isBuiltInAgent,
        reason:
          'user_kill_async' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      // 17. 终止通知尽量附带工作树信息和已产生的最新文本，方便用户接着判断进展。
      const worktreeResult = await getWorktreeResult()
      const partialResult = extractPartialResult(agentMessages)
      enqueueAgentNotification({
        taskId,
        description,
        status: 'killed',
        setAppState: rootSetAppState,
        toolUseId: toolUseContext.toolUseId,
        finalMessage: partialResult,
        ...worktreeResult,
      })
      return
    }
    // 18. 非取消异常标记为失败，并把标准化错误消息写入任务状态和通知。
    const msg = errorMessage(error)
    failAsyncAgent(taskId, msg, rootSetAppState)
    const worktreeResult = await getWorktreeResult()
    enqueueAgentNotification({
      taskId,
      description,
      status: 'failed',
      error: msg,
      setAppState: rootSetAppState,
      toolUseId: toolUseContext.toolUseId,
      ...worktreeResult,
    })
  } finally {
    // 19. 无论成功、失败还是终止，都清理该 Agent 的技能调用状态和 prompt dump 状态。
    clearInvokedSkillsForAgent(agentIdForCleanup)
    clearDumpState(agentIdForCleanup)
  }
}
