function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function generateToolCallId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  return `toolcall_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function parseToolArguments(value) {
  if (isObject(value)) return value
  if (typeof value !== 'string') return {}

  try {
    const parsed = JSON.parse(value)
    return isObject(parsed) ? parsed : {}
  } catch (_error) {
    return {}
  }
}

function normalizeToolDefinitions(tools) {
  if (!Array.isArray(tools)) return []

  return tools
    .filter((tool) => isObject(tool) && typeof tool.name === 'string' && tool.name)
    .map((tool) => ({
      name: tool.name,
      ...(typeof tool.description === 'string' && tool.description
        ? { description: tool.description }
        : {}),
      parameters: isObject(tool.parameters) ? tool.parameters : { type: 'object', properties: {} },
    }))
}

export function toOpenAiTools(tools) {
  return normalizeToolDefinitions(tools).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters,
    },
  }))
}

export function toAnthropicTools(tools) {
  return normalizeToolDefinitions(tools).map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.parameters,
  }))
}

export function toGoogleTools(tools) {
  const functionDeclarations = normalizeToolDefinitions(tools).map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters,
  }))

  if (!functionDeclarations.length) return []
  return [{ functionDeclarations }]
}

export function parseOpenAiToolCalls(response) {
  const toolCalls = response?.choices?.[0]?.message?.tool_calls
  if (!Array.isArray(toolCalls)) return []

  return toolCalls
    .map((call) => {
      const name = call?.function?.name
      if (typeof name !== 'string' || !name) return null

      return {
        id: typeof call.id === 'string' && call.id ? call.id : generateToolCallId(),
        name,
        arguments: parseToolArguments(call?.function?.arguments),
      }
    })
    .filter(Boolean)
}

export function parseAnthropicToolCalls(response) {
  const content = response?.content
  if (!Array.isArray(content)) return []

  return content
    .filter((block) => block?.type === 'tool_use')
    .map((block) => {
      if (typeof block?.name !== 'string' || !block.name) return null
      return {
        id: typeof block.id === 'string' && block.id ? block.id : generateToolCallId(),
        name: block.name,
        arguments: parseToolArguments(block.input),
      }
    })
    .filter(Boolean)
}

export function parseGoogleToolCalls(response) {
  const parts = response?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return []

  return parts
    .map((part) => {
      const functionCall = part?.functionCall
      if (!isObject(functionCall) || typeof functionCall.name !== 'string' || !functionCall.name) {
        return null
      }

      return {
        id: generateToolCallId(),
        name: functionCall.name,
        arguments: parseToolArguments(functionCall.args || functionCall.arguments),
      }
    })
    .filter(Boolean)
}

export function buildOpenAiToolResult(toolCallId, result) {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content: JSON.stringify(result),
  }
}

export function buildOpenAiToolResultWithImage(toolCallId, result, imageDataUrl) {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content: [
      { type: 'text', text: JSON.stringify(result) },
      { type: 'image_url', image_url: { url: imageDataUrl } },
    ],
  }
}

export function buildAnthropicToolResult(toolCallId, result) {
  return {
    type: 'tool_result',
    tool_use_id: toolCallId,
    content: JSON.stringify(result),
  }
}

export function buildAnthropicToolResultWithImage(toolCallId, result, imageDataUrl) {
  const match = typeof imageDataUrl === 'string'
    ? imageDataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/)
    : null

  if (!match) {
    return buildAnthropicToolResult(toolCallId, result)
  }

  return {
    type: 'tool_result',
    tool_use_id: toolCallId,
    content: [
      { type: 'text', text: JSON.stringify(result) },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: match[1],
          data: match[2],
        },
      },
    ],
  }
}

export function buildGoogleToolResult(name, result) {
  return {
    functionResponse: {
      name,
      response: result,
    },
  }
}

export function buildToolResultMessage(provider, toolCallId, toolName, result, imageDataUrl = null) {
  if (provider === 'anthropic') {
    const toolResultPart = imageDataUrl
      ? buildAnthropicToolResultWithImage(toolCallId, result, imageDataUrl)
      : buildAnthropicToolResult(toolCallId, result)

    return {
      role: 'user',
      content: [toolResultPart],
    }
  }

  if (provider === 'google') {
    const content = [buildGoogleToolResult(toolName, result)]
    if (imageDataUrl) {
      content.push(
        { type: 'text', text: JSON.stringify(result) },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      )
    }

    return {
      role: 'user',
      content,
    }
  }

  if (provider === 'openai' || provider === 'xai' || provider === 'custom') {
    if (imageDataUrl) {
      return buildOpenAiToolResultWithImage(toolCallId, result, imageDataUrl)
    }
    return buildOpenAiToolResult(toolCallId, result)
  }

  throw new Error(`Unsupported LLM provider for tool result message: ${provider}`)
}
