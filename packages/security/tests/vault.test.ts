import { describe, expect, it } from 'vitest';
import { createVault, hashPassword, randomToken, verifyPassword } from '../src/vault.js';

const MASTER = 'test-master-key-for-unit-tests-0123456789';

describe('secret vault (AES-256-GCM)', () => {
  it('round-trips a secret', () => {
    const v = createVault(MASTER);
    const plain = 'sk-or-v1-abcDEF1234567890_-';
    const cipher = v.encrypt(plain);
    expect(cipher).toMatch(/^v1\./);
    expect(cipher).not.toContain(plain);
    expect(v.decrypt(cipher)).toBe(plain);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const v = createVault(MASTER);
    const a = v.encrypt('same-secret');
    const b = v.encrypt('same-secret');
    expect(a).not.toBe(b);
    expect(v.decrypt(a)).toBe(v.decrypt(b));
  });

  it('refuses to decrypt with another master key', () => {
    const cipher = createVault(MASTER).encrypt('sk-or-v1-secret');
    expect(() => createVault('a-completely-different-master-key').decrypt(cipher)).toThrow();
  });

  it('detects tampering', () => {
    const v = createVault(MASTER);
    const cipher = v.encrypt('payload');
    const body = Buffer.from(cipher.slice(3), 'base64');
    const last = body.length - 1;
    body[last] = (body[last] ?? 0) ^ 0xff;
    expect(() => v.decrypt(`v1.${body.toString('base64')}`)).toThrow();
  });

  it('rejects a weak or missing master key', () => {
    expect(() => createVault('short')).toThrow(/NEXUS_MASTER_KEY/);
    expect(() => createVault('')).toThrow(/NEXUS_MASTER_KEY/);
  });

  it('fingerprints without leaking the secret', () => {
    const v = createVault(MASTER);
    const fp = v.fingerprint('sk-or-v1-abcDEF1234567890');
    expect(fp).toContain('…');
    expect(fp.length).toBeLessThan(20);
    expect(fp).not.toContain('abcDEF1234567890'.slice(4));
  });
});

describe('password hashing (scrypt)', () => {
  const pw = 'correct horse battery staple!';

  it('verifies the right password and rejects the wrong one', () => {
    const hash = hashPassword(pw);
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(verifyPassword(pw, hash)).toBe(true);
    expect(verifyPassword('wrong password', hash)).toBe(false);
  });

  it('is salted: two hashes of the same password differ', () => {
    expect(hashPassword(pw)).not.toBe(hashPassword(pw));
  });

  it('rejects malformed stored hashes instead of throwing', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'scrypt$NaN$8$1$AAAA$BBBB')).toBe(false);
  });
});

describe('random tokens', () => {
  it('is url-safe and unique', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
