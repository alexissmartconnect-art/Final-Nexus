import { NexusError, newId, now, type CostBreakdown, type PublicConversation, type PublicMessage, type RoutingMode } from '@nexus/shared';
import type { Db } from '@nexus/db';
import type { ChatMessage } from '@nexus/providers';
import type { AppContext } from '../context.js';
import type { ProviderService } from './provider.service.js';
import { sanitizeUntrusted } from '@nexus/security';

export interface ChatInput {
  conversationId?: string;
  message: string;
  routingMode: RoutingMode;
  modelId?: string;
  stream: boolean;
  projectId?: string;
  agent?: string;
}

export interface ChatOutcome {
  conversationId: string;
  messageId: string;
  modelId: string;
  text: string;
  finishReason: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
  cost: CostBreakdown;
  attempts: { modelId: string; error: string }[];
}

const HISTORY_LIMIT = 20;

interface ConvRow { id: string; title: string | null; mode: string; routing_mode: string; created_at: number; updated_at: number }
interface MsgRow { id: string; role: string; content: string; model_id: string | null; agent: string | null; tokens_in: number | null; tokens_out: number | null; cost_usd: number | null; cost_status: string; created_at: number }

/**
 * Chat orchestration: conversation persistence, model selection, provider call,
 * and honest cost accounting. A cost we did not observe is reported as unknown,
 * never as zero.
 */
export class ChatService {
  constructor(private readonly ctx: AppContext, private readonly providers: ProviderService) {}

  listConversations(userId: string): PublicConversation[] {
    const rows = this.ctx.db
      .prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100')
      .all(userId) as ConvRow[];
    return rows.map((r) => ({
      id: r.id, title: r.title, mode: r.mode, routingMode: r.routing_mode,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  messages(conversationId: string, userId: string): PublicMessage[] {
    const conv = this.ctx.db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId);
    if (!conv) throw new NexusError('not_found', 'Conversation not found');
    const rows = this.ctx.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 500')
      .all(conversationId) as MsgRow[];
    return rows.map((r) => ({
      id: r.id, role: r.role, content: r.content, modelId: r.model_id, agent: r.agent,
      tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd,
      costStatus: r.cost_status, createdAt: r.created_at,
    }));
  }

  /**
   * Choose a model for the requested mode.
   * `free_only` never falls back to a paid model: it fails with an explicit message.
   */
  selectModel(input: ChatInput, userId: string): { modelId: string; externalId: string; provider: 'openrouter' | 'huggingface' } {
    const registry = this.providers.registry;
    if (input.modelId) {
      const found = registry.get(input.modelId);
      if (!found) throw new NexusError('not_found', `Unknown model ${input.modelId}`);
      const { provider, externalId } = registry.externalIdOf(found.id);
      return { modelId: found.id, externalId, provider };
    }

    const freeOnly = input.routingMode === 'free_only' || input.routingMode === 'free_first';
    const candidates = registry.list({ availableOnly: true, limit: 200 });
    if (candidates.length === 0) {
      throw new NexusError('provider_unavailable',
        'No model has been synchronised yet. Open “Gestion des API”, add a key, then synchronise the catalogue.');
    }
    const free = candidates.filter((m) => m.pricingTier === 'free');
    const pool = freeOnly ? free : candidates;
    if (pool.length === 0) {
      if (input.routingMode === 'free_only') {
        throw new NexusError('budget_exceeded',
          'No free model is available in the synchronised catalogue. Switch routing mode or synchronise a provider that offers free models.');
      }
      throw new NexusError('provider_unavailable', 'No model matched the requested routing mode.');
    }
    const picked = pool[0]!;
    const { provider, externalId } = registry.externalIdOf(picked.id);
    void userId;
    return { modelId: picked.id, externalId, provider };
  }

  async send(
    userId: string,
    input: ChatInput,
    sink: { onDelta?: (text: string) => void; onMeta?: (meta: Record<string, unknown>) => void } = {},
  ): Promise<ChatOutcome> {
    const db: Db = this.ctx.db;
    const conversationId = input.conversationId ?? this.createConversation(userId, input);
    const cleanMessage = sanitizeUntrusted(input.message);

    this.insertMessage(db, conversationId, { role: 'user', content: cleanMessage });
    this.touchConversation(db, conversationId, cleanMessage);

    const history = this.loadHistory(db, conversationId);
    const primary = this.selectModel(input, userId);
    const attempts: { modelId: string; error: string }[] = [];

    const chain = this.buildFallbackChain(primary, input);
    let lastError: unknown = null;

    for (const choice of chain) {
      try {
        const client = this.providers.clientFor(userId, choice.provider);
        const result = input.stream
          ? await client.chatStream(
              { model: choice.externalId, messages: history, temperature: 0.7, maxTokens: 1024 },
              (c) => { if (c.text) sink.onDelta?.(c.text); },
            )
          : await client.chat({ model: choice.externalId, messages: history, temperature: 0.7, maxTokens: 1024 });

        const cost = costBreakdown(result.usage.billedCostUsd, result.usage.promptTokens, result.usage.completionTokens, choice.modelId, this.providers);
        const messageId = this.insertMessage(db, conversationId, {
          role: 'assistant', content: result.text, modelId: choice.modelId, agent: input.agent ?? null,
          tokensIn: result.usage.promptTokens, tokensOut: result.usage.completionTokens,
          costUsd: cost.status === 'billed' ? cost.billedUsd : cost.estimatedUsd, costStatus: cost.status,
        });
        this.recordUsage(db, {
          userId, provider: choice.provider, modelId: choice.modelId, conversationId,
          tokensIn: result.usage.promptTokens, tokensOut: result.usage.completionTokens,
          billed: cost.billedUsd, estimated: cost.estimatedUsd, status: cost.status,
          latencyMs: result.latencyMs, status2: 'ok',
        });
        sink.onMeta?.({ modelId: choice.modelId, cost, usage: result.usage, attempts });

        return {
          conversationId, messageId, modelId: choice.modelId, text: result.text,
          finishReason: result.finishReason,
          tokensIn: result.usage.promptTokens, tokensOut: result.usage.completionTokens,
          latencyMs: result.latencyMs, cost, attempts,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        attempts.push({ modelId: choice.modelId, error: message });
        lastError = err;
        this.recordUsage(db, {
          userId, provider: choice.provider, modelId: choice.modelId, conversationId,
          tokensIn: null, tokensOut: null, billed: null, estimated: null, status: 'unknown',
          latencyMs: null, status2: 'error',
        });
        this.ctx.audit.log({ userId, action: 'chat.fallback', outcome: 'error', detail: { modelId: choice.modelId, message } });
        // An auth or configuration problem will not be fixed by another model.
        if (err instanceof NexusError && (err.code === 'unauthorized' || err.code === 'provider_unavailable')) break;
      }
    }
    throw lastError instanceof NexusError ? lastError : new NexusError('provider_error', 'All model attempts failed');
  }

  /** free_only must not silently fall back to a paid model. */
  private buildFallbackChain(primary: ReturnType<ChatService['selectModel']>, input: ChatInput) {
    if (input.routingMode === 'free_only' || input.modelId) return [primary];
    const others = this.providers.registry.list({ availableOnly: true, limit: 5 })
      .filter((m) => m.id !== primary.modelId)
      .map((m) => {
        const { provider, externalId } = this.providers.registry.externalIdOf(m.id);
        return { modelId: m.id, externalId, provider };
      });
    return [primary, ...others.slice(0, 2)];
  }

  private createConversation(userId: string, input: ChatInput): string {
    const id = newId('cnv');
    const t = now();
    this.ctx.db.prepare(
      `INSERT INTO conversations (id, user_id, title, project_id, mode, routing_mode, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'chat', ?, ?, ?)`,
    ).run(id, userId, input.projectId ?? null, input.routingMode, t, t);
    return id;
  }

  private touchConversation(db: Db, id: string, firstMessage: string): void {
    const row = db.prepare('SELECT title FROM conversations WHERE id = ?').get(id) as { title: string | null } | undefined;
    const title = row?.title ?? firstMessage.slice(0, 80);
    db.prepare('UPDATE conversations SET title = COALESCE(title, ?), updated_at = ? WHERE id = ?').run(title, now(), id);
  }

  private insertMessage(
    db: Db, conversationId: string,
    m: { role: string; content: string; modelId?: string | null; agent?: string | null;
         tokensIn?: number | null; tokensOut?: number | null; costUsd?: number | null; costStatus?: string },
  ): string {
    const id = newId('msg');
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, model_id, agent, tokens_in, tokens_out, cost_usd, cost_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, conversationId, m.role, m.content, m.modelId ?? null, m.agent ?? null,
      m.tokensIn ?? null, m.tokensOut ?? null, m.costUsd ?? null, m.costStatus ?? 'unknown', now());
    return id;
  }

  private loadHistory(db: Db, conversationId: string): ChatMessage[] {
    const rows = db.prepare(
      `SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(conversationId, HISTORY_LIMIT) as { role: string; content: string }[];
    return rows.reverse().map((r) => ({
      role: (r.role === 'assistant' ? 'assistant' : r.role === 'system' ? 'system' : 'user') as ChatMessage['role'],
      content: r.content,
    }));
  }

  private recordUsage(db: Db, u: {
    userId: string; provider: string; modelId: string; conversationId: string;
    tokensIn: number | null; tokensOut: number | null; billed: number | null; estimated: number | null;
    status: string; latencyMs: number | null; status2: string;
  }): void {
    db.prepare(
      `INSERT INTO usage_records (id, user_id, provider_id, model_id, conversation_id, kind,
        tokens_in, tokens_out, cost_estimated_usd, cost_billed_usd, cost_status, latency_ms, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'completion', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId('usg'), u.userId, u.provider, u.modelId, u.conversationId, u.tokensIn, u.tokensOut,
      u.estimated, u.billed, u.status, u.latencyMs, u.status2, now());
  }
}

function costBreakdown(
  billed: number | null, promptTokens: number | null, completionTokens: number | null,
  modelId: string, providers: ProviderService,
): CostBreakdown {
  if (billed !== null) {
    return { estimatedUsd: null, billedUsd: billed, status: 'billed', note: 'Reported by the provider (usage.cost).' };
  }
  const model = providers.registry.get(modelId);
  if (model?.pricingTier === 'free') {
    return { estimatedUsd: 0, billedUsd: null, status: 'free', note: 'Model is published as free; no charge expected.' };
  }
  if (model && model.promptPerMtok !== null && model.completionPerMtok !== null && promptTokens !== null && completionTokens !== null) {
    const est = (promptTokens / 1_000_000) * model.promptPerMtok + (completionTokens / 1_000_000) * model.completionPerMtok;
    return { estimatedUsd: est, billedUsd: null, status: 'estimated', note: 'Computed from catalogue prices; the provider did not report a cost.' };
  }
  return {
    estimatedUsd: null, billedUsd: null, status: 'unknown',
    note: 'The provider returned neither a cost nor enough pricing data. Unknown is not zero.',
  };
}
