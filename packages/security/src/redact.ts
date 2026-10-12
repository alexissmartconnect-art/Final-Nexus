/** Never let a secret reach the browser, a screenshot or a model prompt. */

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'openrouter_key', re: /\bsk-or-(?:v1-)?[A-Za-z0-9_-]{16,}\b/g },
  { name: 'hf_token', re: /\bhf_[A-Za-z0-9]{20,}\b/g },
  { name: 'bearer_header', re: /\bauthorization\b\s*[:=]\s*(?:bearer\s+)?['"]?[A-Za-z0-9._~+/=.-]{8,}['"]?/gi },
  { name: 'bearer_token', re: /\bbearer\s+[A-Za-z0-9._~+/=.-]{16,}/gi },
  { name: 'generic_secret_assignment', re: /\b(api[_-]?key|apikey|secret|password|passwd|token|access[_-]?key)\b\s*[:=]\s*['"]?[^\s'",;{}]{8,}['"]?/gi },
  { name: 'private_key_block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'aws_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
];

export interface RedactionResult {
  text: string;
  redacted: string[];
}

export function redactSecrets(input: unknown): RedactionResult {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  const redacted: string[] = [];
  let out = text;
  for (const { name, re } of PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), (match) => {
      if (!redacted.includes(name)) redacted.push(name);
      return `[REDACTED:${name}]`;
    });
  }
  return { text: out, redacted };
}

/** Deep-walk an object and redact string values. */
export function redactDeep<T>(value: T, maxDepth = 8): T {
  if (maxDepth <= 0) return value;
  if (typeof value === 'string') return redactSecrets(value).text as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, maxDepth - 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, maxDepth - 1);
    }
    return out as T;
  }
  return value;
}
