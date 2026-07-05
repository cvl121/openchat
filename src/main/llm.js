// LLM provider integrations. All requests run in the main process (no CORS
// constraints) and stream chunks back to the renderer via callbacks.
//
// Providers: OpenRouter (primary), OpenAI, Anthropic Claude, Google Gemini,
// Ollama (local). OpenRouter/OpenAI/Ollama share the OpenAI-compatible
// chat/completions wire format.

export const PROVIDERS = {
  openrouter: {
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    defaultModel: 'google/gemini-3.1-pro-preview',
  },
  openai: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    requiresKey: true,
    defaultModel: 'gpt-4o-mini',
  },
  claude: {
    label: 'Anthropic Claude',
    baseURL: 'https://api.anthropic.com/v1',
    requiresKey: true,
    defaultModel: 'claude-sonnet-4-6',
  },
  gemini: {
    label: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    requiresKey: true,
    defaultModel: 'gemini-3.1-pro-preview',
  },
  ollama: {
    label: 'Ollama (local)',
    baseURL: 'http://localhost:11434/v1',
    requiresKey: false,
    defaultModel: 'llama3.1',
  },
};

export const FALLBACK_MODELS = {
  openrouter: [
    'google/gemini-3.1-pro-preview', 'google/gemini-3.5-flash', 'google/gemini-3.1-flash-image',
    'anthropic/claude-opus-4.8', 'anthropic/claude-sonnet-4-6', 'anthropic/claude-haiku-4-5',
    'openai/gpt-4o', 'openai/gpt-4o-mini', 'openai/o4-mini',
    'meta-llama/llama-3.3-70b-instruct', 'meta-llama/llama-3.1-405b-instruct',
    'mistralai/mistral-large', 'deepseek/deepseek-r1', 'qwen/qwen-2.5-72b-instruct',
    'cohere/command-r-plus', 'nousresearch/hermes-3-llama-3.1-405b',
  ],
  openai: [
    'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3', 'o3-mini', 'o4-mini',
    'gpt-4-turbo', 'chatgpt-4o-latest',
  ],
  claude: [
    'claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
    'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022',
  ],
  gemini: [
    'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash',
    'gemini-2.0-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash',
  ],
  ollama: ['llama3.3', 'llama3.1', 'mistral', 'qwen2.5', 'gemma3', 'deepseek-r1'],
};

export class LLMError extends Error {
  constructor(message, { status = 0, body = '' } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function effectiveBaseURL(config) {
  return (config.baseURL || PROVIDERS[config.provider]?.baseURL || '').replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Request body builders
//
// Messages may carry attached images as `images: [dataURL, ...]` alongside
// the plain-text `content`; each builder maps them to its provider's
// multimodal content-part format.

function parseDataURL(dataURL) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataURL ?? '');
  return match ? { mime: match[1], data: match[2] } : null;
}

function openAIContent(m) {
  if (!m.images?.length) return m.content;
  return [
    ...(m.content ? [{ type: 'text', text: m.content }] : []),
    ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
}

function openAICompatibleBody(messages, config, stream) {
  const p = config.params;
  const body = {
    model: config.model,
    messages: messages.map((m) => ({ role: m.role, content: openAIContent(m) })),
    max_tokens: p.max_tokens,
    temperature: p.temperature,
    top_p: p.top_p,
    frequency_penalty: p.frequency_penalty,
    presence_penalty: p.presence_penalty,
    stream,
  };
  // OpenRouter passes provider-specific sampler params straight through
  if (config.provider === 'openrouter' || config.provider === 'ollama') {
    if (p.min_p > 0) body.min_p = p.min_p;
    if (p.top_k > 0) body.top_k = p.top_k;
    if (p.top_a > 0) body.top_a = p.top_a;
    if (p.repetition_penalty !== 1.0) body.repetition_penalty = p.repetition_penalty;
  }
  if (p.stop_sequences?.length) body.stop = p.stop_sequences;
  if (p.seed >= 0) body.seed = p.seed;
  // Ask image-capable models for image output (OpenRouter modalities passthrough)
  if (config.requestImages && config.provider === 'openrouter') {
    body.modalities = ['image', 'text'];
  }
  return body;
}

function buildRequest(messages, config, stream) {
  const base = effectiveBaseURL(config);
  const p = config.params;

  switch (config.provider) {
    case 'openrouter':
      return {
        url: `${base}/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
          'X-Title': 'OpenChat',
        },
        body: openAICompatibleBody(messages, config, stream),
      };

    case 'openai':
    case 'ollama':
      return {
        url: `${base}/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: openAICompatibleBody(messages, config, stream),
      };

    case 'claude': {
      // Anthropic: system messages go in a top-level field; turns must alternate
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const blocksOf = (m) => [
        ...(m.images ?? [])
          .map(parseDataURL)
          .filter(Boolean)
          .map(({ mime, data }) => ({ type: 'image', source: { type: 'base64', media_type: mime, data } })),
        ...(m.content ? [{ type: 'text', text: m.content }] : []),
      ];
      const turns = [];
      for (const m of messages) {
        if (m.role === 'system') continue;
        const blocks = blocksOf(m);
        if (!blocks.length) continue;
        const last = turns[turns.length - 1];
        if (last && last.role === m.role) {
          // Merge same-role turns; adjacent text blocks collapse into one
          const lastBlock = last.content[last.content.length - 1];
          if (lastBlock?.type === 'text' && blocks[0].type === 'text') {
            lastBlock.text += '\n\n' + blocks.shift().text;
          }
          last.content.push(...blocks);
        } else {
          turns.push({ role: m.role, content: blocks });
        }
      }
      if (!turns.length || turns[0].role !== 'user') {
        turns.unshift({ role: 'user', content: [{ type: 'text', text: '[Begin the conversation]' }] });
      }
      const body = {
        model: config.model,
        max_tokens: p.max_tokens,
        temperature: Math.min(p.temperature, 1.0),
        messages: turns,
        stream,
      };
      if (system) body.system = system;
      if (p.top_p < 1.0) body.top_p = p.top_p;
      if (p.top_k > 0) body.top_k = p.top_k;
      if (p.stop_sequences?.length) body.stop_sequences = p.stop_sequences;
      return {
        url: `${base}/messages`,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body,
      };
    }

    case 'gemini': {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const contents = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [
            ...(m.content ? [{ text: m.content }] : []),
            ...(m.images ?? [])
              .map(parseDataURL)
              .filter(Boolean)
              .map(({ mime, data }) => ({ inline_data: { mime_type: mime, data } })),
          ],
        }))
        .filter((c) => c.parts.length);
      if (!contents.length) contents.push({ role: 'user', parts: [{ text: '[Begin]' }] });
      const body = {
        contents,
        generationConfig: {
          maxOutputTokens: p.max_tokens,
          temperature: p.temperature,
          topP: p.top_p,
          ...(p.top_k > 0 ? { topK: p.top_k } : {}),
          ...(p.stop_sequences?.length ? { stopSequences: p.stop_sequences.slice(0, 5) } : {}),
          ...(config.requestImages ? { responseModalities: ['TEXT', 'IMAGE'] } : {}),
        },
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      };
      const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
      return {
        url: `${base}/models/${config.model}:${method}`,
        // Key goes in a header, not the query string — URLs leak into logs
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
        body,
      };
    }

    default:
      throw new LLMError(`Unknown provider: ${config.provider}`);
  }
}

// ---------------------------------------------------------------------------
// Streaming chunk extractors (per wire format)

function extractChunk(provider, json) {
  switch (provider) {
    case 'claude':
      return json.type === 'content_block_delta' ? (json.delta?.text ?? null) : null;
    case 'gemini':
      return json.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    default:
      return json.choices?.[0]?.delta?.content ?? null;
  }
}

function extractComplete(provider, json) {
  switch (provider) {
    case 'claude':
      return (json.content ?? []).map((b) => b.text ?? '').join('');
    case 'gemini':
      return json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    default:
      return json.choices?.[0]?.message?.content ?? '';
  }
}

/**
 * Why the model stopped, from a streamed or complete payload.
 * 'length' / 'max_tokens' / 'MAX_TOKENS' mean the response was truncated by
 * the max-tokens limit — callers surface that to the user.
 */
function extractFinishReason(provider, json) {
  switch (provider) {
    case 'claude':
      return json.delta?.stop_reason ?? json.stop_reason ?? null;
    case 'gemini':
      return json.candidates?.[0]?.finishReason ?? null;
    default:
      return json.choices?.[0]?.finish_reason ?? null;
  }
}

/** Image outputs (data URLs) in a streamed or complete response payload. */
function extractImages(provider, json) {
  switch (provider) {
    case 'gemini': {
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      return parts
        .map((p) => p.inlineData ?? p.inline_data)
        .filter((d) => d?.data)
        .map((d) => `data:${d.mimeType ?? d.mime_type ?? 'image/png'};base64,${d.data}`);
    }
    case 'claude':
      return [];
    default: {
      // OpenRouter image-capable models attach images to the delta/message
      const choice = json.choices?.[0] ?? {};
      const images = choice.delta?.images ?? choice.message?.images ?? [];
      return images.map((img) => img.image_url?.url ?? img.url).filter(Boolean);
    }
  }
}

// ---------------------------------------------------------------------------
// SSE parsing

/** Async-iterate "data: ..." payloads from a fetch response body. */
async function* sseEvents(response) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        if (data) yield data;
      }
    }
  }
  // A final event without a trailing newline would otherwise be dropped,
  // silently truncating the response by one chunk.
  buffer += decoder.decode();
  for (const raw of buffer.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('data:')) {
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      if (data) yield data;
    }
  }
}

async function readErrorBody(response) {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      return json.error?.message ?? json.message ?? text;
    } catch {
      return text.slice(0, 500);
    }
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Stream a chat completion. Calls onChunk(text) as tokens arrive,
 * onImage(dataURL) for image outputs (image-capable models), and
 * onFinishReason(reason) with the provider's stop reason (e.g. 'length'
 * when the response was truncated by the max-tokens limit).
 * Returns the full response text. Abortable via opts.signal.
 */
export async function sendMessage(messages, config, onChunk, { signal, onImage, onFinishReason } = {}) {
  const stream = config.params.stream_response !== false;
  const req = buildRequest(messages, config, stream);
  const response = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal,
  });
  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new LLMError(`${PROVIDERS[config.provider]?.label ?? config.provider} error (${response.status}): ${body}`, {
      status: response.status,
      body,
    });
  }

  if (!stream) {
    const json = await response.json();
    const text = extractComplete(config.provider, json);
    if (text) onChunk?.(text);
    for (const image of extractImages(config.provider, json)) onImage?.(image);
    const reason = extractFinishReason(config.provider, json);
    if (reason) onFinishReason?.(reason);
    return text;
  }

  let full = '';
  let finishReason = null;
  for await (const data of sseEvents(response)) {
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json.error) {
      throw new LLMError(json.error.message ?? 'Stream error', { body: data });
    }
    const text = extractChunk(config.provider, json);
    if (text) {
      full += text;
      onChunk?.(text);
    }
    for (const image of extractImages(config.provider, json)) onImage?.(image);
    finishReason = extractFinishReason(config.provider, json) ?? finishReason;
  }
  if (finishReason) onFinishReason?.(finishReason);
  return full;
}

/**
 * Fetch the live model list for a provider, authenticated with the user's
 * API key where the provider requires it. Falls back to a static list.
 * Each model: { id, name, context, imageOutput }.
 */
export async function listModels(config) {
  try {
    switch (config.provider) {
      case 'openrouter': {
        const res = await fetch(`${effectiveBaseURL(config)}/models`, {
          headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
        });
        if (!res.ok) throw new LLMError(`HTTP ${res.status}`);
        const json = await res.json();
        return (json.data ?? [])
          .map((m) => ({
            id: m.id,
            name: m.name ?? m.id,
            context: m.context_length ?? null,
            imageOutput: (m.architecture?.output_modalities ?? []).includes('image'),
          }))
          .sort((a, b) => a.id.localeCompare(b.id));
      }
      case 'openai': {
        const res = await fetch(`${effectiveBaseURL(config)}/models`, {
          headers: { Authorization: `Bearer ${config.apiKey}` },
        });
        if (!res.ok) throw new LLMError(`HTTP ${res.status}`);
        const json = await res.json();
        return (json.data ?? [])
          .map((m) => ({ id: m.id, name: m.id, context: null, imageOutput: false }))
          .filter((m) => /gpt|^o\d/.test(m.id))
          .sort((a, b) => a.id.localeCompare(b.id));
      }
      case 'claude': {
        const res = await fetch(`${effectiveBaseURL(config)}/models?limit=100`, {
          headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
        });
        if (!res.ok) throw new LLMError(`HTTP ${res.status}`);
        const json = await res.json();
        return (json.data ?? [])
          .map((m) => ({ id: m.id, name: m.display_name ?? m.id, context: null, imageOutput: false }))
          .sort((a, b) => a.id.localeCompare(b.id));
      }
      case 'gemini': {
        const res = await fetch(`${effectiveBaseURL(config)}/models?pageSize=200`, {
          headers: { 'x-goog-api-key': config.apiKey },
        });
        if (!res.ok) throw new LLMError(`HTTP ${res.status}`);
        const json = await res.json();
        return (json.models ?? [])
          .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
          .map((m) => ({
            id: m.name.replace(/^models\//, ''),
            name: m.displayName ?? m.name,
            context: m.inputTokenLimit ?? null,
            imageOutput: /image/i.test(m.name),
          }))
          .sort((a, b) => a.id.localeCompare(b.id));
      }
      case 'ollama': {
        const base = effectiveBaseURL(config).replace(/\/v1$/, '');
        const res = await fetch(`${base}/api/tags`);
        if (!res.ok) throw new LLMError(`HTTP ${res.status}`);
        const json = await res.json();
        return (json.models ?? []).map((m) => ({ id: m.name, name: m.name, context: null, imageOutput: false }));
      }
      default:
        return FALLBACK_MODELS[config.provider].map((id) => ({ id, name: id, context: null, imageOutput: false }));
    }
  } catch {
    return (FALLBACK_MODELS[config.provider] ?? []).map((id) => ({ id, name: id, context: null, imageOutput: false }));
  }
}

/**
 * Remaining prepaid balance for providers that expose one (OpenRouter).
 * Returns { total, used, remaining } in USD, or null if unsupported.
 */
export async function getCredits(config) {
  if (config.provider !== 'openrouter' || !config.apiKey) return null;
  const res = await fetch(`${effectiveBaseURL(config)}/credits`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!res.ok) throw new LLMError(`Could not fetch credits (HTTP ${res.status})`, { status: res.status });
  const { data } = await res.json();
  const total = data?.total_credits ?? 0;
  const used = data?.total_usage ?? 0;
  return { total, used, remaining: total - used };
}

/** Send a tiny request to verify the API key / connection. */
export async function testConnection(config) {
  const messages = [{ role: 'user', content: 'Say "ok" and nothing else.' }];
  const testConfig = {
    ...config,
    params: { ...config.params, max_tokens: 16, stream_response: false, stop_sequences: [], seed: -1 },
  };
  const started = Date.now();
  const text = await sendMessage(messages, testConfig, null, {
    signal: AbortSignal.timeout(30000),
  });
  return { ok: true, latencyMs: Date.now() - started, sample: text.slice(0, 80) };
}
