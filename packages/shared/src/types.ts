export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  createdAt: number;
  prefs: Record<string, unknown>;
}

export interface PublicConversation {
  id: string;
  title: string | null;
  mode: string;
  routingMode: string;
  createdAt: number;
  updatedAt: number;
}

export interface PublicMessage {
  id: string;
  role: string;
  content: string;
  modelId: string | null;
  agent: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  costStatus: string;
  createdAt: number;
}

export type PricingTier = 'free' | 'promo_credit' | 'paid' | 'unknown';

export interface PublicModel {
  id: string;
  provider: string;
  externalId: string;
  name: string;
  contextLength: number | null;
  supportsTools: boolean | null;
  supportsJson: boolean | null;
  supportsStream: boolean | null;
  supportsVision: boolean | null;
  pricingTier: PricingTier;
  promptPerMtok: number | null;
  completionPerMtok: number | null;
  isAvailable: boolean;
  availabilityNote: string | null;
  syncedAt: number;
}

export interface ProviderHealth {
  provider: string;
  configured: boolean;
  reachable: boolean | null;
  checkedAt: number | null;
  detail: string | null;
  keyInfo: Record<string, unknown> | null;
}

export interface UsageSummary {
  totalCalls: number;
  totalCostBilledUsd: number;
  totalCostEstimatedUsd: number;
  unknownCostCalls: number;
  tokensIn: number;
  tokensOut: number;
  byModel: { modelId: string; calls: number; billedUsd: number; estimatedUsd: number; unknown: number }[];
  byDay: { day: string; calls: number; usd: number }[];
}

export interface CostBreakdown {
  estimatedUsd: number | null;
  billedUsd: number | null;
  status: 'free' | 'estimated' | 'billed' | 'unknown';
  note: string;
}
