import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Db } from './database.js';

export interface MigrationRecord {
  name: string;
  hash: string;
  appliedAt: number;
}

export interface MigrationResult {
  applied: MigrationRecord[];
  skipped: string[];
  total: number;
}

/**
 * Versioned SQL migrations. Files are applied in lexicographic order, each inside
 * its own transaction, and recorded in `_migrations` together with a content hash.
 * A changed hash on an already-applied file is a hard error: released migrations
 * must never be edited, only superseded.
 */
export function migrate(db: Db, migrationsDir: string): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const get = db.prepare('SELECT name, hash FROM _migrations WHERE name = ?');
  const insert = db.prepare('INSERT INTO _migrations (name, hash, applied_at) VALUES (?, ?, ?)');

  let files: string[] = [];
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch (e) {
    throw new Error(`Cannot read migrations directory ${migrationsDir}: ${(e as Error).message}`);
  }

  const applied: MigrationRecord[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    const name = basename(file);
    const existing = get.get(name) as { name: string; hash: string } | undefined;
    if (existing) {
      if (existing.hash !== hash) {
        throw new Error(`Migration ${name} was modified after being applied. Add a new migration instead.`);
      }
      skipped.push(name);
      continue;
    }
    const run = db.transaction(() => {
      db.exec(sql);
      insert.run(name, hash, Date.now());
    });
    run();
    applied.push({ name, hash, appliedAt: Date.now() });
  }

  return { applied, skipped, total: files.length };
}
