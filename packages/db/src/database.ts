import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type Db = Database.Database;

export interface DatabaseOptions {
  /** Absolute or relative file path, or ':memory:'. */
  file: string;
  /** Apply WAL + normal durability settings. Disable for in-memory test databases. */
  tuning?: boolean;
}

export function openDatabase(opts: DatabaseOptions): Db {
  if (opts.file !== ':memory:') mkdirSync(dirname(resolve(opts.file)), { recursive: true });
  const db = new Database(opts.file);
  db.pragma('foreign_keys = ON');
  if (opts.tuning !== false && opts.file !== ':memory:') {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
  }
  return db;
}
