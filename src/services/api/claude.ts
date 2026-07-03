import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaJSONOutputFormat,
  BetaMessage,
  BetaMessageDeltaUsage,
  BetaMessageStreamParams,
  BetaOutputConfig,
  BetaRawMessageStreamEvent,
  BetaRequestDocumentBlock,
  BetaStopReason,
  BetaToolChoiceAuto,
  BetaToolChoiceTool,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaUsage,
  BetaMessageParam as MessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Stream } from '@anthropic-ai/sdk/streaming.mjs'
import { randomUUID } from 'crypto'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from 'src/utils/model/providers.js'
import {
  getAttributionHeader,
  getCLISyspromptPrefix,
} from '../../constants/system.js'
import {
  getEmptyToolPermissionContext,
  type QueryChainTracking,
  type Tool,
  type ToolPermissionContext,
  type Tools,
  toolMatchesName,
} from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import {
  type ConnectorTextBlock,
  type ConnectorTextDelta,
  isConnectorTextBlock,
} from '../../types/connectorText.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  UserMessage,
} from '../../types/message.js'
import {
  type CacheScope,
  logAPIPrefix,
  splitSysPromptPrefix,
  toolToAPISchema,
} from '../../utils/api.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import {
  getBedrockExtraBodyParamsBetas,
  getMergedBetas,
  getModelBetas,
} from '../../utils/betas.js'
import { getOrCreateUserID } from '../../utils/config.js'
import {
  CAPPED_DEFAULT_MAX_TOKENS,
  getModelMaxOutputTokens,
  getSonnet1mExpTreatmentEnabled,
} from '../../utils/context.js'
import { resolveAppliedEffort } from '../../utils/effort.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { computeFingerprintFromMessages } from '../../utils/fingerprint.js'
import { captureAPIRequest, logError } from '../../utils/log.js'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
  ensureToolResultPairing,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
  stripAdvisorBlocks,
  stripCallerFieldFromAssistantMessage,
  stripToolReferenceBlocksFromUserMessage,
} from '../../utils/messages.js'
import {
  getDefaultOpusModel,
  getDefaultSonnetModel,
  getSmallFastModel,
  isNonCustomOpusModel,
} from '../../utils/model/model.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPromptType.js'
import { tokenCountFromLastAPIResponse } from '../../utils/tokens.js'
import { getDynamicConfig_BLOCKS_ON_INIT } from '../analytics/growthbook.js'
import {
  currentLimits,
  extractQuotaStatusFromError,
  extractQuotaStatusFromHeaders,
} from '../claudeAiLimits.js'
import { getAPIContextManagement } from '../compact/apiMicrocompact.js'

/* eslint-disable @typescript-eslint/no-require-imports */
/** auto mode 状态模块只在 transcript classifier 特性开启时懒加载，避免默认路径引入额外权限状态依赖。 */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('../../utils/permissions/autoModeState.js') as typeof import('../../utils/permissions/autoModeState.js'))
  : null

import { feature } from 'bun:bundle'
import type { ClientOptions } from '@anthropic-ai/sdk'
import {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk/error'
import {
  getAfkModeHeaderLatched,
  getCacheEditingHeaderLatched,
  getFastModeHeaderLatched,
  getLastApiCompletionTimestamp,
  getPromptCache1hAllowlist,
  getPromptCache1hEligible,
  getSessionId,
  getThinkingClearLatched,
  setAfkModeHeaderLatched,
  setCacheEditingHeaderLatched,
  setFastModeHeaderLatched,
  setLastMainRequestId,
  setPromptCache1hAllowlist,
  setPromptCache1hEligible,
  setThinkingClearLatched,
} from 'src/bootstrap/state.js'
import {
  AFK_MODE_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  EFFORT_BETA_HEADER,
  FAST_MODE_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  TASK_BUDGETS_BETA_HEADER,
} from 'src/constants/betas.js'
import type { QuerySource } from 'src/constants/querySource.js'
import type { Notification } from 'src/context/notifications.js'
import { addToTotalSessionCost } from 'src/cost-tracker.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import type { AgentId } from 'src/types/ids.js'
import {
  ADVISOR_TOOL_INSTRUCTIONS,
  getExperimentAdvisorModels,
  isAdvisorEnabled,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from 'src/utils/advisor.js'
import { getAgentContext } from 'src/utils/agentContext.js'
import { isClaudeAISubscriber } from 'src/utils/auth.js'
import {
  getToolSearchBetaHeader,
  modelSupportsStructuredOutputs,
  shouldIncludeFirstPartyOnlyBetas,
  shouldUseGlobalCacheScope,
} from 'src/utils/betas.js'
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME } from 'src/utils/claudeInChrome/common.js'
import { CHROME_TOOL_SEARCH_INSTRUCTIONS } from 'src/utils/claudeInChrome/prompt.js'
import { getMaxThinkingTokensForModel } from 'src/utils/context.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { type EffortValue, modelSupportsEffort } from 'src/utils/effort.js'
import {
  isFastModeAvailable,
  isFastModeCooldown,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from 'src/utils/fastMode.js'
import { returnValue } from 'src/utils/generators.js'
import { headlessProfilerCheckpoint } from 'src/utils/headlessProfiler.js'
import { isMcpInstructionsDeltaEnabled } from 'src/utils/mcpInstructionsDelta.js'
import { calculateUSDCost } from 'src/utils/modelCost.js'
import { endQueryProfile, queryCheckpoint } from 'src/utils/queryProfiler.js'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
  type ThinkingConfig,
} from 'src/utils/thinking.js'
import {
  extractDiscoveredToolNames,
  isDeferredToolsDeltaEnabled,
  isToolSearchEnabled,
} from 'src/utils/toolSearch.js'
import { API_MAX_MEDIA_PER_REQUEST } from '../../constants/apiLimits.js'
import { ADVISOR_BETA_HEADER } from '../../constants/betas.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  TOOL_SEARCH_TOOL_NAME,
} from '../../tools/ToolSearchTool/prompt.js'
import { count } from '../../utils/array.js'
import { insertBlockAfterToolResults } from '../../utils/contentArray.js'
import { validateBoundedIntEnvVar } from '../../utils/envValidation.js'
import { safeParseJSON } from '../../utils/json.js'
import { getInferenceProfileBackingModel } from '../../utils/model/bedrock.js'
import {
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import {
  startSessionActivity,
  stopSessionActivity,
} from '../../utils/sessionActivity.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  isBetaTracingEnabled,
  type LLMRequestNewContext,
  startLLMRequestSpan,
} from '../../utils/telemetry/sessionTracing.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  consumePendingCacheEdits,
  getPinnedCacheEdits,
  markToolsSentToAPIState,
  pinCacheEdits,
} from '../compact/microCompact.js'
import { getInitializationStatus } from '../lsp/manager.js'
import { isToolFromMcpServer } from '../mcp/utils.js'
import { withStreamingVCR, withVCR } from '../vcr.js'
import { CLIENT_REQUEST_ID_HEADER, getAnthropicClient } from './client.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  CUSTOM_OFF_SWITCH_MESSAGE,
  getAssistantMessageFromError,
  getErrorMessageIfRefusal,
} from './errors.js'
import {
  EMPTY_USAGE,
  type GlobalCacheStrategy,
  logAPIError,
  logAPIQuery,
  logAPISuccessAndDuration,
  type NonNullableUsage,
} from './logging.js'
import {
  CACHE_TTL_1HOUR_MS,
  checkResponseForCacheBreak,
  recordPromptState,
} from './promptCacheBreakDetection.js'
import {
  CannotRetryError,
  FallbackTriggeredError,
  is529Error,
  type RetryContext,
  withRetry,
} from './withRetry.js'

/**
 * Claude API 请求编排模块。
 *
 * 该文件负责把内部消息、系统提示词、工具定义、缓存策略、模型能力和重试上下文组装成 Claude API 请求，并处理流式响应、非流式降级、用量统计、错误转换和提示词缓存断点。
 * 它位于业务会话和底层 SDK 之间，因此注释重点说明“为什么要这样组装请求”和“哪些状态需要保持会话稳定”，避免调用方误改缓存键、beta header 或流式清理路径。
 */

/** 可被安全放入 API 额外请求体或 metadata 的 JSON 值。 */
type JsonValue = string | number | boolean | null | JsonObject | JsonArray
/** JSON 对象结构，键为字符串，值仍然必须是 JSON 可表示的数据。 */
type JsonObject = { [key: string]: JsonValue }
/** JSON 数组结构，用于表达环境变量中传入的数组型额外参数。 */
type JsonArray = JsonValue[]

/**
 * 组装 Claude API 请求的额外 body 参数。
 *
 * 该方法会合并用户通过环境变量传入的 JSON 对象，以及 provider 需要放入 body 的 beta header，确保缓存对象不会被原地污染。
 *
 * @param betaHeaders 需要追加到 `anthropic_beta` 的 beta header 列表，主要用于 Bedrock 等不能走普通 `betas` 字段的 provider。
 * @returns 可直接展开进 API 请求参数的 JSON 对象。
 */
export function getExtraBodyParams(betaHeaders?: string[]): JsonObject {
  // 1. 先解析用户通过环境变量传入的额外 body，只有对象才能安全展开到请求参数中。
  const extraBodyStr = process.env.CLAUDE_CODE_EXTRA_BODY
  let result: JsonObject = {}

  if (extraBodyStr) {
    try {
      const parsed = safeParseJSON(extraBodyStr)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // 2. 对解析结果做浅拷贝，避免后续写入 beta 字段时污染 safeParseJSON 的 LRU 缓存对象。
        result = { ...(parsed as JsonObject) }
      } else {
        logForDebugging(
          `CLAUDE_CODE_EXTRA_BODY env var must be a JSON object, but was given ${extraBodyStr}`,
          { level: 'error' },
        )
      }
    } catch (error) {
      logForDebugging(
        `Error parsing CLAUDE_CODE_EXTRA_BODY: ${errorMessage(error)}`,
        { level: 'error' },
      )
    }
  }

  // 3. 一方 CLI 且实验开启时，追加反蒸馏 opt-in；第三方 provider 不携带该内部字段。
  if (
    feature('ANTI_DISTILLATION_CC')
      ? process.env.CLAUDE_CODE_ENTRYPOINT === 'cli' &&
        shouldIncludeFirstPartyOnlyBetas() &&
        getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_anti_distill_fake_tool_injection',
          false,
        )
      : false
  ) {
    result.anti_distillation = ['fake_tools']
  }

  // 4. 将 body 形式的 beta header 合并到 anthropic_beta，并去重保留用户已有配置。
  if (betaHeaders && betaHeaders.length > 0) {
    if (result.anthropic_beta && Array.isArray(result.anthropic_beta)) {
      const existingHeaders = result.anthropic_beta as string[]
      const newHeaders = betaHeaders.filter(
        header => !existingHeaders.includes(header),
      )
      result.anthropic_beta = [...existingHeaders, ...newHeaders]
    } else {
      result.anthropic_beta = betaHeaders
    }
  }

  return result
}

/**
 * 判断指定模型本次请求是否启用 prompt caching。
 *
 * @param model API 模型名，按当前默认 Haiku/Sonnet/Opus 配置和环境变量进行匹配。
 * @returns 未被全局或模型族环境变量关闭时返回 true。
 */
export function getPromptCachingEnabled(model: string): boolean {
  // 1. 全局禁用优先级最高，命中后不再检查具体模型。
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING)) return false

  // 2. 针对小模型、默认 Sonnet、默认 Opus 分别允许通过环境变量禁用缓存。
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_HAIKU)) {
    const smallFastModel = getSmallFastModel()
    if (model === smallFastModel) return false
  }

  // 3. 默认 Sonnet 可单独关闭缓存，用于排查该模型族的缓存问题。
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_SONNET)) {
    const defaultSonnet = getDefaultSonnetModel()
    if (model === defaultSonnet) return false
  }

  // 4. 默认 Opus 可单独关闭缓存，避免影响其他模型族。
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_OPUS)) {
    const defaultOpus = getDefaultOpusModel()
    if (model === defaultOpus) return false
  }

  return true
}

/**
 * 构造文本块上的 `cache_control` 标记。
 *
 * @param scope 缓存作用域；只有 global 会显式写入 API 参数。
 * @param querySource 请求来源，用于判断是否允许 1 小时 TTL。
 * @returns Anthropic API 支持的临时缓存控制对象。
 */
export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope
  querySource?: QuerySource
} = {}): {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
} {
  // 1. 基础缓存类型固定为 ephemeral，再按来源和作用域补充 TTL 与 global scope。
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}

/**
 * 判断当前请求是否应该使用 1 小时 prompt cache TTL。
 *
 * @param querySource 请求来源，例如主线程、SDK 或子 Agent，用于匹配 GrowthBook allowlist。
 * @returns 用户资格和来源规则都满足时返回 true。
 */
function should1hCacheTTL(querySource?: QuerySource): boolean {
  // 1. Bedrock 用户如果通过环境变量显式开启 1h TTL，直接放行；第三方账单由用户自行承担，不走 GrowthBook。
  if (
    getAPIProvider() === 'bedrock' &&
    isEnvTruthy(process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK)
  ) {
    return true
  }

  // 2. 将用户资格锁存在会话状态里，避免 overage 状态中途变化导致 cache_control TTL 抖动。
  let userEligible = getPromptCache1hEligible()
  if (userEligible === null) {
    userEligible =
      process.env.USER_TYPE === 'ant' ||
      (isClaudeAISubscriber() && !currentLimits.isUsingOverage)
    setPromptCache1hEligible(userEligible)
  }
  if (!userEligible) return false

  // 3. 将 allowlist 同样锁存在会话状态里，避免 GrowthBook 本地缓存刷新后同一会话出现混合 TTL。
  let allowlist = getPromptCache1hAllowlist()
  if (allowlist === null) {
    const config = getFeatureValue_CACHED_MAY_BE_STALE<{
      allowlist?: string[]
    }>('tengu_prompt_cache_1h_config', {})
    allowlist = config.allowlist ?? []
    setPromptCache1hAllowlist(allowlist)
  }

  return (
    querySource !== undefined &&
    allowlist.some(pattern =>
      pattern.endsWith('*')
        ? querySource.startsWith(pattern.slice(0, -1))
        : querySource === pattern,
    )
  )
}

/**
 * 为支持 effort 的模型写入 API 请求参数。
 *
 * @param effortValue 调用方指定的 effort 值；未指定时仅携带 beta header，让服务端使用默认策略。
 * @param outputConfig 即将发送的 output_config，会被原地补充 effort。
 * @param extraBodyParams 额外请求体；内部数字 effort 会写入 `anthropic_internal`。
 * @param betas 当前请求 beta header 列表，必要时追加 effort beta。
 * @param model 目标模型名，用于判断是否支持 effort。
 * @returns 无返回值；通过修改 `outputConfig`、`extraBodyParams` 和 `betas` 生效。
 */
function configureEffortParams(
  effortValue: EffortValue | undefined,
  outputConfig: BetaOutputConfig,
  extraBodyParams: Record<string, unknown>,
  betas: string[],
  model: string,
): void {
  // 1. 不支持 effort 或调用方已经显式写入 output_config.effort 时，不覆盖现有请求参数。
  if (!modelSupportsEffort(model) || 'effort' in outputConfig) {
    return
  }

  // 2. 字符串 effort 作为公开参数发送；数字 override 只允许 ant 内部请求使用。
  if (effortValue === undefined) {
    betas.push(EFFORT_BETA_HEADER)
  } else if (typeof effortValue === 'string') {
    outputConfig.effort = effortValue
    betas.push(EFFORT_BETA_HEADER)
  } else if (process.env.USER_TYPE === 'ant') {
    const existingInternal =
      (extraBodyParams.anthropic_internal as Record<string, unknown>) || {}
    extraBodyParams.anthropic_internal = {
      ...existingInternal,
      effort_override: effortValue,
    }
  }
}

/** API 侧任务预算参数；SDK 类型暂未内置该字段，因此在本文件声明 wire 结构。 */
type TaskBudgetParam = {
  /** 预算类型，目前只支持按 token 计量。 */
  type: 'tokens'
  /** 整个任务的总预算 token 数。 */
  total: number
  /** 当前请求开始前剩余的预算 token 数，由上层 agentic loop 计算。 */
  remaining?: number
}

/**
 * 将任务预算写入 API output_config。
 *
 * @param taskBudget 上层传入的总预算和剩余额度；未传时不写入。
 * @param outputConfig 即将发送的 output_config，会在满足条件时原地补充 `task_budget`。
 * @param betas 当前请求 beta header 列表，必要时追加 task budget beta。
 * @returns 无返回值；通过修改 `outputConfig` 和 `betas` 生效。
 */
export function configureTaskBudgetParams(
  taskBudget: Options['taskBudget'],
  outputConfig: BetaOutputConfig & { task_budget?: TaskBudgetParam },
  betas: string[],
): void {
  // 1. 没有预算、调用方已写入预算或当前 provider 不允许一方 beta 时，保持请求不变。
  if (
    !taskBudget ||
    'task_budget' in outputConfig ||
    !shouldIncludeFirstPartyOnlyBetas()
  ) {
    return
  }
  // 2. 写入 API 约定的 task_budget 结构，并只在 remaining 有值时携带该字段。
  outputConfig.task_budget = {
    type: 'tokens',
    total: taskBudget.total,
    ...(taskBudget.remaining !== undefined && {
      remaining: taskBudget.remaining,
    }),
  }
  // 3. 确保 beta header 存在且不重复。
  if (!betas.includes(TASK_BUDGETS_BETA_HEADER)) {
    betas.push(TASK_BUDGETS_BETA_HEADER)
  }
}

/**
 * 生成发送给 API metadata 的用户标识字段。
 *
 * @returns 包含设备、OAuth 账号和会话 ID 的 metadata 对象，值会被序列化到 `user_id` 字段中。
 */
export function getAPIMetadata() {
  // 1. 读取调用方通过环境变量提供的额外 metadata；只有 JSON 对象才允许合并。
  let extra: JsonObject = {}
  const extraStr = process.env.CLAUDE_CODE_EXTRA_METADATA
  if (extraStr) {
    const parsed = safeParseJSON(extraStr, false)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      extra = parsed as JsonObject
    } else {
      logForDebugging(
        `CLAUDE_CODE_EXTRA_METADATA env var must be a JSON object, but was given ${extraStr}`,
        { level: 'error' },
      )
    }
  }

  // 2. 将额外字段和稳定设备/账号/会话信息合并成 API 期望的字符串字段。
  return {
    user_id: jsonStringify({
      ...extra,
      device_id: getOrCreateUserID(),
      // 3. 只有当前确实使用 OAuth 时才写入账号 UUID，避免 API key 场景混入旧账号信息。
      account_uuid: getOauthAccountInfo()?.accountUuid ?? '',
      session_id: getSessionId(),
    }),
  }
}

/**
 * 通过一次最小化消息请求验证 API key 是否可用。
 *
 * @param apiKey 待验证的 API key。
 * @param isNonInteractiveSession 是否为非交互会话；非交互模式跳过验证，避免 print 模式额外阻塞。
 * @returns key 明确有效时返回 true，认证错误时返回 false，其他网络或服务错误继续抛出。
 */
export async function verifyApiKey(
  apiKey: string,
  isNonInteractiveSession: boolean,
): Promise<boolean> {
  // 1. 非交互场景不做主动探测，避免脚本模式因验证请求产生额外延迟或失败面。
  if (isNonInteractiveSession) {
    return true
  }

  try {
    // 2. 使用小快模型发起最小 token 请求，降低验证成本并避免主模型能力差异影响 key 判断。
    const model = getSmallFastModel()
    const betas = getModelBetas(model)
    return await returnValue(
      withRetry(
        () =>
          getAnthropicClient({
            apiKey,
            maxRetries: 3,
            model,
            source: 'verify_api_key',
          }),
        async anthropic => {
          const messages: MessageParam[] = [{ role: 'user', content: 'test' }]
          // biome-ignore lint/plugin: API key 验证故意使用最小直接调用，不走完整业务封装。
          await anthropic.beta.messages.create({
            model,
            max_tokens: 1,
            messages,
            temperature: 1,
            ...(betas.length > 0 && { betas }),
            metadata: getAPIMetadata(),
            ...getExtraBodyParams(),
          })
          return true
        },
        { maxRetries: 2, model, thinkingConfig: { type: 'disabled' } },
      ),
    )
  } catch (errorFromRetry) {
    // 3. withRetry 可能包裹不可重试错误，先还原真实错误再做认证错误判断。
    let error = errorFromRetry
    if (errorFromRetry instanceof CannotRetryError) {
      error = errorFromRetry.originalError
    }
    logError(error)
    // 4. 只有明确的 invalid x-api-key 返回 false，其余错误交给调用方按普通 API 错误处理。
    if (
      error instanceof Error &&
      error.message.includes(
        '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      )
    ) {
      return false
    }
    throw error
  }
}

/**
 * 将内部 user 消息转换成 Anthropic API 的 message 参数。
 *
 * @param message 内部 user 消息，内容可以是字符串或多模态 block 数组。
 * @param addCache 是否在该消息的最后一个可缓存 block 上添加 cache_control。
 * @param enablePromptCaching 当前请求是否启用 prompt caching。
 * @param querySource 请求来源，用于决定 cache_control TTL。
 * @returns 可直接放入 API `messages` 数组的 user 消息。
 */
export function userMessageToMessageParam(
  message: UserMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): MessageParam {
  // 1. 需要加缓存标记时，把字符串内容规范成 text block，方便挂载 cache_control。
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      // 2. 数组内容只给最后一个 block 加缓存标记，保证请求里只有一个消息级缓存断点。
      return {
        role: 'user',
        content: message.message.content.map((_, i) => ({
          ..._,
          ...(i === message.message.content.length - 1
            ? enablePromptCaching
              ? { cache_control: getCacheControl({ querySource }) }
              : {}
            : {}),
        })),
      }
    }
  }
  // 3. 不加缓存时仍要浅拷贝数组内容，避免后续 cache_edits 插入污染原始消息对象。
  return {
    role: 'user',
    content: Array.isArray(message.message.content)
      ? [...message.message.content]
      : message.message.content,
  }
}

/**
 * 将内部 assistant 消息转换成 Anthropic API 的 message 参数。
 *
 * @param message 内部 assistant 消息，可能包含文本、工具调用、thinking 或 connector 文本块。
 * @param addCache 是否在该消息的最后一个可缓存块上添加 cache_control。
 * @param enablePromptCaching 当前请求是否启用 prompt caching。
 * @param querySource 请求来源，用于决定 cache_control TTL。
 * @returns 可直接放入 API `messages` 数组的 assistant 消息。
 */
export function assistantMessageToMessageParam(
  message: AssistantMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): MessageParam {
  // 1. 字符串 assistant 内容需要先转为 text block，才能携带 cache_control。
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      // 2. 数组内容只给最后一个普通可缓存块加标记；thinking、redacted thinking 和 connector text 不写缓存标记。
      return {
        role: 'assistant',
        content: message.message.content.map((_, i) => ({
          ..._,
          ...(i === message.message.content.length - 1 &&
          _.type !== 'thinking' &&
          _.type !== 'redacted_thinking' &&
          (feature('CONNECTOR_TEXT') ? !isConnectorTextBlock(_) : true)
            ? enablePromptCaching
              ? { cache_control: getCacheControl({ querySource }) }
              : {}
            : {}),
        })),
      }
    }
  }
  // 3. 不需要缓存标记时，保持 assistant 内容结构原样传给 API。
  return {
    role: 'assistant',
    content: message.message.content,
  }
}

/** Claude API 查询入口的统一选项集合，覆盖模型、工具、缓存、降级、输出格式和请求来源。 */
export type Options = {
  /** 异步读取当前工具权限上下文，用于日志和权限敏感的工具 schema 生成。 */
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  /** 本次请求使用的模型名，可能是用户指定名或内部默认模型。 */
  model: string
  /** API tool_choice 参数，用于限制自动工具选择或强制调用某个工具。 */
  toolChoice?: BetaToolChoiceTool | BetaToolChoiceAuto | undefined
  /** 是否为非交互会话；影响系统提示词和部分验证逻辑。 */
  isNonInteractiveSession: boolean
  /** 调用方额外传入的 API 工具 schema，通常用于 server-side tool 或结构化输出。 */
  extraToolSchemas?: BetaToolUnion[]
  /** 覆盖默认输出 token 上限；优先级高于模型默认值。 */
  maxOutputTokensOverride?: number
  /** 主模型失败时可切换的备用模型。 */
  fallbackModel?: string
  /** 流式请求降级为非流式请求时触发的回调。 */
  onStreamingFallback?: () => void
  /** 请求来源，用于缓存策略、日志归因和 1h TTL allowlist。 */
  querySource: QuerySource
  /** 当前可用的 Agent 定义，用于 AgentTool schema 生成和限制。 */
  agents: AgentDefinition[]
  /** 当前上下文允许调用的 Agent 类型白名单。 */
  allowedAgentTypes?: string[]
  /** 是否存在调用方追加的系统提示词，用于系统 prompt 前缀说明。 */
  hasAppendSystemPrompt: boolean
  /** 测试或特殊运行环境可传入 fetch 覆盖实现。 */
  fetchOverride?: ClientOptions['fetch']
  /** 是否启用 prompt caching；未传时按模型和环境变量自动判断。 */
  enablePromptCaching?: boolean
  /** 是否跳过写缓存；用于后台 fork 等不希望留下请求尾部缓存的场景。 */
  skipCacheWrite?: boolean
  /** 温度覆盖值；thinking 开启时不会发送给 API。 */
  temperatureOverride?: number
  /** effort 配置，支持公开字符串级别和 ant 内部数字 override。 */
  effortValue?: EffortValue
  /** MCP 工具集合，用于 ToolSearch 和工具 schema 生成。 */
  mcpTools: Tools
  /** 是否还有 MCP server 正在连接；有 pending 时保留 ToolSearch 入口。 */
  hasPendingMcpServers?: boolean
  /** 请求链路追踪信息，用于日志串联主线程、Agent 或 teammate 请求。 */
  queryTracking?: QueryChainTracking
  /** 子 Agent ID；只有子 Agent 请求会设置。 */
  agentId?: AgentId
  /** 结构化输出格式，写入 output_config.format。 */
  outputFormat?: BetaJSONOutputFormat
  /** 调用方是否请求 fast mode；最终还会受模型、冷却和全局开关约束。 */
  fastMode?: boolean
  /** Advisor server tool 使用的模型配置。 */
  advisorModel?: string
  /** 追加 UI 通知的回调，供请求链路向上层报告状态。 */
  addNotification?: (notif: Notification) => void
  /** API 侧任务预算，会发送给模型帮助它规划输出节奏；不同于本地 auto-continue token 预算。 */
  taskBudget?: { total: number; remaining?: number }
}

/**
 * 使用流式底层实现执行一次非流式查询，并返回最终 assistant 消息。
 *
 * @param messages 当前会话消息。
 * @param systemPrompt 系统提示词块。
 * @param thinkingConfig thinking 配置。
 * @param tools 本次请求可用工具集合。
 * @param signal 中断信号。
 * @param options API 查询选项。
 * @returns 最后一个 assistant 消息；如果用户中断则抛出 APIUserAbortError。
 */
export async function queryModelWithoutStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): Promise<AssistantMessage> {
  // 1. 持续消费底层 generator，确保成功日志和资源释放逻辑能执行到最后。
  let assistantMessage: AssistantMessage | undefined
  for await (const message of withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })) {
    // 2. 保存最后一个 assistant 消息，但不提前 break，避免跳过后续清理和统计。
    if (message.type === 'assistant') {
      assistantMessage = message
    }
  }
  if (!assistantMessage) {
    // 3. 没有 assistant 时优先识别用户中断，让上层按中断流程展示，而不是普通执行错误。
    if (signal.aborted) {
      throw new APIUserAbortError()
    }
    throw new Error('No assistant message found')
  }
  return assistantMessage
}

/**
 * 执行一次流式 Claude 查询。
 *
 * @param messages 当前会话消息。
 * @param systemPrompt 系统提示词块。
 * @param thinkingConfig thinking 配置。
 * @param tools 本次请求可用工具集合。
 * @param signal 中断信号。
 * @param options API 查询选项。
 * @returns 异步流，依次产出原始流事件、assistant 增量消息或系统级 API 错误消息。
 */
export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  // 1. 通过 VCR 包装主查询逻辑，测试录制/回放时仍保持流式产出形态。
  return yield* withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })
}

/**
 * 判断 LSP 工具是否需要延迟加载。
 *
 * @param tool 待生成 schema 的工具。
 * @returns LSP 尚未初始化完成时返回 true，让工具以 defer_loading 方式发送。
 */
function shouldDeferLspTool(tool: Tool): boolean {
  // 1. 非 LSP 工具不受 LSP 初始化状态影响。
  if (!('isLsp' in tool) || !tool.isLsp) {
    return false
  }
  const status = getInitializationStatus()
  // 2. 初始化尚未开始或仍在 pending 时延迟暴露，避免模型提前调用不可用工具。
  return status.status === 'pending' || status.status === 'not-started'
}

/**
 * 计算非流式 fallback 单次请求超时时间。
 *
 * @returns 超时时间，单位毫秒；远端会话默认更短，避免容器空闲回收前一直挂住。
 */
function getNonstreamingFallbackTimeoutMs(): number {
  // 1. 显式环境变量优先生效，使慢后端和流式路径共用同一个超时上限。
  const override = parseInt(process.env.API_TIMEOUT_MS || '', 10)
  if (override) return override
  // 2. 远端会话使用 120 秒，本地会话使用 300 秒，二者都低于 API 非流式 10 分钟边界。
  return isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ? 120_000 : 300_000
}

/**
 * 执行非流式 API 请求并保留 withRetry 的系统消息产出能力。
 *
 * @param clientOptions 创建 Anthropic client 所需的模型、fetch 覆盖和来源。
 * @param retryOptions 重试、fallback、thinking、fast mode 和中断相关配置。
 * @param paramsFromContext 根据重试上下文生成最终 API 请求参数的回调。
 * @param onAttempt 每次尝试发起前的通知回调，用于记录 attempt 和 max_tokens。
 * @param captureRequest 捕获请求参数的回调，用于 bug report 或回放。
 * @param originatingRequestId 触发 fallback 的流式请求 ID，用于日志关联。
 * @returns generator 会产出系统错误消息，最终返回非流式 API 的 BetaMessage。
 */
export async function* executeNonStreamingRequest(
  clientOptions: {
    model: string
    fetchOverride?: Options['fetchOverride']
    source: string
  },
  retryOptions: {
    model: string
    fallbackModel?: string
    thinkingConfig: ThinkingConfig
    fastMode?: boolean
    signal: AbortSignal
    initialConsecutive529Errors?: number
    querySource?: QuerySource
  },
  paramsFromContext: (context: RetryContext) => BetaMessageStreamParams,
  onAttempt: (attempt: number, start: number, maxOutputTokens: number) => void,
  captureRequest: (params: BetaMessageStreamParams) => void,
  originatingRequestId?: string | null,
): AsyncGenerator<SystemAPIErrorMessage, BetaMessage> {
  // 1. 先确定本轮 fallback 的超时边界，再把请求委托给统一重试框架。
  const fallbackTimeoutMs = getNonstreamingFallbackTimeoutMs()
  const generator = withRetry(
    () =>
      getAnthropicClient({
        maxRetries: 0,
        model: clientOptions.model,
        fetchOverride: clientOptions.fetchOverride,
        source: clientOptions.source,
      }),
    async (anthropic, attempt, context) => {
      // 2. 每次重试都重新按上下文生成参数，保证模型 fallback、max token 修正等能生效。
      const start = Date.now()
      const retryParams = paramsFromContext(context)
      captureRequest(retryParams)
      onAttempt(attempt, start, retryParams.max_tokens)

      const adjustedParams = adjustParamsForNonStreaming(
        retryParams,
        MAX_NON_STREAMING_TOKENS,
      )

      try {
        // biome-ignore lint/plugin: 非流式 fallback 需要直接调用 SDK API。
        return await anthropic.beta.messages.create(
          {
            ...adjustedParams,
            model: normalizeModelStringForAPI(adjustedParams.model),
          },
          {
            signal: retryOptions.signal,
            timeout: fallbackTimeoutMs,
          },
        )
      } catch (err) {
        // 3. 用户主动中断不是 API 失败，直接抛回上层中断流程。
        if (err instanceof APIUserAbortError) throw err

        // 4. 记录 fallback 错误，区分“请求按超时失败”和“进程被外部回收前一直无事件”。
        logForDiagnosticsNoPII('error', 'cli_nonstreaming_fallback_error')
        logEvent('tengu_nonstreaming_fallback_error', {
          model:
            clientOptions.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error:
            err instanceof Error
              ? (err.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : ('unknown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          attempt,
          timeout_ms: fallbackTimeoutMs,
          request_id: (originatingRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw err
      }
    },
    {
      model: retryOptions.model,
      fallbackModel: retryOptions.fallbackModel,
      thinkingConfig: retryOptions.thinkingConfig,
      ...(isFastModeEnabled() && { fastMode: retryOptions.fastMode }),
      signal: retryOptions.signal,
      initialConsecutive529Errors: retryOptions.initialConsecutive529Errors,
      querySource: retryOptions.querySource,
    },
  )

  // 5. 透传 retry 过程中产生的系统消息，并在 generator 完成时返回最终 API 消息。
  let e
  do {
    e = await generator.next()
    if (!e.done && e.value.type === 'system') {
      yield e.value
    }
  } while (!e.done)

  return e.value as BetaMessage
}

/**
 * 从消息链中提取最近一次 assistant 请求 ID。
 *
 * @param messages 当前请求所属链路的全部消息。
 * @returns 最近 assistant 消息携带的 requestId；没有历史 assistant 请求时返回 undefined。
 */
function getPreviousRequestIdFromMessages(
  messages: Message[],
): string | undefined {
  // 1. 从后往前查找，使回滚或撤销后的消息数组自然决定当前请求链。
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type === 'assistant' && msg.requestId) {
      return msg.requestId
    }
  }
  return undefined
}

/**
 * 判断内容块是否属于 API 媒体类 block。
 *
 * @param block 待检查的 API 内容块。
 * @returns 图片或文档 block 返回 true。
 */
function isMedia(
  block: BetaContentBlockParam,
): block is BetaImageBlockParam | BetaRequestDocumentBlock {
  // 1. 媒体配额只统计图片和文档，其他 block 不参与裁剪。
  return block.type === 'image' || block.type === 'document'
}

/**
 * 判断内容块是否是工具结果 block。
 *
 * @param block 待检查的 API 内容块。
 * @returns `tool_result` block 返回 true。
 */
function isToolResult(
  block: BetaContentBlockParam,
): block is BetaToolResultBlockParam {
  // 1. tool_result 可能内嵌媒体内容，需要单独展开统计其中的图片和文档。
  return block.type === 'tool_result'
}

/**
 * 限制消息中的媒体 block 数量。
 *
 * @param messages 已规范化的 user/assistant 消息列表。
 * @param limit 允许保留的图片和文档总数。
 * @returns 媒体数量不超限时返回原列表；超限时返回移除最旧媒体后的新消息列表。
 */
export function stripExcessMediaItems(
  messages: (UserMessage | AssistantMessage)[],
  limit: number,
): (UserMessage | AssistantMessage)[] {
  // 1. 先统计顶层媒体和 tool_result 内嵌媒体总数。
  let toRemove = 0
  for (const msg of messages) {
    if (!Array.isArray(msg.message.content)) continue
    for (const block of msg.message.content) {
      if (isMedia(block)) toRemove++
      if (isToolResult(block) && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (isMedia(nested)) toRemove++
        }
      }
    }
  }
  toRemove -= limit
  if (toRemove <= 0) return messages

  // 2. 从旧到新移除媒体，优先保留最近的用户上下文。
  return messages.map(msg => {
    if (toRemove <= 0) return msg
    const content = msg.message.content
    if (!Array.isArray(content)) return msg

    const before = toRemove
    const stripped = content
      .map(block => {
        if (
          toRemove <= 0 ||
          !isToolResult(block) ||
          !Array.isArray(block.content)
        )
          return block
        const filtered = block.content.filter(n => {
          if (toRemove > 0 && isMedia(n)) {
            toRemove--
            return false
          }
          return true
        })
        return filtered.length === block.content.length
          ? block
          : { ...block, content: filtered }
      })
      .filter(block => {
        if (toRemove > 0 && isMedia(block)) {
          toRemove--
          return false
        }
        return true
      })

    // 3. 只有当前消息真的发生裁剪时才克隆 message，避免无意义地改变对象引用。
    return before === toRemove
      ? msg
      : {
          ...msg,
          message: { ...msg.message, content: stripped },
        }
  }) as (UserMessage | AssistantMessage)[]
}

/**
 * Claude API 查询的核心实现。
 *
 * 该 generator 会完成模型能力判定、工具 schema 生成、消息规范化、缓存断点、流式请求、fallback、usage 和日志统计。
 *
 * @param messages 当前会话消息。
 * @param systemPrompt 系统提示词块。
 * @param thinkingConfig thinking 配置。
 * @param tools 本次请求可用工具集合。
 * @param signal 中断信号。
 * @param options API 查询选项。
 * @returns 异步流，产出流事件、assistant 消息或系统级 API 错误消息。
 */
async function* queryModel(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  // 1. 先做低成本条件判断，只有非订阅用户且 Opus 非自定义模型才等待 off-switch 配置。
  if (
    !isClaudeAISubscriber() &&
    isNonCustomOpusModel(options.model) &&
    (
      await getDynamicConfig_BLOCKS_ON_INIT<{ activated: boolean }>(
        'tengu-off-switch',
        {
          activated: false,
        },
      )
    ).activated
  ) {
    logEvent('tengu_off_switch_query', {})
    yield getAssistantMessageFromError(
      new Error(CUSTOM_OFF_SWITCH_MESSAGE),
      options.model,
    )
    return
  }

  // 2. 从当前消息链推导上一个 requestId，避免主线程、子 Agent、teammate 之间互相覆盖全局状态。
  const previousRequestId = getPreviousRequestIdFromMessages(messages)

  // 3. Bedrock inference profile 需要解析出背后的真实模型，用于成本和能力判断。
  const resolvedModel =
    getAPIProvider() === 'bedrock' &&
    options.model.includes('application-inference-profile')
      ? ((await getInferenceProfileBackingModel(options.model)) ??
        options.model)
      : options.model

  queryCheckpoint('query_tool_schema_build_start')
  // 4. 判断当前请求是否属于 agentic 路径，决定 beta、advisor 和缓存策略的适用范围。
  const isAgenticQuery =
    options.querySource.startsWith('repl_main_thread') ||
    options.querySource.startsWith('agent:') ||
    options.querySource === 'sdk' ||
    options.querySource === 'hook_agent' ||
    options.querySource === 'verification_agent'
  const betas = getMergedBetas(options.model, { isAgenticQuery })

  // 5. Advisor 开启时所有请求都携带 beta，确保非 agentic 查询也能解析历史中的 advisor block。
  if (isAdvisorEnabled()) {
    betas.push(ADVISOR_BETA_HEADER)
  }

  let advisorModel: string | undefined
  if (isAgenticQuery && isAdvisorEnabled()) {
    // 6. agentic 请求才尝试启用 server-side advisor，并优先应用实验分配的 advisor 模型。
    let advisorOption = options.advisorModel

    const advisorExperiment = getExperimentAdvisorModels()
    if (advisorExperiment !== undefined) {
      if (
        normalizeModelStringForAPI(advisorExperiment.baseModel) ===
        normalizeModelStringForAPI(options.model)
      ) {
        advisorOption = advisorExperiment.advisorModel
      }
    }

    if (advisorOption) {
      const normalizedAdvisorModel = normalizeModelStringForAPI(
        parseUserSpecifiedModel(advisorOption),
      )
      if (!modelSupportsAdvisor(options.model)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - base model ${options.model} does not support advisor`,
        )
      } else if (!isValidAdvisorModel(normalizedAdvisorModel)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - ${normalizedAdvisorModel} is not a valid advisor model`,
        )
      } else {
        advisorModel = normalizedAdvisorModel
        logForDebugging(
          `[AdvisorTool] Server-side tool enabled with ${advisorModel} as the advisor model`,
        )
      }
    }
  }

  // 7. 判断 ToolSearch 是否可用；该判断可能计算 MCP 工具描述尺寸，因此保持异步。
  let useToolSearch = await isToolSearchEnabled(
    options.model,
    tools,
    options.getToolPermissionContext,
    options.agents,
    'query',
  )

  // 8. 预先收集延迟加载工具名，避免在过滤工具时重复触发 GrowthBook 查询。
  const deferredToolNames = new Set<string>()
  if (useToolSearch) {
    for (const t of tools) {
      if (isDeferredTool(t)) deferredToolNames.add(t.name)
    }
  }

  // 9. 没有延迟工具且没有 MCP pending 时关闭 ToolSearch，减少无意义工具暴露。
  if (
    useToolSearch &&
    deferredToolNames.size === 0 &&
    !options.hasPendingMcpServers
  ) {
    logForDebugging(
      'Tool search disabled: no deferred tools available to search',
    )
    useToolSearch = false
  }

  // 10. 根据 ToolSearch 状态过滤工具；不支持 tool_reference 的模型不能看到 ToolSearchTool。
  let filteredTools: Tools

  if (useToolSearch) {
    // 11. 动态工具加载只发送已被 tool_reference 发现的延迟工具，避免一次性塞入全部 deferred 工具。
    const discoveredToolNames = extractDiscoveredToolNames(messages)

    filteredTools = tools.filter(tool => {
      if (!deferredToolNames.has(tool.name)) return true
      if (toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME)) return true
      return discoveredToolNames.has(tool.name)
    })
  } else {
    filteredTools = tools.filter(
      t => !toolMatchesName(t, TOOL_SEARCH_TOOL_NAME),
    )
  }

  // 12. ToolSearch 启用时追加 provider 对应 beta；Bedrock 的 header 后续会放入 extra body。
  const toolSearchHeader = useToolSearch ? getToolSearchBetaHeader() : null
  if (toolSearchHeader && getAPIProvider() !== 'bedrock') {
    if (!betas.includes(toolSearchHeader)) {
      betas.push(toolSearchHeader)
    }
  }

  // 13. 在异步上下文中一次性判断 cached microcompact，避免 paramsFromContext 每次重试重复加载模块。
  let cachedMCEnabled = false
  let cacheEditingBetaHeader = ''
  if (feature('CACHED_MICROCOMPACT')) {
    const {
      isCachedMicrocompactEnabled,
      isModelSupportedForCacheEditing,
      getCachedMCConfig,
    } = await import('../compact/cachedMicrocompact.js')
    const betas = await import('src/constants/betas.js')
    cacheEditingBetaHeader = betas.CACHE_EDITING_BETA_HEADER
    const featureEnabled = isCachedMicrocompactEnabled()
    const modelSupported = isModelSupportedForCacheEditing(options.model)
    cachedMCEnabled = featureEnabled && modelSupported
    const config = getCachedMCConfig()
    logForDebugging(
      `Cached MC gate: enabled=${featureEnabled} modelSupported=${modelSupported} model=${options.model} supportedModels=${jsonStringify(config.supportedModels)}`,
    )
  }

  const useGlobalCacheFeature = shouldUseGlobalCacheScope()
  /**
   * 判断工具本次是否以延迟加载形式发送。
   *
   * @param t 待判断的工具。
   * @returns ToolSearch 启用且工具属于延迟集合或 LSP 未就绪时返回 true。
   */
  const willDefer = (t: Tool) =>
    useToolSearch && (deferredToolNames.has(t.name) || shouldDeferLspTool(t))
  // 14. MCP 工具属于用户动态配置，只有实际渲染到工具区时才禁止系统提示词走 global cache。
  const needsToolBasedCacheMarker =
    useGlobalCacheFeature &&
    filteredTools.some(t => t.isMcp === true && !willDefer(t))

  // 15. global cache 开启时必须携带 prompt_caching_scope beta，否则 API 不接受 scope 字段。
  if (
    useGlobalCacheFeature &&
    !betas.includes(PROMPT_CACHING_SCOPE_BETA_HEADER)
  ) {
    betas.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  // 16. 计算日志用的 global cache 策略，方便后续分析缓存命中差异。
  const globalCacheStrategy: GlobalCacheStrategy = useGlobalCacheFeature
    ? needsToolBasedCacheMarker
      ? 'none'
      : 'system_prompt'
    : 'none'

  // 17. 生成工具 schema；ToolSearch 的提示仍需看到完整工具池，但真正发送给 API 的工具按 filteredTools 控制。
  const toolSchemas = await Promise.all(
    filteredTools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model: options.model,
        deferLoading: willDefer(tool),
      }),
    ),
  )

  if (useToolSearch) {
    const includedDeferredTools = count(filteredTools, t =>
      deferredToolNames.has(t.name),
    )
    logForDebugging(
      `Dynamic tool loading: ${includedDeferredTools}/${deferredToolNames.size} deferred tools included`,
    )
  }

  queryCheckpoint('query_tool_schema_build_end')

  // 18. 先规范化消息再计算 fingerprint 和系统提示词，确保工具结果、tool_reference 等结构符合 API 期望。
  logEvent('tengu_api_before_normalize', {
    preNormalizedMessageCount: messages.length,
  })

  queryCheckpoint('query_message_normalization_start')
  let messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)
  queryCheckpoint('query_message_normalization_end')

  // 19. 如果当前模型不支持 ToolSearch，移除历史中遗留的 tool_reference/caller 字段，避免模型切换后 API 400。
  if (!useToolSearch) {
    messagesForAPI = messagesForAPI.map(msg => {
      switch (msg.type) {
        case 'user':
          return stripToolReferenceBlocksFromUserMessage(msg)
        case 'assistant':
          return stripCallerFieldFromAssistantMessage(msg)
        default:
          return msg
      }
    })
  }

  // 20. 修复远端或 teleport 恢复时可能出现的 tool_use/tool_result 配对缺口。
  messagesForAPI = ensureToolResultPairing(messagesForAPI)

  // 21. 未携带 advisor beta 时剥离 advisor block，避免 API 拒绝历史消息。
  if (!betas.includes(ADVISOR_BETA_HEADER)) {
    messagesForAPI = stripAdvisorBlocks(messagesForAPI)
  }

  // 22. 媒体数量超过 API 上限时丢弃最旧媒体，比把用户带入难恢复的 400 错误更可控。
  messagesForAPI = stripExcessMediaItems(
    messagesForAPI,
    API_MAX_MEDIA_PER_REQUEST,
  )

  // 23. 记录规范化后的消息数量，用于定位消息压缩或过滤异常。
  logEvent('tengu_api_after_normalize', {
    postNormalizedMessageCount: messagesForAPI.length,
  })

  // 24. 在注入合成消息前计算用户输入 fingerprint，保证归因只反映真实用户内容。
  const fingerprint = computeFingerprintFromMessages(messagesForAPI)

  // 25. 没启用 delta attachment 时，临时把 deferred tools 列表插入消息头供模型发现。
  if (useToolSearch && !isDeferredToolsDeltaEnabled()) {
    const deferredToolList = tools
      .filter(t => deferredToolNames.has(t.name))
      .map(formatDeferredToolLine)
      .sort()
      .join('\n')
    if (deferredToolList) {
      messagesForAPI = [
        createUserMessage({
          content: `<available-deferred-tools>\n${deferredToolList}\n</available-deferred-tools>`,
          isMeta: true,
        }),
        ...messagesForAPI,
      ]
    }
  }

  // 26. Chrome MCP 指令只有在没有 delta attachment 时才拼进系统提示词，避免晚连接导致缓存失效。
  const hasChromeTools = filteredTools.some(t =>
    isToolFromMcpServer(t.name, CLAUDE_IN_CHROME_MCP_SERVER_NAME),
  )
  const injectChromeHere =
    useToolSearch && hasChromeTools && !isMcpInstructionsDeltaEnabled()

  // 27. 组装最终系统提示词：归因头、CLI 前缀、业务提示词和可选工具说明按顺序拼接。
  systemPrompt = asSystemPrompt(
    [
      getAttributionHeader(fingerprint),
      getCLISyspromptPrefix({
        isNonInteractive: options.isNonInteractiveSession,
        hasAppendSystemPrompt: options.hasAppendSystemPrompt,
      }),
      ...systemPrompt,
      ...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
      ...(injectChromeHere ? [CHROME_TOOL_SEARCH_INSTRUCTIONS] : []),
    ].filter(Boolean),
  )

  // 28. 输出 API 前缀日志，方便从请求日志中快速识别系统提示词结构。
  logAPIPrefix(systemPrompt)

  // 29. 根据最终系统提示词构建 API system block，并应用全局缓存避让策略。
  const enablePromptCaching =
    options.enablePromptCaching ?? getPromptCachingEnabled(options.model)
  const system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching, {
    skipGlobalCacheForSystemPrompt: needsToolBasedCacheMarker,
    querySource: options.querySource,
  })
  const useBetas = betas.length > 0

  // 30. Advisor server tool 必须放在 API tools 数组中，且追加在普通工具后以减少缓存前缀扰动。
  const extraToolSchemas = [...(options.extraToolSchemas ?? [])]
  if (advisorModel) {
    extraToolSchemas.push({
      type: 'advisor_20260301',
      name: 'advisor',
      model: advisorModel,
    } as unknown as BetaToolUnion)
  }
  const allTools = [...toolSchemas, ...extraToolSchemas]

  // 31. fast mode 必须同时满足全局开关、可用性、冷却状态、模型支持和调用方请求。
  const isFastMode =
    isFastModeEnabled() &&
    isFastModeAvailable() &&
    !isFastModeCooldown() &&
    isFastModeSupportedByModel(options.model) &&
    !!options.fastMode

  // 32. 动态 beta header 一旦在会话中发送就锁存，防止中途切换导致服务端缓存键抖动。

  let afkHeaderLatched = getAfkModeHeaderLatched() === true
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (
      !afkHeaderLatched &&
      isAgenticQuery &&
      shouldIncludeFirstPartyOnlyBetas() &&
      (autoModeStateModule?.isAutoModeActive() ?? false)
    ) {
      afkHeaderLatched = true
      setAfkModeHeaderLatched(true)
    }
  }

  let fastModeHeaderLatched = getFastModeHeaderLatched() === true
  if (!fastModeHeaderLatched && isFastMode) {
    fastModeHeaderLatched = true
    setFastModeHeaderLatched(true)
  }

  let cacheEditingHeaderLatched = getCacheEditingHeaderLatched() === true
  if (feature('CACHED_MICROCOMPACT')) {
    if (
      !cacheEditingHeaderLatched &&
      cachedMCEnabled &&
      getAPIProvider() === 'firstParty' &&
      options.querySource === 'repl_main_thread'
    ) {
      cacheEditingHeaderLatched = true
      setCacheEditingHeaderLatched(true)
    }
  }

  // 33. thinking clear 只由 agentic 请求锁存，避免分类器等旁路请求改变主线程 context_management。
  let thinkingClearLatched = getThinkingClearLatched() === true
  if (!thinkingClearLatched && isAgenticQuery) {
    const lastCompletion = getLastApiCompletionTimestamp()
    if (
      lastCompletion !== null &&
      Date.now() - lastCompletion > CACHE_TTL_1HOUR_MS
    ) {
      thinkingClearLatched = true
      setThinkingClearLatched(true)
    }
  }

  const effort = resolveAppliedEffort(options.model, options.effortValue)

  if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
    // 34. 缓存破坏检测排除 defer_loading 工具，因为 API 不会把它们纳入真实 prompt 缓存键。
    const toolsForCacheDetection = allTools.filter(
      t => !('defer_loading' in t && t.defer_loading),
    )
    // 35. 记录会影响服务端缓存键的完整请求状态，并使用锁存值而不是实时开关值。
    recordPromptState({
      system,
      toolSchemas: toolsForCacheDetection,
      querySource: options.querySource,
      model: options.model,
      agentId: options.agentId,
      fastMode: fastModeHeaderLatched,
      globalCacheStrategy,
      betas,
      autoModeActive: afkHeaderLatched,
      isUsingOverage: currentLimits.isUsingOverage ?? false,
      cachedMCEnabled: cacheEditingHeaderLatched,
      effortValue: effort,
      extraBodyParams: getExtraBodyParams(),
    })
  }

  const newContext: LLMRequestNewContext | undefined = isBetaTracingEnabled()
    ? {
        systemPrompt: systemPrompt.join('\n\n'),
        querySource: options.querySource,
        tools: jsonStringify(allTools),
      }
    : undefined

  // 36. 创建 LLM tracing span，让并发请求的响应和对应请求正确配对。
  const llmSpan = startLLMRequestSpan(
    options.model,
    newContext,
    messagesForAPI,
    isFastMode,
  )

  const startIncludingRetries = Date.now()
  let start = Date.now()
  let attemptNumber = 0
  const attemptStartTimes: number[] = []
  let stream: Stream<BetaRawMessageStreamEvent> | undefined = undefined
  let streamRequestId: string | null | undefined = undefined
  let clientRequestId: string | undefined = undefined
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins -- Node 18+ 提供 Response，SDK 会返回该对象。
  let streamResponse: Response | undefined = undefined

  /**
   * 释放当前流式请求占用的原生资源。
   *
   * @returns 无返回值；该方法会尽力 abort stream 并取消 Response body。
   */
  function releaseStreamResources(): void {
    // 37. 先终止 SDK stream 控制器，避免调用方提前结束 generator 后底层请求继续占用连接。
    cleanupStream(stream)
    stream = undefined
    // 38. 再取消 Response body，释放 V8 堆外 TLS/socket buffer。
    if (streamResponse) {
      streamResponse.body?.cancel().catch(() => {})
      streamResponse = undefined
    }
  }

  // 39. 在 paramsFromContext 外只消费一次 pending cache edits，避免日志或重试重复调用时把编辑偷走。
  const consumedCacheEdits = cachedMCEnabled ? consumePendingCacheEdits() : null
  const consumedPinnedEdits = cachedMCEnabled ? getPinnedCacheEdits() : []

  // 40. 记录最后一次真正发送的 beta 列表，包含运行时追加的 header，供成功日志上报。
  let lastRequestBetas: string[] | undefined

  /**
   * 根据重试上下文生成最终 API 请求参数。
   *
   * @param retryContext 当前重试尝试使用的模型、thinking 和 token 修正信息。
   * @returns 完整的 Anthropic messages.create 请求参数。
   */
  const paramsFromContext = (retryContext: RetryContext) => {
    // 41. 每次尝试都复制 beta 列表，避免重试或 fallback 之间共享可变数组。
    const betasParams = [...betas]

    // 42. Sonnet 1M 实验按重试模型动态追加 beta，因为 fallback 模型可能不同。
    if (
      !betasParams.includes(CONTEXT_1M_BETA_HEADER) &&
      getSonnet1mExpTreatmentEnabled(retryContext.model)
    ) {
      betasParams.push(CONTEXT_1M_BETA_HEADER)
    }

    // 43. Bedrock 的 beta 走 extra body，需合并模型 beta 和运行时 ToolSearch beta。
    const bedrockBetas =
      getAPIProvider() === 'bedrock'
        ? [
            ...getBedrockExtraBodyParamsBetas(retryContext.model),
            ...(toolSearchHeader ? [toolSearchHeader] : []),
          ]
        : []
    const extraBodyParams = getExtraBodyParams(bedrockBetas)

    // 44. 从用户 extra body 中继承 output_config，后续 effort、task budget、structured output 都写入这里。
    const outputConfig: BetaOutputConfig = {
      ...((extraBodyParams.output_config as BetaOutputConfig) ?? {}),
    }

    configureEffortParams(
      effort,
      outputConfig,
      extraBodyParams,
      betasParams,
      options.model,
    )

    // 45. 写入任务预算，让模型了解整个 agentic loop 的剩余 token 预算。
    configureTaskBudgetParams(
      options.taskBudget,
      outputConfig as BetaOutputConfig & { task_budget?: TaskBudgetParam },
      betasParams,
    )

    // 46. 结构化输出和 effort 共用 output_config；模型支持时补 structured outputs beta。
    if (options.outputFormat && !('format' in outputConfig)) {
      outputConfig.format = options.outputFormat as BetaJSONOutputFormat
      // 补充说明：provider 和模型都支持结构化输出时，补充对应 beta header。
      if (
        modelSupportsStructuredOutputs(options.model) &&
        !betasParams.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
      ) {
        betasParams.push(STRUCTURED_OUTPUTS_BETA_HEADER)
      }
    }

    // 47. max_tokens 优先使用重试上下文的修正值，其次是调用方覆盖，最后才是模型默认值。
    const maxOutputTokens =
      retryContext?.maxTokensOverride ||
      options.maxOutputTokensOverride ||
      getMaxOutputTokensForModel(options.model)

    const hasThinking =
      thinkingConfig.type !== 'disabled' &&
      !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_THINKING)
    let thinking: BetaMessageStreamParams['thinking'] | undefined = undefined

    // 48. thinking 策略对模型质量敏感：支持 adaptive 的模型用 adaptive，否则用预算型 thinking。
    if (hasThinking && modelSupportsThinking(options.model)) {
      if (
        !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING) &&
        modelSupportsAdaptiveThinking(options.model)
      ) {
        thinking = {
          type: 'adaptive',
        } satisfies BetaMessageStreamParams['thinking']
      } else {
        let thinkingBudget = getMaxThinkingTokensForModel(options.model)
        if (
          thinkingConfig.type === 'enabled' &&
          thinkingConfig.budgetTokens !== undefined
        ) {
          thinkingBudget = thinkingConfig.budgetTokens
        }
        thinkingBudget = Math.min(maxOutputTokens - 1, thinkingBudget)
        thinking = {
          budget_tokens: thinkingBudget,
          type: 'enabled',
        } satisfies BetaMessageStreamParams['thinking']
      }
    }

    // 49. 根据 thinking 状态和缓存锁存状态计算 API context management 策略。
    const contextManagement = getAPIContextManagement({
      hasThinking,
      isRedactThinkingActive: betasParams.includes(REDACT_THINKING_BETA_HEADER),
      clearAllThinking: thinkingClearLatched,
    })

    const enablePromptCaching =
      options.enablePromptCaching ?? getPromptCachingEnabled(retryContext.model)

    // 50. fast mode header 使用会话锁存保证缓存稳定，但 speed 参数保持动态以尊重冷却状态。
    let speed: BetaMessageStreamParams['speed']
    const isFastModeForRetry =
      isFastModeEnabled() &&
      isFastModeAvailable() &&
      !isFastModeCooldown() &&
      isFastModeSupportedByModel(options.model) &&
      !!retryContext.fastMode
    if (isFastModeForRetry) {
      speed = 'fast'
    }
    if (fastModeHeaderLatched && !betasParams.includes(FAST_MODE_BETA_HEADER)) {
      betasParams.push(FAST_MODE_BETA_HEADER)
    }

    // 51. AFK beta 在 auto mode 首次激活后锁存，但只对 agentic 请求发送。
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      if (
        afkHeaderLatched &&
        shouldIncludeFirstPartyOnlyBetas() &&
        isAgenticQuery &&
        !betasParams.includes(AFK_MODE_BETA_HEADER)
      ) {
        betasParams.push(AFK_MODE_BETA_HEADER)
      }
    }

    // 52. cache editing header 锁存，但 cache_edits body 是否发送仍按实时功能状态判断。
    const useCachedMC =
      cachedMCEnabled &&
      getAPIProvider() === 'firstParty' &&
      options.querySource === 'repl_main_thread'
    if (
      cacheEditingHeaderLatched &&
      getAPIProvider() === 'firstParty' &&
      options.querySource === 'repl_main_thread' &&
      !betasParams.includes(cacheEditingBetaHeader)
    ) {
      betasParams.push(cacheEditingBetaHeader)
      logForDebugging(
        'Cache editing beta header enabled for cached microcompact',
      )
    }

    // 53. thinking 开启时不显式发送 temperature，因为 API 要求此时使用默认温度 1。
    const temperature = !hasThinking
      ? (options.temperatureOverride ?? 1)
      : undefined

    lastRequestBetas = betasParams

    // 54. 汇总本次尝试的最终请求参数；缓存断点在这里按最新重试上下文重新计算。
    return {
      model: normalizeModelStringForAPI(options.model),
      messages: addCacheBreakpoints(
        messagesForAPI,
        enablePromptCaching,
        options.querySource,
        useCachedMC,
        consumedCacheEdits,
        consumedPinnedEdits,
        options.skipCacheWrite,
      ),
      system,
      tools: allTools,
      tool_choice: options.toolChoice,
      ...(useBetas && { betas: betasParams }),
      metadata: getAPIMetadata(),
      max_tokens: maxOutputTokens,
      thinking,
      ...(temperature !== undefined && { temperature }),
      ...(contextManagement &&
        useBetas &&
        betasParams.includes(CONTEXT_MANAGEMENT_BETA_HEADER) && {
          context_management: contextManagement,
        }),
      ...extraBodyParams,
      ...(Object.keys(outputConfig).length > 0 && {
        output_config: outputConfig,
      }),
      ...(speed !== undefined && { speed }),
    }
  }

  // 55. 预先提取日志标量，避免异步日志闭包持有完整请求上下文导致内存被延迟释放。
  {
    const queryParams = paramsFromContext({
      model: options.model,
      thinkingConfig,
    })
    const logMessagesLength = queryParams.messages.length
    const logBetas = useBetas ? (queryParams.betas ?? []) : []
    const logThinkingType = queryParams.thinking?.type ?? 'disabled'
    const logEffortValue = queryParams.output_config?.effort
    void options.getToolPermissionContext().then(permissionContext => {
      logAPIQuery({
        model: options.model,
        messagesLength: logMessagesLength,
        temperature: options.temperatureOverride ?? 1,
        betas: logBetas,
        permissionMode: permissionContext.mode,
        querySource: options.querySource,
        queryTracking: options.queryTracking,
        thinkingType: logThinkingType,
        effortValue: logEffortValue,
        fastMode: isFastMode,
        previousRequestId,
      })
    })
  }

  const newMessages: AssistantMessage[] = []
  let ttftMs = 0
  let partialMessage: BetaMessage | undefined = undefined
  const contentBlocks: (BetaContentBlock | ConnectorTextBlock)[] = []
  let usage: NonNullableUsage = EMPTY_USAGE
  let costUSD = 0
  let stopReason: BetaStopReason | null = null
  let didFallBackToNonStreaming = false
  let fallbackMessage: AssistantMessage | undefined
  let maxOutputTokens = 0
  let responseHeaders: globalThis.Headers | undefined = undefined
  let research: unknown = undefined
  let isFastModeRequest = isFastMode // 56. fallback 可能切换 fast mode 状态，因此单独记录实际请求状态。
  let isAdvisorInProgress = false

  try {
    // 57. 创建带重试能力的流式请求 generator，所有 API 错误都先经过统一 retry/fallback 逻辑。
    queryCheckpoint('query_client_creation_start')
    const generator = withRetry(
      () =>
        getAnthropicClient({
          maxRetries: 0, // 补充说明：关闭 SDK 自动重试，统一交给 withRetry 控制重试和模型 fallback。
          model: options.model,
          fetchOverride: options.fetchOverride,
          source: options.querySource,
        }),
      async (anthropic, attempt, context) => {
        attemptNumber = attempt
        isFastModeRequest = context.fastMode ?? false
        start = Date.now()
        attemptStartTimes.push(start)
        // 58. client 创建结束点按 attempt 记录，首次 attempt 的耗时用于定位初始化慢点。
        queryCheckpoint('query_client_creation_end')

        const params = paramsFromContext(context)
        // 59. 捕获最终请求参数，供 bug report 和 VCR 排查使用。
        captureAPIRequest(params, options.querySource)

        maxOutputTokens = params.max_tokens

        // 60. 该 checkpoint 必须在 await 前触发，否则网络 TTFB 会被响应头等待时间污染。
        queryCheckpoint('query_api_request_sent')
        if (!options.agentId) {
          headlessProfilerCheckpoint('api_request_sent')
        }

        // 61. 一方请求生成 client request ID，让没有 server request ID 的超时也能关联日志。
        clientRequestId =
          getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
            ? randomUUID()
            : undefined

        // 62. 使用 raw stream 避免 SDK BetaMessageStream 对 input_json_delta 做 O(n²) partial JSON 解析。
        // biome-ignore lint/plugin: 主对话链路会单独处理归因。
        const result = await anthropic.beta.messages
          .create(
            { ...params, stream: true },
            {
              signal,
              ...(clientRequestId && {
                headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId },
              }),
            },
          )
          .withResponse()
        queryCheckpoint('query_response_headers_received')
        streamRequestId = result.request_id
        streamResponse = result.response
        return result.data
      },
      {
        model: options.model,
        fallbackModel: options.fallbackModel,
        thinkingConfig,
        ...(isFastModeEnabled() ? { fastMode: isFastMode } : false),
        signal,
        querySource: options.querySource,
      },
    )

    let e
    do {
      e = await generator.next()

      // 63. withRetry 在真正返回 stream 前可能产出系统错误消息，这里先透传给上层 UI。
      if (!('controller' in e.value)) {
        yield e.value
      }
    } while (!e.done)
    stream = e.value as Stream<BetaRawMessageStreamEvent>

    // 64. 拿到最终 stream 后重置本次响应累积状态，避免 retry 前的部分状态泄漏。
    newMessages.length = 0
    ttftMs = 0
    partialMessage = undefined
    contentBlocks.length = 0
    usage = EMPTY_USAGE
    stopReason = null
    isAdvisorInProgress = false

    // 65. 流式空闲 watchdog 会主动终止长时间无 chunk 的连接，弥补 SDK 超时只覆盖初始 fetch 的不足。
    const streamWatchdogEnabled = isEnvTruthy(
      process.env.CLAUDE_ENABLE_STREAM_WATCHDOG,
    )
    const STREAM_IDLE_TIMEOUT_MS =
      parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000
    const STREAM_IDLE_WARNING_MS = STREAM_IDLE_TIMEOUT_MS / 2
    let streamIdleAborted = false
    // 66. 记录 watchdog 触发时刻，用于衡量 abort 传播到 for-await 退出的延迟。
    let streamWatchdogFiredAt: number | null = null
    let streamIdleWarningTimer: ReturnType<typeof setTimeout> | null = null
    let streamIdleTimer: ReturnType<typeof setTimeout> | null = null
    /**
     * 清理流式空闲检测相关计时器。
     *
     * @returns 无返回值；只重置本次请求的 watchdog timer。
     */
    function clearStreamIdleTimers(): void {
      // 67. 分别清理 warning 和 abort timer，避免请求结束后仍触发误报。
      if (streamIdleWarningTimer !== null) {
        clearTimeout(streamIdleWarningTimer)
        streamIdleWarningTimer = null
      }
      if (streamIdleTimer !== null) {
        clearTimeout(streamIdleTimer)
        streamIdleTimer = null
      }
    }
    /**
     * 在收到新 chunk 后重置流式空闲 watchdog。
     *
     * @returns 无返回值；未启用 watchdog 时只清空旧 timer。
     */
    function resetStreamIdleTimer(): void {
      // 68. 每个新事件都会刷新 timer，只有持续无事件才触发 warning 或 abort。
      clearStreamIdleTimers()
      if (!streamWatchdogEnabled) {
        return
      }
      streamIdleWarningTimer = setTimeout(
        warnMs => {
          logForDebugging(
            `Streaming idle warning: no chunks received for ${warnMs / 1000}s`,
            { level: 'warn' },
          )
          logForDiagnosticsNoPII('warn', 'cli_streaming_idle_warning')
        },
        STREAM_IDLE_WARNING_MS,
        STREAM_IDLE_WARNING_MS,
      )
      streamIdleTimer = setTimeout(() => {
        streamIdleAborted = true
        streamWatchdogFiredAt = performance.now()
        logForDebugging(
          `Streaming idle timeout: no chunks received for ${STREAM_IDLE_TIMEOUT_MS / 1000}s, aborting stream`,
          { level: 'error' },
        )
        logForDiagnosticsNoPII('error', 'cli_streaming_idle_timeout')
        logEvent('tengu_streaming_idle_timeout', {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          timeout_ms: STREAM_IDLE_TIMEOUT_MS,
        })
        releaseStreamResources()
      }, STREAM_IDLE_TIMEOUT_MS)
    }
    resetStreamIdleTimer()

    startSessionActivity('api_call')
    try {
      // 69. 开始消费 raw stream，并按事件类型累积 assistant 内容、usage、cost 和错误状态。
      let isFirstChunk = true
      let lastEventTime: number | null = null // 70. 首个 chunk 后再记录，避免把 TTFB 当作 stall。
      const STALL_THRESHOLD_MS = 30_000 // 71. 超过 30 秒无新事件则记录一次流式 stall。
      let totalStallTime = 0
      let stallCount = 0

      for await (const part of stream) {
        resetStreamIdleTimer()
        const now = Date.now()

        // 72. 检测相邻 chunk 间隔，记录慢流但不主动中断；真正中断由 watchdog 负责。
        if (lastEventTime !== null) {
          const timeSinceLastEvent = now - lastEventTime
          if (timeSinceLastEvent > STALL_THRESHOLD_MS) {
            stallCount++
            totalStallTime += timeSinceLastEvent
            logForDebugging(
              `Streaming stall detected: ${(timeSinceLastEvent / 1000).toFixed(1)}s gap between events (stall #${stallCount})`,
              { level: 'warn' },
            )
            logEvent('tengu_streaming_stall', {
              stall_duration_ms: timeSinceLastEvent,
              stall_count: stallCount,
              total_stall_time_ms: totalStallTime,
              event_type:
                part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              request_id: (streamRequestId ??
                'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
          }
        }
        lastEventTime = now

        // 73. 首个 chunk 到达时关闭 query profile 的首包阶段，并记录 TTFT 相关 checkpoint。
        if (isFirstChunk) {
          logForDebugging('Stream started - received first chunk')
          queryCheckpoint('query_first_chunk_received')
          if (!options.agentId) {
            headlessProfilerCheckpoint('first_chunk')
          }
          endQueryProfile()
          isFirstChunk = false
        }

        switch (part.type) {
          case 'message_start': {
            // 74. message_start 建立响应骨架并接收输入 token/cache token 的初始 usage。
            partialMessage = part.message
            ttftMs = Date.now() - start
            usage = updateUsage(usage, part.message?.usage)
            // 75. ant 内部 research 字段可能随事件更新，始终保留最新值。
            if (
              process.env.USER_TYPE === 'ant' &&
              'research' in (part.message as unknown as Record<string, unknown>)
            ) {
              research = (part.message as unknown as Record<string, unknown>)
                .research
            }
            break
          }
          case 'content_block_start':
            // 76. content_block_start 初始化对应下标的可变累积块，后续 delta 会追加到该块。
            switch (part.content_block.type) {
              case 'tool_use':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  input: '',
                }
                break
              case 'server_tool_use':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  input: '' as unknown as { [key: string]: unknown },
                }
                if ((part.content_block.name as string) === 'advisor') {
                  isAdvisorInProgress = true
                  logForDebugging(`[AdvisorTool] Advisor tool called`)
                  logEvent('tengu_advisor_tool_call', {
                    model:
                      options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    advisor_model: (advisorModel ??
                      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  })
                }
                break
              case 'text':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  // 77. SDK 可能在 start 和 delta 中重复同一段文本，这里置空以 delta 为准。
                  text: '',
                }
                break
              case 'thinking':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  thinking: '',
                  // 78. 即使没有 signature_delta，也保证 thinking block 上存在 signature 字段。
                  signature: '',
                }
                break
              default:
                // 79. 对未知 block 也做浅拷贝，避免 SDK 内部 mutation 影响我们自己的累积状态。
                contentBlocks[part.index] = { ...part.content_block }
                if (
                  (part.content_block.type as string) === 'advisor_tool_result'
                ) {
                  isAdvisorInProgress = false
                  logForDebugging(`[AdvisorTool] Advisor tool result received`)
                }
                break
            }
            break
          case 'content_block_delta': {
            // 80. delta 必须落到已经初始化的 content block，否则说明流事件顺序异常。
            const contentBlock = contentBlocks[part.index]
            const delta = part.delta as typeof part.delta | ConnectorTextDelta
            if (!contentBlock) {
              logEvent('tengu_streaming_error', {
                error_type:
                  'content_block_not_found_delta' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_index: part.index,
              })
              throw new RangeError('Content block not found')
            }
            if (
              feature('CONNECTOR_TEXT') &&
              delta.type === 'connector_text_delta'
            ) {
              // 81. connector_text_delta 只能追加到 connector_text block，类型不匹配时立即报错并上报遥测。
              if (contentBlock.type !== 'connector_text') {
                logEvent('tengu_streaming_error', {
                  error_type:
                    'content_block_type_mismatch_connector_text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  expected_type:
                    'connector_text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  actual_type:
                    contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                })
                throw new Error('Content block is not a connector_text block')
              }
              contentBlock.connector_text += delta.connector_text
            } else {
              // 82. 普通 delta 按类型追加到工具 JSON、文本、thinking 或签名字段。
              switch (delta.type) {
                case 'citations_delta':
                  // 83. citations 当前暂不落盘处理，保留分支避免未知 delta 穿透。
                  break
                case 'input_json_delta':
                  if (
                    contentBlock.type !== 'tool_use' &&
                    contentBlock.type !== 'server_tool_use'
                  ) {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_input_json' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'tool_use' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a input_json block')
                  }
                  if (typeof contentBlock.input !== 'string') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_input_not_string' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      input_type:
                        typeof contentBlock.input as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block input is not a string')
                  }
                  contentBlock.input += delta.partial_json
                  break
                case 'text_delta':
                  if (contentBlock.type !== 'text') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a text block')
                  }
                  contentBlock.text += delta.text
                  break
                case 'signature_delta':
                  if (
                    feature('CONNECTOR_TEXT') &&
                    contentBlock.type === 'connector_text'
                  ) {
                    contentBlock.signature = delta.signature
                    break
                  }
                  if (contentBlock.type !== 'thinking') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_thinking_signature' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'thinking' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a thinking block')
                  }
                  contentBlock.signature = delta.signature
                  break
                case 'thinking_delta':
                  if (contentBlock.type !== 'thinking') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_thinking_delta' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'thinking' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a thinking block')
                  }
                  contentBlock.thinking += delta.thinking
                  break
              }
            }
            // 84. delta 事件上的 research 同样以后到的为准。
            if (process.env.USER_TYPE === 'ant' && 'research' in part) {
              research = (part as { research: unknown }).research
            }
            break
          }
          case 'content_block_stop': {
            // 85. block 结束时把单个累积块转成内部 assistant 消息并立即 yield 给上层。
            const contentBlock = contentBlocks[part.index]
            if (!contentBlock) {
              logEvent('tengu_streaming_error', {
                error_type:
                  'content_block_not_found_stop' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_index: part.index,
              })
              throw new RangeError('Content block not found')
            }
            if (!partialMessage) {
              logEvent('tengu_streaming_error', {
                error_type:
                  'partial_message_not_found' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              })
              throw new Error('Message not found')
            }
            const m: AssistantMessage = {
              message: {
                ...partialMessage,
                content: normalizeContentFromAPI(
                  [contentBlock] as BetaContentBlock[],
                  tools,
                  options.agentId,
                ),
              },
              requestId: streamRequestId ?? undefined,
              type: 'assistant',
              uuid: randomUUID(),
              timestamp: new Date().toISOString(),
              ...(process.env.USER_TYPE === 'ant' &&
                research !== undefined && { research }),
              ...(advisorModel && { advisorModel }),
            }
            newMessages.push(m)
            yield m
            break
          }
          case 'message_delta': {
            // 86. message_delta 携带最终 usage 和 stop_reason，需要回写到已经 yield 的最后一条消息。
            usage = updateUsage(usage, part.usage)
            if (
              process.env.USER_TYPE === 'ant' &&
              'research' in (part as unknown as Record<string, unknown>)
            ) {
              research = (part as unknown as Record<string, unknown>).research
              for (const msg of newMessages) {
                msg.research = research
              }
            }

            // 87. 这里必须直接 mutation 而不是替换对象，因为 transcript 写队列持有的是 message.message 引用。
            stopReason = part.delta.stop_reason

            const lastMsg = newMessages.at(-1)
            if (lastMsg) {
              lastMsg.message.usage = usage
              lastMsg.message.stop_reason = stopReason
            }

            // 88. 使用最新累计 usage 计算本段成本，并计入会话总成本。
            const costUSDForPart = calculateUSDCost(resolvedModel, usage)
            costUSD += addToTotalSessionCost(
              costUSDForPart,
              usage,
              options.model,
            )

            const refusalMessage = getErrorMessageIfRefusal(
              part.delta.stop_reason,
              options.model,
            )
            if (refusalMessage) {
              yield refusalMessage
            }

            // 89. 输出 token 达到上限时，追加可恢复的 API 错误消息，引导上层继续请求。
            if (stopReason === 'max_tokens') {
              logEvent('tengu_max_tokens_reached', {
                max_tokens: maxOutputTokens,
              })
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: Claude's response exceeded the ${
                  maxOutputTokens
                } output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`,
                apiError: 'max_output_tokens',
                error: 'max_output_tokens',
              })
            }

            // 90. 模型上下文窗口耗尽复用 max_output_tokens 恢复路径，让上层从截断处继续。
            if (stopReason === 'model_context_window_exceeded') {
              logEvent('tengu_context_window_exceeded', {
                max_tokens: maxOutputTokens,
                output_tokens: usage.output_tokens,
              })
              // 补充说明：对模型而言上下文窗口耗尽和输出上限都是“从截断处继续”的同类恢复动作。
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: The model has reached its context window limit.`,
                apiError: 'max_output_tokens',
                error: 'max_output_tokens',
              })
            }
            break
          }
          case 'message_stop':
            break
        }

        // 91. 无论是否生成 assistant 消息，都把原始 stream event 透传给需要进度展示的上层。
        yield {
          type: 'stream_event',
          event: part,
          ...(part.type === 'message_start' ? { ttftMs } : undefined),
        }
      }
      // 92. stream 正常退出后清理 watchdog，避免请求完成后 timer 继续触发。
      clearStreamIdleTimers()

      // 93. 如果退出原因是 watchdog 主动 abort，转入非流式 fallback，而不是当作成功空响应。
      if (streamIdleAborted) {
        const exitDelayMs =
          streamWatchdogFiredAt !== null
            ? Math.round(performance.now() - streamWatchdogFiredAt)
            : -1
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_clean',
        )
        logEvent('tengu_stream_loop_exited_after_watchdog', {
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_delay_ms: exitDelayMs,
          exit_path:
            'clean' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        // 94. 清空触发时间，避免后续 catch 分支重复记录 watchdog 退出事件。
        streamWatchdogFiredAt = null
        throw new Error('Stream idle timeout - no chunks received')
      }

      // 95. 识别代理返回 200 但没有完整 SSE 内容的异常流，避免调用方只看到“没有 assistant 消息”。
      if (!partialMessage || (newMessages.length === 0 && !stopReason)) {
        logForDebugging(
          !partialMessage
            ? 'Stream completed without receiving message_start event - triggering non-streaming fallback'
            : 'Stream completed with message_start but no content blocks completed - triggering non-streaming fallback',
          { level: 'error' },
        )
        logEvent('tengu_stream_no_events', {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new Error('Stream ended without receiving any events')
      }

      // 96. 如果请求过程中出现过慢流间隔，汇总记录总次数和总耗时。
      if (stallCount > 0) {
        logForDebugging(
          `Streaming completed with ${stallCount} stall(s), total stall time: ${(totalStallTime / 1000).toFixed(1)}s`,
          { level: 'warn' },
        )
        logEvent('tengu_streaming_stall_summary', {
          stall_count: stallCount,
          total_stall_time_ms: totalStallTime,
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }

      // 97. 根据响应 token 反推 prompt cache 是否真的被破坏，用于缓存诊断。
      if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
        void checkResponseForCacheBreak(
          options.querySource,
          usage.cache_read_input_tokens,
          usage.cache_creation_input_tokens,
          messages,
          options.agentId,
          streamRequestId,
        )
      }

      // 98. 读取响应头中的 quota 和 gateway 信息；TypeScript 无法追踪回调内赋值，因此这里做窄化。
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins -- 当前运行时支持 Response。
      const resp = streamResponse as unknown as Response | undefined
      if (resp) {
        extractQuotaStatusFromHeaders(resp.headers)
        responseHeaders = resp.headers
      }
    } catch (streamingError) {
      // 99. 错误路径也必须清理 watchdog，避免错误返回后还有 timer 继续运行。
      clearStreamIdleTimers()

      // 100. watchdog 触发后如果 for-await 以错误退出，也记录退出延迟，区分真挂死和正常异常退出。
      if (streamIdleAborted && streamWatchdogFiredAt !== null) {
        const exitDelayMs = Math.round(
          performance.now() - streamWatchdogFiredAt,
        )
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_error',
        )
        logEvent('tengu_stream_loop_exited_after_watchdog', {
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_delay_ms: exitDelayMs,
          exit_path:
            'error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error_name:
            streamingError instanceof Error
              ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : ('unknown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }

      if (streamingError instanceof APIUserAbortError) {
        // 101. APIUserAbortError 需要区分真实用户中断和 SDK 内部超时。
        if (signal.aborted) {
          logForDebugging(
            `Streaming aborted by user: ${errorMessage(streamingError)}`,
          )
          if (isAdvisorInProgress) {
            logEvent('tengu_advisor_tool_interrupted', {
              model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              advisor_model: (advisorModel ??
                'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
          }
          throw streamingError
        } else {
          logForDebugging(
            `Streaming timeout (SDK abort): ${streamingError.message}`,
            { level: 'error' },
          )
          throw new APIConnectionTimeoutError({ message: 'Request timed out' })
        }
      }

      // 102. 特定开关下禁用非流式 fallback，避免流式工具已启动后 fallback 再次执行同一工具。
      const disableFallback =
        isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK) ||
        getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_disable_streaming_to_non_streaming_fallback',
          false,
        )

      if (disableFallback) {
        logForDebugging(
          `Error streaming (non-streaming fallback disabled): ${errorMessage(streamingError)}`,
          { level: 'error' },
        )
        logEvent('tengu_streaming_fallback_to_non_streaming', {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error:
            streamingError instanceof Error
              ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : (String(
                  streamingError,
                ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          attemptNumber,
          maxOutputTokens,
          thinkingType:
            thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          fallback_disabled: true,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          fallback_cause: (streamIdleAborted
            ? 'watchdog'
            : 'other') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw streamingError
      }

      // 103. 默认情况下，流式异常进入非流式 fallback，尽量给用户返回完整 assistant 消息。
      logForDebugging(
        `Error streaming, falling back to non-streaming mode: ${errorMessage(streamingError)}`,
        { level: 'error' },
      )
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }

      logEvent('tengu_streaming_fallback_to_non_streaming', {
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        error:
          streamingError instanceof Error
            ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
            : (String(
                streamingError,
              ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
        attemptNumber,
        maxOutputTokens,
        thinkingType:
          thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_disabled: false,
        request_id: (streamRequestId ??
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause: (streamIdleAborted
          ? 'watchdog'
          : 'other') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      // 104. fallback 请求沿用重试框架；如果流式阶段已遇到 529，要计入连续 529 预算。
      logForDiagnosticsNoPII('info', 'cli_nonstreaming_fallback_started')
      logEvent('tengu_nonstreaming_fallback_started', {
        request_id: (streamRequestId ??
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause: (streamIdleAborted
          ? 'watchdog'
          : 'other') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      const result = yield* executeNonStreamingRequest(
        { model: options.model, source: options.querySource },
        {
          model: options.model,
          fallbackModel: options.fallbackModel,
          thinkingConfig,
          ...(isFastModeEnabled() && { fastMode: isFastMode }),
          signal,
          initialConsecutive529Errors: is529Error(streamingError) ? 1 : 0,
          querySource: options.querySource,
        },
        paramsFromContext,
        (attempt, _startTime, tokens) => {
          attemptNumber = attempt
          maxOutputTokens = tokens
        },
        params => captureAPIRequest(params, options.querySource),
        streamRequestId,
      )

      // 105. 将非流式返回转换成内部 assistant 消息，并沿用同一套内容规范化逻辑。
      const m: AssistantMessage = {
        message: {
          ...result,
          content: normalizeContentFromAPI(
            result.content,
            tools,
            options.agentId,
          ),
        },
        requestId: streamRequestId ?? undefined,
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        ...(process.env.USER_TYPE === 'ant' &&
          research !== undefined && {
            research,
          }),
        ...(advisorModel && {
          advisorModel,
        }),
      }
      newMessages.push(m)
      fallbackMessage = m
      yield m
    } finally {
      // 106. 内层 finally 兜底清理 watchdog，覆盖正常、错误和 fallback 三种路径。
      clearStreamIdleTimers()
    }
  } catch (errorFromRetry) {
    // 107. 模型 fallback 信号必须交给 query.ts 执行真实模型切换，不能在这里转成普通错误。
    if (errorFromRetry instanceof FallbackTriggeredError) {
      throw errorFromRetry
    }

    // 108. 部分 gateway 的流式端点返回 404，但非流式端点可用；创建阶段 404 也要进入 fallback。
    const is404StreamCreationError =
      !didFallBackToNonStreaming &&
      errorFromRetry instanceof CannotRetryError &&
      errorFromRetry.originalError instanceof APIError &&
      errorFromRetry.originalError.status === 404

    if (is404StreamCreationError) {
      // 109. 创建流失败时还没有 streamRequestId，因此从 APIError header 中取失败请求 ID。
      const failedRequestId =
        (errorFromRetry.originalError as APIError).requestID ?? 'unknown'
      logForDebugging(
        'Streaming endpoint returned 404, falling back to non-streaming mode',
        { level: 'warn' },
      )
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }

      logEvent('tengu_streaming_fallback_to_non_streaming', {
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        error:
          '404_stream_creation' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        attemptNumber,
        maxOutputTokens,
        thinkingType:
          thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        request_id:
          failedRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause:
          '404_stream_creation' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      try {
        // 110. 对 404 流式创建失败执行同样的非流式 fallback。
        const result = yield* executeNonStreamingRequest(
          { model: options.model, source: options.querySource },
          {
            model: options.model,
            fallbackModel: options.fallbackModel,
            thinkingConfig,
            ...(isFastModeEnabled() && { fastMode: isFastMode }),
            signal,
          },
          paramsFromContext,
          (attempt, _startTime, tokens) => {
            attemptNumber = attempt
            maxOutputTokens = tokens
          },
          params => captureAPIRequest(params, options.querySource),
          failedRequestId,
        )

        // 111. fallback 成功后把结果转换为内部 assistant 消息，并继续走统一成功日志。
        const m: AssistantMessage = {
          message: {
            ...result,
            content: normalizeContentFromAPI(
              result.content,
              tools,
              options.agentId,
            ),
          },
          requestId: streamRequestId ?? undefined,
          type: 'assistant',
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
          ...(process.env.USER_TYPE === 'ant' &&
            research !== undefined && { research }),
          ...(advisorModel && { advisorModel }),
        }
        newMessages.push(m)
        fallbackMessage = m
        yield m

      } catch (fallbackError) {
        // 112. fallback 内部也可能触发模型切换信号，仍然必须向外抛出。
        if (fallbackError instanceof FallbackTriggeredError) {
          throw fallbackError
        }

        // 113. fallback 也失败时按普通 API 错误记录并转换为 assistant 错误消息。
        logForDebugging(
          `Non-streaming fallback also failed: ${errorMessage(fallbackError)}`,
          { level: 'error' },
        )

        let error = fallbackError
        let errorModel = options.model
        if (fallbackError instanceof CannotRetryError) {
          error = fallbackError.originalError
          errorModel = fallbackError.retryContext.model
        }

        if (error instanceof APIError) {
          extractQuotaStatusFromError(error)
        }

        const requestId =
          streamRequestId ||
          (error instanceof APIError ? error.requestID : undefined) ||
          (error instanceof APIError
            ? (error.error as { request_id?: string })?.request_id
            : undefined)

        logAPIError({
          error,
          model: errorModel,
          messageCount: messagesForAPI.length,
          messageTokens: tokenCountFromLastAPIResponse(messagesForAPI),
          durationMs: Date.now() - start,
          durationMsIncludingRetries: Date.now() - startIncludingRetries,
          attempt: attemptNumber,
          requestId,
          clientRequestId,
          didFallBackToNonStreaming,
          queryTracking: options.queryTracking,
          querySource: options.querySource,
          llmSpan,
          fastMode: isFastModeRequest,
          previousRequestId,
        })

        if (error instanceof APIUserAbortError) {
          releaseStreamResources()
          return
        }

        yield getAssistantMessageFromError(error, errorModel, {
          messages,
          messagesForAPI,
        })
        releaseStreamResources()
        return
      }
    } else {
      // 114. 非 404 创建错误或重试失败按标准 API 错误路径处理。
      logForDebugging(`Error in API request: ${errorMessage(errorFromRetry)}`, {
        level: 'error',
      })

      let error = errorFromRetry
      let errorModel = options.model
      if (errorFromRetry instanceof CannotRetryError) {
        error = errorFromRetry.originalError
        errorModel = errorFromRetry.retryContext.model
      }

      // 115. APIError 里可能带 quota 状态，先提取供后续 UI/限额逻辑使用。
      if (error instanceof APIError) {
        extractQuotaStatusFromError(error)
      }

      // 116. requestId 按 stream、错误 header、错误 body 顺序兜底提取。
      const requestId =
        streamRequestId ||
        (error instanceof APIError ? error.requestID : undefined) ||
        (error instanceof APIError
          ? (error.error as { request_id?: string })?.request_id
          : undefined)

      logAPIError({
        error,
        model: errorModel,
        messageCount: messagesForAPI.length,
        messageTokens: tokenCountFromLastAPIResponse(messagesForAPI),
        durationMs: Date.now() - start,
        durationMsIncludingRetries: Date.now() - startIncludingRetries,
        attempt: attemptNumber,
        requestId,
        clientRequestId,
        didFallBackToNonStreaming,
        queryTracking: options.queryTracking,
        querySource: options.querySource,
        llmSpan,
        fastMode: isFastModeRequest,
        previousRequestId,
      })

      // 117. 用户中断不产出 assistant 错误消息，交给 query.ts 显示统一中断提示。
      if (error instanceof APIUserAbortError) {
        releaseStreamResources()
        return
      }

      yield getAssistantMessageFromError(error, errorModel, {
        messages,
        messagesForAPI,
      })
      releaseStreamResources()
      return
    }
  } finally {
    // 118. 无论请求成功、失败还是 fallback，都停止会话活动状态并释放流资源。
    stopSessionActivity('api_call')
    releaseStreamResources()

    // 119. 非流式 fallback 的成本在 finally 中补计，避免 yield 后调用方提前 return 导致漏记。
    if (fallbackMessage) {
      const fallbackUsage = fallbackMessage.message.usage
      usage = updateUsage(EMPTY_USAGE, fallbackUsage)
      stopReason = fallbackMessage.message.stop_reason
      const fallbackCost = calculateUSDCost(resolvedModel, fallbackUsage)
      costUSD += addToTotalSessionCost(
        fallbackCost,
        fallbackUsage,
        options.model,
      )
    }
  }

  // 120. cached microcompact 成功发出工具后，标记工具已发送，后续才允许删除旧缓存引用。
  if (feature('CACHED_MICROCOMPACT') && cachedMCEnabled) {
    markToolsSentToAPIState()
  }

  // 121. 主会话链路记录最后 requestId，供退出或清空时发送缓存驱逐提示；后台 Agent 链路不共享该状态。
  if (
    streamRequestId &&
    !getAgentContext() &&
    (options.querySource.startsWith('repl_main_thread') ||
      options.querySource === 'sdk')
  ) {
    setLastMainRequestId(streamRequestId)
  }

  // 122. 成功日志同样只捕获标量，避免异步 permissionContext 读取期间持有完整消息数组。
  const logMessageCount = messagesForAPI.length
  const logMessageTokens = tokenCountFromLastAPIResponse(messagesForAPI)
  void options.getToolPermissionContext().then(permissionContext => {
    logAPISuccessAndDuration({
      model:
        newMessages[0]?.message.model ?? partialMessage?.model ?? options.model,
      preNormalizedModel: options.model,
      usage,
      start,
      startIncludingRetries,
      attempt: attemptNumber,
      messageCount: logMessageCount,
      messageTokens: logMessageTokens,
      requestId: streamRequestId ?? null,
      stopReason,
      ttftMs,
      didFallBackToNonStreaming,
      querySource: options.querySource,
      headers: responseHeaders,
      costUSD,
      queryTracking: options.queryTracking,
      permissionMode: permissionContext.mode,
      // 123. beta tracing 开启时 logging.ts 会从 newMessages 中提取新增上下文。
      newMessages,
      llmSpan,
      globalCacheStrategy,
      requestSetupMs: start - startIncludingRetries,
      attemptStartTimes,
      fastMode: isFastModeRequest,
      previousRequestId,
      betas: lastRequestBetas,
    })
  })

  // 124. 正常完成后再防御性释放一次；如果 finally 已经执行，这里是无副作用 no-op。
  releaseStreamResources()
}

/**
 * 清理 SDK stream，避免请求结束后底层连接继续占用资源。
 *
 * @param stream 需要终止的 SDK stream；为空时直接返回。
 * @returns 无返回值；异常会被吞掉，因为清理路径不能覆盖原始错误。
 * @internal 为测试导出。
 */
export function cleanupStream(
  stream: Stream<BetaRawMessageStreamEvent> | undefined,
): void {
  // 1. 没有 stream 时无需清理。
  if (!stream) {
    return
  }
  try {
    // 2. 只在 controller 尚未 abort 时触发 abort，避免重复中断引发无意义异常。
    if (!stream.controller.signal.aborted) {
      stream.controller.abort()
    }
  } catch {
    // 3. stream 可能已经关闭；清理失败不应影响调用方的主错误处理。
  }
}

/**
 * 用流式事件中的 usage 更新当前累计用量。
 *
 * Anthropic 流式 usage 是“到当前事件为止的累计值”，不是增量；输入 token 字段通常只在 message_start 有真实值，message_delta 的 0 不应覆盖它们。
 *
 * @param usage 当前已记录的非空 usage。
 * @param partUsage 流式事件携带的 usage 片段。
 * @returns 合并后的 usage 对象。
 */
export function updateUsage(
  usage: Readonly<NonNullableUsage>,
  partUsage: BetaMessageDeltaUsage | undefined,
): NonNullableUsage {
  // 1. 没有新 usage 时返回浅拷贝，避免调用方误以为可以原地修改传入对象。
  if (!partUsage) {
    return { ...usage }
  }
  // 2. 输入和缓存 token 只接受非零新值，防止 message_delta 的 0 覆盖 message_start 的真实统计。
  return {
    input_tokens:
      partUsage.input_tokens !== null && partUsage.input_tokens > 0
        ? partUsage.input_tokens
        : usage.input_tokens,
    cache_creation_input_tokens:
      partUsage.cache_creation_input_tokens !== null &&
      partUsage.cache_creation_input_tokens > 0
        ? partUsage.cache_creation_input_tokens
        : usage.cache_creation_input_tokens,
    cache_read_input_tokens:
      partUsage.cache_read_input_tokens !== null &&
      partUsage.cache_read_input_tokens > 0
        ? partUsage.cache_read_input_tokens
        : usage.cache_read_input_tokens,
    output_tokens: partUsage.output_tokens ?? usage.output_tokens,
    server_tool_use: {
      web_search_requests:
        partUsage.server_tool_use?.web_search_requests ??
        usage.server_tool_use.web_search_requests,
      web_fetch_requests:
        partUsage.server_tool_use?.web_fetch_requests ??
        usage.server_tool_use.web_fetch_requests,
    },
    service_tier: usage.service_tier,
    cache_creation: {
      // 3. SDK 类型暂缺 cache_creation，但 API 实际会返回该字段，需要通过 BetaUsage 读取。
      ephemeral_1h_input_tokens:
        (partUsage as BetaUsage).cache_creation?.ephemeral_1h_input_tokens ??
        usage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        (partUsage as BetaUsage).cache_creation?.ephemeral_5m_input_tokens ??
        usage.cache_creation.ephemeral_5m_input_tokens,
    },
    // 4. cache_deleted_input_tokens 只在 cached microcompact 构建中保留，外部构建通过 DCE 移除字段名。
    ...(feature('CACHED_MICROCOMPACT')
      ? {
          cache_deleted_input_tokens:
            (partUsage as unknown as { cache_deleted_input_tokens?: number })
              .cache_deleted_input_tokens != null &&
            (partUsage as unknown as { cache_deleted_input_tokens: number })
              .cache_deleted_input_tokens > 0
              ? (partUsage as unknown as { cache_deleted_input_tokens: number })
                  .cache_deleted_input_tokens
              : ((usage as unknown as { cache_deleted_input_tokens?: number })
                  .cache_deleted_input_tokens ?? 0),
        }
      : {}),
    inference_geo: usage.inference_geo,
    iterations: partUsage.iterations ?? usage.iterations,
    speed: (partUsage as BetaUsage).speed ?? usage.speed,
  }
}

/**
 * 将单条 assistant 消息的 usage 累加到总 usage。
 *
 * @param totalUsage 当前累计 usage。
 * @param messageUsage 待累加的单条消息 usage。
 * @returns 新的累计 usage；计数型字段累加，状态型字段使用最新消息值。
 */
export function accumulateUsage(
  totalUsage: Readonly<NonNullableUsage>,
  messageUsage: Readonly<NonNullableUsage>,
): NonNullableUsage {
  // 1. token 和 server_tool_use 请求数是可累加指标，需要逐项求和。
  return {
    input_tokens: totalUsage.input_tokens + messageUsage.input_tokens,
    cache_creation_input_tokens:
      totalUsage.cache_creation_input_tokens +
      messageUsage.cache_creation_input_tokens,
    cache_read_input_tokens:
      totalUsage.cache_read_input_tokens + messageUsage.cache_read_input_tokens,
    output_tokens: totalUsage.output_tokens + messageUsage.output_tokens,
    server_tool_use: {
      web_search_requests:
        totalUsage.server_tool_use.web_search_requests +
        messageUsage.server_tool_use.web_search_requests,
      web_fetch_requests:
        totalUsage.server_tool_use.web_fetch_requests +
        messageUsage.server_tool_use.web_fetch_requests,
    },
    service_tier: messageUsage.service_tier, // 2. service tier 是状态值，使用最近一次响应。
    cache_creation: {
      ephemeral_1h_input_tokens:
        totalUsage.cache_creation.ephemeral_1h_input_tokens +
        messageUsage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        totalUsage.cache_creation.ephemeral_5m_input_tokens +
        messageUsage.cache_creation.ephemeral_5m_input_tokens,
    },
    // 3. cache_deleted_input_tokens 只在 cached microcompact 构建中累加。
    ...(feature('CACHED_MICROCOMPACT')
      ? {
          cache_deleted_input_tokens:
            ((totalUsage as unknown as { cache_deleted_input_tokens?: number })
              .cache_deleted_input_tokens ?? 0) +
            ((
              messageUsage as unknown as { cache_deleted_input_tokens?: number }
            ).cache_deleted_input_tokens ?? 0),
        }
      : {}),
    // 4. 地域、迭代数和 speed 描述最近一次响应状态，因此采用最新消息值。
    inference_geo: messageUsage.inference_geo,
    iterations: messageUsage.iterations,
    speed: messageUsage.speed,
  }
}

/**
 * 判断未知 block 是否为带工具调用 ID 的 tool_result。
 *
 * @param block 待检查的未知内容块。
 * @returns 结构满足 `tool_result` 且存在 `tool_use_id` 时返回 true。
 */
function isToolResultBlock(
  block: unknown,
): block is { type: 'tool_result'; tool_use_id: string } {
  // 1. 同时校验对象形态、block 类型和 tool_use_id 字段，避免误处理普通内容块。
  return (
    block !== null &&
    typeof block === 'object' &&
    'type' in block &&
    (block as { type: string }).type === 'tool_result' &&
    'tool_use_id' in block
  )
}

/** cache editing 发送给 API 的删除编辑块，用于删除指定 cache_reference。 */
type CachedMCEditsBlock = {
  /** API block 类型，固定为 cache_edits。 */
  type: 'cache_edits'
  /** 删除操作列表，每个操作指向一个需要删除的 cache_reference。 */
  edits: { type: 'delete'; cache_reference: string }[]
}

/** 已固定位置的 cache edits，用于后续请求在原 user 消息位置重发。 */
type CachedMCPinnedEdits = {
  /** cache edits 所属的 user 消息索引。 */
  userMessageIndex: number
  /** 需要在该消息中重插入的 cache edits block。 */
  block: CachedMCEditsBlock
}

/**
 * 为 API 消息添加 prompt cache 断点和 cache editing 辅助 block。
 *
 * @param messages 内部 user/assistant 消息列表。
 * @param enablePromptCaching 是否启用 prompt caching。
 * @param querySource 请求来源，用于 cache_control TTL。
 * @param useCachedMC 是否启用 cached microcompact 的 cache editing。
 * @param newCacheEdits 本轮新产生的 cache 删除编辑。
 * @param pinnedEdits 之前已固定位置、需要重发的 cache 删除编辑。
 * @param skipCacheWrite 是否避免在请求尾部写入新的缓存尾巴。
 * @returns 可发送给 API 的 message 参数数组。
 */
export function addCacheBreakpoints(
  messages: (UserMessage | AssistantMessage)[],
  enablePromptCaching: boolean,
  querySource?: QuerySource,
  useCachedMC = false,
  newCacheEdits?: CachedMCEditsBlock | null,
  pinnedEdits?: CachedMCPinnedEdits[],
  skipCacheWrite = false,
): MessageParam[] {
  // 1. 先记录总消息数量和缓存开关，方便排查缓存断点位置异常。
  logEvent('tengu_api_cache_breakpoints', {
    totalMessageCount: messages.length,
    cachingEnabled: enablePromptCaching,
    skipCacheWrite,
  })

  // 2. 每个请求只放一个消息级 cache_control；后台 fork 则把断点移到倒数第二条，避免留下独立尾巴缓存。
  const markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1
  const result = messages.map((msg, index) => {
    const addCache = index === markerIndex
    if (msg.type === 'user') {
      return userMessageToMessageParam(
        msg,
        addCache,
        enablePromptCaching,
        querySource,
      )
    }
    return assistantMessageToMessageParam(
      msg,
      addCache,
      enablePromptCaching,
      querySource,
    )
  })

  if (!useCachedMC) {
    return result
  }

  // 3. 记录已删除的 cache_reference，避免 pinned edits 和 new edits 重复删除同一引用。
  const seenDeleteRefs = new Set<string>()

  /**
   * 针对已见过的 cache_reference 去重 cache edits。
   *
   * @param block 待去重的 cache edits block。
   * @returns 删除重复项后的新 block。
   */
  const deduplicateEdits = (block: CachedMCEditsBlock): CachedMCEditsBlock => {
    // 4. 遍历编辑项，保留首次出现的 cache_reference。
    const uniqueEdits = block.edits.filter(edit => {
      if (seenDeleteRefs.has(edit.cache_reference)) {
        return false
      }
      seenDeleteRefs.add(edit.cache_reference)
      return true
    })
    return { ...block, edits: uniqueEdits }
  }

  // 5. 将之前固定位置的 cache edits 插回原 user 消息，保持 API cache_reference 位置稳定。
  for (const pinned of pinnedEdits ?? []) {
    const msg = result[pinned.userMessageIndex]
    if (msg && msg.role === 'user') {
      if (!Array.isArray(msg.content)) {
        msg.content = [{ type: 'text', text: msg.content as string }]
      }
      const dedupedBlock = deduplicateEdits(pinned.block)
      if (dedupedBlock.edits.length > 0) {
        insertBlockAfterToolResults(msg.content, dedupedBlock)
      }
    }
  }

  // 6. 把本轮新 cache edits 插入最后一条 user 消息，并 pin 住位置供后续请求复用。
  if (newCacheEdits && result.length > 0) {
    const dedupedNewEdits = deduplicateEdits(newCacheEdits)
    if (dedupedNewEdits.edits.length > 0) {
      for (let i = result.length - 1; i >= 0; i--) {
        const msg = result[i]
        if (msg && msg.role === 'user') {
          if (!Array.isArray(msg.content)) {
            msg.content = [{ type: 'text', text: msg.content as string }]
          }
          insertBlockAfterToolResults(msg.content, dedupedNewEdits)
          pinCacheEdits(i, newCacheEdits)

          logForDebugging(
            `Added cache_edits block with ${dedupedNewEdits.edits.length} deletion(s) to message[${i}]: ${dedupedNewEdits.edits.map(e => e.cache_reference).join(', ')}`,
          )
          break
        }
      }
    }
  }

  // 7. 对缓存前缀内的 tool_result 增加 cache_reference；必须在 cache_edits 插入后执行。
  if (enablePromptCaching) {
    // 8. 找到最后一个带 cache_control 的消息索引，只有它之前的 tool_result 可以安全引用缓存。
    let lastCCMsg = -1
    for (let i = 0; i < result.length; i++) {
      const msg = result[i]!
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === 'object' && 'cache_control' in block) {
            lastCCMsg = i
          }
        }
      }
    }

    // 9. 只处理严格位于最后 cache_control 前的 tool_result，并克隆 block 避免污染其他查询复用的对象。
    if (lastCCMsg >= 0) {
      for (let i = 0; i < lastCCMsg; i++) {
        const msg = result[i]!
        if (msg.role !== 'user' || !Array.isArray(msg.content)) {
          continue
        }
        let cloned = false
        for (let j = 0; j < msg.content.length; j++) {
          const block = msg.content[j]
          if (block && isToolResultBlock(block)) {
            if (!cloned) {
              msg.content = [...msg.content]
              cloned = true
            }
            msg.content[j] = Object.assign({}, block, {
              cache_reference: block.tool_use_id,
            })
          }
        }
      }
    }
  }

  return result
}

/**
 * 将系统提示词拆分成 API text block，并按块级 cacheScope 添加缓存控制。
 *
 * @param systemPrompt 内部系统提示词数组。
 * @param enablePromptCaching 是否启用 prompt caching。
 * @param options 全局缓存避让和请求来源配置。
 * @returns Anthropic API `system` 字段需要的 text block 数组。
 */
export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: {
    skipGlobalCacheForSystemPrompt?: boolean
    querySource?: QuerySource
  },
): TextBlockParam[] {
  // 1. 只能按 splitSysPromptPrefix 的块数输出，不能为了缓存额外制造 block，否则 API 会返回 400。
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map(block => {
    return {
      type: 'text' as const,
      text: block.text,
      ...(enablePromptCaching &&
        block.cacheScope !== null && {
          cache_control: getCacheControl({
            scope: block.cacheScope,
            querySource: options?.querySource,
          }),
        }),
    }
  })
}

/** 查询 Haiku/小快模型时使用的选项，模型和权限上下文由函数内部固定。 */
type HaikuOptions = Omit<Options, 'model' | 'getToolPermissionContext'>

/**
 * 使用小快模型执行一次非流式查询。
 *
 * @param systemPrompt 系统提示词，默认空数组。
 * @param userPrompt 用户提示词文本。
 * @param outputFormat 可选结构化输出格式。
 * @param signal 中断信号。
 * @param options 除模型和权限上下文外的查询选项。
 * @returns 小快模型返回的 assistant 消息。
 */
export async function queryHaiku({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: BetaJSONOutputFormat
  signal: AbortSignal
  options: HaikuOptions
}): Promise<AssistantMessage> {
  // 1. 用 VCR 包裹请求，保证测试回放时输入消息与真实调用一致。
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      // 2. queryHaiku 只发送用户 prompt，系统 prompt 通过 queryModelWithoutStreaming 的 system 参数进入请求。
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          model: getSmallFastModel(),
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  // 3. Haiku 包装函数只期望一条非流式 assistant 结果，因此取第一条即可。
  return result[0]! as AssistantMessage
}

/** 指定模型查询使用的选项，权限上下文由函数内部提供空权限上下文。 */
type QueryWithModelOptions = Omit<Options, 'getToolPermissionContext'>

/**
 * 通过 Claude Code 完整基础设施查询指定模型。
 *
 * @param systemPrompt 系统提示词，默认空数组。
 * @param userPrompt 用户提示词文本。
 * @param outputFormat 可选结构化输出格式。
 * @param signal 中断信号。
 * @param options 包含目标模型在内的查询选项。
 * @returns 指定模型返回的 assistant 消息。
 */
export async function queryWithModel({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: BetaJSONOutputFormat
  signal: AbortSignal
  options: QueryWithModelOptions
}): Promise<AssistantMessage> {
  // 1. 仍走 VCR 和主查询链路，确保认证、beta、header、日志等行为与真实请求一致。
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      // 2. 构造单轮用户消息，再交给非流式查询入口处理系统提示词和模型参数。
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  // 3. 指定模型包装函数只期望一条 assistant 结果。
  return result[0]! as AssistantMessage
}

/** 非流式 fallback 的最大输出 token 上限；单位为 token，低于 API 长请求边界且高于 SDK 默认保守值。 */
export const MAX_NON_STREAMING_TOKENS = 64_000

/**
 * 为非流式 fallback 修正 max_tokens 和 thinking 预算。
 *
 * @param params 即将发送给 API 的请求参数。
 * @param maxTokensCap 非流式请求允许的最大输出 token 数。
 * @returns 修正后的请求参数，保证 `max_tokens > thinking.budget_tokens`。
 */
export function adjustParamsForNonStreaming<
  T extends {
    max_tokens: number
    thinking?: BetaMessageStreamParams['thinking']
  },
>(params: T, maxTokensCap: number): T {
  // 1. 先对 max_tokens 做硬上限裁剪，避免非流式请求超过长请求安全边界。
  const cappedMaxTokens = Math.min(params.max_tokens, maxTokensCap)

  // 2. 如果 thinking 预算不小于裁剪后的 max_tokens，则同步下调到 max_tokens - 1。
  const adjustedParams = { ...params }
  if (
    adjustedParams.thinking?.type === 'enabled' &&
    adjustedParams.thinking.budget_tokens
  ) {
    adjustedParams.thinking = {
      ...adjustedParams.thinking,
      budget_tokens: Math.min(
        adjustedParams.thinking.budget_tokens,
        cappedMaxTokens - 1,
      ),
    }
  }

  // 3. 返回新对象，避免调用方持有的原参数被原地修改。
  return {
    ...adjustedParams,
    max_tokens: cappedMaxTokens,
  }
}

/**
 * 判断默认输出 token 是否启用槽位预留上限。
 *
 * @returns GrowthBook gate 开启时返回 true。
 */
function isMaxTokensCapEnabled(): boolean {
  // 1. 第三方 provider 默认不开启该限制，避免在 Bedrock/Vertex 上应用未验证策略。
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_otk_slot_v1', false)
}

/**
 * 计算某个模型本次请求的默认最大输出 token。
 *
 * @param model 模型名。
 * @returns 环境变量覆盖、槽位预留上限和模型原生上限共同约束后的有效 token 数。
 */
export function getMaxOutputTokensForModel(model: string): number {
  // 1. 读取模型配置中的默认值和硬上限。
  const maxOutputTokens = getModelMaxOutputTokens(model)

  // 2. 槽位预留策略开启时，将高默认值压到统一上限，但保留原生更低默认值。
  const defaultTokens = isMaxTokensCapEnabled()
    ? Math.min(maxOutputTokens.default, CAPPED_DEFAULT_MAX_TOKENS)
    : maxOutputTokens.default

  // 3. 最后应用环境变量覆盖，并用模型 upperLimit 做边界校验。
  const result = validateBoundedIntEnvVar(
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
    defaultTokens,
    maxOutputTokens.upperLimit,
  )
  return result.effective
}
