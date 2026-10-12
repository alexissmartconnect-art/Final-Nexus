import type { FastifyInstance } from 'fastify';
import { CAPABILITIES } from '@nexus/shared';
import type { AppContext } from '../context.js';
import { requireAdmin } from '../http/security.js';

export async function metaRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/health', async (_req, reply) => {
    const dbOk = (() => {
      try { ctx.db.prepare('SELECT 1 AS ok').get(); return true; } catch { return false; }
    })();
    const healthy = dbOk;
    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      service: 'nexus-omega-api',
      version: '0.1.0',
      time: new Date().toISOString(),
      checks: { database: dbOk },
      // Never expose config, keys or absolute paths.
      runtime: { node: process.version, env: ctx.config.env },
    });
  });

  /** Capability registry (spec 4.1): what is implemented, what is planned, what is verified. */
  app.get('/api/meta/capabilities', async (_req, reply) => reply.send({ capabilities: CAPABILITIES }));

  app.get('/api/admin/audit', async (req, reply) => {
    requireAdmin(req);
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? '100') || 100, 500);
    return reply.send({ entries: ctx.audit.recent(limit) });
  });
}
