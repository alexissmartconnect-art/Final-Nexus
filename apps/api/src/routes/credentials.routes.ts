import type { FastifyInstance } from 'fastify';
import { credentialSchema } from '@nexus/shared';
import type { AppContext } from '../context.js';
import { parse } from '../http/errors.js';
import { requireAuth, requireCsrf } from '../http/security.js';

/**
 * API key management. Secrets are accepted over HTTPS, encrypted at rest, and
 * never returned: the client only ever sees a fingerprint.
 */
export async function credentialRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/credentials', async (req, reply) => {
    requireCsrf(ctx, req);
    const a = requireAuth(req);
    const input = parse(credentialSchema, req.body);
    const stored = ctx.credentials.upsert({
      userId: a.userId, provider: input.provider, label: input.label, secret: input.secret,
    });
    ctx.audit.log({
      userId: a.userId, action: 'credentials.set', targetType: 'api_credential', targetId: stored.id,
      ip: req.ip, detail: { provider: input.provider, label: input.label, fingerprint: stored.keyFingerprint },
    });
    const { userId: _u, ...rest } = stored;
    void _u;
    return reply.status(201).send({ credential: rest });
  });

  app.get('/api/credentials', async (req, reply) => {
    const a = requireAuth(req);
    const list = ctx.credentials.list(a.userId).map(({ userId: _u, ...rest }) => { void _u; return rest; });
    return reply.send({ credentials: list });
  });

  app.delete('/api/credentials/:provider', async (req, reply) => {
    requireCsrf(ctx, req);
    const a = requireAuth(req);
    const { provider } = req.params as { provider: string };
    const label = (req.query as { label?: string }).label ?? 'default';
    ctx.credentials.remove(a.userId, provider, label);
    ctx.audit.log({ userId: a.userId, action: 'credentials.delete', targetType: 'api_credential', targetId: provider, ip: req.ip });
    return reply.send({ ok: true });
  });
}
