import { resetSdkInitState } from '../../bootstrap/state.js'
import { isRestrictedToPluginOnly } from '../settings/pluginOnlyPolicy.js'
/** 使用模块对象导入，方便测试通过替换函数的方式模拟配置读取结果。 */
import * as settingsModule from '../settings/settings.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import type { HooksSettings } from '../settings/types.js'

/** 启动后捕获的钩子配置快照；为 null 表示尚未初始化。 */
let initialHooksConfig: HooksSettings | null = null

/**
 * 按当前策略读取允许执行的钩子配置。
 *
 * @returns 经过托管策略、插件专用策略和禁用开关过滤后的钩子配置。
 */
function getHooksFromAllowedSources(): HooksSettings {
  // 1. 先读取企业托管配置，因为它拥有最高优先级。
  const policySettings = settingsModule.getSettingsForSource('policySettings')

  // 2. 托管配置显式禁用钩子时，所有来源都必须关闭。
  if (policySettings?.disableAllHooks === true) {
    return {}
  }

  // 3. 托管配置要求只运行托管钩子时，忽略用户、项目和本地配置。
  if (policySettings?.allowManagedHooksOnly === true) {
    return policySettings.hooks ?? {}
  }

  // 4. 插件专用策略会屏蔽配置文件中的非托管钩子，但不影响插件注册通道。
  if (isRestrictedToPluginOnly('hooks')) {
    return policySettings?.hooks ?? {}
  }

  // 5. 默认读取合并后的配置，保持历史兼容行为。
  const mergedSettings = settingsModule.getSettings_DEPRECATED()

  // 6. 非托管配置只能禁用非托管钩子，不能覆盖企业托管钩子。
  if (mergedSettings.disableAllHooks === true) {
    return policySettings?.hooks ?? {}
  }

  // 7. 没有特殊策略时返回所有来源合并后的钩子。
  return mergedSettings.hooks ?? {}
}

/**
 * 判断当前是否只允许托管钩子执行。
 *
 * @returns true 表示用户、项目、本地等非托管钩子都应被跳过。
 */
export function shouldAllowManagedHooksOnly(): boolean {
  // 1. 企业策略直接声明只允许托管钩子时立即生效。
  const policySettings = settingsModule.getSettingsForSource('policySettings')
  if (policySettings?.allowManagedHooksOnly === true) {
    return true
  }
  // 2. 非托管禁用开关只能关掉非托管钩子，因此等价于只允许托管钩子。
  if (
    settingsModule.getSettings_DEPRECATED().disableAllHooks === true &&
    policySettings?.disableAllHooks !== true
  ) {
    return true
  }
  // 3. 其他情况允许合并来源中的钩子正常参与。
  return false
}

/**
 * 判断是否禁用所有钩子，包括企业托管钩子。
 *
 * @returns true 表示托管策略显式设置了 `disableAllHooks`。
 */
export function shouldDisableAllHooksIncludingManaged(): boolean {
  // 1. 只有策略配置可以关闭全部钩子；非托管来源无权关闭托管钩子。
  return (
    settingsModule.getSettingsForSource('policySettings')?.disableAllHooks ===
    true
  )
}

/**
 * 捕获当前钩子配置快照。
 *
 * @returns 无返回值；结果写入模块级快照变量。
 */
export function captureHooksConfigSnapshot(): void {
  // 1. 按策略读取可执行钩子，并固定为后续查询使用的快照。
  initialHooksConfig = getHooksFromAllowedSources()
}

/**
 * 刷新钩子配置快照。
 *
 * @returns 无返回值；会清理配置缓存后重新读取钩子配置。
 */
export function updateHooksConfigSnapshot(): void {
  // 1. 先清理配置缓存，避免外部编辑配置文件后仍读取旧值。
  resetSettingsCache()
  // 2. 重新按策略捕获快照。
  initialHooksConfig = getHooksFromAllowedSources()
}

/**
 * 获取当前钩子配置快照。
 *
 * @returns 钩子配置快照；首次调用会懒初始化。
 */
export function getHooksConfigFromSnapshot(): HooksSettings | null {
  // 1. 如果启动流程尚未显式捕获，则在读取时补一次快照。
  if (initialHooksConfig === null) {
    captureHooksConfigSnapshot()
  }
  // 2. 返回模块级快照，避免调用方反复访问配置层。
  return initialHooksConfig
}

/**
 * 重置钩子配置快照。
 *
 * @returns 无返回值；主要用于测试或重新初始化流程。
 */
export function resetHooksConfigSnapshot(): void {
  // 1. 清空快照，让下一次读取重新捕获。
  initialHooksConfig = null
  // 2. 同时重置 SDK 初始化状态，避免测试之间共享钩子初始化副作用。
  resetSdkInitState()
}
