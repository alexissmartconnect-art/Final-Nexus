import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '@nexus/db';
import { NexusError } from '@nexus/shared';
import { AgentRegistry, DEFAULT_AGENTS } from '../src/index.js';

describe('agent registry', () => {
  let db: Db;
  let registry: AgentRegistry;

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' });
    migrate(db, join(process.cwd(), 'database/migrations'));
    registry = new AgentRegistry(db);
  });

  it('seeds the 17 roles of the specification', () => {
    expect(registry.seed()).toBe(17);
    expect(DEFAULT_AGENTS).toHaveLength(17);
    const keys = registry.list().map((a) => a.key);
    for (const expected of ['orchestrator', 'planner', 'researcher', 'analyst', 'architect', 'designer',
      'frontend_dev', 'backend_dev', 'db_expert', 'tester', 'fixer', 'security_expert',
      'performance_expert', 'seo_expert', 'deployer', 'documentalist', 'judge']) {
      expect(keys, `missing agent ${expected}`).toContain(expected);
    }
  });

  it('seeding twice does not duplicate', () => {
    registry.seed();
    expect(registry.seed()).toBe(0);
    expect(registry.list()).toHaveLength(17);
  });

  it('each agent declares role, instructions, tools and limits', () => {
    registry.seed();
    for (const a of registry.list()) {
      expect(a.role.length).toBeGreaterThan(5);
      expect(a.instructions.length).toBeGreaterThan(10);
      expect(Array.isArray(a.tools)).toBe(true);
      expect(a.maxRuns).toBeGreaterThan(0);
      expect(a.enabled).toBe(true);
    }
  });

  it('updates an agent and validates the input', () => {
    registry.seed();
    const updated = registry.update('fixer', { maxRuns: 5, budgetUsd: 0.5, tools: ['file.patch'] });
    expect(updated.maxRuns).toBe(5);
    expect(updated.budgetUsd).toBe(0.5);
    expect(updated.tools).toEqual(['file.patch']);

    expect(() => registry.update('fixer', { maxRuns: 0 })).toThrow(NexusError);
    expect(() => registry.update('fixer', { budgetUsd: -1 })).toThrow(NexusError);
    expect(() => registry.update('nope', { maxRuns: 2 })).toThrow(/Unknown agent/);
  });

  it('records runs and counts them against maxRuns', () => {
    registry.seed();
    registry.recordRun({ agentKey: 'planner', status: 'ok', startedAt: Date.now(), finishedAt: Date.now() });
    registry.recordRun({ agentKey: 'planner', status: 'error', error: 'boom', startedAt: Date.now() });
    expect(registry.runCount('planner')).toBe(2);
    expect(() => registry.recordRun({ agentKey: 'ghost', status: 'ok', startedAt: Date.now() })).toThrow(/Unknown agent/);
  });
});
