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
  };
}
