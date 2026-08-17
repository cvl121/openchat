// LLM provider integrations. All requests run in the main process (no CORS
// constraints) and stream chunks back to the renderer via callbacks.
//
// Providers: OpenRouter (primary), NanoGPT, OpenAI, Anthropic Claude, and
// Google Gemini. All but Claude/Gemini share the OpenAI-compatible
// chat/completions wire format.

import { PROVIDERS } from '../shared/providers.js';
import { t } from '../shared/i18n.js';

export { PROVIDERS };

// Reference list prices in USD per million tokens {inPerM, outPerM}, used for
// providers whose model-list API doesn't report pricing (only OpenRouter does).
// Matched by exact model id first, then longest key prefix — so dated ids like
// "claude-sonnet-4-6-20251114" or preview suffixes still resolve. Approximate
// list prices as of early 2026; cost estimates are heuristics, not billing.
export const STATIC_MODEL_PRICING = {
  claude: {
    'claude-fable-5': { inPerM: 10, outPerM: 50 },
    'claude-mythos-5': { inPerM: 10, outPerM: 50 },
    'claude-opus-5': { inPerM: 5, outPerM: 25 },
    'claude-opus-4-8': { inPerM: 5, outPerM: 25 },
    'claude-opus-4-7': { inPerM: 5, outPerM: 25 },
    'claude-opus-4-6': { inPerM: 5, outPerM: 25 },
    'claude-opus-4-5': { inPerM: 5, outPerM: 25 },
    'claude-opus-4-1': { inPerM: 15, outPerM: 75 },
    'claude-opus-4-2025': { inPerM: 15, outPerM: 75 },
    'claude-sonnet-5': { inPerM: 3, outPerM: 15 },
    'claude-sonnet-4': { inPerM: 3, outPerM: 15 },
    'claude-haiku-4-5': { inPerM: 1, outPerM: 5 },
    'claude-3-5-haiku': { inPerM: 0.8, outPerM: 4 },
    'claude-3-haiku': { inPerM: 0.25, outPerM: 1.25 },
  },
  openai: {
    'gpt-5.1': { inPerM: 1.25, outPerM: 10 },
    'gpt-5-mini': { inPerM: 0.25, outPerM: 2 },
    'gpt-5-nano': { inPerM: 0.05, outPerM: 0.4 },
    'gpt-5': { inPerM: 1.25, outPerM: 10 },
    'gpt-4o-mini': { inPerM: 0.15, outPerM: 0.6 },
    'gpt-4o': { inPerM: 2.5, outPerM: 10 },
    'chatgpt-4o-latest': { inPerM: 5, outPerM: 15 },
    'gpt-4.1-mini': { inPerM: 0.4, outPerM: 1.6 },
    'gpt-4.1-nano': { inPerM: 0.1, outPerM: 0.4 },
    'gpt-4.1': { inPerM: 2, outPerM: 8 },
    'gpt-4-turbo': { inPerM: 10, outPerM: 30 },
    'o3-mini': { inPerM: 1.1, outPerM: 4.4 },
    o3: { inPerM: 2, outPerM: 8 },
    'o4-mini': { inPerM: 1.1, outPerM: 4.4 },
  },
  gemini: {
    'gemini-3.1-pro': { inPerM: 2, outPerM: 12 },
    'gemini-3-pro': { inPerM: 2, outPerM: 12 },
    'gemini-2.5-pro': { inPerM: 1.25, outPerM: 10 },
    'gemini-2.5-flash-lite': { inPerM: 0.1, outPerM: 0.4 },
    'gemini-2.5-flash': { inPerM: 0.3, outPerM: 2.5 },
    'gemini-2.0-flash': { inPerM: 0.1, outPerM: 0.4 },
  },
};

// --- Live reference pricing from the public OpenRouter catalog --------------
// OpenRouter's /models endpoint is public (no key) and lists most major
// models with pass-through prices that track the providers' own list prices.
// Its "vendor/slug" ids are mapped onto the native providers so direct API
// users get current prices; the static table above is the offline fallback.
// Refreshed lazily when a model list is fetched — never on a timer.

const OPENROUTER_VENDOR_TO_PROVIDER = {
  openai: 'openai',
  anthropic: 'claude',
  google: 'gemini',
};

/** "claude-opus-4.8", "claude-opus-4-8", and dated snapshots share one key. */
function normalizeModelId(id) {
  return id.toLowerCase().replace(/\./g, '-').replace(/-\d{8}$/, '');
}

/** Build a {"provider|normalizedId" -> pricing} index from an OpenRouter model list. */
export function buildLivePricingIndex(orModels) {
  const index = new Map();
  for (const m of orModels ?? []) {
    if (!m.pricing) continue;
    const [vendor, ...rest] = (m.id ?? '').split('/');
    const provider = OPENROUTER_VENDOR_TO_PROVIDER[vendor];
    const slug = rest.join('/');
    if (!provider || !slug) continue;
    // Variants (":free", ":extended") only fill gaps; the base listing wins
    const isVariant = slug.includes(':');
    const key = `${provider}|${normalizeModelId(slug.split(':')[0])}`;
    const existing = index.get(key);
    if (!existing || (existing.variant && !isVariant)) {
      index.set(key, { inPerM: m.pricing.inPerM, outPerM: m.pricing.outPerM, variant: isVariant });
    }
  }
  return index;
}

/** Pricing for a native provider/model from a live index, or null. */
export function lookupLivePricing(index, provider, modelId) {
  if (!index || !modelId) return null;
  const hit = index.get(`${provider}|${normalizeModelId(modelId)}`);
  return hit ? { inPerM: hit.inPerM, outPerM: hit.outPerM } : null;
}

let livePricingIndex = null;
let livePricingFetchedAt = 0;
const LIVE_PRICING_TTL_MS = 6 * 60 * 60 * 1000;
const LIVE_PRICING_RETRY_MS = 10 * 60 * 1000;

async function ensureLivePricing() {
  const age = Date.now() - livePricingFetchedAt;
  if (livePricingIndex ? age < LIVE_PRICING_TTL_MS : age < LIVE_PRICING_RETRY_MS) return;
  livePricingFetchedAt = Date.now();
  try {
    const models = await listModels({ provider: 'openrouter', apiKey: '', baseURL: '' });
    const index = buildLivePricingIndex(models);
    if (index.size) livePricingIndex = index;
  } catch {} // offline — static table covers it; retry after the backoff
}

function referencePricing(provider, modelId) {
  return lookupLivePricing(livePricingIndex, provider, modelId) ?? lookupModelPricing(provider, modelId);
}

/** Reference pricing for a model, or null when unknown. Exact id, then longest prefix. */
export function lookupModelPricing(provider, modelId) {
  const table = STATIC_MODEL_PRICING[provider];
  if (!table || !modelId) return null;
  if (table[modelId]) return table[modelId];
  let best = null;
  for (const key of Object.keys(table)) {
    if (modelId.startsWith(key) && (best === null || key.length > best.length)) best = key;
  }
  return best !== null ? table[best] : null;
}

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
  nanogpt: [
    'google/gemini-3.1-pro-preview', 'anthropic/claude-sonnet-5', 'anthropic/claude-sonnet-latest',
    'openai/gpt-5.6-sol', 'openai/gpt-5.6-luna', 'x-ai/grok-4.6',
    'deepseek/deepseek-v3.2', 'meta-llama/llama-4-maverick', 'meta-llama/llama-3.3-70b-instruct',
  ],
};

export class LLMError extends Error {
  constructor(message, { status = 0, body = '', retryAfterMs = null } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
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
  // OpenAI reasoning models (o-series, gpt-5) take max_completion_tokens and
  // reject non-default sampling parameters. Aggregators (OpenRouter, NanoGPT)
  // translate the standard body themselves, so this only applies to the
  // direct OpenAI API.
  const reasoning = /^(o\d|gpt-5)/.test(config.model) && config.provider === 'openai';
  const body = {
    model: config.model,
    messages: messages.map((m) => ({ role: m.role, content: openAIContent(m) })),
    ...(reasoning
      ? { max_completion_tokens: p.max_tokens }
      : {
          max_tokens: p.max_tokens,
          temperature: p.temperature,
          top_p: p.top_p,
          frequency_penalty: p.frequency_penalty,
          presence_penalty: p.presence_penalty,
        }),
    stream,
  };
  // The aggregators pass provider-specific sampler params straight through
  if (config.provider === 'openrouter' || config.provider === 'nanogpt') {
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
    case 'nanogpt':
      return {
        url: `${base}/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
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
      throw new LLMError(t('errors.unknownProvider', { provider: config.provider }));
  }
}

// ---------------------------------------------------------------------------
// Streaming chunk extractors (per wire format)

function extractChunk(provider, json) {
  switch (provider) {
    case 'claude':
      return json.type === 'content_block_delta' ? (json.delta?.text ?? null) : null;
    case 'gemini':
      // Multi-part chunks happen in image-output mode (text after an image part)
      return json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') || null;
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

const MAX_SEND_RETRIES = 2;
const STREAM_IDLE_TIMEOUT_MS = 120_000;

/** Transient failures worth retrying: rate limits, server errors, network drops. */
function isRetryable(err) {
  if (err?.name === 'AbortError') return false;
  if (err instanceof LLMError) return err.status === 429 || err.status >= 500;
  return true; // fetch-level network failure
}

function retryDelayMs(err, attempt) {
  if (err?.retryAfterMs != null) return Math.min(err.retryAfterMs, 30_000);
  return 1000 * 2 ** attempt; // 1s, 2s
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

/**
 * Stream a chat completion. Calls onChunk(text) as tokens arrive,
 * onImage(dataURL) for image outputs (image-capable models), and
 * onFinishReason(reason) with the provider's stop reason (e.g. 'length'
 * when the response was truncated by the max-tokens limit).
 * Returns the full response text. Abortable via opts.signal.
 *
 * Transient failures (429/5xx/network) are retried with backoff — but never
 * once any content has reached the callbacks, and never on abort.
 */
export async function sendMessage(messages, config, onChunk, { signal, onImage, onFinishReason } = {}) {
  const stream = config.params.stream_response !== false;
  const req = buildRequest(messages, config, stream);
  let delivered = false;
  const callbacks = {
    onChunk: (text) => {
      delivered = true;
      onChunk?.(text);
    },
    onImage: (url) => {
      delivered = true;
      onImage?.(url);
    },
    onFinishReason,
  };
  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptSend(req, config, stream, callbacks, signal);
    } catch (err) {
      if (delivered || attempt >= MAX_SEND_RETRIES || !isRetryable(err) || signal?.aborted) throw err;
      await abortableDelay(retryDelayMs(err, attempt), signal);
    }
  }
}

async function attemptSend(req, config, stream, { onChunk, onImage, onFinishReason }, signal) {
  // A stalled connection would otherwise hang until manual stop: abort if no
  // bytes arrive for STREAM_IDLE_TIMEOUT_MS.
  const idle = new AbortController();
  let idleTimer = null;
  let idledOut = false;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idledOut = true;
      idle.abort();
    }, STREAM_IDLE_TIMEOUT_MS);
  };
  resetIdle();
  try {
    const response = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: signal ? AbortSignal.any([signal, idle.signal]) : idle.signal,
    });
    if (!response.ok) {
      const body = await readErrorBody(response);
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new LLMError(
        t('errors.providerError', { label: PROVIDERS[config.provider]?.label ?? config.provider, status: response.status, body }),
        {
          status: response.status,
          body,
          retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : null,
        }
      );
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
      resetIdle();
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) {
        const message = json.error.message ?? (typeof json.error === 'string' ? json.error : 'Stream error');
        throw new LLMError(message, { body: data });
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
  } catch (err) {
    if (idledOut) {
      throw new LLMError(t('errors.connectionStalled'), { status: 0 });
    }
    throw err;
  } finally {
    clearTimeout(idleTimer);
  }
}

/**
 * Fetch the live model list for a provider, authenticated with the user's
 * API key where the provider requires it. Network failures fall back to a
 * static list; auth failures (401/403) throw so the UI can flag a bad key
 * at the model picker instead of at first send.
 * Each model: { id, name, context, imageOutput }.
 */
const LIVE_PRICED_PROVIDERS = new Set(Object.values(OPENROUTER_VENDOR_TO_PROVIDER));

export async function listModels(config) {
  try {
    // Refresh live catalog prices for direct-API providers (lazy, TTL'd;
    // the openrouter case below is already live by itself)
    if (LIVE_PRICED_PROVIDERS.has(config.provider)) await ensureLivePricing();
    switch (config.provider) {
      case 'openrouter': {
        const res = await fetch(`${effectiveBaseURL(config)}/models`, {
          headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
        });
        if (!res.ok) throw new LLMError(`HTTP ${res.status}`, { status: res.status });
        const json = await res.json();
        return (json.data ?? [])
          .map((m) => ({
            id: m.id,
            name: m.name ?? m.id,
            context: m.context_length ?? null,
            imageOutput: (m.architecture?.output_modalities ?? []).includes('image'),
            // OpenRouter reports USD per single token; normalize to per-million
            pricing: m.pricing
              ? {
                  inPerM: (parseFloat(m.pricing.prompt) || 0) * 1e6,
                  outPerM: (parseFloat(m.pricing.completion) || 0) * 1e6,
                }
              : null,
          }))
          .sort((a, b) => a.id.localeCompare(b.id));
      }
      case 'openai': {
        const res = await fetch(`${effectiveBaseURL(config)}/models`, {
          headers: { Authorization: `Bearer ${config.apiKey}` },
        });
        if (!res.ok) throw new LLMError(`HTTP ${res.status}`, { status: res.status });
        const json = await res.json();
        return (json.data ?? [])
          .map((m) => ({ id: m.id, name: m.id, context: null, imageOutput: false, pricing: referencePricing('openai', m.id) }))
          .filter((m) => /gpt|^o\d/.test(m.id))
          .sort((a, b) => a.id.localeCompare(b.id));
      }
      case 'nanogpt': {
        // detailed=true adds name, context_length, per-million pricing, and
        // output modalities to the otherwise-bare OpenAI-style list
        const res = await fetch(`${effectiveBaseURL(config)}/models?detailed=true`, {
          headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
        });
        if (!res.ok) throw new LLMError(`HTTP ${res.status}`, { status: res.status });
        const json = await res.json();
        return (json.data ?? [])
          .map((m) => ({
            id: m.id,
            name: m.name ?? m.id,
            context: m.context_length ?? null,
            imageOutput: (m.architecture?.output_modalities ?? []).includes('image'),
            pricing: m.pricing
              ? {
                  inPerM: parseFloat(m.pricing.prompt) || 0,
                  outPerM: parseFloat(m.pricing.completion) || 0,
                }
              : null,
          }))
          .sort((a, b) => a.id.localeCompare(b.id));
      }
      case 'claude': {
        const res = await fetch(`${effectiveBaseURL(config)}/models?limit=100`, {
          headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
        });
        if (!res.ok) throw new LLMError(`HTTP ${res.status}`, { status: res.status });
        const json = await res.json();
        return (json.data ?? [])
          .map((m) => ({ id: m.id, name: m.display_name ?? m.id, context: null, imageOutput: false, pricing: referencePricing('claude', m.id) }))
          .sort((a, b) => a.id.localeCompare(b.id));
      }
      case 'gemini': {
        const res = await fetch(`${effectiveBaseURL(config)}/models?pageSize=200`, {
          headers: { 'x-goog-api-key': config.apiKey },
        });
        if (!res.ok) throw new LLMError(`HTTP ${res.status}`, { status: res.status });
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
      default:
        return FALLBACK_MODELS[config.provider].map((id) => ({ id, name: id, context: null, imageOutput: false, pricing: referencePricing(config.provider, id) }));
    }
  } catch (err) {
    if (err instanceof LLMError && (err.status === 401 || err.status === 403)) {
      const label = PROVIDERS[config.provider]?.label ?? config.provider;
      throw new LLMError(t('errors.keyRejected', { label, status: err.status }), {
        status: err.status,
      });
    }
    return (FALLBACK_MODELS[config.provider] ?? []).map((id) => ({ id, name: id, context: null, imageOutput: false, pricing: referencePricing(config.provider, id) }));
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
  if (!res.ok) throw new LLMError(t('errors.creditsFailed', { status: res.status }), { status: res.status });
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
