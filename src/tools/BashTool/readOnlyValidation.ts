import type { z } from 'zod/v4'
import { getOriginalCwd } from '../../bootstrap/state.js'
import {
  extractOutputRedirections,
  splitCommand_DEPRECATED,
} from '../../utils/bash/commands.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import { getCwd } from '../../utils/cwd.js'
import { isCurrentDirectoryBareGitRepo } from '../../utils/git.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { getPlatform } from '../../utils/platform.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import {
  containsVulnerableUncPath,
  DOCKER_READ_ONLY_COMMANDS,
  EXTERNAL_READONLY_COMMANDS,
  type FlagArgType,
  GH_READ_ONLY_COMMANDS,
  GIT_READ_ONLY_COMMANDS,
  PYRIGHT_READ_ONLY_COMMANDS,
  RIPGREP_READ_ONLY_COMMANDS,
  validateFlags,
} from '../../utils/shell/readOnlyCommandValidation.js'
import type { BashTool } from './BashTool.js'
import { isNormalizedGitCommand } from './bashPermissions.js'
import { bashCommandIsSafe_DEPRECATED } from './bashSecurity.js'
import {
  COMMAND_OPERATION_TYPE,
  PATH_EXTRACTORS,
  type PathCommand,
} from './pathValidation.js'
import { sedCommandIsAllowedByAllowlist } from './sedValidation.js'

/**
 * Bash 只读命令校验模块。
 *
 * 该文件负责在 BashTool 进入普通权限检查前，识别一批可以自动放行的只读命令。
 * 它并不是沙箱，而是一个“命令是否明显只读”的前置判断：只有命令结构、参数和路径风险都可解释时才允许。
 */

/** 命令级白名单配置，描述某个命令允许哪些 flag、是否需要额外正则或自定义安全判断。 */
type CommandConfig = {
  /** 允许的 flag 及其参数类型，例如 `xargs`、`git diff` 这类命令会在这里声明可接受的参数形态。 */
  safeFlags: Record<string, FlagArgType>
  /** flag 解析之外的补充校验规则，用于约束命令整体文本必须满足的安全形态。 */
  regex?: RegExp
  /** 自定义危险判断回调，返回 true 表示命令虽然 flag 合法但仍存在写入、执行或外联风险。 */
  additionalCommandIsDangerousCallback?: (
    rawCommand: string,
    args: string[],
  ) => boolean
  /** 是否遵守 POSIX `--` 选项终止语义；少数工具不遵守时需要继续检查后续 flag。 */
  respectsDoubleDash?: boolean
}

/** `fd` 和 Debian/Ubuntu 上的 `fdfind` 共享的安全 flag 集合，只保留搜索和输出控制能力。 */
const FD_SAFE_FLAGS: Record<string, FlagArgType> = {
  '-h': 'none',
  '--help': 'none',
  '-V': 'none',
  '--version': 'none',
  '-H': 'none',
  '--hidden': 'none',
  '-I': 'none',
  '--no-ignore': 'none',
  '--no-ignore-vcs': 'none',
  '--no-ignore-parent': 'none',
  '-s': 'none',
  '--case-sensitive': 'none',
  '-i': 'none',
  '--ignore-case': 'none',
  '-g': 'none',
  '--glob': 'none',
  '--regex': 'none',
  '-F': 'none',
  '--fixed-strings': 'none',
  '-a': 'none',
  '--absolute-path': 'none',
  // 1. 不加入 -l/--list-details，因为它内部会调用 ls，恶意 PATH 下可能被劫持执行。
  '-L': 'none',
  '--follow': 'none',
  '-p': 'none',
  '--full-path': 'none',
  '-0': 'none',
  '--print0': 'none',
  '-d': 'number',
  '--max-depth': 'number',
  '--min-depth': 'number',
  '--exact-depth': 'number',
  '-t': 'string',
  '--type': 'string',
  '-e': 'string',
  '--extension': 'string',
  '-S': 'string',
  '--size': 'string',
  '--changed-within': 'string',
  '--changed-before': 'string',
  '-o': 'string',
  '--owner': 'string',
  '-E': 'string',
  '--exclude': 'string',
  '--ignore-file': 'string',
  '-c': 'string',
  '--color': 'string',
  '-j': 'number',
  '--threads': 'number',
  '--max-buffer-time': 'string',
  '--max-results': 'number',
  '-1': 'none',
  '-q': 'none',
  '--quiet': 'none',
  '--show-errors': 'none',
  '--strip-cwd-prefix': 'none',
  '--one-file-system': 'none',
  '--prune': 'none',
  '--search-path': 'string',
  '--base-directory': 'string',
  '--path-separator': 'string',
  '--batch-size': 'number',
  '--no-require-git': 'none',
  '--hyperlink': 'string',
  '--and': 'string',
  '--format': 'string',
}

/** 基于白名单的命令配置中心；这里的命令只能表达读取、查询或本地展示，不应包含写文件、执行代码或发起网络请求能力。 */
const COMMAND_ALLOWLIST: Record<string, CommandConfig> = {
  xargs: {
    safeFlags: {
      '-I': '{}',
      // 1. 不允许小写 -i/-e：GNU getopt 会把它们当作“可选紧贴参数”，校验器和真实 xargs 对空格参数的理解会分歧。
      // 2. 使用大写 -I/-E，它们都需要明确参数，校验器和运行时对参数消费位置保持一致。
      '-n': 'number',
      '-P': 'number',
      '-L': 'number',
      '-s': 'number',
      '-E': 'EOF', // 3. POSIX 强制单独参数形式，避免目标命令被误当成 eof 标记。
      '-0': 'none',
      '-t': 'none',
      '-r': 'none',
      '-x': 'none',
      '-d': 'char',
    },
  },
  // 4. git 只读子命令来自共享校验表，保持 BashTool 和其他入口的规则一致。
  ...GIT_READ_ONLY_COMMANDS,
  file: {
    safeFlags: {
      // 输出格式类选项：只改变 file 的展示结果，不会修改被检查文件。
      '--brief': 'none',
      '-b': 'none',
      '--mime': 'none',
      '-i': 'none',
      '--mime-type': 'none',
      '--mime-encoding': 'none',
      '--apple': 'none',
      // 行为控制类选项：只影响扫描方式、分隔符或帮助信息，仍保持只读。
      '--check-encoding': 'none',
      '-c': 'none',
      '--exclude': 'string',
      '--exclude-quiet': 'string',
      '--print0': 'none',
      '-0': 'none',
      '-f': 'string',
      '-F': 'string',
      '--separator': 'string',
      '--help': 'none',
      '--version': 'none',
      '-v': 'none',
      // 符号链接处理类选项：只决定读取链接本身还是目标文件。
      '--no-dereference': 'none',
      '-h': 'none',
      '--dereference': 'none',
      '-L': 'none',
      // magic 数据库类选项：只用于指定识别规则来源，本身不产生写入。
      '--magic-file': 'string',
      '-m': 'string',
      // 其他只读选项：用于容错、列出规则或调整输出细节。
      '--keep-going': 'none',
      '-k': 'none',
      '--list': 'none',
      '-l': 'none',
      '--no-buffer': 'none',
      '-n': 'none',
      '--preserve-date': 'none',
      '-p': 'none',
      '--raw': 'none',
      '-r': 'none',
      '-s': 'none',
      '--special-files': 'none',
      // 压缩包读取选项：只在识别内容时解压，不写回归档。
      '--uncompress': 'none',
      '-z': 'none',
    },
  },
  sed: {
    safeFlags: {
      // 表达式选项：允许提供 sed 脚本，但后续回调会限制为安全读取形态。
      '--expression': 'string',
      '-e': 'string',
      // 输出控制选项：只控制是否打印默认输出。
      '--quiet': 'none',
      '--silent': 'none',
      '-n': 'none',
      // 正则模式选项：只改变表达式语法。
      '--regexp-extended': 'none',
      '-r': 'none',
      '--posix': 'none',
      '-E': 'none',
      // 行处理选项：只调整换行、缓冲或记录分隔方式。
      '--line-length': 'number',
      '-l': 'number',
      '--zero-terminated': 'none',
      '-z': 'none',
      '--separate': 'none',
      '-s': 'none',
      '--unbuffered': 'none',
      '-u': 'none',
      // 调试和版本选项：只输出辅助信息。
      '--debug': 'none',
      '--help': 'none',
      '--version': 'none',
    },
    additionalCommandIsDangerousCallback: (
      rawCommand: string,
      _args: string[],
    ) => !sedCommandIsAllowedByAllowlist(rawCommand),
  },
  sort: {
    safeFlags: {
      // 排序规则选项：只影响比较和输出顺序。
      '--ignore-leading-blanks': 'none',
      '-b': 'none',
      '--dictionary-order': 'none',
      '-d': 'none',
      '--ignore-case': 'none',
      '-f': 'none',
      '--general-numeric-sort': 'none',
      '-g': 'none',
      '--human-numeric-sort': 'none',
      '-h': 'none',
      '--ignore-nonprinting': 'none',
      '-i': 'none',
      '--month-sort': 'none',
      '-M': 'none',
      '--numeric-sort': 'none',
      '-n': 'none',
      '--random-sort': 'none',
      '-R': 'none',
      '--reverse': 'none',
      '-r': 'none',
      '--sort': 'string',
      '--stable': 'none',
      '-s': 'none',
      '--unique': 'none',
      '-u': 'none',
      '--version-sort': 'none',
      '-V': 'none',
      '--zero-terminated': 'none',
      '-z': 'none',
      // 排序键选项：指定参与比较的字段和分隔符。
      '--key': 'string',
      '-k': 'string',
      '--field-separator': 'string',
      '-t': 'string',
      // 校验选项：只检查输入是否有序。
      '--check': 'none',
      '-c': 'none',
      '--check-char-order': 'none',
      '-C': 'none',
      // 归并选项：合并已有有序输入，不创建输出文件。
      '--merge': 'none',
      '-m': 'none',
      // 缓冲区选项：只影响内存使用规模。
      '--buffer-size': 'string',
      '-S': 'string',
      // 并行选项：只影响本地排序性能。
      '--parallel': 'number',
      // 批处理规模选项：限制一次处理的输入批次。
      '--batch-size': 'number',
      // 帮助和版本选项：只输出说明信息。
      '--help': 'none',
      '--version': 'none',
    },
  },
  man: {
    safeFlags: {
      // 安全展示选项：只查询手册、位置或索引，不调用外部 pager 执行命令。
      '-a': 'none', // 展示所有匹配的手册页。
      '--all': 'none', // 与 -a 等价。
      '-d': 'none', // 输出调试信息。
      '-f': 'none', // 按 whatis 方式查询简短说明。
      '--whatis': 'none', // 与 -f 等价。
      '-h': 'none', // 输出帮助信息。
      '-k': 'none', // 按 apropos 方式搜索主题。
      '--apropos': 'none', // 与 -k 等价。
      '-l': 'string', // 读取本地手册文件，适用于 Linux。
      '-w': 'none', // 只显示手册文件位置。

      // 安全格式选项：只限制手册章节范围。
      '-S': 'string', // 限定手册章节。
      '-s': 'string', // 在 whatis/apropos 模式下与 -S 等价。
    },
  },
  // help 只允许 Bash 内建 help 的安全参数，避免 zsh/别名把 help 转到 man 后通过 pager 参数执行任意命令。
  help: {
    safeFlags: {
      '-d': 'none', // 输出主题的简短说明。
      '-m': 'none', // 按类 manpage 格式展示用法。
      '-s': 'none', // 只输出简短用法摘要。
    },
  },
  netstat: {
    safeFlags: {
      // 展示类选项：只读取连接和监听状态。
      '-a': 'none', // 显示全部套接字。
      '-L': 'none', // 显示监听队列大小。
      '-l': 'none', // 显示完整 IPv6 地址。
      '-n': 'none', // 以数字形式显示地址。

      // 过滤类选项：只限定地址族。
      '-f': 'string', // 指定地址族，例如 inet、inet6、unix、vsock。

      // 网络接口类选项：只读取接口状态。
      '-g': 'none', // 显示多播组成员信息。
      '-i': 'none', // 显示接口状态。
      '-I': 'string', // 指定要查询的接口。

      // 统计类选项：只输出协议计数。
      '-s': 'none', // 显示各协议统计。

      // 路由类选项：只读取路由表。
      '-r': 'none', // 显示路由表。

      // mbuf 类选项：只读取内核网络缓冲统计。
      '-m': 'none', // 显示内存管理统计。

      // 其他展示选项：只增加输出细节。
      '-v': 'none', // 增加输出详细程度。
    },
  },
  ps: {
    safeFlags: {
      // UNIX 风格进程选择选项：只筛选要展示的进程集合。
      '-e': 'none', // 选择全部进程。
      '-A': 'none', // 与 -e 等价。
      '-a': 'none', // 选择有 tty 且非会话首进程的进程。
      '-d': 'none', // 选择除会话首进程外的全部进程。
      '-N': 'none', // 反选当前筛选条件。
      '--deselect': 'none',

      // UNIX 风格输出格式：只展示进程元数据，不暴露环境变量。
      '-f': 'none', // 完整格式。
      '-F': 'none', // 更完整格式。
      '-l': 'none', // 长格式。
      '-j': 'none', // 作业格式。
      '-y': 'none', // 不显示 flags 字段。

      // 输出修饰选项：只影响宽度、层级或表头。
      '-w': 'none', // 宽输出。
      '-ww': 'none', // 不限制输出宽度。
      '--width': 'number',
      '-c': 'none', // 显示调度信息。
      '-H': 'none', // 显示进程层级。
      '--forest': 'none',
      '--headers': 'none',
      '--no-headers': 'none',
      '-n': 'string', // 指定 namelist 文件。
      '--sort': 'string',

      // 线程展示选项：只改变线程是否展开显示。
      '-L': 'none', // 显示线程。
      '-T': 'none', // 显示线程。
      '-m': 'none', // 在进程后显示线程。

      // 条件筛选选项：按进程属性过滤输出。
      '-C': 'string', // 按命令名筛选。
      '-G': 'string', // 按真实组 ID 筛选。
      '-g': 'string', // 按会话或有效组筛选。
      '-p': 'string', // 按 PID 筛选。
      '--pid': 'string',
      '-q': 'string', // 按 PID 使用快速模式。
      '--quick-pid': 'string',
      '-s': 'string', // 按会话 ID 筛选。
      '--sid': 'string',
      '-t': 'string', // 按 tty 筛选。
      '--tty': 'string',
      '-U': 'string', // 按真实用户 ID 筛选。
      '-u': 'string', // 按有效用户 ID 筛选。
      '--user': 'string',

      // 帮助和版本选项：只输出说明信息。
      '--help': 'none',
      '--info': 'none',
      '-V': 'none',
      '--version': 'none',
    },
    // 阻止 BSD 风格的 e 修饰符，因为它会展示进程环境变量；这类参数没有前导短横线。
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // 1. 只检查无前导短横线的纯字母 token，避免误伤 UNIX 风格的安全 -e。
      return args.some(
        a => !a.startsWith('-') && /^[a-zA-Z]*e[a-zA-Z]*$/.test(a),
      )
    },
  },
  base64: {
    respectsDoubleDash: false, // macOS base64 不遵循 POSIX 的 -- 终止参数语义。
    safeFlags: {
      // 解码选项：只转换输入内容，不写入文件。
      '-d': 'none', // 解码。
      '-D': 'none', // macOS 解码选项。
      '--decode': 'none', // 解码。

      // 格式化选项：只调整输出换行宽度。
      '-b': 'number', // macOS 按指定列数换行。
      '--break': 'number', // macOS 按指定列数换行。
      '-w': 'number', // Linux 按指定列数换行。
      '--wrap': 'number', // Linux 按指定列数换行。

      // 输入文件选项：只从文件读取，不写回文件。
      '-i': 'string', // 指定输入文件。
      '--input': 'string', // 指定输入文件。

      // 其他安全选项：只影响容错或帮助输出。
      '--ignore-garbage': 'none', // Linux 解码时忽略非字母表字符。
      '-h': 'none', // 帮助。
      '--help': 'none', // 帮助。
      '--version': 'none', // 版本。
    },
  },
  grep: {
    safeFlags: {
      // 匹配模式选项：只指定搜索表达式来源或正则语法。
      '-e': 'string', // 指定匹配模式。
      '--regexp': 'string',
      '-f': 'string', // 从文件读取匹配模式。
      '--file': 'string',
      '-F': 'none', // 按固定字符串匹配。
      '--fixed-strings': 'none',
      '-G': 'none', // 使用基础正则。
      '--basic-regexp': 'none',
      '-E': 'none', // 使用扩展正则。
      '--extended-regexp': 'none',
      '-P': 'none', // 使用 Perl 风格正则。
      '--perl-regexp': 'none',

      // 匹配控制选项：只改变匹配条件。
      '-i': 'none', // 忽略大小写。
      '--ignore-case': 'none',
      '--no-ignore-case': 'none',
      '-v': 'none', // 反向匹配。
      '--invert-match': 'none',
      '-w': 'none', // 按单词匹配。
      '--word-regexp': 'none',
      '-x': 'none', // 按整行匹配。
      '--line-regexp': 'none',

      // 输出控制选项：只改变返回内容形态。
      '-c': 'none', // 输出匹配数量。
      '--count': 'none',
      '--color': 'string',
      '--colour': 'string',
      '-L': 'none', // 输出不包含匹配内容的文件。
      '--files-without-match': 'none',
      '-l': 'none', // 输出包含匹配内容的文件。
      '--files-with-matches': 'none',
      '-m': 'number', // 限制最大匹配次数。
      '--max-count': 'number',
      '-o': 'none', // 只输出匹配片段。
      '--only-matching': 'none',
      '-q': 'none', // 静默模式。
      '--quiet': 'none',
      '--silent': 'none',
      '-s': 'none', // 不输出错误消息。
      '--no-messages': 'none',

      // 行前缀选项：只补充位置或文件名信息。
      '-b': 'none', // 输出字节偏移。
      '--byte-offset': 'none',
      '-H': 'none', // 输出文件名。
      '--with-filename': 'none',
      '-h': 'none', // 不输出文件名。
      '--no-filename': 'none',
      '--label': 'string',
      '-n': 'none', // 输出行号。
      '--line-number': 'none',
      '-T': 'none', // 对齐初始制表符。
      '--initial-tab': 'none',
      '-u': 'none', // 使用 Unix 字节偏移。
      '--unix-byte-offsets': 'none',
      '-Z': 'none', // 文件名后输出 NUL。
      '--null': 'none',
      '-z': 'none', // 按 NUL 分隔数据。
      '--null-data': 'none',

      // 上下文选项：只决定匹配行附近输出多少行。
      '-A': 'number', // 输出匹配行之后的上下文。
      '--after-context': 'number',
      '-B': 'number', // 输出匹配行之前的上下文。
      '--before-context': 'number',
      '-C': 'number', // 输出前后上下文。
      '--context': 'number',
      '--group-separator': 'string',
      '--no-group-separator': 'none',

      // 文件和目录筛选选项：只影响搜索范围。
      '-a': 'none', // 将二进制文件按文本处理。
      '--text': 'none',
      '--binary-files': 'string',
      '-D': 'string', // 指定设备文件处理方式。
      '--devices': 'string',
      '-d': 'string', // 指定目录处理方式。
      '--directories': 'string',
      '--exclude': 'string',
      '--exclude-from': 'string',
      '--exclude-dir': 'string',
      '--include': 'string',
      '-r': 'none', // 递归搜索。
      '--recursive': 'none',
      '-R': 'none', // 递归并跟随符号链接。
      '--dereference-recursive': 'none',

      // 其他只读选项：只改变缓冲或二进制处理方式。
      '--line-buffered': 'none',
      '-U': 'none', // 按二进制方式处理。
      '--binary': 'none',

      // 帮助和版本选项：只输出说明信息。
      '--help': 'none',
      '-V': 'none',
      '--version': 'none',
    },
  },
  ...RIPGREP_READ_ONLY_COMMANDS,
  // 校验和命令只读取文件并计算或核对摘要；允许的参数只影响输出格式或校验行为。
  sha256sum: {
    safeFlags: {
      // 模式选项：只决定按文本还是二进制读取。
      '-b': 'none', // 二进制模式。
      '--binary': 'none',
      '-t': 'none', // 文本模式。
      '--text': 'none',

      // 校验选项：只从输入中读取摘要并验证。
      '-c': 'none', // 从文件中读取摘要并校验。
      '--check': 'none',
      '--ignore-missing': 'none', // 校验时忽略缺失文件。
      '--quiet': 'none', // 校验时减少输出。
      '--status': 'none', // 不输出内容，只用退出码表达结果。
      '--strict': 'none', // 遇到格式错误行时返回非零。
      '-w': 'none', // 对格式错误行给出警告。
      '--warn': 'none',

      // 输出格式选项：只改变摘要行格式。
      '--tag': 'none', // 使用 BSD 风格输出。
      '-z': 'none', // 输出行以 NUL 结束。
      '--zero': 'none',

      // 帮助和版本选项：只输出说明信息。
      '--help': 'none',
      '--version': 'none',
    },
  },
  sha1sum: {
    safeFlags: {
      // 模式选项：只决定按文本还是二进制读取。
      '-b': 'none', // 二进制模式。
      '--binary': 'none',
      '-t': 'none', // 文本模式。
      '--text': 'none',

      // 校验选项：只从输入中读取摘要并验证。
      '-c': 'none', // 从文件中读取摘要并校验。
      '--check': 'none',
      '--ignore-missing': 'none', // 校验时忽略缺失文件。
      '--quiet': 'none', // 校验时减少输出。
      '--status': 'none', // 不输出内容，只用退出码表达结果。
      '--strict': 'none', // 遇到格式错误行时返回非零。
      '-w': 'none', // 对格式错误行给出警告。
      '--warn': 'none',

      // 输出格式选项：只改变摘要行格式。
      '--tag': 'none', // 使用 BSD 风格输出。
      '-z': 'none', // 输出行以 NUL 结束。
      '--zero': 'none',

      // 帮助和版本选项：只输出说明信息。
      '--help': 'none',
      '--version': 'none',
    },
  },
  md5sum: {
    safeFlags: {
      // 模式选项：只决定按文本还是二进制读取。
      '-b': 'none', // 二进制模式。
      '--binary': 'none',
      '-t': 'none', // 文本模式。
      '--text': 'none',

      // 校验选项：只从输入中读取摘要并验证。
      '-c': 'none', // 从文件中读取摘要并校验。
      '--check': 'none',
      '--ignore-missing': 'none', // 校验时忽略缺失文件。
      '--quiet': 'none', // 校验时减少输出。
      '--status': 'none', // 不输出内容，只用退出码表达结果。
      '--strict': 'none', // 遇到格式错误行时返回非零。
      '-w': 'none', // 对格式错误行给出警告。
      '--warn': 'none',

      // 输出格式选项：只改变摘要行格式。
      '--tag': 'none', // 使用 BSD 风格输出。
      '-z': 'none', // 输出行以 NUL 结束。
      '--zero': 'none',

      // 帮助和版本选项：只输出说明信息。
      '--help': 'none',
      '--version': 'none',
    },
  },
  // tree 从正则只读列表迁到参数白名单，方便同时校验 flag 和路径参数；-o/--output 会写文件，因此不加入。
  tree: {
    safeFlags: {
      // 列表选项：只控制展示哪些目录项。
      '-a': 'none', // 显示所有文件。
      '-d': 'none', // 只显示目录。
      '-l': 'none', // 跟随符号链接。
      '-f': 'none', // 显示完整路径前缀。
      '-x': 'none', // 限制在当前文件系统内。
      '-L': 'number', // 限制最大深度。
      // 安全说明：-R 已移除；它和 HTML 输出、深度限制组合时会在边界子目录写入 00Tree.html。
      '-P': 'string', // 包含匹配模式。
      '-I': 'string', // 排除匹配模式。
      '--gitignore': 'none',
      '--gitfile': 'string',
      '--ignore-case': 'none',
      '--matchdirs': 'none',
      '--metafirst': 'none',
      '--prune': 'none',
      '--info': 'none',
      '--infofile': 'string',
      '--noreport': 'none',
      '--charset': 'string',
      '--filelimit': 'number',
      // 文件展示选项：只改变名称、权限和大小等展示方式。
      '-q': 'none', // 不可打印字符显示为问号。
      '-N': 'none', // 原样显示不可打印字符。
      '-Q': 'none', // 给文件名加引号。
      '-p': 'none', // 显示权限。
      '-u': 'none', // 显示所有者。
      '-g': 'none', // 显示所属组。
      '-s': 'none', // 以字节显示大小。
      '-h': 'none', // 使用易读大小单位。
      '--si': 'none',
      '--du': 'none',
      '-D': 'none', // 显示最后修改时间。
      '--timefmt': 'string',
      '-F': 'none', // 追加类型标识符。
      '--inodes': 'none',
      '--device': 'none',
      // 排序选项：只改变展示顺序。
      '-v': 'none', // 版本号排序。
      '-t': 'none', // 按修改时间排序。
      '-c': 'none', // 按 ctime 排序。
      '-U': 'none', // 不排序。
      '-r': 'none', // 反向排序。
      '--dirsfirst': 'none',
      '--filesfirst': 'none',
      '--sort': 'string',
      // 图形和输出格式选项：只改变树形结构的渲染格式。
      '-i': 'none', // 不显示缩进线。
      '-A': 'none', // 使用 ANSI 线条图形。
      '-S': 'none', // 使用 CP437 线条图形。
      '-n': 'none', // 不使用颜色。
      '-C': 'none', // 使用颜色。
      '-X': 'none', // XML 输出。
      '-J': 'none', // JSON 输出。
      '-H': 'string', // HTML 输出并指定基础链接。
      '--nolinks': 'none',
      '--hintro': 'string',
      '--houtro': 'string',
      '-T': 'string', // HTML 标题。
      '--hyperlink': 'none',
      '--scheme': 'string',
      '--authority': 'string',
      // 输入选项：只从文件读取树形数据，不写文件。
      '--fromfile': 'none',
      '--fromtabfile': 'none',
      '--fflinks': 'none',
      // 帮助和版本选项：只输出说明信息。
      '--help': 'none',
      '--version': 'none',
    },
  },
  // date 不能放在纯命令正则里，因为 -s/--set 和位置参数都可能设置系统时间；这里只保留展示类参数。
  date: {
    safeFlags: {
      // 展示类选项：只解释或显示时间，不修改系统时钟。
      '-d': 'string', // 显示指定字符串描述的时间。
      '--date': 'string',
      '-r': 'string', // 显示参考文件的修改时间。
      '--reference': 'string',
      '-u': 'none', // 使用 UTC。
      '--utc': 'none',
      '--universal': 'none',
      // 输出格式选项：只决定时间字符串格式。
      '-I': 'none', // ISO-8601 裸参数形式；带值形式由长参数覆盖。
      '--iso-8601': 'string',
      '-R': 'none', // RFC 邮件日期格式。
      '--rfc-email': 'none',
      '--rfc-3339': 'string',
      // 调试和帮助选项：只输出辅助信息。
      '--debug': 'none',
      '--help': 'none',
      '--version': 'none',
    },
    // 危险参数通过不加入 safeFlags 来阻断：-s/--set 会设置时间，-f/--file 可批量读取并设置时间。
    // date 的裸位置参数也可能按 MMDDhhmm[[CC]YY][.ss] 语义设置系统时间，因此回调要求位置参数必须是 + 开头的格式串。
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // 1. args 已经是 date 后面的 token，这里列出需要消费下一个参数的安全 flag。
      const flagsWithArgs = new Set([
        '-d',
        '--date',
        '-r',
        '--reference',
        '--iso-8601',
        '--rfc-3339',
      ])
      let i = 0
      while (i < args.length) {
        const token = args[i]!
        // 2. 跳过 flag 及其参数，避免把合法参数误判为位置参数。
        if (token.startsWith('--') && token.includes('=')) {
          // 3. --flag=value 已经在同一个 token 内携带参数。
          i++
        } else if (token.startsWith('-')) {
          // 4. 短参数或普通长参数需要按是否带值分别推进游标。
          if (flagsWithArgs.has(token)) {
            i += 2 // 跳过 flag 及其参数。
          } else {
            i++ // 只跳过 flag。
          }
        } else {
          // 5. 位置参数只有 +FORMAT 是展示格式；其他形式可能设置系统时间。
          if (!token.startsWith('+')) {
            return true // 危险。
          }
          i++
        }
      }
      return false // 安全。
    },
  },
  // hostname 的位置参数会修改主机名，-F/-b 等也会写入系统状态；这里只允许展示类参数并拒绝位置参数。
  hostname: {
    safeFlags: {
      // 仅展示选项：读取主机名、域名或地址信息。
      '-f': 'none', // 显示 FQDN。
      '--fqdn': 'none',
      '--long': 'none',
      '-s': 'none', // 显示短主机名。
      '--short': 'none',
      '-i': 'none', // 显示 IP 地址。
      '--ip-address': 'none',
      '-I': 'none', // 显示全部 IP 地址。
      '--all-ip-addresses': 'none',
      '-a': 'none', // 显示别名。
      '--alias': 'none',
      '-d': 'none', // 显示域名。
      '--domain': 'none',
      '-A': 'none', // 显示全部 FQDN。
      '--all-fqdns': 'none',
      '-v': 'none', // 输出详细信息。
      '--verbose': 'none',
      '-h': 'none', // 帮助。
      '--help': 'none',
      '-V': 'none', // 版本。
      '--version': 'none',
    },
    // 关键约束：任何位置参数都会设置主机名；未列入 safeFlags 的 -F/-b/-y 等修改类参数也会被阻断。
    regex: /^hostname(?:\s+(?:-[a-zA-Z]|--[a-zA-Z-]+))*\s*$/,
  },
  // info 不能只按命令名放行，因为 -o/--output、--dribble、--init-file 等会写文件或加载配置；这里只允许阅读和导航参数。
  info: {
    safeFlags: {
      // 导航和展示选项：只决定读取哪个 info 文档或节点。
      '-f': 'string', // 指定要读取的手册文件。
      '--file': 'string',
      '-d': 'string', // 指定搜索目录。
      '--directory': 'string',
      '-n': 'string', // 指定节点。
      '--node': 'string',
      '-a': 'none', // 显示全部匹配内容。
      '--all': 'none',
      '-k': 'string', // 按关键字搜索。
      '--apropos': 'string',
      '-w': 'none', // 显示文档位置。
      '--where': 'none',
      '--location': 'none',
      '--show-options': 'none',
      '--vi-keys': 'none',
      '--subnodes': 'none',
      '-h': 'none',
      '--help': 'none',
      '--usage': 'none',
      '--version': 'none',
    },
    // 危险参数通过省略阻断：-o 写文件，--dribble 记录按键，--init-file/--restore 会加载或回放外部配置。
  },

  lsof: {
    safeFlags: {
      '-?': 'none',
      '-h': 'none',
      '-v': 'none',
      '-a': 'none',
      '-b': 'none',
      '-C': 'none',
      '-l': 'none',
      '-n': 'none',
      '-N': 'none',
      '-O': 'none',
      '-P': 'none',
      '-Q': 'none',
      '-R': 'none',
      '-t': 'none',
      '-U': 'none',
      '-V': 'none',
      '-X': 'none',
      '-H': 'none',
      '-E': 'none',
      '-F': 'none',
      '-g': 'none',
      '-i': 'none',
      '-K': 'none',
      '-L': 'none',
      '-o': 'none',
      '-r': 'none',
      '-s': 'none',
      '-S': 'none',
      '-T': 'none',
      '-x': 'none',
      '-A': 'string',
      '-c': 'string',
      '-d': 'string',
      '-e': 'string',
      '-k': 'string',
      '-p': 'string',
      '-u': 'string',
      // 省略 -D：它会构建或更新设备缓存文件，属于磁盘写入。
    },
    // 阻断 +m：它会创建 mount supplement 文件；+ 前缀参数会被 validateFlags 当作位置参数，只能在回调中补充识别。
    additionalCommandIsDangerousCallback: (_rawCommand, args) =>
      args.some(a => a === '+m' || a.startsWith('+m')),
  },

  pgrep: {
    safeFlags: {
      '-d': 'string',
      '--delimiter': 'string',
      '-l': 'none',
      '--list-name': 'none',
      '-a': 'none',
      '--list-full': 'none',
      '-v': 'none',
      '--inverse': 'none',
      '-w': 'none',
      '--lightweight': 'none',
      '-c': 'none',
      '--count': 'none',
      '-f': 'none',
      '--full': 'none',
      '-g': 'string',
      '--pgroup': 'string',
      '-G': 'string',
      '--group': 'string',
      '-i': 'none',
      '--ignore-case': 'none',
      '-n': 'none',
      '--newest': 'none',
      '-o': 'none',
      '--oldest': 'none',
      '-O': 'string',
      '--older': 'string',
      '-P': 'string',
      '--parent': 'string',
      '-s': 'string',
      '--session': 'string',
      '-t': 'string',
      '--terminal': 'string',
      '-u': 'string',
      '--euid': 'string',
      '-U': 'string',
      '--uid': 'string',
      '-x': 'none',
      '--exact': 'none',
      '-F': 'string',
      '--pidfile': 'string',
      '-L': 'none',
      '--logpidfile': 'none',
      '-r': 'string',
      '--runstates': 'string',
      '--ns': 'string',
      '--nslist': 'string',
      '--help': 'none',
      '-V': 'none',
      '--version': 'none',
    },
  },

  tput: {
    safeFlags: {
      '-T': 'string',
      '-V': 'none',
      '-x': 'none',
      // 安全说明：故意不加入 -S；它会从 stdin 读取能力名，且组合短参数可能绕开回调的精确匹配。
    },
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // 1. 这些 capability 会修改终端状态、清除证据、触发 terminfo 程序或改变屏幕缓冲，因此统一阻断。
      const DANGEROUS_CAPABILITIES = new Set([
        'init',
        'reset',
        'rs1',
        'rs2',
        'rs3',
        'is1',
        'is2',
        'is3',
        'iprog',
        'if',
        'rf',
        'clear',
        'flash',
        'mc0',
        'mc4',
        'mc5',
        'mc5i',
        'mc5p',
        'pfkey',
        'pfloc',
        'pfx',
        'pfxl',
        'smcup',
        'rmcup',
      ])
      const flagsWithArgs = new Set(['-T'])
      let i = 0
      let afterDoubleDash = false
      while (i < args.length) {
        const token = args[i]!
        if (token === '--') {
          afterDoubleDash = true
          i++
        } else if (!afterDoubleDash && token.startsWith('-')) {
          // 2. 纵深防御：即使 -S 绕过前置 flag 校验，这里仍然阻断。
          if (token === '-S') return true
          // 3. 组合短参数也要检查，例如 -xS。
          if (
            !token.startsWith('--') &&
            token.length > 2 &&
            token.includes('S')
          )
            return true
          if (flagsWithArgs.has(token)) {
            i += 2
          } else {
            i++
          }
        } else {
          if (DANGEROUS_CAPABILITIES.has(token)) return true
          i++
        }
      }
      return false
    },
  },

  // ss 是 iproute2 的套接字统计工具，等价于 netstat 的只读查询；会关闭连接、转储文件或读取过滤文件的参数不加入。
  ss: {
    safeFlags: {
      '-h': 'none',
      '--help': 'none',
      '-V': 'none',
      '--version': 'none',
      '-n': 'none',
      '--numeric': 'none',
      '-r': 'none',
      '--resolve': 'none',
      '-a': 'none',
      '--all': 'none',
      '-l': 'none',
      '--listening': 'none',
      '-o': 'none',
      '--options': 'none',
      '-e': 'none',
      '--extended': 'none',
      '-m': 'none',
      '--memory': 'none',
      '-p': 'none',
      '--processes': 'none',
      '-i': 'none',
      '--info': 'none',
      '-s': 'none',
      '--summary': 'none',
      '-4': 'none',
      '--ipv4': 'none',
      '-6': 'none',
      '--ipv6': 'none',
      '-0': 'none',
      '--packet': 'none',
      '-t': 'none',
      '--tcp': 'none',
      '-M': 'none',
      '--mptcp': 'none',
      '-S': 'none',
      '--sctp': 'none',
      '-u': 'none',
      '--udp': 'none',
      '-d': 'none',
      '--dccp': 'none',
      '-w': 'none',
      '--raw': 'none',
      '-x': 'none',
      '--unix': 'none',
      '--tipc': 'none',
      '--vsock': 'none',
      '-f': 'string',
      '--family': 'string',
      '-A': 'string',
      '--query': 'string',
      '--socket': 'string',
      '-Z': 'none',
      '--context': 'none',
      '-z': 'none',
      '--contexts': 'none',
      // 安全说明：不加入 -N/--net，因为它会切换网络命名空间并触发 setns/unshare/mount/umount。
      '-b': 'none',
      '--bpf': 'none',
      '-E': 'none',
      '--events': 'none',
      '-H': 'none',
      '--no-header': 'none',
      '-O': 'none',
      '--oneline': 'none',
      '--tipcinfo': 'none',
      '--tos': 'none',
      '--cgroup': 'none',
      '--inet-sockopt': 'none',
      // 安全说明：不加入 -K/--kill，避免强制关闭套接字。
      // 安全说明：不加入 -D/--diag，避免把原始 TCP 数据转储到文件。
      // 安全说明：不加入 -F/--filter，避免从外部文件读取过滤表达式。
    },
  },

  // fd/fdfind 是只读文件查找工具；-x/--exec 和 -X/--exec-batch 会执行结果命令，因此不加入。
  fd: { safeFlags: { ...FD_SAFE_FLAGS } },
  // fdfind 是 Debian/Ubuntu 上 fd 的包名，复用同一套安全参数。
  fdfind: { safeFlags: { ...FD_SAFE_FLAGS } },

  ...PYRIGHT_READ_ONLY_COMMANDS,
  ...DOCKER_READ_ONLY_COMMANDS,
}

/** 仅内部用户可用的网络查询命令白名单；普通只读校验默认不允许网络访问。 */
const ANT_ONLY_COMMAND_ALLOWLIST: Record<string, CommandConfig> = {
  // 1. gh 的只读子命令仍会访问网络，因此只在 ant 用户类型下合并。
  ...GH_READ_ONLY_COMMANDS,
  // 2. aki 是内部知识库查询 CLI，只允许网络只读查询；会写磁盘的 --audit-csv 不加入。
  aki: {
    safeFlags: {
      '-h': 'none',
      '--help': 'none',
      '-k': 'none',
      '--keyword': 'none',
      '-s': 'none',
      '--semantic': 'none',
      '--no-adaptive': 'none',
      '-n': 'number',
      '--limit': 'number',
      '-o': 'number',
      '--offset': 'number',
      '--source': 'string',
      '--exclude-source': 'string',
      '-a': 'string',
      '--after': 'string',
      '-b': 'string',
      '--before': 'string',
      '--collection': 'string',
      '--drive': 'string',
      '--folder': 'string',
      '--descendants': 'none',
      '-m': 'string',
      '--meta': 'string',
      '-t': 'string',
      '--threshold': 'string',
      '--kw-weight': 'string',
      '--sem-weight': 'string',
      '-j': 'none',
      '--json': 'none',
      '-c': 'none',
      '--chunk': 'none',
      '--preview': 'none',
      '-d': 'none',
      '--full-doc': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '--stats': 'none',
      '-S': 'number',
      '--summarize': 'number',
      '--explain': 'none',
      '--examine': 'string',
      '--url': 'string',
      '--multi-turn': 'number',
      '--multi-turn-model': 'string',
      '--multi-turn-context': 'string',
      '--no-rerank': 'none',
      '--audit': 'none',
      '--local': 'none',
      '--staging': 'none',
    },
  },
}

/**
 * 根据平台和用户类型获取本次校验实际使用的命令白名单。
 *
 * @returns 合并平台限制和用户类型后的命令白名单配置。
 */
function getCommandAllowlist(): Record<string, CommandConfig> {
  // 1. 默认使用本地只读命令白名单，不包含网络查询命令。
  let allowlist: Record<string, CommandConfig> = COMMAND_ALLOWLIST
  // 2. Windows 下 xargs 可能把文件内容中的 UNC 路径转交给后续命令，静态命令串看不到该风险，因此整体禁用。
  if (getPlatform() === 'windows') {
    const { xargs: _, ...rest } = allowlist
    allowlist = rest
  }
  // 3. 内部用户允许额外的网络只读查询命令，普通用户不合并这些规则。
  if (process.env.USER_TYPE === 'ant') {
    return { ...allowlist, ...ANT_ONLY_COMMAND_ALLOWLIST }
  }
  return allowlist
}

/**
 * 可作为 xargs 目标命令且仍能自动放行的工具集合。
 *
 * 只有完全没有写文件、执行代码或网络请求能力的工具才能加入。
 * xargs 命中目标命令后会停止继续解析目标命令自己的 flag，因此这里必须比普通白名单更严格。
 *
 * @returns 该常量不是函数返回值；数组元素表示允许被 xargs 包装的只读目标命令名。
 */
const SAFE_TARGET_COMMANDS_FOR_XARGS = [
  'echo', // 1. 仅输出参数，不引入写入或执行能力。
  'printf', // 2. xargs 调用的是外部二进制 printf，不是带 -v 写变量的 Bash 内建。
  'wc', // 3. 只读取并统计输入。
  'grep', // 4. 只读取并搜索内容。
  'head', // 5. 只读取文件前部内容。
  'tail', // 6. 只读取文件尾部内容，包括 follow 模式也不写文件。
]

/**
 * 使用声明式白名单判断一个简单命令是否只读。
 *
 * @param command 待校验的单个命令字符串，不应包含管道、重定向等 shell 操作符。
 * @returns 命令在当前平台和用户类型下符合只读白名单时返回 true，否则返回 false。
 */
export function isCommandSafeViaFlagParsing(command: string): boolean {
  // 1. 使用 shell 解析器拆分 token，保留变量引用文本以便后续识别运行时展开风险。
  const parseResult = tryParseShellCommand(command, env => `$${env}`)
  if (!parseResult.success) return false

  // 2. glob token 在本函数中只作为普通文本参与 flag 判断，真正的展开风险由上层拦截。
  const parsed = parseResult.tokens.map(token => {
    if (typeof token !== 'string') {
      token = token as { op: 'glob'; pattern: string }
      if (token.op === 'glob') {
        return token.pattern
      }
    }
    return token
  })

  // 3. 本函数只处理单个简单命令；管道、重定向等组合结构应由上游拆开后再校验。
  const hasOperators = parsed.some(token => typeof token !== 'string')
  if (hasOperators) {
    return false
  }

  // 4. 此时 token 都是字符串，空命令不能进入白名单。
  const tokens = parsed as string[]

  if (tokens.length === 0) {
    return false
  }

  // 5. 定位当前命令对应的白名单配置。
  let commandConfig: CommandConfig | undefined
  let commandTokens: number = 0

  // 6. 优先匹配多词命令配置，例如 `git diff`、`git stash list`。
  const allowlist = getCommandAllowlist()
  for (const [cmdPattern] of Object.entries(allowlist)) {
    const cmdTokens = cmdPattern.split(' ')
    if (tokens.length >= cmdTokens.length) {
      let matches = true
      for (let i = 0; i < cmdTokens.length; i++) {
        if (tokens[i] !== cmdTokens[i]) {
          matches = false
          break
        }
      }
      if (matches) {
        commandConfig = allowlist[cmdPattern]
        commandTokens = cmdTokens.length
        break
      }
    }
  }

  if (!commandConfig) {
    return false
  }

  // 7. git ls-remote 虽然是读操作，但远程 URL 可能造成外联或数据外泄，需要额外拒绝。
  if (tokens[0] === 'git' && tokens[1] === 'ls-remote') {
    for (let i = 2; i < tokens.length; i++) {
      const token = tokens[i]
      if (token && !token.startsWith('-')) {
        if (token.includes('://')) {
          return false
        }
        if (token.includes('@') || token.includes(':')) {
          return false
        }
        if (token.includes('$')) {
          return false
        }
      }
    }
  }

  // 8. 拒绝任何包含 `$` 的 token：校验阶段看到的是字面量，运行时 Bash 会展开，可能把位置参数伪装成危险 flag。
  //
  //   示例：`ps ax"$Z"e` 在静态 token 里是 `ax$Ze`，ps 回调无法命中 BSD e 选项；
  //   但运行时 Bash 会把空变量折叠成 `ps axe`，从而泄露进程环境变量。
  //
  //   因此命令名前缀之后的所有 token 都要检查，并且必须早于 flag 校验和命令回调执行。
  for (let i = commandTokens; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    // 9. 变量展开会改变运行时 token，无法静态证明只读。
    if (token.includes('$')) {
      return false
    }
    // 10. 花括号展开可把一个看似普通的参数展开成危险 flag；要求同时出现 `{` 和 `,`/`..`，减少误伤 git ref、Go 模板和 xargs 占位符。
    if (token.includes('{') && (token.includes(',') || token.includes('..'))) {
      return false
    }
  }

  // 11. 从命令名之后开始做 flag 白名单校验。
  if (
    !validateFlags(tokens, commandTokens, commandConfig, {
      commandName: tokens[0],
      rawCommand: command,
      xargsTargetCommands:
        tokens[0] === 'xargs' ? SAFE_TARGET_COMMANDS_FOR_XARGS : undefined,
    })
  ) {
    return false
  }

  if (commandConfig.regex && !commandConfig.regex.test(command)) {
    return false
  }
  if (!commandConfig.regex && /`/.test(command)) {
    return false
  }
  // 12. grep/rg 的模式中如果含换行或回车，可能拆出额外命令或参数，保守拒绝。
  if (
    !commandConfig.regex &&
    (tokens[0] === 'rg' || tokens[0] === 'grep') &&
    /[\n\r]/.test(command)
  ) {
    return false
  }
  if (
    commandConfig.additionalCommandIsDangerousCallback &&
    commandConfig.additionalCommandIsDangerousCallback(
      command,
      tokens.slice(commandTokens),
    )
  ) {
    return false
  }

  return true
}

/**
 * 为简单只读命令创建安全匹配正则。
 *
 * 该正则只允许命令名后跟普通文本参数，拒绝 shell 元字符、重定向、命令替换、
 * 变量展开和形如 `command=value` 的环境变量绕过。
 *
 * @param command 命令名或多词命令，例如 `date`、`npm list`、`ip addr`。
 * @returns 用于匹配该命令安全调用形式的正则表达式。
 */
function makeRegexForSafeCommand(command: string): RegExp {
  // 1. 只允许命令后出现普通参数字符，明确排除 shell 控制字符和展开语法。
  return new RegExp(`^${command}(?:\\s|$)[^<>()$\`|{}&;\\n\\r]*$`)
}

/** 简单只读命令列表；这些命令会通过 `makeRegexForSafeCommand()` 转成严格正则。 */
const READONLY_COMMANDS = [
  // 1. 跨平台只读命令来自共享配置。
  ...EXTERNAL_READONLY_COMMANDS,

  // 2. 以下命令是 Unix/Bash 专有命令，PowerShell 入口不共享。

  // 3. 时间与日期展示命令。
  'cal',
  'uptime',

  // 4. 文件内容查看命令，路径是否允许由后续路径校验负责。
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'strings',
  'hexdump',
  'od',
  'nl',

  // 5. 系统信息读取命令。
  'id',
  'uname',
  'free',
  'df',
  'du',
  'locale',
  'groups',
  'nproc',

  // 6. 路径信息读取命令。
  'basename',
  'dirname',
  'realpath',

  // 7. 文本处理命令，只允许标准输入/输出方向的只读处理。
  'cut',
  'paste',
  'tr',
  'column',
  'tac', // 反向按行显示文件内容。
  'rev', // 反转每一行的字符。
  'fold', // 按指定宽度折行。
  'expand', // 将制表符转换为空格。
  'unexpand', // 将空格转换为制表符。
  'fmt', // 简单文本格式化，只写标准输出。
  'comm', // 按行比较已排序文件。
  'cmp', // 按字节比较文件。
  'numfmt', // 转换数字格式。

  // 8. 额外路径信息命令。
  'readlink', // 9. 解析符号链接并输出目标。

  // 10. 文件对比命令。
  'diff',

  // 11. true/false 不读写文件，常用于控制返回码。
  'true',
  'false',

  // 12. 其他只读或无副作用命令。
  'sleep',
  'which',
  'type',
  'expr', // 计算算术或字符串匹配表达式。
  'test', // 执行文件检查或条件比较。
  'getconf', // 读取系统配置值。
  'seq', // 生成数字序列。
  'tsort', // 执行拓扑排序并输出结果。
  'pr', // 将文本分页输出到标准输出。
]

/** 需要手写正则的复杂只读命令集合；新增规则时优先考虑 `COMMAND_ALLOWLIST`，它比手写正则更容易处理 GNU getopt 变体。 */
const READONLY_COMMAND_REGEXES = new Set([
  // 1. 简单命令统一转换为安全正则。
  ...READONLY_COMMANDS.map(makeRegexForSafeCommand),

  // 2. echo 只允许普通文本、单引号文本和不含变量的双引号文本，并允许末尾 2>&1。
  /^echo(?:\s+(?:'[^']*'|"[^"$<>\n\r]*"|[^|;&`$(){}><#\\!"'\s]+))*(?:\s+2>&1)?\s*$/,

  // 3. Claude CLI 帮助命令只展示本地帮助。
  /^claude -h$/,
  /^claude --help$/,

  // 4. git 只读命令已迁移到 COMMAND_ALLOWLIST，避免通过缩写 flag 绕过正则。

  /^uniq(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?|-[fsw]\s+\d+))*(?:\s|$)\s*$/, // 5. 只允许 uniq 的 flag 形式，不允许输入输出文件参数。

  // 6. 只读系统信息命令。
  /^pwd$/,
  /^whoami$/,
  // 7. env 和 printenv 不允许自动放行，因为可能暴露敏感环境变量。

  // 8. 开发工具版本查询必须精确匹配，避免 `node -v --run <task>` 这类附加参数触发脚本执行。
  /^node -v$/,
  /^node --version$/,
  /^python --version$/,
  /^python3 --version$/,

  // 9. 其他安全命令；tree 已转到 COMMAND_ALLOWLIST 以阻止 -o/--output 写文件。
  /^history(?:\s+\d+)?\s*$/, // 10. 只允许裸 history 或数字条数，避免 history 写文件。
  /^alias$/,
  /^arch(?:\s+(?:--help|-h))?\s*$/, // 11. arch 只允许无参数或帮助参数。

  // 12. 网络信息命令只允许读取本地接口信息，禁止附加会修改网络状态的参数。
  /^ip addr$/,
  /^ifconfig(?:\s+[a-zA-Z][a-zA-Z0-9_-]*)?\s*$/,

  // 13. jq 只允许内联过滤器和普通文件参数，禁止加载脚本、读取额外文件、执行测试或访问环境变量。
  /^jq(?!\s+.*(?:-f\b|--from-file|--rawfile|--slurpfile|--run-tests|-L\b|--library-path|\benv\b|\$ENV\b))(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?))*(?:\s+'[^'`]*'|\s+"[^"`]*"|\s+[^-\s'"][^\s]*)+\s*$/,

  // 14. 路径命令本身只表达目录/文件定位，具体路径是否允许由路径校验负责。
  /^cd(?:\s+(?:'[^']*'|"[^"]*"|[^\s;|&`$(){}><#\\]+))?$/,
  /^ls(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
  // 15. find 允许转义括号用于分组，但拒绝 -delete/-exec 等写入或执行能力。
  /^find(?:\s+(?:\\[()]|(?!-delete\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint0?\b|-fls\b|-fprintf\b)[^<>()$`|{}&;\n\r\s]|\s)+)?$/,
])

/**
 * 检查命令中是否存在未被安全引用保护的 glob 或变量展开。
 *
 * glob 和 `$VAR` 在 Bash 运行时会变成新的参数、路径或 flag，静态正则无法知道真实展开结果。
 * 单引号内的内容按字面量处理；双引号内变量仍会展开，但 glob 不展开。
 *
 * @param command 需要检查的命令字符串。
 * @returns 存在未受保护的 glob 或可展开变量时返回 true。
 */
function containsUnquotedExpansion(command: string): boolean {
  // 1. 跟踪单双引号状态，避免把字面量文本中的特殊字符误判为运行时展开。
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const currentChar = command[i]

    // 2. 已被反斜杠转义的字符只作为普通字符消费一次。
    if (escaped) {
      escaped = false
      continue
    }

    // 3. 反斜杠只有在单引号外才有转义意义；单引号内的反斜杠是字面量。
    if (currentChar === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    // 4. 根据当前字符更新单引号状态。
    if (currentChar === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    // 5. 根据当前字符更新双引号状态。
    if (currentChar === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    // 6. 单引号内所有内容都是字面量，直接跳过。
    if (inSingleQuote) {
      continue
    }

    // 7. `$` 在双引号和未引用上下文都会展开，只要后面像变量名或特殊参数就判定有风险。
    if (currentChar === '$') {
      const next = command[i + 1]
      if (next && /[A-Za-z_@*#?!$0-9-]/.test(next)) {
        return true
      }
    }

    // 8. 双引号内 glob 不展开，只有完全未引用时才继续检查 glob 字符。
    if (inDoubleQuote) {
      continue
    }

    // 9. 未引用的 glob 可能展开成任意文件名，包括危险 flag 或路径。
    if (currentChar && /[?*[\]]/.test(currentChar)) {
      return true
    }
  }

  // 10. 扫描完成仍未命中风险字符，说明该命令没有明显的未引用展开。
  return false
}

/**
 * 判断单个子命令是否满足只读命令规则。
 *
 * @param command 需要检查的单个命令字符串。
 * @returns 命令可被视为只读时返回 true，否则返回 false。
 */
function isCommandReadOnly(command: string): boolean {
  // 1. 标准错误合并到标准输出不改变读写性质，先剥离再做模式匹配。
  let testCommand = command.trim()
  if (testCommand.endsWith(' 2>&1')) {
    testCommand = testCommand.slice(0, -5).trim()
  }

  // 2. UNC 路径可能触发 Windows/WebDAV 访问，任何包含该风险的命令都不能自动视为只读。
  if (containsVulnerableUncPath(testCommand)) {
    return false
  }

  // 3. 未引用 glob 或变量展开会让运行时参数偏离静态校验结果，因此直接拒绝自动放行。
  if (containsUnquotedExpansion(testCommand)) {
    return false
  }

  // 4. 优先使用声明式 flag 白名单，避免 git 等工具通过缩写长选项绕过手写正则。
  if (isCommandSafeViaFlagParsing(testCommand)) {
    return true
  }

  // 5. 对无法配置化表达的命令，退回到少量严格手写正则。
  for (const regex of READONLY_COMMAND_REGEXES) {
    if (regex.test(testCommand)) {
      // 6. git -c 可注入 core.fsmonitor/diff.external 等执行型配置，正则命中后仍需拦截。
      if (testCommand.includes('git') && /\s-c[\s=]/.test(testCommand)) {
        return false
      }

      // 7. git --exec-path 会改写 git 查找子命令的位置，可能让恶意可执行文件参与执行。
      if (
        testCommand.includes('git') &&
        /\s--exec-path[\s=]/.test(testCommand)
      ) {
        return false
      }

      // 8. git --config-env 和 -c 一样能注入危险配置，只是值来自环境变量。
      if (
        testCommand.includes('git') &&
        /\s--config-env[\s=]/.test(testCommand)
      ) {
        return false
      }
      return true
    }
  }
  // 9. 没有任何规则认可时，交回普通权限流程。
  return false
}

/**
 * 检查复合命令中是否包含任何 git 子命令。
 *
 * @param command 完整 Bash 命令字符串。
 * @returns 任一子命令是规范化 git 命令时返回 true。
 */
function commandHasAnyGit(command: string): boolean {
  // 1. 先拆分复合命令，再逐个子命令做 git 规范化匹配。
  return splitCommand_DEPRECATED(command).some(subcmd =>
    isNormalizedGitCommand(subcmd.trim()),
  )
}

/**
 * git 裸仓库内部路径模式；复合命令如果先创建这些路径再运行 git，可能诱导 git 执行新建 hook。
 */
const GIT_INTERNAL_PATTERNS = [
  /^HEAD$/,
  /^objects(?:\/|$)/,
  /^refs(?:\/|$)/,
  /^hooks(?:\/|$)/,
]

/**
 * 判断路径是否指向 git 裸仓库内部结构。
 *
 * @param path 需要检查的相对或带前缀路径。
 * @returns 路径归一化后命中 HEAD、objects、refs 或 hooks 时返回 true。
 */
function isGitInternalPath(path: string): boolean {
  // 1. 去掉开头的 ./ 或 /，让 `hooks/x`、`./hooks/x`、`/hooks/x` 使用同一套匹配。
  const normalized = path.replace(/^\.?\//, '')
  return GIT_INTERNAL_PATTERNS.some(pattern => pattern.test(normalized))
}

/** 只删除或原地修改、不在新路径创建文件的写类命令；这些命令不参与 git 内部路径“创建”判断。 */
const NON_CREATING_WRITE_COMMANDS = new Set(['rm', 'rmdir', 'sed'])

/**
 * 从一个子命令中提取可能新建文件或目录的目标路径。
 *
 * @param subcommand 单个子命令文本。
 * @returns 该子命令可能创建的新路径列表；无法解析或不是创建型命令时返回空数组。
 */
function extractWritePathsFromSubcommand(subcommand: string): string[] {
  // 1. 解析失败时不在这里猜测路径，交由外层普通权限检查处理。
  const parseResult = tryParseShellCommand(subcommand, env => `$${env}`)
  if (!parseResult.success) return []

  // 2. 只保留字符串 token，glob 或操作符不作为路径提取来源。
  const tokens = parseResult.tokens.filter(
    (t): t is string => typeof t === 'string',
  )
  if (tokens.length === 0) return []

  const baseCmd = tokens[0]
  if (!baseCmd) return []

  // 3. 只有路径校验表认识的命令才知道哪些参数代表写入目标。
  if (!(baseCmd in COMMAND_OPERATION_TYPE)) {
    return []
  }
  // 4. 只关心 write/create 且会在新路径产生文件的命令，删除或原地修改不算创建 git 内部结构。
  const opType = COMMAND_OPERATION_TYPE[baseCmd as PathCommand]
  if (
    (opType !== 'write' && opType !== 'create') ||
    NON_CREATING_WRITE_COMMANDS.has(baseCmd)
  ) {
    return []
  }

  // 5. 调用对应命令的路径提取器，返回参数中可能被创建的目标路径。
  const extractor = PATH_EXTRACTORS[baseCmd as PathCommand]
  if (!extractor) return []

  return extractor(tokens.slice(1))
}

/**
 * 检查复合命令是否会写入 git 内部路径。
 *
 * 该检查用于阻止“同一条复合命令先创建裸仓库结构，再运行 git 触发恶意 hook”的沙箱逃逸路径。
 *
 * @param command 完整 Bash 命令字符串。
 * @returns 任一子命令写入 HEAD、objects、refs 或 hooks 等 git 内部路径时返回 true。
 */
function commandWritesToGitInternalPaths(command: string): boolean {
  // 1. 按子命令拆分，分别检查参数路径和重定向目标。
  const subcommands = splitCommand_DEPRECATED(command)

  for (const subcmd of subcommands) {
    const trimmed = subcmd.trim()

    // 2. 检查 mkdir、touch、cp、mv 等路径型命令可能创建的目标。
    const writePaths = extractWritePathsFromSubcommand(trimmed)
    for (const path of writePaths) {
      if (isGitInternalPath(path)) {
        return true
      }
    }

    // 3. 检查输出重定向，例如 `echo x > hooks/pre-commit`。
    const { redirections } = extractOutputRedirections(trimmed)
    for (const { target } of redirections) {
      if (isGitInternalPath(target)) {
        return true
      }
    }
  }

  // 4. 所有子命令都没有写入 git 内部路径。
  return false
}

/**
 * 对 BashTool 输入执行只读约束检查。
 *
 * @param input BashTool 的输入对象，至少包含待执行命令。
 * @param compoundCommandHasCd 上游预先计算的复合命令是否包含 cd，用于避免重复解析。
 * @returns 权限判定结果；确认只读时返回 allow，无法确认或有风险时交回后续权限流程。
 */
export function checkReadOnlyConstraints(
  input: z.infer<typeof BashTool.inputSchema>,
  compoundCommandHasCd: boolean,
): PermissionResult {
  const { command } = input

  // 1. 命令无法解析时不能自动判断只读，交给后续权限检查。
  const result = tryParseShellCommand(command, env => `$${env}`)
  if (!result.success) {
    return {
      behavior: 'passthrough',
      message: 'Command cannot be parsed, requires further permission checks',
    }
  }

  // 2. 拆分前先检查原始命令的基础安全性，避免拆分过程改变变量写法后漏掉风险。
  if (bashCommandIsSafe_DEPRECATED(command).behavior !== 'passthrough') {
    return {
      behavior: 'passthrough',
      message: 'Command is not read-only, requires further permission checks',
    }
  }

  // 3. UNC 路径必须在原始命令上检查，因为后续拆分可能改变反斜杠表现形式。
  if (containsVulnerableUncPath(command)) {
    return {
      behavior: 'ask',
      message:
        'Command contains Windows UNC path that could be vulnerable to WebDAV attacks',
    }
  }

  // 4. 复合命令是否包含 git 会被多个安全分支复用，因此只计算一次。
  const hasGitCommand = commandHasAnyGit(command)

  // 5. cd 与 git 同时出现时，git 可能在切换后的恶意目录中执行 hook，必须交回权限检查。
  if (compoundCommandHasCd && hasGitCommand) {
    return {
      behavior: 'passthrough',
      message:
        'Compound commands with cd and git require permission checks for enhanced security',
    }
  }

  // 6. 当前目录如果像裸 git 仓库，git 可能把本目录当作仓库目录并执行内部 hook。
  if (hasGitCommand && isCurrentDirectoryBareGitRepo()) {
    return {
      behavior: 'passthrough',
      message:
        'Git commands in directories with bare repository structure require permission checks for enhanced security',
    }
  }

  // 7. 同一条命令如果先创建 git 内部文件再运行 git，也可能触发刚写入的恶意 hook。
  if (hasGitCommand && commandWritesToGitInternalPaths(command)) {
    return {
      behavior: 'passthrough',
      message:
        'Compound commands that create git internal files and run git require permission checks for enhanced security',
    }
  }

  // 8. 沙箱开启时，只有原始工作目录中的 git 命令才可自动放行，避免后台命令在新目录中竞态触发裸仓库结构。
  if (
    hasGitCommand &&
    SandboxManager.isSandboxingEnabled() &&
    getCwd() !== getOriginalCwd()
  ) {
    return {
      behavior: 'passthrough',
      message:
        'Git commands outside the original working directory require permission checks when sandbox is enabled',
    }
  }

  // 9. 所有子命令都必须同时通过基础安全检查和只读命令检查，才允许整体自动放行。
  const allSubcommandsReadOnly = splitCommand_DEPRECATED(command).every(
    subcmd => {
      if (bashCommandIsSafe_DEPRECATED(subcmd).behavior !== 'passthrough') {
        return false
      }
      return isCommandReadOnly(subcmd)
    },
  )

  // 10. 全部子命令确认只读时，返回 allow 并保留原始输入。
  if (allSubcommandsReadOnly) {
    return {
      behavior: 'allow',
      updatedInput: input,
    }
  }

  // 11. 任何无法证明只读的情况都不在这里拒绝，交给后续权限系统决定询问或阻断。
  return {
    behavior: 'passthrough',
    message: 'Command is not read-only, requires further permission checks',
  }
}
