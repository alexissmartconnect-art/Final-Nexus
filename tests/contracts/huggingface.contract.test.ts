import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HuggingFaceClient, HF_HUB_BASE_URL, HF_ROUTER_BASE_URL } from '../../packages/providers/src/huggingface.js';
import { startMockServer, writeSse, type MockServer } from './mock-server.js';

/**
 * Contract tests for the Hugging Face Inference Providers client.
 * Endpoints follow huggingface.co/docs/inference-providers (verified 2026-10-12):
 *   POST https://router.huggingface.co/v1/chat/completions
 *   GET  https://router.huggingface.co/v1/models
 *   GET  https://huggingface.co/api/models            (Hub catalogue)
 *   GET  https://huggingface.co/api/whoami-v2
 * A model listed on the Hub is not automatically served: the client keeps the
 * two lists apart instead of pretending they are the same thing.
 */
describe('Hugging Face contract', () => {
  let router: MockServer;
  let hub: MockServer;
  let client: HuggingFaceClient;

  beforeAll(async () => {
    router = await startMockServer({
      '/v1/models': (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          data: [
            {
              id: 'openai/gpt-oss-120b', owned_by: 'openai', context_length: 131072,
              pricing: { prompt: 0, completion: 0 }, capabilities: ['tools', 'reasoning'], type: 'chat',
            },
            {
              id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', owned_by: 'Qwen', context_length: 262144,
              pricing: { prompt: 0.0000002, completion: 0.0000006 }, capabilities: ['tools'], type: 'chat',
            },
          ],
        }));
      },
      '/v1/chat/completions': async (_req, res, body) => {
        const b = body as { stream?: boolean };
        if (b.stream) {
          await writeSse(res, [
            { model: 'openai/gpt-oss-120b', choices: [{ delta: { content: 'Salut' } }] },
            { choices: [{ delta: { content: ' !' }, finish_reason: 'stop' }] },
            { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } },
            '[DONE]',
          ]);
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          model: 'openai/gpt-oss-120b',
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Bonjour depuis HF.' } }],
          usage: { prompt_tokens: 6, completion_tokens: 5 },
        }));
      },
    });

    hub = await startMockServer({
      '/api/models': (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify([
          { id: 'meta-llama/Llama-3.3-70B-Instruct', author: 'meta-llama', pipeline_tag: 'text-generation', tags: ['transformers'], downloads: 100000 },
          { id: 'some-org/weights-only-model', author: 'some-org', pipeline_tag: 'text-generation', tags: ['safetensors'], inference_provider_mapping: { together: {} } },
        ]));
      },
      '/api/whoami-v2': (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ name: 'nexus-operator', type: 'user' }));
      },
    });

    client = new HuggingFaceClient({
      token: 'hf_testtoken0123456789abcdef',
      routerBaseUrl: `${router.baseUrl}/v1`,
      hubBaseUrl: `${hub.baseUrl}/api`,
      extraHosts: ['127.0.0.1'],
      allowPrivate: true,
    });
  });

  afterAll(async () => { await router.close(); await hub.close(); });

  it('exposes the documented base URLs', () => {
    expect(HF_ROUTER_BASE_URL).toBe('https://router.huggingface.co/v1');
    expect(HF_HUB_BASE_URL).toBe('https://huggingface.co/api');
  });

  it('lists inference models with pricing normalised to USD per million tokens', async () => {
    const models = await client.listInferenceModels();
    expect(models).toHaveLength(2);
    const free = models.find((m) => m.externalId === 'openai/gpt-oss-120b')!;
    expect(free.pricing.isFree).toBe(true);
    expect(free.pricing.tier).toBe('free');
    expect(free.support.tools).toBe(true);
    expect(free.available).toBe(true);
    expect(free.contextLength).toBe(131072);

    const paid = models.find((m) => m.externalId.startsWith('Qwen/'))!;
    expect(paid.pricing.promptPerMtok).toBeCloseTo(0.2, 6);
    expect(paid.pricing.completionPerMtok).toBeCloseTo(0.6, 6);
    expect(paid.pricing.tier).toBe('paid');
  });

  it('keeps Hub-listed models distinct from inference-served models', async () => {
    const hubModels = await client.listModels();
    expect(hubModels).toHaveLength(2);
    const unmapped = hubModels.find((m) => m.externalId === 'meta-llama/Llama-3.3-70B-Instruct')!;
    expect(unmapped.available).toBe(false);
    expect(unmapped.availabilityNote).toMatch(/not confirmed as served/i);

    const mapped = hubModels.find((m) => m.externalId === 'some-org/weights-only-model')!;
    expect(mapped.available).toBe(true);
    expect(mapped.inferenceProviders).toEqual(['together']);
  });

  it('calls chat completions and reports that the cost is unknown, not zero', async () => {
    const result = await client.chat({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: 'bonjour' }],
      temperature: 0.3, maxTokens: 128, topK: 50, responseFormat: { type: 'json_object' },
    });
    expect(result.text).toBe('Bonjour depuis HF.');
    expect(result.usage.promptTokens).toBe(6);
    expect(result.usage.billedCostUsd).toBeNull(); // honest: the router does not bill-report here
    // Parameters the endpoint does not document are reported, never silently sent.
    expect(result.unsupportedParams).toContain('top_k');
    expect(result.unsupportedParams).toContain('response_format');

    const sent = router.requests.filter((r) => r.url === '/v1/chat/completions').pop()!;
    const body = sent.body as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'openai/gpt-oss-120b', temperature: 0.3, max_tokens: 128, stream: false });
    expect(body.top_k).toBeUndefined();
    expect(body.response_format).toBeUndefined();
    expect(sent.headers.authorization).toBe('Bearer hf_testtoken0123456789abcdef');
  });

  it('streams over real SSE', async () => {
    const deltas: string[] = [];
    const result = await client.chatStream(
      { model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] },
      (c) => { if (c.text) deltas.push(c.text); },
    );
    expect(deltas).toEqual(['Salut', ' !']);
    expect(result.text).toBe('Salut !');
    expect(result.finishReason).toBe('stop');
  });

  it('verifies the token and states that spend is not exposed', async () => {
    const status = await client.verifyKey();
    expect(status.ok).toBe(true);
    expect(status.label).toBe('nexus-operator');
    expect(status.error).toMatch(/not exposed/i);
    expect(status.limitUsd).toBeNull();
  });

  it('retries a 429 a bounded number of times', async () => {
    router.failNext('/v1/chat/completions', 2, 429, { 'retry-after': '0' });
    const before = router.requests.length;
    const result = await client.chat({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'retry' }] });
    expect(result.text).toBe('Bonjour depuis HF.');
    expect(router.requests.slice(before).filter((r) => r.url === '/v1/chat/completions')).toHaveLength(3);
  });

  it('refuses an unallowlisted base URL', () => {
    expect(() => new HuggingFaceClient({ token: 'hf_x', routerBaseUrl: 'https://evil.example/v1' }))
      .toThrow(/not an allowlisted model endpoint/);
  });

  it('requires a token', () => {
    expect(() => new HuggingFaceClient({ token: '' })).toThrow(/Hugging Face token/);
  });
});
