import type { FastifyInstance } from 'fastify';
import { chatRequestSchema, isNexusError, routeExplainSchema, type PublicConversation, type PublicMessage } from '@nexus/shared';
import type { AppContext } from '../context.js';
import { parse } from '../http/errors.js';
import { requireAuth, requireCsrf } from '../http/security.js';
import { ChatService } from '../services/chat.service.js';
import type { CostEngine } from '@nexus/finops';
import type { SmartRouter } from '@nexus/router';
import type { ProviderService } from '../services/provider.service.js';

export async function chatRoutes(
  app: FastifyInstance, ctx: AppContext, providers: ProviderService,
  router: SmartRouter, cost: CostEngine,
): Promise<void> {
  const svc = new ChatService(ctx, providers, router, cost);

  app.get('/api/conversations', async (req, reply) => {
    const a = requireAuth(req);
    return reply.send({ conversations: svc.listConversations(a.userId) });
  });

  app.get('/api/conversations/:id/messages', async (req, reply) => {
    const a = requireAuth(req);
    const { id } = req.params as { id: string };
    const messages: PublicMessage[] = svc.messages(id, a.userId);
    return reply.send({ messages });
  });

  app.post('/api/chat', async (req, reply) => {
    requireCsrf(ctx, req);
    const a = requireAuth(req);
    const input = parse(chatRequestSchema, req.body);

    if (!input.stream) {
      const outcome = await svc.send(a.userId, input);
      return reply.send({
        conversationId: outcome.conversationId,
        message: { role: 'assistant', content: outcome.text, modelId: outcome.modelId, costStatus: outcome.cost.status },
        cost: outcome.cost,
        tokensIn: outcome.tokensIn, tokensOut: outcome.tokensOut,
        latencyMs: outcome.latencyMs, attempts: outcome.attempts,
      });
    }

    // Server-sent events: hijack the reply and write the stream ourselves.
    void reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event: string, data: unknown): void => {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const controller = new AbortController();
    req.raw.on('close', () => controller.abort());

    try {
      const outcome = await svc.send(a.userId, input, {
        onDelta: (text) => send('delta', { text }),
        onMeta: (meta) => send('meta', meta),
      });
      send('done', {
        conversationId: outcome.conversationId, messageId: outcome.messageId,
        modelId: outcome.modelId, cost: outcome.cost,
        tokensIn: outcome.tokensIn, tokensOut: outcome.tokensOut, attempts: outcome.attempts,
      });
    } catch (err) {
      const code = isNexusError(err) ? err.code : 'internal';
      const message = err instanceof Error ? err.message : String(err);
      ctx.audit.log({ userId: a.userId, action: 'chat.error', outcome: 'error', detail: { code, message } });
      send('error', { code, message });
    } finally {
      raw.end();
    }
  });

  /** Dry run: shows which model would be chosen and why, without calling anyone. */
  app.post('/api/router/explain', async (req, reply) => {
    const a = requireAuth(req);
    const input = parse(routeExplainSchema, req.body);
    const models = providers.registry.list({ limit: 500 });
    const decision = router.select(models, {
      mode: input.routingMode, task: input.task, prompt: input.message,
      maxOutputTokens: input.maxOutputTokens, privacy: input.privacy,
      preferredModelId: input.modelId, chainLength: 5,
    }, { userId: a.userId, scope: 'account' });
    return reply.send({
      mode: decision.mode,
      task: decision.task,
      chosen: decision.chosen ? { modelId: decision.chosen.model.id, name: decision.chosen.model.name, score: decision.chosen.score, reasons: decision.chosen.reasons } : null,
      chain: decision.chain.map((c) => ({ modelId: c.model.id, score: c.score, estimate: c.estimate })),
      rejected: decision.rejected.slice(0, 25),
      estimate: decision.estimate,
      spend: decision.spend,
      explanation: decision.explanation,
    });
  });

  app.get('/api/usage', async (req, reply) => {
    const a = requireAuth(req);
    return reply.send({
      ...cost.summary(a.userId),
      policies: cost.listPolicies(a.userId),
    });
  });

}
