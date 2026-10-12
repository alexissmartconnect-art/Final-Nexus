import type { Db } from '@nexus/db';
import { createHmac } from 'node:crypto';
import { newId, NexusError, now } from '@nexus/shared';
import type { Vault } from '@nexus/security';

export interface StoredCredential {
  id: string;
  userId: string;
  provider: string;
  label: string;
  keyFingerprint: string;
  status: string;
  lastVerifiedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface CredRow {
  id: string; user_id: string; provider: string; label: string; cipher_text: string;
  key_fingerprint: string; scopes_json: string; status: string;
  last_verified_at: number | null; last_error: string | null;
  created_at: number; updated_at: number;
}

function toPublic(r: CredRow): StoredCredential {
  return {
    id: r.id, userId: r.user_id, provider: r.provider, label: r.label,
    keyFingerprint: r.key_fingerprint, status: r.status,
    lastVerifiedAt: r.last_verified_at, lastError: r.last_error,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/**
 * Server-side secret store. The plaintext key only ever exists inside the API process;
 * the database holds an AES-256-GCM payload plus a display-only fingerprint.
 */
export class CredentialService {
  constructor(private readonly db: Db, private readonly vault: Vault) {}

  private fingerprint(secret: string): string {
    const d = createHmac('sha256', 'nexus-cred-fp').update(secret).digest('hex');
    return `${secret.slice(0, 6)}…${d.slice(0, 4)}`;
  }

  upsert(input: { userId: string; provider: string; label: string; secret: string }): StoredCredential {
    const cipher = this.vault.encrypt(input.secret);
    const fp = this.fingerprint(input.secret);
    const existing = this.db
      .prepare('SELECT * FROM api_credentials WHERE user_id = ? AND provider = ? AND label = ?')
      .get(input.userId, input.provider, input.label) as CredRow | undefined;
    if (existing) {
      this.db.prepare(
        `UPDATE api_credentials SET cipher_text = ?, key_fingerprint = ?, status = 'active',
         last_error = NULL, updated_at = ? WHERE id = ?`,
      ).run(cipher, fp, now(), existing.id);
      return this.byId(existing.id)!;
    }
    const id = newId('crd');
    this.db.prepare(
      `INSERT INTO api_credentials (id, user_id, provider, label, cipher_text, key_fingerprint, scopes_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', 'active', ?, ?)`,
    ).run(id, input.userId, input.provider, input.label, cipher, fp, now(), now());
    return this.byId(id)!;
  }

  byId(id: string): StoredCredential | null {
    const row = this.db.prepare('SELECT * FROM api_credentials WHERE id = ?').get(id) as CredRow | undefined;
    return row ? toPublic(row) : null;
  }

  list(userId: string): StoredCredential[] {
    const rows = this.db.prepare('SELECT * FROM api_credentials WHERE user_id = ? ORDER BY provider, label').all(userId) as CredRow[];
    return rows.map(toPublic);
  }

  /** Returns the decrypted secret. Callers must never return it to the client or log it. */
  reveal(userId: string, provider: string, label = 'default'): string | null {
    const row = this.db.prepare(
      `SELECT * FROM api_credentials WHERE user_id = ? AND provider = ? AND label = ? AND status = 'active'`,
    ).get(userId, provider, label) as CredRow | undefined;
    if (!row) return null;
    return this.vault.decrypt(row.cipher_text);
  }

  markVerified(userId: string, provider: string, label: string, error: string | null): void {
    this.db.prepare(
      `UPDATE api_credentials SET status = ?, last_verified_at = ?, last_error = ?, updated_at = ?
       WHERE user_id = ? AND provider = ? AND label = ?`,
    ).run(error ? 'invalid' : 'active', now(), error, now(), userId, provider, label);
  }

  remove(userId: string, provider: string, label: string): boolean {
    const res = this.db.prepare(
      'DELETE FROM api_credentials WHERE user_id = ? AND provider = ? AND label = ?',
    ).run(userId, provider, label);
    if (res.changes === 0) throw new NexusError('not_found', 'Credential not found');
    return true;
  }
}
