import type { FastifyInstance } from 'fastify';
import { chatRequestSchema, NexusError, isNexusError, type PublicConversation, type PublicMessage } from '@nexus/shared';
import type { AppContext } from '../context.js';
import { parse } from '../http/errors.js';
import { requireAuth, requireCsrf } from '../http/security.js';
import { ChatService } from '../services/chat.service.js';
import type { ProviderService } from '../services/provider.service.js';

export async function chatRoutes(app: FastifyInstance, ctx: AppContext, providers: ProviderService): Promise<void> {
  const svc = new ChatService(ctx, providers);

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

  app.get('/api/usage', async (req, reply) => {
    const a = requireAuth(req);
    const rows = ctx.db.prepare(`
      SELECT model_id, COUNT(*) AS calls,
             SUM(COALESCE(cost_billed_usd, 0)) AS billed,
             SUM(COALESCE(cost_estimated_usd, 0)) AS estimated,
             SUM(CASE WHEN cost_status = 'unknown' THEN 1 ELSE 0 END) AS unknown,
             SUM(COALESCE(tokens_in, 0)) AS tokens_in,
             SUM(COALESCE(tokens_out, 0)) AS tokens_out
      FROM usage_records WHERE user_id = ? GROUP BY model_id ORDER BY calls DESC LIMIT 100
    `).all(a.userId) as Record<string, unknown>[];

    const total = ctx.db.prepare(`
      SELECT COUNT(*) AS calls,
             SUM(COALESCE(cost_billed_usd,0)) AS billed,
             SUM(COALESCE(cost_estimated_usd,0)) AS estimated,
             SUM(CASE WHEN cost_status='unknown' THEN 1 ELSE 0 END) AS unknown,
             SUM(COALESCE(tokens_in,0)) AS tokens_in,
             SUM(COALESCE(tokens_out,0)) AS tokens_out
      FROM usage_records WHERE user_id = ?
    `).get(a.userId) as Record<string, unknown>;

    return reply.send({
      total: {
        totalCalls: Number(total.calls ?? 0),
        totalCostBilledUsd: Number(total.billed ?? 0),
        totalCostEstimatedUsd: Number(total.estimated ?? 0),
        unknownCostCalls: Number(total.unknown ?? 0),
        tokensIn: Number(total.tokens_in ?? 0),
        tokensOut: Number(total.tokens_out ?? 0),
      },
      byModel: rows.map((r) => ({
        modelId: String(r.model_id ?? 'unknown'),
        calls: Number(r.calls ?? 0),
        billedUsd: Number(r.billed ?? 0),
        estimatedUsd: Number(r.estimated ?? 0),
        unknown: Number(r.unknown ?? 0),
      })),
    });
  });

  void NexusError;
}
