/**
 * 权限规则中各类工具的内容校验配置。
 *
 * 大多数工具只需要通用格式校验；只有当工具的规则内容有特殊语义时，才需要在这里补充分类或自定义校验。
 */

/** 权限规则校验器使用的工具分类和自定义校验函数集合。 */
export type ToolValidationConfig = {
  /** 接收文件 glob 模式的工具，例如 `*.ts`、`src/**`。 */
  filePatternTools: string[]

  /** 接收 Bash 命令通配模式的工具，支持任意位置 `*` 和历史 `:*` 前缀语法。 */
  bashPrefixTools: string[]

  /** 按工具名注册的内容校验函数，用于表达 WebFetch 这类工具的专属规则。 */
  customValidation: {
    [toolName: string]: (content: string) => {
      valid: boolean
      error?: string
      suggestion?: string
      examples?: string[]
    }
  }
}

/** 内置工具权限规则内容的分类配置和专属校验入口。 */
export const TOOL_VALIDATION_CONFIG: ToolValidationConfig = {
  // 1. 这些工具的规则内容按文件路径或 glob 解释。
  filePatternTools: [
    'Read',
    'Write',
    'Edit',
    'Glob',
    'NotebookRead',
    'NotebookEdit',
  ],

  // 2. Bash 的规则内容按命令模式解释，兼容旧的 `command:*` 写法。
  bashPrefixTools: ['Bash'],

  // 3. 只有内容语义无法靠通用分类表达时，才在这里补工具专属校验。
  customValidation: {
    /**
     * 校验 WebSearch 的搜索词权限规则。
     *
     * @param content WebSearch 括号中的搜索词。
     * @returns 校验结果；WebSearch 不支持通配符，因此包含 `*` 或 `?` 时返回错误。
     */
    WebSearch: content => {
      // 1. WebSearch 权限按搜索词精确匹配，不支持 glob 或 shell 风格通配符。
      if (content.includes('*') || content.includes('?')) {
        return {
          valid: false,
          error: 'WebSearch does not support wildcards',
          suggestion: 'Use exact search terms without * or ?',
          examples: ['WebSearch(claude ai)', 'WebSearch(typescript tutorial)'],
        }
      }
      // 2. 没有通配符时交给上层继续接受该规则。
      return { valid: true }
    },

    /**
     * 校验 WebFetch 的域名权限规则。
     *
     * @param content WebFetch 括号中的域名规则。
     * @returns 校验结果；合法内容必须使用 `domain:` 前缀。
     */
    WebFetch: content => {
      // 1. WebFetch 权限只接受域名模式，不能直接写 URL。
      if (content.includes('://') || content.startsWith('http')) {
        return {
          valid: false,
          error: 'WebFetch permissions use domain format, not URLs',
          suggestion: 'Use "domain:hostname" format',
          examples: [
            'WebFetch(domain:example.com)',
            'WebFetch(domain:github.com)',
          ],
        }
      }

      // 2. 没有 `domain:` 前缀时无法判断用户是域名、路径还是搜索词。
      if (!content.startsWith('domain:')) {
        return {
          valid: false,
          error: 'WebFetch permissions must use "domain:" prefix',
          suggestion: 'Use "domain:hostname" format',
          examples: [
            'WebFetch(domain:example.com)',
            'WebFetch(domain:*.google.com)',
          ],
        }
      }

      // 3. 域名内部允许通配符，例如 `domain:*.example.com`。
      return { valid: true }
    },
  },
}

/**
 * 判断工具的权限规则内容是否应按文件 glob 解释。
 *
 * @param toolName 工具名。
 * @returns true 表示该工具使用文件模式校验。
 */
export function isFilePatternTool(toolName: string): boolean {
  // 1. 工具分类集中放在配置表中，查询函数只负责读表。
  return TOOL_VALIDATION_CONFIG.filePatternTools.includes(toolName)
}

/**
 * 判断工具的权限规则内容是否应按 Bash 命令模式解释。
 *
 * @param toolName 工具名。
 * @returns true 表示该工具支持 Bash 通配和历史前缀语法。
 */
export function isBashPrefixTool(toolName: string): boolean {
  // 1. Bash 类工具单独分类，避免把命令模式误套到文件路径上。
  return TOOL_VALIDATION_CONFIG.bashPrefixTools.includes(toolName)
}

/**
 * 获取指定工具的专属内容校验函数。
 *
 * @param toolName 工具名。
 * @returns 找到时返回校验函数；没有专属规则时返回 undefined。
 */
export function getCustomValidation(toolName: string) {
  // 1. 上层会在存在专属校验时优先调用，缺省工具继续走通用逻辑。
  return TOOL_VALIDATION_CONFIG.customValidation[toolName]
}
