// Verifies the LLM layer against a local mock server speaking the OpenAI/
// OpenRouter SSE wire format, plus error handling and abort.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sendMessage, listModels, getCredits, LLMError, PROVIDERS, FALLBACK_MODELS, lookupModelPricing } from '../src/main/llm.js';

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
  // Local models are free
  assert.deepEqual(lookupModelPricing('ollama', 'llama3.1'), { inPerM: 0, outPerM: 0 });
  // Unknown model / provider without a table
  assert.equal(lookupModelPricing('openai', 'some-experimental-model'), null);
  assert.equal(lookupModelPricing('custom', 'gpt-4o'), null);
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
          const chunks = ['Hello', ' from', ' the', ' tavern!'];
          for (const text of chunks) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: 'Hello complete' } }] }));
        }
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

test('provider registry covers all fallback lists', () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), Object.keys(FALLBACK_MODELS).sort());
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

test('requestImages adds OpenRouter modalities', async () => {
  const server = await startMockServer();
  try {
    await sendMessage([{ role: 'user', content: 'draw' }], config(server, { requestImages: true }), null);
    assert.deepEqual(server.lastRequest.body.modalities, ['image', 'text']);
    await sendMessage([{ role: 'user', content: 'hi' }], config(server), null);
    assert.ok(!('modalities' in server.lastRequest.body));
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
    assert.equal(await getCredits(config(server, { provider: 'ollama' })), null);
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

test('custom provider requires a base URL and auth is optional', async () => {
  const server = await startMockServer();
  try {
    await assert.rejects(
      sendMessage([{ role: 'user', content: 'hi' }], config(server, { provider: 'custom', baseURL: '' }), null),
      /base URL/
    );
    await sendMessage([{ role: 'user', content: 'hi' }], config(server, { provider: 'custom', apiKey: '' }), null);
    assert.equal(server.lastRequest.headers.authorization, undefined);
    await sendMessage([{ role: 'user', content: 'hi' }], config(server, { provider: 'custom' }), null);
    assert.equal(server.lastRequest.headers.authorization, 'Bearer test-key');
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

test('ollama uses the native /api/chat with num_ctx and NDJSON streaming', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      server.lastRequest = { url: req.url, body: JSON.parse(body) };
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { content: 'Hello ' }, done: false }) + '\n');
      res.write(JSON.stringify({ message: { content: 'local' }, done: true, done_reason: 'stop' }) + '\n');
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const cfg = config(server, { provider: 'ollama', apiKey: '' });
    cfg.params.context_size = 8192;
    const chunks = [];
    let reason = null;
    const full = await sendMessage(
      [{ role: 'user', content: 'hi', images: ['data:image/png;base64,QUJD'] }],
      cfg,
      (t) => chunks.push(t),
      { onFinishReason: (r) => (reason = r) }
    );
    assert.equal(full, 'Hello local');
    assert.deepEqual(chunks, ['Hello ', 'local']);
    assert.equal(reason, 'stop');
    assert.ok(server.lastRequest.url.endsWith('/api/chat'));
    assert.equal(server.lastRequest.body.options.num_ctx, 8192);
    assert.equal(server.lastRequest.body.options.num_predict, 128);
    assert.deepEqual(server.lastRequest.body.messages[0].images, ['QUJD']);
  } finally {
    server.close();
  }
});

test('default models point at Gemini 3.1 Pro', () => {
  assert.equal(PROVIDERS.openrouter.defaultModel, 'google/gemini-3.1-pro-preview');
  assert.equal(PROVIDERS.gemini.defaultModel, 'gemini-3.1-pro-preview');
});

test('deepseek/kimi/qwen use the OpenAI wire format with bearer auth', async () => {
  const server = await startMockServer();
  try {
    for (const provider of ['deepseek', 'kimi', 'qwen']) {
      const full = await sendMessage([{ role: 'user', content: 'hi' }], config(server, { provider }), null);
      assert.equal(full, 'Hello from the tavern!');
      assert.ok(server.lastRequest.url.endsWith('/chat/completions'));
      assert.equal(server.lastRequest.headers.authorization, 'Bearer test-key');
      assert.equal(server.lastRequest.body.max_tokens, 128);
    }
  } finally {
    server.close();
  }
});

test('deepseek/kimi/qwen have hosted default base URLs and fallback models', () => {
  for (const provider of ['deepseek', 'kimi', 'qwen']) {
    assert.match(PROVIDERS[provider].baseURL, /^https:\/\//);
    assert.equal(PROVIDERS[provider].requiresKey, true);
    assert.ok(FALLBACK_MODELS[provider].length > 0);
    assert.ok(FALLBACK_MODELS[provider].includes(PROVIDERS[provider].defaultModel));
  }
});
