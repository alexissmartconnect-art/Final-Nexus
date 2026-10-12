import { describe, expect, it } from 'vitest';
import { assertUrlAllowed, MODEL_API_ALLOWLIST } from '../src/ssrf.js';
import { NexusError } from '@nexus/shared';

describe('SSRF guard', () => {
  it('allows the documented model endpoints', async () => {
    await expect(assertUrlAllowed('https://openrouter.ai/api/v1/chat/completions', { allowlist: MODEL_API_ALLOWLIST })).resolves.toBeInstanceOf(URL);
    await expect(assertUrlAllowed('https://router.huggingface.co/v1/chat/completions', { allowlist: MODEL_API_ALLOWLIST })).resolves.toBeInstanceOf(URL);
  });

  it('rejects a host outside the allowlist', async () => {
    await expect(assertUrlAllowed('https://evil.example.com/x', { allowlist: MODEL_API_ALLOWLIST })).rejects.toThrow(/allowlist/);
  });

  it('rejects non-HTTPS protocols', async () => {
    await expect(assertUrlAllowed('http://openrouter.ai/api/v1/models', { allowlist: MODEL_API_ALLOWLIST })).rejects.toThrow(/Protocol/);
    await expect(assertUrlAllowed('file:///etc/passwd')).rejects.toThrow(NexusError);
    await expect(assertUrlAllowed('gopher://openrouter.ai/')).rejects.toThrow(/Protocol/);
  });

  it('rejects loopback and private addresses', async () => {
    await expect(assertUrlAllowed('https://127.0.0.1/admin')).rejects.toThrow(/private/i);
    await expect(assertUrlAllowed('https://10.0.0.5/')).rejects.toThrow(/private/i);
    await expect(assertUrlAllowed('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(/private/i);
    await expect(assertUrlAllowed('https://[::1]/')).rejects.toThrow(/private/i);
  });

  it('rejects malformed URLs', async () => {
    await expect(assertUrlAllowed('not a url')).rejects.toThrow(/Malformed/);
  });

  it('permits private targets only when explicitly allowed (local runner)', async () => {
    await expect(assertUrlAllowed('http://127.0.0.1:9321/exec', { allowPrivate: true, protocols: ['http:'] })).resolves.toBeInstanceOf(URL);
  });
});
