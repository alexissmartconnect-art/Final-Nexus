import { describe, expect, it } from 'vitest';
import { createTestApp, registerAndLogin } from './helpers.js';

describe('provider + model endpoints', () => {
  it('reports providers as configured:false when no key exists, without inventing data', async () => {
    const t = await createTestApp();
    const { cookie } = await registerAndLogin(t);
    const res = await t.app.inject({ method: 'GET', url: '/api/providers', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { providers: { provider: string; configured: boolean; reachable: boolean | null }[]; models: { total: number } };
    expect(body.providers).toHaveLength(2);
    for (const p of body.providers) {
      expect(p.configured).toBe(false);
      expect(p.reachable).toBeNull(); // unknown, not "ok"
    }
    expect(body.models.total).toBe(0);
    await t.close();
  });

  it('refuses to sync without a key, with an actionable message', async () => {
    const t = await createTestApp();
    const { cookie, csrf } = await registerAndLogin(t);
    const res = await t.app.inject({
      method: 'POST', url: '/api/providers/openrouter/sync',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'provider_unavailable' } });
    expect(String((res.json() as { error: { message: string } }).error.message)).toMatch(/OpenRouter API key/);
    await t.close();
  });

  it('rejects an unknown provider name', async () => {
    const t = await createTestApp();
    const { cookie, csrf } = await registerAndLogin(t);
    const res = await t.app.inject({
      method: 'POST', url: '/api/providers/openai/sync',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, payload: {},
    });
    expect(res.statusCode).toBe(400);
    await t.close();
  });

  it('requires authentication for the model catalogue', async () => {
    const t = await createTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/models' });
    expect(res.statusCode).toBe(401);
    await t.close();
  });

  it('serves the catalogue after a registry sync (direct registry write, no network)', async () => {
    const t = await createTestApp();
    const { cookie } = await registerAndLogin(t);
    const svc = t.app.providers!;
    await svc.registry.syncFrom(
      { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' } as never,
      [{
        provider: 'openrouter', externalId: 'acme/tiny:free', name: 'Acme Tiny', author: 'acme',
        description: null, contextLength: 8192, maxOutput: null,
        pricing: { promptPerMtok: 0, completionPerMtok: 0, isFree: true, tier: 'free', note: null },
        support: { tools: false, json: true, stream: null, reasoning: null, vision: false, audio: null, video: null, embeddings: null },
        available: true, availabilityNote: null, inferenceProviders: [],
      }],
    );

    const all = await t.app.inject({ method: 'GET', url: '/api/models', headers: { cookie } });
    expect(all.statusCode).toBe(200);
    const body = all.json() as { models: { id: string; pricingTier: string }[]; counts: { total: number; free: number } };
    expect(body.models).toHaveLength(1);
    expect(body.models[0]!.id).toBe('openrouter:acme/tiny:free');
    expect(body.counts).toEqual({ total: 1, free: 1, available: 1 });

    const free = await t.app.inject({ method: 'GET', url: '/api/models?tier=free&tools=1', headers: { cookie } });
    expect((free.json() as { models: unknown[] }).models).toHaveLength(0); // tools=false
    await t.close();
  });
});
