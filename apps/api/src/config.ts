import { resolve } from 'node:path';
import { NexusError } from '@nexus/shared';

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  masterKey: string;
  dataDir: string;
  dbFile: string;
  migrationsDir: string;
  workspaceDir: string;
  corsOrigins: string[];
  bootstrapAdmin: { email: string; password: string } | null;
  sessionTtlMs: number;
  secureCookies: boolean;
}

function str(v: string | undefined, fallback: string): string {
  return v === undefined || v === '' ? fallback : v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (str(env.NEXUS_ENV, 'development') as AppConfig['env']);
  const dataDir = resolve(str(env.NEXUS_DATA_DIR, './.nexus/data'));
  const bootstrap = str(env.NEXUS_BOOTSTRAP_ADMIN, '');
  const [bEmail, bPassword] = bootstrap.split(':');
  const masterKey = str(env.NEXUS_MASTER_KEY, '');

  if (nodeEnv !== 'test' && masterKey.length < 16) {
    throw new NexusError('internal', 'NEXUS_MASTER_KEY must be set (>=16 chars). See .env.example');
  }

  return {
    env: nodeEnv,
    host: str(env.NEXUS_HOST, '0.0.0.0'),
    port: Number(str(env.NEXUS_PORT, '8787')),
    masterKey: masterKey || 'nexus-omega-test-master-key',
    dataDir,
    dbFile: resolve(dataDir, 'nexus.sqlite'),
    migrationsDir: resolve(str(env.NEXUS_MIGRATIONS_DIR, './database/migrations')),
    workspaceDir: resolve(str(env.NEXUS_WORKSPACE_DIR, './.nexus/workspaces')),
    corsOrigins: str(env.NEXUS_CORS_ORIGINS, 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
    bootstrapAdmin: bEmail && bPassword ? { email: bEmail, password: bPassword } : null,
    sessionTtlMs: Number(str(env.NEXUS_SESSION_TTL_MS, String(7 * 24 * 3600 * 1000))),
    secureCookies: nodeEnv === 'production',
  };
}
