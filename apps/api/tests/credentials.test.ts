import { describe, expect, it } from 'vitest';
import { createTestApp, registerAndLogin } from './helpers.js';

describe('API key management', () => {
  it('stores the key encrypted and returns only a fingerprint', async () => {
    const t = await createTestApp();
    const { cookie, csrf, user } = await registerAndLogin(t);
    const secret = 'sk-or-v1-abcdef0123456789ABCDEF0123456789';

    const res = await t.app.inject({
      method: 'POST', url: '/api/credentials',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { provider: 'openrouter', secret },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(secret);
    const body = res.json() as { credential: { keyFingerprint: string; status: string } };
    expect(body.credential.status).toBe('active');
    expect(body.credential.keyFingerprint).toContain('…');

    // The raw secret must not be recoverable from the database row.
    const row = t.db.prepare('SELECT cipher_text, key_fingerprint FROM api_credentials WHERE user_id = ?').get(user.id) as
      { cipher_text: string; key_fingerprint: string };
    expect(row.cipher_text).toMatch(/^v1\./);
    expect(row.cipher_text).not.toContain(secret);
    expect(row.key_fingerprint).not.toContain(secret);

    // Server-side reveal still works, which is what the provider client needs.
    expect(t.ctx.credentials.reveal(user.id, 'openrouter')).toBe(secret);
    await t.close();
  });

  it('lists credentials without exposing ciphertext', async () => {
    const t = await createTestApp();
    const { cookie, csrf } = await registerAndLogin(t);
    await t.app.inject({
      method: 'POST', url: '/api/credentials',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { provider: 'huggingface', secret: 'hf_abcdefghijklmnopqrstuvwx1234' },
    });
    const list = await t.app.inject({ method: 'GET', url: '/api/credentials', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { credentials: { provider: string }[] };
    expect(body.credentials.map((c) => c.provider)).toContain('huggingface');
    expect(list.body).not.toContain('cipher_text');
    expect(list.body).not.toContain('hf_abcdefghijklmnopqrstuvwx1234');
    await t.close();
  });

  it('rejects an unauthenticated or CSRF-less write', async () => {
    const t = await createTestApp();
    const anon = await t.app.inject({
      method: 'POST', url: '/api/credentials',
      headers: { 'content-type': 'application/json' },
      payload: { provider: 'openrouter', secret: 'sk-or-v1-whatever-1234567890' },
    });
    expect(anon.statusCode).toBe(401);

    const { cookie } = await registerAndLogin(t);
    const noCsrf = await t.app.inject({
      method: 'POST', url: '/api/credentials',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { provider: 'openrouter', secret: 'sk-or-v1-whatever-1234567890' },
    });
    expect(noCsrf.statusCode).toBe(403);
    await t.close();
  });

  it('validates the provider name', async () => {
    const t = await createTestApp();
    const { cookie, csrf } = await registerAndLogin(t);
    const res = await t.app.inject({
      method: 'POST', url: '/api/credentials',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { provider: 'openai', secret: 'sk-something-long-enough' },
    });
    expect(res.statusCode).toBe(422);
    await t.close();
  });

  it('deletes a credential on request', async () => {
    const t = await createTestApp();
    const { cookie, csrf, user } = await registerAndLogin(t);
    await t.app.inject({
      method: 'POST', url: '/api/credentials',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { provider: 'openrouter', secret: 'sk-or-v1-abcdef0123456789ABCDEF0123456789' },
    });
    const del = await t.app.inject({
      method: 'DELETE', url: '/api/credentials/openrouter',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, payload: {},
    });
    expect(del.statusCode).toBe(200);
    expect(t.ctx.credentials.reveal(user.id, 'openrouter')).toBeNull();
    await t.close();
  });
});
