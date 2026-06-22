/** 顺序执行队列中的单次调用记录，保存参数、Promise 回调和调用时的 this。 */
type QueueItem<T extends unknown[], R> = {
  /** 调用原函数时传入的参数。 */
  args: T
  /** 原函数成功后用于兑现外层 Promise。 */
  resolve: (value: R) => void
  /** 原函数失败后用于拒绝外层 Promise。 */
  reject: (reason?: unknown) => void
  /** 调用包装函数时的 this，用于保持方法调用语义。 */
  context: unknown
}

/**
 * 把异步函数包装成按调用顺序串行执行的函数。
 *
 * 适用于文件写入、状态持久化、数据库更新等不能并发交错的操作；调用方仍会拿到各自调用对应的返回值或异常。
 *
 * @param fn 需要串行化的异步函数。
 * @returns 包装后的函数；并发调用会排队，按进入队列的顺序逐个执行。
 */
export function sequential<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
  /** 等待执行的调用队列，先进先出。 */
  const queue: QueueItem<T, R>[] = []
  /** 当前是否已有执行循环在消费队列。 */
  let processing = false

  /**
   * 消费队列中的待执行任务。
   *
   * @returns 队列本轮消费完成后 resolved 的 Promise。
   */
  async function processQueue(): Promise<void> {
    // 1. 已有消费者运行时直接返回，避免多个循环并发取队列。
    if (processing) return
    // 2. 队列为空时无需启动执行循环。
    if (queue.length === 0) return

    // 3. 标记执行中，后续新调用只入队不另起消费者。
    processing = true

    // 4. 按 FIFO 顺序逐个执行原函数，并把结果转发给对应 Promise。
    while (queue.length > 0) {
      const { args, resolve, reject, context } = queue.shift()!

      try {
        const result = await fn.apply(context, args)
        resolve(result)
      } catch (error) {
        reject(error)
      }
    }

    // 5. 本轮队列清空后释放执行标记。
    processing = false

    // 6. 处理释放标记和退出之间进入的新任务，确保不会滞留在队列里。
    if (queue.length > 0) {
      void processQueue()
    }
  }

  return function (this: unknown, ...args: T): Promise<R> {
    // 1. 每次调用都创建独立 Promise，并把兑现/拒绝回调放入队列。
    return new Promise((resolve, reject) => {
      // 2. 保存 this 和参数，保证包装后仍能作为对象方法使用。
      queue.push({ args, resolve, reject, context: this })
      // 3. 尝试启动队列消费；如果已有消费者，processQueue 会自行跳过。
      void processQueue()
    })
  }
}
