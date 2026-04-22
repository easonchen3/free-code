import { randomUUID } from 'crypto'

type AnthropicContentBlock = {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  source?: {
    type?: string
    media_type?: string
    data?: string
    url?: string
  }
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
}

type AnthropicMessage = {
  role: string
  content: string | AnthropicContentBlock[]
}

type AnthropicTool = {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

type OpenAIChatCompletionChoice = {
  index: number
  message: {
    role: 'assistant'
    content?: string | null
    tool_calls?: Array<{
      id?: string
      type?: 'function'
      function?: {
        name?: string
        arguments?: string
      }
    }>
  }
  finish_reason: string | null
}

type OpenAIChatCompletionResponse = {
  id: string
  model: string
  choices: OpenAIChatCompletionChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

function getOpenAICompatibleThinkingType(): 'enabled' | 'disabled' | undefined {
  const rawValue =
    process.env.OPENAI_COMPATIBLE_THINKING_TYPE?.trim() ??
    process.env.OPENAI_THINKING_TYPE?.trim()
  if (!rawValue) {
    return undefined
  }

  const normalized = rawValue.toLowerCase()
  if (normalized === 'enabled' || normalized === 'disabled') {
    return normalized
  }

  return undefined
}

function parseCustomHeaders(
  rawHeaders: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!rawHeaders) {
    return headers
  }

  for (const line of rawHeaders.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const separatorIndex = trimmed.indexOf(':')
    if (separatorIndex === -1) continue
    const name = trimmed.slice(0, separatorIndex).trim()
    const value = trimmed.slice(separatorIndex + 1).trim()
    if (name) {
      headers[name] = value
    }
  }

  return headers
}

function getOpenAIChatCompletionsUrl(): string {
  const baseUrl =
    process.env.OPENAI_COMPATIBLE_BASE_URL?.trim() ??
    process.env.OPENAI_BASE_URL?.trim()
  if (!baseUrl) {
    return 'https://api.openai.com/v1/chat/completions'
  }

  const normalizedBase = baseUrl.replace(/\/+$/, '')
  if (normalizedBase.endsWith('/chat/completions')) {
    return normalizedBase
  }
  if (normalizedBase.endsWith('/v1')) {
    return `${normalizedBase}/chat/completions`
  }
  return `${normalizedBase}/v1/chat/completions`
}

function getOpenAIRequestHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    ...(process.env.OPENAI_COMPATIBLE_ORGANIZATION ||
    process.env.OPENAI_ORGANIZATION
      ? {
          'OpenAI-Organization':
            process.env.OPENAI_COMPATIBLE_ORGANIZATION ??
            process.env.OPENAI_ORGANIZATION!,
        }
      : {}),
    ...(process.env.OPENAI_COMPATIBLE_PROJECT || process.env.OPENAI_PROJECT
      ? {
          'OpenAI-Project':
            process.env.OPENAI_COMPATIBLE_PROJECT ?? process.env.OPENAI_PROJECT!,
        }
      : {}),
    ...parseCustomHeaders(
      process.env.OPENAI_COMPATIBLE_CUSTOM_HEADERS ??
        process.env.OPENAI_CUSTOM_HEADERS,
    ),
  }
}

function extractTextFromBlockContent(
  content: string | AnthropicContentBlock[] | undefined,
): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map(block => {
      if (block.type === 'text') {
        return block.text ?? ''
      }
      if (block.type === 'image') {
        return '[Image attached]'
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function flushBufferedUserContent(
  openAIMessages: Array<Record<string, unknown>>,
  bufferedUserContent: Array<Record<string, unknown>>,
): void {
  if (bufferedUserContent.length === 0) {
    return
  }

  if (
    bufferedUserContent.length === 1 &&
    bufferedUserContent[0]?.type === 'text'
  ) {
    openAIMessages.push({
      role: 'user',
      content: bufferedUserContent[0].text,
    })
  } else {
    openAIMessages.push({
      role: 'user',
      content: bufferedUserContent,
    })
  }

  bufferedUserContent.length = 0
}

function translateMessages(
  anthropicMessages: AnthropicMessage[],
): Array<Record<string, unknown>> {
  const openAIMessages: Array<Record<string, unknown>> = []

  for (const message of anthropicMessages) {
    if (typeof message.content === 'string') {
      openAIMessages.push({
        role: message.role,
        content: message.content,
      })
      continue
    }

    if (!Array.isArray(message.content)) {
      continue
    }

    if (message.role === 'user') {
      const bufferedUserContent: Array<Record<string, unknown>> = []

      for (const block of message.content) {
        if (block.type === 'tool_result') {
          flushBufferedUserContent(openAIMessages, bufferedUserContent)
          openAIMessages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id ?? `tool_${randomUUID()}`,
            content: extractTextFromBlockContent(block.content),
          })
          continue
        }

        if (block.type === 'text' && typeof block.text === 'string') {
          bufferedUserContent.push({
            type: 'text',
            text: block.text,
          })
          continue
        }

        if (block.type === 'image' && block.source) {
          const imageUrl =
            block.source.type === 'base64' &&
            block.source.media_type &&
            block.source.data
              ? `data:${block.source.media_type};base64,${block.source.data}`
              : block.source.url
          if (imageUrl) {
            bufferedUserContent.push({
              type: 'image_url',
              image_url: {
                url: imageUrl,
              },
            })
          }
        }
      }

      flushBufferedUserContent(openAIMessages, bufferedUserContent)
      continue
    }

    const textParts: string[] = []
    const toolCalls: Array<Record<string, unknown>> = []

    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text)
        continue
      }

      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id ?? `tool_${randomUUID()}`,
          type: 'function',
          function: {
            name: block.name ?? '',
            arguments: JSON.stringify(block.input ?? {}),
          },
        })
      }
    }

    if (textParts.length > 0 || toolCalls.length > 0) {
      openAIMessages.push({
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('') : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
    }
  }

  return openAIMessages
}

function translateTools(
  anthropicTools: AnthropicTool[],
): Array<Record<string, unknown>> {
  return anthropicTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.input_schema ?? {
        type: 'object',
        properties: {},
      },
    },
  }))
}

function translateToolChoice(
  anthropicToolChoice: unknown,
): Record<string, unknown> | string | undefined {
  if (
    anthropicToolChoice &&
    typeof anthropicToolChoice === 'object' &&
    'type' in anthropicToolChoice &&
    anthropicToolChoice.type === 'tool' &&
    'name' in anthropicToolChoice &&
    typeof anthropicToolChoice.name === 'string'
  ) {
    return {
      type: 'function',
      function: {
        name: anthropicToolChoice.name,
      },
    }
  }

  if (
    anthropicToolChoice &&
    typeof anthropicToolChoice === 'object' &&
    'type' in anthropicToolChoice &&
    anthropicToolChoice.type === 'auto'
  ) {
    return 'auto'
  }

  return undefined
}

function translateToOpenAIChatCompletionsBody(
  anthropicBody: Record<string, unknown>,
  stream: boolean,
): Record<string, unknown> {
  const anthropicMessages = (anthropicBody.messages ?? []) as AnthropicMessage[]
  const anthropicSystem = anthropicBody.system as
    | string
    | Array<{ type?: string; text?: string }>
    | undefined
  const anthropicTools = (anthropicBody.tools ?? []) as AnthropicTool[]

  const systemText =
    typeof anthropicSystem === 'string'
      ? anthropicSystem
      : Array.isArray(anthropicSystem)
        ? anthropicSystem
            .filter(block => block.type === 'text' && typeof block.text === 'string')
            .map(block => block.text)
            .join('\n\n')
        : ''

  const messages: Array<Record<string, unknown>> = []
  if (systemText) {
    messages.push({
      role: 'system',
      content: systemText,
    })
  }
  messages.push(...translateMessages(anthropicMessages))

  const body: Record<string, unknown> = {
    model: anthropicBody.model,
    messages,
    stream,
    ...(typeof anthropicBody.temperature === 'number'
      ? { temperature: anthropicBody.temperature }
      : {}),
    ...(typeof anthropicBody.max_tokens === 'number'
      ? { max_tokens: anthropicBody.max_tokens }
      : {}),
  }

  const thinkingType = getOpenAICompatibleThinkingType()
  if (thinkingType) {
    body.thinking = {
      type: thinkingType,
    }
  }

  const toolChoice = translateToolChoice(anthropicBody.tool_choice)
  if (toolChoice !== undefined) {
    body.tool_choice = toolChoice
  }

  if (anthropicTools.length > 0) {
    body.tools = translateTools(anthropicTools)
  }

  return body
}

function mapFinishReasonToStopReason(
  finishReason: string | null | undefined,
): string {
  switch (finishReason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'refusal'
    case 'stop':
    default:
      return 'end_turn'
  }
}

function buildAnthropicUsage(
  usage: OpenAIChatCompletionResponse['usage'] | undefined,
): Record<string, unknown> {
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
  }
}

function buildAnthropicContentFromChoice(
  choice: OpenAIChatCompletionChoice | undefined,
): Array<Record<string, unknown>> {
  if (!choice) {
    return [
      {
        type: 'text',
        text: '',
      },
    ]
  }

  const contentBlocks: Array<Record<string, unknown>> = []

  if (choice.message.content) {
    contentBlocks.push({
      type: 'text',
      text: choice.message.content,
    })
  }

  for (const toolCall of choice.message.tool_calls ?? []) {
    let parsedInput: Record<string, unknown> = {}
    const rawArguments = toolCall.function?.arguments ?? '{}'
    try {
      const parsed = JSON.parse(rawArguments)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedInput = parsed as Record<string, unknown>
      }
    } catch {
      parsedInput = {}
    }

    contentBlocks.push({
      type: 'tool_use',
      id: toolCall.id ?? `tool_${randomUUID()}`,
      name: toolCall.function?.name ?? '',
      input: parsedInput,
    })
  }

  if (contentBlocks.length === 0) {
    contentBlocks.push({
      type: 'text',
      text: '',
    })
  }

  return contentBlocks
}

function translateOpenAIResponseToAnthropicResponse(
  response: OpenAIChatCompletionResponse,
): Response {
  const choice = response.choices[0]
  const anthropicBody = {
    id: response.id ?? `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    content: buildAnthropicContentFromChoice(choice),
    model: response.model,
    stop_reason: mapFinishReasonToStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: buildAnthropicUsage(response.usage),
  }

  return new Response(JSON.stringify(anthropicBody), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'request-id': response.id ?? `msg_${randomUUID()}`,
      'x-request-id': response.id ?? `msg_${randomUUID()}`,
    },
  })
}

function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

function createAnthropicStreamResponse(
  responseId: string,
  model: string,
  stream: ReadableStream,
): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'request-id': responseId,
      'x-request-id': responseId,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': '',
      model,
    },
  })
}

async function translateOpenAIStreamToAnthropic(
  openAIResponse: Response,
  model: string,
): Promise<Response> {
  const responseId = openAIResponse.headers.get('x-request-id') ?? `msg_${randomUUID()}`
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      const decoder = new TextDecoder()
      const reader = openAIResponse.body?.getReader()
      const messageId = responseId

      let textBlockIndex: number | null = null
      let nextContentBlockIndex = 0
      let lastFinishReason: string | null = null
      const openToolBlocks = new Map<
        number,
        {
          contentBlockIndex: number
          toolCallId: string
          toolName: string
        }
      >()

      controller.enqueue(
        encoder.encode(
          formatSSE(
            'message_start',
            JSON.stringify({
              type: 'message_start',
              message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model,
                stop_reason: null,
                stop_sequence: null,
                usage,
              },
            }),
          ),
        ),
      )

      if (!reader) {
        controller.enqueue(
          encoder.encode(
            formatSSE(
              'message_delta',
              JSON.stringify({
                type: 'message_delta',
                delta: {
                  stop_reason: 'end_turn',
                  stop_sequence: null,
                },
                usage,
              }),
            ),
          ),
        )
        controller.enqueue(
          encoder.encode(
            formatSSE(
              'message_stop',
              JSON.stringify({
                type: 'message_stop',
              }),
            ),
          ),
        )
        controller.close()
        return
      }

      let buffered = ''

      const closeTextBlock = () => {
        if (textBlockIndex === null) {
          return
        }
        controller.enqueue(
          encoder.encode(
            formatSSE(
              'content_block_stop',
              JSON.stringify({
                type: 'content_block_stop',
                index: textBlockIndex,
              }),
            ),
          ),
        )
        textBlockIndex = null
      }

      const closeToolBlocks = () => {
        for (const { contentBlockIndex } of openToolBlocks.values()) {
          controller.enqueue(
            encoder.encode(
              formatSSE(
                'content_block_stop',
                JSON.stringify({
                  type: 'content_block_stop',
                  index: contentBlockIndex,
                }),
              ),
            ),
          )
        }
        openToolBlocks.clear()
      }

      const ensureTextBlock = () => {
        if (textBlockIndex !== null) {
          return textBlockIndex
        }
        const index = nextContentBlockIndex++
        textBlockIndex = index
        controller.enqueue(
          encoder.encode(
            formatSSE(
              'content_block_start',
              JSON.stringify({
                type: 'content_block_start',
                index,
                content_block: {
                  type: 'text',
                  text: '',
                },
              }),
            ),
          ),
        )
        return index
      }

      const ensureToolBlock = (
        toolCallIndex: number,
        toolCallId?: string,
        toolName?: string,
      ) => {
        const existing = openToolBlocks.get(toolCallIndex)
        if (existing) {
          if (toolCallId) existing.toolCallId = toolCallId
          if (toolName) existing.toolName = toolName
          return existing.contentBlockIndex
        }

        const contentBlockIndex = nextContentBlockIndex++
        const state = {
          contentBlockIndex,
          toolCallId: toolCallId ?? `tool_${randomUUID()}`,
          toolName: toolName ?? '',
        }
        openToolBlocks.set(toolCallIndex, state)

        controller.enqueue(
          encoder.encode(
            formatSSE(
              'content_block_start',
              JSON.stringify({
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: {
                  type: 'tool_use',
                  id: state.toolCallId,
                  name: state.toolName,
                  input: {},
                },
              }),
            ),
          ),
        )

        return contentBlockIndex
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }

        buffered += decoder.decode(value, { stream: true })
        const chunks = buffered.split('\n')
        buffered = chunks.pop() ?? ''

        for (const rawLine of chunks) {
          const line = rawLine.trim()
          if (!line || !line.startsWith('data: ')) {
            continue
          }

          const data = line.slice(6)
          if (data === '[DONE]') {
            continue
          }

          let chunk: Record<string, unknown>
          try {
            chunk = JSON.parse(data)
          } catch {
            continue
          }

          const chunkUsage = chunk.usage as
            | {
                prompt_tokens?: number
                completion_tokens?: number
              }
            | undefined
          if (chunkUsage) {
            usage.input_tokens = chunkUsage.prompt_tokens ?? usage.input_tokens
            usage.output_tokens =
              chunkUsage.completion_tokens ?? usage.output_tokens
          }

          const choices = Array.isArray(chunk.choices)
            ? (chunk.choices as Array<Record<string, unknown>>)
            : []
          for (const choice of choices) {
            const finishReason =
              typeof choice.finish_reason === 'string'
                ? choice.finish_reason
                : null
            if (finishReason) {
              lastFinishReason = finishReason
            }

            const delta =
              choice.delta && typeof choice.delta === 'object'
                ? (choice.delta as Record<string, unknown>)
                : {}

            const content = delta.content
            if (typeof content === 'string' && content.length > 0) {
              const blockIndex = ensureTextBlock()
              controller.enqueue(
                encoder.encode(
                  formatSSE(
                    'content_block_delta',
                    JSON.stringify({
                      type: 'content_block_delta',
                      index: blockIndex,
                      delta: {
                        type: 'text_delta',
                        text: content,
                      },
                    }),
                  ),
                ),
              )
            }

            const toolCalls = Array.isArray(delta.tool_calls)
              ? (delta.tool_calls as Array<Record<string, unknown>>)
              : []
            if (toolCalls.length > 0) {
              closeTextBlock()
            }

            for (const toolCall of toolCalls) {
              const toolCallIndex =
                typeof toolCall.index === 'number' ? toolCall.index : 0
              const functionData =
                toolCall.function && typeof toolCall.function === 'object'
                  ? (toolCall.function as Record<string, unknown>)
                  : {}
              const contentBlockIndex = ensureToolBlock(
                toolCallIndex,
                typeof toolCall.id === 'string' ? toolCall.id : undefined,
                typeof functionData.name === 'string'
                  ? functionData.name
                  : undefined,
              )
              const partialArguments =
                typeof functionData.arguments === 'string'
                  ? functionData.arguments
                  : ''
              if (partialArguments) {
                controller.enqueue(
                  encoder.encode(
                    formatSSE(
                      'content_block_delta',
                      JSON.stringify({
                        type: 'content_block_delta',
                        index: contentBlockIndex,
                        delta: {
                          type: 'input_json_delta',
                          partial_json: partialArguments,
                        },
                      }),
                    ),
                  ),
                )
              }
            }
          }
        }
      }

      closeTextBlock()
      closeToolBlocks()

      controller.enqueue(
        encoder.encode(
          formatSSE(
            'message_delta',
            JSON.stringify({
              type: 'message_delta',
              delta: {
                stop_reason: mapFinishReasonToStopReason(lastFinishReason),
                stop_sequence: null,
              },
              usage,
            }),
          ),
        ),
      )
      controller.enqueue(
        encoder.encode(
          formatSSE(
            'message_stop',
            JSON.stringify({
              type: 'message_stop',
            }),
          ),
        ),
      )
      controller.close()
    },
  })

  return createAnthropicStreamResponse(responseId, model, stream)
}

function createAnthropicErrorResponse(
  status: number,
  message: string,
): Response {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: {
        type: 'api_error',
        message,
      },
    }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
      },
    },
  )
}

export function createOpenAIChatCompletionsFetch(
  apiKey: string,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const inputUrl = input instanceof Request ? input.url : String(input)
    if (!inputUrl.includes('/v1/messages')) {
      return globalThis.fetch(input, init)
    }

    let anthropicBody: Record<string, unknown> = {}
    try {
      const bodyText =
        typeof init?.body === 'string'
          ? init.body
          : init?.body
            ? await new Response(init.body).text()
            : '{}'
      anthropicBody = JSON.parse(bodyText)
    } catch {
      anthropicBody = {}
    }

    const stream = anthropicBody.stream === true
    const requestBody = translateToOpenAIChatCompletionsBody(
      anthropicBody,
      stream,
    )

    const response = await globalThis.fetch(getOpenAIChatCompletionsUrl(), {
      method: 'POST',
      headers: {
        ...getOpenAIRequestHeaders(apiKey),
        ...(stream ? { Accept: 'text/event-stream' } : {}),
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorText = await response.text()
      return createAnthropicErrorResponse(
        response.status,
        `OpenAI-compatible API error (${response.status}): ${errorText}`,
      )
    }

    const model =
      typeof anthropicBody.model === 'string' ? anthropicBody.model : 'unknown'

    if (stream) {
      return translateOpenAIStreamToAnthropic(response, model)
    }

    const data =
      (await response.json()) as OpenAIChatCompletionResponse
    return translateOpenAIResponseToAnthropicResponse(data)
  }
}
