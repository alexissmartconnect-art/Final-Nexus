import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderClient } from '@nexus/providers';
import { startMockServer, type MockServer } from '../../../tests/contracts/mock-server.js';
import { createTestApp, registerAndLogin, type TestApp } from './helpers.js';

/**
 * Phase 3 acceptance: a real multi-step task actually executes.
 * Each step performs a routed model call against a real local HTTP server;
 * the DAG, retries, cancellation and persistence are the production code.
 */
describe('orchestration', () => {
  let provider: MockServer;
  let t: TestApp;
  let cookie: string;
  let csrf: string;
  let calls: string[];
  const stub = { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' } as unknown as ProviderClient;

  beforeAll(async () => {
    calls = [];
    provider = await startMockServer({
      '/api/v1/chat/completions': (_req, res, body) => {
        const messages = (body as { messages?: { content: string }[] }).messages ?? [];
        const prompt = messages.map((m) => m.content).join('\n');
        calls.push(prompt);
        if (prompt.includes('FAILME')) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: { message: 'injected step failure' } }));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          model: 'acme/tiny:free',
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `done(${prompt.length})` } }],
          usage: { prompt_tokens: 8, completion_tokens: 3, cost: 0.00001 },
        }));
      },
    });

    t = await createTestApp({ providers: { openrouterBaseUrl: `${provider.baseUrl}/api/v1`, allowPrivate: true } });
    const s = await registerAndLogin(t);
    cookie = s.cookie; csrf = s.csrf;
    await t.app.inject({
      method: 'POST', url: '/api/credentials',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { provider: 'openrouter', secret: 'sk-or-v1-orch-test-0123456789' },
    });
    await t.app.providers!.registry.syncFrom(stub, [{
      provider: 'openrouter', externalId: 'acme/tiny:free', name: 'Acme Tiny', author: 'acme', description: null,
      contextLength: 32000, maxOutput: null,
      pricing: { promptPerMtok: 0, completionPerMtok: 0, isFree: true, tier: 'free', note: null },
      support: { tools: false, json: false, stream: null, reasoning: null, vision: false, audio: null, video: null, embeddings: null },
      available: true, availabilityNote: null, inferenceProviders: [],
    }]);
  }, 60_000);

  afterAll(async () => { await t.close(); await provider.close(); });

  it('seeds the 17 agent roles and exposes them', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/agents', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const agents = (res.json() as { agents: { key: string; role: string; tools: string[] }[] }).agents;
    expect(agents).toHaveLength(17);
    expect(agents.every((a) => a.role.length > 5)).toBe(true);
  });

  it('updates an agent definition', async () => {
    const res = await t.app.inject({
      method: 'PATCH', url: '/api/agents/fixer',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { maxRuns: 9, budgetUsd: 0.25 },
    });
    expect(res.statusCode).toBe(200);
    const agent = (res.json() as { agent: { maxRuns: number; budgetUsd: number } }).agent;
    expect(agent.maxRuns).toBe(9);
    expect(agent.budgetUsd).toBe(0.25);
  });

  it('rejects an invalid plan without executing anything', async () => {
    const before = calls.length;
    const cases = [
      { title: 'x', steps: [{ title: 'a', prompt: 'p', dependsOn: [5] }] },                    // out of range
      { title: 'x', steps: [{ title: 'a', prompt: 'p', dependsOn: [1] }, { title: 'b', prompt: 'q' }] }, // forward dep
      { title: 'x', steps: [{ title: 'a', prompt: 'p', agent: 'ghost' }] },                     // unknown agent
      { title: 'x', steps: [] },                                                                // no step
    ];
    for (const payload of cases) {
      const res = await t.app.inject({
        method: 'POST', url: '/api/orchestrate',
        headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        payload: { ...payload, run: true },
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
    }
    expect(calls.length).toBe(before);
  });

  it('plans a DAG without running it when run=false', async () => {
    const before = calls.length;
    const res = await t.app.inject({
      method: 'POST', url: '/api/orchestrate',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { title: 'Dry plan', run: false, steps: [{ title: 's1', prompt: 'p1' }, { title: 's2', prompt: 'p2', dependsOn: [0] }] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { rootId: string; ran: boolean; tasks: { kind: string; status: string }[] };
    expect(body.ran).toBe(false);
    expect(body.tasks).toHaveLength(3); // plan node + 2 steps
    expect(body.tasks[0]!.kind).toBe('plan');
    expect(calls.length).toBe(before); // nothing was executed
  });

  it('executes a real multi-step task in dependency order', async () => {
    calls = [];
    const res = await t.app.inject({
      method: 'POST', url: '/api/orchestrate',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: {
        title: 'Build a landing page',
        routingMode: 'free_first',
        steps: [
          { title: 'Architecture', prompt: 'Choose the stack', agent: 'architect', task: 'analysis' },
          { title: 'Implementation', prompt: 'Write the files', agent: 'frontend_dev', dependsOn: [0] },
          { title: 'Tests', prompt: 'Verify the result', agent: 'tester', dependsOn: [1] },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      rootId: string;
      report: { status: string; completed: number; failed: number; cancelled: number; tasks: { title: string; status: string; attempt: number }[] };
      events: { title: string; status: string }[];
    };
    expect(body.report.status).toBe('completed');
    expect(body.report.failed).toBe(0);
    expect(body.report.completed).toBe(4);           // plan node + 3 steps

    // Three real model calls, one per step
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatch(/Choose the stack/);
    expect(calls[1]).toMatch(/Write the files/);
    expect(calls[2]).toMatch(/Verify the result/);
    // The agent role is injected into the prompt
    expect(calls[0]).toMatch(/Rôle : Architecte/);
    // Later steps receive the previous output as untrusted context
    expect(calls[1]).toMatch(/UNTRUSTED-/);
    expect(calls[1]).toMatch(/sortie de/);

    // Agent runs were recorded
    const runs = t.db.prepare('SELECT agent_key, status, cost_status FROM agent_runs ORDER BY started_at').all() as
      { agent_key: string; status: string; cost_status: string }[];
    expect(runs.map((r) => r.agent_key)).toEqual(['architect', 'frontend_dev', 'tester']);
    expect(runs.every((r) => r.status === 'ok')).toBe(true);

    // Every step produced a tool execution record
    const tools = t.db.prepare("SELECT COUNT(*) AS n FROM tool_executions WHERE tool = 'ai.step' AND status = 'ok'").get() as { n: number };
    expect(tools.n).toBe(3);
  });

  it('retries a failing step, then fails it and cancels what depends on it', async () => {
    calls = [];
    const res = await t.app.inject({
      method: 'POST', url: '/api/orchestrate',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: {
        title: 'Doomed pipeline',
        steps: [
          { title: 'Broken step', prompt: 'FAILME please', maxAttempts: 2 },
          { title: 'Never runs', prompt: 'should not execute', dependsOn: [0] },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { report: { status: string; failed: number; cancelled: number; tasks: { title: string; status: string; attempt: number; error: string | null }[] } };
    expect(body.report.status).toBe('failed');
    // Bounded at two levels: 2 step attempts (maxAttempts) x 3 provider calls
    // per attempt (the HTTP client's own bounded retry on 5xx). No loop.
    expect(calls).toHaveLength(2 * 3);
    const broken = body.report.tasks.find((x) => x.title === 'Broken step')!;
    expect(broken.status).toBe('failed');
    expect(broken.attempt).toBe(2);
    expect(broken.error).toMatch(/injected step failure|500/);
    const blocked = body.report.tasks.find((x) => x.title === 'Never runs')!;
    expect(blocked.status).toBe('cancelled');
    expect(blocked.error).toMatch(/blocked by a failed dependency/);
  });

  it('reports the task graph on demand', async () => {
    const created = await t.app.inject({
      method: 'POST', url: '/api/orchestrate',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { title: 'Inspect me', run: false, steps: [{ title: 'only', prompt: 'p' }] },
    });
    const rootId = (created.json() as { rootId: string }).rootId;
    const res = await t.app.inject({ method: 'GET', url: `/api/tasks/${rootId}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { tasks: unknown[] }).tasks).toHaveLength(2);
  });

  it('cancels a planned task graph', async () => {
    const created = await t.app.inject({
      method: 'POST', url: '/api/orchestrate',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { title: 'Cancel me', run: false, steps: [{ title: 'a', prompt: 'p' }, { title: 'b', prompt: 'q', dependsOn: [0] }] },
    });
    const rootId = (created.json() as { rootId: string }).rootId;
    const res = await t.app.inject({
      method: 'POST', url: `/api/tasks/${rootId}/cancel`,
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, payload: {},
    });
    expect(res.statusCode).toBe(200);
    const tasks = (res.json() as { tasks: { status: string; error: string | null }[] }).tasks;
    expect(tasks.filter((x) => x.status !== 'completed').every((x) => x.status === 'cancelled')).toBe(true);
    expect(tasks.some((x) => x.error === 'cancelled by user')).toBe(true);
  });

  it('requires authentication and CSRF', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/agents' })).statusCode).toBe(401);
    const res = await t.app.inject({
      method: 'POST', url: '/api/orchestrate',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { title: 'x', steps: [{ title: 'a', prompt: 'p' }] },
    });
    expect(res.statusCode).toBe(403);
  });
});
