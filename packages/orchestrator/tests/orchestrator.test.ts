import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '@nexus/db';
import { NexusError } from '@nexus/shared';
import { Orchestrator, TaskStore, type TaskStatus } from '../src/index.js';

describe('task store', () => {
  let db: Db;
  let store: TaskStore;

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' });
    migrate(db, join(process.cwd(), 'database/migrations'));
    store = new TaskStore(db);
  });

  it('creates a task with the documented initial state', () => {
    const t = store.create({ title: 'Root', kind: 'plan', acceptance: ['a plan exists'] });
    expect(t.status).toBe('created');
    expect(t.attempt).toBe(0);
    expect(t.maxAttempts).toBe(3);
    expect(t.acceptance).toEqual(['a plan exists']);
    expect(t.finishedAt).toBeNull();
  });

  it('returns the whole tree under a root', () => {
    const root = store.create({ title: 'Root', kind: 'plan' });
    const a = store.create({ title: 'A', kind: 'step', parentId: root.id });
    const b = store.create({ title: 'B', kind: 'step', parentId: a.id });
    store.create({ title: 'Unrelated', kind: 'step' });
    const tree = store.tree(root.id);
    expect(tree.map((t) => t.title)).toEqual(['Root', 'A', 'B']);
  });

  it('refuses a self dependency and a cycle', () => {
    const a = store.create({ title: 'A', kind: 'step' });
    const b = store.create({ title: 'B', kind: 'step' });
    store.addDependency(b.id, a.id);
    expect(() => store.addDependency(a.id, a.id)).toThrow(/itself/);
    expect(() => store.addDependency(a.id, b.id)).toThrow(/cycle/);
  });

  it('lists interrupted tasks for resumability', () => {
    const t = store.create({ title: 'A', kind: 'step' });
    store.setStatus(t.id, 'running');
    expect(store.resumable().map((r) => r.id)).toContain(t.id);
    store.setStatus(t.id, 'completed', { output: { ok: true } });
    expect(store.resumable().map((r) => r.id)).not.toContain(t.id);
  });
});

describe('orchestrator', () => {
  let db: Db;
  let store: TaskStore;
  let orch: Orchestrator;

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' });
    migrate(db, join(process.cwd(), 'database/migrations'));
    store = new TaskStore(db);
    orch = new Orchestrator(store);
  });

  it('runs a real multi-step task in dependency order and passes outputs along', async () => {
    const order: string[] = [];
    orch.register('plan', () => { order.push('plan'); return { steps: ['build', 'test'] }; });
    orch.register('build', ({ dependencyOutputs }) => {
      order.push('build');
      return { builtFrom: Object.values(dependencyOutputs)[0] };
    });
    orch.register('test', ({ dependencyOutputs }) => {
      order.push('test');
      return { tested: Object.values(dependencyOutputs)[0] };
    });

    const root = store.create({ title: 'Plan', kind: 'plan', acceptance: ['plan produced'] });
    const build = store.create({ title: 'Build', kind: 'build', parentId: root.id, dependsOn: [root.id] });
    store.create({ title: 'Test', kind: 'test', parentId: root.id, dependsOn: [build.id] });

    const events: { title: string; status: TaskStatus }[] = [];
    const report = await orch.run(root.id, { onEvent: (e) => events.push({ title: e.title, status: e.status }) });

    expect(order).toEqual(['plan', 'build', 'test']);
    expect(report.status).toBe('completed');
    expect(report.completed).toBe(3);
    expect(report.failed).toBe(0);
    const testTask = report.tasks.find((t) => t.title === 'Test')!;
    expect(store.get(testTask.id)!.output).toEqual({ tested: { builtFrom: { steps: ['build', 'test'] } } });
    // every state change was emitted for the UI
    expect(events.filter((e) => e.status === 'completed')).toHaveLength(3);
  });

  it('retries a failing step up to maxAttempts, then succeeds', async () => {
    let calls = 0;
    orch.register('flaky', () => {
      calls += 1;
      if (calls < 3) throw new Error(`transient failure ${calls}`);
      return { ok: true };
    });
    const t = store.create({ title: 'Flaky', kind: 'flaky', maxAttempts: 3 });
    const report = await orch.run(t.id);
    expect(calls).toBe(3);
    expect(report.status).toBe('completed');
    expect(store.get(t.id)!.attempt).toBe(3);
    expect(store.get(t.id)!.output).toEqual({ ok: true });
  });

  it('fails after the attempt budget and cancels the downstream tasks', async () => {
    let calls = 0;
    orch.register('doomed', () => { calls += 1; throw new Error('permanent'); });
    orch.register('after', () => ({ never: true }));

    const a = store.create({ title: 'Doomed', kind: 'doomed', maxAttempts: 2 });
    store.create({ title: 'After', kind: 'after', dependsOn: [a.id] });

    const report = await orch.run(a.id);
    expect(calls).toBe(2);            // bounded: no infinite loop
    expect(report.status).toBe('failed');
    expect(report.failed).toBe(1);
    expect(report.cancelled).toBe(1);
    const after = report.tasks.find((t) => t.title === 'After')!;
    expect(after.status).toBe('cancelled');
    expect(after.error).toMatch(/blocked by a failed dependency/);
  });

  it('fails a task whose kind has no handler', async () => {
    const t = store.create({ title: 'Orphan', kind: 'nothing-registered' });
    const report = await orch.run(t.id);
    expect(report.status).toBe('failed');
    expect(store.get(t.id)!.error).toMatch(/No handler registered/);
  });

  it('honours cancellation and stops issuing work', async () => {
    const controller = new AbortController();
    let started = 0;
    orch.register('slow', async ({ signal }) => {
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (signal.aborted) throw new Error('aborted');
      return { done: started };
    });
    orch.register('next', () => ({ unreachable: true }));

    const a = store.create({ title: 'Slow', kind: 'slow', maxAttempts: 1 });
    store.create({ title: 'Next', kind: 'next', dependsOn: [a.id] });

    setTimeout(() => controller.abort(), 5);
    const report = await orch.run(a.id, { signal: controller.signal });
    expect(report.status).toBe('cancelled');
    expect(report.cancelled).toBeGreaterThan(0);
    expect(report.tasks.find((t) => t.title === 'Next')!.status).toBe('cancelled');
  });

  it('resumes an interrupted run instead of starting over', async () => {
    const done: string[] = [];
    orch.register('step', ({ task }) => { done.push(task.title); return { title: task.title }; });

    const root = store.create({ title: 'S1', kind: 'step' });
    const second = store.create({ title: 'S2', kind: 'step', dependsOn: [root.id] });
    // Simulate a crash: the first task completed, the second was mid-flight.
    store.setStatus(root.id, 'completed', { output: { title: 'S1' } });
    store.setStatus(second.id, 'running');

    expect(store.resumable().map((t) => t.title)).toEqual(['S2']);
    const report = await orch.resume(root.id);
    expect(report.status).toBe('completed');
    expect(done).toEqual(['S2']);           // S1 was not re-executed
    expect(store.get(second.id)!.output).toEqual({ title: 'S2' });
  });

  it('records a tool execution for every step, success and failure alike', async () => {
    orch.register('ok', () => ({ fine: true }));
    orch.register('bad', () => { throw new Error('nope'); });
    const a = store.create({ title: 'OK', kind: 'ok', maxAttempts: 1 });
    const b = store.create({ title: 'Bad', kind: 'bad', maxAttempts: 1 });
    await orch.run(a.id);
    await orch.run(b.id);

    const rows = db.prepare('SELECT tool, status, error FROM tool_executions ORDER BY created_at').all() as
      { tool: string; status: string; error: string | null }[];
    expect(rows.map((r) => [r.tool, r.status])).toEqual([['ok', 'ok'], ['bad', 'error']]);
    expect(rows[1]!.error).toBe('nope');
  });

  it('cancels a whole tree on demand', async () => {
    const root = store.create({ title: 'Root', kind: 'plan' });
    store.create({ title: 'Child', kind: 'step', parentId: root.id });
    orch.cancelTree(root.id, 'user cancelled');
    for (const t of store.tree(root.id)) {
      expect(t.status).toBe('cancelled');
      expect(t.error).toBe('user cancelled');
    }
  });

  it('refuses to build a cyclic plan', () => {
    const a = store.create({ title: 'A', kind: 'step' });
    const b = store.create({ title: 'B', kind: 'step' });
    store.addDependency(b.id, a.id);
    expect(() => store.addDependency(a.id, b.id)).toThrow(NexusError);
  });
});
