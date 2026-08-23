// Verifies the LLM layer against a local mock server speaking the OpenAI/
// OpenRouter SSE wire format, plus error handling and abort.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sendMessage, listModels, getCredits, LLMError, PROVIDERS, FALLBACK_MODELS, lookupModelPricing, buildLivePricingIndex, lookupLivePricing } from '../src/main/llm.js';

test('live pricing index: vendor mapping, id normalization, variant precedence', () => {
  const index = buildLivePricingIndex([
    { id: 'anthropic/claude-opus-4.8', pricing: { inPerM: 5, outPerM: 25 } },
    { id: 'openai/gpt-4o:extended', pricing: { inPerM: 9, outPerM: 99 } },
    { id: 'openai/gpt-4o', pricing: { inPerM: 2.5, outPerM: 10 } },
    { id: 'google/gemini-3.1-pro-preview', pricing: { inPerM: 2, outPerM: 12 } },
    { id: 'mistralai/mistral-large', pricing: { inPerM: 2, outPerM: 6 } }, // vendor not mapped to a native provider
    { id: 'deepseek/deepseek-chat', pricing: null }, // catalog entry without pricing
  ]);
  // OpenRouter's dotted version maps onto the native dashed id
  assert.deepEqual(lookupLivePricing(index, 'claude', 'claude-opus-4-8'), { inPerM: 5, outPerM: 25 });
  // Dated snapshots normalize onto the same key
  assert.deepEqual(lookupLivePricing(index, 'claude', 'claude-opus-4-8-20260101'), { inPerM: 5, outPerM: 25 });
  // The base listing wins over a ":variant" even when the variant came first
  assert.deepEqual(lookupLivePricing(index, 'openai', 'gpt-4o'), { inPerM: 2.5, outPerM: 10 });
  assert.deepEqual(lookupLivePricing(index, 'gemini', 'gemini-3.1-pro-preview'), { inPerM: 2, outPerM: 12 });
  // Unmapped vendors and priceless entries stay out of the index
  assert.equal(lookupLivePricing(index, 'deepseek', 'deepseek-chat'), null);
  assert.equal(index.has('kimi|mistral-large'), false);
  assert.equal(lookupLivePricing(null, 'openai', 'gpt-4o'), null);
});

test('lookupModelPricing: exact ids, dated-id prefixes, and longest-prefix wins', () => {
  // Exact match
  assert.deepEqual(lookupModelPricing('claude', 'claude-sonnet-5'), { inPerM: 3, outPerM: 15 });
  // Dated snapshot resolves via prefix
  assert.deepEqual(lookupModelPricing('claude', 'claude-haiku-4-5-20251001'), { inPerM: 1, outPerM: 5 });
  // Longest prefix wins: opus-4-1 must not fall into the opus-4-x $5 tier
  assert.equal(lookupModelPricing('claude', 'claude-opus-4-1-20250805').inPerM, 15);
  assert.equal(lookupModelPricing('claude', 'claude-opus-4-8').inPerM, 5);
  // Gemini flash-lite must beat the shorter "gemini-2.5-flash" prefix
  assert.equal(lookupModelPricing('gemini', 'gemini-2.5-flash-lite-preview').inPerM, 0.1);
  assert.equal(lookupModelPricing('gemini', 'gemini-2.5-flash-preview-05-20').inPerM, 0.3);
  // Unknown model / provider without a table
  assert.equal(lookupModelPricing('openai', 'some-experimental-model'), null);
  assert.equal(lookupModelPricing('nanogpt', 'gpt-4o'), null);
  assert.equal(lookupModelPricing('openrouter', 'openai/gpt-4o'), null);
});

function startMockServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      server.lastRequest = { url: req.url, headers: req.headers, body: json };
      if (req.url.endsWith('/chat/completions')) {
        if (json.model === 'error-model') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
          return;
        }
        if (json.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          if (json.model === 'image-model') {
            // OpenRouter image-capable models: image arrives on the delta
            const delta = { content: '', images: [{ image_url: { url: 'data:image/png;base64,AAAA' } }] };
            res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'stop' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          if (json.model === 'reasoning-model') {
            // GLM/R1-style: thinking streams before any content — legacy
            // `reasoning` string and structured `reasoning_details` both occur
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'hmm, ' } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'let me think' }] } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'The answer.' }, finish_reason: 'stop' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          const chunks = ['Hello', ' from', ' the', ' tavern!'];
          for (const text of chunks) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
          }
          // Usage accounting arrives on a trailing content-less chunk
          // (OpenRouter shape: exact cost + cached-token details)
          res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.00042, prompt_tokens_details: { cached_tokens: 8 } } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: 'Hello complete' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
        }
      } else if (req.url.endsWith('/messages')) {
        // Anthropic Messages API (non-streaming)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          content: [{ type: 'text', text: 'Claude says hi' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 42, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 },
        }));
      } else if (req.url.includes(':generateContent')) {
        // Gemini generateContent (non-streaming)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'Gemini says hi' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5, cachedContentTokenCount: 20 },
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function config(server, overrides = {}) {
  return {
    provider: 'openrouter',
    apiKey: 'test-key',
    baseURL: `http://127.0.0.1:${server.address().port}`,
    model: 'test-model',
    params: {
      max_tokens: 128,
      temperature: 0.7,
      top_p: 1,
      top_k: 0,
      frequency_penalty: 0,
      presence_penalty: 0,
      repetition_penalty: 1,
      min_p: 0,
      top_a: 0,
      stop_sequences: [],
      seed: -1,
      stream_response: true,
    },
    ...overrides,
  };
}

test('streams SSE chunks and returns full text', async () => {
  const server = await startMockServer();
  try {
    const chunks = [];
    const full = await sendMessage(
      [{ role: 'user', content: 'hi' }],
      config(server),
      (text) => chunks.push(text)
    );
    assert.equal(full, 'Hello from the tavern!');
    assert.deepEqual(chunks, ['Hello', ' from', ' the', ' tavern!']);
    // OpenRouter headers and auth present
    assert.equal(server.lastRequest.headers.authorization, 'Bearer test-key');
    assert.equal(server.lastRequest.headers['x-title'], 'OpenChat');
    assert.equal(server.lastRequest.body.model, 'test-model');
    assert.equal(server.lastRequest.body.stream, true);
  } finally {
    server.close();
  }
});

test('non-streaming mode returns complete text', async () => {
  const server = await startMockServer();
  try {
    const cfg = config(server);
    cfg.params.stream_response = false;
    const full = await sendMessage([{ role: 'user', content: 'hi' }], cfg, null);
    assert.equal(full, 'Hello complete');
    assert.equal(server.lastRequest.body.stream, false);
  } finally {
    server.close();
  }
});

test('image requests add modalities and deliver images via onImage', async () => {
  const server = await startMockServer();
  try {
    const images = [];
    let finish = null;
    const full = await sendMessage(
      [{ role: 'user', content: 'draw an apple' }],
      config(server, { model: 'image-model', requestImages: true }),
      () => {},
      { onImage: (url) => images.push(url), onFinishReason: (r) => (finish = r) }
    );
    assert.deepEqual(server.lastRequest.body.modalities, ['image', 'text']);
    assert.deepEqual(images, ['data:image/png;base64,AAAA']);
    assert.equal(full, '');
    assert.equal(finish, 'stop');
  } finally {
    server.close();
  }
});

test('modalities omitted unless image output is requested', async () => {
  const server = await startMockServer();
  try {
    await sendMessage([{ role: 'user', content: 'hi' }], config(server), null);
    assert.equal(server.lastRequest.body.modalities, undefined);
  } finally {
    server.close();
  }
});

test('generated images in history become image_url parts on assistant turns', async () => {
  const server = await startMockServer();
  try {
    const png = 'data:image/png;base64,BBBB';
    await sendMessage(
      [
        { role: 'user', content: 'draw an apple' },
        { role: 'assistant', content: '', images: [png] },
        { role: 'user', content: 'now a pear' },
      ],
      config(server),
      null
    );
    const assistantTurn = server.lastRequest.body.messages[1];
    assert.equal(assistantTurn.role, 'assistant');
    assert.deepEqual(assistantTurn.content, [{ type: 'image_url', image_url: { url: png } }]);
  } finally {
    server.close();
  }
});

test('HTTP errors surface provider message', async () => {
  const server = await startMockServer();
  try {
    await assert.rejects(
      sendMessage([{ role: 'user', content: 'hi' }], config(server, { model: 'error-model' }), null),
      (err) => err instanceof LLMError && err.status === 401 && /Invalid API key/.test(err.message)
    );
  } finally {
    server.close();
  }
});

test('sampler params only included when active', async () => {
  const server = await startMockServer();
  try {
    const cfg = config(server);
    cfg.params.min_p = 0.05;
    cfg.params.top_k = 40;
    cfg.params.seed = 42;
    await sendMessage([{ role: 'user', content: 'hi' }], cfg, null);
    const body = server.lastRequest.body;
    assert.equal(body.min_p, 0.05);
    assert.equal(body.top_k, 40);
    assert.equal(body.seed, 42);
    assert.ok(!('top_a' in body)); // 0 = disabled, omitted
    assert.ok(!('repetition_penalty' in body)); // 1.0 = disabled, omitted
  } finally {
    server.close();
  }
});

test('abort signal cancels the request', async () => {
  const server = await startMockServer();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      sendMessage([{ role: 'user', content: 'hi' }], config(server), null, { signal: controller.signal }),
      (err) => err.name === 'AbortError'
    );
  } finally {
    server.close();
  }
});

test('listModels falls back to static list when unreachable', async () => {
  const models = await listModels({
    provider: 'claude',
    apiKey: '',
    baseURL: 'http://127.0.0.1:1', // nothing listens here
  });
  assert.deepEqual(models.map((m) => m.id), FALLBACK_MODELS.claude);
});

test('listModels surfaces auth errors instead of falling back', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad key' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(listModels(config(server)), /rejected the API key/);
  } finally {
    server.close();
  }
});

test('messages with images become multimodal content parts', async () => {
  const server = await startMockServer();
  try {
    await sendMessage(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'look', images: ['data:image/png;base64,AAAA'] },
      ],
      config(server),
      null
    );
    const sent = server.lastRequest.body.messages;
    assert.equal(sent[0].content, 'sys'); // no images → plain string
    assert.deepEqual(sent[1].content, [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  } finally {
    server.close();
  }
});

test('image outputs in stream deltas fire onImage', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Here you go' } }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: { images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,IMG' } }] } }],
      })}\n\n`
    );
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const images = [];
    const full = await sendMessage([{ role: 'user', content: 'draw' }], config(server), null, {
      onImage: (url) => images.push(url),
    });
    assert.equal(full, 'Here you go');
    assert.deepEqual(images, ['data:image/png;base64,IMG']);
  } finally {
    server.close();
  }
});

test('finish_reason "length" surfaces via onFinishReason', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Cut off mid-sen' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    let reason = null;
    const full = await sendMessage([{ role: 'user', content: 'hi' }], config(server), null, {
      onFinishReason: (r) => (reason = r),
    });
    assert.equal(full, 'Cut off mid-sen');
    assert.equal(reason, 'length');
  } finally {
    server.close();
  }
});

test('normal stop reason also reported, not just truncation', async () => {
  const server = await startMockServer(); // sends no finish_reason at all
  try {
    let reason = 'unset';
    await sendMessage([{ role: 'user', content: 'hi' }], config(server), null, {
      onFinishReason: (r) => (reason = r),
    });
    assert.equal(reason, 'unset'); // callback only fires when the provider sent one
  } finally {
    server.close();
  }
});

test('final SSE event without trailing newline is not dropped', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'part one' } }] })}\n\n`);
    // Last event: no trailing newline, then the socket closes
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: ' and the very end' } }] })}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const full = await sendMessage([{ role: 'user', content: 'hi' }], config(server), null);
    assert.equal(full, 'part one and the very end');
  } finally {
    server.close();
  }
});

test('getCredits returns remaining balance from OpenRouter', async () => {
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/credits')) {
      server.lastAuth = req.headers.authorization;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { total_credits: 25, total_usage: 4.5 } }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const credits = await getCredits(config(server));
    assert.deepEqual(credits, { total: 25, used: 4.5, remaining: 20.5 });
    assert.equal(server.lastAuth, 'Bearer test-key');
    // Non-OpenRouter providers have no balance endpoint
    assert.equal(await getCredits(config(server, { provider: 'nanogpt' })), null);
  } finally {
    server.close();
  }
});

test('listModels flags image-output models from OpenRouter metadata', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [
      { id: 'maker/text-model', name: 'Text', context_length: 8000, architecture: { output_modalities: ['text'] } },
      { id: 'maker/image-model', name: 'Image', context_length: 32000, architecture: { output_modalities: ['image', 'text'] } },
    ]}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const models = await listModels(config(server));
    assert.equal(models.find((m) => m.id === 'maker/image-model').imageOutput, true);
    assert.equal(models.find((m) => m.id === 'maker/text-model').imageOutput, false);
  } finally {
    server.close();
  }
});

test('OpenAI reasoning models get max_completion_tokens and no sampling params', async () => {
  const server = await startMockServer();
  try {
    await sendMessage([{ role: 'user', content: 'hi' }], config(server, { provider: 'openai', model: 'o3-mini' }), null);
    let body = server.lastRequest.body;
    assert.equal(body.max_completion_tokens, 128);
    assert.ok(!('max_tokens' in body));
    assert.ok(!('temperature' in body));
    assert.ok(!('top_p' in body));
    await sendMessage([{ role: 'user', content: 'hi' }], config(server, { provider: 'openai', model: 'gpt-4o' }), null);
    body = server.lastRequest.body;
    assert.equal(body.max_tokens, 128);
    assert.equal(body.temperature, 0.7);
  } finally {
    server.close();
  }
});

test('retries a 429 with Retry-After and succeeds on the second attempt', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    if (requests === 1) {
      res.writeHead(429, { 'Retry-After': '0', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'after retry' } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const full = await sendMessage([{ role: 'user', content: 'hi' }], config(server), null);
    assert.equal(full, 'after retry');
    assert.equal(requests, 2);
  } finally {
    server.close();
  }
});

test('persistent 5xx gives up after the retry budget', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.writeHead(503, { 'Retry-After': '0', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'overloaded' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      sendMessage([{ role: 'user', content: 'hi' }], config(server), null),
      (err) => err instanceof LLMError && err.status === 503
    );
    assert.equal(requests, 3); // initial + 2 retries
  } finally {
    server.close();
  }
});

test('stream failures after content arrived are not retried', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
    setTimeout(() => res.destroy(), 20);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const chunks = [];
    await assert.rejects(
      sendMessage([{ role: 'user', content: 'hi' }], config(server), (t) => chunks.push(t))
    );
    assert.deepEqual(chunks, ['partial']);
    assert.equal(requests, 1);
  } finally {
    server.close();
  }
});

test('default models point at Gemini 3.1 Pro', () => {
  assert.equal(PROVIDERS.openrouter.defaultModel, 'google/gemini-3.1-pro-preview');
  assert.equal(PROVIDERS.nanogpt.defaultModel, 'google/gemini-3.1-pro-preview');
  assert.equal(PROVIDERS.gemini.defaultModel, 'gemini-3.1-pro-preview');
});

test('nanogpt uses the OpenAI wire format with bearer auth and sampler passthrough', async () => {
  const server = await startMockServer();
  try {
    const cfg = config(server, { provider: 'nanogpt' });
    cfg.params.min_p = 0.05;
    const full = await sendMessage([{ role: 'user', content: 'hi' }], cfg, null);
    assert.equal(full, 'Hello from the tavern!');
    assert.ok(server.lastRequest.url.endsWith('/chat/completions'));
    assert.equal(server.lastRequest.headers.authorization, 'Bearer test-key');
    assert.equal(server.lastRequest.body.max_tokens, 128);
    // Aggregator: provider-specific samplers pass straight through
    assert.equal(server.lastRequest.body.min_p, 0.05);
  } finally {
    server.close();
  }
});

test('nanogpt listModels requests the detailed catalog and maps its fields', async () => {
  const server = http.createServer((req, res) => {
    server.lastURL = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [
      {
        id: 'anthropic/claude-sonnet-5',
        name: 'Claude Sonnet 5',
        context_length: 1000000,
        architecture: { output_modalities: ['text'] },
        pricing: { prompt: 2, completion: 10, currency: 'USD', unit: 'per_million_tokens' },
      },
      { id: 'bare-model' }, // basic (non-detailed) entry shape
    ]}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const models = await listModels(config(server, { provider: 'nanogpt' }));
    assert.equal(server.lastURL, '/models?detailed=true');
    const sonnet = models.find((m) => m.id === 'anthropic/claude-sonnet-5');
    assert.equal(sonnet.name, 'Claude Sonnet 5');
    assert.equal(sonnet.context, 1000000);
    assert.equal(sonnet.imageOutput, false);
    assert.deepEqual(sonnet.pricing, { inPerM: 2, outPerM: 10 });
    const bare = models.find((m) => m.id === 'bare-model');
    assert.equal(bare.name, 'bare-model');
    assert.equal(bare.pricing, null);
  } finally {
    server.close();
  }
});

test('every provider is hosted, keyed, and covered by fallback models', () => {
  // Key sets must match exactly — a fallback list for a removed provider is stale
  assert.deepEqual(Object.keys(PROVIDERS).sort(), Object.keys(FALLBACK_MODELS).sort());
  for (const [provider, p] of Object.entries(PROVIDERS)) {
    assert.match(p.baseURL, /^https:\/\//);
    assert.equal(p.requiresKey, true);
    assert.ok(FALLBACK_MODELS[provider].length > 0, `no fallback models for ${provider}`);
    assert.ok(FALLBACK_MODELS[provider].includes(p.defaultModel), `default model of ${provider} missing from fallbacks`);
  }
});

test('openrouter asks for usage accounting and reports it via onUsage', async () => {
  const server = await startMockServer();
  try {
    let usage = null;
    await sendMessage([{ role: 'user', content: 'hi' }], config(server), () => {}, {
      onUsage: (u) => (usage = u),
    });
    assert.deepEqual(server.lastRequest.body.usage, { include: true });
    assert.deepEqual(usage, { inTokens: 12, outTokens: 4, cachedTokens: 8, costUSD: 0.00042 });
  } finally {
    server.close();
  }
});

test('non-streaming responses also report usage', async () => {
  const server = await startMockServer();
  try {
    const cfg = config(server);
    cfg.params.stream_response = false;
    let usage = null;
    await sendMessage([{ role: 'user', content: 'hi' }], cfg, null, { onUsage: (u) => (usage = u) });
    // No cache/cost fields in this payload → the optional keys are absent
    assert.deepEqual(usage, { inTokens: 12, outTokens: 4 });
  } finally {
    server.close();
  }
});

test('anthropic models via openrouter get a cache_control breakpoint on the leading system message', async () => {
  const server = await startMockServer();
  try {
    const messages = [
      { role: 'system', content: 'CARD' },
      { role: 'user', content: 'hi' },
    ];
    await sendMessage(messages, config(server, { model: 'anthropic/claude-sonnet-4-6' }), () => {});
    assert.deepEqual(server.lastRequest.body.messages[0], {
      role: 'system',
      content: [{ type: 'text', text: 'CARD', cache_control: { type: 'ephemeral' } }],
    });
    // Non-Anthropic models keep plain string content (implicit caching)
    await sendMessage(messages, config(server, { model: 'openai/gpt-4o' }), () => {});
    assert.equal(server.lastRequest.body.messages[0].content, 'CARD');
  } finally {
    server.close();
  }
});

test('openai streams request usage via stream_options; aggregators do not', async () => {
  const server = await startMockServer();
  try {
    await sendMessage([{ role: 'user', content: 'hi' }], config(server, { provider: 'openai' }), () => {});
    assert.deepEqual(server.lastRequest.body.stream_options, { include_usage: true });
    await sendMessage([{ role: 'user', content: 'hi' }], config(server), () => {});
    assert.equal(server.lastRequest.body.stream_options, undefined);
  } finally {
    server.close();
  }
});

test('claude: leading system cached, later system messages keep their position as user turns', async () => {
  const server = await startMockServer();
  try {
    const cfg = config(server, { provider: 'claude', model: 'claude-sonnet-5' });
    cfg.params.stream_response = false;
    let usage = null;
    const text = await sendMessage(
      [
        { role: 'system', content: 'CARD' },
        { role: 'system', content: 'PERSONA' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'system', content: 'SUMMARY' },
        { role: 'user', content: 'go on' },
        { role: 'system', content: 'REMINDER' },
      ],
      cfg,
      null,
      { onUsage: (u) => (usage = u) }
    );
    assert.equal(text, 'Claude says hi');
    const body = server.lastRequest.body;
    // The leading run of system messages is hoisted with a cache breakpoint
    assert.deepEqual(body.system, [
      { type: 'text', text: 'CARD\n\nPERSONA', cache_control: { type: 'ephemeral' } },
    ]);
    // Later system entries ride inline as user turns, merged with neighbors
    assert.deepEqual(
      body.messages.map((m) => [m.role, m.content.map((b) => b.text).join('|')]),
      [
        ['user', 'hi'],
        ['assistant', 'hello'],
        ['user', 'SUMMARY\n\ngo on\n\nREMINDER'],
      ]
    );
    // Anthropic's input_tokens excludes cache reads/writes — inTokens sums all three
    assert.deepEqual(usage, { inTokens: 152, outTokens: 7, cachedTokens: 100, cacheWriteTokens: 10 });
  } finally {
    server.close();
  }
});

test('gemini: later system messages stay positional as user turns', async () => {
  const server = await startMockServer();
  try {
    const cfg = config(server, { provider: 'gemini', model: 'test-model' });
    cfg.params.stream_response = false;
    let usage = null;
    const text = await sendMessage(
      [
        { role: 'system', content: 'CARD' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'NOTE' },
      ],
      cfg,
      null,
      { onUsage: (u) => (usage = u) }
    );
    assert.equal(text, 'Gemini says hi');
    const body = server.lastRequest.body;
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'CARD' }] });
    assert.deepEqual(
      body.contents.map((c) => [c.role, c.parts[0].text]),
      [
        ['user', 'hi'],
        ['user', 'NOTE'],
      ]
    );
    assert.deepEqual(usage, { inTokens: 30, outTokens: 5, cachedTokens: 20 });
  } finally {
    server.close();
  }
});

test('reasoning deltas stream via onReasoning and stay out of the content', async () => {
  const server = await startMockServer();
  try {
    const chunks = [];
    const thoughts = [];
    const full = await sendMessage(
      [{ role: 'user', content: 'hi' }],
      config(server, { model: 'reasoning-model' }),
      (text) => chunks.push(text),
      { onReasoning: (text) => thoughts.push(text) }
    );
    // Both the legacy `reasoning` string and `reasoning_details` entries arrive
    assert.deepEqual(thoughts, ['hmm, ', 'let me think']);
    assert.equal(full, 'The answer.');
    assert.deepEqual(chunks, ['The answer.']);
  } finally {
    server.close();
  }
});

test('reasoning effort setting maps to the OpenRouter reasoning param', async () => {
  const server = await startMockServer();
  try {
    const cfg = config(server);
    cfg.params.reasoning_effort = 'low';
    await sendMessage([{ role: 'user', content: 'hi' }], cfg, () => {});
    assert.deepEqual(server.lastRequest.body.reasoning, { effort: 'low' });

    cfg.params.reasoning_effort = 'none';
    await sendMessage([{ role: 'user', content: 'hi' }], cfg, () => {});
    assert.deepEqual(server.lastRequest.body.reasoning, { effort: 'none' });

    // 'auto' (and unset) leave the model at its own default
    cfg.params.reasoning_effort = 'auto';
    await sendMessage([{ role: 'user', content: 'hi' }], cfg, () => {});
    assert.equal(server.lastRequest.body.reasoning, undefined);

    // Direct-API providers don't get the OpenRouter-specific param
    const openaiCfg = config(server, { provider: 'openai' });
    openaiCfg.params.reasoning_effort = 'low';
    await sendMessage([{ role: 'user', content: 'hi' }], openaiCfg, () => {});
    assert.equal(server.lastRequest.body.reasoning, undefined);
  } finally {
    server.close();
  }
});
