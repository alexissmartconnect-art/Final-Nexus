import type { FastifyInstance } from 'fastify';
import { NexusError } from '@nexus/shared';
import type { ProviderId } from '@nexus/providers';
import type { AppContext } from '../context.js';
import { requireAuth, requireCsrf } from '../http/security.js';
import { ProviderService } from '../services/provider.service.js';

function providerParam(raw: string): ProviderId {
  if (raw === 'openrouter' || raw === 'huggingface') return raw;
  throw new NexusError('bad_request', `Unknown provider "${raw}"`);
}

export async function providerRoutes(app: FastifyInstance, ctx: AppContext, svc: ProviderService): Promise<void> {
  app.get('/api/providers', async (req, reply) => {
    const a = requireAuth(req);
    const [healths, counts] = await Promise.all([svc.healthAll(a.userId), Promise.resolve(svc.registry.counts())]);
    return reply.send({ providers: healths, models: counts });
  });

  app.post('/api/providers/:provider/sync', async (req, reply) => {
    requireCsrf(ctx, req);
    const a = requireAuth(req);
    const provider = providerParam((req.params as { provider: string }).provider);
    const result = await svc.sync(a.userId, provider);
    return reply.send({ result, models: svc.registry.counts() });
  });

  app.get('/api/models', async (req, reply) => {
    requireAuth(req);
    const q = req.query as Record<string, string | undefined>;
    const models = svc.registry.list({
      provider: q.provider === 'openrouter' || q.provider === 'huggingface' ? q.provider : undefined,
      pricingTier: q.tier === 'free' || q.tier === 'paid' || q.tier === 'unknown' ? q.tier : undefined,
      availableOnly: q.available === '1',
      needsTools: q.tools === '1',
      search: q.q,
      limit: q.limit ? Math.min(Number(q.limit) || 200, 1000) : 200,
    });
    return reply.send({ models, counts: svc.registry.counts() });
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    providers?: ProviderService;
    cost?: import('@nexus/finops').CostEngine;
    router?: import('@nexus/router').SmartRouter;
    chat?: import('../services/chat.service.js').ChatService;
  }
}
