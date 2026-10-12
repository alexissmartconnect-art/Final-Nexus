import { createHash } from 'node:crypto';
import { NexusError, newId, now } from '@nexus/shared';
import { hashPassword, randomToken, verifyPassword } from '@nexus/security';
import type { PublicUser } from '@nexus/shared';
import type { AppContext } from '../context.js';

export const SESSION_COOKIE = 'nexus_session';
export const CSRF_COOKIE = 'nexus_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface SessionView {
  sessionId: string;
  token: string;
  csrfToken: string;
  expiresAt: number;
  user: PublicUser;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function toPublicUser(u: {
  id: string; email: string; display_name: string; role: string; created_at: number; prefs_json: string;
}): PublicUser {
  let prefs: Record<string, unknown> = {};
  try { prefs = JSON.parse(u.prefs_json) as Record<string, unknown>; } catch { /* keep empty */ }
  return { id: u.id, email: u.email, displayName: u.display_name, role: u.role, createdAt: u.created_at, prefs };
}

export class AuthService {
  constructor(private readonly ctx: AppContext) {}

  register(input: { email: string; password: string; displayName?: string }, meta: { ip?: string; userAgent?: string | null } = {}): SessionView {
    const email = input.email.toLowerCase();
    if (this.ctx.users.byEmail(email)) {
      this.ctx.audit.log({ action: 'auth.register', outcome: 'denied', ip: meta.ip, userAgent: meta.userAgent, detail: { email } });
      throw new NexusError('conflict', 'An account with this email already exists');
    }
    const isFirst = this.ctx.users.count() === 0;
    const user = this.ctx.users.create({
      email,
      displayName: input.displayName?.trim() || email.split('@')[0]!,
      passwordHash: hashPassword(input.password),
      role: isFirst ? 'admin' : 'user',
    });
    this.ctx.audit.log({
      userId: user.id, action: 'auth.register', targetType: 'user', targetId: user.id,
      ip: meta.ip, userAgent: meta.userAgent, detail: { firstAccount: isFirst },
    });
    return this.createSession(user.id, meta);
  }

  login(input: { email: string; password: string }, meta: { ip?: string; userAgent?: string | null } = {}): SessionView {
    const email = input.email.toLowerCase();
    const user = this.ctx.users.byEmail(email);
    // Constant-ish behaviour: verify against a dummy hash when the account does not exist,
    // so response timing does not reveal account existence.
    const stored = user?.password_hash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const ok = verifyPassword(input.password, stored);
    if (!user || !ok) {
      this.ctx.audit.log({ action: 'auth.login', outcome: 'denied', ip: meta.ip, userAgent: meta.userAgent, detail: { email } });
      throw new NexusError('unauthorized', 'Invalid email or password');
    }
    if (user.status !== 'active') {
      this.ctx.audit.log({ userId: user.id, action: 'auth.login', outcome: 'blocked', ip: meta.ip, detail: { reason: user.status } });
      throw new NexusError('forbidden', 'This account is disabled');
    }
    this.ctx.users.touchLogin(user.id);
    this.ctx.audit.log({ userId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, ip: meta.ip, userAgent: meta.userAgent });
    return this.createSession(user.id, meta);
  }

  logout(sessionId: string, userId: string | null, meta: { ip?: string } = {}): void {
    this.ctx.sessions.revoke(sessionId);
    this.ctx.audit.log({ userId, action: 'auth.logout', targetType: 'session', targetId: sessionId, ip: meta.ip });
  }

  changePassword(userId: string, current: string, next: string): void {
    const user = this.ctx.users.byId(userId);
    if (!user) throw new NexusError('unauthorized', 'Unknown user');
    if (!verifyPassword(current, user.password_hash)) {
      this.ctx.audit.log({ userId, action: 'auth.change_password', outcome: 'denied' });
      throw new NexusError('unauthorized', 'Current password is incorrect');
    }
    this.ctx.users.setPassword(userId, hashPassword(next));
    this.ctx.audit.log({ userId, action: 'auth.change_password', targetType: 'user', targetId: userId });
  }

  /** Resolve a session cookie to an active user. */
  resolve(token: string | undefined): { sessionId: string; user: ReturnType<typeof toPublicUser> } | null {
    if (!token) return null;
    const row = this.ctx.sessions.byTokenHash(hashToken(token));
    if (!row) return null;
    if (row.expires_at < now()) {
      this.ctx.sessions.revoke(row.id);
      return null;
    }
    const user = this.ctx.users.byId(row.user_id);
    if (!user || user.status !== 'active') return null;
    return { sessionId: row.id, user: toPublicUser(user) };
  }

  /** Double-submit CSRF: the cookie value must match the session-bound hash. */
  verifyCsrf(sessionId: string, csrfCookie: string | undefined, header: string | undefined): boolean {
    if (!csrfCookie || !header) return false;
    if (csrfCookie !== header) return false;
    const row = this.ctx.sessions.byId(sessionId);
    if (!row) return false;
    return row.csrf_token_hash === hashToken(csrfCookie);
  }

  private createSession(userId: string, meta: { ip?: string; userAgent?: string | null }): SessionView {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const row = this.ctx.sessions.create({
      userId,
      tokenHash: hashToken(token),
      csrfHash: hashToken(csrfToken),
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
      ttlMs: this.ctx.config.sessionTtlMs,
    });
    const user = this.ctx.users.byId(userId)!;
    return {
      sessionId: row.id,
      token,
      csrfToken,
      expiresAt: row.expires_at,
      user: toPublicUser(user),
    };
  }
}

/** Random id used for audit correlation when no session exists yet. */
export function requestId(): string {
  return newId('req');
}
