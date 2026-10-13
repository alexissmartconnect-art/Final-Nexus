import type { Db } from '@nexus/db';
import { NexusError, newId, now } from '@nexus/shared';

export const TASK_STATUSES = [
  'created', 'planning', 'ready', 'running', 'waiting',
  'validating', 'retrying', 'completed', 'failed', 'cancelled',
] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

const TERMINAL: TaskStatus[] = ['completed', 'failed', 'cancelled'];

export interface TaskRecord {
  id: string;
  parentId: string | null;
  projectId: string | null;
  conversationId: string | null;
  title: string;
  kind: string;
  agent: string | null;
  status: TaskStatus;
  attempt: number;
  maxAttempts: number;
  input: Record<string, unknown>;
  output: unknown;
  error: string | null;
  acceptance: string[];
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateTaskInput {
  title: string;
  kind: string;
  parentId?: string | null;
  projectId?: string | null;
  conversationId?: string | null;
  agent?: string | null;
  input?: Record<string, unknown>;
  acceptance?: string[];
  maxAttempts?: number;
  dependsOn?: string[];
  status?: TaskStatus;
}

interface Row {
  id: string; parent_id: string | null; project_id: string | null; conversation_id: string | null;
  title: string; kind: string; status: string; attempt: number; max_attempts: number;
  input_json: string; output_json: string | null; error: string | null; acceptance_json: string | null;
  started_at: number | null; finished_at: number | null; created_at: number; updated_at: number;
}

/** Task persistence + DAG edges. Every state transition is written, so a run can be resumed. */
export class TaskStore {
  constructor(private readonly db: Db) {}

  create(input: CreateTaskInput): TaskRecord {
    const id = newId('tsk');
    const t = now();
    this.db.prepare(`
      INSERT INTO tasks (id, parent_id, project_id, conversation_id, title, kind, status, attempt,
        max_attempts, input_json, output_json, error, acceptance_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, ?, ?, ?)
    `).run(id, input.parentId ?? null, input.projectId ?? null, input.conversationId ?? null,
      input.title, input.kind, input.status ?? 'created', input.maxAttempts ?? 3,
      JSON.stringify(input.input ?? {}), JSON.stringify(input.acceptance ?? []), t, t);
    // `agent` is carried in the input payload: the schema keeps tasks generic.
    if (input.agent) this.db.prepare(`UPDATE tasks SET input_json = ? WHERE id = ?`)
      .run(JSON.stringify({ ...(input.input ?? {}), agent: input.agent }), id);
    for (const dep of input.dependsOn ?? []) this.addDependency(id, dep);
    return this.get(id)!;
  }

  get(id: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? toRecord(row, this.agentOf(row)) : null;
  }

  /**
   * The connected task graph reachable from a root: children by `parent_id` plus
   * every dependency edge in both directions (a dependency must run first, a
   * dependent belongs to the same plan). Ordered by creation.
   */
  tree(rootId: string): TaskRecord[] {
    const all = this.db.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all() as Row[];
    if (!all.some((r) => r.id === rootId)) throw new NexusError('not_found', `Unknown task ${rootId}`);
    const edges = this.db.prepare('SELECT task_id, depends_on_id FROM task_dependencies').all() as
      { task_id: string; depends_on_id: string }[];

    const ids = new Set<string>([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of all) {
        if (r.parent_id && ids.has(r.parent_id) && !ids.has(r.id)) { ids.add(r.id); grew = true; }
      }
      for (const e of edges) {
        if (ids.has(e.task_id) && !ids.has(e.depends_on_id)) { ids.add(e.depends_on_id); grew = true; }
        if (ids.has(e.depends_on_id) && !ids.has(e.task_id)) { ids.add(e.task_id); grew = true; }
      }
    }
    return all.filter((r) => ids.has(r.id)).map((r) => toRecord(r, this.agentOf(r)));
  }

  dependenciesOf(taskId: string): string[] {
    return (this.db.prepare('SELECT depends_on_id FROM task_dependencies WHERE task_id = ?').all(taskId) as { depends_on_id: string }[])
      .map((r) => r.depends_on_id);
  }

  addDependency(taskId: string, dependsOnId: string): void {
    if (taskId === dependsOnId) throw new NexusError('validation', 'A task cannot depend on itself');
    for (const id of [taskId, dependsOnId]) {
      if (!this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(id)) {
        throw new NexusError('not_found', `Unknown task ${id}`);
      }
    }
    // Refuse to create a cycle: dependsOnId must not already reach taskId.
    if (this.reaches(dependsOnId, taskId)) {
      throw new NexusError('validation', `Adding ${taskId} -> ${dependsOnId} would create a cycle`);
    }
    this.db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run(taskId, dependsOnId);
  }

  setStatus(id: string, status: TaskStatus, patch: { output?: unknown; error?: string | null; bumpAttempt?: boolean } = {}): TaskRecord {
    const current = this.get(id);
    if (!current) throw new NexusError('not_found', `Unknown task ${id}`);
    const t = now();
    this.db.prepare(`
      UPDATE tasks SET status = ?, attempt = ?, output_json = ?, error = ?,
        started_at = COALESCE(started_at, ?),
        finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      patch.bumpAttempt ? current.attempt + 1 : current.attempt,
      patch.output === undefined ? current.output === null ? null : JSON.stringify(current.output) : JSON.stringify(patch.output),
      patch.error === undefined ? current.error : patch.error,
      status === 'running' ? t : null,
      TERMINAL.includes(status) ? t : null,
      t, id,
    );
    return this.get(id)!;
  }

  /** Tasks interrupted mid-flight: the entry point for resumability. */
  resumable(): TaskRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE status IN ('running','waiting','retrying','planning','ready','created') ORDER BY created_at ASC`,
    ).all() as Row[];
    return rows.map((r) => toRecord(r, this.agentOf(r)));
  }

  recordToolExecution(input: {
    taskId?: string | null; projectId?: string | null; tool: string; runnerId?: string | null;
    status: 'ok' | 'error' | 'denied' | 'timeout'; input: unknown; output?: unknown;
    error?: string | null; durationMs: number;
  }): string {
    const id = newId('tex');
    this.db.prepare(`
      INSERT INTO tool_executions (id, task_id, project_id, tool, runner_id, status, input_json,
        output_json, error, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.taskId ?? null, input.projectId ?? null, input.tool, input.runnerId ?? null,
      input.status, JSON.stringify(input.input ?? {}),
      input.output === undefined ? null : JSON.stringify(input.output), input.error ?? null,
      input.durationMs, now());
    return id;
  }

  private agentOf(row: Row): string | null {
    try {
      const parsed = JSON.parse(row.input_json) as { agent?: string };
      return typeof parsed.agent === 'string' ? parsed.agent : null;
    } catch { return null; }
  }

  /** True when `from` can reach `to` through dependency edges. */
  private reaches(from: string, to: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === to) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const dep of this.dependenciesOf(cur)) stack.push(dep);
    }
    return false;
  }
}

export interface StepContext {
  task: TaskRecord;
  attempt: number;
  signal: AbortSignal;
  /** Outputs of this task's dependencies, keyed by task id. */
  dependencyOutputs: Record<string, unknown>;
  store: TaskStore;
}

export type StepHandler = (ctx: StepContext) => unknown | Promise<unknown>;

export interface RunReport {
  rootId: string;
  status: TaskStatus;
  tasks: { id: string; title: string; kind: string; status: TaskStatus; attempt: number; error: string | null }[];
  completed: number;
  failed: number;
  cancelled: number;
  durationMs: number;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Called after every state change, so the UI can follow the run live. */
  onEvent?: (event: { taskId: string; title: string; status: TaskStatus; attempt: number; error?: string | null }) => void;
}

/**
 * Model-independent orchestrator (spec 9).
 * It owns the plan, the dependencies, the retries, the cancellation and the
 * resumability. Deciding *what* a step does is the handler's job, which is where
 * a model may or may not be involved.
 */
export class Orchestrator {
  private readonly handlers = new Map<string, StepHandler>();

  constructor(readonly store: TaskStore) {}

  register(kind: string, handler: StepHandler): void {
    this.handlers.set(kind, handler);
  }

  /**
   * Execute the DAG rooted at `rootId` in dependency order.
   * Sequential by design: deterministic, cheaper, and easier to audit.
   */
  async run(rootId: string, opts: RunOptions = {}): Promise<RunReport> {
    const started = Date.now();
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const emit = (t: TaskRecord, status: TaskStatus, error?: string | null): void =>
      opts.onEvent?.({ taskId: t.id, title: t.title, status, attempt: t.attempt, error });

    try {
      for (;;) {
        if (controller.signal.aborted) break;
        const tree = this.store.tree(rootId);
        const byId = new Map(tree.map((t) => [t.id, t]));
        const runnable = tree.filter((t) => {
          if (TERMINAL.includes(t.status)) return false;
          return this.store.dependenciesOf(t.id).every((d) => byId.get(d)?.status === 'completed');
        });
        if (runnable.length === 0) break;

        const task = runnable[0]!;
        const handler = this.handlers.get(task.kind);
        if (!handler) {
          const failed = this.store.setStatus(task.id, 'failed', { error: `No handler registered for kind "${task.kind}"` });
          emit(failed, 'failed', failed.error);
          continue;
        }

        // One bump per execution attempt, exactly once, when the attempt starts.
        const running = this.store.setStatus(task.id, task.attempt === 0 ? 'running' : 'retrying', { bumpAttempt: true });
        emit(running, running.status);

        const dependencyOutputs: Record<string, unknown> = {};
        for (const dep of this.store.dependenciesOf(task.id)) {
          dependencyOutputs[dep] = this.store.get(dep)?.output ?? null;
        }

        const stepStarted = Date.now();
        try {
          const output = await handler({ task: running, attempt: running.attempt, signal: controller.signal, dependencyOutputs, store: this.store });
          if (controller.signal.aborted) throw new NexusError('internal', 'cancelled');
          const done = this.store.setStatus(task.id, 'completed', { output, error: null });
          this.store.recordToolExecution({
            taskId: task.id, projectId: task.projectId, tool: task.kind, status: 'ok',
            input: task.input, output, durationMs: Date.now() - stepStarted,
          });
          emit(done, 'completed');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.store.recordToolExecution({
            taskId: task.id, projectId: task.projectId, tool: task.kind,
            status: controller.signal.aborted ? 'denied' : 'error',
            input: task.input, error: message, durationMs: Date.now() - stepStarted,
          });
          if (controller.signal.aborted) {
            const c = this.store.setStatus(task.id, 'cancelled', { error: 'cancelled' });
            emit(c, 'cancelled', c.error);
            break;
          }
          if (running.attempt < running.maxAttempts) {
            // Stay runnable: the next loop iteration bumps the attempt and retries.
            const retrying = this.store.setStatus(task.id, 'retrying', { error: message });
            emit(retrying, 'retrying', message);
            continue;
          }
          const failed = this.store.setStatus(task.id, 'failed', { error: message });
          emit(failed, 'failed', message);
        }
      }

      if (controller.signal.aborted) this.cancelTree(rootId, 'cancelled by request');
      // A task whose dependency failed can never run: mark it cancelled, not failed.
      this.cancelBlocked(rootId);
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }

    const tree = this.store.tree(rootId);
    const root = tree.find((t) => t.id === rootId)!;
    const counts = { completed: 0, failed: 0, cancelled: 0, pending: 0 };
    for (const t of tree) {
      if (t.status === 'completed') counts.completed += 1;
      else if (t.status === 'failed') counts.failed += 1;
      else if (t.status === 'cancelled') counts.cancelled += 1;
      else counts.pending += 1;
    }
    const overall: TaskStatus =
      counts.failed > 0 ? 'failed'
        : counts.pending > 0 ? 'running'
          : counts.cancelled > 0 && counts.completed === 0 ? 'cancelled'
            : 'completed';
    if (root.status !== overall && TERMINAL.includes(overall)) this.store.setStatus(rootId, overall, { output: root.output, error: root.error });

    return {
      rootId, status: overall, durationMs: Date.now() - started,
      completed: counts.completed, failed: counts.failed, cancelled: counts.cancelled,
      tasks: tree.map((t) => ({ id: t.id, title: t.title, kind: t.kind, status: t.status, attempt: t.attempt, error: t.error })),
    };
  }

  cancelTree(rootId: string, reason = 'cancelled'): void {
    for (const t of this.store.tree(rootId)) {
      if (!TERMINAL.includes(t.status)) this.store.setStatus(t.id, 'cancelled', { error: reason });
    }
  }

  /** Tasks downstream of a failure will never become runnable. */
  private cancelBlocked(rootId: string): void {
    const tree = this.store.tree(rootId);
    const byId = new Map(tree.map((t) => [t.id, t]));
    for (const t of tree) {
      if (TERMINAL.includes(t.status)) continue;
      const blocked = this.store.dependenciesOf(t.id).some((d) => {
        const dep = byId.get(d);
        return dep && (dep.status === 'failed' || dep.status === 'cancelled');
      });
      if (blocked) this.store.setStatus(t.id, 'cancelled', { error: 'blocked by a failed dependency' });
    }
  }

  /**
   * Resume a run that was interrupted (process restart, network cut).
   * Tasks left in a non-terminal state are re-executed from their current attempt.
   */
  async resume(rootId: string, opts: RunOptions = {}): Promise<RunReport> {
    for (const t of this.store.tree(rootId)) {
      if (t.status === 'running' || t.status === 'waiting' || t.status === 'retrying') {
        this.store.setStatus(t.id, 'ready', { error: null });
      }
    }
    return this.run(rootId, opts);
  }
}

function toRecord(r: Row, agent: string | null): TaskRecord {
  return {
    id: r.id, parentId: r.parent_id, projectId: r.project_id, conversationId: r.conversation_id,
    title: r.title, kind: r.kind, agent,
    status: r.status as TaskStatus,
    attempt: r.attempt, maxAttempts: r.max_attempts,
    input: safeParse<Record<string, unknown>>(r.input_json, {}),
    output: r.output_json === null ? null : safeParse<unknown>(r.output_json, null),
    error: r.error,
    acceptance: safeParse<string[]>(r.acceptance_json ?? '[]', []),
    startedAt: r.started_at, finishedAt: r.finished_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function safeParse<T>(json: string, fallback: T): T {
  try { return JSON.parse(json) as T; } catch { return fallback; }
}
