import { resetSdkInitState } from '../../bootstrap/state.js'
import { isRestrictedToPluginOnly } from '../settings/pluginOnlyPolicy.js'
/** 使用模块对象导入，方便测试通过 spyOn 替换 settings 读取函数。 */
import * as settingsModule from '../settings/settings.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import type { HooksSettings } from '../settings/types.js'

/** 启动后捕获的 Hook 配置快照；为 null 表示尚未初始化。 */
let initialHooksConfig: HooksSettings | null = null

/**
 * 按当前策略读取允许执行的 Hook 配置。
 *
 * @returns 经过托管策略、插件专用策略和禁用开关过滤后的 Hook 配置。
 */
function getHooksFromAllowedSources(): HooksSettings {
  // 1. 先读取企业托管配置，因为它拥有最高优先级。
  const policySettings = settingsModule.getSettingsForSource('policySettings')

  // 2. 托管配置显式禁用 Hook 时，所有来源都必须关闭。
  if (policySettings?.disableAllHooks === true) {
    return {}
  }

  // 3. 托管配置要求只运行托管 Hook 时，忽略用户、项目和本地配置。
  if (policySettings?.allowManagedHooksOnly === true) {
    return policySettings.hooks ?? {}
  }

  // 4. 插件专用策略会屏蔽 settings 中的非托管 Hook，但不影响插件注册通道。
  if (isRestrictedToPluginOnly('hooks')) {
    return policySettings?.hooks ?? {}
  }

  // 5. 默认读取合并后的 settings，保持历史兼容行为。
  const mergedSettings = settingsModule.getSettings_DEPRECATED()

  // 6. 非托管配置只能禁用非托管 Hook，不能覆盖企业托管 Hook。
  if (mergedSettings.disableAllHooks === true) {
    return policySettings?.hooks ?? {}
  }

  // 7. 没有特殊策略时返回所有来源合并后的 Hook。
  return mergedSettings.hooks ?? {}
}

/**
 * 判断当前是否只允许托管 Hook 执行。
 *
 * @returns true 表示用户、项目、本地等非托管 Hook 都应被跳过。
 */
export function shouldAllowManagedHooksOnly(): boolean {
  // 1. 企业策略直接声明 managed-only 时立即生效。
  const policySettings = settingsModule.getSettingsForSource('policySettings')
  if (policySettings?.allowManagedHooksOnly === true) {
    return true
  }
  // 2. 非托管 disableAllHooks 只能关掉非托管 Hook，因此等价于 managed-only。
  if (
    settingsModule.getSettings_DEPRECATED().disableAllHooks === true &&
    policySettings?.disableAllHooks !== true
  ) {
    return true
  }
  // 3. 其他情况允许合并来源中的 Hook 正常参与。
  return false
}

/**
 * 判断是否禁用所有 Hook，包括企业托管 Hook。
 *
 * @returns true 表示托管策略显式设置了 `disableAllHooks`。
 */
export function shouldDisableAllHooksIncludingManaged(): boolean {
  // 1. 只有 policySettings 可以关闭全部 Hook；非托管来源无权关闭托管 Hook。
  return (
    settingsModule.getSettingsForSource('policySettings')?.disableAllHooks ===
    true
  )
}

/**
 * 捕获当前 Hook 配置快照。
 *
 * @returns 无返回值；结果写入模块级快照变量。
 */
export function captureHooksConfigSnapshot(): void {
  // 1. 按策略读取可执行 Hook，并固定为后续查询使用的快照。
  initialHooksConfig = getHooksFromAllowedSources()
}

/**
 * 刷新 Hook 配置快照。
 *
 * @returns 无返回值；会清理 settings 缓存后重新读取 Hook 配置。
 */
export function updateHooksConfigSnapshot(): void {
  // 1. 先清理 settings 缓存，避免外部编辑 settings.json 后仍读取旧值。
  resetSettingsCache()
  // 2. 重新按策略捕获快照。
  initialHooksConfig = getHooksFromAllowedSources()
}

/**
 * 获取当前 Hook 配置快照。
 *
 * @returns Hook 配置快照；首次调用会懒初始化。
 */
export function getHooksConfigFromSnapshot(): HooksSettings | null {
  // 1. 如果启动流程尚未显式捕获，则在读取时补一次快照。
  if (initialHooksConfig === null) {
    captureHooksConfigSnapshot()
  }
  // 2. 返回模块级快照，避免调用方反复访问 settings 层。
  return initialHooksConfig
}

/**
 * 重置 Hook 配置快照。
 *
 * @returns 无返回值；主要用于测试或重新初始化流程。
 */
export function resetHooksConfigSnapshot(): void {
  // 1. 清空快照，让下一次读取重新捕获。
  initialHooksConfig = null
  // 2. 同时重置 SDK 初始化状态，避免测试之间共享 Hook 初始化副作用。
  resetSdkInitState()
}
