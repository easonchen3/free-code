import { describe, expect, it, mock } from 'bun:test'

mock.module('../ToolSearchTool/prompt.js', () => ({
  formatDeferredToolLine: (tool: { name: string }) => tool.name,
  getPrompt: () => 'mocked tool search prompt',
  isDeferredTool: (tool: { alwaysLoad?: boolean; shouldDefer?: boolean }) =>
    tool.alwaysLoad === true ? false : tool.shouldDefer === true,
  TOOL_SEARCH_TOOL_NAME: 'ToolSearch',
}))

mock.module('../SendMessageTool/SendMessageTool.js', () => ({
  SendMessageTool: { name: 'SendMessage' },
}))

mock.module('./bashPermissions.js', () => ({
  awaitClassifierAutoApproval: async () => null,
  BINARY_HIJACK_VARS: new Set(['PATH', 'BASH_ENV', 'ENV', 'SHELL']),
  bashToolHasPermission: async () => ({
    behavior: 'ask',
    message: 'mocked permission check',
  }),
  bashPermissionRule: (pattern: string) =>
    pattern.includes('*')
      ? { type: 'wildcard', pattern }
      : pattern.endsWith(':')
        ? { type: 'prefix', prefix: pattern.slice(0, -1) }
        : { type: 'exact', command: pattern },
  clearSpeculativeChecks: () => {},
  commandHasAnyCd: (command: string) =>
    command
      .split(/&&|\|\||;|\|/)
      .some(part => /^(?:\s*cd)(?:\s|$)/.test(part)),
  consumeSpeculativeClassifierCheck: () => null,
  executeAsyncClassifierCheck: async () => null,
  getFirstWordPrefix: (command: string) => command.trim().split(/\s+/)[0] ?? null,
  getSimpleCommandPrefix: (command: string) =>
    command.trim().split(/\s+/)[0] ?? null,
  isNormalizedGitCommand: (command: string) => /^git(?:\s|$)/.test(command),
  matchWildcardPattern: (pattern: string, value: string) =>
    pattern === value || pattern === '*',
  peekSpeculativeClassifierCheck: () => null,
  permissionRuleExtractPrefix: (permissionRule: string) =>
    permissionRule.split('*')[0] ?? null,
  startSpeculativeClassifierCheck: () => null,
  stripAllLeadingEnvVars: (command: string) =>
    command.replace(/^(?:[A-Za-z_]\w*=\S+\s+)+/, ''),
  stripSafeWrappers: (command: string) => command.trim(),
  stripWrappersFromArgv: (argv: string[]) => argv,
}))

const { checkReadOnlyConstraints, isCommandSafeViaFlagParsing } = await import(
  './readOnlyValidation.js'
)

describe('isCommandSafeViaFlagParsing', () => {
  it('放行明确只读的白名单命令', () => {
    expect(isCommandSafeViaFlagParsing('git status --short')).toBe(true)
    expect(isCommandSafeViaFlagParsing('date +%Y-%m-%d')).toBe(true)
    expect(isCommandSafeViaFlagParsing('hostname -f')).toBe(true)
  })

  it('拒绝会写文件或修改系统状态的危险参数', () => {
    expect(isCommandSafeViaFlagParsing('git diff --output=/tmp/pwn')).toBe(
      false,
    )
    expect(isCommandSafeViaFlagParsing('date 010101012026')).toBe(false)
    expect(isCommandSafeViaFlagParsing('hostname new-name')).toBe(false)
  })

  it('拒绝运行时展开和花括号混淆输入', () => {
    expect(isCommandSafeViaFlagParsing('rg foo $BAR')).toBe(false)
    expect(
      isCommandSafeViaFlagParsing('git diff {@{0},--output=/tmp/pwned}'),
    ).toBe(false)
    expect(isCommandSafeViaFlagParsing('git status | cat')).toBe(false)
  })

  it('拒绝空命令和无法证明安全的 xargs 目标', () => {
    expect(isCommandSafeViaFlagParsing('')).toBe(false)
    expect(isCommandSafeViaFlagParsing('xargs -I {} echo {}')).toBe(false)
    expect(isCommandSafeViaFlagParsing('xargs sh -c echo')).toBe(false)
  })
})

describe('checkReadOnlyConstraints', () => {
  it('对整体可证明只读的 BashTool 输入返回 allow 并保留输入', () => {
    const input = { command: 'pwd' } as Parameters<
      typeof checkReadOnlyConstraints
    >[0]

    expect(checkReadOnlyConstraints(input, false)).toEqual({
      behavior: 'allow',
      updatedInput: input,
    })
  })

  it('对写文件命令返回 passthrough 并交给后续权限检查', () => {
    expect(
      checkReadOnlyConstraints({ command: 'echo hi > out.txt' } as Parameters<
        typeof checkReadOnlyConstraints
      >[0], false),
    ).toEqual({
      behavior: 'passthrough',
      message: 'Command is not read-only, requires further permission checks',
    })
  })

  it('对无法解析或无法证明只读的命令保持 passthrough', () => {
    expect(
      checkReadOnlyConstraints({ command: "echo 'unterminated" } as Parameters<
        typeof checkReadOnlyConstraints
      >[0], false),
    ).toEqual({
      behavior: 'passthrough',
      message: 'Command is not read-only, requires further permission checks',
    })
  })

  it('对 cd 与 git 组合返回需要后续权限检查的 passthrough', () => {
    expect(
      checkReadOnlyConstraints({ command: 'cd .. && git status' } as Parameters<
        typeof checkReadOnlyConstraints
      >[0], true),
    ).toEqual({
      behavior: 'passthrough',
      message:
        'Compound commands with cd and git require permission checks for enhanced security',
    })
  })

  it('对写入 git 内部路径后运行 git 的复合命令返回 passthrough', () => {
    expect(
      checkReadOnlyConstraints(
        {
          command: 'mkdir -p hooks && touch hooks/pre-commit && git status',
        } as Parameters<typeof checkReadOnlyConstraints>[0],
        false,
      ),
    ).toEqual({
      behavior: 'passthrough',
      message:
        'Compound commands that create git internal files and run git require permission checks for enhanced security',
    })
  })
})
