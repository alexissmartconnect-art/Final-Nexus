import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/index.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'nexus-mig-'));
}

describe('migration runner', () => {
  it('applies the real project schema and creates every expected table', () => {
    const db = openDatabase({ file: ':memory:' });
    const result = migrate(db, join(process.cwd(), 'database/migrations'));
    expect(result.applied.length).toBeGreaterThanOrEqual(1);
    expect(result.total).toBe(result.applied.length);

    const expected = [
      'users','sessions','api_credentials','providers','models','model_capabilities','model_prices',
      'conversations','messages','projects','project_files','project_versions','tasks',
      'agent_definitions','agent_runs','council_sessions','judge_evaluations','tool_executions',
      'build_runs','test_runs','deployments','usage_records','budget_policies',
      'knowledge_documents','audit_logs',
    ];
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tables = new Set(rows.map((r) => r.name));
    for (const t of expected) expect(tables.has(t), `missing table ${t}`).toBe(true);
  });

  it('is idempotent: a second run applies nothing', () => {
    const db = openDatabase({ file: ':memory:' });
    const dir = join(process.cwd(), 'database/migrations');
    migrate(db, dir);
    const second = migrate(db, dir);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBe(second.total);
  });

  it('refuses to run when an applied migration was edited', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (x INTEGER);');
    const db = openDatabase({ file: ':memory:' });
    migrate(db, dir);
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (x INTEGER, y INTEGER);');
    expect(() => migrate(db, dir)).toThrow(/modified after being applied/);
  });

  it('reports a missing migrations directory instead of silently passing', () => {
    const db = openDatabase({ file: ':memory:' });
    expect(() => migrate(db, join(tmpDir(), 'does-not-exist'))).toThrow(/Cannot read migrations directory/);
  });

  it('enforces foreign keys', () => {
    const db = openDatabase({ file: ':memory:' });
    migrate(db, join(process.cwd(), 'database/migrations'));
    expect(() =>
      db.prepare(`INSERT INTO sessions (id, user_id, token_hash, csrf_token_hash, created_at, expires_at)
                  VALUES ('s1','missing-user','h','c',1,2)`).run(),
    ).toThrow(/FOREIGN KEY/i);
  });
});
