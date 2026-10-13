import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenRouterClient, OPENROUTER_BASE_URL } from '../../packages/providers/src/openrouter.js';
import { NexusError } from '@nexus/shared';
import { startMockServer, writeSse, type MockServer } from './mock-server.js';

/**
 * Contract tests for the OpenRouter client.
 * Endpoints and payload shapes follow openrouter.ai/docs (verified 2026-10-12):
 *   GET  /api/v1/models
 *   GET  /api/v1/key
 *   GET  /api/v1/credits
 *   POST /api/v1/chat/completions  (OpenAI-compatible, usage.cost on the response)
 * The mock server is a real HTTP listener; only the *provider* is simulated.
 */
describe('OpenRouter contract', () => {
  let server: MockServer;
  let client: OpenRouterClient;

  beforeAll(async () => {
    server = await startMockServer({
      '/api/v1/models': (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          data: [
            {
              id: 'anthropic/claude-sonnet-4.5',
              name: 'Anthropic: Claude Sonnet 4.5',
              context_length: 200000,
              top_provider: { max_completion_tokens: 64000 },
              pricing: { prompt: '0.000003', completion: '0.000015' },
              architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
              supported_parameters: ['tools', 'response_format', 'reasoning', 'temperature'],
            },
            {
              id: 'meta-llama/llama-3.3-70b-instruct:free',
              name: 'Meta: Llama 3.3 70B (free)',
              context_length: 131072,
              pricing: { prompt: '0', completion: '0' },
              supported_parameters: ['temperature'],
            },
          ],
        }));
      },
      '/api/v1/key': (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          data: {
            label: 'nexus-key', limit: 10, limit_remaining: 7.5, limit_reset: 'monthly',
            usage: 2.5, usage_daily: 0.42, is_free_tier: false,
            free_model_daily_requests: { used: 12, limit: 1000 },
          },
        }));
      },
      '/api/v1/credits': (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: { total_credits: 25, total_usage: 2.5 } }));
      },
      '/api/v1/chat/completions': async (req, res, body) => {
        const b = body as { stream?: boolean; tools?: unknown[] };
        if (b.stream) {
          await writeSse(res, [
            { model: 'anthropic/claude-sonnet-4.5', choices: [{ delta: { role: 'assistant', content: 'Bon' } }] },
            { choices: [{ delta: { content: 'jour ' } }] },
            { choices: [{ delta: { content: 'le monde' }, finish_reason: 'stop' }] },
            { choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, cost: 0.0000405 } },
            '[DONE]',
          ]);
          return;
        }
        if (b.tools && b.tools.length > 0) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            model: 'anthropic/claude-sonnet-4.5',
            choices: [{
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant', content: '',
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'create_project', arguments: '{"name":"bella-notte"}' } }],
              },
            }],
            usage: { prompt_tokens: 40, completion_tokens: 12, cost: 0.0003 },
          }));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          model: 'anthropic/claude-sonnet-4.5',
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'TypeScript adds static types.' } }],
          usage: { prompt_tokens: 9, completion_tokens: 7, cost: 0.000132 },
        }));
      },
    });
    client = new OpenRouterClient({
      apiKey: 'sk-or-v1-test-key-0123456789',
      baseUrl: `${server.baseUrl}/api/v1`,
      extraHosts: ['127.0.0.1'],
      allowPrivate: true,
      referer: 'http://localhost:5173',
      title: 'NEXUS OMEGA',
    });
  });

  afterAll(async () => { await server.close(); });

  it('exposes the documented base URL', () => {
    expect(OPENROUTER_BASE_URL).toBe('https://openrouter.ai/api/v1');
  });

  it('normalises the model catalogue, including prices and free detection', async () => {
    const models = await client.listModels();
    expect(models).toHaveLength(2);

    const paid = models.find((m) => m.externalId === 'anthropic/claude-sonnet-4.5')!;
    expect(paid.pricing.promptPerMtok).toBeCloseTo(3, 5);          // 0.000003 $/tok -> 3 $/Mtok
    expect(paid.pricing.completionPerMtok).toBeCloseTo(15, 5);
    expect(paid.pricing.tier).toBe('paid');
    expect(paid.contextLength).toBe(200000);
    expect(paid.support.tools).toBe(true);
    expect(paid.support.json).toBe(true);
    expect(paid.support.vision).toBe(true);
    expect(paid.available).toBe(true);

    const free = models.find((m) => m.externalId.endsWith(':free'))!;
    expect(free.pricing.isFree).toBe(true);
    expect(free.pricing.tier).toBe('free');
    expect(free.support.tools).toBe(false);
  });

  it('sends the documented parameter names and returns the billed cost', async () => {
    const result = await client.chat({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'Explain TypeScript' }],
      temperature: 0.4, topP: 0.95, topK: 40, maxTokens: 256, seed: 7,
      responseFormat: { type: 'json_object' },
      providerRouting: { order: ['Anthropic', 'OpenAI'], allowFallbacks: false, requireParameters: true, dataCollection: 'deny', sort: { by: 'price' } },
    });

    expect(result.text).toBe('TypeScript adds static types.');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.promptTokens).toBe(9);
    expect(result.usage.completionTokens).toBe(7);
    expect(result.usage.billedCostUsd).toBeCloseTo(0.000132, 9);

    const sent = server.requests.filter((r) => r.url === '/api/v1/chat/completions').pop()!;
    const body = sent.body as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'anthropic/claude-sonnet-4.5', temperature: 0.4, top_p: 0.95, top_k: 40,
      max_tokens: 256, seed: 7, stream: false,
      response_format: { type: 'json_object' },
      provider: { order: ['Anthropic', 'OpenAI'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', sort: { by: 'price' } },
    });
    expect(sent.headers.authorization).toBe('Bearer sk-or-v1-test-key-0123456789');
    expect(sent.headers['http-referer']).toBe('http://localhost:5173');
    expect(sent.headers['x-title']).toBe('NEXUS OMEGA');
    expect(result.unsupportedParams).toEqual([]);
  });

  it('parses tool calls returned by the provider', async () => {
    const result = await client.chat({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'create a project' }],
      tools: [{ type: 'function', function: { name: 'create_project', parameters: { type: 'object' } } }],
      toolChoice: 'auto',
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe('create_project');
    expect(JSON.parse(result.toolCalls[0]!.argumentsText)).toEqual({ name: 'bella-notte' });
    expect(result.finishReason).toBe('tool_calls');
  });

  it('streams deltas over real SSE and aggregates usage', async () => {
    const deltas: string[] = [];
    const result = await client.chatStream(
      { model: 'anthropic/claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }] },
      (c) => { if (c.text) deltas.push(c.text); },
    );
    expect(deltas).toEqual(['Bon', 'jour ', 'le monde']);
    expect(result.text).toBe('Bonjour le monde');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.completionTokens).toBe(5);
    expect(result.usage.billedCostUsd).toBeCloseTo(0.0000405, 12);
  });

  it('reads the key endpoint and the credits endpoint, keeping unknowns null', async () => {
    const status = await client.verifyKey();
    expect(status.ok).toBe(true);
    expect(status.label).toBe('nexus-key');
    expect(status.limitUsd).toBe(10);
    expect(status.limitRemainingUsd).toBe(7.5);
    expect(status.usageUsd).toBe(2.5);
    expect(status.freeRequestsUsed).toBe(12);
    expect(status.freeRequestsLimit).toBe(1000);
    expect(status.creditsBalanceUsd).toBeCloseTo(22.5, 6);
    expect(status.isFreeTier).toBe(false);
  });

  it('retries a 429 a bounded number of times, then succeeds', async () => {
    server.failNext('/api/v1/chat/completions', 2, 429, { 'retry-after': '0' });
    const before = server.requests.length;
    const result = await client.chat({ model: 'anthropic/claude-sonnet-4.5', messages: [{ role: 'user', content: 'again' }] });
    expect(result.text).toBe('TypeScript adds static types.');
    const attempted = server.requests.slice(before).filter((r) => r.url === '/api/v1/chat/completions');
    expect(attempted).toHaveLength(3); // 2 injected failures + 1 success, no infinite loop
  });

  it('gives up after the retry budget on a persistent 429', async () => {
    server.failNext('/api/v1/models', 10, 429, { 'retry-after': '0' });
    await expect(client.listModels()).rejects.toThrow(NexusError);
  });

  it('maps a 401 to an unauthorized NexusError without leaking the key', async () => {
    server.failNext('/api/v1/key', 1, 401);
    const status = await client.verifyKey();
    expect(status.ok).toBe(false);
    expect(status.error).toBeTruthy();
    expect(status.error).not.toContain('sk-or-v1-test-key-0123456789');
  });

  it('refuses to reach a private address unless explicitly allowed (SSRF guard)', async () => {
    // HTTPS on a private address, allowlisted but with allowPrivate off.
    const unsafe = new OpenRouterClient({
      apiKey: 'sk-or-v1-test',
      baseUrl: 'https://10.0.0.7:9999/api/v1',
      extraHosts: ['10.0.0.7'],
    });
    await expect(unsafe.listModels()).rejects.toThrow(/private/i);
  });

  it('refuses a host outside the allowlist', async () => {
    expect(() => new OpenRouterClient({ apiKey: 'sk-or-v1-test', baseUrl: 'https://not-openrouter.example/api/v1' }))
      .toThrow(/not an allowlisted model endpoint/);
  });

  it('requires an API key', () => {
    expect(() => new OpenRouterClient({ apiKey: '' })).toThrow(/OpenRouter API key/);
  });
});
