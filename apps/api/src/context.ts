import type { Db } from '@nexus/db';
import { AuditRepo, SessionRepo, UserRepo } from '@nexus/db';
import { createVault, RateLimiter, type Vault } from '@nexus/security';
import type { AppConfig } from './config.js';
import { CredentialService } from './services/credentials.service.js';

export interface AppContext {
  config: AppConfig;
  db: Db;
  vault: Vault;
  users: UserRepo;
  sessions: SessionRepo;
  audit: AuditRepo;
  credentials: CredentialService;
  loginLimiter: RateLimiter;
  apiLimiter: RateLimiter;
  /** Resolve the owner of a conversation or project (used by background task handlers). */
  ownerOf: (conversationId: string | null) => string | null;
}

export function createContext(config: AppConfig, db: Db): AppContext {
  return {
    config,
    db,
    vault: createVault(config.masterKey),
    users: new UserRepo(db),
    sessions: new SessionRepo(db),
    audit: new AuditRepo(db),
    credentials: new CredentialService(db, createVault(config.masterKey)),
    loginLimiter: new RateLimiter({ max: 12, windowMs: 5 * 60_000 }),
    apiLimiter: new RateLimiter({ max: 600, windowMs: 60_000 }),
    ownerOf: (conversationId: string | null): string | null => {
      if (!conversationId) return null;
      const row = db.prepare('SELECT user_id FROM conversations WHERE id = ?').get(conversationId) as { user_id: string } | undefined;
      if (row) return row.user_id;
      const proj = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(conversationId) as { user_id: string } | undefined;
      return proj?.user_id ?? null;
    },
  };
}
