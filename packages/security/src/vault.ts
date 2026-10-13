import {
  createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual,
} from 'node:crypto';

const ALGO = 'aes-256-gcm' as const;
const IV_LEN = 12;
const TAG_LEN = 16;
const VERSION = 'v1';
/** Fixed application salt: the entropy comes from the operator-supplied master key. */
const KDF_SALT = Buffer.from('nexus-omega/secret-vault/v1', 'utf8');

let cached: { master: string; key: Buffer } | null = null;

function deriveKey(masterKey: string): Buffer {
  if (cached && cached.master === masterKey) return cached.key;
  if (!masterKey || masterKey.length < 16) {
    throw new Error('NEXUS_MASTER_KEY must be set and at least 16 characters long');
  }
  const key = scryptSync(masterKey, KDF_SALT, 32);
  cached = { master: masterKey, key };
  return key;
}

export interface Vault {
  encrypt(plain: string): string;
  decrypt(payload: string): string;
  fingerprint(secret: string): string;
}

/** AES-256-GCM vault. Output format: `v1.<base64(iv | tag | ciphertext)>`. */
export function createVault(masterKey: string): Vault {
  const key = deriveKey(masterKey);

  return {
    encrypt(plain: string): string {
      const iv = randomBytes(IV_LEN);
      const cipher = createCipheriv(ALGO, key, iv);
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${VERSION}.${Buffer.concat([iv, tag, ct]).toString('base64')}`;
    },

    decrypt(payload: string): string {
      const [version, body] = payload.split('.');
      if (version !== VERSION || !body) throw new Error('Unsupported vault payload format');
      const raw = Buffer.from(body, 'base64');
      if (raw.length <= IV_LEN + TAG_LEN) throw new Error('Vault payload is truncated');
      const iv = raw.subarray(0, IV_LEN);
      const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
      const ct = raw.subarray(IV_LEN + TAG_LEN);
      const decipher = createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    },

    /** Stable, non-reversible short identifier, safe to show in the UI. */
    fingerprint(secret: string): string {
      const digest = createHmac('sha256', key).update(secret).digest('hex');
      return `${digest.slice(0, 8)}…${digest.slice(-4)}`;
    },
  };
}

/** scrypt password hashing, format `scrypt$N$r$p$salt$hash`. */
export function hashPassword(password: string): string {
  const N = 16384, r = 8, p = 1, keylen = 32;
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHmac('sha256', 'nexus-omega').update(value).digest('hex');
}
