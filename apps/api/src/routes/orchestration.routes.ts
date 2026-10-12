import type { FastifyInstance } from 'fastify';
import { agentUpdateSchema, NexusError, orchestrateSchema } from '@nexus/shared';
import type { AppContext } from '../context.js';
import { parse } from '../http/errors.js';
import { requireAuth, requireCsrf } from '../http/security.js';
import { OrchestrationService } from '../services/orchestration.service.js';
import type { ChatService } from '../services/chat.service.js';

export async function orchestrationRoutes(
  app: FastifyInstance, ctx: AppContext, chat: ChatService,
): Promise<void> {
  const svc = new OrchestrationService(ctx, chat);
  app.decorate('orchestration', svc);

  app.get('/api/agents', async (req, reply) => {
    requireAuth(req);
    return reply.send({ agents: svc.agents.list() });
  });

  app.patch('/api/agents/:key', async (req, reply) => {
    requireCsrf(ctx, req);
    const a = requireAuth(req);
    const { key } = req.params as { key: string };
    const patch = parse(agentUpdateSchema, req.body);
    const agent = svc.agents.update(key, patch);
    ctx.audit.log({ userId: a.userId, action: 'agents.update', targetType: 'agent', targetId: key, ip: req.ip });
    return reply.send({ agent });
  });

  app.post('/api/orchestrate', async (req, reply) => {
    requireCsrf(ctx, req);
    const a = requireAuth(req);
    const input = parse(orchestrateSchema, req.body);
    if (!input.run) {
      const { rootId, stepIds } = svc.plan({ ...input, userId: a.userId });
      return reply.status(201).send({ rootId, stepIds, tasks: svc.taskView(rootId), ran: false });
    }
    const { rootId, report, events } = await svc.execute({ ...input, userId: a.userId });
    return reply.status(201).send({ rootId, report, events, tasks: svc.taskView(rootId), ran: true });
  });

  app.get('/api/tasks/:rootId', async (req, reply) => {
    requireAuth(req);
    const { rootId } = req.params as { rootId: string };
    return reply.send({ tasks: svc.taskView(rootId) });
  });

  app.post('/api/tasks/:rootId/resume', async (req, reply) => {
    requireCsrf(ctx, req);
    const a = requireAuth(req);
    const { rootId } = req.params as { rootId: string };
    const report = await svc.resume(rootId, a.userId);
    return reply.send({ report, tasks: svc.taskView(rootId) });
  });

  app.post('/api/tasks/:rootId/cancel', async (req, reply) => {
    requireCsrf(ctx, req);
    const a = requireAuth(req);
    const { rootId } = req.params as { rootId: string };
    svc.cancel(rootId, a.userId);
    return reply.send({ ok: true, tasks: svc.taskView(rootId) });
  });

  void NexusError;
}

declare module 'fastify' {
  interface FastifyInstance {
    orchestration?: OrchestrationService;
  }
}
