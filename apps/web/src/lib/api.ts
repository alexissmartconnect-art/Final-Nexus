import type { PublicUser } from '@nexus/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function readCsrf(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)nexus_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  const csrf = readCsrf();
  if (csrf && init.method && init.method.toUpperCase() !== 'GET') headers.set('x-csrf-token', csrf);

  const res = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });

  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? res.statusText, err?.details);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export interface MeResponse { user: PublicUser; csrfToken: string | null; csrfHeader: string }
export interface Capability {
  key: string; provider: string; name: string; endpoint?: string; method?: string;
  status: string; cost?: string; verifiedAt: string | null; notes?: string; test?: string; params?: string[];
}
export interface HealthResponse {
  status: string; service: string; version: string; time: string;
  checks: { database: boolean }; runtime: { node: string; env: string };
}
export interface CredentialView {
  id: string; provider: string; label: string; keyFingerprint: string;
  status: string; lastVerifiedAt: number | null; lastError: string | null;
}

export const client = {
  api,
  me: () => api<MeResponse>('/api/auth/me'),
  health: () => api<HealthResponse>('/api/health'),
  capabilities: () => api<{ capabilities: Capability[] }>('/api/meta/capabilities'),
  credentials: () => api<{ credentials: CredentialView[] }>('/api/credentials'),
  register: (email: string, password: string, displayName?: string) =>
    api<{ user: PublicUser; csrfToken: string; firstAccount: boolean }>('/api/auth/register', {
      method: 'POST', json: { email, password, ...(displayName ? { displayName } : {}) },
    }),
  login: (email: string, password: string) =>
    api<{ user: PublicUser; csrfToken: string }>('/api/auth/login', { method: 'POST', json: { email, password } }),
  logout: () => api<{ ok: boolean }>('/api/auth/logout', { method: 'POST', json: {} }),
  setCredential: (provider: string, secret: string, label = 'default') =>
    api<{ credential: CredentialView }>('/api/credentials', { method: 'POST', json: { provider, secret, label } }),
  deleteCredential: (provider: string) =>
    api<{ ok: boolean }>(`/api/credentials/${encodeURIComponent(provider)}`, { method: 'DELETE', json: {} }),
};
