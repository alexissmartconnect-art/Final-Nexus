import type { PricingTier } from '@nexus/shared';

export type ProviderId = 'openrouter' | 'huggingface';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface ToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  stop?: string[];
  seed?: number;
  responseFormat?: { type: 'json_object' | 'text' };
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  reasoning?: { effort?: 'low' | 'medium' | 'high' };
  /** OpenRouter provider routing; ignored by other providers. */
  providerRouting?: OpenRouterRouting;
}

export interface OpenRouterRouting {
  order?: string[];
  allowFallbacks?: boolean;
  requireParameters?: boolean;
  dataCollection?: 'allow' | 'deny' | 'store';
  sort?: { by: 'price' | 'throughput' | 'latency'; partition?: string };
  ignore?: string[];
  quantizations?: string[];
}

export interface UsageInfo {
  promptTokens: number | null;
  completionTokens: number | null;
  /** Real cost reported by the provider (OpenRouter returns usage.cost). Null = unknown. */
  billedCostUsd: number | null;
}

export interface ChatResult {
  provider: ProviderId;
  model: string;
  text: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: UsageInfo;
  latencyMs: number;
  /** Only the parameters the provider documents; anything else was dropped. */
  unsupportedParams: string[];
}

export interface ModelPricing {
  promptPerMtok: number | null;
  completionPerMtok: number | null;
  isFree: boolean;
  tier: PricingTier;
  note: string | null;
}

export interface ModelSupport {
  tools: boolean | null;
  json: boolean | null;
  stream: boolean | null;
  reasoning: boolean | null;
  vision: boolean | null;
  audio: boolean | null;
  video: boolean | null;
  embeddings: boolean | null;
}

export interface ModelInfo {
  provider: ProviderId;
  externalId: string;
  name: string;
  author: string | null;
  description: string | null;
  contextLength: number | null;
  maxOutput: number | null;
  pricing: ModelPricing;
  support: ModelSupport;
  /** A model listed on a hub is NOT automatically served over the inference API. */
  available: boolean;
  availabilityNote: string | null;
  inferenceProviders: string[];
  raw?: unknown;
}

export interface KeyStatus {
  provider: ProviderId;
  ok: boolean;
  error: string | null;
  /** Provider-reported facts. Anything absent stays null; we never invent numbers. */
  label: string | null;
  isFreeTier: boolean | null;
  limitUsd: number | null;
  limitRemainingUsd: number | null;
  usageUsd: number | null;
  usageDailyUsd: number | null;
  freeRequestsUsed: number | null;
  freeRequestsLimit: number | null;
  creditsTotalUsd: number | null;
  creditsUsageUsd: number | null;
  creditsBalanceUsd: number | null;
}

export interface ProviderClient {
  readonly id: ProviderId;
  readonly baseUrl: string;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  chat(params: ChatParams, signal?: AbortSignal): Promise<ChatResult>;
  chatStream(
    params: ChatParams,
    onDelta: (chunk: { text?: string; toolCallDelta?: string }) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult>;
  verifyKey(signal?: AbortSignal): Promise<KeyStatus>;
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** OpenRouter returns prices as USD-per-token strings; we normalise to USD per million tokens. */
export function perMtok(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  return n * 1_000_000;
}
