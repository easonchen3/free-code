import { z } from 'zod/v4'
import { mcpInfoFromString } from '../../services/mcp/mcpStringUtils.js'
import { lazySchema } from '../lazySchema.js'
import { permissionRuleValueFromString } from '../permissions/permissionRuleParser.js'
import { capitalize } from '../stringUtils.js'
import {
  getCustomValidation,
  isBashPrefixTool,
  isFilePatternTool,
} from './toolValidationConfig.js'

/**
 * 判断指定位置的字符是否处在转义状态。
 *
 * @param str 要检查的完整字符串。
 * @param index 目标字符在字符串中的下标。
 * @returns true 表示目标字符前面存在奇数个连续反斜杠，因此该字符被转义。
 */
function isEscaped(str: string, index: number): boolean {
  // 1. 从目标字符左侧开始，统计连续反斜杠数量。
  let backslashCount = 0
  let j = index - 1
  while (j >= 0 && str[j] === '\\') {
    backslashCount++
    j--
  }
  // 2. 奇数个反斜杠表示最后一个反斜杠作用在当前字符上。
  return backslashCount % 2 !== 0
}

/**
 * 统计字符串中未被转义的指定字符数量。
 *
 * @param str 要扫描的字符串。
 * @param char 要统计的单字符目标。
 * @returns 未被反斜杠转义的目标字符出现次数。
 */
function countUnescapedChar(str: string, char: string): number {
  // 1. 逐字符扫描，只有字符相同且不处于转义状态时才计数。
  let count = 0
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char && !isEscaped(str, i)) {
      count++
    }
  }
  // 2. 返回可参与语法判断的真实字符数量。
  return count
}

/**
 * 检查权限规则中是否存在未转义的空括号。
 *
 * @param str 原始权限规则字符串。
 * @returns true 表示出现了语义上为空的 `()`，通常说明用户想写模式但漏写了内容。
 */
function hasUnescapedEmptyParens(str: string): boolean {
  // 1. 只检查相邻的左右括号，避免把跨内容的括号误判为空括号。
  for (let i = 0; i < str.length - 1; i++) {
    if (str[i] === '(' && str[i + 1] === ')') {
      // 2. 左括号未被转义时，这组括号才属于规则语法。
      if (!isEscaped(str, i)) {
        return true
      }
    }
  }
  // 3. 没有发现语法层面的空括号。
  return false
}

/**
 * 校验单条权限规则的格式和工具专属内容。
 *
 * @param rule 用户配置的权限规则，例如 `Bash(git *)` 或 `Read(src/**)`。
 * @returns 校验结果；失败时包含错误原因、修复建议和示例。
 */
export function validatePermissionRule(rule: string): {
  valid: boolean
  error?: string
  suggestion?: string
  examples?: string[]
} {
  // 1. 空字符串无法表达任何工具或匹配范围，直接返回配置错误。
  if (!rule || rule.trim() === '') {
    return { valid: false, error: 'Permission rule cannot be empty' }
  }

  // 2. 先做括号配对检查，避免后续解析把明显不完整的规则当成工具名。
  const openCount = countUnescapedChar(rule, '(')
  const closeCount = countUnescapedChar(rule, ')')
  if (openCount !== closeCount) {
    return {
      valid: false,
      error: 'Mismatched parentheses',
      suggestion:
        'Ensure all opening parentheses have matching closing parentheses',
    }
  }

  // 3. 空括号通常是用户误以为 `Tool()` 等价于全量权限，需要给出明确修复方式。
  if (hasUnescapedEmptyParens(rule)) {
    const toolName = rule.substring(0, rule.indexOf('('))
    if (!toolName) {
      return {
        valid: false,
        error: 'Empty parentheses with no tool name',
        suggestion: 'Specify a tool name before the parentheses',
      }
    }
    return {
      valid: false,
      error: 'Empty parentheses',
      suggestion: `Either specify a pattern or use just "${toolName}" without parentheses`,
      examples: [`${toolName}`, `${toolName}(some-pattern)`],
    }
  }

  // 4. 将字符串拆成工具名和可选规则内容；解析器会处理旧工具名和转义括号。
  const parsed = permissionRuleValueFromString(rule)

  // 5. MCP 工具名不是普通内置工具名，必须先按 MCP 的服务名/工具名结构校验。
  const mcpInfo = mcpInfoFromString(parsed.toolName)
  if (mcpInfo) {
    // 6. MCP 权限只支持服务、通配工具或具体工具三种粒度，不支持括号模式。
    if (parsed.ruleContent !== undefined || countUnescapedChar(rule, '(') > 0) {
      return {
        valid: false,
        error: 'MCP rules do not support patterns in parentheses',
        suggestion: `Use "${parsed.toolName}" without parentheses, or use "mcp__${mcpInfo.serverName}__*" for all tools`,
        examples: [
          `mcp__${mcpInfo.serverName}`,
          `mcp__${mcpInfo.serverName}__*`,
          mcpInfo.toolName && mcpInfo.toolName !== '*'
            ? `mcp__${mcpInfo.serverName}__${mcpInfo.toolName}`
            : undefined,
        ].filter(Boolean) as string[],
      }
    }

    // 7. MCP 工具名结构有效且没有额外模式，规则可接受。
    return { valid: true }
  }

  // 8. 非 MCP 规则必须至少包含工具名。
  if (!parsed.toolName || parsed.toolName.length === 0) {
    return { valid: false, error: 'Tool name cannot be empty' }
  }

  // 9. 内置工具名按约定首字母大写，提前提示大小写错误。
  if (parsed.toolName[0] !== parsed.toolName[0]?.toUpperCase()) {
    return {
      valid: false,
      error: 'Tool names must start with uppercase',
      suggestion: `Use "${capitalize(String(parsed.toolName))}"`,
    }
  }

  // 10. 优先执行工具自己的语义校验，例如网页抓取工具的域名前缀规则。
  const customValidation = getCustomValidation(parsed.toolName)
  if (customValidation && parsed.ruleContent !== undefined) {
    const customResult = customValidation(parsed.ruleContent)
    if (!customResult.valid) {
      return customResult
    }
  }

  // 11. 命令行规则同时支持新通配语法和旧 `:*` 前缀语法，需要拦截常见误写。
  if (isBashPrefixTool(parsed.toolName) && parsed.ruleContent !== undefined) {
    const content = parsed.ruleContent

    // 12. 旧前缀语法只能放在末尾，否则匹配语义会变得不明确。
    if (content.includes(':*') && !content.endsWith(':*')) {
      return {
        valid: false,
        error: 'The :* pattern must be at the end',
        suggestion:
          'Move :* to the end for prefix matching, or use * for wildcard matching',
        examples: [
          'Bash(npm run:*) - prefix matching (legacy)',
          'Bash(npm run *) - wildcard matching',
        ],
      }
    }

    // 13. `:*` 前面没有命令前缀时无法形成有效匹配范围。
    if (content === ':*') {
      return {
        valid: false,
        error: 'Prefix cannot be empty before :*',
        suggestion: 'Specify a command prefix before :*',
        examples: ['Bash(npm:*)', 'Bash(git:*)'],
      }
    }

    // 14. 不校验命令行引号配对；合法写法很多，过度校验会误伤有效命令。
  }

  // 15. 文件类工具使用通配路径思维，和命令行的命令前缀匹配需要分开提示。
  if (isFilePatternTool(parsed.toolName) && parsed.ruleContent !== undefined) {
    const content = parsed.ruleContent

    // 16. 文件路径不支持命令行的 `:*` 前缀语法，应提示改用通配路径。
    if (content.includes(':*')) {
      return {
        valid: false,
        error: 'The ":*" syntax is only for Bash prefix rules',
        suggestion: 'Use glob patterns like "*" or "**" for file matching',
        examples: [
          `${parsed.toolName}(*.ts) - matches .ts files`,
          `${parsed.toolName}(src/**) - matches all files in src`,
          `${parsed.toolName}(**/*.test.ts) - matches test files`,
        ],
      }
    }

    // 17. 路径通配符放在单词中间通常是误用，给出更符合通配路径直觉的例子。
    if (
      content.includes('*') &&
      !content.match(/^\*|\*$|\*\*|\/\*|\*\.|\*\)/) &&
      !content.includes('**')
    ) {
      return {
        valid: false,
        error: 'Wildcard placement might be incorrect',
        suggestion: 'Wildcards are typically used at path boundaries',
        examples: [
          `${parsed.toolName}(*.js) - all .js files`,
          `${parsed.toolName}(src/*) - all files directly in src`,
          `${parsed.toolName}(src/**) - all files recursively in src`,
        ],
      }
    }
  }

  // 18. 所有通用和工具专属校验都通过，规则可写入配置。
  return { valid: true }
}

/**
 * 权限规则字符串的结构化校验器。
 *
 * @returns 可复用的校验结构；校验失败时会把建议和示例合并进校验问题。
 */
export const PermissionRuleSchema = lazySchema(() =>
  z.string().superRefine((val, ctx) => {
    // 1. 复用业务校验，保证配置解析和手动调用得到一致结果。
    const result = validatePermissionRule(val)
    if (!result.valid) {
      // 2. 将错误、建议和示例拼成一条面向用户的配置错误信息。
      let message = result.error!
      if (result.suggestion) {
        message += `. ${result.suggestion}`
      }
      if (result.examples && result.examples.length > 0) {
        message += `. Examples: ${result.examples.join(', ')}`
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message,
        params: { received: val },
      })
    }
    // 3. 校验通过时不添加问题，交给结构化校验器返回原始字符串。
  }),
)
