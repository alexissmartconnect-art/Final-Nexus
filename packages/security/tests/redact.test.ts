import { describe, expect, it } from 'vitest';
import { redactDeep, redactSecrets } from '../src/redact.js';

describe('secret redaction', () => {
  it('redacts an OpenRouter key', () => {
    const r = redactSecrets('my key is sk-or-v1-abcdef0123456789ABCDEF0123456789 ok');
    expect(r.text).not.toContain('sk-or-v1-abcdef0123456789');
    expect(r.text).toContain('[REDACTED:openrouter_key]');
    expect(r.redacted).toContain('openrouter_key');
  });

  it('redacts a Hugging Face token', () => {
    const r = redactSecrets('token=hf_abcdefghijklmnopqrstuvwx');
    expect(r.text).not.toContain('hf_abcdefghijklmnopqrstuvwx');
    expect(r.redacted).toContain('hf_token');
  });

  it('redacts Authorization headers and key assignments', () => {
    expect(redactSecrets('Authorization: Bearer abcdef0123456789abcdef').text).toContain('[REDACTED:bearer_header]');
    expect(redactSecrets('api_key = "supersecretvalue123"').text).toContain('[REDACTED:generic_secret_assignment]');
  });

  it('redacts private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(pem).text).toContain('[REDACTED:private_key_block]');
  });

  it('leaves ordinary text untouched', () => {
    const text = 'Build a React + Vite site with Tailwind.';
    expect(redactSecrets(text).text).toBe(text);
  });

  it('redacts nested structures', () => {
    const out = redactDeep({ log: ['ok', 'key=sk-or-v1-abcdef0123456789ABCDEF'], n: 1 }) as { log: string[]; n: number };
    expect(out.log[1]).not.toContain('sk-or-v1');
    expect(out.n).toBe(1);
  });
});
