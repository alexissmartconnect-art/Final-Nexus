import { describe, expect, it } from 'vitest';
import { createTestApp, registerAndLogin } from './helpers.js';

describe('authentication (real routes, real SQLite)', () => {
  it('registers the first account as admin and issues a session cookie', async () => {
    const t = await createTestApp();
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'First@Example.com', password: 'strong-password-123', displayName: 'First' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { user: { email: string; role: string }; firstAccount: boolean };
    expect(body.user.email).toBe('first@example.com'); // normalised to lower case
    expect(body.user.role).toBe('admin');
    expect(body.firstAccount).toBe(true);

    const setCookie = res.headers['set-cookie'];
    const cookies = (Array.isArray(setCookie) ? setCookie : [setCookie]).filter(Boolean) as string[];
    const session = cookies.find((c) => c.startsWith('nexus_session='));
    expect(session).toBeDefined();
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).not.toMatch(/Secure/i); // development/test
    await t.close();
  });

  it('marks later accounts as plain users', async () => {
    const t = await createTestApp();
    await registerAndLogin(t, 'admin@example.com');
    const second = await registerAndLogin(t, 'user@example.com');
    expect(second.user.role).toBe('user');
    await t.close();
  });

  it('rejects a duplicate email with 409', async () => {
    const t = await createTestApp();
    await registerAndLogin(t, 'dup@example.com');
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'dup@example.com', password: 'another-password-1' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'conflict' } });
    await t.close();
  });

  it('validates weak passwords with 422', async () => {
    const t = await createTestApp();
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'weak@example.com', password: 'short' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'validation' } });
    await t.close();
  });

  it('rejects a wrong password with 401 and logs the denial', async () => {
    const t = await createTestApp();
    await registerAndLogin(t, 'who@example.com', 'correct-password-1');
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'who@example.com', password: 'wrong-password-99' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
    expect(t.ctx.audit.countByOutcome('denied')).toBeGreaterThan(0);
    await t.close();
  });

  it('serves /api/auth/me only with a valid cookie', async () => {
    const t = await createTestApp();
    const anon = await t.app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(anon.statusCode).toBe(401);

    const { cookie } = await registerAndLogin(t);
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { email: 'ada@example.com' } });
    await t.close();
  });

  it('logout revokes the session so the cookie stops working', async () => {
    const t = await createTestApp();
    const { cookie, csrf } = await registerAndLogin(t);
    const out = await t.app.inject({
      method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, payload: {},
    });
    expect(out.statusCode).toBe(200);
    const after = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
    await t.close();
  });

  it('enforces CSRF on state-changing routes', async () => {
    const t = await createTestApp();
    const { cookie } = await registerAndLogin(t);
    const noToken = await t.app.inject({
      method: 'POST', url: '/api/auth/logout', headers: { cookie, 'content-type': 'application/json' }, payload: {},
    });
    expect(noToken.statusCode).toBe(403);
    expect(noToken.json()).toMatchObject({ error: { code: 'forbidden' } });

    const badToken = await t.app.inject({
      method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-csrf-token': 'forged', 'content-type': 'application/json' }, payload: {},
    });
    expect(badToken.statusCode).toBe(403);
    await t.close();
  });

  it('rate limits repeated login attempts with 429', async () => {
    const t = await createTestApp();
    await registerAndLogin(t, 'rl@example.com', 'correct-password-1');
    let last = 0;
    for (let i = 0; i < 14; i++) {
      const r = await t.app.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: 'rl@example.com', password: 'nope-nope-nope' },
        headers: { 'content-type': 'application/json' },
      });
      last = r.statusCode;
    }
    expect(last).toBe(429);
    expect(t.ctx.audit.countByOutcome('denied')).toBeGreaterThan(0);
    await t.close();
  });

  it('sets security headers and a strict CSP on every response', async () => {
    const t = await createTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'self'");
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    await t.close();
  });

  it('exposes health with a real database check', async () => {
    const t = await createTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; checks: { database: boolean } };
    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe(true);
    await t.close();
  });

  it('returns a structured 404 for unknown routes', async () => {
    const t = await createTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
    await t.close();
  });

  it('restricts the audit endpoint to admins', async () => {
    const t = await createTestApp();
    await registerAndLogin(t, 'boss@example.com');           // first -> admin
    const normal = await registerAndLogin(t, 'worker@example.com');
    const denied = await t.app.inject({ method: 'GET', url: '/api/admin/audit', headers: { cookie: normal.cookie } });
    expect(denied.statusCode).toBe(403);
    await t.close();
  });
});
