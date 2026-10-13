import { migrate, openDatabase } from '@nexus/db';
import { loadEnvFile } from '../env.js';
import { loadConfig } from '../config.js';

try {
  const envFile = loadEnvFile();
  const config = loadConfig();
  const db = openDatabase({ file: config.dbFile });
  const result = migrate(db, config.migrationsDir);
  console.log(JSON.stringify({ envFile, dbFile: config.dbFile, ...result }, null, 2));
  db.close();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[nexus] migration failed: ${message}`);
  process.exit(1);
}
