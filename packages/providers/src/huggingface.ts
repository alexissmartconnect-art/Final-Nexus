import { NexusError } from '@nexus/shared';
import { ProviderHttp } from './http.js';
import { readSse } from './sse.js';
import { num, type ChatParams, type ChatResult, type KeyStatus, type ModelInfo, type ProviderClient, type ToolCall, type UsageInfo } from './types.js';

export const HF_ROUTER_BASE_URL = 'https://router.huggingface.co/v1';
export const HF_HUB_BASE_URL = 'https://huggingface.co/api';

/** Parameters accepted by the Inference Providers chat endpoint (OpenAI-compatible subset). */
const SUPPORTED_PARAMS = new Set([
  'model', 'messages', 'temperature', 'top_p', 'max_tokens', 'stop', 'seed', 'stream', 'tools', 'tool_choice',
]);

export interface HuggingFaceOptions {
  token: string;
  routerBaseUrl?: string;
  hubBaseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  extraHosts?: string[];
  allowPrivate?: boolean;
  fetchImpl?: typeof fetch;
  /** Limit for the Hub listing; the Hub hosts far more models than we should pull at once. */
  hubLimit?: number;
}

interface HubModel {
  id?: string; modelId?: string; author?: string; pipeline_tag?: string;
  tags?: string[]; library_name?: string; downloads?: number; likes?: number;
  inference?: string; inference_provider_mapping?: Record<string, unknown>;
}

interface RouterModel {
  id?: string; owned_by?: string; context_length?: number;
  pricing?: { prompt?: number | string; completion?: number | string };
  capabilities?: string[]; type?: string;
}

/**
 * A model listed on the Hub is NOT necessarily served by an Inference Provider.
 * `listModels()` returns the Hub catalogue marked unavailable; `listInferenceModels()`
 * returns what the router actually serves. The registry merges the two.
 */
export class HuggingFaceClient implements ProviderClient {
  readonly id = 'huggingface' as const;
  readonly baseUrl: string;
  private readonly hubBaseUrl: string;
  private readonly http: ProviderHttp;
  private readonly hub: ProviderHttp;

  constructor(private readonly opts: HuggingFaceOptions) {
    if (!opts.token) throw new NexusError('unauthorized', 'A Hugging Face token is required');
    this.baseUrl = opts.routerBaseUrl ?? HF_ROUTER_BASE_URL;
    this.hubBaseUrl = opts.hubBaseUrl ?? HF_HUB_BASE_URL;
    const common = {
      apiKey: opts.token, provider: 'huggingface' as const, timeoutMs: opts.timeoutMs,
      maxRetries: opts.maxRetries, extraHosts: opts.extraHosts, allowPrivate: opts.allowPrivate,
      fetchImpl: opts.fetchImpl,
    };
    this.http = new ProviderHttp({ ...common, baseUrl: this.baseUrl });
    this.hub = new ProviderHttp({ ...common, baseUrl: this.hubBaseUrl });
  }

  /** Hub catalogue: known models, inference availability unknown until probed. */
  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const limit = this.opts.hubLimit ?? 200;
    const data = await this.hub.json<HubModel[]>(`/models?limit=${limit}&sort=downloads&direction=-1`, { signal });
    if (!Array.isArray(data)) return [];
    return data.map((m): ModelInfo | null => {
      const id = m.id ?? m.modelId;
      if (!id) return null;
      const tags = m.tags ?? [];
      const mapping = m.inference_provider_mapping;
      const providers = mapping ? Object.keys(mapping) : [];
      return {
        provider: 'huggingface',
        externalId: id,
        name: id,
        author: m.author ?? (id.includes('/') ? id.split('/')[0] ?? null : null),
        description: null,
        contextLength: null,
        maxOutput: null,
        pricing: { promptPerMtok: null, completionPerMtok: null, isFree: false, tier: 'unknown', note: 'Hub metadata does not expose inference pricing' },
        support: {
          tools: null,
          json: null,
          stream: null,
          reasoning: null,
          vision: tags.includes('image-text-to-text') ? true : null,
          audio: null,
          video: null,
          embeddings: m.pipeline_tag === 'feature-extraction' ? true : null,
        },
        available: providers.length > 0,
        availabilityNote: providers.length > 0
          ? 'Inference provider mapping present on the model card'
          : 'Listed on the Hub; not confirmed as served by an Inference Provider',
        inferenceProviders: providers,
        raw: m,
      };
    }).filter((m): m is ModelInfo => m !== null);
  }

  /** What the Inference Providers router actually serves right now. */
  async listInferenceModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const data = await this.http.json<{ data?: RouterModel[] }>('/models', { signal });
    return (data.data ?? []).map((m): ModelInfo | null => {
      if (!m.id) return null;
      const prompt = m.pricing?.prompt === undefined ? null : Number(m.pricing.prompt) * 1_000_000;
      const completion = m.pricing?.completion === undefined ? null : Number(m.pricing.completion) * 1_000_000;
      const caps = new Set(m.capabilities ?? []);
      const isFree = prompt === 0 && completion === 0;
      return {
        provider: 'huggingface',
        externalId: m.id,
        name: m.id,
        author: m.owned_by ?? (m.id.includes('/') ? m.id.split('/')[0] ?? null : null),
        description: null,
        contextLength: num(m.context_length),
        maxOutput: null,
        pricing: {
          promptPerMtok: Number.isFinite(prompt as number) ? prompt : null,
          completionPerMtok: Number.isFinite(completion as number) ? completion : null,
          isFree,
          tier: isFree ? 'free' : prompt !== null ? 'paid' : 'unknown',
          note: null,
        },
        support: {
          tools: caps.size === 0 ? null : caps.has('tools') || caps.has('function_calling'),
          json: caps.size === 0 ? null : caps.has('json') || caps.has('structured_outputs'),
          stream: null,
          reasoning: caps.size === 0 ? null : caps.has('reasoning'),
          vision: caps.size === 0 ? null : caps.has('vision') || caps.has('image'),
          audio: null, video: null, embeddings: m.type === 'embedding',
        },
        available: true,
        availabilityNote: 'Served by the Inference Providers router',
        inferenceProviders: [],
        raw: m,
      };
    }).filter((m): m is ModelInfo => m !== null);
  }

  async chat(params: ChatParams, signal?: AbortSignal): Promise<ChatResult> {
    const started = Date.now();
    const { body, unsupported } = this.buildBody(params, false);
    const data = await this.http.json<Record<string, unknown>>('/chat/completions', { method: 'POST', body, signal });
    const choice = (data.choices as Record<string, unknown>[] | undefined)?.[0] ?? {};
    const message = (choice.message as Record<string, unknown> | undefined) ?? {};
    return {
      provider: 'huggingface',
      model: typeof data.model === 'string' ? data.model : params.model,
      text: typeof message.content === 'string' ? message.content : '',
      toolCalls: parseToolCalls(message.tool_calls),
      finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
      usage: extractUsage(data),
      latencyMs: Date.now() - started,
      unsupportedParams: unsupported,
    };
  }

  async chatStream(
    params: ChatParams,
    onDelta: (chunk: { text?: string; toolCallDelta?: string }) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const started = Date.now();
    const { body, unsupported } = this.buildBody(params, true);
    const { res, json } = await this.http.request('/chat/completions', { method: 'POST', body, signal, stream: true });
    if (!res.ok || !res.body) {
      const parsed = json ? await json() : undefined;
      throw new NexusError(res.status === 401 || res.status === 403 ? 'unauthorized' : 'provider_error',
        `Hugging Face streaming failed with ${res.status}: ${JSON.stringify(parsed ?? {}).slice(0, 300)}`, { status: 502 });
    }
    let text = '';
    let finishReason: string | null = null;
    let usage: UsageInfo = { promptTokens: null, completionTokens: null, billedCostUsd: null };
    let model = params.model;
    const toolBuffers = new Map<number, { id: string; name: string; args: string }>();

    for await (const evt of readSse(res.body, signal)) {
      if (evt.data.trim() === '[DONE]') break;
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(evt.data) as Record<string, unknown>; } catch { continue; }
      if (typeof payload.model === 'string') model = payload.model;
      if (payload.usage) usage = extractUsage(payload);
      const choice = (payload.choices as Record<string, unknown>[] | undefined)?.[0];
      if (!choice) continue;
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
      const delta = (choice.delta as Record<string, unknown> | undefined) ?? {};
      if (typeof delta.content === 'string' && delta.content) { text += delta.content; onDelta({ text: delta.content }); }
      const tcs = delta.tool_calls as Record<string, unknown>[] | undefined;
      if (tcs) {
        for (const tc of tcs) {
          const index = typeof tc.index === 'number' ? tc.index : 0;
          const buf = toolBuffers.get(index) ?? { id: '', name: '', args: '' };
          const fn = (tc.function as Record<string, unknown> | undefined) ?? {};
          if (typeof tc.id === 'string') buf.id = tc.id;
          if (typeof fn.name === 'string') buf.name += fn.name;
          if (typeof fn.arguments === 'string') { buf.args += fn.arguments; onDelta({ toolCallDelta: fn.arguments }); }
          toolBuffers.set(index, buf);
        }
      }
    }
    return {
      provider: 'huggingface', model, text,
      toolCalls: [...toolBuffers.values()].map((b) => ({ id: b.id, name: b.name, argumentsText: b.args })),
      finishReason, usage, latencyMs: Date.now() - started, unsupportedParams: unsupported,
    };
  }

  /** The router answers /models only for a valid token; whoami adds the account name. */
  async verifyKey(signal?: AbortSignal): Promise<KeyStatus> {
    const empty: KeyStatus = {
      provider: 'huggingface', ok: false, error: null, label: null, isFreeTier: null,
      limitUsd: null, limitRemainingUsd: null, usageUsd: null, usageDailyUsd: null,
      freeRequestsUsed: null, freeRequestsLimit: null,
      creditsTotalUsd: null, creditsUsageUsd: null, creditsBalanceUsd: null,
    };
    try {
      await this.http.json<{ data?: unknown[] }>('/models', { signal });
    } catch (err) {
      return { ...empty, error: err instanceof Error ? err.message : String(err) };
    }
    const status: KeyStatus = { ...empty, ok: true };
    try {
      const who = await this.hub.json<{ name?: string; type?: string }>('/whoami-v2', { signal });
      status.label = typeof who.name === 'string' ? who.name : null;
    } catch {
      status.error = 'Token accepted by the router; whoami is not readable with this token.';
    }
    // Hugging Face does not expose a spend endpoint on the inference router.
    status.error = status.error ?? 'Inference spend is not exposed by the router API; cost stays unknown.';
    return status;
  }

  private buildBody(params: ChatParams, stream: boolean): { body: Record<string, unknown>; unsupported: string[] } {
    const body: Record<string, unknown> = { model: params.model, messages: params.messages, stream };
    const unsupported: string[] = [];
    const put = (key: string, value: unknown): void => {
      if (value === undefined) return;
      if (!SUPPORTED_PARAMS.has(key)) { unsupported.push(key); return; }
      body[key] = value;
    };
    put('temperature', params.temperature);
    put('top_p', params.topP);
    put('max_tokens', params.maxTokens);
    put('stop', params.stop);
    put('seed', params.seed);
    put('tools', params.tools);
    put('tool_choice', params.toolChoice);
    if (params.topK !== undefined) unsupported.push('top_k');
    if (params.responseFormat) unsupported.push('response_format');
    if (params.reasoning) unsupported.push('reasoning');
    if (params.providerRouting) unsupported.push('provider');
    return { body, unsupported };
  }
}

function extractUsage(raw: unknown): UsageInfo {
  const u = (raw as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u) return { promptTokens: null, completionTokens: null, billedCostUsd: null };
  return {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    // The inference router does not return a billed cost: it stays unknown, never zero.
    billedCostUsd: num(u.cost),
  };
}

function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((tc, i) => {
    const o = tc as Record<string, unknown>;
    const fn = (o.function as Record<string, unknown> | undefined) ?? {};
    return {
      id: typeof o.id === 'string' ? o.id : `call_${i}`,
      name: typeof fn.name === 'string' ? fn.name : '',
      argumentsText: typeof fn.arguments === 'string' ? fn.arguments : '',
    };
  });
}
