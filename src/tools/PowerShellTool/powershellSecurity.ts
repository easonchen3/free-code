/**
 * PowerShell 命令安全分析模块。
 *
 * 该文件基于 PowerShell 原生 AST 识别难以静态证明安全的命令形态，例如动态执行、下载后执行、提权、嵌套 PowerShell、COM/.NET 访问和持久化入口。
 * 这里的策略不是直接拒绝命令，而是在风险无法被允许列表准确覆盖时返回 `ask`，让权限层把决策交给用户确认。
 */

import {
  DANGEROUS_SCRIPT_BLOCK_CMDLETS,
  FILEPATH_EXECUTION_CMDLETS,
  MODULE_LOADING_CMDLETS,
} from '../../utils/powershell/dangerousCmdlets.js'
import type {
  ParsedCommandElement,
  ParsedPowerShellCommand,
} from '../../utils/powershell/parser.js'
import {
  COMMON_ALIASES,
  commandHasArgAbbreviation,
  deriveSecurityFlags,
  getAllCommands,
  getVariablesByScope,
  hasCommandNamed,
} from '../../utils/powershell/parser.js'
import { isClmAllowedType } from './clmTypes.js'

/** PowerShell 安全检查的标准返回结构，用于告诉权限层继续后续规则、询问用户或直接允许。 */
type PowerShellSecurityResult = {
  /** 当前规则的处理结果；`passthrough` 表示继续检查，`ask` 表示需要用户确认，`allow` 预留给明确放行场景。 */
  behavior: 'passthrough' | 'ask' | 'allow'
  /** 需要询问用户时展示的风险说明。 */
  message?: string
}

/** 可被识别为 PowerShell 运行时的可执行文件名，统一用小写形态匹配。 */
const POWERSHELL_EXECUTABLES = new Set([
  'pwsh',
  'pwsh.exe',
  'powershell',
  'powershell.exe',
])

/**
 * 判断命令名是否指向 PowerShell 可执行文件。
 *
 * @param name 命令名或带目录的可执行文件路径。
 * @returns 名称或路径 basename 是 pwsh/powershell 时返回 true。
 */
function isPowerShellExecutable(name: string): boolean {
  // 1. 先用原始命令名的小写形式匹配，覆盖直接写 pwsh/powershell 的场景。
  const lower = name.toLowerCase()
  if (POWERSHELL_EXECUTABLES.has(lower)) {
    return true
  }
  // 2. 如果传入的是路径，则同时兼容 POSIX `/` 和 Windows `\` 分隔符提取 basename。
  const lastSep = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'))
  if (lastSep >= 0) {
    return POWERSHELL_EXECUTABLES.has(lower.slice(lastSep + 1))
  }
  return false
}

/**
 * PowerShell 接受的非标准参数前缀集合。
 *
 * PowerShell 词法器会把这些字符视作普通 `-` 的等价写法，Windows PowerShell 5.1 还接受 `/` 作为参数分隔符；AST 原文会保留这些字符，因此安全规则必须主动归一化。
 */
const PS_ALT_PARAM_PREFIXES = new Set([
  '/', // Windows PowerShell 5.1 的参数分隔符，pwsh 7+ 通常不使用。
  '\u2013', // 短破折号。
  '\u2014', // 长破折号。
  '\u2015', // 横线字符。
])

/**
 * 按 PowerShell 参数缩写规则检查命令参数，并兼容非标准 dash 前缀。
 *
 * @param cmd 已解析出的命令元素。
 * @param fullParam 完整参数名，例如 `-encodedcommand`。
 * @param minPrefix 允许匹配的最短缩写，例如 `-e`。
 * @returns 参数以标准或非标准前缀命中缩写规则时返回 true。
 */
function psExeHasParamAbbreviation(
  cmd: ParsedCommandElement,
  fullParam: string,
  minPrefix: string,
): boolean {
  // 1. 先按标准 `-` 参数前缀检查，覆盖最常见的 PowerShell 参数写法。
  if (commandHasArgAbbreviation(cmd, fullParam, minPrefix)) {
    return true
  }
  // 2. 再把 PowerShell 也接受的替代前缀归一化为 `-`，避免绕过风险参数检测。
  const normalized: ParsedCommandElement = {
    ...cmd,
    args: cmd.args.map(a =>
      a.length > 0 && PS_ALT_PARAM_PREFIXES.has(a[0]!) ? '-' + a.slice(1) : a,
    ),
  }
  return commandHasArgAbbreviation(normalized, fullParam, minPrefix)
}

/**
 * 检查命令是否使用 `Invoke-Expression` 或别名 `iex`。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 命中动态求值命令时返回 ask，否则继续后续规则。
 */
function checkInvokeExpression(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. `Invoke-Expression` 等同于 eval，无法仅通过参数允许列表证明安全。
  if (hasCommandNamed(parsed, 'Invoke-Expression')) {
    return {
      behavior: 'ask',
      message:
        'Command uses Invoke-Expression which can execute arbitrary code',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查命令名本身是否来自运行时表达式。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 命令名不是静态字符串且无法安全解析时返回 ask。
 */
function checkDynamicCommandName(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. 遍历所有命令节点，只对真正的 CommandAst 判断命令名形态。
  for (const cmd of getAllCommands(parsed)) {
    if (cmd.elementType !== 'CommandAst') {
      continue
    }
    // 2. 合法命令名应是静态字符串；变量、索引、拼接等表达式会在运行时解析成真实命令。
    const nameElementType = cmd.elementTypes?.[0]
    if (nameElementType !== undefined && nameElementType !== 'StringConstant') {
      return {
        behavior: 'ask',
        message:
          'Command name is a dynamic expression which cannot be statically validated',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查嵌套 PowerShell 是否使用编码命令参数。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns PowerShell 可执行文件携带 `-EncodedCommand` 缩写时返回 ask。
 */
function checkEncodedCommand(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. 只有 PowerShell 进程本身理解 encoded command，因此先限定命令名。
  for (const cmd of getAllCommands(parsed)) {
    if (isPowerShellExecutable(cmd.name)) {
      // 2. 编码参数隐藏真实意图，必须询问用户确认。
      if (psExeHasParamAbbreviation(cmd, '-encodedcommand', '-e')) {
        return {
          behavior: 'ask',
          message: 'Command uses encoded parameters which obscure intent',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查命令是否重新启动 PowerShell 子进程。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 发现嵌套 PowerShell 进程时返回 ask。
 */
function checkPwshCommandOrFile(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. 只要命令位是 PowerShell 可执行文件，就可能通过 stdin、位置参数或脚本文件执行未解析代码。
  for (const cmd of getAllCommands(parsed)) {
    if (isPowerShellExecutable(cmd.name)) {
      return {
        behavior: 'ask',
        message:
          'Command spawns a nested PowerShell process which cannot be validated',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 下载器命令集合，用于识别“下载远端内容”这半段风险链路。
 */
const DOWNLOADER_NAMES = new Set([
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',
  'new-object',
  'start-bitstransfer', // BITS 文件传输能力，常见于持久化或下载载荷场景。
])

/**
 * 判断命令名是否属于下载器集合。
 *
 * @param name 待检查的命令名。
 * @returns 命令可以获取远端内容时返回 true。
 */
function isDownloader(name: string): boolean {
  // 1. 下载器名称统一按小写匹配，兼容 PowerShell 命令大小写不敏感的语义。
  return DOWNLOADER_NAMES.has(name.toLowerCase())
}

/**
 * 判断命令名是否是 `Invoke-Expression` 或 `iex`。
 *
 * @param name 待检查的命令名。
 * @returns 命令会执行字符串内容时返回 true。
 */
function isIex(name: string): boolean {
  // 1. 归一化大小写后同时匹配完整命令和常用别名。
  const lower = name.toLowerCase()
  return lower === 'invoke-expression' || lower === 'iex'
}

/**
 * 检查“下载后立即执行”的 cradle 组合。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 同一语句或跨语句同时出现下载器和 IEX 时返回 ask。
 */
function checkDownloadCradles(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. 先按单条语句检查管道式 cradle，例如 `IWR ... | IEX`。
  for (const statement of parsed.statements) {
    const cmds = statement.commands
    if (cmds.length < 2) {
      continue
    }
    const hasDownloader = cmds.some(cmd => isDownloader(cmd.name))
    const hasIex = cmds.some(cmd => isIex(cmd.name))
    if (hasDownloader && hasIex) {
      return {
        behavior: 'ask',
        message: 'Command downloads and executes remote code',
      }
    }
  }

  // 2. 再检查跨语句拆开的 cradle，用更准确的提示解释“下载并执行”风险。
  const all = getAllCommands(parsed)
  if (all.some(c => isDownloader(c.name)) && all.some(c => isIex(c.name))) {
    return {
      behavior: 'ask',
      message: 'Command downloads and executes remote code',
    }
  }

  return { behavior: 'passthrough' }
}

/**
 * 检查独立下载工具调用。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 命令本身具备下载文件能力且无法证明用途安全时返回 ask。
 */
function checkDownloadUtilities(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. 对每个命令做名称级匹配，覆盖 PowerShell cmdlet 和 Windows 原生命令。
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    // 2. Start-BitsTransfer 语义就是文件传输，不区分更细的安全子场景。
    if (lower === 'start-bitstransfer') {
      return {
        behavior: 'ask',
        message: 'Command downloads files via BITS transfer',
      }
    }
    // 3. certutil 只有携带 urlcache 时才按下载风险处理，避免误伤证书查询等正常用途。
    if (lower === 'certutil' || lower === 'certutil.exe') {
      const hasUrlcache = cmd.args.some(a => {
        const la = a.toLowerCase()
        return la === '-urlcache' || la === '/urlcache'
      })
      if (hasUrlcache) {
        return {
          behavior: 'ask',
          message: 'Command uses certutil to download from a URL',
        }
      }
    }
    // 4. bitsadmin 的 /transfer 是旧版 BITS 下载入口，风险等同于 Start-BitsTransfer。
    if (lower === 'bitsadmin' || lower === 'bitsadmin.exe') {
      if (cmd.args.some(a => a.toLowerCase() === '/transfer')) {
        return {
          behavior: 'ask',
          message: 'Command downloads files via BITS transfer',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查是否通过 `Add-Type` 动态编译并加载 .NET 代码。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 命中 `Add-Type` 时返回 ask。
 */
function checkAddType(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. Add-Type 会把源码编译进当前运行时，静态命令允许列表无法覆盖其真实行为。
  if (hasCommandNamed(parsed, 'Add-Type')) {
    return {
      behavior: 'ask',
      message: 'Command compiles and loads .NET code',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 `New-Object` 是否创建 COM 对象或受限语言模式外的 .NET 类型。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 命中 COM 创建或不在 CLM allowlist 的类型创建时返回 ask。
 */
function checkComObject(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. 只分析 New-Object；其他命令交给对应规则处理。
  for (const cmd of getAllCommands(parsed)) {
    if (cmd.name.toLowerCase() !== 'new-object') {
      continue
    }
    // 2. `-ComObject` 可以访问带执行或下载能力的 COM 组件，最短安全缩写按 `-com` 判断。
    if (psExeHasParamAbbreviation(cmd, '-comobject', '-com')) {
      return {
        behavior: 'ask',
        message:
          'Command instantiates a COM object which may have execution capabilities',
      }
    }
    // 3. New-Object 的 TypeName 可能只是字符串参数，不会进入 typeLiterals，因此需要从参数绑定里提取。
    let typeName: string | undefined
    for (let i = 0; i < cmd.args.length; i++) {
      const a = cmd.args[i]!
      const lower = a.toLowerCase()
      // 4. 先处理 `-TypeName:Foo.Bar` 这类冒号绑定形式。
      if (lower.startsWith('-t') && lower.includes(':')) {
        const colonIdx = a.indexOf(':')
        const paramPart = lower.slice(0, colonIdx)
        if ('-typename'.startsWith(paramPart)) {
          typeName = a.slice(colonIdx + 1)
          break
        }
      }
      // 5. 再处理 `-TypeName Foo.Bar` 这种空格分隔形式。
      if (
        lower.startsWith('-t') &&
        '-typename'.startsWith(lower) &&
        cmd.args[i + 1] !== undefined
      ) {
        typeName = cmd.args[i + 1]
        break
      }
    }
    // 6. 如果没有命名参数，则按 New-Object 默认绑定规则寻找第一个未被参数消费的位置参数。
    if (typeName === undefined) {
      // 7. 这些命名参数会消费后一个值，扫描位置参数时需要跳过。
      const VALUE_PARAMS = new Set(['-argumentlist', '-comobject', '-property'])
      // 8. switch 参数不消费后续值，只跳过自身。
      const SWITCH_PARAMS = new Set(['-strict'])
      for (let i = 0; i < cmd.args.length; i++) {
        const a = cmd.args[i]!
        if (a.startsWith('-')) {
          const lower = a.toLowerCase()
          // 9. TypeName 命名形式前面已经处理，这里只跳过其值避免重复识别。
          if (lower.startsWith('-t') && '-typename'.startsWith(lower)) {
            i++ // 跳过 TypeName 的值。
            continue
          }
          // 10. 冒号绑定的参数值已经在同一 token 内，不需要额外跳过。
          if (lower.includes(':')) continue
          if (SWITCH_PARAMS.has(lower)) continue
          if (VALUE_PARAMS.has(lower)) {
            i++ // 跳过被命名参数消费的值。
            continue
          }
          // 11. 未知参数保守跳过，避免把参数名误当作类型名。
          continue
        }
        // 12. 第一个非参数 token 按位置绑定为 TypeName。
        typeName = a
        break
      }
    }
    // 13. 最后用受限语言模式 allowlist 判断该 .NET 类型是否可接受。
    if (typeName !== undefined && !isClmAllowedType(typeName)) {
      return {
        behavior: 'ask',
        message: `New-Object instantiates .NET type '${typeName}' outside the ConstrainedLanguage allowlist`,
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查危险脚本块 cmdlet 是否通过文件路径执行脚本。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 命中 `-FilePath`、`-LiteralPath` 或位置脚本路径时返回 ask。
 */
function checkDangerousFilePathExecution(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. 先把别名解析成规范 cmdlet 名称，只检查可通过文件路径执行脚本的命令。
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    const resolved = COMMON_ALIASES[lower]?.toLowerCase() ?? lower
    if (!FILEPATH_EXECUTION_CMDLETS.has(resolved)) {
      continue
    }
    // 2. 命名参数形式会直接让目标 cmdlet 加载并执行脚本文件。
    if (
      psExeHasParamAbbreviation(cmd, '-filepath', '-f') ||
      psExeHasParamAbbreviation(cmd, '-literalpath', '-l')
    ) {
      return {
        behavior: 'ask',
        message: `${cmd.name} -FilePath executes an arbitrary script file`,
      }
    }
    // 3. 位置参数也可能绑定到 FilePath；宁可提示用户，也不静默放过脚本文件执行。
    for (let i = 0; i < cmd.args.length; i++) {
      const argType = cmd.elementTypes?.[i + 1]
      const arg = cmd.args[i]
      if (argType === 'StringConstant' && arg && !arg.startsWith('-')) {
        return {
          behavior: 'ask',
          message: `${cmd.name} with positional string argument binds to -FilePath and executes a script file`,
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 `ForEach-Object -MemberName` 这类按字符串调用成员的方法。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 命中命名或位置形式的 MemberName 调用时返回 ask。
 */
function checkForEachMemberName(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. 解析 foreach 相关别名后，只处理 ForEach-Object。
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    const resolved = COMMON_ALIASES[lower]?.toLowerCase() ?? lower
    if (resolved !== 'foreach-object') {
      continue
    }
    // 2. `-MemberName` 会按字符串调用对象方法，AST 中不会出现普通方法调用节点。
    if (psExeHasParamAbbreviation(cmd, '-membername', '-m')) {
      return {
        behavior: 'ask',
        message:
          'ForEach-Object -MemberName invokes methods by string name which cannot be validated',
      }
    }
    // 3. PS7 会把位置字符串绑定到 MemberName，因此所有非参数字符串都要按潜在方法名处理。
    for (let i = 0; i < cmd.args.length; i++) {
      const argType = cmd.elementTypes?.[i + 1]
      const arg = cmd.args[i]
      if (argType === 'StringConstant' && arg && !arg.startsWith('-')) {
        return {
          behavior: 'ask',
          message:
            'ForEach-Object with positional string argument binds to -MemberName and invokes methods by name',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 `Start-Process` 的提权和嵌套 PowerShell 风险。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 请求 RunAs 提权或启动 PowerShell 子进程时返回 ask。
 */
function checkStartProcess(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. 只处理 Start-Process 及其常见别名。
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (lower !== 'start-process' && lower !== 'saps' && lower !== 'start') {
      continue
    }
    // 2. 空格分隔的 `-Verb RunAs` 会触发 UAC 提权，需要用户显式确认。
    if (
      psExeHasParamAbbreviation(cmd, '-Verb', '-v') &&
      cmd.args.some(a => a.toLowerCase() === 'runas')
    ) {
      return {
        behavior: 'ask',
        message: 'Command requests elevated privileges',
      }
    }
    // 3. 冒号绑定的 `-Verb:RunAs` 优先用 children 结构判断，能覆盖复杂引号和反引号。
    if (cmd.children) {
      for (let i = 0; i < cmd.args.length; i++) {
        // 4. 参数名里可能插入反引号，先移除再判断是否是 Verb 参数。
        const argClean = cmd.args[i]!.replace(/`/g, '')
        if (!/^[-\u2013\u2014\u2015/]v[a-z]*:/i.test(argClean)) continue
        const kids = cmd.children[i]
        if (!kids) continue
        for (const child of kids) {
          if (child.text.replace(/['"`\s]/g, '').toLowerCase() === 'runas') {
            return {
              behavior: 'ask',
              message: 'Command requests elevated privileges',
            }
          }
        }
      }
    }
    // 5. 对没有 children 细节的解析结果，再用正则兜底识别冒号绑定 RunAs。
    if (
      cmd.args.some(a => {
        // 6. 兜底正则同样先去掉反引号，避免简单规避。
        const clean = a.replace(/`/g, '')
        return /^[-\u2013\u2014\u2015/]v[a-z]*:['"` ]*runas['"` ]*$/i.test(
          clean,
        )
      })
    ) {
      return {
        behavior: 'ask',
        message: 'Command requests elevated privileges',
      }
    }
    // 7. Start-Process 启动 PowerShell 后子进程参数不再可静态验证，因此只要目标像 PowerShell 就询问。
    for (const arg of cmd.args) {
      const stripped = arg.replace(/^['"]|['"]$/g, '')
      if (isPowerShellExecutable(stripped)) {
        return {
          behavior: 'ask',
          message:
            'Start-Process launches a nested PowerShell process which cannot be validated',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 可安全消费脚本块的 cmdlet 集合。
 *
 * 这些命令把脚本块用于过滤、排序或投影，不把它当作通用执行入口。
 */
const SAFE_SCRIPT_BLOCK_CMDLETS = new Set([
  'where-object',
  'sort-object',
  'select-object',
  'group-object',
  'format-table',
  'format-list',
  'format-wide',
  'format-custom',
  // ForEach-Object 的脚本块是任意脚本而不是纯谓词，因此不能列入安全集合。
])

/**
 * 检查脚本块是否出现在可执行任意代码的上下文。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 脚本块被危险 cmdlet 消费，或无法证明只是过滤/投影用途时返回 ask。
 */
function checkScriptBlockInjection(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. 没有脚本块时无需进入该规则。
  const security = deriveSecurityFlags(parsed)
  if (!security.hasScriptBlocks) {
    return { behavior: 'passthrough' }
  }

  // 2. 危险 cmdlet 携带脚本块时，通常意味着远程执行、作业执行或动态执行。
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (DANGEROUS_SCRIPT_BLOCK_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message:
          'Command contains script block with dangerous cmdlet that may execute arbitrary code',
      }
    }
  }

  // 3. 如果所有命令都属于安全消费脚本块的集合，则继续后续规则。
  const allCommandsSafe = getAllCommands(parsed).every(cmd => {
    const lower = cmd.name.toLowerCase()
    // 4. 直接命中安全集合的 cmdlet 可以放行。
    if (SAFE_SCRIPT_BLOCK_CMDLETS.has(lower)) {
      return true
    }
    // 5. 别名需要先解析后再判断是否属于安全集合。
    const alias = COMMON_ALIASES[lower]
    if (alias && SAFE_SCRIPT_BLOCK_CMDLETS.has(alias.toLowerCase())) {
      return true
    }
    // 6. 未知命令携带脚本块时无法证明只是谓词或投影，按风险处理。
    return false
  })

  if (allCommandsSafe) {
    return { behavior: 'passthrough' }
  }

  return {
    behavior: 'ask',
    message: 'Command contains script block that may execute arbitrary code',
  }
}

/**
 * 检查是否存在 `$()` 子表达式。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 存在子表达式时返回 ask。
 */
function checkSubExpressions(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. 子表达式可以把命令执行隐藏在参数或字符串拼接中。
  if (deriveSecurityFlags(parsed).hasSubExpressions) {
    return {
      behavior: 'ask',
      message: 'Command contains subexpressions $()',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查双引号可展开字符串是否嵌入表达式。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 字符串中存在变量或命令表达式展开时返回 ask。
 */
function checkExpandableStrings(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. 可展开字符串会在运行时求值，可能隐藏变量读取或命令执行。
  if (deriveSecurityFlags(parsed).hasExpandableStrings) {
    return {
      behavior: 'ask',
      message: 'Command contains expandable strings with embedded expressions',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查是否使用 splatting 传参。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 出现 `@variable` 参数展开时返回 ask。
 */
function checkSplatting(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. splatting 会把真实参数藏在变量里，静态规则无法直接验证参数内容。
  if (deriveSecurityFlags(parsed).hasSplatting) {
    return {
      behavior: 'ask',
      message: 'Command uses splatting (@variable)',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查是否使用 PowerShell stop-parsing token。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 出现 `--%` 时返回 ask。
 */
function checkStopParsing(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. stop-parsing 会阻止后续参数被 PowerShell 正常解析，降低静态校验可信度。
  if (deriveSecurityFlags(parsed).hasStopParsing) {
    return {
      behavior: 'ask',
      message: 'Command uses stop-parsing token (--%)',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查是否调用 .NET 成员方法。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 出现实例或静态成员调用时返回 ask。
 */
function checkMemberInvocations(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. .NET 方法可能访问文件、进程、网络等系统 API，不能只按 cmdlet allowlist 放行。
  if (deriveSecurityFlags(parsed).hasMemberInvocations) {
    return {
      behavior: 'ask',
      message: 'Command invokes .NET methods',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查类型字面量是否超出 PowerShell 受限语言模式允许范围。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 发现 CLM allowlist 外的 .NET 类型时返回 ask。
 */
function checkTypeLiterals(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. 类型字面量按 CLM allowlist 逐个校验，允许基础类型转换但拦截系统 API 类型。
  for (const t of parsed.typeLiterals ?? []) {
    if (!isClmAllowedType(t)) {
      return {
        behavior: 'ask',
        message: `Command uses .NET type [${t}] outside the ConstrainedLanguage allowlist`,
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 `Invoke-Item` 是否通过系统默认处理器打开文件。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 命中 `Invoke-Item` 或 `ii` 时返回 ask。
 */
function checkInvokeItem(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. 默认处理器可能执行可执行文件或用户配置的处理程序，因此统一询问用户。
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (lower === 'invoke-item' || lower === 'ii') {
      return {
        behavior: 'ask',
        message:
          'Invoke-Item opens files with the default handler (ShellExecute). On executable files this runs arbitrary code.',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 计划任务相关持久化 cmdlet 集合。
 *
 * 这些命令可以创建或修改跨会话保留的任务，是典型持久化入口。
 */
const SCHEDULED_TASK_CMDLETS = new Set([
  'register-scheduledtask',
  'new-scheduledtask',
  'new-scheduledtaskaction',
  'set-scheduledtask',
])

/**
 * 检查是否创建或修改计划任务。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 命中计划任务 cmdlet 或 schtasks 创建/修改参数时返回 ask。
 */
function checkScheduledTask(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. PowerShell 计划任务 cmdlet 直接按名称拦截。
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (SCHEDULED_TASK_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message: `${cmd.name} creates or modifies a scheduled task (persistence primitive)`,
      }
    }
    // 2. schtasks.exe 只有 create/change 会修改持久化任务，其他查询类用法不在这里处理。
    if (lower === 'schtasks' || lower === 'schtasks.exe') {
      if (
        cmd.args.some(a => {
          const la = a.toLowerCase()
          return (
            la === '/create' ||
            la === '/change' ||
            la === '-create' ||
            la === '-change'
          )
        })
      ) {
        return {
          behavior: 'ask',
          message:
            'schtasks with create/change modifies scheduled tasks (persistence primitive)',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 会写入 `env:` 作用域的 cmdlet 或别名集合。
 *
 * 该集合用于判断命令是否可能修改后续进程或工具调用继承到的环境变量。
 */
const ENV_WRITE_CMDLETS = new Set([
  'set-item',
  'si',
  'new-item',
  'ni',
  'remove-item',
  'ri',
  'del',
  'rm',
  'rd',
  'rmdir',
  'erase',
  'clear-item',
  'cli',
  'set-content',
  // `sc` 在 PS Core 7+ 中容易和 sc.exe 冲突，因此不按 Set-Content 别名处理。
  'add-content',
  'ac',
])

/**
 * 检查命令是否修改环境变量。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 发现 env: 作用域写操作或赋值时返回 ask。
 */
function checkEnvVarManipulation(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. 没有 env: 变量引用时，不需要检查环境变量写入规则。
  const envVars = getVariablesByScope(parsed, 'env')
  if (envVars.length === 0) {
    return { behavior: 'passthrough' }
  }
  // 2. 对 env: 作用域配合写入类 cmdlet 的情况进行拦截。
  for (const cmd of getAllCommands(parsed)) {
    if (ENV_WRITE_CMDLETS.has(cmd.name.toLowerCase())) {
      return {
        behavior: 'ask',
        message: 'Command modifies environment variables',
      }
    }
  }
  // 3. 赋值语句同样会修改 env: 变量，即使没有显式写入 cmdlet。
  if (deriveSecurityFlags(parsed).hasAssignments && envVars.length > 0) {
    return {
      behavior: 'ask',
      message: 'Command modifies environment variables',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查是否加载、安装或保存 PowerShell 模块。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 命中模块加载类 cmdlet 时返回 ask。
 */
function checkModuleLoading(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. 模块文件可能在导入时执行顶层脚本，安装/保存模块还可能从远端仓库获取内容。
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (MODULE_LOADING_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message:
          'Command loads, installs, or downloads a PowerShell module or script, which can execute arbitrary code',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 会改变后续命令解析或默认参数的运行时状态 cmdlet 集合。
 *
 * 这些操作会影响当前会话之后的命令行为，单次命令静态分析无法完整追踪。
 */
const RUNTIME_STATE_CMDLETS = new Set([
  'set-alias',
  'sal',
  'new-alias',
  'nal',
  'set-variable',
  'sv',
  'new-variable',
  'nv',
])

/**
 * 检查是否修改别名或变量等运行时状态。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 命中运行时状态修改 cmdlet 时返回 ask。
 */
function checkRuntimeStateManipulation(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. 支持带模块限定名前缀的命令，先截取最后一级命令名再匹配。
  for (const cmd of getAllCommands(parsed)) {
    const raw = cmd.name.toLowerCase()
    const lower = raw.includes('\\')
      ? raw.slice(raw.lastIndexOf('\\') + 1)
      : raw
    if (RUNTIME_STATE_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message:
          'Command creates or modifies an alias or variable that can affect future command resolution',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 可通过 WMI/CIM 触发进程创建的 cmdlet 集合。
 *
 * 这些入口可以绕过 `Start-Process` 规则启动任意进程，因此统一询问用户。
 */
const WMI_SPAWN_CMDLETS = new Set([
  'invoke-wmimethod',
  'iwmi',
  'invoke-cimmethod',
])

/**
 * 检查是否通过 WMI/CIM 调用进程创建能力。
 *
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 命中相关 WMI/CIM cmdlet 时返回 ask。
 */
function checkWmiProcessSpawn(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. WMI/CIM 方法名和类名可能来自动态字符串，窄匹配 Win32_Process 并不可靠。
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (WMI_SPAWN_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message: `${cmd.name} can spawn arbitrary processes via WMI/CIM (Win32_Process Create)`,
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 对 PowerShell 命令执行安全规则总检查。
 *
 * @param command 原始 PowerShell 命令；当前保留用于兼容调用签名。
 * @param parsed PowerShell 原生 AST 转换后的命令结构。
 * @returns 首个命中的风险规则结果；全部规则通过时返回 passthrough。
 */
export function powershellCommandIsSafe(
  _command: string,
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. AST 解析失败时无法证明命令安全，默认交给用户确认。
  if (!parsed.valid) {
    return {
      behavior: 'ask',
      message: 'Could not parse command for security analysis',
    }
  }

  // 2. 按从高危显式模式到通用 AST 标志的顺序组织规则，方便返回更准确的提示。
  const validators = [
    checkInvokeExpression,
    checkDynamicCommandName,
    checkEncodedCommand,
    checkPwshCommandOrFile,
    checkDownloadCradles,
    checkDownloadUtilities,
    checkAddType,
    checkComObject,
    checkDangerousFilePathExecution,
    checkInvokeItem,
    checkScheduledTask,
    checkForEachMemberName,
    checkStartProcess,
    checkScriptBlockInjection,
    checkSubExpressions,
    checkExpandableStrings,
    checkSplatting,
    checkStopParsing,
    checkMemberInvocations,
    checkTypeLiterals,
    checkEnvVarManipulation,
    checkModuleLoading,
    checkRuntimeStateManipulation,
    checkWmiProcessSpawn,
  ]

  // 3. 命中第一个需要用户确认的规则后立即返回，避免后续规则覆盖更具体的原因。
  for (const validator of validators) {
    const result = validator(parsed)
    if (result.behavior === 'ask') {
      return result
    }
  }

  // 4. 所有规则都未命中时，交给权限 allowlist 或其他外层策略继续处理。
  return { behavior: 'passthrough' }
}
