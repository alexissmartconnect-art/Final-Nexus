import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { NexusError } from '@nexus/shared';

export interface SsrfPolicy {
  allowlist?: string[];     // exact hostnames allowed
  allowPrivate?: boolean;   // only for the local runner, never for model calls
  protocols?: string[];
}

const DEFAULT_PROTOCOLS = ['https:'];

function ipIsPrivate(ip: string): boolean {
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return true;
  const [a, b] = p as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Guard against server-side request forgery.
 * Model traffic goes to an explicit allowlist; anything else is refused before the socket opens.
 */
export async function assertUrlAllowed(rawUrl: string, policy: SsrfPolicy = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NexusError('ssrf_blocked', `Malformed URL: ${rawUrl}`);
  }
  const protocols = policy.protocols ?? DEFAULT_PROTOCOLS;
  if (!protocols.includes(url.protocol)) {
    throw new NexusError('ssrf_blocked', `Protocol ${url.protocol} is not allowed`);
  }
  // WHATWG URL keeps IPv6 literals bracketed ("[::1]"); isIP() needs the bare form.
  const rawHost = url.hostname.toLowerCase();
  if (!rawHost) throw new NexusError('ssrf_blocked', 'URL has no host');
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;

  if (policy.allowlist && policy.allowlist.length > 0) {
    const ok = policy.allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
    if (!ok) throw new NexusError('ssrf_blocked', `Host ${host} is not in the allowlist`);
  }

  if (!policy.allowPrivate) {
    if (isIP(host)) {
      if (ipIsPrivate(host)) throw new NexusError('ssrf_blocked', `Private IP ${host} is not allowed`);
    } else {
      let addresses;
      try {
        addresses = await lookup(host, { all: true });
      } catch {
        throw new NexusError('ssrf_blocked', `Cannot resolve host ${host}`);
      }
      for (const a of addresses) {
        if (ipIsPrivate(a.address)) {
          throw new NexusError('ssrf_blocked', `Host ${host} resolves to private address ${a.address}`);
        }
      }
    }
  }
  return url;
}

export const MODEL_API_ALLOWLIST = ['openrouter.ai', 'router.huggingface.co', 'huggingface.co'];
