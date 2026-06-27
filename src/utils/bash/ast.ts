/**
 * 基于 tree-sitter 的 Bash 命令 AST 安全分析模块。
 *
 * 该模块用 tree-sitter-bash 解析命令，并通过显式 AST 节点白名单抽取简单命令。
 * 如果遇到没有明确处理过的节点类型，就把整条命令归类为 `too-complex`，
 * 交给普通权限询问流程，而不是尝试猜测 Bash 的真实行为。
 *
 * 核心设计原则是 fail-closed：只解释自己能证明的结构，不理解的语法一律拒绝自动抽取。
 *
 * 这不是沙箱，不能阻止危险命令运行；它只回答一个问题：
 * “能否为每个简单命令生成可信的 argv[]？”能生成时，下游再做权限规则和 flag 白名单匹配；
 * 不能生成时，必须询问用户或走更保守的权限路径。
 */

import { SHELL_KEYWORDS } from './bashParser.js'
import type { Node } from './parser.js'
import { PARSE_ABORTED, parseCommandRaw } from './parser.js'

/** 重定向信息，表示 Bash 命令中的输入、输出或文件描述符重定向。 */
export type Redirect = {
  /** 规范化后的重定向操作符。 */
  op: '>' | '>>' | '<' | '<<' | '>&' | '>|' | '<&' | '&>' | '&>>' | '<<<'
  /** 重定向目标，已经按 AST 可理解范围提取为字符串。 */
  target: string
  /** 可选文件描述符，例如 `2>` 中的 `2`。 */
  fd?: number
}

/** 简单命令抽取结果，表示一个可被下游权限系统按 argv 检查的命令。 */
export type SimpleCommand = {
  /** 命令名和参数列表；argv[0] 是命令名，后续元素是已经处理引号语义后的参数。 */
  argv: string[]
  /** 命令前缀形式的环境变量赋值，例如 `FOO=bar cmd`。 */
  envVars: { name: string; value: string }[]
  /** 命令上的输入/输出重定向。 */
  redirects: Redirect[]
  /** 原始命令文本片段，用于 UI 展示或诊断。 */
  text: string
}

/** Bash AST 安全解析的结果类型：成功抽取、语法过复杂，或解析器不可用。 */
export type ParseForSecurityResult =
  | { kind: 'simple'; commands: SimpleCommand[] }
  | { kind: 'too-complex'; reason: string; nodeType?: string }
  | { kind: 'parse-unavailable' }

/**
 * 表示命令组合结构的 AST 节点类型。
 *
 * 这些节点本身不产生 argv，只负责包裹或连接真正的 `command` 叶子节点。
 */
const STRUCTURAL_TYPES = new Set([
  'program',
  'list',
  'pipeline',
  'redirected_statement',
])

/** 命令之间的分隔符节点；它们不携带命令参数，只影响变量作用域和执行关系。 */
const SEPARATOR_TYPES = new Set(['&&', '||', '|', ';', '&', '|&', '\n'])

/**
 * 命令替换 `$()` 的占位符。
 *
 * 内部命令会被单独抽取和检查，外层 argv 只能保留“这里有运行时输出”的事实，
 * 不能把运行时内容当成可信字面量。
 */
const CMDSUB_PLACEHOLDER = '__CMDSUB_OUTPUT__'

/**
 * 已跟踪变量展开的占位符。
 *
 * 当 `$VAR` 引用前面同一命令链中可追踪的赋值时，用该占位符表示“变量存在但值不一定是纯字面量”。
 */
const VAR_PLACEHOLDER = '__TRACKED_VAR__'

/**
 * 判断值中是否包含任何运行时占位符。
 *
 * @param value 需要检查的变量值。
 * @returns 包含命令替换或变量占位符时返回 true。
 */
function containsAnyPlaceholder(value: string): boolean {
  // 1. 子串匹配能覆盖 `prefix$(cmd)` 这类混合字面量和运行时输出的情况。
  return value.includes(CMDSUB_PLACEHOLDER) || value.includes(VAR_PLACEHOLDER)
}

/**
 * 未加引号的变量值中会触发 Bash 分词或 glob 展开的字符。
 *
 * 如果变量作为裸参数展开，空格、制表符、换行和 glob 字符都可能让一个静态 argv 元素变成多个运行时参数。
 */
const BARE_VAR_UNSAFE_RE = /[ \t\n*?[]/

/** `stdbuf -o 0` 这类短 flag 空格分隔形式。 */
const STDBUF_SHORT_SEP_RE = /^-[ioe]$/
/** `stdbuf -o0` 这类短 flag 与值粘连形式。 */
const STDBUF_SHORT_FUSED_RE = /^-[ioe]./
/** `stdbuf --output=0` 这类长 flag 等号形式。 */
const STDBUF_LONG_RE = /^--(input|output|error)=/

/**
 * Bash 或登录环境稳定提供的安全环境变量名集合。
 *
 * 这些变量的值通常由 shell 或操作系统控制，适合在受限场景中作为字符串的一部分解析；
 * 集合刻意保持较小，避免把任意用户输入误当成可信展开。
 */
const SAFE_ENV_VARS = new Set([
  'HOME', // 1. 用户主目录。
  'PWD', // 2. Bash 维护的当前目录。
  'OLDPWD', // 3. 上一个工作目录。
  'USER', // 4. 当前用户名。
  'LOGNAME', // 5. 登录名。
  'SHELL', // 6. 登录 shell 路径。
  'PATH', // 7. 可执行文件搜索路径。
  'HOSTNAME', // 8. 主机名。
  'UID', // 9. 用户 ID。
  'EUID', // 10. 有效用户 ID。
  'PPID', // 11. 父进程 ID。
  'RANDOM', // 12. Bash 内建随机数。
  'SECONDS', // 13. shell 启动后的秒数。
  'LINENO', // 14. 当前行号。
  'TMPDIR', // 15. 临时目录。
  'BASH_VERSION', // 16. Bash 版本字符串。
  'BASHPID', // 17. 当前 Bash 进程 ID。
  'SHLVL', // 18. shell 嵌套层级。
  'HISTFILE', // 19. 历史文件路径。
  'IFS', // 20. 字段分隔符；只能在字符串内安全，裸参数由 resolveSimpleExpansion 阻断。
])

/**
 * shell 特殊变量名集合，例如退出码、进程号和位置参数计数。
 *
 * 这些变量只在字符串上下文中可保守处理；`$@` 和 `$*` 不放入集合，
 * 因为它们在 BashTool 的空位置参数环境中会消失，静态占位会误导下游 deny 规则。
 */
const SPECIAL_VAR_NAMES = new Set([
  '?', // 1. 上一条命令退出码。
  '$', // 2. 当前 shell PID。
  '!', // 3. 上一个后台进程 PID。
  '#', // 4. 位置参数数量。
  '0', // 5. 脚本名。
  '-', // 6. shell 选项标记。
])

/**
 * 已知无法安全静态分析的 AST 节点类型。
 *
 * 这些节点要么会执行代码，要么会在运行时展开出无法预知的值。真实安全边界仍是 walker 的白名单：
 * 任何没有显式处理的节点都会进入 too-complex。
 */
const DANGEROUS_TYPES = new Set([
  'command_substitution',
  'process_substitution',
  'expansion',
  'simple_expansion',
  'brace_expression',
  'subshell',
  'compound_statement',
  'for_statement',
  'while_statement',
  'until_statement',
  'if_statement',
  'case_statement',
  'function_definition',
  'test_command',
  'ansi_c_string',
  'translated_string',
  'herestring_redirect',
  'heredoc_redirect',
])

/**
 * 危险节点类型的稳定数字编号，用于不接受字符串的分析事件。
 *
 * @param nodeType AST 节点类型；为空表示预检查阶段命中。
 * @returns 节点对应的稳定数字 ID，未知类型为 0，解析错误为 -1，预检查为 -2。
 */
const DANGEROUS_TYPE_IDS = [...DANGEROUS_TYPES]
export function nodeTypeId(nodeType: string | undefined): number {
  // 1. 没有节点类型代表命令在 AST 前置检查阶段被拒绝。
  if (!nodeType) return -2
  // 2. tree-sitter ERROR 节点使用单独编号，便于和普通未知类型区分。
  if (nodeType === 'ERROR') return -1
  // 3. 已知危险类型按声明顺序从 1 开始编号，追加新类型时保持已有编号稳定。
  const i = DANGEROUS_TYPE_IDS.indexOf(nodeType)
  return i >= 0 ? i + 1 : 0
}

/** tree-sitter 重定向操作符到内部规范操作符的映射。 */
const REDIRECT_OPS: Record<string, Redirect['op']> = {
  '>': '>',
  '>>': '>>',
  '<': '<',
  '>&': '>&',
  '<&': '<&',
  '>|': '>|',
  '&>': '&>',
  '&>>': '&>>',
  '<<<': '<<<',
}

/**
 * Bash 花括号展开检测正则，覆盖 `{a,b}` 和 `{a..b}` 形式。
 *
 * 这里不尝试还原反斜杠转义，因为那等于重新实现 Bash 去引号规则；遇到可疑形式保守拒绝。
 */
const BRACE_EXPANSION_RE = /\{[^{}\s]*(,|\.\.)[^{}\s]*\}/

/**
 * 会导致 Bash 和 tree-sitter 在词边界上产生分歧的控制字符。
 *
 * 包含 CR：tree-sitter 会把它当分隔符，但 Bash 默认 IFS 不包含 CR。
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B-\x1F\x7F]/

/**
 * ASCII 之外的 Unicode 空白字符。
 *
 * 这些字符在终端中不可见或像普通空格，但 Bash 可能按普通字面量处理，容易误导人工复核。
 */
const UNICODE_WHITESPACE_RE =
  /[\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/

/**
 * 反斜杠紧邻空白或特定换行续行的检测正则。
 *
 * Bash 会把 `\ ` 作为当前词里的字面空格，而 tree-sitter 保留原始反斜杠；
 * 为避免 argv 与真实执行命令不一致，这类写法统一视为过复杂。
 */
const BACKSLASH_WHITESPACE_RE = /\\[ \t]|[^ \t\n\\]\\\n/

/**
 * zsh 动态命名目录展开检测，形如 `~[name]`。
 *
 * Bash 会把它当字面量或 glob，但 zsh 可调用 hook，因此在默认 shell 可能是 zsh 的场景下保守拒绝。
 */
const ZSH_TILDE_BRACKET_RE = /~\[/

/**
 * zsh `=cmd` 展开检测。
 *
 * 词首 `=curl` 在 zsh 中会展开为 curl 的绝对路径，导致按 argv[0] 匹配的 deny 规则看不到真实命令名。
 */
const ZSH_EQUALS_EXPANSION_RE = /(?:^|[\s;&|])=[a-zA-Z_]/

/**
 * 花括号展开中混入引号的混淆写法检测。
 *
 * 这类写法很难用正则准确还原 Bash 展开结果，也不是自动放行命令需要的正常形态。
 */
const BRACE_WITH_QUOTE_RE = /\{[^}]*['"]/

/**
 * 遮蔽单双引号上下文中的 `{`，只保留可能参与花括号展开的未引用 `{`。
 *
 * @param cmd 原始 Bash 命令字符串。
 * @returns 引号内 `{` 被替换为空格后的命令字符串。
 */
function maskBracesInQuotedContexts(cmd: string): string {
  // 1. 没有 `{` 时直接返回，避免普通命令进入逐字符扫描。
  if (!cmd.includes('{')) return cmd
  const out: string[] = []
  let inSingle = false
  let inDouble = false
  let i = 0
  while (i < cmd.length) {
    const c = cmd[i]!
    if (inSingle) {
      // 2. 单引号内没有转义语义，遇到下一个单引号即退出。
      if (c === "'") inSingle = false
      out.push(c === '{' ? ' ' : c)
      i++
    } else if (inDouble) {
      // 3. 双引号内只按会影响引号状态的反斜杠转义推进扫描。
      if (c === '\\' && (cmd[i + 1] === '"' || cmd[i + 1] === '\\')) {
        out.push(c, cmd[i + 1]!)
        i += 2
      } else {
        if (c === '"') inDouble = false
        out.push(c === '{' ? ' ' : c)
        i++
      }
    } else {
      // 4. 未引用上下文中反斜杠转义下一个字符，并正常切换单双引号状态。
      if (c === '\\' && i + 1 < cmd.length) {
        out.push(c, cmd[i + 1]!)
        i += 2
      } else {
        if (c === "'") inSingle = true
        else if (c === '"') inDouble = true
        out.push(c)
        i++
      }
    }
  }
  // 5. 返回遮蔽后的字符串，供花括号混淆检测使用。
  return out.join('')
}

/** `$` 字符常量，避免在字符串和正则拼接时反复转义。 */
const DOLLAR = String.fromCharCode(0x24)

/**
 * 解析 Bash 命令并抽取可安全分析的简单命令列表。
 *
 * @param cmd 原始 Bash 命令字符串。
 * @returns 简单命令列表、过复杂原因，或解析器不可用状态。
 */
export async function parseForSecurity(
  cmd: string,
): Promise<ParseForSecurityResult> {
  // 1. 空字符串直接返回空命令列表；不能 trim，否则会吞掉需要被预检查拒绝的 Unicode 空白。
  if (cmd === '') return { kind: 'simple', commands: [] }
  // 2. 调用底层 parser；parser 未加载时返回 parse-unavailable，由调用方走保守逻辑。
  const root = await parseCommandRaw(cmd)
  return root === null
    ? { kind: 'parse-unavailable' }
    : parseForSecurityFromAst(cmd, root)
}

/**
 * 基于已经解析出的 AST 根节点执行安全抽取。
 *
 * @param cmd 原始 Bash 命令字符串；预检查仍然依赖原始文本。
 * @param root tree-sitter AST 根节点，或解析中止标记。
 * @returns 简单命令列表或过复杂原因。
 */
export function parseForSecurityFromAst(
  cmd: string,
  root: Node | typeof PARSE_ABORTED,
): ParseForSecurityResult {
  // 1. 先拒绝会导致 Bash 与 tree-sitter 分词不一致的控制字符。
  if (CONTROL_CHAR_RE.test(cmd)) {
    return { kind: 'too-complex', reason: 'Contains control characters' }
  }
  // 2. Unicode 空白在终端显示和 Bash 解析间容易产生误导，统一拒绝。
  if (UNICODE_WHITESPACE_RE.test(cmd)) {
    return { kind: 'too-complex', reason: 'Contains Unicode whitespace' }
  }
  // 3. 反斜杠空白会让真实 argv 和 AST 文本不一致。
  if (BACKSLASH_WHITESPACE_RE.test(cmd)) {
    return {
      kind: 'too-complex',
      reason: 'Contains backslash-escaped whitespace',
    }
  }
  // 4. zsh 动态目录语法可能触发 hook，不适合自动分析。
  if (ZSH_TILDE_BRACKET_RE.test(cmd)) {
    return {
      kind: 'too-complex',
      reason: 'Contains zsh ~[ dynamic directory syntax',
    }
  }
  // 5. zsh =cmd 会把命令名展开为路径，绕过按命令名匹配的规则。
  if (ZSH_EQUALS_EXPANSION_RE.test(cmd)) {
    return {
      kind: 'too-complex',
      reason: 'Contains zsh =cmd equals expansion',
    }
  }
  // 6. 花括号展开混合引号属于混淆写法，无法可靠静态还原。
  if (BRACE_WITH_QUOTE_RE.test(maskBracesInQuotedContexts(cmd))) {
    return {
      kind: 'too-complex',
      reason: 'Contains brace with quote character (expansion obfuscation)',
    }
  }

  const trimmed = cmd.trim()
  if (trimmed === '') {
    // 7. 只包含普通 ASCII 空白的命令没有实际子命令。
    return { kind: 'simple', commands: [] }
  }

  if (root === PARSE_ABORTED) {
    // 8. parser 已加载但因超时、节点预算或 panic 中止时，按过复杂处理，不能回退到较弱的旧路径。
    return {
      kind: 'too-complex',
      reason:
        'Parser aborted (timeout or resource limit) — possible adversarial input',
      nodeType: 'PARSE_ABORT',
    }
  }

  // 9. 预检查通过后，信任 tree-sitter 的 tokenization 并递归遍历 AST。
  return walkProgram(root)
}

/**
 * 遍历 AST 根节点并收集所有简单命令。
 *
 * @param root tree-sitter 的 program 根节点。
 * @returns 成功时返回简单命令列表；遇到不允许节点时返回 too-complex。
 */
function walkProgram(root: Node): ParseForSecurityResult {
  // 1. ERROR 节点检查合并到 collectCommands，避免额外全树扫描。
  const commands: SimpleCommand[] = []
  // 2. 跟踪同一命令链中前面赋值过的变量，允许后续 `$VAR` 在受控条件下替换为字面量或占位符。
  const varScope = new Map<string, string>()
  // 3. 从根节点递归收集命令，任一分支过复杂就整体返回过复杂。
  const err = collectCommands(root, commands, varScope)
  if (err) return err
  return { kind: 'simple', commands }
}

/**
 * 从结构节点中递归收集叶子 `command` 节点。
 *
 * @param node 当前 AST 节点。
 * @param commands 收集到的简单命令输出数组。
 * @param varScope 当前可见的变量赋值作用域。
 * @returns 成功时返回 null；遇到不允许结构时返回 too-complex。
 */
function collectCommands(
  node: Node,
  commands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  if (node.type === 'command') {
    // 1. command 叶子交给 walkCommand；其中的 `$()` 内部命令会追加到同一收集器。
    const result = walkCommand(node, [], commands, varScope)
    if (result.kind !== 'simple') return result
    commands.push(...result.commands)
    return null
  }

  if (node.type === 'redirected_statement') {
    // 2. 带重定向的命令需要把重定向信息挂回内部简单命令。
    return walkRedirectedStatement(node, commands, varScope)
  }

  if (node.type === 'comment') {
    // 3. 注释节点不产生命令，直接忽略。
    return null
  }

  if (STRUCTURAL_TYPES.has(node.type)) {
    // 4. `||`、管道和后台执行不能线性继承变量作用域；这些分支可能不执行，或在子 shell 中执行。
    // 5. 典型绕过是 `true || FLAG=--dry-run && cmd $FLAG`：真实 Bash 不会设置 FLAG，但线性模型会误以为命令带了安全 flag。
    // 6. 进入结构节点时按需保留作用域快照，遇到不保证执行或子 shell 分隔符后恢复快照。
    // 7. `&&` 和 `;` 是顺序执行路径，允许变量沿路径继续传播。
    // 8. 为减少常见简单命令开销，只有预扫描发现相关分隔符时才创建快照；pipeline 则天然按子 shell 作用域处理。
    const isPipeline = node.type === 'pipeline'
    let needsSnapshot = false
    if (!isPipeline) {
      for (const c of node.children) {
        if (c && (c.type === '||' || c.type === '&')) {
          needsSnapshot = true
          break
        }
      }
    }
    const snapshot = needsSnapshot ? new Map(varScope) : null
    // 9. pipeline 的每个阶段都在子 shell 中运行，因此使用作用域副本；普通 list/program 只在不确定执行的分支处隔离。
    let scope = isPipeline ? new Map(varScope) : varScope
    for (const child of node.children) {
      if (!child) continue
      if (SEPARATOR_TYPES.has(child.type)) {
        if (
          child.type === '||' ||
          child.type === '|' ||
          child.type === '|&' ||
          child.type === '&'
        ) {
          // 10. 遇到管道、短路右侧或后台分支后恢复入口快照，阻止分支赋值继续向后传播。
          scope = new Map(snapshot ?? varScope)
        }
        continue
      }
      const err = collectCommands(child, commands, scope)
      if (err) return err
    }
    return null
  }

  if (node.type === 'negated_command') {
    // 11. `! cmd` 只反转退出码，不改变实际执行的命令；递归进入内部命令继续做权限检查。
    for (const child of node.children) {
      if (!child) continue
      if (child.type === '!') continue
      return collectCommands(child, commands, varScope)
    }
    return null
  }

  if (node.type === 'declaration_command') {
    // 12. export/local/readonly/declare/typeset 是声明节点，需要显式抽取；右值仍交给变量赋值解析，命令替换会进入内部命令检查。
    const argv: string[] = []
    for (const child of node.children) {
      if (!child) continue
      switch (child.type) {
        case 'export':
        case 'local':
        case 'readonly':
        case 'declare':
        case 'typeset':
          argv.push(child.text)
          break
        case 'word':
        case 'number':
        case 'raw_string':
        case 'string':
        case 'concatenation': {
          // 13. flag、带引号名称和可解析的数字参数统一走参数解析，确保展开仍按安全规则拒绝。
          const arg = walkArgument(child, commands, varScope)
          if (typeof arg !== 'string') return arg
          // 14. declare/typeset/local 中改变赋值语义的 flag 会破坏静态模型，例如 nameref、整数求值和数组下标求值。
          // 15. 检查解析后的参数而不是原始文本，这样转义或带引号的危险 flag 也不会漏掉。
          // 16. 限定在 declare/typeset/local 上处理；export/readonly 对同名 flag 的语义不同，不能混同。
          if (
            (argv[0] === 'declare' ||
              argv[0] === 'typeset' ||
              argv[0] === 'local') &&
            /^-[a-zA-Z]*[niaA]/.test(arg)
          ) {
            return {
              kind: 'too-complex',
              reason: `declare flag ${arg} changes assignment semantics (nameref/integer/array)`,
              nodeType: 'declaration_command',
            }
          }
          // 17. declare/typeset/local 的裸数组下标赋值也会触发算术求值，即使没有 -a/-i，也要拒绝包含 `[` 的位置赋值。
          if (
            (argv[0] === 'declare' ||
              argv[0] === 'typeset' ||
              argv[0] === 'local') &&
            arg[0] !== '-' &&
            /^[^=]*\[/.test(arg)
          ) {
            return {
              kind: 'too-complex',
              reason: `declare positional '${arg}' contains array subscript — bash evaluates $(cmd) in subscripts`,
              nodeType: 'declaration_command',
            }
          }
          argv.push(arg)
          break
        }
        case 'variable_assignment': {
          const ev = walkVariableAssignment(child, commands, varScope)
          if ('kind' in ev) return ev
          // 18. 声明中的赋值会进入作用域，后续 `$VAR` 才能解析为静态值。
          applyVarToScope(varScope, ev)
          argv.push(`${ev.name}=${ev.value}`)
          break
        }
        case 'variable_name':
          // `export FOO` — bare name, no assignment.
          argv.push(child.text)
          break
        default:
          return tooComplex(child)
      }
    }
    commands.push({ argv, envVars: [], redirects: [], text: node.text })
    return null
  }

  if (node.type === 'variable_assignment') {
    // 19. 语句级裸赋值只设置 shell 变量，不执行命令也不读写文件；右值仍会递归校验，赋值本身不加入命令列表。
    const ev = walkVariableAssignment(node, commands, varScope)
    if ('kind' in ev) return ev
    // 20. 将静态赋值写入作用域，供后续变量引用解析。
    applyVarToScope(varScope, ev)
    return null
  }

  if (node.type === 'for_statement') {
    // 21. for 循环体只需要抽取一次，但循环变量始终按未知值处理，因为迭代词可能来自绝对路径、glob 或运行时文件名。
    // 22. 未知循环变量会让循环体里的裸 `$i` 变复杂，只允许嵌入到普通字符串中的场景继续解析。
    let loopVar: string | null = null
    let doGroup: Node | null = null
    for (const child of node.children) {
      if (!child) continue
      if (child.type === 'variable_name') {
        loopVar = child.text
      } else if (child.type === 'do_group') {
        doGroup = child
      } else if (
        child.type === 'for' ||
        child.type === 'in' ||
        child.type === 'select' ||
        child.type === ';'
      ) {
        continue // 23. 结构 token 不参与 argv。
      } else if (child.type === 'command_substitution') {
        // 24. `for i in $(seq 1 3)` 的内部命令必须抽取并接受规则检查。
        const err = collectCommandSubstitution(child, commands, varScope)
        if (err) return err
      } else {
        // 25. 迭代词本身仍要校验，用来发现命令替换等危险展开；校验后丢弃具体值。
        const arg = walkArgument(child, commands, varScope)
        if (typeof arg !== 'string') return arg
      }
    }
    if (loopVar === null || doGroup === null) return tooComplex(node)
    // 26. PS4/IFS 作为循环变量会绕过普通赋值检查，可能触发 trace 执行或分词绕过，直接拒绝。
    if (loopVar === 'PS4' || loopVar === 'IFS') {
      return {
        kind: 'too-complex',
        reason: `${loopVar} as loop variable bypasses assignment validation`,
        nodeType: 'for_statement',
      }
    }
    // 27. 循环体使用作用域副本，体内赋值不泄漏；循环变量按 Bash 语义保留到外层，但值保持未知占位。
    varScope.set(loopVar, VAR_PLACEHOLDER)
    const bodyScope = new Map(varScope)
    for (const c of doGroup.children) {
      if (!c) continue
      if (c.type === 'do' || c.type === 'done' || c.type === ';') continue
      const err = collectCommands(c, commands, bodyScope)
      if (err) return err
    }
    return null
  }

  if (node.type === 'if_statement' || node.type === 'while_statement') {
    // 28. if/while 需要抽取条件和所有分支/循环体命令，全部进入权限检查。
    // 29. 分支或循环体可能不执行，因此内部赋值使用作用域副本；条件部分按必经路径处理，可让 `while read VAR` 传递到体内。
    // 30. tree-sitter 的 if 子节点通过 then 标记区分条件区和 then 体。
    let seenThen = false
    for (const child of node.children) {
      if (!child) continue
      if (
        child.type === 'if' ||
        child.type === 'fi' ||
        child.type === 'else' ||
        child.type === 'elif' ||
        child.type === 'while' ||
        child.type === 'until' ||
        child.type === ';'
      ) {
        continue
      }
      if (child.type === 'then') {
        seenThen = true
        continue
      }
      if (child.type === 'do_group') {
        // 31. while 体用作用域副本递归，保留条件中 read 捕获的未知变量，同时不让体内赋值泄漏到 done 之后。
        const bodyScope = new Map(varScope)
        for (const c of child.children) {
          if (!c) continue
          if (c.type === 'do' || c.type === 'done' || c.type === ';') continue
          const err = collectCommands(c, commands, bodyScope)
          if (err) return err
        }
        continue
      }
      if (child.type === 'elif_clause' || child.type === 'else_clause') {
        // 32. elif/else 分支使用作用域副本，避免未必执行的赋值流出 fi。
        const branchScope = new Map(varScope)
        for (const c of child.children) {
          if (!c) continue
          if (
            c.type === 'elif' ||
            c.type === 'else' ||
            c.type === 'then' ||
            c.type === ';'
          ) {
            continue
          }
          const err = collectCommands(c, commands, branchScope)
          if (err) return err
        }
        continue
      }
      // 33. 条件区使用真实作用域，then 体使用副本；while read 的变量要写回真实作用域供循环体继承。
      const targetScope = seenThen ? new Map(varScope) : varScope
      const before = commands.length
      const err = collectCommands(child, commands, targetScope)
      if (err) return err
      // 34. 条件中出现 read 时，把读取到的变量记录为未知值占位符。
      if (!seenThen) {
        for (let i = before; i < commands.length; i++) {
          const c = commands[i]
          if (c?.argv[0] === 'read') {
            for (const a of c.argv.slice(1)) {
              // 35. 跳过 read 的 flag，只把裸标识符参数当作变量名。
              if (!a.startsWith('-') && /^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) {
                // 36. read 可能处于短路、管道或子 shell 中而未真正覆盖变量；若会覆盖已知静态值，保守拒绝，避免路径校验被未知值占位掩盖。
                const existing = varScope.get(a)
                if (
                  existing !== undefined &&
                  !containsAnyPlaceholder(existing)
                ) {
                  return {
                    kind: 'too-complex',
                    reason: `'read ${a}' in condition may not execute (||/pipeline/subshell); cannot prove it overwrites tracked literal '${existing}'`,
                    nodeType: 'if_statement',
                  }
                }
                varScope.set(a, VAR_PLACEHOLDER)
              }
            }
          }
        }
      }
    }
    return null
  }

  if (node.type === 'subshell') {
    // 37. 子 shell 中的命令会执行，必须抽取；但变量作用域隔离，内部赋值不能泄漏到外层。
    const innerScope = new Map(varScope)
    for (const child of node.children) {
      if (!child) continue
      if (child.type === '(' || child.type === ')') continue
      const err = collectCommands(child, commands, innerScope)
      if (err) return err
    }
    return null
  }

  if (node.type === 'test_command') {
    // 38. test 表达式按合成命令 `[[` 进入权限匹配；操作数仍递归解析，确保内部展开不会被跳过。
    const argv: string[] = ['[[']
    for (const child of node.children) {
      if (!child) continue
      if (child.type === '[[' || child.type === ']]') continue
      if (child.type === '[' || child.type === ']') continue
      // 39. 递归解析 test 表达式树，最终收集操作符和操作数叶子节点。
      const err = walkTestExpr(child, argv, commands, varScope)
      if (err) return err
    }
    commands.push({ argv, envVars: [], redirects: [], text: node.text })
    return null
  }

  if (node.type === 'unset_command') {
    // 40. unset 只移除当前 shell 的变量或函数，本身不执行代码也不读写文件，但需要更新静态作用域。
    const argv: string[] = []
    for (const child of node.children) {
      if (!child) continue
      switch (child.type) {
        case 'unset':
          argv.push(child.text)
          break
        case 'variable_name':
          argv.push(child.text)
          // 41. unset 后变量不应继续按旧静态值解析，否则会放过后续 `$VAR`。
          varScope.delete(child.text)
          break
        case 'word': {
          const arg = walkArgument(child, commands, varScope)
          if (typeof arg !== 'string') return arg
          argv.push(arg)
          break
        }
        default:
          return tooComplex(child)
      }
    }
    commands.push({ argv, envVars: [], redirects: [], text: node.text })
    return null
  }

  return tooComplex(node)
}

/**
 * 递归遍历 `[[ ... ]]` 或 test 表达式树并生成等价 argv。
 *
 * @param node 当前 test 表达式节点。
 * @param argv 输出参数数组。
 * @param innerCommands 表达式中抽取出的内部命令收集器。
 * @param varScope 当前变量作用域。
 * @returns 表达式可静态解析时返回 null；出现无法处理节点时返回 too-complex。
 */
function walkTestExpr(
  node: Node,
  argv: string[],
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  // 1. 复合 test 表达式递归处理子节点。
  switch (node.type) {
    case 'unary_expression':
    case 'binary_expression':
    case 'negated_expression':
    case 'parenthesized_expression': {
      for (const c of node.children) {
        if (!c) continue
        const err = walkTestExpr(c, argv, innerCommands, varScope)
        if (err) return err
      }
      return null
    }
    case 'test_operator':
    case '!':
    case '(':
    case ')':
    case '&&':
    case '||':
    case '==':
    case '=':
    case '!=':
    case '<':
    case '>':
    case '=~':
      // 2. test 操作符本身作为 argv 字面量保存。
      argv.push(node.text)
      return null
    case 'regex':
    case 'extglob_pattern':
      // 3. [[ ]] 右侧模式只按模式文本加入；内部展开会作为兄弟节点另行遍历。
      argv.push(node.text)
      return null
    default: {
      // 4. 操作数复用参数解析逻辑，确保引号和展开规则一致。
      const arg = walkArgument(node, innerCommands, varScope)
      if (typeof arg !== 'string') return arg
      argv.push(arg)
      return null
    }
  }
}

/**
 * 处理包裹命令和重定向的 `redirected_statement` 节点。
 *
 * @param node 当前 redirected_statement 节点。
 * @param commands 收集到的简单命令输出数组。
 * @param varScope 当前变量作用域。
 * @returns 成功时返回 null；重定向或内部命令不可静态分析时返回 too-complex。
 */
function walkRedirectedStatement(
  node: Node,
  commands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  // 1. 先收集重定向，再定位真正的内部命令节点。
  const redirects: Redirect[] = []
  let innerCommand: Node | null = null

  for (const child of node.children) {
    if (!child) continue
    if (child.type === 'file_redirect') {
      // 2. 重定向目标中如果出现 `$()`，内部命令也要进入权限检查。
      const r = walkFileRedirect(child, commands, varScope)
      if ('kind' in r) return r
      redirects.push(r)
    } else if (child.type === 'heredoc_redirect') {
      const r = walkHeredocRedirect(child)
      if (r) return r
    } else if (
      child.type === 'command' ||
      child.type === 'pipeline' ||
      child.type === 'list' ||
      child.type === 'negated_command' ||
      child.type === 'declaration_command' ||
      child.type === 'unset_command'
    ) {
      innerCommand = child
    } else {
      return tooComplex(child)
    }
  }

  if (!innerCommand) {
    // 3. `> file` 本身是合法 Bash 且会截断文件，用空 argv 命令表示这次写入。
    commands.push({ argv: [], envVars: [], redirects, text: node.text })
    return null
  }

  // 4. 先递归收集内部命令，再把外层重定向挂到最后一个命令上。
  const before = commands.length
  const err = collectCommands(innerCommand, commands, varScope)
  if (err) return err
  if (commands.length > before && redirects.length > 0) {
    const last = commands[commands.length - 1]
    if (last) last.redirects.push(...redirects)
  }
  return null
}

/**
 * 从 `file_redirect` 节点中抽取重定向操作符、目标和可选 fd。
 *
 * @param node 当前 file_redirect 节点。
 * @param innerCommands 重定向目标里抽取出的内部命令收集器。
 * @param varScope 当前变量作用域。
 * @returns 成功时返回重定向对象；无法证明目标是静态值时返回 too-complex。
 */
function walkFileRedirect(
  node: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): Redirect | ParseForSecurityResult {
  // 1. 重定向必须同时具备操作符和目标，fd 是可选信息。
  let op: Redirect['op'] | null = null
  let target: string | null = null
  let fd: number | undefined

  for (const child of node.children) {
    if (!child) continue
    if (child.type === 'file_descriptor') {
      fd = Number(child.text)
    } else if (child.type in REDIRECT_OPS) {
      op = REDIRECT_OPS[child.type] ?? null
    } else if (child.type === 'word' || child.type === 'number') {
      // 2. number/word 如果带子节点，可能隐藏运行时展开，不能当作静态目标。
      if (child.children.length > 0) return tooComplex(child)
      // 3. 重定向目标中的花括号展开会让目标数量和名称运行时变化，保守拒绝。
      if (BRACE_EXPANSION_RE.test(child.text)) return tooComplex(child)
      // 4. Bash 去引号会移除反斜杠，目标检查必须使用运行时实际路径。
      target = child.text.replace(/\\(.)/g, '$1')
    } else if (child.type === 'raw_string') {
      target = stripRawString(child.text)
    } else if (child.type === 'string') {
      const s = walkString(child, innerCommands, varScope)
      if (typeof s !== 'string') return s
      target = s
    } else if (child.type === 'concatenation') {
      // 5. 拼接型目标复用参数 walker，确保其中没有未处理展开。
      const s = walkArgument(child, innerCommands, varScope)
      if (typeof s !== 'string') return s
      target = s
    } else {
      return tooComplex(child)
    }
  }

  if (!op || target === null) {
    // 6. 无法识别操作符或目标时，不猜测重定向语义。
    return {
      kind: 'too-complex',
      reason: 'Unrecognized redirect shape',
      nodeType: node.type,
    }
  }
  // 7. 返回规范化后的重定向结构，供下游路径和语义检查使用。
  return { op, target, fd }
}

/**
 * 校验 heredoc 重定向是否为可静态信任的字面量输入。
 *
 * @param node 当前 heredoc_redirect 节点。
 * @returns 可接受时返回 null；未引用分隔符或异常子节点返回 too-complex。
 */
function walkHeredocRedirect(node: Node): ParseForSecurityResult | null {
  // 1. 收集 heredoc 起始分隔符和正文节点。
  let startText: string | null = null
  let body: Node | null = null

  for (const child of node.children) {
    if (!child) continue
    if (child.type === 'heredoc_start') startText = child.text
    else if (child.type === 'heredoc_body') body = child
    else if (
      child.type === '<<' ||
      child.type === '<<-' ||
      child.type === 'heredoc_end' ||
      child.type === 'file_descriptor'
    ) {
      // 2. 这些是 heredoc 的结构 token，不会产生命令或运行时展开。
    } else {
      // 3. 分隔符同行后的管道或命令可能被 tree-sitter 放到 heredoc 节点下，必须拒绝而不是跳过。
      return tooComplex(child)
    }
  }

  // 4. 只有引用分隔符的 heredoc 正文才是字面量；未引用正文会执行变量、命令和算术展开。
  const isQuoted =
    startText !== null &&
    ((startText.startsWith("'") && startText.endsWith("'")) ||
      (startText.startsWith('"') && startText.endsWith('"')) ||
      startText.startsWith('\\'))

  if (!isQuoted) {
    return {
      kind: 'too-complex',
      reason: 'Heredoc with unquoted delimiter undergoes shell expansion',
      nodeType: 'heredoc_redirect',
    }
  }

  if (body) {
    // 5. 正文内只能包含普通 heredoc_content，任何可执行或可展开节点都拒绝。
    for (const child of body.children) {
      if (!child) continue
      if (child.type !== 'heredoc_content') {
        return tooComplex(child)
      }
    }
  }
  return null
}

/**
 * 校验 here-string 重定向内容是否可静态解析。
 *
 * @param node 当前 herestring_redirect 节点。
 * @param innerCommands 内容中抽取出的内部命令收集器。
 * @param varScope 当前变量作用域。
 * @returns 内容可证明为字面量时返回 null；出现运行时展开时返回 too-complex。
 */
function walkHerestringRedirect(
  node: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  // 1. here-string 内容进入 stdin，不进入 argv；但仍要确认内容没有执行型展开。
  for (const child of node.children) {
    if (!child) continue
    if (child.type === '<<<') continue
    // 2. 复用参数 walker 验证内容是否静态可解析，结果字符串本身不写入 argv。
    const content = walkArgument(child, innerCommands, varScope)
    if (typeof content !== 'string') return content
    // 3. 内容虽然不进入 argv，但仍可能影响下游按 .text 重分词的安全假设。
    if (NEWLINE_HASH_RE.test(content)) return tooComplex(child)
  }
  return null
}

/**
 * 遍历 `command` 节点并抽取 argv、环境变量和重定向。
 *
 * @param node 当前 command 节点。
 * @param extraRedirects 外层 redirected_statement 已经收集到的重定向。
 * @param innerCommands 命令替换中抽取出的内部命令收集器。
 * @param varScope 当前变量作用域。
 * @returns 成功时返回一个简单命令；遇到未处理结构时返回 too-complex。
 */
function walkCommand(
  node: Node,
  extraRedirects: Redirect[],
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult {
  // 1. 初始化命令名/参数、环境变量和重定向容器。
  const argv: string[] = []
  const envVars: { name: string; value: string }[] = []
  const redirects: Redirect[] = [...extraRedirects]

  // 2. 按 AST 子节点顺序逐项处理，任何未明确支持的节点都 fail-closed。
  for (const child of node.children) {
    if (!child) continue

    switch (child.type) {
      case 'variable_assignment': {
        const ev = walkVariableAssignment(child, innerCommands, varScope)
        if ('kind' in ev) return ev
        // 3. 命令前缀环境变量只对当前命令可见，不能写入全局 varScope。
        envVars.push({ name: ev.name, value: ev.value })
        break
      }
      case 'command_name': {
        // 4. command_name 的真实文本仍交给参数 walker，统一处理引号和展开。
        const arg = walkArgument(
          child.children[0] ?? child,
          innerCommands,
          varScope,
        )
        if (typeof arg !== 'string') return arg
        argv.push(arg)
        break
      }
      case 'word':
      case 'number':
      case 'raw_string':
      case 'string':
      case 'concatenation':
      case 'arithmetic_expansion': {
        // 5. 普通参数统一走 walkArgument，确保特殊展开和花括号语法都被检查。
        const arg = walkArgument(child, innerCommands, varScope)
        if (typeof arg !== 'string') return arg
        argv.push(arg)
        break
      }
      case 'simple_expansion': {
        // 6. 裸 `$VAR` 只有在变量值可静态证明时才替换为真实值，否则拒绝。
        const v = resolveSimpleExpansion(child, varScope, false)
        if (typeof v !== 'string') return v
        argv.push(v)
        break
      }
      case 'file_redirect': {
        // 7. 命令内联重定向直接挂到当前简单命令上。
        const r = walkFileRedirect(child, innerCommands, varScope)
        if ('kind' in r) return r
        redirects.push(r)
        break
      }
      case 'herestring_redirect': {
        // 8. here-string 内容只作为 stdin，验证为字面量后丢弃。
        const err = walkHerestringRedirect(child, innerCommands, varScope)
        if (err) return err
        break
      }
      default:
        return tooComplex(child)
    }
  }

  // 9. 如果解析过程中把 `$VAR` 替换成真实 argv，或原文含换行，则重建 text，避免下游 deny 规则按原始 `$VAR` 漏匹配。
  const text =
    /\$[A-Za-z_]/.test(node.text) || node.text.includes('\n')
      ? argv
          .map(a =>
            a === '' || /["'\\ \t\n$`;|&<>(){}*?[\]~#]/.test(a)
              ? `'${a.replace(/'/g, "'\\''")}'`
              : a,
          )
          .join(' ')
      : node.text
  return {
    kind: 'simple',
    commands: [{ argv, envVars, redirects, text }],
  }
}

/**
 * 递归抽取命令替换 `$()` 或反引号中的内部命令。
 *
 * @param csNode command_substitution 节点。
 * @param innerCommands 内部命令收集器。
 * @param varScope 外层变量作用域。
 * @returns 内部命令可抽取时返回 null；内部结构过复杂时返回 too-complex。
 */
function collectCommandSubstitution(
  csNode: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  // 1. 命令替换运行在子 shell 中，能看到外层已有变量，但内部赋值不能泄漏回外层。
  const innerScope = new Map(varScope)
  // 2. 跳过 `$(`/反引号/`)` 结构 token，只递归处理内部语句。
  for (const child of csNode.children) {
    if (!child) continue
    if (child.type === '$(' || child.type === '`' || child.type === ')') {
      continue
    }
    const err = collectCommands(child, innerCommands, innerScope)
    if (err) return err
  }
  return null
}

/**
 * 将参数位置的 AST 节点转换为可信字面量字符串。
 *
 * @param node 参数节点，可能是 word、string、raw_string、concatenation 等。
 * @param innerCommands 命令替换中抽取出的内部命令收集器。
 * @param varScope 当前变量作用域。
 * @returns 可静态解析时返回参数字符串；无法证明安全时返回 too-complex。
 */
function walkArgument(
  node: Node | null,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): string | ParseForSecurityResult {
  if (!node) {
    return { kind: 'too-complex', reason: 'Null argument node' }
  }

  // 1. 按节点类型使用白名单处理，未知参数节点一律返回 too-complex。
  switch (node.type) {
    case 'word': {
      // 2. 未引用 word 中的反斜杠会被 Bash 去引号移除，语义检查必须看到运行时真实文本。
      if (BRACE_EXPANSION_RE.test(node.text)) {
        return {
          kind: 'too-complex',
          reason: 'Word contains brace expansion syntax',
          nodeType: 'word',
        }
      }
      return node.text.replace(/\\(.)/g, '$1')
    }

    case 'number':
      // 3. number 节点如果包含子节点，可能是 `NN#$(cmd)` 这类算术基数语法，运行时会执行展开。
      if (node.children.length > 0) {
        return {
          kind: 'too-complex',
          reason: 'Number node contains expansion (NN# arithmetic base syntax)',
          nodeType: node.children[0]?.type,
        }
      }
      return node.text

    case 'raw_string':
      // 4. 单引号原始字符串去掉外层引号即可。
      return stripRawString(node.text)

    case 'string':
      // 5. 双引号字符串需要单独处理内部转义和受限展开。
      return walkString(node, innerCommands, varScope)

    case 'concatenation': {
      // 6. 拼接节点中的每一段都必须可静态解析，并额外拒绝花括号展开。
      if (BRACE_EXPANSION_RE.test(node.text)) {
        return {
          kind: 'too-complex',
          reason: 'Brace expansion',
          nodeType: 'concatenation',
        }
      }
      let result = ''
      for (const child of node.children) {
        if (!child) continue
        const part = walkArgument(child, innerCommands, varScope)
        if (typeof part !== 'string') return part
        result += part
      }
      return result
    }

    case 'arithmetic_expansion': {
      // 7. 算术展开只允许纯字面量数值表达式。
      const err = walkArithmetic(node)
      if (err) return err
      return node.text
    }

    case 'simple_expansion': {
      // 8. 拼接中的 `$VAR` 按裸参数处理，因为整个拼接结果就是一个运行时参数。
      return resolveSimpleExpansion(node, varScope, false)
    }

    default:
      // 9. 裸命令替换、参数展开等没有显式支持的参数形态都不能生成可信 argv。
      return tooComplex(node)
  }
}

/**
 * 抽取双引号字符串的运行时字面量内容。
 *
 * @param node 双引号 string 节点。
 * @param innerCommands 命令替换中抽取出的内部命令收集器。
 * @param varScope 当前变量作用域。
 * @returns 可解析时返回字符串内容；出现不可控展开时返回 too-complex。
 */
function walkString(
  node: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): string | ParseForSecurityResult {
  // 1. 逐段拼接双引号内部内容，并通过 startIndex gap 补回 tree-sitter 遗漏的换行。
  let result = ''
  let cursor = -1
  // 2. 区分“只有运行时占位符”和“占位符混合字面量”，前者不能作为可信路径参数。
  let sawDynamicPlaceholder = false
  let sawLiteralContent = false
  for (const child of node.children) {
    if (!child) continue
    // 3. 子节点索引之间的空洞代表双引号中的真实换行，需要补回。
    if (cursor !== -1 && child.startIndex > cursor && child.type !== '"') {
      result += '\n'.repeat(child.startIndex - cursor)
      sawLiteralContent = true
    }
    cursor = child.endIndex
    switch (child.type) {
      case '"':
        // 4. 引号分隔符本身不进入结果，只更新 cursor。
        cursor = child.endIndex
        break
      case 'string_content':
        // 5. 双引号内只有 `$`、反引号、双引号和反斜杠前的反斜杠会被 Bash 去掉。
        result += child.text.replace(/\\([$`"\\])/g, '$1')
        sawLiteralContent = true
        break
      case DOLLAR:
        // 6. 不构成变量名的裸 `$` 在 Bash 中是字面量。
        result += DOLLAR
        sawLiteralContent = true
        break
      case 'command_substitution': {
        // 7. 特判 `$(cat <<'EOF' ...)`，引用 heredoc 正文是字面量，可作为已知字符串处理。
        const heredocBody = extractSafeCatHeredoc(child)
        if (heredocBody === 'DANGEROUS') return tooComplex(child)
        if (heredocBody !== null) {
          // 8. 单行 heredoc 正文必须进入 argv，避免路径敏感命令把真实目标藏在命令替换里。
          const trimmed = heredocBody.replace(/\n+$/, '')
          if (trimmed.includes('\n')) {
            sawLiteralContent = true
            break
          }
          result += trimmed
          sawLiteralContent = true
          break
        }
        // 9. 普通 `$()` 递归抽取内部命令，外层字符串只保留运行时占位符。
        const err = collectCommandSubstitution(child, innerCommands, varScope)
        if (err) return err
        result += CMDSUB_PLACEHOLDER
        sawDynamicPlaceholder = true
        break
      }
      case 'simple_expansion': {
        // 10. 双引号内 `$VAR` 只允许已跟踪变量或少量安全环境变量。
        const v = resolveSimpleExpansion(child, varScope, true)
        if (typeof v !== 'string') return v
        // 11. 占位符代表运行时未知；其他字符串代表已知字面量变量值。
        if (v === VAR_PLACEHOLDER) sawDynamicPlaceholder = true
        else sawLiteralContent = true
        result += v
        break
      }
      case 'arithmetic_expansion': {
        // 12. 算术展开必须先通过纯字面量校验。
        const err = walkArithmetic(child)
        if (err) return err
        result += child.text
        // 13. 通过算术字面量校验后，可作为静态内容参与后续 argv 判断。
        sawLiteralContent = true
        break
      }
      default:
        // 14. `${...}` 等没有显式建模的双引号内部展开拒绝自动分析。
        return tooComplex(child)
    }
  }
  // 15. 只有运行时占位符、没有任何字面量内容的字符串不能作为可信 argv。
  if (sawDynamicPlaceholder && !sawLiteralContent) {
    return tooComplex(node)
  }
  // 16. tree-sitter 会遗漏“只有空白”的双引号内容，此时不能把它误判成空字符串。
  if (!sawLiteralContent && !sawDynamicPlaceholder && node.text.length > 2) {
    return tooComplex(node)
  }
  // 17. 返回与 Bash 运行时一致的双引号字符串值。
  return result
}

/**
 * 算术展开中允许的叶子文本。
 *
 * 只允许数字字面量、Bash base#digits 形式和操作符/括号；变量名等运行时值必须拒绝。
 */
const ARITH_LEAF_RE =
  /^(?:[0-9]+|0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[-+*/%^&|~!<>=?:(),]+|<<|>>|\*\*|&&|\|\||[<>=!]=|\$\(\(|\)\))$/

/**
 * 递归校验算术展开是否只包含字面量表达式。
 *
 * @param node arithmetic_expansion 或其内部表达式节点。
 * @returns 校验通过返回 null；出现变量、命令替换或未知表达式时返回 too-complex。
 */
function walkArithmetic(node: Node): ParseForSecurityResult | null {
  // 1. 逐个子节点检查，叶子节点只能是安全数字或操作符。
  for (const child of node.children) {
    if (!child) continue
    if (child.children.length === 0) {
      if (!ARITH_LEAF_RE.test(child.text)) {
        return {
          kind: 'too-complex',
          reason: `Arithmetic expansion references variable or non-literal: ${child.text}`,
          nodeType: 'arithmetic_expansion',
        }
      }
      continue
    }
    // 2. 复合算术表达式只允许继续递归到已知表达式结构。
    switch (child.type) {
      case 'binary_expression':
      case 'unary_expression':
      case 'ternary_expression':
      case 'parenthesized_expression': {
        const err = walkArithmetic(child)
        if (err) return err
        break
      }
      default:
        return tooComplex(child)
    }
  }
  return null
}

/**
 * 识别安全的 `$(cat <<'EOF' ... EOF)` 命令替换并返回 heredoc 正文。
 *
 * @param subNode command_substitution 节点。
 * @returns 命中安全 cat heredoc 时返回正文；命中危险正文时返回 `DANGEROUS`；不匹配该特例时返回 null。
 */
function extractSafeCatHeredoc(subNode: Node): string | 'DANGEROUS' | null {
  // 1. 结构必须只有 `$(`、一个 redirected_statement 和 `)`。
  let stmt: Node | null = null
  for (const child of subNode.children) {
    if (!child) continue
    if (child.type === '$(' || child.type === ')') continue
    if (child.type === 'redirected_statement' && stmt === null) {
      stmt = child
    } else {
      return null
    }
  }
  if (!stmt) return null

  // 2. redirected_statement 必须由裸 `cat` 命令和一个引用分隔符 heredoc 组成。
  let sawCat = false
  let body: string | null = null
  for (const child of stmt.children) {
    if (!child) continue
    if (child.type === 'command') {
      // 3. cat 不能带参数或环境变量，否则输出就不再只是 heredoc 正文。
      const cmdChildren = child.children.filter(c => c)
      if (cmdChildren.length !== 1) return null
      const nameNode = cmdChildren[0]
      if (nameNode?.type !== 'command_name' || nameNode.text !== 'cat') {
        return null
      }
      sawCat = true
    } else if (child.type === 'heredoc_redirect') {
      // 4. 复用 heredoc 校验，确保正文是不会展开的字面量。
      if (walkHeredocRedirect(child) !== null) return null
      for (const hc of child.children) {
        if (hc?.type === 'heredoc_body') body = hc.text
      }
    } else {
      return null
    }
  }

  if (!sawCat || body === null) return null
  // 5. heredoc 正文会成为外层 argv 值，敏感路径和 jq system() 必须在这里拦截。
  if (PROC_ENVIRON_RE.test(body)) return 'DANGEROUS'
  if (/\bsystem\s*\(/.test(body)) return 'DANGEROUS'
  return body
}

/**
 * 解析变量赋值节点，提取变量名、值以及是否为追加赋值。
 *
 * @param node variable_assignment 节点。
 * @param innerCommands 赋值右侧命令替换中抽取出的内部命令收集器。
 * @param varScope 当前变量作用域，用于解析右侧 `$VAR`。
 * @returns 成功时返回变量赋值结构；赋值名或值不可静态分析时返回 too-complex。
 */
function walkVariableAssignment(
  node: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): { name: string; value: string; isAppend: boolean } | ParseForSecurityResult {
  // 1. 变量赋值由变量名、赋值操作符和值组成；值可能为空字符串。
  let name: string | null = null
  let value = ''
  let isAppend = false

  for (const child of node.children) {
    if (!child) continue
    if (child.type === 'variable_name') {
      name = child.text
    } else if (child.type === '=' || child.type === '+=') {
      // 2. `+=` 是追加赋值操作符，需要保留给后续作用域合并逻辑。
      isAppend = child.type === '+='
      continue
    } else if (child.type === 'command_substitution') {
      // 3. 赋值右侧的 `$()` 会执行内部命令；内部命令必须被单独抽取并接受权限检查。
      const err = collectCommandSubstitution(child, innerCommands, varScope)
      if (err) return err
      value = CMDSUB_PLACEHOLDER
    } else if (child.type === 'simple_expansion') {
      // 4. 赋值右侧不会像命令参数那样分词或 glob 展开，因此按字符串上下文解析 `$VAR`。
      const v = resolveSimpleExpansion(child, varScope, true)
      if (typeof v !== 'string') return v
      value = v
    } else {
      // 5. 其他赋值值节点按普通参数解析，确保引号和展开都可被建模。
      const v = walkArgument(child, innerCommands, varScope)
      if (typeof v !== 'string') return v
      value = v
    }
  }

  if (name === null) {
    // 6. 没有变量名的赋值结构无法对应 Bash 语义。
    return {
      kind: 'too-complex',
      reason: 'Variable assignment without name',
      nodeType: 'variable_assignment',
    }
  }
  // 7. Bash 只认可合法变量名；非法变量名会被当作命令执行，不能按赋值处理。
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return {
      kind: 'too-complex',
      reason: `Invalid variable name (bash treats as command): ${name}`,
      nodeType: 'variable_assignment',
    }
  }
  // 8. 修改 IFS 会改变后续未引用变量的分词规则，当前静态模型无法可靠模拟。
  if (name === 'IFS') {
    return {
      kind: 'too-complex',
      reason: 'IFS assignment changes word-splitting — cannot model statically',
      nodeType: 'variable_assignment',
    }
  }
  // 9. PS4 会在 `set -x` 跟踪输出时展开；只允许非常窄的字面量字符集和 `${VAR}` 引用。
  if (name === 'PS4') {
    if (isAppend) {
      return {
        kind: 'too-complex',
        reason:
          'PS4 += cannot be statically verified — combine into a single PS4= assignment',
        nodeType: 'variable_assignment',
      }
    }
    if (containsAnyPlaceholder(value)) {
      return {
        kind: 'too-complex',
        reason: 'PS4 value derived from cmdsub/variable — runtime unknowable',
        nodeType: 'variable_assignment',
      }
    }
    if (
      !/^[A-Za-z0-9 _+:./=[\]-]*$/.test(
        value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, ''),
      )
    ) {
      return {
        kind: 'too-complex',
        reason:
          'PS4 value outside safe charset — only ${VAR} refs and [A-Za-z0-9 _+:.=/[]-] allowed',
        nodeType: 'variable_assignment',
      }
    }
  }
  // 10. 赋值右侧的 ~ 可能在赋值时展开成真实路径，静态值与运行时值会分歧。
  if (value.includes('~')) {
    return {
      kind: 'too-complex',
      reason: 'Tilde in assignment value — bash may expand at assignment time',
      nodeType: 'variable_assignment',
    }
  }
  // 11. 返回规范化赋值结果，调用方决定是否写入作用域。
  return { name, value, isAppend }
}

/**
 * 解析 `$VAR` 形式的简单变量展开。
 *
 * @param node simple_expansion 节点。
 * @param varScope 当前变量作用域。
 * @param insideString 当前展开是否位于双引号字符串内部。
 * @returns 已知字面量、运行时占位符，或 too-complex。
 */
function resolveSimpleExpansion(
  node: Node,
  varScope: Map<string, string>,
  insideString: boolean,
): string | ParseForSecurityResult {
  // 1. 提取普通变量名或特殊变量名。
  let varName: string | null = null
  let isSpecial = false
  for (const c of node.children) {
    if (c?.type === 'variable_name') {
      varName = c.text
      break
    }
    if (c?.type === 'special_variable_name') {
      varName = c.text
      isSpecial = true
      break
    }
  }
  if (varName === null) return tooComplex(node)
  // 2. 已跟踪变量如果是纯字面量，直接返回真实值，让路径校验看到运行时目标。
  const trackedValue = varScope.get(varName)
  if (trackedValue !== undefined) {
    if (containsAnyPlaceholder(trackedValue)) {
      // 3. 非字面量变量只能嵌入字符串中，裸参数会隐藏真实路径或 flag。
      if (!insideString) return tooComplex(node)
      return VAR_PLACEHOLDER
    }
    // 4. 裸参数中的字面量变量仍可能分词、glob 或消失，必须检查默认 IFS/glob 风险。
    if (!insideString) {
      if (trackedValue === '') return tooComplex(node)
      if (BARE_VAR_UNSAFE_RE.test(trackedValue)) return tooComplex(node)
    }
    return trackedValue
  }
  // 5. shell 控制的环境变量和特殊变量值未知，只允许作为字符串片段。
  if (insideString) {
    if (SAFE_ENV_VARS.has(varName)) return VAR_PLACEHOLDER
    if (
      isSpecial &&
      (SPECIAL_VAR_NAMES.has(varName) || /^[0-9]+$/.test(varName))
    ) {
      return VAR_PLACEHOLDER
    }
  }
  // 6. 未跟踪、非安全变量不能生成可信 argv。
  return tooComplex(node)
}

/**
 * 将变量赋值写入作用域，并处理 `+=` 追加语义。
 *
 * @param varScope 当前变量作用域。
 * @param ev 已解析的变量赋值结果。
 * @returns 无返回值；函数会原地更新 `varScope`。
 */
function applyVarToScope(
  varScope: Map<string, string>,
  ev: { name: string; value: string; isAppend: boolean },
): void {
  // 1. 追加赋值需要基于已有值拼接，普通赋值直接覆盖。
  const existing = varScope.get(ev.name) ?? ''
  const combined = ev.isAppend ? existing + ev.value : ev.value
  // 2. 只要任一部分含运行时占位符，合并结果就不能再当作纯字面量。
  varScope.set(
    ev.name,
    containsAnyPlaceholder(combined) ? VAR_PLACEHOLDER : combined,
  )
}

/**
 * 去掉单引号 raw_string 的外层引号。
 *
 * @param text raw_string 原始文本。
 * @returns 去掉首尾引号后的字面量内容。
 */
function stripRawString(text: string): string {
  // 1. tree-sitter raw_string 文本包含外层单引号，内部内容按字面量保留。
  return text.slice(1, -1)
}

/**
 * 构造统一的 too-complex 结果。
 *
 * @param node 触发拒绝的 AST 节点。
 * @returns 带原因和节点类型的 too-complex 结果。
 */
function tooComplex(node: Node): ParseForSecurityResult {
  // 1. 根据节点类型给出可诊断原因：解析错误、已知危险节点或未处理节点。
  const reason =
    node.type === 'ERROR'
      ? 'Parse error'
      : DANGEROUS_TYPES.has(node.type)
        ? `Contains ${node.type}`
        : `Unhandled node type: ${node.type}`
  return { kind: 'too-complex', reason, nodeType: node.type }
}

// ────────────────────────────────────────────────────────────────────────────
// argv 后置语义检查
//
// 上半部分解决“能否可靠分词”，这里解决“分词结果本身是否仍有执行、泄密或解析绕过风险”。
// 这些规则需要面对每一个抽取出的 SimpleCommand，因此放在 AST 结果层统一处理。
// ────────────────────────────────────────────────────────────────────────────

/**
 * zsh 模块内建命令集合。
 *
 * 这些名字不是 PATH 上的普通二进制，而是 zsh 通过 zmodload 暴露的内部能力。BashTool 使用用户默认 shell，
 * 在默认 shell 可能是 zsh 的场景下，AST 只能看到普通 command 节点，因此必须按命令名阻断。
 */
const ZSH_DANGEROUS_BUILTINS = new Set([
  'zmodload',
  'emulate',
  'sysopen',
  'sysread',
  'syswrite',
  'sysseek',
  'zpty',
  'ztcp',
  'zsocket',
  'zf_rm',
  'zf_mv',
  'zf_ln',
  'zf_chmod',
  'zf_chown',
  'zf_mkdir',
  'zf_rmdir',
  'zf_chgrp',
])

/**
 * 会把参数当作 shell 代码执行，或会绕开 argv 静态模型的内建命令集合。
 *
 * 例如 `eval "rm -rf /"` 在 argv 里看起来只是普通字符串，但运行时会执行该字符串；这类命令按命令替换同等风险处理。
 */
const EVAL_LIKE_BUILTINS = new Set([
  'eval',
  'source',
  '.',
  'exec',
  'command',
  'builtin',
  'fc',
  // coproc 会把后续命令作为协进程启动；解析结果只看到 coproc，容易绕过真实命令检查。
  'coproc',
  // zsh 前置修饰符会包装真实命令，argv[0] 不是实际执行对象。
  'noglob',
  'nocorrect',
  // trap 会在信号或退出时执行字符串代码，EXIT 在每次 BashTool 调用结束时都会触发。
  'trap',
  // enable -f 可把任意共享库加载成内建命令，属于原生代码执行。
  'enable',
  // mapfile/readarray 的回调参数会按行周期执行 shell 代码。
  'mapfile',
  'readarray',
  // hash -p 会污染 Bash 命令查找缓存，让后续同名命令解析到指定路径。
  'hash',
  // bind/complete/compgen 可注册或触发补全回调，其中 compgen -C 会立即执行命令。
  'bind',
  'complete',
  'compgen',
  // alias 在特定 shell 设置下可影响后续命令解析，作为纵深防御阻断。
  'alias',
  // let 会对表达式做算术求值，数组下标中的 `$()` 即使来自单引号也会在求值时执行。
  'let',
])

/**
 * 会把 NAME 操作数重新解析并对数组下标做算术求值的内建命令 flag 映射。
 *
 * 映射关系为“内建命令名 -> 后一个参数是 NAME 的 flag 集合”；即使 NAME 来自单引号，Bash 仍可能执行下标中的 `$()`。
 */
const SUBSCRIPT_EVAL_FLAGS: Record<string, Set<string>> = {
  test: new Set(['-v', '-R']),
  '[': new Set(['-v', '-R']),
  '[[': new Set(['-v', '-R']),
  printf: new Set(['-v']),
  read: new Set(['-a']),
  unset: new Set(['-v']),
  // Bash 5.1+ 的 wait -p 会把等待结果写入变量；变量名若是数组下标，同样会触发下标算术求值。
  wait: new Set(['-p']),
}

/**
 * `[[ ARG1 OP ARG2 ]]` 的算术比较操作符集合。
 *
 * Bash 会把比较两侧都当作算术表达式求值，数组下标里的 `$()` 也会执行；由于危险下标可能出现在操作符任意一侧，
 * 不能复用“flag 后一个参数是 NAME”的检查方式，只能按二元操作符邻近参数单独处理。
 */
const TEST_ARITH_CMP_OPS = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge'])

/**
 * 每个非 flag 位置参数都会被 Bash 当作变量名重新解析的内建命令集合。
 *
 * 这些命令不需要额外 flag 就会把 `arr[EXPR]` 当作变量名下标求值，因此单引号里的 `$()` 仍可能执行。
 * printf、test 等位置参数不是变量名，不纳入此集合；declare/typeset/local 已在声明节点中处理。
 */
const BARE_SUBSCRIPT_NAME_BUILTINS = new Set(['read', 'unset'])

/**
 * `read` 中下一个参数表示数据而不是变量名的 flag 集合。
 *
 * 例如 `read -p '[foo] ' var` 的提示字符串不应因为 `[` 被误判；`-a` 的操作数是数组名，所以故意不放入。
 */
const READ_DATA_FLAGS = new Set(['-p', '-d', '-n', '-N', '-t', '-u', '-i'])

// shell 保留字不应成为合法 argv[0]；如果出现，说明解析器把复合结构误拆成了普通命令。

/** /proc 环境变量文件检测；使用 `.*` 覆盖 procfs 中可通过 `..` 归一化的路径。 */
const PROC_ENVIRON_RE = /\/proc\/.*\/environ/

/**
 * argv、环境变量或重定向目标中的“换行后注释”形态。
 *
 * 下游按行重新分词时会把 `#` 后内容当作注释，可能隐藏后续参数。
 */
const NEWLINE_HASH_RE = /\n[ \t]*#/

/** 语义检查结果；成功为 ok，失败携带第一条可解释原因。 */
export type SemanticCheckResult = { ok: true } | { ok: false; reason: string }

/**
 * 对已抽取 argv 的简单命令执行语义安全检查。
 *
 * @param commands `parseForSecurity` 成功返回的简单命令列表。
 * @returns 所有命令通过时返回 `{ ok: true }`；否则返回第一条危险原因。
 */
export function checkSemantics(commands: SimpleCommand[]): SemanticCheckResult {
  // 1. 逐条检查简单命令，任何一条危险就返回失败。
  for (const cmd of commands) {
    // 2. 剥离安全包装命令，确保真正被执行的内部命令名接受检查。
    let a = cmd.argv
    for (;;) {
      if (a[0] === 'time' || a[0] === 'nohup') {
        a = a.slice(1)
      } else if (a[0] === 'timeout') {
        // 3. timeout 会包装真实命令，需要跳过已知安全参数和时长后继续检查被包装命令。
        // 4. 未识别 flag 或无法解释的参数会让真实命令位置不可确定，必须保守失败，不能把 timeout 本身当作最终命令。
        let i = 1
        while (i < a.length) {
          const arg = a[i]!
          if (
            arg === '--foreground' ||
            arg === '--preserve-status' ||
            arg === '--verbose'
          ) {
            i++ // 已知无值长参数。
          } else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(arg)) {
            i++ // --kill-after=5 或 --signal=TERM 形式。
          } else if (
            (arg === '--kill-after' || arg === '--signal') &&
            a[i + 1] &&
            /^[A-Za-z0-9_.+-]+$/.test(a[i + 1]!)
          ) {
            i += 2 // --kill-after 5 或 --signal TERM 分离形式。
          } else if (arg.startsWith('--')) {
            // 5. 未知长参数或值不可证明安全时，无法定位被包装命令，直接拒绝。
            return {
              ok: false,
              reason: `timeout with ${arg} flag cannot be statically analyzed`,
            }
          } else if (arg === '-v') {
            i++ // -v 无参数。
          } else if (
            (arg === '-k' || arg === '-s') &&
            a[i + 1] &&
            /^[A-Za-z0-9_.+-]+$/.test(a[i + 1]!)
          ) {
            i += 2 // -k DURATION 或 -s SIGNAL 分离形式。
          } else if (/^-[ks][A-Za-z0-9_.+-]+$/.test(arg)) {
            i++ // -k5 或 -sTERM 紧贴形式。
          } else if (arg.startsWith('-')) {
            // 6. 未知短参数或值不可证明安全时，同样拒绝。
            return {
              ok: false,
              reason: `timeout with ${arg} flag cannot be statically analyzed`,
            }
          } else {
            break // 第一个非 flag 应该是时长。
          }
        }
        if (a[i] && /^\d+(?:\.\d+)?[smhd]?$/.test(a[i]!)) {
          a = a.slice(i + 1)
        } else if (a[i]) {
          // 7. GNU timeout 接受多种浮点/无穷大时长写法；正则无法覆盖时宁可拒绝，避免漏检被包装的 eval 等命令。
          return {
            ok: false,
            reason: `timeout duration '${a[i]}' cannot be statically analyzed`,
          }
        } else {
          break // 没有被包装命令时 timeout 本身无动作。
        }
      } else if (a[0] === 'nice') {
        // 8. nice 只调整优先级，真实命令在其后；必须剥离 nice 后检查被包装命令。
        if (a[1] === '-n' && a[2] && /^-?\d+$/.test(a[2])) {
          a = a.slice(3)
        } else if (a[1] && /^-\d+$/.test(a[1])) {
          a = a.slice(2) // 旧式 `nice -10 cmd`。
        } else if (a[1] && /[$(`]/.test(a[1])) {
          // 9. nice 的优先级参数如果来自展开，运行时可能变成旧式 `-5` 并隐藏真实命令，必须拒绝。
          return {
            ok: false,
            reason: `nice argument '${a[1]}' contains expansion — cannot statically determine wrapped command`,
          }
        } else {
          a = a.slice(1) // 裸 `nice cmd`。
        }
      } else if (a[0] === 'env') {
        // 10. env 会在修改环境后运行真实命令；只跳过已知安全形式，-S/-C/-P 或未知 flag 会改变解析或执行位置，必须拒绝。
        let i = 1
        while (i < a.length) {
          const arg = a[i]!
          if (arg.includes('=') && !arg.startsWith('-')) {
            i++ // 环境变量赋值。
          } else if (arg === '-i' || arg === '-0' || arg === '-v') {
            i++ // 无参数安全 flag。
          } else if (arg === '-u' && a[i + 1]) {
            i += 2 // -u NAME 消费一个变量名参数。
          } else if (arg.startsWith('-')) {
            // 11. 未知或会拆分 argv/改变目录/PATH 的 flag 无法建模，拒绝整个命令。
            return {
              ok: false,
              reason: `env with ${arg} flag cannot be statically analyzed`,
            }
          } else {
            break // 定位到被包装命令。
          }
        }
        if (i < a.length) {
          a = a.slice(i)
        } else {
          break // 只有 env 没有被包装命令时无动作。
        }
      } else if (a[0] === 'stdbuf') {
        // 12. stdbuf 会包装真实命令，支持紧贴、分离和长参数形式；必须完整跳过已知 flag 后再检查内部命令。
        // 13. 未知形式会让真实命令位置不可确定，直接拒绝，避免 `eval` 等命令被前置参数隐藏。
        let i = 1
        while (i < a.length) {
          const arg = a[i]!
          if (STDBUF_SHORT_SEP_RE.test(arg) && a[i + 1]) {
            i += 2 // -o MODE 分离形式。
          } else if (STDBUF_SHORT_FUSED_RE.test(arg)) {
            i++ // -o0 紧贴形式。
          } else if (STDBUF_LONG_RE.test(arg)) {
            i++ // --output=MODE 长参数等号形式。
          } else if (arg.startsWith('-')) {
            // 14. 空格分离的长参数或未知参数无法安全穷举，保守拒绝。
            return {
              ok: false,
              reason: `stdbuf with ${arg} flag cannot be statically analyzed`,
            }
          } else {
            break // 定位到被包装命令。
          }
        }
        if (i > 1 && i < a.length) {
          a = a.slice(i)
        } else {
          break // stdbuf 没有 flag 或没有被包装命令时无动作。
        }
      } else {
        break
      }
    }
    const name = a[0]
    if (name === undefined) continue

    // 15. 空命令名可能来自未加引号的空展开；真实 Bash 会丢弃空字段并执行后续词，必须拒绝。
    if (name === '') {
      return {
        ok: false,
        reason: 'Empty command name — argv[0] may not reflect what bash runs',
      }
    }

    // 16. argv[0] 不应是占位符；如果上游漏过，说明命令名运行时决定，直接判定不安全。
    if (name.includes(CMDSUB_PLACEHOLDER) || name.includes(VAR_PLACEHOLDER)) {
      return {
        ok: false,
        reason: 'Command name is runtime-determined (placeholder argv[0])',
      }
    }

    // 17. argv[0] 以操作符或 flag 开头时更像残缺片段，不是可信命令名。
    if (name.startsWith('-') || name.startsWith('|') || name.startsWith('&')) {
      return {
        ok: false,
        reason: 'Command appears to be an incomplete fragment',
      }
    }

    // 18. 部分内建会把 NAME 参数重新解析并对数组下标做算术求值；无论分离还是紧贴 flag 都要检查 NAME 中的 `[`。
    const dangerFlags = SUBSCRIPT_EVAL_FLAGS[name]
    if (dangerFlags !== undefined) {
      for (let i = 1; i < a.length; i++) {
        const arg = a[i]!
        // 19. 分离形式：危险 flag 后一个参数是 NAME。
        if (dangerFlags.has(arg) && a[i + 1]?.includes('[')) {
          return {
            ok: false,
            reason: `'${name} ${arg}' operand contains array subscript — bash evaluates $(cmd) in subscripts`,
          }
        }
        // 20. 组合短参数中如果包含危险 flag，后一个参数同样按 NAME 检查。
        if (
          arg.length > 2 &&
          arg[0] === '-' &&
          arg[1] !== '-' &&
          !arg.includes('[')
        ) {
          for (const flag of dangerFlags) {
            if (flag.length === 2 && arg.includes(flag[1]!)) {
              if (a[i + 1]?.includes('[')) {
                return {
                  ok: false,
                  reason: `'${name} ${flag}' (combined in '${arg}') operand contains array subscript — bash evaluates $(cmd) in subscripts`,
                }
              }
            }
          }
        }
        // 21. 紧贴形式：短 flag 和 NAME 位于同一个参数中。
        for (const flag of dangerFlags) {
          if (
            flag.length === 2 &&
            arg.startsWith(flag) &&
            arg.length > 2 &&
            arg.includes('[')
          ) {
            return {
              ok: false,
              reason: `'${name} ${flag}' (fused) operand contains array subscript — bash evaluates $(cmd) in subscripts`,
            }
          }
        }
      }
    }

    // 22. `[[ ARG OP ARG ]]` 的算术比较会求值两侧操作数；危险数组下标可出现在操作符任意一侧。
    if (name === '[[') {
      // 23. 二元操作符不会出现在索引 2 之前，左右邻近参数都要检查。
      for (let i = 2; i < a.length; i++) {
        if (!TEST_ARITH_CMP_OPS.has(a[i]!)) continue
        if (a[i - 1]?.includes('[') || a[i + 1]?.includes('[')) {
          return {
            ok: false,
            reason: `'[[ ... ${a[i]} ... ]]' operand contains array subscript — bash arithmetically evaluates $(cmd) in subscripts`,
          }
        }
      }
    }

    // 24. read/unset 的裸位置参数都是 NAME，不需要 flag 就可能触发数组下标求值；但 read 的提示、分隔符等数据参数要跳过。
    if (BARE_SUBSCRIPT_NAME_BUILTINS.has(name)) {
      let skipNext = false
      for (let i = 1; i < a.length; i++) {
        const arg = a[i]!
        if (skipNext) {
          skipNext = false
          continue
        }
        if (arg[0] === '-') {
          if (name === 'read') {
            if (READ_DATA_FLAGS.has(arg)) {
              skipNext = true
            } else if (arg.length > 2 && arg[1] !== '-') {
              // 25. 组合短参数里数据 flag 若位于末尾，则下一个参数是数据值；否则当前参数剩余部分已被消费。
              for (let j = 1; j < arg.length; j++) {
                if (READ_DATA_FLAGS.has('-' + arg[j])) {
                  if (j === arg.length - 1) skipNext = true
                  break
                }
              }
            }
          }
          continue
        }
        if (arg.includes('[')) {
          return {
            ok: false,
            reason: `'${name}' positional NAME '${arg}' contains array subscript — bash evaluates $(cmd) in subscripts`,
          }
        }
      }
    }

    // 26. shell 保留字出现在 argv[0] 说明解析器可能把复合结构误拆成普通命令，直接拒绝。
    if (SHELL_KEYWORDS.has(name)) {
      return {
        ok: false,
        reason: `Shell keyword '${name}' as command name — tree-sitter mis-parse`,
      }
    }

    // 27. 检查 argv/env/redirect 中的“换行后注释”形态，避免下游按行分词时隐藏后续路径参数。
    for (const arg of cmd.argv) {
      if (arg.includes('\n') && NEWLINE_HASH_RE.test(arg)) {
        return {
          ok: false,
          reason:
            'Newline followed by # inside a quoted argument can hide arguments from path validation',
        }
      }
    }
    for (const ev of cmd.envVars) {
      if (ev.value.includes('\n') && NEWLINE_HASH_RE.test(ev.value)) {
        return {
          ok: false,
          reason:
            'Newline followed by # inside an env var value can hide arguments from path validation',
        }
      }
    }
    for (const r of cmd.redirects) {
      if (r.target.includes('\n') && NEWLINE_HASH_RE.test(r.target)) {
        return {
          ok: false,
          reason:
            'Newline followed by # inside a redirect target can hide arguments from path validation',
        }
      }
    }

    // 28. jq 的 system() 会执行 shell，部分读取文件类 flag 也会扩大访问面；AST 成功路径要复刻旧校验器的防护。
    if (name === 'jq') {
      for (const arg of a) {
        if (/\bsystem\s*\(/.test(arg)) {
          return {
            ok: false,
            reason:
              'jq command contains system() function which executes arbitrary commands',
          }
        }
      }
      if (
        a.some(arg =>
          /^(?:-[fL](?:$|[^A-Za-z])|--(?:from-file|rawfile|slurpfile|library-path)(?:$|=))/.test(
            arg,
          ),
        )
      ) {
        return {
          ok: false,
          reason:
            'jq command contains dangerous flags that could execute code or read arbitrary files',
        }
      }
    }

    if (ZSH_DANGEROUS_BUILTINS.has(name)) {
      return {
        ok: false,
        reason: `Zsh builtin '${name}' can bypass security checks`,
      }
    }

    if (EVAL_LIKE_BUILTINS.has(name)) {
      // 29. `command -v/-V` 只是查询路径可以继续检查；裸 `command foo` 会绕过函数/别名解析，保持阻断。
      if (name === 'command' && (a[1] === '-v' || a[1] === '-V')) {
        // 30. 继续执行后续检查。
      } else if (
        name === 'fc' &&
        !a.slice(1).some(arg => /^-[^-]*[es]/.test(arg))
      ) {
        // 31. fc 仅列历史时安全；带 e/s 的形式会编辑或重放命令，按 eval 类处理。
      } else if (
        name === 'compgen' &&
        !a.slice(1).some(arg => /^-[^-]*[CFW]/.test(arg))
      ) {
        // 32. compgen 的安全小写参数只列补全；C/F/W 会执行命令、调用函数或展开词表，必须阻断。
      } else {
        return {
          ok: false,
          reason: `'${name}' evaluates arguments as shell code`,
        }
      }
    }

    // 33. /proc/*/environ 会暴露进程环境变量和潜在密钥；argv 和重定向目标都要检查。
    for (const arg of cmd.argv) {
      if (arg.includes('/proc/') && PROC_ENVIRON_RE.test(arg)) {
        return {
          ok: false,
          reason: 'Accesses /proc/*/environ which may expose secrets',
        }
      }
    }
    for (const r of cmd.redirects) {
      if (r.target.includes('/proc/') && PROC_ENVIRON_RE.test(r.target)) {
        return {
          ok: false,
          reason: 'Accesses /proc/*/environ which may expose secrets',
        }
      }
    }
  }
  return { ok: true }
}
