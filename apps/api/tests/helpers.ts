import { join } from 'node:path';
import { migrate, openDatabase, type Db } from '@nexus/db';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createContext, type AppContext } from '../src/context.js';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  db: Db;
  config: AppConfig;
  close: () => Promise<void>;
}

/**
 * Build a real API instance against a real SQLite database.
 * Routes are exercised through Fastify's `inject`, which runs the full
 * onRequest/parse/serialize pipeline without opening a network port.
 */
export async function createTestApp(overrides: Partial<AppConfig> = {}): Promise<TestApp> {
  const config: AppConfig = {
    ...loadConfig({ NEXUS_ENV: 'test', NEXUS_MASTER_KEY: 'unit-test-master-key-0123456789' }),
    ...overrides,
  };
  const db = openDatabase({ file: ':memory:' });
  migrate(db, join(process.cwd(), 'database/migrations'));
  const ctx = createContext(config, db);
  const app = await buildApp(ctx, { logger: false });
  return {
    app, ctx, db, config,
    close: async () => { await app.close(); db.close(); },
  };
}

/** Follow redirects-free cookie handling so a test can reuse a session. */
export function jar(): { header: string; store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get header() {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
  };
}

export function absorbCookies(res: { headers: Record<string, string | string[] | undefined> }, j: ReturnType<typeof jar>): void {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const c of list) {
    const [pair] = c.split(';');
    if (!pair) continue;
    const idx = pair.indexOf('=');
    store2(j, pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

function store2(j: ReturnType<typeof jar>, k: string, v: string): void {
  if (v === '') j.store.delete(k);
  else j.store.set(k, v);
}

export async function registerAndLogin(
  t: TestApp, email = 'ada@example.com', password = 'strong-password-123',
): Promise<{ cookie: string; csrf: string; user: { id: string; email: string; role: string } }> {
  const j = jar();
  const res = await t.app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email, password, displayName: 'Ada' },
    headers: { 'content-type': 'application/json' },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  absorbCookies(res, j);
  const body = res.json() as { csrfToken: string; user: { id: string; email: string; role: string } };
  return { cookie: j.header, csrf: body.csrfToken, user: body.user };
}
