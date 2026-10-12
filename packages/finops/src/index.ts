import { NexusError, newId, now, type PublicModel, type UsageSummary as SharedUsageSummary } from '@nexus/shared';

export type CostStatus = 'free' | 'estimated' | 'billed' | 'unknown';

export interface CostEstimate {
  tokensIn: number;
  tokensOut: number;
  /** null when the price is not published: unknown is never coerced to zero. */
  usd: number | null;
  status: Exclude<CostStatus, 'billed'>;
  note: string;
}

export interface BudgetPolicyView {
  id: string;
  scope: 'account' | 'project' | 'agent';
  scopeId: string | null;
  limitUsd: number;
  period: 'total' | 'daily' | 'monthly';
  spentUsd: number;
  remainingUsd: number;
  allowPaid: boolean;
  freeOnly: boolean;
  actionOnExceed: 'block' | 'warn';
}

export interface SpendDecision {
  allowed: boolean;
  reason: string;
  policyId: string | null;
  remainingUsd: number | null;
  estimatedUsd: number | null;
  /** Concrete suggestion so a blocked call is actionable, not a dead end. */
  alternative: string | null;
}

export type UsageSummary = SharedUsageSummary;

interface PolicyRow {
  id: string; scope: string; scope_id: string | null; limit_usd: number; period: string;
  spent_usd: number; allow_paid: number; free_only: number; action_on_exceed: string;
}

/** Rough but deterministic token estimate: ~4 characters per token for latin text. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil((text ?? '').length / 4));
}

/**
 * Cost engine (spec 8). Every amount is tracked with its provenance:
 * a price we did not observe is `unknown`, never `0`.
 */
export class CostEngine {
  constructor(private readonly db: import('@nexus/db').Db) {}

  estimate(model: Pick<PublicModel, 'pricingTier' | 'promptPerMtok' | 'completionPerMtok'>, tokensIn: number, tokensOut: number): CostEstimate {
    if (model.pricingTier === 'free') {
      return { tokensIn, tokensOut, usd: 0, status: 'free', note: 'Model published as free.' };
    }
    if (model.promptPerMtok !== null && model.completionPerMtok !== null) {
      const usd = (tokensIn / 1_000_000) * model.promptPerMtok + (tokensOut / 1_000_000) * model.completionPerMtok;
      return { tokensIn, tokensOut, usd, status: 'estimated', note: 'Computed from catalogue prices.' };
    }
    return {
      tokensIn, tokensOut, usd: null, status: 'unknown',
      note: 'The provider publishes no price for this model. Unknown cost is not free.',
    };
  }

  policyFor(userId: string, scope: 'account' | 'project' | 'agent', scopeId?: string): BudgetPolicyView | null {
    const row = scope === 'account'
      ? this.db.prepare(`SELECT * FROM budget_policies WHERE user_id = ? AND scope = 'account' LIMIT 1`).get(userId) as PolicyRow | undefined
      : this.db.prepare(`SELECT * FROM budget_policies WHERE user_id = ? AND scope = ? AND scope_id = ? LIMIT 1`)
          .get(userId, scope, scopeId ?? null) as PolicyRow | undefined;
    return row ? toPolicyView(row) : null;
  }

  upsertPolicy(userId: string, input: {
    scope?: 'account' | 'project' | 'agent'; scopeId?: string | null; limitUsd: number;
    period?: 'total' | 'daily' | 'monthly'; allowPaid?: boolean; freeOnly?: boolean;
    actionOnExceed?: 'block' | 'warn';
  }): BudgetPolicyView {
    const scope = input.scope ?? 'account';
    const scopeId = scope === 'account' ? null : input.scopeId ?? null;
    const existing = this.policyFor(userId, scope, scopeId ?? undefined);
    if (existing) {
      this.db.prepare(
        `UPDATE budget_policies SET limit_usd = ?, period = ?, allow_paid = ?, free_only = ?, action_on_exceed = ?, updated_at = ?
         WHERE id = ?`,
      ).run(input.limitUsd, input.period ?? 'total', input.allowPaid ? 1 : 0, input.freeOnly ? 1 : 0,
        input.actionOnExceed ?? 'block', now(), existing.id);
      return this.policyFor(userId, scope, scopeId ?? undefined)!;
    }
    const id = newId('bdg');
    this.db.prepare(
      `INSERT INTO budget_policies (id, user_id, scope, scope_id, limit_usd, period, spent_usd,
        allow_paid, free_only, action_on_exceed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    ).run(id, userId, scope, scopeId, input.limitUsd, input.period ?? 'total',
      input.allowPaid ? 1 : 0, input.freeOnly ? 1 : 0, input.actionOnExceed ?? 'block', now(), now());
    return this.policyFor(userId, scope, scopeId ?? undefined)!;
  }

  listPolicies(userId: string): BudgetPolicyView[] {
    const rows = this.db.prepare('SELECT * FROM budget_policies WHERE user_id = ? ORDER BY scope, limit_usd').all(userId) as PolicyRow[];
    return rows.map(toPolicyView);
  }

  /**
   * Decide whether a call may proceed. Pure decision: it does not mutate the budget.
   * `reserve` applies it.
   */
  decide(params: {
    userId: string; scope?: 'account' | 'project' | 'agent'; scopeId?: string;
    estimate: CostEstimate; modelTier: string;
  }): SpendDecision {
    const scope = params.scope ?? 'account';
    const policy = this.policyFor(params.userId, scope, params.scopeId);
    const est = params.estimate;

    if (!policy) {
      return {
        allowed: true, reason: 'No budget policy configured.', policyId: null,
        remainingUsd: null, estimatedUsd: est.usd, alternative: null,
      };
    }

    if (policy.freeOnly && params.modelTier !== 'free') {
      return {
        allowed: false,
        reason: est.status === 'unknown'
          ? 'Policy is "free only" and this model has no published price; an unknown cost cannot be treated as free.'
          : 'Policy is "free only" and this model is not free.',
        policyId: policy.id, remainingUsd: policy.remainingUsd, estimatedUsd: est.usd,
        alternative: 'Switch to a free model, or allow paid models in the budget policy.',
      };
    }

    if (!policy.allowPaid && params.modelTier === 'paid') {
      return {
        allowed: false, reason: 'Paid models are disabled by the budget policy.',
        policyId: policy.id, remainingUsd: policy.remainingUsd, estimatedUsd: est.usd,
        alternative: 'Enable "allow paid models" or pick a free model.',
      };
    }

    // A genuinely free call consumes no money, so a USD ceiling cannot block it.
    // Free models are a separate category from paid ones (spec 8).
    if (est.status === 'free' && est.usd === 0) {
      return {
        allowed: true, reason: 'Model is free; the spend limit does not apply.',
        policyId: policy.id, remainingUsd: policy.remainingUsd, estimatedUsd: 0, alternative: null,
      };
    }

    if (est.usd === null) {
      // Unknown cost: allowed only when the policy explicitly permits paid spend.
      const allowed = policy.allowPaid;
      return {
        allowed,
        reason: allowed
          ? 'Cost is unknown; allowed because the policy permits paid spend.'
          : 'Cost is unknown and the policy does not permit paid spend.',
        policyId: policy.id, remainingUsd: policy.remainingUsd, estimatedUsd: null,
        alternative: allowed ? null : 'Choose a model with a published price, or allow paid spend.',
      };
    }

    if (policy.spentUsd + est.usd > policy.limitUsd) {
      const allowed = policy.actionOnExceed === 'warn';
      return {
        allowed,
        reason: `Budget ${allowed ? 'warning' : 'exceeded'}: ${fmt(policy.spentUsd)} spent + ${fmt(est.usd)} estimated > ${fmt(policy.limitUsd)} limit.`,
        policyId: policy.id, remainingUsd: policy.remainingUsd, estimatedUsd: est.usd,
        alternative: allowed ? null : 'Raise the limit, or pick a cheaper or free model.',
      };
    }

    return {
      allowed: true, reason: 'Within budget.', policyId: policy.id,
      remainingUsd: policy.remainingUsd, estimatedUsd: est.usd, alternative: null,
    };
  }

  /** Apply a reservation. Throws `budget_exceeded` (402) when the decision refuses. */
  reserve(params: {
    userId: string; scope?: 'account' | 'project' | 'agent'; scopeId?: string;
    estimate: CostEstimate; modelTier: string;
  }): SpendDecision {
    const decision = this.decide(params);
    if (!decision.allowed) {
      throw new NexusError('budget_exceeded', decision.reason, {
        status: 402,
        details: { policyId: decision.policyId, remainingUsd: decision.remainingUsd, alternative: decision.alternative },
      });
    }
    if (decision.estimatedUsd !== null && decision.estimatedUsd > 0) {
      this.applySpend(params.userId, params.scope ?? 'account', params.scopeId ?? null, decision.estimatedUsd);
    }
    return decision;
  }

  /**
   * Reconcile the reservation with what actually happened.
   * A provider-reported cost wins over our estimate; if neither exists the spend
   * stays recorded as an estimate and the usage row stays `unknown`.
   */
  settle(params: {
    userId: string; scope?: 'account' | 'project' | 'agent'; scopeId?: string | null;
    reservedUsd: number | null; billedUsd: number | null;
  }): void {
    const actual = params.billedUsd;
    const reserved = params.reservedUsd ?? 0;
    if (actual === null) return;               // nothing observed: keep the reservation
    const delta = actual - reserved;
    if (Math.abs(delta) < 1e-12) return;
    this.applySpend(params.userId, params.scope ?? 'account', params.scopeId ?? null, delta);
  }

  summary(userId: string): UsageSummary {
    const total = this.db.prepare(`
      SELECT COUNT(*) AS calls,
             SUM(COALESCE(cost_billed_usd,0)) AS billed,
             SUM(COALESCE(cost_estimated_usd,0)) AS estimated,
             SUM(CASE WHEN cost_status='unknown' THEN 1 ELSE 0 END) AS unknown,
             SUM(COALESCE(tokens_in,0)) AS tin, SUM(COALESCE(tokens_out,0)) AS tout
      FROM usage_records WHERE user_id = ?`).get(userId) as Record<string, unknown>;

    const byModel = this.db.prepare(`
      SELECT model_id, COUNT(*) AS calls,
             SUM(COALESCE(cost_billed_usd,0)) AS billed,
             SUM(COALESCE(cost_estimated_usd,0)) AS estimated,
             SUM(CASE WHEN cost_status='unknown' THEN 1 ELSE 0 END) AS unknown
      FROM usage_records WHERE user_id = ? GROUP BY model_id ORDER BY calls DESC LIMIT 50
    `).all(userId) as Record<string, unknown>[];

    const byDay = this.db.prepare(`
      SELECT date(created_at/1000, 'unixepoch') AS day, COUNT(*) AS calls,
             SUM(COALESCE(cost_billed_usd, cost_estimated_usd, 0)) AS usd
      FROM usage_records WHERE user_id = ? GROUP BY day ORDER BY day DESC LIMIT 30
    `).all(userId) as Record<string, unknown>[];

    return {
      totalCalls: Number(total.calls ?? 0),
      totalCostBilledUsd: Number(total.billed ?? 0),
      totalCostEstimatedUsd: Number(total.estimated ?? 0),
      unknownCostCalls: Number(total.unknown ?? 0),
      tokensIn: Number(total.tin ?? 0),
      tokensOut: Number(total.tout ?? 0),
      byModel: byModel.map((r) => ({
        modelId: String(r.model_id ?? 'unknown'), calls: Number(r.calls ?? 0),
        billedUsd: Number(r.billed ?? 0), estimatedUsd: Number(r.estimated ?? 0), unknown: Number(r.unknown ?? 0),
      })),
      byDay: byDay.map((r) => ({ day: String(r.day), calls: Number(r.calls ?? 0), usd: Number(r.usd ?? 0) })),
    };
  }

  private applySpend(userId: string, scope: string, scopeId: string | null, delta: number): void {
    if (scope === 'account') {
      this.db.prepare(`UPDATE budget_policies SET spent_usd = MAX(0, spent_usd + ?), updated_at = ? WHERE user_id = ? AND scope = 'account'`)
        .run(delta, now(), userId);
    } else {
      this.db.prepare(`UPDATE budget_policies SET spent_usd = MAX(0, spent_usd + ?), updated_at = ? WHERE user_id = ? AND scope = ? AND scope_id IS ?`)
        .run(delta, now(), userId, scope, scopeId);
    }
  }
}

function toPolicyView(r: PolicyRow): BudgetPolicyView {
  return {
    id: r.id,
    scope: r.scope as BudgetPolicyView['scope'],
    scopeId: r.scope_id,
    limitUsd: r.limit_usd,
    period: r.period as BudgetPolicyView['period'],
    spentUsd: r.spent_usd,
    remainingUsd: Math.max(0, r.limit_usd - r.spent_usd),
    allowPaid: r.allow_paid === 1,
    freeOnly: r.free_only === 1,
    actionOnExceed: r.action_on_exceed as BudgetPolicyView['actionOnExceed'],
  };
}

export function fmt(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 6 : 4)}`;
}
