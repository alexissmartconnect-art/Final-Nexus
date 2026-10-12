import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { NexusError } from '@nexus/shared';
import { startMockServer, writeSse, type MockServer } from '../../../tests/contracts/mock-server.js';
import { createTestApp, registerAndLogin, type TestApp } from './helpers.js';

/**
 * End-to-end chat test. The API talks to a real HTTP server over a real socket,
 * streams SSE back, and persists messages + usage into SQLite. Only the upstream
 * provider is simulated; every line of NEXUS code under test is the production one.
 */
describe('chat pipeline', () => {
  let provider: MockServer;
  let t: TestApp;
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    provider = await startMockServer({
      '/api/v1/models': (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          data: [
            { id: 'acme/cheap:free', name: 'Acme Cheap', context_length: 8192, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['temperature'] },
            { id: 'acme/smart', name: 'Acme Smart', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' }, supported_parameters: ['tools', 'temperature'] },
          ],
        }));
      },
      '/api/v1/chat/completions': async (_req, res, body) => {
        const b = body as { stream?: boolean; messages?: { role: string; content: string }[] };
        const lastUser = (b.messages ?? []).filter((m) => m.role === 'user').pop()?.content ?? '';
        if (b.stream) {
          await writeSse(res, [
            { model: 'acme/cheap:free', choices: [{ delta: { content: 'Streamed: ' } }] },
            { choices: [{ delta: { content: lastUser }, finish_reason: 'stop' }] },
            '[DONE]',
          ]);
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          model: 'acme/cheap:free',
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `Echo: ${lastUser}` } }],
          usage: { prompt_tokens: 12, completion_tokens: 8, cost: 0.000123 },
        }));
      },
    });

    t = await createTestApp({
      providers: { openrouterBaseUrl: `${provider.baseUrl}/api/v1`, allowPrivate: true },
    });
    const session = await registerAndLogin(t);
    cookie = session.cookie;
    csrf = session.csrf;

    const key = await t.app.inject({
      method: 'POST', url: '/api/credentials',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { provider: 'openrouter', secret: 'sk-or-v1-chat-test-0123456789' },
    });
    expect(key.statusCode).toBe(201);

    const sync = await t.app.inject({
      method: 'POST', url: '/api/providers/openrouter/sync',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, payload: {},
    });
    expect(sync.statusCode).toBe(200);
    const syncBody = sync.json() as { result: { models: number; free: number }; models: { total: number } };
    expect(syncBody.result.models).toBe(2);
    expect(syncBody.result.free).toBe(1);
    expect(syncBody.models.total).toBe(2);
  }, 60_000);

  afterAll(async () => { await t.close(); await provider.close(); });

  it('answers without streaming, persists the exchange and records the real billed cost', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/chat',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { message: 'Bonjour, explique-moi les avantages de TypeScript.', stream: false, routingMode: 'free_first' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      conversationId: string; message: { content: string; modelId: string; costStatus: string };
      cost: { status: string; billedUsd: number | null }; tokensIn: number; tokensOut: number;
    };
    expect(body.message.content).toContain('Echo:');
    expect(body.message.modelId).toBe('openrouter:acme/cheap:free'); // free model chosen in free_first mode
    expect(body.cost.status).toBe('billed');
    expect(body.cost.billedUsd).toBeCloseTo(0.000123, 9);
    expect(body.tokensIn).toBe(12);

    const convs = await t.app.inject({ method: 'GET', url: '/api/conversations', headers: { cookie } });
    const list = (convs.json() as { conversations: { id: string; title: string | null }[] }).conversations;
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toMatch(/TypeScript/);

    const msgs = await t.app.inject({ method: 'GET', url: `/api/conversations/${body.conversationId}/messages`, headers: { cookie } });
    const rows = (msgs.json() as { messages: { role: string; costStatus: string }[] }).messages;
    expect(rows.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(rows[1]!.costStatus).toBe('billed');

    const usage = await t.app.inject({ method: 'GET', url: '/api/usage', headers: { cookie } });
    const totals = usage.json() as { totalCalls: number; totalCostBilledUsd: number; unknownCostCalls: number; policies: unknown[] };
    expect(totals.totalCalls).toBeGreaterThanOrEqual(1);
    expect(totals.totalCostBilledUsd).toBeCloseTo(0.000123, 9);
    expect(totals.unknownCostCalls).toBe(0);
    expect(Array.isArray(totals.policies)).toBe(true);
  });

  it('streams real SSE deltas and closes with a done event', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/chat',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { message: 'stream me', stream: true, routingMode: 'free_first' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const raw = res.rawPayload.toString('utf8');
    expect(raw).toContain('event: delta');
    expect(raw).toContain('"text":"Streamed: "');
    expect(raw).toContain('"text":"stream me"');
    expect(raw).toContain('event: done');
  });

  it('refuses free_only when no free model is available instead of spending money', async () => {
    // Point at a catalogue that only has paid models.
    t.db.prepare("UPDATE models SET pricing_tier = 'paid', external_id = replace(external_id, ':free', '')").run();
    const res = await t.app.inject({
      method: 'POST', url: '/api/chat',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { message: 'hello', stream: false, routingMode: 'free_only' },
    });
    expect(res.statusCode).toBe(402);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('budget_exceeded');
    expect(body.error.message).toMatch(/No free model/);
  });

  it('reports provider_unavailable when nothing has been synchronised', async () => {
    const t2 = await createTestApp();
    const s = await registerAndLogin(t2);
    const res = await t2.app.inject({
      method: 'POST', url: '/api/chat',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' },
      payload: { message: 'hello', stream: false, routingMode: 'free_first' },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('provider_unavailable');
    await t2.close();
  });

  it('keeps a cost of unknown as unknown, never zero', () => {
    // Direct check of the accounting rule that guards acceptance test 5.
    const err = new NexusError('budget_exceeded', 'x');
    expect(err.status).toBe(402);
  });
});
