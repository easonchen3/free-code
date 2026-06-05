import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { UUID } from 'crypto'
import { resetStateForTests, setOriginalCwd, switchSession } from '../bootstrap/state.js'
import { asAgentId, asSessionId } from '../types/ids.js'
import type { LogOption, TranscriptMessage } from '../types/logs.js'
import * as storage from './sessionStorage.js'

const OLD_ENV = { ...process.env }

let tempRoot = ''
let projectDir = ''
let sessionId: UUID

function uuid(n: number): UUID {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID
}

function iso(n: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()
}

function userMessage(n: number, content: unknown = `user ${n}`): any {
  return {
    type: 'user',
    uuid: uuid(n),
    timestamp: iso(n),
    message: { role: 'user', content },
  }
}

function assistantMessage(n: number, content: unknown = `assistant ${n}`): any {
  return {
    type: 'assistant',
    uuid: uuid(n),
    timestamp: iso(n),
    message: {
      id: `msg-${n}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }
}

function progressMessage(n: number, data: Record<string, unknown> = {}): any {
  return {
    type: 'progress',
    uuid: uuid(n),
    timestamp: iso(n),
    data,
  }
}

function transcriptEntry(
  n: number,
  type: 'user' | 'assistant' | 'system' | 'attachment' = 'user',
  parentUuid: UUID | null = null,
  overrides: Record<string, unknown> = {},
): TranscriptMessage {
  const base =
    type === 'assistant'
      ? assistantMessage(n)
      : type === 'system'
        ? { type: 'system', uuid: uuid(n), subtype: 'info', message: `system ${n}` }
        : type === 'attachment'
          ? {
              type: 'attachment',
              uuid: uuid(n),
              attachment: { type: 'text', content: `attachment ${n}` },
            }
          : userMessage(n)

  return {
    parentUuid,
    isSidechain: false,
    cwd: projectDir,
    userType: 'external',
    sessionId,
    timestamp: iso(n),
    version: 'test',
    ...base,
    ...overrides,
  } as TranscriptMessage
}

async function writeJsonl(path: string, entries: unknown[]): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true }).catch(() => undefined)
  await writeFile(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
}

function liteLog(path: string, id: UUID = sessionId): LogOption {
  return {
    date: iso(1),
    messages: [],
    fullPath: path,
    value: 0,
    created: new Date(iso(1)),
    modified: new Date(iso(2)),
    firstPrompt: '',
    messageCount: 0,
    isSidechain: false,
    isLite: true,
    sessionId: id,
  }
}

beforeEach(async () => {
  process.env.NODE_ENV = 'test'
  tempRoot = await mkdtemp(join(tmpdir(), 'session-storage-test-'))
  projectDir = join(tempRoot, 'project')
  await mkdir(projectDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = join(tempRoot, '.claude')
  process.env.USER_TYPE = 'external'
  process.env.ANTHROPIC_API_KEY = 'test-key'
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  sessionId = uuid(900)
  resetStateForTests()
  storage.resetProjectForTesting()
  storage.clearSessionMessagesCache()
  setOriginalCwd(projectDir)
  storage.resetProjectFlushStateForTesting()
  switchSession(asSessionId(sessionId))
})

afterEach(async () => {
  await storage.flushSessionStorage().catch(() => undefined)
  storage.resetProjectForTesting()
  storage.clearSessionMessagesCache()
  resetStateForTests()
  process.env = { ...OLD_ENV }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
})

describe('sessionStorage 判定和路径方法', () => {
  test('isTranscriptMessage 只接受 transcript 消息类型', () => {
    expect(storage.isTranscriptMessage({ type: 'user' } as any)).toBe(true)
    expect(storage.isTranscriptMessage({ type: 'assistant' } as any)).toBe(true)
    expect(storage.isTranscriptMessage({ type: 'attachment' } as any)).toBe(true)
    expect(storage.isTranscriptMessage({ type: 'system' } as any)).toBe(true)
    expect(storage.isTranscriptMessage({ type: 'summary' } as any)).toBe(false)
  })

  test('isChainParticipant 跳过 progress 消息', () => {
    expect(storage.isChainParticipant({ type: 'user' } as any)).toBe(true)
    expect(storage.isChainParticipant({ type: 'progress' } as any)).toBe(false)
  })

  test('isEphemeralToolProgress 识别高频临时工具进度', () => {
    expect(storage.isEphemeralToolProgress('bash_progress')).toBe(true)
    expect(storage.isEphemeralToolProgress('powershell_progress')).toBe(true)
    expect(storage.isEphemeralToolProgress('mcp_progress')).toBe(true)
    expect(storage.isEphemeralToolProgress('agent_progress')).toBe(false)
  })

  test('getProjectsDir、getTranscriptPath 和 getTranscriptPathForSession 使用隔离配置目录', () => {
    expect(storage.getProjectsDir()).toContain(process.env.CLAUDE_CONFIG_DIR!)
    expect(storage.getTranscriptPath()).toBe(
      join(storage.getProjectDir(projectDir), `${sessionId}.jsonl`),
    )
    expect(storage.getTranscriptPathForSession(uuid(901))).toBe(
      join(storage.getProjectDir(projectDir), `${uuid(901)}.jsonl`),
    )
  })

  test('agent transcript subdir 可以设置和清除', () => {
    const agentId = asAgentId('agent-a')
    const basePath = storage.getAgentTranscriptPath(agentId)
    storage.setAgentTranscriptSubdir(agentId, 'workflow/run-1')
    expect(storage.getAgentTranscriptPath(agentId)).toContain(
      join('subagents', 'workflow', 'run-1', 'agent-agent-a.jsonl'),
    )
    storage.clearAgentTranscriptSubdir(agentId)
    expect(storage.getAgentTranscriptPath(agentId)).toBe(basePath)
  })

  test('sessionIdExists 返回当前和磁盘 session 状态', async () => {
    expect(storage.sessionIdExists(sessionId)).toBe(false)
    await storage.recordTranscript([userMessage(1, 'materialize')])
    await storage.flushSessionStorage()
    expect(storage.sessionIdExists(sessionId)).toBe(true)
    const other = uuid(902)
    expect(storage.sessionIdExists(other)).toBe(false)
    await mkdir(storage.getProjectDir(projectDir), { recursive: true })
    await writeFile(storage.getTranscriptPathForSession(other), '')
    expect(storage.sessionIdExists(other)).toBe(true)
  })

  test('环境读取方法返回稳定值', () => {
    process.env.NODE_ENV = 'test'
    process.env.USER_TYPE = 'external'
    process.env.CLAUDE_CODE_CUSTOM_TITLE = '1'
    expect(storage.getNodeEnv()).toBe('test')
    expect(storage.getUserType()).toBe('external')
    expect(storage.isCustomTitleEnabled()).toBe(true)
  })
})

describe('sessionStorage metadata sidecar', () => {
  test('writeAgentMetadata/readAgentMetadata 保存和读取 subagent metadata', async () => {
    const agentId = asAgentId('agent-meta')
    await storage.writeAgentMetadata(agentId, {
      agentType: 'reviewer',
      worktreePath: join(tempRoot, 'wt'),
      description: 'check code',
    })
    await expect(storage.readAgentMetadata(agentId)).resolves.toEqual({
      agentType: 'reviewer',
      worktreePath: join(tempRoot, 'wt'),
      description: 'check code',
    })
  })

  test('remote-agent metadata 支持写、列举、读和删除', async () => {
    await storage.writeRemoteAgentMetadata('task-1', {
      taskId: 'task-1',
      sessionId,
      ccrSessionId: 'ccr-1',
      prompt: 'run remotely',
    })
    expect(await storage.readRemoteAgentMetadata('task-1')).toMatchObject({
      taskId: 'task-1',
      sessionId,
      ccrSessionId: 'ccr-1',
    })
    expect(await storage.listRemoteAgentMetadata()).toHaveLength(1)
    await storage.deleteRemoteAgentMetadata('task-1')
    expect(await storage.readRemoteAgentMetadata('task-1')).toBeNull()
  })
})

describe('sessionStorage transcript 读写', () => {
  test('recordTranscript 写入主链并返回最后一个链参与消息 UUID', async () => {
    const last = await storage.recordTranscript([
      userMessage(1, 'hello'),
      progressMessage(2),
      assistantMessage(3, [{ type: 'text', text: 'world' }]),
    ])
    await storage.flushSessionStorage()

    expect(last).toBe(uuid(3))
    const { messages } = await storage.loadTranscriptFile(storage.getTranscriptPath())
    expect([...messages.keys()]).toEqual([uuid(1), uuid(3)])
    expect(messages.get(uuid(3))?.parentUuid).toBe(uuid(1))
  })

  test('recordSidechainTranscript 写入 agent sidechain transcript', async () => {
    await storage.recordTranscript([userMessage(9, 'main before sidechain')])
    await storage.recordSidechainTranscript(
      [userMessage(10, 'agent prompt'), assistantMessage(11, 'agent answer')],
      'agent-x',
    )
    await storage.flushSessionStorage()

    const agent = await storage.getAgentTranscript(asAgentId('agent-x'))
    expect(agent?.messages.map(m => m.uuid)).toEqual([uuid(10), uuid(11)])
  })

  test('recordQueueOperation、快照和 replacement entry 可被 loadTranscriptFile 读取', async () => {
    await storage.recordTranscript([userMessage(20, 'with metadata')])
    await storage.recordQueueOperation({ type: 'queue-operation', operation: 'enqueue' } as any)
    await storage.recordFileHistorySnapshot(
      uuid(20),
      { messageId: uuid(20), files: [] } as any,
      false,
    )
    await storage.recordAttributionSnapshot({
      type: 'attribution-snapshot',
      messageId: uuid(21),
      surface: 'cli',
      fileStates: {},
    })
    await storage.recordContentReplacement([{ uuid: uuid(22), replacement: 'stub' } as any])
    await storage.flushSessionStorage()

    const loaded = await storage.loadTranscriptFile(storage.getTranscriptPath())
    expect(loaded.messages.has(uuid(20))).toBe(true)
    expect(loaded.fileHistorySnapshots.has(uuid(20))).toBe(true)
    expect(loaded.attributionSnapshots.has(uuid(21))).toBe(true)
    expect(loaded.contentReplacements.get(sessionId)).toHaveLength(1)
  })

  test('removeTranscriptMessage 删除已写入消息', async () => {
    await storage.recordTranscript([userMessage(30, 'delete me')])
    await storage.flushSessionStorage()
    await storage.removeTranscriptMessage(uuid(30))
    await storage.flushSessionStorage()
    storage.clearSessionMessagesCache()
    expect(await storage.doesMessageExistInSession(sessionId, uuid(30))).toBe(false)
  })

  test('resetSessionFilePointer 和 adoptResumedSessionFile 可安全切换当前文件指针', async () => {
    await storage.recordTranscript([userMessage(40, 'before reset')])
    await storage.flushSessionStorage()
    storage.resetSessionFilePointer()
    storage.adoptResumedSessionFile()
    storage.reAppendSessionMetadata()
    await storage.flushSessionStorage()
    expect(storage.sessionIdExists(sessionId)).toBe(true)
  })

  test('context-collapse commit 和 snapshot 按 session 持久化', async () => {
    await storage.recordTranscript([userMessage(49, 'main before collapse')])
    await storage.recordContextCollapseCommit({
      collapseId: '0000000000000001',
      summaryUuid: uuid(50),
      summaryContent: '<collapsed id="1">summary</collapsed>',
      summary: 'summary',
      firstArchivedUuid: uuid(51),
      lastArchivedUuid: uuid(52),
    })
    await storage.recordContextCollapseSnapshot({
      type: 'marble-origami-snapshot',
      sessionId,
      staged: [],
      spawnTrigger: null,
    } as any)
    await storage.flushSessionStorage()
    const loaded = await storage.loadTranscriptFile(storage.getTranscriptPath())
    expect(loaded.contextCollapseCommits).toHaveLength(1)
    expect(loaded.contextCollapseSnapshot?.sessionId).toBe(sessionId)
  })

  test('hydrateFromCCRv2InternalEvents 没有 reader 时返回 false', async () => {
    await expect(storage.hydrateFromCCRv2InternalEvents(uuid(60))).resolves.toBe(false)
  })

  test('hydrateRemoteSession 对不可用 ingress 返回 false', async () => {
    await expect(storage.hydrateRemoteSession(uuid(61), 'http://127.0.0.1:1')).resolves.toBe(false)
  })
})

describe('sessionStorage transcript 解析和链路恢复', () => {
  test('getFirstMeaningfulUserMessageTextContent 跳过 meta、内置命令和 XML 上下文', () => {
    const transcript = [
      { ...userMessage(1, 'meta'), isMeta: true },
      userMessage(2, '<command-name>/clear</command-name>'),
      userMessage(3, '<ide_selection>ignore</ide_selection>'),
      userMessage(4, [{ type: 'text', text: '<ide_opened_file>x</ide_opened_file>' }, { type: 'text', text: 'real prompt' }]),
    ]
    expect(storage.getFirstMeaningfulUserMessageTextContent(transcript)).toBe('real prompt')
  })

  test('getFirstMeaningfulUserMessageTextContent 格式化 bash 和自定义命令', () => {
    expect(
      storage.getFirstMeaningfulUserMessageTextContent([
        userMessage(2, '<bash-input>npm test</bash-input>'),
      ]),
    ).toBe('! npm test')
  })

  test('removeExtraFields 去掉 transcript 专用字段', () => {
    const clean = storage.removeExtraFields([transcriptEntry(1)])
    expect(clean[0]).not.toHaveProperty('parentUuid')
    expect(clean[0]).not.toHaveProperty('isSidechain')
    expect(clean[0]?.uuid).toBe(uuid(1))
  })

  test('buildConversationChain 从 leaf 回溯到 root，并恢复并行 tool_result sibling', () => {
    const root = transcriptEntry(1, 'user')
    const a1 = transcriptEntry(2, 'assistant', uuid(1), {
      message: { ...assistantMessage(2).message, id: 'same', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    })
    const a2 = transcriptEntry(3, 'assistant', uuid(1), {
      message: { ...assistantMessage(3).message, id: 'same', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] },
    })
    const tr1 = transcriptEntry(4, 'user', uuid(2), {
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    })
    const tr2 = transcriptEntry(5, 'user', uuid(3), {
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] },
    })
    const messages = new Map([root, a1, a2, tr1, tr2].map(m => [m.uuid, m]))
    expect(storage.buildConversationChain(messages, tr1).map(m => m.uuid)).toEqual([
      uuid(1),
      uuid(2),
      uuid(3),
      uuid(5),
      uuid(4),
    ])
  })

  test('checkResumeConsistency 对没有 checkpoint 的链 no-op', () => {
    expect(() => storage.checkResumeConsistency([userMessage(1)])).not.toThrow()
  })

  test('loadTranscriptFromFile 支持 JSONL 和 JSON transcript', async () => {
    const jsonl = join(tempRoot, 'input.jsonl')
    await writeJsonl(jsonl, [
      transcriptEntry(1, 'user'),
      transcriptEntry(2, 'assistant', uuid(1)),
      { type: 'summary', leafUuid: uuid(2), summary: 'short' },
    ])

    const fromJsonl = await storage.loadTranscriptFromFile(jsonl)
    expect(fromJsonl.messages.map(m => m.uuid)).toEqual([uuid(1), uuid(2)])
    expect(fromJsonl.summary).toBe('short')

    const json = join(tempRoot, 'input.json')
    await writeFile(json, JSON.stringify([userMessage(3, 'json prompt')]))
    const fromJson = await storage.loadTranscriptFromFile(json)
    expect(fromJson.firstPrompt).toBe('json prompt')
  })

  test('loadTranscriptFile 读取 metadata、leaf 和快照索引', async () => {
    const file = storage.getTranscriptPath()
    await writeJsonl(file, [
      transcriptEntry(1, 'user'),
      transcriptEntry(2, 'assistant', uuid(1)),
      { type: 'summary', leafUuid: uuid(2), summary: 'summary' },
      { type: 'custom-title', sessionId, customTitle: 'Title' },
      { type: 'tag', sessionId, tag: 'tag-a' },
      { type: 'agent-name', sessionId, agentName: 'Agent' },
      { type: 'agent-color', sessionId, agentColor: 'blue' },
      { type: 'agent-setting', sessionId, agentSetting: 'reviewer' },
      { type: 'mode', sessionId, mode: 'coordinator' },
      { type: 'pr-link', sessionId, prNumber: 12, prUrl: 'https://example.test/pr/12', prRepository: 'o/r', timestamp: iso(3) },
      { type: 'worktree-state', sessionId, worktreeSession: null },
    ])
    const loaded = await storage.loadTranscriptFile(file)
    expect(loaded.summaries.get(uuid(2))).toBe('summary')
    expect(loaded.customTitles.get(sessionId)).toBe('Title')
    expect(loaded.tags.get(sessionId)).toBe('tag-a')
    expect(loaded.agentNames.get(sessionId)).toBe('Agent')
    expect(loaded.agentColors.get(sessionId)).toBe('blue')
    expect(loaded.agentSettings.get(sessionId)).toBe('reviewer')
    expect(loaded.modes.get(sessionId)).toBe('coordinator')
    expect(loaded.prNumbers.get(sessionId)).toBe(12)
    expect(loaded.worktreeStates.has(sessionId)).toBe(true)
    expect(loaded.leafUuids.has(uuid(2))).toBe(true)
  })
})

describe('sessionStorage session metadata API', () => {
  test('saveCustomTitle、saveTag、PR、agent、mode 和 worktree 状态可写入并恢复缓存', async () => {
    await storage.saveCustomTitle(sessionId, 'Custom')
    storage.saveAiGeneratedTitle(sessionId, 'AI')
    storage.saveTaskSummary(sessionId, 'Doing work')
    await storage.saveTag(sessionId, 'tag-1')
    await storage.linkSessionToPR(sessionId, 7, 'https://example.test/pr/7', 'owner/repo')
    await storage.saveAgentName(sessionId, 'Reviewer')
    await storage.saveAgentColor(sessionId, 'green')
    storage.saveAgentSetting('agent-setting')
    storage.cacheSessionTitle('Startup Title')
    storage.saveMode('coordinator')
    storage.saveWorktreeState({
      originalCwd: projectDir,
      worktreePath: join(tempRoot, 'worktree'),
      worktreeName: 'wt',
      sessionId,
      creationDurationMs: 99,
    } as any)
    await storage.flushSessionStorage()

    expect(storage.getCurrentSessionTag(sessionId)).toBe('tag-1')
    expect(storage.getCurrentSessionTitle(asSessionId(sessionId))).toBe('Startup Title')
    expect(storage.getCurrentSessionAgentColor()).toBe('green')

    storage.clearSessionMetadata()
    expect(storage.getCurrentSessionTag(sessionId)).toBeUndefined()
    storage.restoreSessionMetadata({ customTitle: 'Restored', tag: 'restored', agentColor: 'red' })
    expect(storage.getCurrentSessionTitle(asSessionId(sessionId))).toBe('Restored')
    expect(storage.getCurrentSessionTag(sessionId)).toBe('restored')
    expect(storage.getCurrentSessionAgentColor()).toBe('red')
  })

  test('getSessionIdFromLog 和 isLiteLog 区分 lite/full log', () => {
    const lite = liteLog('x')
    expect(storage.isLiteLog(lite)).toBe(true)
    expect(storage.getSessionIdFromLog(lite)).toBe(sessionId)

    const full = { ...lite, messages: [transcriptEntry(1)], sessionId: undefined }
    expect(storage.isLiteLog(full)).toBe(false)
    expect(storage.getSessionIdFromLog(full)).toBe(sessionId)
  })
})

describe('sessionStorage 日志列表 API', () => {
  test('getSessionFilesWithMtime 和 getSessionFilesLite 基于文件系统生成 lite log', async () => {
    const project = storage.getProjectDir(projectDir)
    await mkdir(project, { recursive: true })
    await writeFile(join(project, `${sessionId}.jsonl`), '')

    const files = await storage.getSessionFilesWithMtime(project)
    expect(files.get(sessionId)?.path).toBe(join(project, `${sessionId}.jsonl`))

    const logs = await storage.getSessionFilesLite(project, 1, projectDir)
    expect(logs).toHaveLength(1)
    expect(logs[0]?.isLite).toBe(true)
  })

  test('enrichLogs、loadFullLog、loadMessageLogs 和 getLogByIndex 返回可展示 session', async () => {
    const file = storage.getTranscriptPath()
    await writeJsonl(file, [transcriptEntry(1, 'user'), transcriptEntry(2, 'assistant', uuid(1))])
    await storage.saveCustomTitle(sessionId, 'Searchable Title')
    await storage.flushSessionStorage()

    const lite = liteLog(file)
    const { logs, nextIndex } = await storage.enrichLogs([lite], 0, 1)
    expect(nextIndex).toBe(1)
    expect(logs[0]?.firstPrompt).toBe('user 1')

    const full = await storage.loadFullLog(logs[0]!)
    expect(full.messages.map(m => m.uuid)).toEqual([uuid(1), uuid(2)])

    const currentLogs = await storage.loadMessageLogs()
    expect(currentLogs.length).toBeGreaterThanOrEqual(1)
    expect(await storage.getLogByIndex(0)).not.toBeNull()
  })

  test('fetchLogs、loadAllProjectsMessageLogs、progressive、sameRepo 和 searchSessionsByCustomTitle', async () => {
    const file = storage.getTranscriptPath()
    await writeJsonl(file, [transcriptEntry(1, 'user')])
    await storage.saveCustomTitle(sessionId, 'Needle Title')
    await storage.flushSessionStorage()

    expect(await storage.fetchLogs(10)).toHaveLength(1)
    expect(await storage.loadAllProjectsMessageLogs(10)).toHaveLength(1)

    const progressive = await storage.loadAllProjectsMessageLogsProgressive(10, 1)
    expect(progressive.logs).toHaveLength(1)
    expect(progressive.allStatLogs.length).toBeGreaterThanOrEqual(1)

    expect(await storage.loadSameRepoMessageLogs([projectDir], 10, 1)).toHaveLength(1)
    const sameRepoProgressive = await storage.loadSameRepoMessageLogsProgressive([projectDir], 10, 1)
    expect(sameRepoProgressive.logs).toHaveLength(1)

    const found = await storage.searchSessionsByCustomTitle('needle')
    expect(found[0]?.customTitle).toBe('Needle Title')
  })

  test('loadAllLogsFromSessionFile 和 getLastSessionLog 返回 full log', async () => {
    const file = storage.getTranscriptPath()
    await writeJsonl(file, [transcriptEntry(1, 'user'), transcriptEntry(2, 'assistant', uuid(1))])
    const logs = await storage.loadAllLogsFromSessionFile(file)
    expect(logs).toHaveLength(1)
    expect(logs[0]?.messages.map(m => m.uuid)).toEqual([uuid(1), uuid(2)])

    const last = await storage.getLastSessionLog(sessionId)
    expect(last?.messages.map(m => m.uuid)).toEqual([uuid(1), uuid(2)])
  })
})

describe('sessionStorage subagent、清理和工具辅助方法', () => {
  test('extractAgentIdsFromMessages 和 extractTeammateTranscriptsFromTasks 提取内存 transcript', () => {
    expect(
      storage.extractAgentIdsFromMessages([
        progressMessage(1, { type: 'agent_progress', agentId: 'a' }),
        progressMessage(2, { type: 'skill_progress', agentId: 'a' }),
        progressMessage(3, { type: 'other', agentId: 'b' }),
      ]),
    ).toEqual(['a'])

    const messages = [userMessage(1, 'task')]
    expect(
      storage.extractTeammateTranscriptsFromTasks({
        t1: { type: 'in_process_teammate', identity: { agentId: 'agent-1' }, messages },
        t2: { type: 'other', identity: { agentId: 'agent-2' }, messages },
      }),
    ).toEqual({ 'agent-1': messages })
  })

  test('loadSubagentTranscripts 和 loadAllSubagentTranscriptsFromDisk 读取磁盘 subagent', async () => {
    await storage.recordTranscript([userMessage(0, 'main before subagent')])
    await storage.recordSidechainTranscript([userMessage(1, 'sub')], 'agent-disk')
    await storage.flushSessionStorage()

    expect(await storage.loadSubagentTranscripts(['agent-disk'])).toHaveProperty('agent-disk')
    expect(await storage.loadAllSubagentTranscriptsFromDisk()).toHaveProperty('agent-disk')
  })

  test('isLoggableMessage 和 cleanMessagesForLogging 过滤 progress、attachment 和 REPL wrapper', () => {
    expect(storage.isLoggableMessage(progressMessage(1))).toBe(false)
    expect(
      storage.isLoggableMessage({
        type: 'attachment',
        uuid: uuid(2),
        attachment: { type: 'file', filePath: 'secret' },
      } as any),
    ).toBe(false)

    const cleaned = storage.cleanMessagesForLogging([
      userMessage(1, 'keep'),
      progressMessage(2),
      {
        ...assistantMessage(3),
        isVirtual: true,
        message: {
          ...assistantMessage(3).message,
          content: [{ type: 'tool_use', id: 'repl-1', name: 'REPL', input: {} }],
        },
      },
      {
        ...userMessage(4),
        isVirtual: true,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'repl-1', content: 'result' }],
        },
      },
    ])
    expect(cleaned.map(m => m.uuid)).toEqual([uuid(1)])
  })

  test('findUnresolvedToolUse 返回未闭合工具调用，已有结果时返回 null', async () => {
    await writeJsonl(storage.getTranscriptPath(), [
      transcriptEntry(1, 'assistant', null, {
        message: {
          ...assistantMessage(1).message,
          content: [{ type: 'tool_use', id: 'open-tool', name: 'Read', input: {} }],
        },
      }),
    ])
    expect((await storage.findUnresolvedToolUse('open-tool'))?.uuid).toBe(uuid(1))

    await writeJsonl(storage.getTranscriptPath(), [
      transcriptEntry(1, 'assistant', null, {
        message: {
          ...assistantMessage(1).message,
          content: [{ type: 'tool_use', id: 'closed-tool', name: 'Read', input: {} }],
        },
      }),
      transcriptEntry(2, 'user', uuid(1), {
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'closed-tool', content: 'ok' }],
        },
      }),
    ])
    expect(await storage.findUnresolvedToolUse('closed-tool')).toBeNull()
  })

  test('clearSessionMessagesCache 和 doesMessageExistInSession 维护消息存在性缓存', async () => {
    await writeJsonl(storage.getTranscriptPath(), [transcriptEntry(1, 'user')])
    expect(await storage.doesMessageExistInSession(sessionId, uuid(1))).toBe(true)
    storage.clearSessionMessagesCache()
    expect(await storage.doesMessageExistInSession(sessionId, uuid(2))).toBe(false)
  })

  test('resetProjectFlushStateForTesting、setSessionFileForTesting、setRemoteIngressUrlForTesting 可安全调用', () => {
    storage.resetProjectFlushStateForTesting()
    storage.setSessionFileForTesting(join(tempRoot, 'manual.jsonl'))
    storage.setRemoteIngressUrlForTesting('https://example.test/ingress')
    expect(() => storage.resetProjectFlushStateForTesting()).not.toThrow()
  })
})
