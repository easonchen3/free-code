import { HOOK_EVENTS, type HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { AppState } from 'src/state/AppState.js'
import type { Message } from 'src/types/message.js'
import { logForDebugging } from '../debug.js'
import type { AggregatedHookResult } from '../hooks.js'
import type { HookCommand } from '../settings/types.js'
import { isHookEqual } from './hooksSettings.js'

/** Hook 成功执行后的会话内回调，用于把运行结果反馈给注册方。 */
type OnHookSuccess = (
  hook: HookCommand | FunctionHook,
  result: AggregatedHookResult,
) => void

/**
 * function hook 的回调签名。
 *
 * @param messages 当前会话消息历史。
 * @param signal 可选取消信号。
 * @returns true 表示检查通过，false 表示应阻断。
 */
export type FunctionHookCallback = (
  messages: Message[],
  signal?: AbortSignal,
) => boolean | Promise<boolean>

/** 会话态 function hook，携带无法持久化到 settings.json 的内存回调。 */
export type FunctionHook = {
  /** Hook 类型标识。 */
  type: 'function'
  /** 可选唯一 ID，供后续移除指定 function hook。 */
  id?: string
  /** 单个 function hook 的超时时间，单位毫秒。 */
  timeout?: number
  /** 实际执行的内存回调。 */
  callback: FunctionHookCallback
  /** 回调返回 false 时展示给模型或用户的错误消息。 */
  errorMessage: string
  /** 执行期间展示的状态文案。 */
  statusMessage?: string
}

/** 单个 matcher 下的会话态 Hook 列表。 */
type SessionHookMatcher = {
  /** 与事件输入匹配的 matcher 字符串。 */
  matcher: string
  /** skill 作用域根目录；相同 matcher 但不同 skillRoot 不能合并。 */
  skillRoot?: string
  /** matcher 命中后需要执行的 Hook 以及可选成功回调。 */
  hooks: Array<{
    hook: HookCommand | FunctionHook
    onHookSuccess?: OnHookSuccess
  }>
}

/** 单个 session 保存的所有会话态 Hook。 */
export type SessionStore = {
  hooks: {
    [event in HookEvent]?: SessionHookMatcher[]
  }
}

/** 会话 ID 到 Hook store 的映射；使用 Map 是为了原地 set/delete，避免高并发注册时复制大对象。 */
export type SessionHooksState = Map<string, SessionStore>

/**
 * 向会话注册普通 Hook。
 *
 * @param setAppState 更新 AppState 的函数。
 * @param sessionId 会话 ID。
 * @param event Hook 事件名。
 * @param matcher 事件匹配字符串。
 * @param hook 要注册的命令、prompt、agent 或 http Hook。
 * @param onHookSuccess Hook 成功后的可选回调。
 * @param skillRoot 可选 skill 根目录，用于区分 skill 作用域 Hook。
 * @returns 无返回值。
 */
export function addSessionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  hook: HookCommand,
  onHookSuccess?: OnHookSuccess,
  skillRoot?: string,
): void {
  // 1. 普通 Hook 和 function Hook 共享同一份会话存储写入逻辑。
  addHookToSession(
    setAppState,
    sessionId,
    event,
    matcher,
    hook,
    onHookSuccess,
    skillRoot,
  )
}

/**
 * 向会话注册 function hook。
 *
 * @param setAppState 更新 AppState 的函数。
 * @param sessionId 会话 ID。
 * @param event Hook 事件名。
 * @param matcher 事件匹配字符串。
 * @param callback 内存回调，返回 false 时阻断。
 * @param errorMessage 阻断时使用的错误消息。
 * @param options 可选 ID 和超时时间，timeout 单位为毫秒。
 * @returns function hook ID，供后续移除使用。
 */
export function addFunctionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  callback: FunctionHookCallback,
  errorMessage: string,
  options?: {
    timeout?: number
    id?: string
  },
): string {
  // 1. 调用方未提供 ID 时生成一个会话内唯一性足够的 ID。
  const id = options?.id || `function-hook-${Date.now()}-${Math.random()}`
  // 2. function hook 只存在内存里，不能写入 settings。
  const hook: FunctionHook = {
    type: 'function',
    id,
    timeout: options?.timeout || 5000,
    callback,
    errorMessage,
  }
  // 3. 复用统一注册路径写入会话 store。
  addHookToSession(setAppState, sessionId, event, matcher, hook)
  // 4. 返回 ID，允许调用方精准删除。
  return id
}

/**
 * 从会话中移除指定 function hook。
 *
 * @param setAppState 更新 AppState 的函数。
 * @param sessionId 会话 ID。
 * @param event Hook 事件名。
 * @param hookId 要移除的 function hook ID。
 * @returns 无返回值。
 */
export function removeFunctionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  hookId: string,
): void {
  setAppState(prev => {
    // 1. 没有会话 store 时无需修改状态。
    const store = prev.sessionHooks.get(sessionId)
    if (!store) {
      return prev
    }

    // 2. 只扫描目标事件下的 matcher 列表。
    const eventMatchers = store.hooks[event] || []

    // 3. 从每个 matcher 中过滤掉 ID 命中的 function hook。
    const updatedMatchers = eventMatchers
      .map(matcher => {
        const updatedHooks = matcher.hooks.filter(h => {
          if (h.hook.type !== 'function') return true
          return h.hook.id !== hookId
        })

        return updatedHooks.length > 0
          ? { ...matcher, hooks: updatedHooks }
          : null
      })
      .filter((m): m is SessionHookMatcher => m !== null)

    // 4. 如果目标事件没有剩余 matcher，则从 hooks 对象中删除该事件。
    const newHooks =
      updatedMatchers.length > 0
        ? { ...store.hooks, [event]: updatedMatchers }
        : Object.fromEntries(
            Object.entries(store.hooks).filter(([e]) => e !== event),
          )

    // 5. Map 原地更新，保持 AppState 外层对象引用不变。
    prev.sessionHooks.set(sessionId, { hooks: newHooks })
    return prev
  })

  logForDebugging(
    `Removed function hook ${hookId} for event ${event} in session ${sessionId}`,
  )
}

/**
 * 把 Hook 写入指定会话的 Hook store。
 *
 * @param setAppState 更新 AppState 的函数。
 * @param sessionId 会话 ID。
 * @param event Hook 事件名。
 * @param matcher 事件匹配字符串。
 * @param hook 要写入的 Hook。
 * @param onHookSuccess Hook 成功后的可选回调。
 * @param skillRoot 可选 skill 根目录。
 * @returns 无返回值。
 */
function addHookToSession(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  hook: HookCommand | FunctionHook,
  onHookSuccess?: OnHookSuccess,
  skillRoot?: string,
): void {
  setAppState(prev => {
    // 1. 取出当前 session store；不存在时创建空 store。
    const store = prev.sessionHooks.get(sessionId) ?? { hooks: {} }
    const eventMatchers = store.hooks[event] || []

    // 2. matcher 和 skillRoot 都相同才合并到已有 matcher。
    const existingMatcherIndex = eventMatchers.findIndex(
      m => m.matcher === matcher && m.skillRoot === skillRoot,
    )

    // 3. 命中已有 matcher 时追加 Hook；否则新增 matcher 项。
    let updatedMatchers: SessionHookMatcher[]
    if (existingMatcherIndex >= 0) {
      updatedMatchers = [...eventMatchers]
      const existingMatcher = updatedMatchers[existingMatcherIndex]!
      updatedMatchers[existingMatcherIndex] = {
        matcher: existingMatcher.matcher,
        skillRoot: existingMatcher.skillRoot,
        hooks: [...existingMatcher.hooks, { hook, onHookSuccess }],
      }
    } else {
      updatedMatchers = [
        ...eventMatchers,
        {
          matcher,
          skillRoot,
          hooks: [{ hook, onHookSuccess }],
        },
      ]
    }

    // 4. 只替换当前事件的 matcher 列表，其它事件保持不变。
    const newHooks = { ...store.hooks, [event]: updatedMatchers }

    // 5. 原地更新 Map，避免触发不必要的全局状态监听。
    prev.sessionHooks.set(sessionId, { hooks: newHooks })
    return prev
  })

  logForDebugging(
    `Added session hook for event ${event} in session ${sessionId}`,
  )
}

/**
 * 从会话中移除指定普通 Hook。
 *
 * @param setAppState 更新 AppState 的函数。
 * @param sessionId 会话 ID。
 * @param event Hook 事件名。
 * @param hook 要移除的 Hook 配置。
 * @returns 无返回值。
 */
export function removeSessionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  hook: HookCommand,
): void {
  setAppState(prev => {
    // 1. 没有 store 时说明当前会话没有注册 Hook。
    const store = prev.sessionHooks.get(sessionId)
    if (!store) {
      return prev
    }

    // 2. 只处理目标事件下的 matcher。
    const eventMatchers = store.hooks[event] || []

    // 3. 从所有 matcher 中删除与目标 Hook 等价的配置。
    const updatedMatchers = eventMatchers
      .map(matcher => {
        const updatedHooks = matcher.hooks.filter(
          h => !isHookEqual(h.hook, hook),
        )

        return updatedHooks.length > 0
          ? { ...matcher, hooks: updatedHooks }
          : null
      })
      .filter((m): m is SessionHookMatcher => m !== null)

    // 4. 当前事件没有剩余 matcher 时，从 hooks 对象中移除事件键。
    const newHooks =
      updatedMatchers.length > 0
        ? { ...store.hooks, [event]: updatedMatchers }
        : { ...store.hooks }

    if (updatedMatchers.length === 0) {
      delete newHooks[event]
    }

    // 5. 写回 sessionHooks Map。
    prev.sessionHooks.set(sessionId, { ...store, hooks: newHooks })
    return prev
  })

  logForDebugging(
    `Removed session hook for event ${event} in session ${sessionId}`,
  )
}

/** 由会话态 Hook 转换出的普通 matcher，保留可选 skillRoot 以便执行阶段恢复上下文。 */
export type SessionDerivedHookMatcher = {
  /** 事件匹配字符串。 */
  matcher: string
  /** 可持久化 Hook 列表；function hook 不会出现在这里。 */
  hooks: HookCommand[]
  /** 可选 skill 根目录。 */
  skillRoot?: string
}

/**
 * 把会话内部 matcher 转成普通 Hook matcher。
 *
 * @param sessionMatchers 会话内部 matcher 列表。
 * @returns 可交给普通 Hook 执行路径使用的 matcher 列表。
 */
function convertToHookMatchers(
  sessionMatchers: SessionHookMatcher[],
): SessionDerivedHookMatcher[] {
  // 1. 保留 matcher 和 skillRoot，只转换可持久化的 HookCommand。
  return sessionMatchers.map(sm => ({
    matcher: sm.matcher,
    skillRoot: sm.skillRoot,
    // 2. function hook 带闭包回调，不能进入普通 HookMatcher 格式。
    hooks: sm.hooks
      .map(h => h.hook)
      .filter((h): h is HookCommand => h.type !== 'function'),
  }))
}

/**
 * 获取会话中注册的普通 Hook。
 *
 * @param appState 当前应用状态。
 * @param sessionId 会话 ID。
 * @param event 可选事件名；传入时只返回该事件的 Hook。
 * @returns 事件到普通 Hook matcher 的映射。
 */
export function getSessionHooks(
  appState: AppState,
  sessionId: string,
  event?: HookEvent,
): Map<HookEvent, SessionDerivedHookMatcher[]> {
  // 1. 没有会话 store 时返回空 Map。
  const store = appState.sessionHooks.get(sessionId)
  if (!store) {
    return new Map()
  }

  // 2. 结果统一使用 Map，和调用方合并逻辑保持一致。
  const result = new Map<HookEvent, SessionDerivedHookMatcher[]>()

  // 3. 指定事件时只转换该事件，减少不必要遍历。
  if (event) {
    const sessionMatchers = store.hooks[event]
    if (sessionMatchers) {
      result.set(event, convertToHookMatchers(sessionMatchers))
    }
    return result
  }

  // 4. 未指定事件时按已知 Hook 事件枚举输出所有普通 Hook。
  for (const evt of HOOK_EVENTS) {
    const sessionMatchers = store.hooks[evt]
    if (sessionMatchers) {
      result.set(evt, convertToHookMatchers(sessionMatchers))
    }
  }

  // 5. 返回普通 Hook 视图；function hook 由专门函数读取。
  return result
}

/** function hook 专用 matcher，不能和普通 HookCommand matcher 混用。 */
type FunctionHookMatcher = {
  /** 事件匹配字符串。 */
  matcher: string
  /** 该 matcher 下的 function hook 列表。 */
  hooks: FunctionHook[]
}

/**
 * 获取会话中注册的 function hook。
 *
 * @param appState 当前应用状态。
 * @param sessionId 会话 ID。
 * @param event 可选事件名；传入时只返回该事件的 function hook。
 * @returns 事件到 function hook matcher 的映射。
 */
export function getSessionFunctionHooks(
  appState: AppState,
  sessionId: string,
  event?: HookEvent,
): Map<HookEvent, FunctionHookMatcher[]> {
  // 1. 没有会话 store 时返回空 Map。
  const store = appState.sessionHooks.get(sessionId)
  if (!store) {
    return new Map()
  }

  // 2. function hook 独立返回，避免普通 Hook 执行路径尝试序列化闭包。
  const result = new Map<HookEvent, FunctionHookMatcher[]>()

  /**
   * 从会话 matcher 中提取 function hook。
   *
   * @param sessionMatchers 会话内部 matcher 列表。
   * @returns 只包含 function hook 的 matcher 列表。
   */
  const extractFunctionHooks = (
    sessionMatchers: SessionHookMatcher[],
  ): FunctionHookMatcher[] => {
    // 1. 保留 matcher 字符串，只筛选 type=function 的 Hook。
    return sessionMatchers
      .map(sm => ({
        matcher: sm.matcher,
        hooks: sm.hooks
          .map(h => h.hook)
          .filter((h): h is FunctionHook => h.type === 'function'),
      }))
      // 2. 删除没有 function hook 的 matcher，减少执行阶段空循环。
      .filter(m => m.hooks.length > 0)
  }

  // 3. 指定事件时只提取该事件。
  if (event) {
    const sessionMatchers = store.hooks[event]
    if (sessionMatchers) {
      const functionMatchers = extractFunctionHooks(sessionMatchers)
      if (functionMatchers.length > 0) {
        result.set(event, functionMatchers)
      }
    }
    return result
  }

  // 4. 未指定事件时遍历全部 Hook 事件并提取 function hook。
  for (const evt of HOOK_EVENTS) {
    const sessionMatchers = store.hooks[evt]
    if (sessionMatchers) {
      const functionMatchers = extractFunctionHooks(sessionMatchers)
      if (functionMatchers.length > 0) {
        result.set(evt, functionMatchers)
      }
    }
  }

  // 5. 返回 function hook 专用视图。
  return result
}

/**
 * 查找会话 Hook 的完整注册项。
 *
 * @param appState 当前应用状态。
 * @param sessionId 会话 ID。
 * @param event Hook 事件名。
 * @param matcher 当前执行命中的 matcher；空字符串表示允许匹配任意 matcher。
 * @param hook 当前执行的 Hook。
 * @returns 找到时返回 Hook 和成功回调；否则返回 undefined。
 */
export function getSessionHookCallback(
  appState: AppState,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  hook: HookCommand | FunctionHook,
):
  | {
      hook: HookCommand | FunctionHook
      onHookSuccess?: OnHookSuccess
    }
  | undefined {
  // 1. 没有会话 store 时无法查找回调。
  const store = appState.sessionHooks.get(sessionId)
  if (!store) {
    return undefined
  }

  // 2. 没有目标事件时直接返回空。
  const eventMatchers = store.hooks[event]
  if (!eventMatchers) {
    return undefined
  }

  // 3. 在 matcher 命中或调用方传空 matcher 时，按 Hook 等价性查找注册项。
  for (const matcherEntry of eventMatchers) {
    if (matcherEntry.matcher === matcher || matcher === '') {
      const hookEntry = matcherEntry.hooks.find(h => isHookEqual(h.hook, hook))
      if (hookEntry) {
        return hookEntry
      }
    }
  }

  // 4. 没有找到对应 Hook 或成功回调。
  return undefined
}

/**
 * 清空指定会话的所有会话态 Hook。
 *
 * @param setAppState 更新 AppState 的函数。
 * @param sessionId 会话 ID。
 * @returns 无返回值。
 */
export function clearSessionHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
): void {
  setAppState(prev => {
    // 1. 直接从 Map 删除该会话的 Hook store。
    prev.sessionHooks.delete(sessionId)
    return prev
  })

  logForDebugging(`Cleared all session hooks for session ${sessionId}`)
}
