import type { Db } from '@nexus/db';
import { newId, NexusError, now, type PublicModel } from '@nexus/shared';
import type { ModelInfo, ProviderClient, ProviderId } from '@nexus/providers';

export interface SyncResult {
  provider: ProviderId;
  models: number;
  inserted: number;
  updated: number;
  free: number;
  available: number;
  durationMs: number;
  error: string | null;
}

export interface ListFilters {
  provider?: ProviderId;
  pricingTier?: 'free' | 'paid' | 'unknown';
  availableOnly?: boolean;
  needsTools?: boolean;
  needsJson?: boolean;
  needsVision?: boolean;
  minContext?: number;
  search?: string;
  limit?: number;
}

const PROVIDER_LABEL: Record<ProviderId, string> = {
  openrouter: 'OpenRouter',
  huggingface: 'Hugging Face',
};

/**
 * Unified model registry (spec 6): one row per model per provider, with unknown
 * values kept as NULL. Nothing is guessed: if a provider does not publish a
 * capability or a price, the column stays null and the UI says "unknown".
 */
export class ModelRegistry {
  constructor(private readonly db: Db) {}

  ensureProvider(id: ProviderId, baseUrl: string): void {
    const t = now();
    this.db.prepare(
      `INSERT INTO providers (id, display_name, base_url, capabilities_json, enabled, created_at, updated_at)
       VALUES (?, ?, ?, '{}', 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET base_url = excluded.base_url, updated_at = excluded.updated_at`,
    ).run(id, PROVIDER_LABEL[id], baseUrl, t, t);
  }

  markSynced(id: ProviderId, error: string | null): void {
    this.db.prepare('UPDATE providers SET last_sync_at = ?, last_sync_error = ?, updated_at = ? WHERE id = ?')
      .run(now(), error, now(), id);
  }

  /** Pull a catalogue from a provider client and upsert it. Returns real counts. */
  async syncFrom(client: ProviderClient, models: ModelInfo[]): Promise<SyncResult> {
    const started = Date.now();
    let inserted = 0;
    let updated = 0;
    let free = 0;
    let available = 0;

    this.ensureProvider(client.id, client.baseUrl);

    const upsertModel = this.db.prepare(`
      INSERT INTO models (
        id, provider_id, external_id, name, author, license, description, context_length, max_output,
        modality_json, supports_tools, supports_json, supports_stream, supports_reasoning,
        supports_vision, supports_audio, supports_video, supports_embeddings,
        pricing_tier, is_available, availability_note, inference_providers_json, raw_json,
        synced_at, created_at, updated_at
      ) VALUES (
        @id, @provider_id, @external_id, @name, @author, @license, @description, @context_length, @max_output,
        @modality_json, @supports_tools, @supports_json, @supports_stream, @supports_reasoning,
        @supports_vision, @supports_audio, @supports_video, @supports_embeddings,
        @pricing_tier, @is_available, @availability_note, @inference_providers_json, @raw_json,
        @synced_at, @created_at, @updated_at
      )
      ON CONFLICT(provider_id, external_id) DO UPDATE SET
        name = excluded.name, author = excluded.author, description = excluded.description,
        context_length = excluded.context_length, max_output = excluded.max_output,
        modality_json = excluded.modality_json,
        supports_tools = excluded.supports_tools, supports_json = excluded.supports_json,
        supports_stream = excluded.supports_stream, supports_reasoning = excluded.supports_reasoning,
        supports_vision = excluded.supports_vision, supports_audio = excluded.supports_audio,
        supports_video = excluded.supports_video, supports_embeddings = excluded.supports_embeddings,
        pricing_tier = excluded.pricing_tier, is_available = excluded.is_available,
        availability_note = excluded.availability_note,
        inference_providers_json = excluded.inference_providers_json,
        raw_json = excluded.raw_json, synced_at = excluded.synced_at, updated_at = excluded.updated_at
    `);

    const existingIds = new Set(
      (this.db.prepare('SELECT id FROM models WHERE provider_id = ?').all(client.id) as { id: string }[])
        .map((r) => r.id),
    );
    const insertPrice = this.db.prepare(`
      INSERT INTO model_prices (id, model_id, currency, prompt_per_mtok, completion_per_mtok, image_per_unit,
                                request_price, is_free, free_quota_json, source, synced_at)
      VALUES (?, ?, 'USD', ?, ?, NULL, NULL, ?, NULL, ?, ?)
    `);
    const deletePrices = this.db.prepare('DELETE FROM model_prices WHERE model_id = ?');

    const run = this.db.transaction(() => {
      const t = now();
      for (const m of models) {
        const id = `${client.id}:${m.externalId}`;
        const tri = (b: boolean | null): number | null => (b === null ? null : b ? 1 : 0);
        upsertModel.run({
          id,
          provider_id: client.id,
          external_id: m.externalId,
          name: m.name,
          author: m.author,
          license: null,
          description: m.description,
          context_length: m.contextLength,
          max_output: m.maxOutput,
          modality_json: '[]',
          supports_tools: tri(m.support.tools),
          supports_json: tri(m.support.json),
          supports_stream: tri(m.support.stream),
          supports_reasoning: tri(m.support.reasoning),
          supports_vision: tri(m.support.vision),
          supports_audio: tri(m.support.audio),
          supports_video: tri(m.support.video),
          supports_embeddings: tri(m.support.embeddings),
          pricing_tier: m.pricing.tier,
          is_available: m.available ? 1 : 0,
          availability_note: m.availabilityNote,
          inference_providers_json: JSON.stringify(m.inferenceProviders),
          raw_json: m.raw === undefined ? null : JSON.stringify(m.raw),
          synced_at: t,
          created_at: t,
          updated_at: t,
        });
        if (existingIds.has(id)) updated += 1; else inserted += 1;
        if (m.pricing.isFree) free += 1;
        if (m.available) available += 1;

        deletePrices.run(id);
        insertPrice.run(newId('prc'), id, m.pricing.promptPerMtok, m.pricing.completionPerMtok,
          m.pricing.isFree ? 1 : 0, 'provider_catalog', t);
      }
    });
    run();

    return {
      provider: client.id, models: models.length, inserted, updated, free, available,
      durationMs: Date.now() - started, error: null,
    };
  }

  list(filters: ListFilters = {}): PublicModel[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filters.provider) { where.push('m.provider_id = @provider'); params.provider = filters.provider; }
    if (filters.pricingTier) { where.push('m.pricing_tier = @tier'); params.tier = filters.pricingTier; }
    if (filters.availableOnly) where.push('m.is_available = 1');
    if (filters.needsTools) where.push('m.supports_tools = 1');
    if (filters.needsJson) where.push('m.supports_json = 1');
    if (filters.needsVision) where.push('m.supports_vision = 1');
    if (filters.minContext !== undefined) { where.push('m.context_length >= @minContext'); params.minContext = filters.minContext; }
    if (filters.search) { where.push('(m.name LIKE @search OR m.external_id LIKE @search)'); params.search = `%${filters.search}%`; }

    const sql = `
      SELECT m.*, p.prompt_per_mtok, p.completion_per_mtok
      FROM models m
      LEFT JOIN model_prices p ON p.model_id = m.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY m.pricing_tier = 'free' DESC, m.is_available DESC, m.name ASC
      LIMIT @limit
    `;
    params.limit = filters.limit ?? 500;
    const rows = this.db.prepare(sql).all(params) as Record<string, unknown>[];
    return rows.map(toPublic);
  }

  get(id: string): PublicModel | null {
    const row = this.db.prepare(`
      SELECT m.*, p.prompt_per_mtok, p.completion_per_mtok
      FROM models m LEFT JOIN model_prices p ON p.model_id = m.id WHERE m.id = ?
    `).get(id) as Record<string, unknown> | undefined;
    return row ? toPublic(row) : null;
  }

  /** Canonical id -> the external id the provider expects on the wire. */
  externalIdOf(id: string): { provider: ProviderId; externalId: string } {
    const idx = id.indexOf(':');
    if (idx <= 0) throw new NexusError('bad_request', `Malformed model id: ${id}`);
    const provider = id.slice(0, idx) as ProviderId;
    if (provider !== 'openrouter' && provider !== 'huggingface') {
      throw new NexusError('bad_request', `Unknown provider in model id: ${provider}`);
    }
    return { provider, externalId: id.slice(idx + 1) };
  }

  counts(): { total: number; free: number; available: number } {
    const q = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      total: q('SELECT COUNT(*) AS n FROM models'),
      free: q("SELECT COUNT(*) AS n FROM models WHERE pricing_tier = 'free'"),
      available: q('SELECT COUNT(*) AS n FROM models WHERE is_available = 1'),
    };
  }
}

function toPublic(r: Record<string, unknown>): PublicModel {
  const b = (v: unknown): boolean | null => (v === null || v === undefined ? null : v === 1 || v === true);
  return {
    id: String(r.id),
    provider: String(r.provider_id),
    externalId: String(r.external_id),
    name: String(r.name),
    contextLength: (r.context_length as number | null) ?? null,
    supportsTools: b(r.supports_tools),
    supportsJson: b(r.supports_json),
    supportsStream: b(r.supports_stream),
    supportsVision: b(r.supports_vision),
    pricingTier: (r.pricing_tier as PublicModel['pricingTier']) ?? 'unknown',
    promptPerMtok: (r.prompt_per_mtok as number | null) ?? null,
    completionPerMtok: (r.completion_per_mtok as number | null) ?? null,
    isAvailable: r.is_available === 1,
    availabilityNote: (r.availability_note as string | null) ?? null,
    syncedAt: Number(r.synced_at),
  };
}
