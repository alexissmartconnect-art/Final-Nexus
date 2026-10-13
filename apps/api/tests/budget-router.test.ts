import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderClient } from '@nexus/providers';
import { startMockServer, type MockServer } from '../../../tests/contracts/mock-server.js';
import { createTestApp, registerAndLogin, type TestApp } from './helpers.js';

/**
 * Acceptance test 5 (budget) and 6 (provider failure) at the HTTP level.
 * The provider is a real local HTTP server; the API, router, cost engine and
 * database are the production code.
 */
describe('budget + routing (acceptance tests 5 and 6)', () => {
  let provider: MockServer;
  let t: TestApp;
  let cookie: string;
  let csrf: string;
  let hits: number;

  const stub = { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' } as unknown as ProviderClient;

  beforeAll(async () => {
    hits = 0;
    provider = await startMockServer({
      '/api/v1/chat/completions': (_req, res, body) => {
        hits += 1;
        const model = (body as { model?: string }).model;
        if (model === 'acme/flaky') {
          res.statusCode = 429;
          res.setHeader('retry-after', '0');
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: { message: 'rate limited' } }));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          model,
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `answered by ${model}` } }],
          usage: { prompt_tokens: 5, completion_tokens: 4, cost: 0.00002 },
        }));
      },
    });

    t = await createTestApp({ providers: { openrouterBaseUrl: `${provider.baseUrl}/api/v1`, allowPrivate: true } });
    const s = await registerAndLogin(t);
    cookie = s.cookie; csrf = s.csrf;

    await t.app.inject({
      method: 'POST', url: '/api/credentials',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { provider: 'openrouter', secret: 'sk-or-v1-budget-test-0123456789' },
    });

    await t.app.providers!.registry.syncFrom(stub, [
      {
        provider: 'openrouter', externalId: 'acme/flaky', name: 'Acme Flaky', author: 'acme', description: null,
        contextLength: 200000, maxOutput: null,
        pricing: { promptPerMtok: 3, completionPerMtok: 15, isFree: false, tier: 'paid', note: null },
        support: { tools: true, json: true, stream: null, reasoning: null, vision: false, audio: null, video: null, embeddings: null },
        available: true, availabilityNote: null, inferenceProviders: [],
      },
      {
        provider: 'openrouter', externalId: 'acme/backup', name: 'Acme Backup', author: 'acme', description: null,
        contextLength: 32000, maxOutput: null,
        pricing: { promptPerMtok: 1, completionPerMtok: 3, isFree: false, tier: 'paid', note: null },
        // tools: true on purpose - a fallback must satisfy the same required capabilities
        support: { tools: true, json: false, stream: null, reasoning: null, vision: false, audio: null, video: null, embeddings: null },
        available: true, availabilityNote: null, inferenceProviders: [],
      },
      {
        provider: 'openrouter', externalId: 'acme/gratis:free', name: 'Acme Gratis', author: 'acme', description: null,
        contextLength: 32000, maxOutput: null,
        pricing: { promptPerMtok: 0, completionPerMtok: 0, isFree: true, tier: 'free', note: null },
        support: { tools: false, json: false, stream: null, reasoning: null, vision: false, audio: null, video: null, embeddings: null },
        available: true, availabilityNote: null, inferenceProviders: [],
      },
    ]);
  }, 60_000);

  afterAll(async () => { await t.close(); await provider.close(); });

  it('creates and reads back a budget policy', async () => {
    const put = await t.app.inject({
      method: 'PUT', url: '/api/budgets',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { limitUsd: 5, allowPaid: true, period: 'monthly' },
    });
    expect(put.statusCode).toBe(200);
    const policy = (put.json() as { policy: { limitUsd: number; remainingUsd: number; allowPaid: boolean } }).policy;
    expect(policy.limitUsd).toBe(5);
    expect(policy.remainingUsd).toBe(5);
    expect(policy.allowPaid).toBe(true);

    const get = await t.app.inject({ method: 'GET', url: '/api/budgets', headers: { cookie } });
    expect((get.json() as { policies: unknown[] }).policies).toHaveLength(1);
  });

  it('explains the routing decision without calling any provider', async () => {
    const before = hits;
    const res = await t.app.inject({
      method: 'POST', url: '/api/router/explain',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { message: 'Quelle architecture pour un SaaS ?', routingMode: 'balanced', task: 'chat' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      chosen: { modelId: string } | null; chain: { modelId: string }[];
      rejected: { modelId: string; reason: string }[]; explanation: string[];
    };
    expect(body.chosen).not.toBeNull();
    expect(body.chain.length).toBeGreaterThan(0);
    expect(body.explanation.join(' ')).toMatch(/Sélection :/);
    expect(hits).toBe(before); // a dry run must not spend anything
  });

  it('retries a 429 a bounded number of times, then falls back to a compatible model', async () => {
    hits = 0;
    const res = await t.app.inject({
      method: 'POST', url: '/api/chat',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { message: 'hello', stream: false, routingMode: 'balanced', task: 'tool_use' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { message: { content: string; modelId: string }; attempts: { modelId: string; error: string }[] };
    // bounded retry: 1 + maxRetries(2) attempts on the failing model, never more
    expect(hits).toBe(4);
    expect(body.attempts).toHaveLength(1);
    expect(body.attempts[0]!.modelId).toBe('openrouter:acme/flaky');
    expect(body.attempts[0]!.error).toMatch(/429/);
    expect(body.message.modelId).toBe('openrouter:acme/backup');
    expect(body.message.content).toBe('answered by acme/backup');

    const audit = t.ctx.audit.recent(50) as { action: string }[];
    expect(audit.some((a) => a.action === 'chat.fallback')).toBe(true);
  });

  it('blocks a paid call when the budget is exhausted and proposes an alternative', async () => {
    await t.app.inject({
      method: 'PUT', url: '/api/budgets',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { limitUsd: 0, allowPaid: true },
    });
    const before = hits;
    const res = await t.app.inject({
      method: 'POST', url: '/api/chat',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { message: 'hello', stream: false, routingMode: 'quality' },
    });
    expect(res.statusCode).toBe(402);
    const err = (res.json() as { error: { code: string; message: string; details: { alternative: string } } }).error;
    expect(err.code).toBe('budget_exceeded');
    expect(err.message).toMatch(/Budget exceeded/);
    expect(err.details.alternative).toMatch(/cheaper or free model/i);
    expect(hits).toBe(before); // nothing was spent
  });

  it('lets a free model through while paid spend is blocked', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/chat',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { message: 'hello', stream: false, routingMode: 'free_only' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { message: { modelId: string } }).message.modelId).toBe('openrouter:acme/gratis:free');
  });

  it('reserves spend against the policy and reconciles it with the billed cost', async () => {
    await t.app.inject({
      method: 'PUT', url: '/api/budgets',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { limitUsd: 1, allowPaid: true },
    });
    const readSpent = async (): Promise<number> => {
      const r = await t.app.inject({ method: 'GET', url: '/api/budgets', headers: { cookie } });
      return (r.json() as { policies: { spentUsd: number }[] }).policies[0]!.spentUsd;
    };
    const before = await readSpent();

    const res = await t.app.inject({
      method: 'POST', url: '/api/chat',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { message: 'hello', stream: false, routingMode: 'manual', modelId: 'openrouter:acme/backup' },
    });
    expect(res.statusCode).toBe(200);
    const after = await readSpent();
    // The reservation (~0.003 USD from catalogue prices) must have been reconciled
    // down to the 0.00002 USD the provider actually reported.
    expect(after - before).toBeCloseTo(0.00002, 9);
  });

  it('refuses CSRF-less budget changes', async () => {
    const res = await t.app.inject({
      method: 'PUT', url: '/api/budgets',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { limitUsd: 999 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('requires authentication for budgets and router explanations', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/budgets' })).statusCode).toBe(401);
    expect((await t.app.inject({
      method: 'POST', url: '/api/router/explain', headers: { 'content-type': 'application/json' }, payload: { message: 'x' },
    })).statusCode).toBe(401);
  });
});
