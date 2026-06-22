/** 会话对外暴露的运行状态。 */
export type SessionState = 'idle' | 'running' | 'requires_action'

/** 会话进入需要用户处理状态时携带的阻塞详情。 */
export type RequiresActionDetails = {
  /** 触发阻塞的工具名。 */
  tool_name: string
  /** 面向用户展示的动作摘要，例如正在编辑文件或正在运行命令。 */
  action_description: string
  /** 工具调用 ID，用于和事件流中的 tool_use 对齐。 */
  tool_use_id: string
  /** 请求 ID，用于和远端协议或通知链路关联。 */
  request_id: string
  /** 原始工具输入；前端可据此解析问题选项、计划内容等结构化信息。 */
  input?: Record<string, unknown>
}

import { isEnvTruthy } from './envUtils.js'
import type { PermissionMode } from './permissions/PermissionMode.js'
import { enqueueSdkEvent } from './sdkEventQueue.js'

/** 写入 CCR external_metadata 的会话附加信息。 */
export type SessionExternalMetadata = {
  /** 当前权限模式。 */
  permission_mode?: string | null
  /** 是否处于 ultraplan 模式。 */
  is_ultraplan_mode?: boolean | null
  /** 当前模型标识。 */
  model?: string | null
  /** 当前阻塞动作；null 表示清除阻塞信息。 */
  pending_action?: RequiresActionDetails | null
  /** 回合结束后的摘要，保持 unknown 以避免向 SDK d.ts 泄漏内部类型路径。 */
  post_turn_summary?: unknown
  /** 长回合中途的任务进度摘要，通常由 forked-agent summarizer 周期性写入。 */
  task_summary?: string | null
}

/** 会话状态变更监听器。 */
type SessionStateChangedListener = (
  state: SessionState,
  details?: RequiresActionDetails,
) => void
/** 会话外部元数据变更监听器。 */
type SessionMetadataChangedListener = (
  metadata: SessionExternalMetadata,
) => void
/** 权限模式变更监听器。 */
type PermissionModeChangedListener = (mode: PermissionMode) => void

/** 当前注册的会话状态监听器。 */
let stateListener: SessionStateChangedListener | null = null
/** 当前注册的元数据监听器。 */
let metadataListener: SessionMetadataChangedListener | null = null
/** 当前注册的权限模式监听器。 */
let permissionModeListener: PermissionModeChangedListener | null = null

/**
 * 注册或清除会话状态变更监听器。
 *
 * @param cb 新监听器；传 null 表示清除监听器。
 * @returns 无返回值。
 */
export function setSessionStateChangedListener(
  cb: SessionStateChangedListener | null,
): void {
  // 1. 监听器只有一个，后注册者覆盖旧注册者。
  stateListener = cb
}

/**
 * 注册或清除会话元数据变更监听器。
 *
 * @param cb 新监听器；传 null 表示清除监听器。
 * @returns 无返回值。
 */
export function setSessionMetadataChangedListener(
  cb: SessionMetadataChangedListener | null,
): void {
  // 1. CCR 或其他外部桥接层通过该回调接收 metadata patch。
  metadataListener = cb
}

/**
 * 注册或清除权限模式变更监听器。
 *
 * @param cb 新监听器；传 null 表示清除监听器。
 * @returns 无返回值。
 */
export function setPermissionModeChangedListener(
  cb: PermissionModeChangedListener | null,
): void {
  // 1. 权限模式所有变更路径最终汇聚到该监听器，避免某个入口漏发状态。
  permissionModeListener = cb
}

/** 是否已经向 external_metadata 写入 pending_action。 */
let hasPendingAction = false
/** 当前会话状态，默认空闲。 */
let currentState: SessionState = 'idle'

/**
 * 获取当前会话状态。
 *
 * @returns 当前记录的会话状态。
 */
export function getSessionState(): SessionState {
  // 1. 返回模块内的最新状态快照。
  return currentState
}

/**
 * 通知会话状态变化，并同步相关外部元数据。
 *
 * @param state 新会话状态。
 * @param details 进入 `requires_action` 时的阻塞详情。
 * @returns 无返回值。
 */
export function notifySessionStateChanged(
  state: SessionState,
  details?: RequiresActionDetails,
): void {
  // 1. 更新本地状态并通知状态监听器。
  currentState = state
  stateListener?.(state, details)

  // 2. 进入阻塞态时，把阻塞详情镜像到 external_metadata，便于查询型客户端读取。
  if (state === 'requires_action' && details) {
    hasPendingAction = true
    metadataListener?.({
      pending_action: details,
    })
  } else if (hasPendingAction) {
    // 3. 离开阻塞态时使用 null patch 清除远端 pending_action。
    hasPendingAction = false
    metadataListener?.({ pending_action: null })
  }

  // 4. 回到 idle 时清理中途任务摘要，避免下一回合短暂显示旧进度。
  if (state === 'idle') {
    metadataListener?.({ task_summary: null })
  }

  // 5. SDK 状态事件默认关闭；开启后把 authoritative 状态同步给非 CCR 客户端。
  if (isEnvTruthy(process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS)) {
    enqueueSdkEvent({
      type: 'system',
      subtype: 'session_state_changed',
      state,
    })
  }
}

/**
 * 通知会话外部元数据变化。
 *
 * @param metadata 要合并到 external_metadata 的局部对象。
 * @returns 无返回值。
 */
export function notifySessionMetadataChanged(
  metadata: SessionExternalMetadata,
): void {
  // 1. 元数据更新只通过监听器转发，具体持久化由桥接层决定。
  metadataListener?.(metadata)
}

/**
 * 通知权限模式变化。
 *
 * @param mode 新的权限模式。
 * @returns 无返回值。
 */
export function notifyPermissionModeChanged(mode: PermissionMode): void {
  // 1. 下游会把该变化同步到 CCR external_metadata 和 SDK status stream。
  permissionModeListener?.(mode)
}
