import { NexusError } from '@nexus/shared';
import { ProviderHttp } from './http.js';
import { readSse } from './sse.js';
import { num, perMtok, type ChatParams, type ChatResult, type KeyStatus, type ModelInfo, type ModelSupport, type ProviderClient, type ToolCall, type UsageInfo } from './types.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Parameters documented for /api/v1/chat/completions. Anything else is dropped, not guessed. */
const SUPPORTED_PARAMS = new Set([
  'model', 'messages', 'temperature', 'top_p', 'top_k', 'max_tokens', 'stop', 'seed',
  'response_format', 'tools', 'tool_choice', 'stream', 'reasoning', 'provider', 'plugins', 'models',
]);

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl?: string;
  referer?: string;
  title?: string;
  timeoutMs?: number;
  maxRetries?: number;
  extraHosts?: string[];
  allowPrivate?: boolean;
  fetchImpl?: typeof fetch;
}

interface ORModel {
  id?: string; name?: string; description?: string; context_length?: number;
  top_provider?: { max_completion_tokens?: number };
  pricing?: Record<string, string | number>;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: string[];
}

function supportFrom(m: ORModel): ModelSupport {
  const sp = new Set(m.supported_parameters ?? []);
  const inputs = new Set(m.architecture?.input_modalities ?? []);
  const has = (k: string): boolean | null => (sp.size === 0 ? null : sp.has(k));
  return {
    tools: has('tools'),
    json: has('response_format') ?? has('structured_outputs'),
    stream: null, // OpenRouter streams for every chat model; not advertised per model
    reasoning: has('reasoning'),
    vision: inputs.size === 0 ? null : inputs.has('image'),
    audio: inputs.size === 0 ? null : inputs.has('audio') || inputs.has('input_audio'),
    video: inputs.size === 0 ? null : inputs.has('video'),
    embeddings: null,
  };
}

function normaliseModel(m: ORModel): ModelInfo | null {
  if (!m.id) return null;
  const prompt = perMtok(m.pricing?.prompt);
  const completion = perMtok(m.pricing?.completion);
  const explicitFree = m.id.endsWith(':free');
  const zeroPriced = prompt === 0 && completion === 0;
  const isFree = explicitFree || zeroPriced;
  let tier: ModelInfo['pricing']['tier'] = 'unknown';
  if (isFree) tier = 'free';
  else if (prompt !== null && completion !== null && prompt > 0) tier = 'paid';
  return {
    provider: 'openrouter',
    externalId: m.id,
    name: m.name ?? m.id,
    author: m.id.includes('/') ? m.id.split('/')[0] ?? null : null,
    description: m.description ?? null,
    contextLength: num(m.context_length),
    maxOutput: num(m.top_provider?.max_completion_tokens),
    pricing: {
      promptPerMtok: prompt,
      completionPerMtok: completion,
      isFree,
      tier,
      note: explicitFree ? 'id carries the :free suffix' : zeroPriced ? 'catalog reports zero price' : null,
    },
    support: supportFrom(m),
    available: true,
    availabilityNote: null,
    inferenceProviders: [],
    raw: m,
  };
}

function buildBody(params: ChatParams, stream: boolean): { body: Record<string, unknown>; unsupported: string[] } {
  const body: Record<string, unknown> = { model: params.model, messages: params.messages, stream };
  const unsupported: string[] = [];

  const put = (key: string, value: unknown): void => {
    if (value === undefined) return;
    if (!SUPPORTED_PARAMS.has(key)) { unsupported.push(key); return; }
    body[key] = value;
  };

  put('temperature', params.temperature);
  put('top_p', params.topP);
  put('top_k', params.topK);
  put('max_tokens', params.maxTokens);
  put('stop', params.stop);
  put('seed', params.seed);
  put('response_format', params.responseFormat);
  put('tools', params.tools);
  put('tool_choice', params.toolChoice);
  put('reasoning', params.reasoning);
  if (params.providerRouting) {
    const r = params.providerRouting;
    const provider: Record<string, unknown> = {};
    if (r.order) provider.order = r.order;
    if (r.allowFallbacks !== undefined) provider.allow_fallbacks = r.allowFallbacks;
    if (r.requireParameters !== undefined) provider.require_parameters = r.requireParameters;
    if (r.dataCollection) provider.data_collection = r.dataCollection;
    if (r.sort) provider.sort = { by: r.sort.by, ...(r.sort.partition ? { partition: r.sort.partition } : {}) };
    if (r.ignore) provider.ignore = r.ignore;
    if (r.quantizations) provider.quantizations = r.quantizations;
    if (Object.keys(provider).length > 0) put('provider', provider);
  }
  return { body, unsupported };
}

function extractUsage(raw: unknown): UsageInfo {
  const u = (raw as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u) return { promptTokens: null, completionTokens: null, billedCostUsd: null };
  return {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    // OpenRouter documents usage.cost: the real billed cost, so we store it as billed.
    billedCostUsd: num(u.cost),
  };
}

export class OpenRouterClient implements ProviderClient {
  readonly id = 'openrouter' as const;
  readonly baseUrl: string;
  private readonly http: ProviderHttp;

  constructor(private readonly opts: OpenRouterOptions) {
    if (!opts.apiKey) throw new NexusError('unauthorized', 'An OpenRouter API key is required');
    this.baseUrl = opts.baseUrl ?? OPENROUTER_BASE_URL;
    this.http = new ProviderHttp({
      baseUrl: this.baseUrl,
      apiKey: opts.apiKey,
      provider: 'openrouter',
      referer: opts.referer,
      title: opts.title,
      timeoutMs: opts.timeoutMs,
      maxRetries: opts.maxRetries,
      extraHosts: opts.extraHosts,
      allowPrivate: opts.allowPrivate,
      fetchImpl: opts.fetchImpl,
    });
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const data = await this.http.json<{ data?: ORModel[] }>('/models', { signal });
    return (data.data ?? []).map(normaliseModel).filter((m): m is ModelInfo => m !== null);
  }

  async chat(params: ChatParams, signal?: AbortSignal): Promise<ChatResult> {
    const started = Date.now();
    const { body, unsupported } = buildBody(params, false);
    const data = await this.http.json<Record<string, unknown>>('/chat/completions', { method: 'POST', body, signal });
    const choice = (data.choices as Record<string, unknown>[] | undefined)?.[0] ?? {};
    const message = (choice.message as Record<string, unknown> | undefined) ?? {};
    return {
      provider: 'openrouter',
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
    const { body, unsupported } = buildBody(params, true);
    const { res, json } = await this.http.request('/chat/completions', { method: 'POST', body, signal, stream: true });
    if (!res.ok || !res.body) {
      const parsed = json ? await json() : undefined;
      throw new NexusError(res.status === 401 || res.status === 403 ? 'unauthorized' : 'provider_error',
        `OpenRouter streaming failed with ${res.status}: ${JSON.stringify(parsed ?? {}).slice(0, 300)}`, { status: 502 });
    }

    let text = '';
    let toolCalls: ToolCall[] = [];
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
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        text += delta.content;
        onDelta({ text: delta.content });
      }
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
    toolCalls = [...toolBuffers.values()].map((b) => ({ id: b.id, name: b.name, argumentsText: b.args }));

    return {
      provider: 'openrouter', model, text, toolCalls, finishReason, usage,
      latencyMs: Date.now() - started, unsupportedParams: unsupported,
    };
  }

  /** GET /api/v1/key plus GET /api/v1/credits. Facts we cannot read stay null. */
  async verifyKey(signal?: AbortSignal): Promise<KeyStatus> {
    const empty: KeyStatus = {
      provider: 'openrouter', ok: false, error: null, label: null, isFreeTier: null,
      limitUsd: null, limitRemainingUsd: null, usageUsd: null, usageDailyUsd: null,
      freeRequestsUsed: null, freeRequestsLimit: null,
      creditsTotalUsd: null, creditsUsageUsd: null, creditsBalanceUsd: null,
    };
    let key: { data?: Record<string, unknown> };
    try {
      key = await this.http.json<{ data?: Record<string, unknown> }>('/key', { signal });
    } catch (err) {
      return { ...empty, error: err instanceof Error ? err.message : String(err) };
    }
    const d = key.data ?? {};
    const freeReq = (d.free_model_daily_requests ?? {}) as Record<string, unknown>;
    const status: KeyStatus = {
      ...empty,
      ok: true,
      label: typeof d.label === 'string' ? d.label : null,
      isFreeTier: typeof d.is_free_tier === 'boolean' ? d.is_free_tier : null,
      limitUsd: num(d.limit),
      limitRemainingUsd: num(d.limit_remaining),
      usageUsd: num(d.usage),
      usageDailyUsd: num(d.usage_daily),
      freeRequestsUsed: num(freeReq.used),
      freeRequestsLimit: num(freeReq.limit),
    };

    // /credits can require a Management key on some accounts; a failure is not a key failure.
    try {
      const credits = await this.http.json<{ data?: Record<string, unknown> }>('/credits', { signal });
      const c = credits.data ?? {};
      const total = num(c.total_credits);
      const usage = num(c.total_usage);
      status.creditsTotalUsd = total;
      status.creditsUsageUsd = usage;
      status.creditsBalanceUsd = total !== null && usage !== null ? total - usage : null;
    } catch {
      status.error = 'Key is valid; the credits endpoint is not readable with this key.';
    }
    return status;
  }
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
