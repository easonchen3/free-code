import { HOOK_EVENTS, type HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { AppState } from 'src/state/AppState.js'
import type { Message } from 'src/types/message.js'
import { logForDebugging } from '../debug.js'
import type { AggregatedHookResult } from '../hooks.js'
import type { HookCommand } from '../settings/types.js'
import { isHookEqual } from './hooksSettings.js'

/** 钩子成功执行后的会话内回调，用于把运行结果反馈给注册方。 */
type OnHookSuccess = (
  hook: HookCommand | FunctionHook,
  result: AggregatedHookResult,
) => void

/**
 * 函数型钩子的回调签名。
 *
 * @param messages 当前会话消息历史。
 * @param signal 可选取消信号。
 * @returns true 表示检查通过，false 表示应阻断。
 */
export type FunctionHookCallback = (
  messages: Message[],
  signal?: AbortSignal,
) => boolean | Promise<boolean>

/** 会话态函数型钩子，携带无法持久化到配置文件的内存回调。 */
export type FunctionHook = {
  /** 钩子类型标识。 */
  type: 'function'
  /** 可选唯一 ID，供后续移除指定函数型钩子。 */
  id?: string
  /** 单个函数型钩子的超时时间，单位毫秒。 */
  timeout?: number
  /** 实际执行的内存回调。 */
  callback: FunctionHookCallback
  /** 回调返回 false 时展示给模型或用户的错误消息。 */
  errorMessage: string
  /** 执行期间展示的状态文案。 */
  statusMessage?: string
}

/** 单个匹配器下的会话态钩子列表。 */
type SessionHookMatcher = {
  /** 与事件输入匹配的匹配器字符串。 */
  matcher: string
  /** 技能作用域根目录；相同匹配器但不同技能根目录不能合并。 */
  skillRoot?: string
  /** 匹配器命中后需要执行的钩子以及可选成功回调。 */
  hooks: Array<{
    hook: HookCommand | FunctionHook
    onHookSuccess?: OnHookSuccess
  }>
}

/** 单个会话保存的所有会话态钩子。 */
export type SessionStore = {
  hooks: {
    [event in HookEvent]?: SessionHookMatcher[]
  }
}

/** 会话 ID 到钩子存储区的映射；使用映射表是为了原地增删，避免高并发注册时复制大对象。 */
export type SessionHooksState = Map<string, SessionStore>

/**
 * 向会话注册普通钩子。
 *
 * @param setAppState 更新 AppState 的函数。
 * @param sessionId 会话 ID。
 * @param event 钩子事件名。
 * @param matcher 事件匹配字符串。
 * @param hook 要注册的命令、提示词、代理或网络钩子。
 * @param onHookSuccess 钩子成功后的可选回调。
 * @param skillRoot 可选技能根目录，用于区分技能作用域钩子。
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
  // 1. 普通钩子和函数型钩子共享同一份会话存储写入逻辑。
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
 * 向会话注册函数型钩子。
 *
 * @param setAppState 更新 AppState 的函数。
 * @param sessionId 会话 ID。
 * @param event 钩子事件名。
 * @param matcher 事件匹配字符串。
 * @param callback 内存回调，返回 false 时阻断。
 * @param errorMessage 阻断时使用的错误消息。
 * @param options 可选 ID 和超时时间，timeout 单位为毫秒。
 * @returns 函数型钩子 ID，供后续移除使用。
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
  // 2. 函数型钩子只存在内存里，不能写入配置文件。
  const hook: FunctionHook = {
    type: 'function',
    id,
    timeout: options?.timeout || 5000,
    callback,
    errorMessage,
  }
  // 3. 复用统一注册路径写入会话存储区。
  addHookToSession(setAppState, sessionId, event, matcher, hook)
  // 4. 返回 ID，允许调用方精准删除。
  return id
}

/**
 * 从会话中移除指定函数型钩子。
 *
 * @param setAppState 更新 AppState 的函数。
 * @param sessionId 会话 ID。
 * @param event 钩子事件名。
 * @param hookId 要移除的函数型钩子 ID。
 * @returns 无返回值。
 */
export function removeFunctionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  hookId: string,
): void {
  setAppState(prev => {
    // 1. 没有会话存储区时无需修改状态。
    const store = prev.sessionHooks.get(sessionId)
    if (!store) {
      return prev
    }

    // 2. 只扫描目标事件下的匹配器列表。
    const eventMatchers = store.hooks[event] || []

    // 3. 从每个匹配器中过滤掉 ID 命中的函数型钩子。
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

    // 4. 如果目标事件没有剩余匹配器，则从钩子对象中删除该事件。
    const newHooks =
      updatedMatchers.length > 0
        ? { ...store.hooks, [event]: updatedMatchers }
        : Object.fromEntries(
            Object.entries(store.hooks).filter(([e]) => e !== event),
          )

    // 5. 映射表原地更新，保持应用状态外层对象引用不变。
    prev.sessionHooks.set(sessionId, { hooks: newHooks })
    return prev
  })

  logForDebugging(
    `Removed function hook ${hookId} for event ${event} in session ${sessionId}`,
  )
}

/**
 * 把钩子写入指定会话的钩子存储区。
 *
 * @param setAppState 更新 AppState 的函数。
 * @param sessionId 会话 ID。
 * @param event 钩子事件名。
 * @param matcher 事件匹配字符串。
 * @param hook 要写入的钩子。
 * @param onHookSuccess 钩子成功后的可选回调。
 * @param skillRoot 可选技能根目录。
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
    // 1. 取出当前会话存储区；不存在时创建空存储区。
    const store = prev.sessionHooks.get(sessionId) ?? { hooks: {} }
    const eventMatchers = store.hooks[event] || []

    // 2. 匹配器和技能根目录都相同才合并到已有匹配器。
    const existingMatcherIndex = eventMatchers.findIndex(
      m => m.matcher === matcher && m.skillRoot === skillRoot,
    )

    // 3. 命中已有匹配器时追加钩子；否则新增匹配器项。
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

    // 4. 只替换当前事件的匹配器列表，其它事件保持不变。
    const newHooks = { ...store.hooks, [event]: updatedMatchers }

    // 5. 原地更新映射表，避免触发不必要的全局状态监听。
    prev.sessionHooks.set(sessionId, { hooks: newHooks })
    return prev
  })

  logForDebugging(
    `Added session hook for event ${event} in session ${sessionId}`,
  )
}

/**
 * 从会话中移除指定普通钩子。
 *
 * @param setAppState 更新 AppState 的函数。
 * @param sessionId 会话 ID。
 * @param event 钩子事件名。
 * @param hook 要移除的钩子配置。
 * @returns 无返回值。
 */
export function removeSessionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  hook: HookCommand,
): void {
  setAppState(prev => {
    // 1. 没有存储区时说明当前会话没有注册钩子。
    const store = prev.sessionHooks.get(sessionId)
    if (!store) {
      return prev
    }

    // 2. 只处理目标事件下的匹配器。
    const eventMatchers = store.hooks[event] || []

    // 3. 从所有匹配器中删除与目标钩子等价的配置。
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

    // 4. 当前事件没有剩余匹配器时，从钩子对象中移除事件键。
    const newHooks =
      updatedMatchers.length > 0
        ? { ...store.hooks, [event]: updatedMatchers }
        : { ...store.hooks }

    if (updatedMatchers.length === 0) {
      delete newHooks[event]
    }

    // 5. 写回会话钩子映射表。
    prev.sessionHooks.set(sessionId, { ...store, hooks: newHooks })
    return prev
  })

  logForDebugging(
    `Removed session hook for event ${event} in session ${sessionId}`,
  )
}

/** 由会话态钩子转换出的普通匹配器，保留可选技能根目录以便执行阶段恢复上下文。 */
export type SessionDerivedHookMatcher = {
  /** 事件匹配字符串。 */
  matcher: string
  /** 可持久化钩子列表；函数型钩子不会出现在这里。 */
  hooks: HookCommand[]
  /** 可选技能根目录。 */
  skillRoot?: string
}

/**
 * 把会话内部匹配器转成普通钩子匹配器。
 *
 * @param sessionMatchers 会话内部匹配器列表。
 * @returns 可交给普通钩子执行路径使用的匹配器列表。
 */
function convertToHookMatchers(
  sessionMatchers: SessionHookMatcher[],
): SessionDerivedHookMatcher[] {
  // 1. 保留匹配器和技能根目录，只转换可持久化的命令型钩子。
  return sessionMatchers.map(sm => ({
    matcher: sm.matcher,
    skillRoot: sm.skillRoot,
    // 2. 函数型钩子带闭包回调，不能进入普通钩子匹配器格式。
    hooks: sm.hooks
      .map(h => h.hook)
      .filter((h): h is HookCommand => h.type !== 'function'),
  }))
}

/**
 * 获取会话中注册的普通钩子。
 *
 * @param appState 当前应用状态。
 * @param sessionId 会话 ID。
 * @param event 可选事件名；传入时只返回该事件的钩子。
 * @returns 事件到普通钩子匹配器的映射。
 */
export function getSessionHooks(
  appState: AppState,
  sessionId: string,
  event?: HookEvent,
): Map<HookEvent, SessionDerivedHookMatcher[]> {
  // 1. 没有会话存储区时返回空映射表。
  const store = appState.sessionHooks.get(sessionId)
  if (!store) {
    return new Map()
  }

  // 2. 结果统一使用映射表，和调用方合并逻辑保持一致。
  const result = new Map<HookEvent, SessionDerivedHookMatcher[]>()

  // 3. 指定事件时只转换该事件，减少不必要遍历。
  if (event) {
    const sessionMatchers = store.hooks[event]
    if (sessionMatchers) {
      result.set(event, convertToHookMatchers(sessionMatchers))
    }
    return result
  }

  // 4. 未指定事件时按已知钩子事件枚举输出所有普通钩子。
  for (const evt of HOOK_EVENTS) {
    const sessionMatchers = store.hooks[evt]
    if (sessionMatchers) {
      result.set(evt, convertToHookMatchers(sessionMatchers))
    }
  }

  // 5. 返回普通钩子视图；函数型钩子由专门函数读取。
  return result
}

/** 函数型钩子专用匹配器，不能和普通命令型钩子匹配器混用。 */
type FunctionHookMatcher = {
  /** 事件匹配字符串。 */
  matcher: string
  /** 该匹配器下的函数型钩子列表。 */
  hooks: FunctionHook[]
}

/**
 * 获取会话中注册的函数型钩子。
 *
 * @param appState 当前应用状态。
 * @param sessionId 会话 ID。
 * @param event 可选事件名；传入时只返回该事件的函数型钩子。
 * @returns 事件到函数型钩子匹配器的映射。
 */
export function getSessionFunctionHooks(
  appState: AppState,
  sessionId: string,
  event?: HookEvent,
): Map<HookEvent, FunctionHookMatcher[]> {
  // 1. 没有会话存储区时返回空映射表。
  const store = appState.sessionHooks.get(sessionId)
  if (!store) {
    return new Map()
  }

  // 2. 函数型钩子独立返回，避免普通钩子执行路径尝试序列化闭包。
  const result = new Map<HookEvent, FunctionHookMatcher[]>()

  /**
   * 从会话匹配器中提取函数型钩子。
   *
   * @param sessionMatchers 会话内部匹配器列表。
   * @returns 只包含函数型钩子的匹配器列表。
   */
  const extractFunctionHooks = (
    sessionMatchers: SessionHookMatcher[],
  ): FunctionHookMatcher[] => {
    // 1. 保留匹配器字符串，只筛选类型为函数的钩子。
    return sessionMatchers
      .map(sm => ({
        matcher: sm.matcher,
        hooks: sm.hooks
          .map(h => h.hook)
          .filter((h): h is FunctionHook => h.type === 'function'),
      }))
      // 2. 删除没有函数型钩子的匹配器，减少执行阶段空循环。
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

  // 4. 未指定事件时遍历全部钩子事件并提取函数型钩子。
  for (const evt of HOOK_EVENTS) {
    const sessionMatchers = store.hooks[evt]
    if (sessionMatchers) {
      const functionMatchers = extractFunctionHooks(sessionMatchers)
      if (functionMatchers.length > 0) {
        result.set(evt, functionMatchers)
      }
    }
  }

  // 5. 返回函数型钩子专用视图。
  return result
}

/**
 * 查找会话钩子的完整注册项。
 *
 * @param appState 当前应用状态。
 * @param sessionId 会话 ID。
 * @param event 钩子事件名。
 * @param matcher 当前执行命中的匹配器；空字符串表示允许匹配任意匹配器。
 * @param hook 当前执行的钩子。
 * @returns 找到时返回钩子和成功回调；否则返回 undefined。
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
  // 1. 没有会话存储区时无法查找回调。
  const store = appState.sessionHooks.get(sessionId)
  if (!store) {
    return undefined
  }

  // 2. 没有目标事件时直接返回空。
  const eventMatchers = store.hooks[event]
  if (!eventMatchers) {
    return undefined
  }

  // 3. 在匹配器命中或调用方传空匹配器时，按钩子等价性查找注册项。
  for (const matcherEntry of eventMatchers) {
    if (matcherEntry.matcher === matcher || matcher === '') {
      const hookEntry = matcherEntry.hooks.find(h => isHookEqual(h.hook, hook))
      if (hookEntry) {
        return hookEntry
      }
    }
  }

  // 4. 没有找到对应钩子或成功回调。
  return undefined
}

/**
 * 清空指定会话的所有会话态钩子。
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
    // 1. 直接从映射表删除该会话的钩子存储区。
    prev.sessionHooks.delete(sessionId)
    return prev
  })

  logForDebugging(`Cleared all session hooks for session ${sessionId}`)
}
