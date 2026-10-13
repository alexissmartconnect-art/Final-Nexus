import { loadEnvFile } from './env.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { openDatabase, migrate } from '@nexus/db';
import { buildApp } from './app.js';
import { hashPassword } from '@nexus/security';

async function main(): Promise<void> {
  const envFile = loadEnvFile();
  if (envFile) console.log(`[nexus] loaded environment from ${envFile}`);
  const config = loadConfig();
  const db = openDatabase({ file: config.dbFile });
  const migration = migrate(db, config.migrationsDir);
  const ctx = createContext(config, db);

  if (migration.applied.length > 0) {
    console.log(`[nexus] applied ${migration.applied.length} migration(s): ${migration.applied.map((m) => m.name).join(', ')}`);
  }

  // Optional first-run bootstrap so an operator is not locked out.
  if (config.bootstrapAdmin && ctx.users.count() === 0) {
    ctx.users.create({
      email: config.bootstrapAdmin.email.toLowerCase(),
      displayName: 'Administrator',
      passwordHash: hashPassword(config.bootstrapAdmin.password),
      role: 'admin',
    });
    console.log(`[nexus] bootstrap admin created for ${config.bootstrapAdmin.email}`);
  }

  const app = await buildApp(ctx, { logger: true });
  await app.listen({ host: config.host, port: config.port });
  console.log(`[nexus] API listening on http://${config.host}:${config.port} (${config.env})`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[nexus] ${signal} received, shutting down`);
    try { await app.close(); } finally { db.close(); process.exit(0); }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[nexus] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
