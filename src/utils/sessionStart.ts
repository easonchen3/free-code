import { getMainThreadAgentType } from '../bootstrap/state.js'
import type { HookResultMessage } from '../types/message.js'
import { createAttachmentMessage } from './attachments.js'
import { logForDebugging } from './debug.js'
import { withDiagnosticsTiming } from './diagLogs.js'
import { isBareMode } from './envUtils.js'
import { updateWatchPaths } from './hooks/fileChangedWatcher.js'
import { shouldAllowManagedHooksOnly } from './hooks/hooksConfigSnapshot.js'
import { executeSessionStartHooks, executeSetupHooks } from './hooks.js'
import { logError } from './log.js'
import { loadPluginHooks } from './plugins/loadPluginHooks.js'

// SessionStart Hook 的执行参数；调用方可以按场景传入会话、模型和同步执行策略。
type SessionStartHooksOptions = {
  // 当前 session 的 UUID；传给 Hook 便于 Hook 读取或关联会话上下文。
  sessionId?: string
  // 当前主 Agent 类型；未传入时会从 bootstrap state 中兜底获取。
  agentType?: string
  // 当前使用的模型名称；Hook 可以根据模型差异调整返回内容。
  model?: string
  // 是否强制同步执行 Hook；用于启动、print 等需要确定顺序的场景。
  forceSyncExecution?: boolean
}

// processSessionStartHooks 在 Hook 返回 initialUserMessage 时写入这里。
// takeInitialUserMessage 只读取一次并立即清空，避免同一条初始用户消息被重复消费。
// 这个旁路状态用于兼容现有 Promise<HookResultMessage[]> 返回类型，避免为了 print 模式
// 的单个字段改动 main.tsx、print.ts 等多个调用点。
let pendingInitialUserMessage: string | undefined

/**
 * 取出 SessionStart Hook 产生的初始用户消息。
 * 1. 读取上一次 Hook 暂存的 pendingInitialUserMessage。
 * 2. 立即清空缓存，保证该消息只会被消费一次。
 * 3. 返回消息内容；如果没有 Hook 写入则返回 undefined。
 */
export function takeInitialUserMessage(): string | undefined {
  // 1. 先把暂存值复制到局部变量，后续清空不会影响本次返回。
  const v = pendingInitialUserMessage
  // 2. 清空全局暂存，确保 initialUserMessage 是一次性消费语义。
  pendingInitialUserMessage = undefined
  return v
}

// 启动路径必须保持轻量：不要在这里加入任何 warmup 逻辑或额外启动工作。
/**
 * 执行 SessionStart Hook，并把 Hook 的结果整理成可追加到会话中的消息。
 * 1. bare 模式直接跳过所有 Hook，避免无意义的插件加载。
 * 2. 准备消息、附加上下文和文件监听路径三个收集器。
 * 3. 按策略加载插件 Hook；受管 Hook-only 策略下禁止加载不受信任插件。
 * 4. 调用 executeSessionStartHooks 逐条消费 Hook 结果。
 * 5. 收集 Hook 消息、附加上下文、初始用户消息和 watchPaths。
 * 6. 更新文件监听路径，并把附加上下文包装成 hook_additional_context 消息。
 */
export async function processSessionStartHooks(
  source: 'startup' | 'resume' | 'clear' | 'compact',
  {
    sessionId,
    agentType,
    model,
    forceSyncExecution,
  }: SessionStartHooksOptions = {},
): Promise<HookResultMessage[]> {
  // 1. --bare 模式不执行 Hook，也不加载插件 Hook，减少启动时的无效等待。
  if (isBareMode()) {
    return []
  }
  // 2. 分别收集普通 Hook 消息、Hook 附加上下文和需要监听的路径。
  const hookMessages: HookResultMessage[] = []
  const additionalContexts: string[] = []
  const allWatchPaths: string[] = []

  // 3. 受管 Hook-only 策略下跳过插件 Hook，因为插件 Hook 属于外部不受信任代码。
  if (shouldAllowManagedHooksOnly()) {
    logForDebugging('Skipping plugin hooks - allowManagedHooksOnly is enabled')
  } else {
    // 4. 执行 SessionStart Hook 前确保插件 Hook 已注册；loadPluginHooks 已做缓存，重复调用成本很低。
    try {
      await withDiagnosticsTiming('load_plugin_hooks', () => loadPluginHooks())
    } catch (error) {
      // 5. 插件加载失败只记录错误，不阻断会话启动；项目级 Hook 仍然可以继续运行。
      /* eslint-disable no-restricted-syntax -- 两个分支都会补充上下文，不属于普通 toError 转换场景 */
      const enhancedError =
        error instanceof Error
          ? new Error(
              `Failed to load plugin hooks during ${source}: ${error.message}`,
            )
          : new Error(
              `Failed to load plugin hooks during ${source}: ${String(error)}`,
            )
      /* eslint-enable no-restricted-syntax */

      if (error instanceof Error && error.stack) {
        enhancedError.stack = error.stack
      }

      logError(enhancedError)

      // 6. 根据错误类型生成更明确的排查提示，便于用户定位网络、权限或配置问题。
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      let userGuidance = ''

      // 6.1 clone、DNS、超时等关键字通常表示插件下载或网络访问失败。
      if (
        errorMessage.includes('Failed to clone') ||
        errorMessage.includes('network') ||
        errorMessage.includes('ETIMEDOUT') ||
        errorMessage.includes('ENOTFOUND')
      ) {
        userGuidance =
          'This appears to be a network issue. Check your internet connection and try again.'
      // 6.2 权限错误通常说明插件目录或配置文件权限不允许当前进程访问。
      } else if (
        errorMessage.includes('Permission denied') ||
        errorMessage.includes('EACCES') ||
        errorMessage.includes('EPERM')
      ) {
        userGuidance =
          'This appears to be a permissions issue. Check file permissions on ~/.claude/plugins/'
      // 6.3 解析、JSON、schema 相关错误通常说明插件配置本身不合法。
      } else if (
        errorMessage.includes('Invalid') ||
        errorMessage.includes('parse') ||
        errorMessage.includes('JSON') ||
        errorMessage.includes('schema')
      ) {
        userGuidance =
          'This appears to be a configuration issue. Check your plugin settings in .claude/settings.json'
      } else {
        // 6.4 无法归类时给出通用修复方向，避免吞掉插件加载失败的上下文。
        userGuidance =
          'Please fix the plugin configuration or remove problematic plugins from your settings.'
      }

      logForDebugging(
        `Warning: Failed to load plugin hooks. SessionStart hooks from plugins will not execute. ` +
          `Error: ${errorMessage}. ${userGuidance}`,
        { level: 'warn' },
      )

      // 7. 继续执行：插件 Hook 不可用，但 .claude/settings.json 中的项目级 Hook 仍会生效。
    }
  }

  // 8. 执行 SessionStart Hook；未显式传入 agentType 时使用 bootstrap 状态中的主线程类型。
  const resolvedAgentType = agentType ?? getMainThreadAgentType()
  for await (const hookResult of executeSessionStartHooks(
    source,
    sessionId,
    resolvedAgentType,
    model,
    undefined,
    undefined,
    forceSyncExecution,
  )) {
    // 9. Hook 返回的 message 会直接成为后续会话消息。
    if (hookResult.message) {
      hookMessages.push(hookResult.message)
    }
    // 10. Hook 返回的 additionalContexts 先集中收集，最后统一包装为附件消息。
    if (
      hookResult.additionalContexts &&
      hookResult.additionalContexts.length > 0
    ) {
      additionalContexts.push(...hookResult.additionalContexts)
    }
    // 11. 初始用户消息通过旁路状态传递给 print 模式等后续消费者。
    if (hookResult.initialUserMessage) {
      pendingInitialUserMessage = hookResult.initialUserMessage
    }
    // 12. watchPaths 用于后续文件变化监听，多个 Hook 的路径统一合并。
    if (hookResult.watchPaths && hookResult.watchPaths.length > 0) {
      allWatchPaths.push(...hookResult.watchPaths)
    }
  }

  // 13. Hook 声明了监听路径时，更新全局文件变化 watcher。
  if (allWatchPaths.length > 0) {
    updateWatchPaths(allWatchPaths)
  }

  // 14. 把 Hook 附加上下文转换成标准附件消息，避免散落在普通消息结构之外。
  if (additionalContexts.length > 0) {
    // 14.1 createAttachmentMessage 会把字符串数组转换成 transcript 可识别的附件消息。
    const contextMessage = createAttachmentMessage({
      type: 'hook_additional_context',
      content: additionalContexts,
      hookName: 'SessionStart',
      toolUseID: 'SessionStart',
      hookEvent: 'SessionStart',
    })
    hookMessages.push(contextMessage)
  }

  return hookMessages
}

/**
 * 执行 Setup Hook，并把 Hook 输出整理成可注入会话的消息。
 * 1. bare 模式直接跳过，避免加载和执行任何 Hook。
 * 2. 按策略加载插件 Hook；加载失败只记录警告，不中断 setup 流程。
 * 3. 逐条消费 executeSetupHooks 的结果，收集消息和附加上下文。
 * 4. 将附加上下文包装成 hook_additional_context 消息后返回。
 */
export async function processSetupHooks(
  trigger: 'init' | 'maintenance',
  { forceSyncExecution }: { forceSyncExecution?: boolean } = {},
): Promise<HookResultMessage[]> {
  // 1. 与 SessionStart 一致，bare 模式下 Hook 不会运行，也没有必要加载插件 Hook。
  if (isBareMode()) {
    return []
  }
  // 2. 收集 Hook 直接返回的消息，以及稍后统一包装的附加上下文。
  const hookMessages: HookResultMessage[] = []
  const additionalContexts: string[] = []

  // 3. 受管 Hook-only 策略下不加载插件 Hook，避免执行外部不受信任代码。
  if (shouldAllowManagedHooksOnly()) {
    logForDebugging('Skipping plugin hooks - allowManagedHooksOnly is enabled')
  } else {
    try {
      // 4. Setup Hook 也可能来自插件，因此执行前先确保插件 Hook 已加载。
      await loadPluginHooks()
    } catch (error) {
      // 5. 插件加载失败时只降级为警告；非插件来源的 Setup Hook 仍可继续执行。
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logForDebugging(
        `Warning: Failed to load plugin hooks. Setup hooks from plugins will not execute. Error: ${errorMessage}`,
        { level: 'warn' },
      )
    }
  }

  // 6. 执行 Setup Hook，逐个消费异步迭代器返回的结果。
  for await (const hookResult of executeSetupHooks(
    trigger,
    undefined,
    undefined,
    forceSyncExecution,
  )) {
    // 7. 普通 Hook 消息直接进入返回列表。
    if (hookResult.message) {
      hookMessages.push(hookResult.message)
    }
    // 8. 附加上下文集中收集，最后转换为附件消息。
    if (
      hookResult.additionalContexts &&
      hookResult.additionalContexts.length > 0
    ) {
      additionalContexts.push(...hookResult.additionalContexts)
    }
  }

  // 9. 有附加上下文时，统一包装成 Setup 来源的附件消息。
  if (additionalContexts.length > 0) {
    // 9.1 Setup Hook 的附加上下文也走附件消息，保持和 SessionStart 一致的消息结构。
    const contextMessage = createAttachmentMessage({
      type: 'hook_additional_context',
      content: additionalContexts,
      hookName: 'Setup',
      toolUseID: 'Setup',
      hookEvent: 'Setup',
    })
    hookMessages.push(contextMessage)
  }

  return hookMessages
}
