import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '@nexus/db';
import { NexusError, type PublicModel } from '@nexus/shared';
import { CostEngine, estimateTokens } from '../src/index.js';

const USER = 'usr_test';

function model(over: Partial<PublicModel> = {}): PublicModel {
  return {
    id: 'openrouter:acme/m', provider: 'openrouter', externalId: 'acme/m', name: 'Acme',
    contextLength: 32000, supportsTools: true, supportsJson: true, supportsStream: null,
    supportsVision: false, pricingTier: 'paid', promptPerMtok: 3, completionPerMtok: 15,
    isAvailable: true, availabilityNote: null, syncedAt: 0, ...over,
  };
}

describe('cost engine', () => {
  let db: Db;
  let cost: CostEngine;

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' });
    migrate(db, join(process.cwd(), 'database/migrations'));
    cost = new CostEngine(db);
    db.prepare(`INSERT INTO users (id, email, display_name, password_hash, role, status, prefs_json, created_at, updated_at)
                VALUES (?, 'a@b.c', 'A', 'x', 'admin', 'active', '{}', 1, 1)`).run(USER);
  });

  it('estimates tokens deterministically', () => {
    expect(estimateTokens('')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('computes an estimate from catalogue prices', () => {
    const est = cost.estimate(model(), 1000, 500);
    expect(est.status).toBe('estimated');
    // 1000 tok * 3 $/Mtok + 500 tok * 15 $/Mtok = 0.003 + 0.0075
    expect(est.usd).toBeCloseTo(0.0105, 9);
  });

  it('reports a free model as free', () => {
    const est = cost.estimate(model({ pricingTier: 'free', promptPerMtok: 0, completionPerMtok: 0 }), 1000, 500);
    expect(est.status).toBe('free');
    expect(est.usd).toBe(0);
  });

  it('never turns an unknown price into zero', () => {
    const est = cost.estimate(model({ pricingTier: 'unknown', promptPerMtok: null, completionPerMtok: null }), 1000, 500);
    expect(est.status).toBe('unknown');
    expect(est.usd).toBeNull();
  });

  it('allows anything when no policy exists', () => {
    const d = cost.decide({ userId: USER, estimate: cost.estimate(model(), 100, 100), modelTier: 'paid' });
    expect(d.allowed).toBe(true);
    expect(d.policyId).toBeNull();
  });

  it('blocks a paid model under a free-only policy and proposes an alternative', () => {
    cost.upsertPolicy(USER, { limitUsd: 1, freeOnly: true });
    const d = cost.decide({ userId: USER, estimate: cost.estimate(model(), 100, 100), modelTier: 'paid' });
    expect(d.allowed).toBe(false);
    expect(d.alternative).toMatch(/free model/i);
  });

  it('blocks an unknown cost under a free-only policy instead of assuming zero', () => {
    cost.upsertPolicy(USER, { limitUsd: 1, freeOnly: true });
    const est = cost.estimate(model({ pricingTier: 'unknown', promptPerMtok: null, completionPerMtok: null }), 100, 100);
    const d = cost.decide({ userId: USER, estimate: est, modelTier: 'unknown' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/unknown cost cannot be treated as free/i);
  });

  it('blocks a paid model when paid spend is not allowed', () => {
    cost.upsertPolicy(USER, { limitUsd: 10, allowPaid: false });
    const d = cost.decide({ userId: USER, estimate: cost.estimate(model(), 100, 100), modelTier: 'paid' });
    expect(d.allowed).toBe(false);
  });

  it('blocks when the reservation would cross the limit', () => {
    cost.upsertPolicy(USER, { limitUsd: 0.01, allowPaid: true });
    const est = cost.estimate(model(), 10_000, 10_000); // 0.03 + 0.15 = 0.18 USD
    const d = cost.decide({ userId: USER, estimate: est, modelTier: 'paid' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/Budget exceeded/);
  });

  it('warns instead of blocking when action_on_exceed is warn', () => {
    cost.upsertPolicy(USER, { limitUsd: 0.01, allowPaid: true, actionOnExceed: 'warn' });
    const d = cost.decide({ userId: USER, estimate: cost.estimate(model(), 10_000, 10_000), modelTier: 'paid' });
    expect(d.allowed).toBe(true);
    expect(d.reason).toMatch(/Budget warning/);
  });

  it('reserve() throws a 402 budget_exceeded NexusError', () => {
    cost.upsertPolicy(USER, { limitUsd: 0.001, allowPaid: true });
    try {
      cost.reserve({ userId: USER, estimate: cost.estimate(model(), 10_000, 10_000), modelTier: 'paid' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(NexusError);
      expect((e as NexusError).code).toBe('budget_exceeded');
      expect((e as NexusError).status).toBe(402);
      expect((e as NexusError).details).toMatchObject({ alternative: expect.any(String) });
    }
  });

  it('never blocks a genuinely free call because of a USD ceiling', () => {
    cost.upsertPolicy(USER, { limitUsd: 0, allowPaid: true });
    // Spend already over the limit, yet the free model must still be usable.
    cost.upsertPolicy(USER, { limitUsd: 0, allowPaid: true });
    db.prepare(`UPDATE budget_policies SET spent_usd = 5 WHERE user_id = ?`).run(USER);
    const est = cost.estimate(model({ pricingTier: 'free', promptPerMtok: 0, completionPerMtok: 0 }), 1000, 500);
    const d = cost.decide({ userId: USER, estimate: est, modelTier: 'free' });
    expect(d.allowed).toBe(true);
    expect(d.reason).toMatch(/free; the spend limit does not apply/i);
    // and reserve() must not throw nor move the counter
    expect(() => cost.reserve({ userId: USER, estimate: est, modelTier: 'free' })).not.toThrow();
    expect(cost.policyFor(USER, 'account')!.spentUsd).toBe(5);
  });

  it('reserves then reconciles with the provider-reported cost', () => {
    cost.upsertPolicy(USER, { limitUsd: 1, allowPaid: true });
    const est = cost.estimate(model(), 1000, 1000); // 0.003 + 0.015 = 0.018
    cost.reserve({ userId: USER, estimate: est, modelTier: 'paid' });
    expect(cost.policyFor(USER, 'account')!.spentUsd).toBeCloseTo(0.018, 9);

    cost.settle({ userId: USER, reservedUsd: est.usd, billedUsd: 0.030 });
    expect(cost.policyFor(USER, 'account')!.spentUsd).toBeCloseTo(0.030, 9);
  });

  it('keeps the reservation when the provider reports no cost', () => {
    cost.upsertPolicy(USER, { limitUsd: 1, allowPaid: true });
    const est = cost.estimate(model(), 1000, 1000);
    cost.reserve({ userId: USER, estimate: est, modelTier: 'paid' });
    cost.settle({ userId: USER, reservedUsd: est.usd, billedUsd: null });
    expect(cost.policyFor(USER, 'account')!.spentUsd).toBeCloseTo(0.018, 9);
  });

  it('never lets spend go negative after reconciliation', () => {
    cost.upsertPolicy(USER, { limitUsd: 1, allowPaid: true });
    const est = cost.estimate(model(), 1000, 1000);
    cost.reserve({ userId: USER, estimate: est, modelTier: 'paid' });
    cost.settle({ userId: USER, reservedUsd: est.usd, billedUsd: 0 });
    expect(cost.policyFor(USER, 'account')!.spentUsd).toBe(0);
  });

  it('upserts a policy instead of duplicating it', () => {
    cost.upsertPolicy(USER, { limitUsd: 1 });
    cost.upsertPolicy(USER, { limitUsd: 5 });
    const list = cost.listPolicies(USER);
    expect(list).toHaveLength(1);
    expect(list[0]!.limitUsd).toBe(5);
    expect(list[0]!.remainingUsd).toBe(5);
  });

  it('summarises usage and keeps unknown-cost calls visible', () => {
    const t = Date.now();
    db.prepare(`INSERT INTO usage_records (id,user_id,model_id,kind,cost_billed_usd,cost_estimated_usd,cost_status,tokens_in,tokens_out,status,created_at)
                VALUES ('u1',?,'m1','completion',0.01,NULL,'billed',100,50,'ok',?)`).run(USER, t);
    db.prepare(`INSERT INTO usage_records (id,user_id,model_id,kind,cost_billed_usd,cost_estimated_usd,cost_status,tokens_in,tokens_out,status,created_at)
                VALUES ('u2',?,'m1','completion',NULL,NULL,'unknown',10,5,'ok',?)`).run(USER, t);
    const s = cost.summary(USER);
    expect(s.totalCalls).toBe(2);
    expect(s.totalCostBilledUsd).toBeCloseTo(0.01, 9);
    expect(s.unknownCostCalls).toBe(1);
    expect(s.byModel).toHaveLength(1);
    expect(s.byDay).toHaveLength(1);
  });
});
