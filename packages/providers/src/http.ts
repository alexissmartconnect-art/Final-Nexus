import { NexusError } from '@nexus/shared';
import { assertUrlAllowed, MODEL_API_ALLOWLIST, redactSecrets } from '@nexus/security';
import type { ProviderId } from './types.js';

export interface HttpOptions {
  baseUrl: string;
  apiKey: string;
  provider: ProviderId;
  /** Extra allowlisted hosts, for tests pointing at a local server. */
  extraHosts?: string[];
  allowPrivate?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  referer?: string;
  title?: string;
  fetchImpl?: typeof fetch;
}

export interface HttpResponse<T> {
  status: number;
  body: T;
  raw: string;
  retryAfterMs: number | null;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function hostOf(baseUrl: string): string {
  return new URL(baseUrl).hostname;
}

export class ProviderHttp {
  private readonly allowlist: string[];

  constructor(private readonly opts: HttpOptions) {
    // The configured base URL host is NOT implicitly trusted: it must be a known
    // model endpoint or be explicitly allowlisted. A typo must not become an SSRF.
    this.allowlist = [...MODEL_API_ALLOWLIST, ...(opts.extraHosts ?? [])];
    if (!this.allowlist.includes(hostOf(opts.baseUrl))) {
      throw new NexusError('ssrf_blocked',
        `Refusing to build a client for ${hostOf(opts.baseUrl)}: host is not an allowlisted model endpoint`);
    }
  }

  async request<T = unknown>(
    path: string,
    init: { method?: string; body?: unknown; signal?: AbortSignal; stream?: boolean } = {},
  ): Promise<{ res: Response; json: (() => Promise<T>) | null }> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}${path}`;
    await assertUrlAllowed(url, {
      allowlist: this.allowlist,
      allowPrivate: this.opts.allowPrivate,
      // Plain HTTP is only ever accepted for an explicitly opted-in private target
      // (a local runner or a contract test). Real model traffic stays HTTPS-only.
      protocols: this.opts.allowPrivate ? ['http:', 'https:'] : ['https:'],
    });

    const timeoutMs = this.opts.timeoutMs ?? 60_000;
    const maxRetries = this.opts.maxRetries ?? 2;
    const doFetch = this.opts.fetchImpl ?? fetch;

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
      const onOuterAbort = (): void => controller.abort();
      init.signal?.addEventListener('abort', onOuterAbort, { once: true });

      try {
        const res = await doFetch(url, {
          method: init.method ?? 'GET',
          headers: {
            authorization: `Bearer ${this.opts.apiKey}`,
            ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
            accept: init.stream ? 'text/event-stream' : 'application/json',
            ...(this.opts.referer ? { 'HTTP-Referer': this.opts.referer } : {}),
            ...(this.opts.title ? { 'X-Title': this.opts.title } : {}),
          },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: controller.signal,
        });

        if (!res.ok && RETRYABLE.has(res.status) && attempt < maxRetries) {
          const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
          const backoff = retryAfterMs ?? backoffMs(attempt);
          await sleep(backoff, init.signal);
          lastError = new NexusError('provider_error', `${this.opts.provider} responded ${res.status}`, { status: 502 });
          continue;
        }
        return {
          res,
          json: async () => {
            const text = await res.text();
            if (!text) return undefined as T;
            try {
              return JSON.parse(text) as T;
            } catch {
              throw new NexusError('provider_error', `${this.opts.provider} returned a non-JSON body`, { status: 502 });
            }
          },
        };
      } catch (err) {
        const aborted = err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError');
        if (init.signal?.aborted) throw err;
        if (aborted && attempt < maxRetries) {
          await sleep(backoffMs(attempt), init.signal);
          lastError = err;
          continue;
        }
        if (aborted) {
          throw new NexusError('provider_unavailable', `${this.opts.provider} request timed out after ${timeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
        init.signal?.removeEventListener('abort', onOuterAbort);
      }
    }
    throw lastError ?? new NexusError('provider_unavailable', `${this.opts.provider} request failed`);
  }

  /** Convenience for JSON endpoints: throws a NexusError with a redacted message on failure. */
  async json<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const { res, json } = await this.request<T>(path, init);
    const body = json ? await json() : (undefined as T);
    if (!res.ok) {
      throw new NexusError(res.status === 401 || res.status === 403 ? 'unauthorized' : 'provider_error',
        redactSecrets(`${this.opts.provider} ${res.status}: ${summarise(body)}`).text,
        { status: 502, details: { providerStatus: res.status } });
    }
    return body;
  }
}

export function summarise(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 400);
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const err = b.error as { message?: string; code?: string } | undefined;
    if (err?.message) return `${err.code ?? ''} ${err.message}`.trim();
    if (typeof b.message === 'string') return b.message;
  }
  return JSON.stringify(body ?? '').slice(0, 400);
}

export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds, 60)) * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));
  return null;
}

export function backoffMs(attempt: number): number {
  return Math.min(8_000, 400 * 2 ** attempt) + Math.floor(Math.random() * 200);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
