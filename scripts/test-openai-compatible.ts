import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'

type MacroShape = {
  VERSION: string
  BUILD_TIME: string
  PACKAGE_URL: string
  FEEDBACK_CHANNEL: string
}

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as typeof globalThis & { MACRO: MacroShape }).MACRO = {
    VERSION: 'dev-test',
    BUILD_TIME: new Date().toISOString(),
    PACKAGE_URL: 'local-test',
    FEEDBACK_CHANNEL: 'github',
  }
}

const { enableConfigs } = await import('../src/utils/config.js')
const { getAnthropicClient } = await import('../src/services/api/client.js')

enableConfigs()

process.env.CLAUDE_CODE_USE_OPENAI_COMPATIBLE ??= '1'

type LoadedConfigSource =
  | 'environment'
  | 'project-local'
  | 'project-shared'
  | 'user-global'
  | 'none'

let loadedConfigSource: LoadedConfigSource = 'environment'
let loadedConfigPath: string | null = null

function getUserConfigHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

function loadJsonConfigEnv(): void {
  const configCandidates = [
    {
      path: resolve(process.cwd(), '.claude', 'settings.local.json'),
      source: 'project-local' as const,
    },
    {
      path: resolve(process.cwd(), '.claude', 'settings.json'),
      source: 'project-shared' as const,
    },
    {
      path: resolve(getUserConfigHome(), 'settings.json'),
      source: 'user-global' as const,
    },
  ]

  for (const candidate of configCandidates) {
    const filePath = candidate.path
    if (!existsSync(filePath)) {
      continue
    }

    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as {
        model?: unknown
        env?: Record<string, unknown>
      }
      let appliedFromFile = false

      if (parsed.env && typeof parsed.env === 'object') {
        for (const [key, value] of Object.entries(parsed.env)) {
          if (value == null || process.env[key] !== undefined) {
            continue
          }
          process.env[key] = String(value)
          appliedFromFile = true
        }
      }

      if (
        typeof parsed.model === 'string' &&
        !process.env.OPENAI_COMPATIBLE_MODEL &&
        !process.env.OPENAI_MODEL
      ) {
        process.env.OPENAI_COMPATIBLE_MODEL = parsed.model
        appliedFromFile = true
      }

      if (appliedFromFile) {
        loadedConfigSource = candidate.source
        loadedConfigPath = filePath
      }
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `警告：解析配置文件失败 ${filePath}：${message}\n`,
      )
      return
    }
  }

  loadedConfigSource = 'none'
}

loadJsonConfigEnv()

function getFlagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  if (index === -1) {
    return undefined
  }
  return process.argv[index + 1]
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

function getPrompt(): string {
  const args = process.argv.slice(2)
  const positionalArgs: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (!arg) {
      continue
    }
    if (arg === '--model' || arg === '--max-tokens') {
      index += 1
      continue
    }
    if (arg === '--json') {
      continue
    }
    if (arg.startsWith('--')) {
      continue
    }
    positionalArgs.push(arg)
  }

  if (positionalArgs.length > 0) {
    return positionalArgs.join(' ')
  }

  return 'Reply with exactly: openai-compatible-ok'
}

const apiKey =
  process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.OPENAI_API_KEY
const baseUrl =
  process.env.OPENAI_COMPATIBLE_BASE_URL ?? process.env.OPENAI_BASE_URL
const model =
  getFlagValue('--model') ??
  process.env.OPENAI_COMPATIBLE_MODEL ??
  process.env.OPENAI_MODEL
const thinkingType =
  process.env.OPENAI_COMPATIBLE_THINKING_TYPE ??
  process.env.OPENAI_THINKING_TYPE
const prompt = getPrompt()
const maxTokens = Number.parseInt(getFlagValue('--max-tokens') ?? '256', 10)

if (!apiKey) {
  process.stderr.write(
    '验证失败：缺少 API Key。请设置 OPENAI_COMPATIBLE_API_KEY 或 OPENAI_API_KEY。\n',
  )
  process.exit(1)
}

if (!baseUrl) {
  process.stderr.write(
    '验证失败：缺少接口地址。请设置 OPENAI_COMPATIBLE_BASE_URL 或 OPENAI_BASE_URL。\n',
  )
  process.exit(1)
}

if (!model) {
  process.stderr.write(
    '验证失败：缺少模型名。请设置 OPENAI_COMPATIBLE_MODEL、OPENAI_MODEL，或通过 --model 传入。\n',
  )
  process.exit(1)
}

function getConfigSourceLabel(): string {
  switch (loadedConfigSource) {
    case 'environment':
      return '环境变量'
    case 'project-local':
      return `项目本地配置 (${loadedConfigPath})`
    case 'project-shared':
      return `项目共享配置 (${loadedConfigPath})`
    case 'user-global':
      return `用户全局配置 (${loadedConfigPath})`
    case 'none':
      return '未从 JSON 配置文件读取，当前仅依赖环境变量'
  }
}

function maskApiKey(value: string): string {
  if (value.length <= 10) {
    return '******'
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

try {
  const client = await getAnthropicClient({
    maxRetries: 0,
    model,
    source: 'openai-compatible-test-script',
  })

  const response = await client.messages.create({
    model,
    max_tokens: Number.isFinite(maxTokens) ? Math.max(1, maxTokens) : 256,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  })

  if (hasFlag('--json')) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`)
    process.exit(0)
  }

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')

  process.stdout.write('OpenAI-compatible 接口验证结果\n')
  process.stdout.write('================================\n')
  process.stdout.write(`验证结论：通过\n`)
  process.stdout.write(`配置来源：${getConfigSourceLabel()}\n`)
  process.stdout.write(`接口地址：${baseUrl}\n`)
  process.stdout.write(`模型名称：${response.model}\n`)
  process.stdout.write(
    `Thinking 配置：${thinkingType ? thinkingType : '未配置'}\n`,
  )
  process.stdout.write(`API Key：${maskApiKey(apiKey)}\n`)
  process.stdout.write(`停止原因：${response.stop_reason}\n`)
  process.stdout.write(
    `Token 用量：输入 ${response.usage.input_tokens} / 输出 ${response.usage.output_tokens}\n`,
  )
  process.stdout.write(`测试提示词：${prompt}\n`)
  process.stdout.write('模型返回：\n')
  process.stdout.write(`${text || '(空响应)'}\n`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write('OpenAI-compatible 接口验证结果\n')
  process.stderr.write('================================\n')
  process.stderr.write('验证结论：不通过\n')
  process.stderr.write(`配置来源：${getConfigSourceLabel()}\n`)
  process.stderr.write(`接口地址：${baseUrl}\n`)
  process.stderr.write(`模型名称：${model}\n`)
  process.stderr.write(
    `Thinking 配置：${thinkingType ? thinkingType : '未配置'}\n`,
  )
  process.stderr.write(`API Key：${maskApiKey(apiKey)}\n`)
  process.stderr.write(`测试提示词：${prompt}\n`)
  process.stderr.write(`失败原因：${message}\n`)
  process.exit(1)
}
