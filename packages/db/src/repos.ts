import type { Db } from './database.js';
import { newId, now } from '@nexus/shared';

export interface UserRow {
  id: string; email: string; display_name: string; password_hash: string;
  role: string; status: string; prefs_json: string;
  created_at: number; updated_at: number; last_login_at: number | null;
}

export interface SessionRow {
  id: string; user_id: string; token_hash: string; csrf_token_hash: string;
  user_agent: string | null; ip: string | null;
  created_at: number; expires_at: number; revoked_at: number | null;
}

export class UserRepo {
  constructor(private readonly db: Db) {}

  create(input: { email: string; displayName: string; passwordHash: string; role?: string }): UserRow {
    const id = newId('usr');
    const t = now();
    this.db.prepare(
      `INSERT INTO users (id, email, display_name, password_hash, role, status, prefs_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', '{}', ?, ?)`,
    ).run(id, input.email, input.displayName, input.passwordHash, input.role ?? 'user', t, t);
    return this.byId(id)!;
  }

  byId(id: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow) ?? null;
  }

  byEmail(email: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as UserRow) ?? null;
  }

  touchLogin(id: string): void {
    this.db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id);
  }

  setPassword(id: string, hash: string): void {
    this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, now(), id);
  }

  setPrefs(id: string, prefs: Record<string, unknown>): void {
    this.db.prepare('UPDATE users SET prefs_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(prefs), now(), id);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }
}

export class SessionRepo {
  constructor(private readonly db: Db) {}

  create(input: { userId: string; tokenHash: string; csrfHash: string; userAgent?: string | null; ip?: string | null; ttlMs: number }): SessionRow {
    const id = newId('ses');
    const t = now();
    this.db.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_token_hash, user_agent, ip, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.userId, input.tokenHash, input.csrfHash, input.userAgent ?? null, input.ip ?? null, t, t + input.ttlMs);
    return this.byId(id)!;
  }

  byTokenHash(tokenHash: string): SessionRow | null {
    return (this.db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL').get(tokenHash) as SessionRow) ?? null;
  }

  byId(id: string): SessionRow | null {
    return (this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow) ?? null;
  }

  revoke(id: string): void {
    this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(now(), id);
  }

  purgeExpired(): number {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()).changes;
  }
}

export class AuditRepo {
  constructor(private readonly db: Db) {}

  log(entry: {
    userId?: string | null; actor?: string; action: string;
    targetType?: string | null; targetId?: string | null;
    outcome?: 'ok' | 'denied' | 'error' | 'blocked';
    ip?: string | null; userAgent?: string | null; detail?: unknown;
  }): string {
    const id = newId('aud');
    this.db.prepare(
      `INSERT INTO audit_logs (id, user_id, actor, action, target_type, target_id, outcome, ip, user_agent, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, entry.userId ?? null, entry.actor ?? 'system', entry.action,
      entry.targetType ?? null, entry.targetId ?? null, entry.outcome ?? 'ok',
      entry.ip ?? null, entry.userAgent ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
      now(),
    );
    return id;
  }

  recent(limit = 100): unknown[] {
    return this.db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  countByOutcome(outcome: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE outcome = ?').get(outcome) as { n: number }).n;
  }
}
