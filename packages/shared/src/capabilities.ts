/**
 * Capability registry (spec 4.1).
 *
 * Every external feature we depend on is declared here with its official endpoint,
 * its verification status and its test. Nothing is coded from assumption: if
 * `verifiedAt` is null the feature is *unverified* and the UI must say so.
 */
export type CapabilityStatus = 'implemented' | 'partial' | 'planned' | 'unavailable' | 'unverified';

export interface Capability {
  key: string;
  provider: 'openrouter' | 'huggingface' | 'system';
  name: string;
  endpoint?: string;
  method?: string;
  params?: string[];
  cost?: 'free' | 'paid' | 'unknown';
  modelRequirement?: string;
  status: CapabilityStatus;
  test?: string;
  /** ISO date the official documentation was last checked. */
  verifiedAt: string | null;
  notes?: string;
}

export const CAPABILITIES: Capability[] = [
  // ---- OpenRouter (verified against openrouter.ai/docs on 2026-10-12) ----
  {
    key: 'openrouter.chat_completions', provider: 'openrouter', name: 'Chat Completions',
    endpoint: '/api/v1/chat/completions', method: 'POST',
    params: ['model','messages','temperature','top_p','top_k','max_tokens','stop','seed','response_format','tools','tool_choice','stream','reasoning','provider','plugins','models'],
    cost: 'unknown', status: 'implemented', test: 'tests/contracts/openrouter.contract.test.ts',
    verifiedAt: '2026-10-12', notes: 'OpenAI-compatible; base https://openrouter.ai/api/v1',
  },
  {
    key: 'openrouter.models', provider: 'openrouter', name: 'Model catalogue',
    endpoint: '/api/v1/models', method: 'GET', cost: 'free', status: 'implemented',
    test: 'tests/contracts/openrouter.contract.test.ts', verifiedAt: '2026-10-12',
  },
  {
    key: 'openrouter.key', provider: 'openrouter', name: 'Current key (limit / spend / free quota)',
    endpoint: '/api/v1/key', method: 'GET', cost: 'free', status: 'implemented',
    test: 'tests/contracts/openrouter.contract.test.ts', verifiedAt: '2026-10-12',
    notes: 'data.label, data.limit, data.limit_remaining, data.limit_reset, data.usage, data.usage_daily, data.is_free_tier, data.free_model_daily_requests{used,limit}',
  },
  {
    key: 'openrouter.credits', provider: 'openrouter', name: 'Account credits',
    endpoint: '/api/v1/credits', method: 'GET', cost: 'free', status: 'implemented',
    test: 'tests/contracts/openrouter.contract.test.ts', verifiedAt: '2026-10-12',
    notes: 'Returns total_credits and total_usage; balance = total_credits - total_usage. Some accounts require a Management key.',
  },
  {
    key: 'openrouter.provider_routing', provider: 'openrouter', name: 'Provider routing',
    endpoint: '/api/v1/chat/completions', method: 'POST',
    params: ['provider.order','provider.allow_fallbacks','provider.require_parameters','provider.data_collection','provider.sort.by','provider.sort.partition','provider.preferred_min_throughput.p90'],
    cost: 'unknown', status: 'implemented', test: 'tests/contracts/openrouter.contract.test.ts', verifiedAt: '2026-10-12',
  },
  {
    key: 'openrouter.usage_cost', provider: 'openrouter', name: 'usage.cost on responses',
    cost: 'free', status: 'implemented', test: 'tests/contracts/openrouter.contract.test.ts', verifiedAt: '2026-10-12',
    notes: 'Provider reports the real billed cost; we store it as cost_billed_usd instead of estimating.',
  },
  {
    key: 'openrouter.responses', provider: 'openrouter', name: 'Responses API',
    endpoint: '/api/v1/responses', method: 'POST', status: 'planned', verifiedAt: '2026-10-12',
    notes: 'Not used by the core chat path; kept in the registry for future use.',
  },
  {
    key: 'openrouter.endpoints', provider: 'openrouter', name: 'Model endpoints discovery',
    endpoint: '/api/v1/models/{author}/{slug}/endpoints', method: 'GET', status: 'planned', verifiedAt: '2026-10-12',
  },
  {
    key: 'openrouter.server_tools', provider: 'openrouter', name: 'Server tools (web search / fetch / datetime)',
    endpoint: '/api/v1/chat/completions', method: 'POST', params: ['plugins'],
    status: 'planned', verifiedAt: '2026-10-12',
    notes: 'OpenRouter server tools never replace local file/build/test tools.',
  },

  // ---- Hugging Face (verified against huggingface.co/docs/inference-providers) ----
  {
    key: 'hf.chat_completions', provider: 'huggingface', name: 'Inference Providers chat',
    endpoint: 'https://router.huggingface.co/v1/chat/completions', method: 'POST',
    params: ['model','messages','temperature','top_p','max_tokens','stream','tools','tool_choice'],
    cost: 'unknown', status: 'implemented', test: 'tests/contracts/huggingface.contract.test.ts', verifiedAt: '2026-10-12',
    notes: 'model may carry a provider suffix: repo:provider or repo:fastest / :cheapest / :preferred',
  },
  {
    key: 'hf.hub_models', provider: 'huggingface', name: 'Hub model discovery',
    endpoint: 'https://huggingface.co/api/models', method: 'GET', cost: 'free',
    status: 'implemented', test: 'tests/contracts/huggingface.contract.test.ts', verifiedAt: '2026-10-12',
    notes: 'Listing a model on the Hub does NOT imply it is served by an Inference Provider.',
  },
  {
    key: 'hf.task_endpoints', provider: 'huggingface', name: 'Task endpoints (text-generation, text-to-image, automatic-speech-recognition, ...)',
    endpoint: 'https://router.huggingface.co/{provider}/v1/{task}', method: 'POST', status: 'planned', verifiedAt: '2026-10-12',
  },
  {
    key: 'hf.embeddings', provider: 'huggingface', name: 'Embeddings',
    endpoint: 'https://router.huggingface.co/{provider}/v1/embeddings', method: 'POST', status: 'planned', verifiedAt: '2026-10-12',
  },
  {
    key: 'hf.dedicated_endpoint', provider: 'huggingface', name: 'Dedicated inference endpoint',
    status: 'unavailable', verifiedAt: '2026-10-12',
    notes: 'Requires a provisioned endpoint on the HF account; detected, never assumed.',
  },

  {
    key: 'openrouter.byo_endpoint', provider: 'openrouter', name: 'Custom / self-hosted endpoint override',
    status: 'implemented', verifiedAt: '2026-10-12',
    notes: 'OPENROUTER_BASE_URL / HF_ROUTER_BASE_URL / HF_HUB_BASE_URL. The override host must still pass the SSRF allowlist.',
  },

  // ---- System ----
  { key: 'system.model_registry', provider: 'system', name: 'Unified model registry (OpenRouter + Hugging Face)', status: 'implemented', test: 'packages/model-registry/tests/registry.test.ts', verifiedAt: '2026-10-12' },
  { key: 'system.chat_stream', provider: 'system', name: 'Chat with SSE streaming and conversation persistence', status: 'implemented', test: 'apps/api/tests/chat.test.ts', verifiedAt: '2026-10-12' },
  { key: 'system.cost_accounting', provider: 'system', name: 'Cost accounting (billed / estimated / free / unknown)', status: 'implemented', test: 'apps/api/tests/chat.test.ts', verifiedAt: '2026-10-12' },
  { key: 'system.free_only_guard', provider: 'system', name: 'free_only routing never falls back to a paid model', status: 'implemented', test: 'apps/api/tests/chat.test.ts', verifiedAt: '2026-10-12' },
  { key: 'system.smart_router', provider: 'system', name: 'Smart Router (8 modes, capability + privacy + context filtering, bounded fallback chain)', status: 'implemented', test: 'packages/router/tests/smart-router.test.ts', verifiedAt: '2026-10-12' },
  { key: 'system.router_explain', provider: 'system', name: 'Routing dry run (POST /api/router/explain) - no provider call, no spend', status: 'implemented', test: 'apps/api/tests/budget-router.test.ts', verifiedAt: '2026-10-12' },
  { key: 'system.budget_engine', provider: 'system', name: 'Budget policies: reservation, reconciliation, caps, block/warn', status: 'implemented', test: 'packages/finops/tests/cost-engine.test.ts', verifiedAt: '2026-10-12' },
  { key: 'system.secret_vault', provider: 'system', name: 'AES-256-GCM secret vault', status: 'implemented', test: 'packages/security/tests/vault.test.ts', verifiedAt: '2026-10-12' },
  { key: 'system.auth', provider: 'system', name: 'Session authentication', status: 'implemented', test: 'apps/api/tests/auth.test.ts', verifiedAt: '2026-10-12' },
  { key: 'system.web_factory', provider: 'system', name: 'Universal Web Factory', status: 'planned', verifiedAt: '2026-10-12' },
];
