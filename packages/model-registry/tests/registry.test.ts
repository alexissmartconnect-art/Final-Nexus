import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { migrate, openDatabase, type Db } from '@nexus/db';
import type { ModelInfo, ProviderClient } from '@nexus/providers';
import { ModelRegistry } from '../src/index.js';

const stubClient = { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' } as unknown as ProviderClient;

function model(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    provider: 'openrouter',
    externalId: 'acme/model-a',
    name: 'Acme Model A',
    author: 'acme',
    description: null,
    contextLength: 32000,
    maxOutput: 4096,
    pricing: { promptPerMtok: 2, completionPerMtok: 6, isFree: false, tier: 'paid', note: null },
    support: { tools: true, json: true, stream: null, reasoning: null, vision: false, audio: null, video: null, embeddings: null },
    available: true,
    availabilityNote: null,
    inferenceProviders: [],
    ...over,
  };
}

describe('model registry', () => {
  let db: Db;
  let registry: ModelRegistry;

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' });
    migrate(db, join(process.cwd(), 'database/migrations'));
    registry = new ModelRegistry(db);
  });

  it('upserts a catalogue and reports real counts', async () => {
    const res = await registry.syncFrom(stubClient, [
      model(),
      model({ externalId: 'acme/model-free:free', name: 'Acme Free', pricing: { promptPerMtok: 0, completionPerMtok: 0, isFree: true, tier: 'free', note: ':free' } }),
      model({ externalId: 'acme/model-hidden', available: false, availabilityNote: 'not served' }),
    ]);
    expect(res.models).toBe(3);
    expect(res.inserted).toBe(3);
    expect(res.updated).toBe(0);
    expect(res.free).toBe(1);
    expect(res.available).toBe(2);

    const again = await registry.syncFrom(stubClient, [model()]);
    expect(again.updated).toBe(1);
    expect(again.inserted).toBe(0);
  });

  it('keeps unknown capabilities as NULL instead of inventing them', async () => {
    await registry.syncFrom(stubClient, [model()]);
    const m = registry.get('openrouter:acme/model-a')!;
    expect(m.supportsTools).toBe(true);
    expect(m.supportsStream).toBeNull();   // provider did not say
    expect(m.supportsVision).toBe(false);  // provider did say: no
  });

  it('filters by tier, availability and capability', async () => {
    await registry.syncFrom(stubClient, [
      model(),
      model({ externalId: 'acme/free:free', pricing: { promptPerMtok: 0, completionPerMtok: 0, isFree: true, tier: 'free', note: null } }),
      model({ externalId: 'acme/no-tools', support: { tools: false, json: false, stream: null, reasoning: null, vision: null, audio: null, video: null, embeddings: null } }),
      model({ externalId: 'acme/unavailable', available: false }),
    ]);
    expect(registry.list({ pricingTier: 'free' })).toHaveLength(1);
    expect(registry.list({ needsTools: true })).toHaveLength(3); // all but 'no-tools'
    expect(registry.list({ availableOnly: true })).toHaveLength(3);
    expect(registry.list({ search: 'no-tools' })).toHaveLength(1);
  });

  it('splits a canonical id back into provider and external id', () => {
    expect(registry.externalIdOf('huggingface:openai/gpt-oss-120b')).toEqual({
      provider: 'huggingface', externalId: 'openai/gpt-oss-120b',
    });
    expect(() => registry.externalIdOf('bogus')).toThrow(/Malformed/);
    expect(() => registry.externalIdOf('openai:gpt-4')).toThrow(/Unknown provider/);
  });

  it('counts the catalogue', async () => {
    await registry.syncFrom(stubClient, [model(), model({ externalId: 'acme/b', available: false })]);
    expect(registry.counts()).toEqual({ total: 2, free: 0, available: 1 });
  });
});
