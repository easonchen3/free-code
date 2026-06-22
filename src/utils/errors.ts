import { APIUserAbortError } from '@anthropic-ai/sdk'

/** 产品内部通用错误基类；构造时把 name 固定为具体子类名，便于日志和 UI 展示。 */
export class ClaudeError extends Error {
  /**
   * 创建 Claude 业务错误。
   *
   * @param message 面向调用方展示或记录的错误消息。
   */
  constructor(message: string) {
    // 1. 先交给 Error 保存 message 和 stack。
    super(message)
    // 2. 再使用实际构造函数名覆盖 name，避免统一显示为 Error。
    this.name = this.constructor.name
  }
}

/** 命令定义或调用格式不合法时抛出的错误。 */
export class MalformedCommandError extends Error {}

/** 本地可识别的取消错误，用于和 DOM AbortError、SDK abort 错误统一判断。 */
export class AbortError extends Error {
  /**
   * 创建取消错误。
   *
   * @param message 可选的取消原因。
   */
  constructor(message?: string) {
    // 1. 保存取消原因。
    super(message)
    // 2. 使用标准 AbortError 名称，方便跨模块按 name 识别。
    this.name = 'AbortError'
  }
}

/**
 * 判断错误是否表示用户或控制器主动取消。
 *
 * @param e 捕获到的未知错误值。
 * @returns true 表示该错误属于取消流程，通常不应按失败上报。
 */
export function isAbortError(e: unknown): boolean {
  // 1. 同时兼容本地 AbortError、SDK APIUserAbortError 和 DOM AbortError。
  return (
    e instanceof AbortError ||
    e instanceof APIUserAbortError ||
    (e instanceof Error && e.name === 'AbortError')
  )
}

/** 配置文件解析失败时携带路径和兜底配置的错误类型。 */
export class ConfigParseError extends Error {
  /** 解析失败的配置文件路径。 */
  filePath: string
  /** 解析失败后建议使用的默认配置。 */
  defaultConfig: unknown

  /**
   * 创建配置解析错误。
   *
   * @param message 解析失败原因。
   * @param filePath 配置文件路径。
   * @param defaultConfig 失败后可使用的默认配置。
   */
  constructor(message: string, filePath: string, defaultConfig: unknown) {
    // 1. 保存基础错误消息。
    super(message)
    // 2. 设置稳定名称，方便上层区分配置错误和普通异常。
    this.name = 'ConfigParseError'
    // 3. 附带配置路径和兜底配置，供恢复逻辑使用。
    this.filePath = filePath
    this.defaultConfig = defaultConfig
  }
}

/** Shell 命令执行失败时的结构化错误，保留 stdout、stderr、退出码和中断状态。 */
export class ShellError extends Error {
  /**
   * 创建 Shell 执行错误。
   *
   * @param stdout 命令标准输出。
   * @param stderr 命令标准错误。
   * @param code 进程退出码。
   * @param interrupted 是否由中断信号导致。
   */
  constructor(
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly code: number,
    public readonly interrupted: boolean,
  ) {
    // 1. 对外使用统一的错误消息，详细内容放在只读字段中。
    super('Shell command failed')
    // 2. 固定错误名，便于调用方 instanceof 之外的展示逻辑识别。
    this.name = 'ShellError'
  }
}

/** Teleport 操作失败时的错误，额外保留已经格式化好的用户可读消息。 */
export class TeleportOperationError extends Error {
  /**
   * 创建 Teleport 操作错误。
   *
   * @param message 原始错误消息。
   * @param formattedMessage 已格式化、可直接展示给用户的消息。
   */
  constructor(
    message: string,
    public readonly formattedMessage: string,
  ) {
    // 1. 原始 message 进入 Error 基类。
    super(message)
    // 2. 使用业务错误名，避免只显示为普通 Error。
    this.name = 'TeleportOperationError'
  }
}

/**
 * 可安全写入遥测的错误。
 *
 * 类名刻意很长，用来提醒调用方：传入 telemetryMessage 前必须确认其中不包含路径、URL、代码片段等敏感内容。
 */
export class TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends Error {
  /** 专门用于遥测的脱敏消息。 */
  readonly telemetryMessage: string

  /**
   * 创建可遥测错误。
   *
   * @param message 完整错误消息，可能用于本地日志或用户提示。
   * @param telemetryMessage 可选的遥测消息；不传时复用 message。
   */
  constructor(message: string, telemetryMessage?: string) {
    // 1. 保存完整错误消息。
    super(message)
    // 2. 使用较短 name，避免日志里重复超长类名。
    this.name = 'TelemetrySafeError'
    // 3. 遥测消息可与用户消息分离，支持本地详细、远端脱敏。
    this.telemetryMessage = telemetryMessage ?? message
  }
}

/**
 * 判断未知错误是否具有指定的精确 message。
 *
 * @param error 捕获到的未知错误值。
 * @param message 需要比较的完整错误消息。
 * @returns true 表示 error 是 Error 且 message 完全一致。
 */
export function hasExactErrorMessage(error: unknown, message: string): boolean {
  // 1. 只对真正的 Error 做精确消息比较。
  return error instanceof Error && error.message === message
}

/**
 * 把未知异常值标准化成 Error 实例。
 *
 * @param e catch 块捕获到的任意值。
 * @returns Error 实例；非 Error 值会用 String 转成 message。
 */
export function toError(e: unknown): Error {
  // 1. 保留原 Error 的 stack 和类型；其他值包装成普通 Error。
  return e instanceof Error ? e : new Error(String(e))
}

/**
 * 从未知异常值中提取可读消息。
 *
 * @param e catch 块捕获到的任意值。
 * @returns Error.message 或 String(e)。
 */
export function errorMessage(e: unknown): string {
  // 1. Error 使用 message，非 Error 仍给出字符串表示。
  return e instanceof Error ? e.message : String(e)
}

/**
 * 读取 Node 文件系统错误的 errno code。
 *
 * @param e 捕获到的未知错误值。
 * @returns 例如 `ENOENT`、`EACCES` 的 code；不存在时返回 undefined。
 */
export function getErrnoCode(e: unknown): string | undefined {
  // 1. 用结构检查替代强制类型断言，避免非对象错误抛出二次异常。
  if (e && typeof e === 'object' && 'code' in e && typeof e.code === 'string') {
    return e.code
  }
  // 2. 没有标准 code 字段时返回 undefined。
  return undefined
}

/**
 * 判断错误是否表示路径不存在。
 *
 * @param e 捕获到的未知错误值。
 * @returns true 表示 errno code 为 `ENOENT`。
 */
export function isENOENT(e: unknown): boolean {
  // 1. 复用 errno 提取逻辑，集中处理未知错误形状。
  return getErrnoCode(e) === 'ENOENT'
}

/**
 * 读取 Node 文件系统错误中关联的路径。
 *
 * @param e 捕获到的未知错误值。
 * @returns 错误对象里的 path 字段；不存在时返回 undefined。
 */
export function getErrnoPath(e: unknown): string | undefined {
  // 1. 只有对象且 path 为字符串时才返回，避免误读任意字段。
  if (e && typeof e === 'object' && 'path' in e && typeof e.path === 'string') {
    return e.path
  }
  // 2. 非文件系统错误通常没有路径。
  return undefined
}

/**
 * 提取错误消息和前几层 stack frame。
 *
 * @param e 捕获到的未知错误值。
 * @param maxFrames 最多保留的 stack frame 数量，默认 5。
 * @returns 精简后的错误堆栈文本。
 */
export function shortErrorStack(e: unknown, maxFrames = 5): string {
  // 1. 非 Error 没有 stack，只能返回字符串化结果。
  if (!(e instanceof Error)) return String(e)
  // 2. 没有 stack 时至少返回 message。
  if (!e.stack) return e.message
  // 3. V8/Bun stack 首行是错误摘要，后续 `at` 行才是调用帧。
  const lines = e.stack.split('\n')
  const header = lines[0] ?? e.message
  const frames = lines.slice(1).filter(l => l.trim().startsWith('at '))
  // 4. 帧数不多时保留原 stack，避免丢失有用信息。
  if (frames.length <= maxFrames) return e.stack
  // 5. 帧数过多时截断，减少塞进模型上下文的内部噪音。
  return [header, ...frames.slice(0, maxFrames)].join('\n')
}

/**
 * 判断文件系统错误是否属于“路径不可访问”的预期类别。
 *
 * @param e 捕获到的未知错误值。
 * @returns true 表示路径不存在、权限不足、路径结构错误或符号链接循环。
 */
export function isFsInaccessible(e: unknown): e is NodeJS.ErrnoException {
  // 1. 先提取 errno code，再按文件访问场景的可预期错误集合判断。
  const code = getErrnoCode(e)
  return (
    code === 'ENOENT' ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'ENOTDIR' ||
    code === 'ELOOP'
  )
}

/** Axios 请求错误的粗粒度分类，用于决定重试、跳过或展示策略。 */
export type AxiosErrorKind =
  | 'auth'
  | 'timeout'
  | 'network'
  | 'http'
  | 'other'

/**
 * 将 Axios 请求异常归类。
 *
 * @param e 捕获到的未知错误值。
 * @returns 错误类别、可选 HTTP 状态码和可读消息。
 */
export function classifyAxiosError(e: unknown): {
  kind: AxiosErrorKind
  status?: number
  message: string
} {
  // 1. 先提取通用消息，非 Axios 错误也能返回可展示文本。
  const message = errorMessage(e)
  // 2. 通过 Axios 标记字段识别请求错误，避免引入 axios 依赖。
  if (
    !e ||
    typeof e !== 'object' ||
    !('isAxiosError' in e) ||
    !e.isAxiosError
  ) {
    return { kind: 'other', message }
  }
  // 3. 只读取分类所需字段，不依赖完整 Axios 类型。
  const err = e as {
    response?: { status?: number }
    code?: string
  }
  const status = err.response?.status
  // 4. 认证错误通常不应盲目重试。
  if (status === 401 || status === 403) return { kind: 'auth', status, message }
  // 5. 超时和连接类错误单独分类，便于上层选择退避或离线提示。
  if (err.code === 'ECONNABORTED') return { kind: 'timeout', status, message }
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    return { kind: 'network', status, message }
  }
  // 6. 其他 Axios 错误保留为普通 HTTP 类别。
  return { kind: 'http', status, message }
}
