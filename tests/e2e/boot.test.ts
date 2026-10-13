import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '@nexus/db';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../apps/api/src/config.js';
import { createContext } from '../../apps/api/src/context.js';
import { buildApp } from '../../apps/api/src/app.js';

/**
 * End-to-end boot test: a real HTTP listener on a real TCP port, driven with fetch.
 * This proves the API is actually reachable, not just constructible.
 */
describe('API boot over real HTTP', () => {
  let app: FastifyInstance;
  let base: string;
  const dir = mkdtempSync(join(tmpdir(), 'nexus-e2e-'));

  beforeAll(async () => {
    const config = {
      ...loadConfig({ NEXUS_ENV: 'development', NEXUS_MASTER_KEY: 'e2e-master-key-0123456789abcdef', NEXUS_DATA_DIR: dir }),
      dbFile: join(dir, 'e2e.sqlite'),
    };
    const db = openDatabase({ file: config.dbFile });
    migrate(db, join(process.cwd(), 'database/migrations'));
    app = await buildApp(createContext(config, db), { logger: false });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    base = address;
  }, 60_000);

  afterAll(async () => { await app.close(); });

  it('answers /api/health over TCP', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; checks: { database: boolean } };
    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe(true);
  });

  it('runs a full register -> me -> credential -> logout cycle over TCP', async () => {
    const cookies = new Map<string, string>();
    const cookieHeader = (): Record<string, string> =>
      cookies.size ? { cookie: [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } : {};

    const reg = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'e2e@example.com', password: 'e2e-password-123', displayName: 'E2E' }),
    });
    expect(reg.status).toBe(201);
    for (const c of reg.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      cookies.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
    }
    const regBody = await reg.json() as { csrfToken: string; user: { role: string } };
    expect(regBody.user.role).toBe('admin');

    const me = await fetch(`${base}/api/auth/me`, { headers: cookieHeader() });
    expect(me.status).toBe(200);

    const putKey = await fetch(`${base}/api/credentials`, {
      method: 'POST',
      headers: { ...cookieHeader(), 'content-type': 'application/json', 'x-csrf-token': regBody.csrfToken },
      body: JSON.stringify({ provider: 'openrouter', secret: 'sk-or-v1-e2e-secret-0123456789abcdef' }),
    });
    expect(putKey.status).toBe(201);
    const keyBody = await putKey.json() as { credential: { keyFingerprint: string } };
    expect(keyBody.credential.keyFingerprint).toBeTruthy();

    const list = await fetch(`${base}/api/credentials`, { headers: cookieHeader() });
    expect((await list.text())).not.toContain('sk-or-v1-e2e-secret');

    const caps = await fetch(`${base}/api/meta/capabilities`);
    const capsBody = await caps.json() as { capabilities: { status: string }[] };
    expect(capsBody.capabilities.length).toBeGreaterThan(5);
    expect(capsBody.capabilities.some((c) => c.status === 'implemented')).toBe(true);

    const out = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { ...cookieHeader(), 'content-type': 'application/json', 'x-csrf-token': regBody.csrfToken },
      body: '{}',
    });
    expect(out.status).toBe(200);
    const after = await fetch(`${base}/api/auth/me`, { headers: cookieHeader() });
    expect(after.status).toBe(401);
  }, 60_000);
});
