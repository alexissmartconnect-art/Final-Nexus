import type { FastifyInstance } from 'fastify';
import { budgetUpsertSchema } from '@nexus/shared';
import type { CostEngine } from '@nexus/finops';
import type { AppContext } from '../context.js';
import { parse } from '../http/errors.js';
import { requireAuth, requireCsrf } from '../http/security.js';

export async function budgetRoutes(app: FastifyInstance, ctx: AppContext, cost: CostEngine): Promise<void> {
  app.get('/api/budgets', async (req, reply) => {
    const a = requireAuth(req);
    return reply.send({ policies: cost.listPolicies(a.userId), usage: cost.summary(a.userId) });
  });

  app.put('/api/budgets', async (req, reply) => {
    requireCsrf(ctx, req);
    const a = requireAuth(req);
    const input = parse(budgetUpsertSchema, req.body);
    const policy = cost.upsertPolicy(a.userId, input);
    ctx.audit.log({
      userId: a.userId, action: 'budget.update', targetType: 'budget_policy', targetId: policy.id, ip: req.ip,
      detail: { limitUsd: policy.limitUsd, period: policy.period, allowPaid: policy.allowPaid, freeOnly: policy.freeOnly },
    });
    return reply.send({ policy });
  });
}
