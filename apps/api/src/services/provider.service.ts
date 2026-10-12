import { NexusError, type ProviderHealth } from '@nexus/shared';
import { ModelRegistry } from '@nexus/model-registry';
import { HuggingFaceClient, OpenRouterClient, type ProviderClient, type ProviderId } from '@nexus/providers';
import type { KeyStatus } from '@nexus/providers';
import type { AppContext } from '../context.js';

function customHosts(...urls: (string | undefined)[]): string[] {
  const hosts = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    try { hosts.add(new URL(u).hostname); } catch { /* ignore a malformed override */ }
  }
  return [...hosts];
}

export interface ResolvedCredential {
  secret: string;
  source: 'stored' | 'environment';
  label: string;
}

/**
 * Resolves which client to talk to for a given user.
 * A user-stored credential wins; the server environment is the fallback so a
 * single-operator deployment does not need to paste a key into the UI.
 * When neither exists the caller gets `provider_unavailable` - never a fake answer.
 */
export class ProviderService {
  readonly registry: ModelRegistry;

  constructor(private readonly ctx: AppContext) {
    this.registry = new ModelRegistry(ctx.db);
    this.registry.ensureProvider('openrouter', 'https://openrouter.ai/api/v1');
    this.registry.ensureProvider('huggingface', 'https://router.huggingface.co/v1');
  }

  resolveCredential(userId: string, provider: ProviderId): ResolvedCredential | null {
    const stored = this.ctx.credentials.reveal(userId, provider);
    if (stored) return { secret: stored, source: 'stored', label: 'default' };
    const envKey = provider === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.HUGGINGFACE_TOKEN;
    if (envKey) return { secret: envKey, source: 'environment', label: 'server' };
    return null;
  }

  clientFor(userId: string, provider: ProviderId): ProviderClient {
    const cred = this.resolveCredential(userId, provider);
    if (!cred) {
      throw new NexusError('provider_unavailable',
        `No ${provider === 'openrouter' ? 'OpenRouter API key' : 'Hugging Face token'} configured. Add one in “Gestion des API”.`);
    }
    const o = this.ctx.config.providers;
    const common = {
      allowPrivate: o.allowPrivate,
      extraHosts: customHosts(o.openrouterBaseUrl, o.hfRouterBaseUrl, o.hfHubBaseUrl),
    };
    if (provider === 'openrouter') {
      return new OpenRouterClient({
        apiKey: cred.secret,
        referer: process.env.OPENROUTER_SITE_URL,
        title: process.env.OPENROUTER_APP_TITLE ?? 'NEXUS OMEGA',
        ...(o.openrouterBaseUrl ? { baseUrl: o.openrouterBaseUrl } : {}),
        ...common,
      });
    }
    return new HuggingFaceClient({
      token: cred.secret,
      ...(o.hfRouterBaseUrl ? { routerBaseUrl: o.hfRouterBaseUrl } : {}),
      ...(o.hfHubBaseUrl ? { hubBaseUrl: o.hfHubBaseUrl } : {}),
      ...common,
    });
  }

  /**
   * Live check against the provider. Never guesses: if the network call fails we
   * report `reachable: false` with the provider's own message.
   */
  async health(userId: string, provider: ProviderId): Promise<ProviderHealth> {
    const cred = this.resolveCredential(userId, provider);
    const base: ProviderHealth = {
      provider, configured: cred !== null, reachable: null, checkedAt: null, detail: null, keyInfo: null,
    };
    if (!cred) {
      return { ...base, detail: 'No key configured for this account or on the server.' };
    }
    let status: KeyStatus;
    try {
      status = await this.clientFor(userId, provider).verifyKey();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.credentials.markVerified(userId, provider, 'default', message);
      return { ...base, reachable: false, checkedAt: Date.now(), detail: message };
    }
    this.ctx.credentials.markVerified(userId, provider, 'default', status.error);
    const { provider: _p, ok, error, ...facts } = status;
    void _p;
    return {
      ...base,
      reachable: ok,
      checkedAt: Date.now(),
      detail: error ?? (ok ? 'Key accepted by the provider.' : 'Provider rejected the key.'),
      keyInfo: facts as unknown as Record<string, unknown>,
    };
  }

  async healthAll(userId: string): Promise<ProviderHealth[]> {
    return Promise.all([this.health(userId, 'openrouter'), this.health(userId, 'huggingface')]);
  }

  /** Pull the real catalogue into the unified registry. */
  async sync(userId: string, provider: ProviderId) {
    const client = this.clientFor(userId, provider);
    try {
      const models = provider === 'huggingface'
        ? [...await (client as HuggingFaceClient).listInferenceModels(), ...await client.listModels()]
        : await client.listModels();
      const result = await this.registry.syncFrom(client, models);
      this.registry.markSynced(provider, null);
      this.ctx.audit.log({ userId, action: 'models.sync', targetType: 'provider', targetId: provider, detail: { ...result } });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.registry.markSynced(provider, message);
      this.ctx.audit.log({ userId, action: 'models.sync', outcome: 'error', targetType: 'provider', targetId: provider, detail: { message } });
      throw err;
    }
  }
}
