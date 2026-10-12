import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '@nexus/db';
import { CostEngine } from '@nexus/finops';
import type { PublicModel } from '@nexus/shared';
import { SmartRouter, requiredCapabilities } from '../src/index.js';

const USER = 'usr_router';

function model(id: string, over: Partial<PublicModel> = {}): PublicModel {
  return {
    id, provider: id.startsWith('huggingface') ? 'huggingface' : 'openrouter',
    externalId: id.split(':').slice(1).join(':'), name: id, contextLength: 32000,
    supportsTools: false, supportsJson: false, supportsStream: null, supportsVision: false,
    pricingTier: 'paid', promptPerMtok: 3, completionPerMtok: 15,
    isAvailable: true, availabilityNote: null, syncedAt: 0, ...over,
  };
}

const CATALOGUE: PublicModel[] = [
  model('openrouter:acme/paid-smart', { contextLength: 200000, supportsTools: true, supportsJson: true }),
  model('openrouter:acme/free-small:free', { pricingTier: 'free', promptPerMtok: 0, completionPerMtok: 0, contextLength: 8192 }),
  model('openrouter:acme/free-big:free', { pricingTier: 'free', promptPerMtok: 0, completionPerMtok: 0, contextLength: 131072, supportsTools: true }),
  model('openrouter:acme/unpriced', { pricingTier: 'unknown', promptPerMtok: null, completionPerMtok: null }),
  model('openrouter:acme/offline', { isAvailable: false }),
  model('huggingface:hf/vision-model', { supportsVision: true, pricingTier: 'free', promptPerMtok: 0, completionPerMtok: 0 }),
];

const chat = { task: 'chat' as const, prompt: 'Bonjour', mode: 'free_first' as const };

describe('smart router', () => {
  let db: Db;
  let router: SmartRouter;

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' });
    migrate(db, join(process.cwd(), 'database/migrations'));
    db.prepare(`INSERT INTO users (id, email, display_name, password_hash, role, status, prefs_json, created_at, updated_at)
                VALUES (?, 'r@b.c', 'R', 'x', 'user', 'active', '{}', 1, 1)`).run(USER);
    router = new SmartRouter(new CostEngine(db));
  });

  it('maps task kinds to required capabilities', () => {
    expect(requiredCapabilities('tool_use')).toMatchObject({ tools: true });
    expect(requiredCapabilities('structured_output')).toMatchObject({ json: true });
    expect(requiredCapabilities('vision')).toMatchObject({ vision: true });
    expect(requiredCapabilities('chat')).toMatchObject({ tools: false, json: false, vision: false, reasoning: false });
    expect(requiredCapabilities('chat', { tools: true })).toMatchObject({ tools: true });
  });

  it('excludes unavailable models and records why', () => {
    const d = router.select(CATALOGUE, chat, { userId: USER });
    expect(d.rejected.map((r) => r.modelId)).toContain('openrouter:acme/offline');
    expect(d.rejected.find((r) => r.modelId === 'openrouter:acme/offline')!.reason).toMatch(/not available/i);
  });

  it('free_first picks a free model even when a paid one scores higher', () => {
    const d = router.select(CATALOGUE, chat, { userId: USER });
    expect(d.chosen!.model.pricingTier).toBe('free');
    expect(d.chosen!.model.id).toBe('openrouter:acme/free-big:free'); // bigger context among the free ones
  });

  it('free_only never proposes a paid model at all', () => {
    const d = router.select(CATALOGUE, { ...chat, mode: 'free_only' }, { userId: USER });
    for (const c of d.chain) expect(c.model.pricingTier).toBe('free');
    expect(d.chain.length).toBeGreaterThan(0);
  });

  it('free_only yields no selection when nothing free is compatible', () => {
    const onlyPaid = [model('openrouter:a/x'), model('openrouter:a/y')];
    const d = router.select(onlyPaid, { ...chat, mode: 'free_only' }, { userId: USER });
    expect(d.chosen).toBeNull();
    expect(d.explanation.join(' ')).toMatch(/Aucun modèle compatible/);
  });

  it('respects the context requirement', () => {
    const d = router.select(CATALOGUE, { ...chat, prompt: 'x'.repeat(40_000), maxOutputTokens: 4000 }, { userId: USER });
    // 40_000/4 = 10_000 tokens in + 4_000 out = 14_000 required -> the 8k model is out
    expect(d.rejected.find((r) => r.modelId === 'openrouter:acme/free-small:free')?.reason).toMatch(/Context 8192 < required/);
  });

  it('filters by capability: tool_use drops models without tools', () => {
    const d = router.select(CATALOGUE, { ...chat, task: 'tool_use' }, { userId: USER });
    for (const c of d.chain) expect(c.model.supportsTools).toBe(true);
    expect(d.rejected.find((r) => r.modelId === 'openrouter:acme/free-small:free')!.reason).toMatch(/Tool calling/);
  });

  it('filters by capability: vision requires a real yes, not an unknown', () => {
    const d = router.select(CATALOGUE, { ...chat, task: 'vision' }, { userId: USER });
    expect(d.chosen!.model.id).toBe('huggingface:hf/vision-model');
  });

  it('honours the no_training privacy constraint instead of assuming', () => {
    const d = router.select(CATALOGUE, { ...chat, task: 'vision', privacy: 'no_training' }, { userId: USER });
    expect(d.rejected.find((r) => r.modelId === 'huggingface:hf/vision-model')!.reason).toMatch(/Data policy not verified/);
    expect(d.chosen).toBeNull();
  });

  it('manual mode returns only the chosen model', () => {
    const d = router.select(CATALOGUE, { ...chat, mode: 'manual', preferredModelId: 'openrouter:acme/paid-smart' }, { userId: USER });
    expect(d.chain).toHaveLength(1);
    expect(d.chosen!.model.id).toBe('openrouter:acme/paid-smart');
  });

  it('economic mode prefers the cheapest compatible model', () => {
    const d = router.select(CATALOGUE, { ...chat, mode: 'economic' }, { userId: USER });
    expect(d.chosen!.model.pricingTier).toBe('free');
  });

  it('keeps a bounded fallback chain of distinct models', () => {
    const d = router.select(CATALOGUE, { ...chat, chainLength: 3 }, { userId: USER });
    expect(d.chain.length).toBeLessThanOrEqual(3);
    expect(new Set(d.chain.map((c) => c.model.id)).size).toBe(d.chain.length);
  });

  it('produces a human-readable explanation', () => {
    const d = router.select(CATALOGUE, chat, { userId: USER });
    expect(d.explanation.length).toBeGreaterThanOrEqual(3);
    expect(d.explanation.join(' ')).toMatch(/Sélection :/);
  });

  it('refuses the call when the budget says no, and says why', () => {
    const cost = new CostEngine(db);
    cost.upsertPolicy(USER, { limitUsd: 1, freeOnly: true });
    const r = new SmartRouter(cost);
    const d = r.select([model('openrouter:a/paid')], { ...chat, mode: 'economic' }, { userId: USER });
    expect(d.spend!.allowed).toBe(false);
    expect(d.explanation.join(' ')).toMatch(/Budget : refusé/);
    expect(d.spend!.alternative).toMatch(/free model/i);
  });

  it('blocks an unpriced model under a free-only policy', () => {
    const cost = new CostEngine(db);
    cost.upsertPolicy(USER, { limitUsd: 1, freeOnly: true });
    const r = new SmartRouter(cost);
    const d = r.select([model('openrouter:a/unpriced', { pricingTier: 'unknown', promptPerMtok: null, completionPerMtok: null })],
      { ...chat, mode: 'economic' }, { userId: USER });
    expect(d.spend!.allowed).toBe(false);
  });

  it('explain() reports the reason a single model is rejected', () => {
    const reason = router.explain(model('openrouter:a/off', { isAvailable: false }), chat);
    expect(reason).toMatch(/not available/i);
  });
});
