import { describe, expect, it } from 'bun:test'
import type { Node } from './parser.js'
import {
  checkSemantics,
  nodeTypeId,
  parseForSecurity,
  parseForSecurityFromAst,
  type ParseForSecurityResult,
  type Redirect,
  type SemanticCheckResult,
  type SimpleCommand,
} from './ast.js'

function astNode(
  type: string,
  text: string,
  children: Node[] = [],
  startIndex = 0,
): Node {
  return {
    type,
    text,
    children,
    startIndex,
    endIndex: startIndex + text.length,
  } as unknown as Node
}

function command(...children: Node[]): Node {
  return astNode(
    'command',
    children.map(child => child.text).join(' '),
    children,
  )
}

function program(...children: Node[]): Node {
  return astNode(
    'program',
    children.map(child => child.text).join(' && '),
    children,
  )
}

function simpleCommand(
  argv: string[],
  text = argv.join(' '),
  envVars: { name: string; value: string }[] = [],
  redirects: Redirect[] = [],
): SimpleCommand {
  return { argv, envVars, redirects, text }
}

describe('导出类型', () => {
  it('可构造公开导出的类型结构', () => {
    const redirect: Redirect = { op: '<', target: '/tmp/input', fd: 0 }
    const commandValue: SimpleCommand = simpleCommand(
      ['cat', 'README.md'],
      'cat README.md',
      [{ name: 'LANG', value: 'C' }],
      [redirect],
    )
    const parseResult: ParseForSecurityResult = {
      kind: 'simple',
      commands: [commandValue],
    }
    const semanticResult: SemanticCheckResult = { ok: true }

    expect(parseResult.commands[0]).toEqual(commandValue)
    expect(semanticResult).toEqual({ ok: true })
  })
})

describe('nodeTypeId', () => {
  it('为空节点类型返回预检查哨兵值', () => {
    expect(nodeTypeId(undefined)).toBe(-2)
  })

  it('为 ERROR 节点返回解析错误哨兵值', () => {
    expect(nodeTypeId('ERROR')).toBe(-1)
  })

  it('为未知普通节点和已知危险节点返回稳定编号', () => {
    expect(nodeTypeId('command')).toBe(0)
    expect(nodeTypeId('command_substitution')).toBe(1)
  })
})

describe('parseForSecurity', () => {
  it('空命令返回空 simple 结果', async () => {
    await expect(parseForSecurity('')).resolves.toEqual({
      kind: 'simple',
      commands: [],
    })
  })

  it('当前测试构建中非空命令在 parser 未启用时返回 parse-unavailable', async () => {
    await expect(parseForSecurity('echo ok')).resolves.toEqual({
      kind: 'parse-unavailable',
    })
  })

  it('超长命令在 parser 层不可用时返回 parse-unavailable', async () => {
    await expect(parseForSecurity('x'.repeat(10001))).resolves.toEqual({
      kind: 'parse-unavailable',
    })
  })
})

describe('parseForSecurityFromAst', () => {
  it('只包含空白的命令返回空 simple 结果', () => {
    expect(parseForSecurityFromAst('   ', program())).toEqual({
      kind: 'simple',
      commands: [],
    })
  })

  it('控制字符和 zsh 等号展开返回 too-complex', () => {
    expect(parseForSecurityFromAst('echo \u0007', program())).toEqual({
      kind: 'too-complex',
      reason: 'Contains control characters',
    })
    expect(parseForSecurityFromAst('=curl example.com', program())).toEqual({
      kind: 'too-complex',
      reason: 'Contains zsh =cmd equals expansion',
    })
  })

  it('从最小 command AST 中抽取 argv', () => {
    expect(
      parseForSecurityFromAst(
        'echo hello',
        program(
          command(
            astNode('command_name', 'echo', [astNode('word', 'echo')]),
            astNode('word', 'hello'),
          ),
        ),
      ),
    ).toEqual({
      kind: 'simple',
      commands: [
        {
          argv: ['echo', 'hello'],
          envVars: [],
          redirects: [],
          text: 'echo hello',
        },
      ],
    })
  })

  it('跟踪前置变量赋值并在后续 simple_expansion 中替换为字面量', () => {
    expect(
      parseForSecurityFromAst(
        'TARGET=README.md cat $TARGET',
        program(
          astNode('variable_assignment', 'TARGET=README.md', [
            astNode('variable_name', 'TARGET'),
            astNode('=', '='),
            astNode('word', 'README.md'),
          ]),
          command(
            astNode('word', 'cat'),
            astNode('simple_expansion', '$TARGET', [
              astNode('$', '$'),
              astNode('variable_name', 'TARGET'),
            ]),
          ),
        ),
      ),
    ).toEqual({
      kind: 'simple',
      commands: [
        {
          argv: ['cat', 'README.md'],
          envVars: [],
          redirects: [],
          text: 'cat README.md',
        },
      ],
    })
  })
})

describe('checkSemantics', () => {
  it('普通读取命令通过语义检查', () => {
    expect(checkSemantics([simpleCommand(['cat', 'README.md'])])).toEqual({
      ok: true,
    })
  })

  it('拒绝 eval 和 timeout 包装后的 eval', () => {
    expect(checkSemantics([simpleCommand(['eval', 'echo hi'])])).toEqual({
      ok: false,
      reason: "'eval' evaluates arguments as shell code",
    })
    expect(
      checkSemantics([
        simpleCommand(['timeout', '-k', '5', '10', 'eval', 'echo hi']),
      ]),
    ).toEqual({
      ok: false,
      reason: "'eval' evaluates arguments as shell code",
    })
  })

  it('拒绝 env 和 stdbuf 中无法静态定位真实命令的参数', () => {
    expect(checkSemantics([simpleCommand(['env', '-S', 'eval echo hi'])])).toEqual(
      {
        ok: false,
        reason: 'env with -S flag cannot be statically analyzed',
      },
    )
    expect(
      checkSemantics([
        simpleCommand(['stdbuf', '--output', '0', 'eval', 'echo hi']),
      ]),
    ).toEqual({
      ok: false,
      reason: 'stdbuf with --output flag cannot be statically analyzed',
    })
  })

  it('拒绝 NAME 参数中的数组下标求值风险', () => {
    expect(
      checkSemantics([simpleCommand(['printf', '-v', 'a[$(id)]', 'x'])]),
    ).toEqual({
      ok: false,
      reason:
        "'printf -v' operand contains array subscript — bash evaluates $(cmd) in subscripts",
    })
    expect(checkSemantics([simpleCommand(['read', 'a[$(id)]'])])).toEqual({
      ok: false,
      reason:
        "'read' positional NAME 'a[$(id)]' contains array subscript — bash evaluates $(cmd) in subscripts",
    })
  })

  it('拒绝 /proc 环境文件和换行注释隐藏参数', () => {
    expect(
      checkSemantics([
        simpleCommand(['cat'], 'cat < /proc/self/environ', [], [
          { op: '<', target: '/proc/self/environ' },
        ]),
      ]),
    ).toEqual({
      ok: false,
      reason: 'Accesses /proc/*/environ which may expose secrets',
    })
    expect(
      checkSemantics([
        simpleCommand(['echo'], 'X=... echo', [
          { name: 'X', value: 'a\n# hidden' },
        ]),
      ]),
    ).toEqual({
      ok: false,
      reason:
        'Newline followed by # inside an env var value can hide arguments from path validation',
    })
  })

  it('保留只查询的 eval-like 例外分支', () => {
    expect(checkSemantics([simpleCommand(['command', '-v', 'node'])])).toEqual({
      ok: true,
    })
    expect(checkSemantics([simpleCommand(['fc', '-l'])])).toEqual({ ok: true })
  })
})
