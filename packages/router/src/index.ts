import type { PublicModel, RoutingMode } from '@nexus/shared';
import { estimateTokens, type CostEstimate, type CostEngine, type SpendDecision } from '@nexus/finops';

export type TaskKind =
  | 'chat' | 'code' | 'analysis' | 'summarization' | 'translation'
  | 'structured_output' | 'tool_use' | 'vision' | 'reasoning';

export interface RouteRequest {
  mode: RoutingMode;
  task: TaskKind;
  prompt: string;
  /** Estimated tokens the answer needs. Defaults to 512. */
  maxOutputTokens?: number;
  needs?: { tools?: boolean; json?: boolean; vision?: boolean; reasoning?: boolean };
  /** `no_training` rejects providers that may retain prompts. */
  privacy?: 'any' | 'no_training';
  preferredModelId?: string;
  /** Hard minimum context the call needs (prompt + output). */
  minContext?: number;
  /** Number of alternatives kept in the fallback chain. */
  chainLength?: number;
}

export interface RouteCandidate {
  model: PublicModel;
  score: number;
  estimate: CostEstimate;
  reasons: string[];
}

export interface RouteRejection {
  modelId: string;
  reason: string;
}

export interface RouteDecision {
  mode: RoutingMode;
  task: TaskKind;
  chosen: RouteCandidate | null;
  chain: RouteCandidate[];
  rejected: RouteRejection[];
  estimate: CostEstimate | null;
  spend: SpendDecision | null;
  /** Human-readable trace of the selection, shown in the UI. */
  explanation: string[];
}

/** What each task kind strictly requires from a model. */
export function requiredCapabilities(task: TaskKind, extra: RouteRequest['needs'] = {}): {
  tools: boolean; json: boolean; vision: boolean; reasoning: boolean;
} {
  const base = { tools: false, json: false, vision: false, reasoning: false };
  switch (task) {
    case 'tool_use': base.tools = true; break;
    case 'structured_output': base.json = true; break;
    case 'vision': base.vision = true; break;
    case 'reasoning': base.reasoning = true; break;
    default: break;
  }
  return {
    tools: base.tools || extra.tools === true,
    json: base.json || extra.json === true,
    vision: base.vision || extra.vision === true,
    reasoning: base.reasoning || extra.reasoning === true,
  };
}

const MODE_LABEL: Record<RoutingMode, string> = {
  free_only: 'Gratuit uniquement',
  free_first: 'Gratuit prioritaire',
  economic: 'Économique',
  balanced: 'Équilibré',
  quality: 'Qualité maximale',
  speed: 'Vitesse maximale',
  manual: 'Manuel',
  multi: 'Multi-IA',
};

/**
 * Smart Router (spec 7). Selection follows the documented pipeline:
 * task type -> required capabilities -> context estimate -> incompatible models out
 * -> privacy -> availability -> cost estimate -> budget -> ranking -> selection.
 *
 * Every rejection keeps its reason, so "no model available" is never a black box.
 */
export class SmartRouter {
  constructor(private readonly cost: CostEngine) {}

  select(models: PublicModel[], request: RouteRequest, ctx: {
    userId: string; scope?: 'account' | 'project' | 'agent'; scopeId?: string;
  }): RouteDecision {
    const explanation: string[] = [];
    const needs = requiredCapabilities(request.task, request.needs);
    const tokensIn = estimateTokens(request.prompt);
    const tokensOut = request.maxOutputTokens ?? 512;
    const minContext = request.minContext ?? tokensIn + tokensOut;

    explanation.push(`Tâche : ${request.task}. Mode : ${MODE_LABEL[request.mode]}.`);
    explanation.push(`Contexte estimé : ${tokensIn} tokens en entrée, ${tokensOut} en sortie (minimum requis ${minContext}).`);
    const needList = Object.entries(needs).filter(([, v]) => v).map(([k]) => k);
    if (needList.length) explanation.push(`Capacités obligatoires : ${needList.join(', ')}.`);

    const rejected: RouteRejection[] = [];
    const survivors: PublicModel[] = [];

    for (const m of models) {
      const why = this.hardFilter(m, needs, minContext, request);
      if (why) { rejected.push({ modelId: m.id, reason: why }); continue; }
      survivors.push(m);
    }
    explanation.push(`${survivors.length} modèle(s) compatible(s) sur ${models.length}.`);

    if (request.mode === 'manual') {
      const picked = request.preferredModelId ? survivors.find((m) => m.id === request.preferredModelId) : null;
      if (request.preferredModelId && !picked) {
        rejected.push({ modelId: request.preferredModelId, reason: 'Preferred model is not compatible with this request.' });
      }
      const chain = picked ? [this.toCandidate(picked, tokensIn, tokensOut)] : [];
      return this.finish(request, chain, rejected, explanation, ctx);
    }

    // free_only must never see a paid model at all.
    const pool = request.mode === 'free_only' || request.mode === 'free_first'
      ? survivors.filter((m) => m.pricingTier === 'free')
      : survivors;

    if (request.mode === 'free_only' && pool.length === 0 && survivors.length > 0) {
      explanation.push('Mode « gratuit uniquement » : les modèles payants compatibles ont été écartés.');
    }

    const scored = (pool.length ? pool : request.mode === 'free_first' ? survivors : [])
      .map((m) => this.toCandidate(m, tokensIn, tokensOut))
      .map((c) => ({ ...c, score: this.score(c, request.mode) }))
      .sort((a, b) => b.score - a.score);

    const chainLength = request.chainLength ?? 3;
    const chain = scored.slice(0, Math.max(1, chainLength));
    if (chain.length > 0) {
      explanation.push(`Sélection : ${chain[0]!.model.name} (score ${chain[0]!.score.toFixed(2)}).`);
      if (chain.length > 1) explanation.push(`Repli prévu sur : ${chain.slice(1).map((c) => c.model.name).join(', ')}.`);
    }
    return this.finish(request, chain, rejected, explanation, ctx);
  }

  /** Explain a single model without selecting anything (used by the UI and tests). */
  explain(model: PublicModel, request: RouteRequest): string {
    const needs = requiredCapabilities(request.task, request.needs);
    const tokensIn = estimateTokens(request.prompt);
    const tokensOut = request.maxOutputTokens ?? 512;
    const why = this.hardFilter(model, needs, request.minContext ?? tokensIn + tokensOut, request);
    if (why) return why;
    const est = this.cost.estimate(model, tokensIn, tokensOut);
    return `Compatible. Coût ${est.status}${est.usd !== null ? ` ${est.usd.toExponential(3)} USD` : ''}.`;
  }

  private hardFilter(
    m: PublicModel,
    needs: { tools: boolean; json: boolean; vision: boolean; reasoning: boolean },
    minContext: number,
    request: RouteRequest,
  ): string | null {
    if (request.mode === 'manual' && request.preferredModelId && m.id !== request.preferredModelId) {
      return 'Not the manually selected model.';
    }
    if (!m.isAvailable) return 'Not available through the provider inference API.';
    if (needs.tools && m.supportsTools === false) return 'Tool calling not supported.';
    if (needs.json && m.supportsJson === false) return 'Structured JSON output not supported.';
    if (needs.vision && m.supportsVision !== true) return 'Vision not supported.';
    if (m.contextLength !== null && m.contextLength < minContext) {
      return `Context ${m.contextLength} < required ${minContext}.`;
    }
    if (request.privacy === 'no_training' && m.provider === 'huggingface') {
      // Hugging Face Inference Providers route to third-party providers whose data
      // policies vary; without a verified policy we refuse rather than assume.
      return 'Data policy not verified for this provider under the "no training" constraint.';
    }
    return null;
  }

  private toCandidate(m: PublicModel, tokensIn: number, tokensOut: number): RouteCandidate {
    const estimate = this.cost.estimate(m, tokensIn, tokensOut);
    const reasons: string[] = [];
    if (m.pricingTier === 'free') reasons.push('free');
    if (m.supportsTools) reasons.push('tools');
    if (m.supportsJson) reasons.push('json');
    if (m.supportsVision) reasons.push('vision');
    if (m.contextLength) reasons.push(`${Math.round(m.contextLength / 1000)}k context`);
    if (estimate.status === 'unknown') reasons.push('price unknown');
    return { model: m, score: 0, estimate, reasons };
  }

  /** Quality proxy from published facts only. No latency data exists, so `speed` uses context size as a documented heuristic. */
  private score(c: RouteCandidate, mode: RoutingMode): number {
    const m = c.model;
    const ctx = m.contextLength ?? 0;
    const quality =
      Math.log10(Math.max(ctx, 1)) * 0.6 +
      (m.supportsTools === true ? 0.5 : 0) +
      (m.supportsJson === true ? 0.2 : 0) +
      (m.supportsVision === true ? 0.3 : 0);
    const price = c.estimate.usd === null ? 0.5 : c.estimate.usd === 0 ? 1 : 1 / (1 + c.estimate.usd * 100_000);

    switch (mode) {
      case 'free_only':
      case 'quality':
        return quality;
      case 'free_first':
        return quality + (m.pricingTier === 'free' ? 5 : 0);
      case 'economic':
        return price * 2 + quality * 0.2;
      case 'balanced':
        return quality * 0.5 + price;
      case 'speed':
        // Heuristic: smaller context windows usually mean smaller, faster models.
        return (ctx === 0 ? 0.5 : 1 / Math.log10(Math.max(ctx, 10))) + (m.pricingTier === 'free' ? 0.2 : 0);
      case 'multi':
        return quality * 0.5 + price;
      default:
        return quality * 0.5 + price;
    }
  }

  private finish(request: RouteRequest, chain: RouteCandidate[], rejected: RouteRejection[], explanation: string[], ctx: {
    userId: string; scope?: 'account' | 'project' | 'agent'; scopeId?: string;
  }): RouteDecision {
    const first = chain[0] ?? null;
    const estimate = first?.estimate ?? null;
    // Recomputed inside the branch: `estimate` was widened to null before narrowing.
    const spend: SpendDecision | null = first
      ? this.cost.decide({ userId: ctx.userId, scope: ctx.scope, scopeId: ctx.scopeId, estimate: first.estimate, modelTier: first.model.pricingTier })
      : null;

    if (spend && !spend.allowed) {
      explanation.push(`Budget : refusé — ${spend.reason}`);
      if (spend.alternative) explanation.push(`Suggestion : ${spend.alternative}`);
    } else if (spend) {
      explanation.push(`Budget : ${spend.reason}`);
    }
    if (!first) explanation.push('Aucun modèle compatible : aucune sélection effectuée.');

    void request;
    return { mode: request.mode, task: request.task, chosen: first, chain, rejected, estimate, spend, explanation };
  }
}
