import { feature } from 'bun:bundle'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { TASK_OUTPUT_TOOL_NAME } from '../../tools/TaskOutputTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../../tools/TaskStopTool/prompt.js'
import type { PermissionRuleValue } from './PermissionRule.js'

/** 仅在内部特性打开时才解析 Brief 工具名，避免外部分发包包含内部工具字符串。 */
/* eslint-disable @typescript-eslint/no-require-imports */
const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('../../tools/BriefTool/prompt.js') as typeof import('../../tools/BriefTool/prompt.js')
      ).BRIEF_TOOL_NAME
    : null
/* eslint-enable @typescript-eslint/no-require-imports */

/** 旧工具名到当前规范工具名的映射，用于兼容历史权限规则、Hook matcher 和已持久化的 wire name。 */
const LEGACY_TOOL_NAME_ALIASES: Record<string, string> = {
  Task: AGENT_TOOL_NAME,
  KillShell: TASK_STOP_TOOL_NAME,
  AgentOutputTool: TASK_OUTPUT_TOOL_NAME,
  BashOutputTool: TASK_OUTPUT_TOOL_NAME,
  ...((feature('KAIROS') || feature('KAIROS_BRIEF')) && BRIEF_TOOL_NAME
    ? { Brief: BRIEF_TOOL_NAME }
    : {}),
}

/**
 * 把历史工具名归一化为当前规范工具名。
 *
 * @param name 用户配置、Hook 输入或旧会话中出现的工具名。
 * @returns 当前代码路径使用的规范工具名；没有别名时返回原值。
 */
export function normalizeLegacyToolName(name: string): string {
  // 1. 优先查别名表，保证重命名后的工具仍能匹配旧配置。
  return LEGACY_TOOL_NAME_ALIASES[name] ?? name
}

/**
 * 查询某个规范工具名对应的历史别名。
 *
 * @param canonicalName 当前规范工具名。
 * @returns 所有仍需要兼容的旧工具名列表。
 */
export function getLegacyToolNames(canonicalName: string): string[] {
  // 1. 遍历别名表，反向找出指向当前工具名的旧名称。
  const result: string[] = []
  for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_NAME_ALIASES)) {
    if (canonical === canonicalName) result.push(legacy)
  }
  // 2. 返回给 matcher 使用，允许旧规则继续命中新工具。
  return result
}

/**
 * 转义权限规则内容中的结构字符。
 *
 * 权限规则以 `Tool(content)` 存储，因此内容里的括号必须转义；反斜杠也要先转义，避免后续解析时丢失用户原始输入。
 *
 * @param content 规则括号内部的原始内容。
 * @returns 可安全拼接进 `Tool(...)` 的内容字符串。
 */
export function escapeRuleContent(content: string): string {
  // 1. 先转义反斜杠，避免新增的括号转义符被再次处理。
  return content
    .replace(/\\/g, '\\\\')
    // 2. 再转义左右括号，保证它们只作为内容而不是规则边界。
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

/**
 * 还原权限规则内容中的转义字符。
 *
 * @param content 从 `Tool(content)` 中截取出的已转义内容。
 * @returns 用户配置时表达的原始内容。
 */
export function unescapeRuleContent(content: string): string {
  // 1. 先还原括号转义，避免后续处理反斜杠时破坏 `\(` 和 `\)` 的语义。
  return content
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    // 2. 最后还原普通反斜杠。
    .replace(/\\\\/g, '\\')
}

/**
 * 把权限规则字符串解析成工具名和可选规则内容。
 *
 * @param ruleString 用户配置的规则字符串，支持 `Tool` 和 `Tool(content)` 两种形式。
 * @returns 结构化权限规则；格式无法可靠解析时会保守地把整段当作工具名。
 */
export function permissionRuleValueFromString(
  ruleString: string,
): PermissionRuleValue {
  // 1. 查找第一个未转义左括号，它决定工具名和规则内容的分界。
  const openParenIndex = findFirstUnescapedChar(ruleString, '(')
  if (openParenIndex === -1) {
    // 2. 没有括号时表示工具级规则，只需要归一化工具名。
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  // 3. 查找最后一个未转义右括号，用于确认内容边界完整。
  const closeParenIndex = findLastUnescapedChar(ruleString, ')')
  if (closeParenIndex === -1 || closeParenIndex <= openParenIndex) {
    // 4. 括号不成对时不猜测内容，保守回退为工具名字符串。
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  // 5. 右括号后还有内容说明格式混杂，同样按工具名处理以避免误授权。
  if (closeParenIndex !== ruleString.length - 1) {
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  // 6. 截取工具名和括号内部原始内容。
  const toolName = ruleString.substring(0, openParenIndex)
  const rawContent = ruleString.substring(openParenIndex + 1, closeParenIndex)

  // 7. 缺少工具名时不把括号内容当成权限范围，避免形成意外规则。
  if (!toolName) {
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  // 8. 空内容和单独 `*` 表示工具级规则，和只写工具名保持一致。
  if (rawContent === '' || rawContent === '*') {
    return { toolName: normalizeLegacyToolName(toolName) }
  }

  // 9. 还原内容里的转义字符，并返回规范工具名。
  const ruleContent = unescapeRuleContent(rawContent)
  return { toolName: normalizeLegacyToolName(toolName), ruleContent }
}

/**
 * 把结构化权限规则序列化为 settings 中使用的字符串。
 *
 * @param ruleValue 已解析或程序构造出的权限规则。
 * @returns 可写回配置文件的规则字符串。
 */
export function permissionRuleValueToString(
  ruleValue: PermissionRuleValue,
): string {
  // 1. 没有内容时保留最短工具级规则写法。
  if (!ruleValue.ruleContent) {
    return ruleValue.toolName
  }
  // 2. 有内容时先转义结构字符，再拼回 `Tool(content)`。
  const escapedContent = escapeRuleContent(ruleValue.ruleContent)
  return `${ruleValue.toolName}(${escapedContent})`
}

/**
 * 查找字符串中第一个未转义目标字符的位置。
 *
 * @param str 要扫描的字符串。
 * @param char 要查找的单字符目标。
 * @returns 找到时返回下标，否则返回 -1。
 */
function findFirstUnescapedChar(str: string, char: string): number {
  // 1. 从左到右扫描，保证返回的是最早的语法边界。
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) {
      // 2. 统计目标字符左侧连续反斜杠数量。
      let backslashCount = 0
      let j = i - 1
      while (j >= 0 && str[j] === '\\') {
        backslashCount++
        j--
      }
      // 3. 偶数个反斜杠表示目标字符没有被转义。
      if (backslashCount % 2 === 0) {
        return i
      }
    }
  }
  // 4. 没有可作为语法字符的目标字符。
  return -1
}

/**
 * 查找字符串中最后一个未转义目标字符的位置。
 *
 * @param str 要扫描的字符串。
 * @param char 要查找的单字符目标。
 * @returns 找到时返回下标，否则返回 -1。
 */
function findLastUnescapedChar(str: string, char: string): number {
  // 1. 从右到左扫描，适合寻找规则内容的结束边界。
  for (let i = str.length - 1; i >= 0; i--) {
    if (str[i] === char) {
      // 2. 统计目标字符左侧连续反斜杠数量。
      let backslashCount = 0
      let j = i - 1
      while (j >= 0 && str[j] === '\\') {
        backslashCount++
        j--
      }
      // 3. 偶数个反斜杠表示目标字符没有被转义，可以作为语法边界。
      if (backslashCount % 2 === 0) {
        return i
      }
    }
  }
  // 4. 没有找到未转义的目标字符。
  return -1
}
