import { NexusError, type RoutingMode } from '@nexus/shared';
import { AgentRegistry } from '@nexus/agents';
import { Orchestrator, TaskStore, type TaskRecord } from '@nexus/orchestrator';
import type { AppContext } from '../context.js';
import type { ChatService } from './chat.service.js';
import { wrapUntrusted } from '@nexus/security';

export interface OrchestrateInput {
  userId: string;
  title: string;
  routingMode: RoutingMode;
  conversationId?: string;
  projectId?: string;
  steps: {
    title: string; prompt: string; agent: string; task: string;
    dependsOn: number[]; maxAttempts: number;
  }[];
  run: boolean;
}

/**
 * Turns a request into a persisted task DAG and executes it.
 *
 * The planner here is deterministic and rule-driven: the caller supplies the
 * steps, the service validates the graph and runs it. The only registered
 * handler (`ai.step`) performs a real routed model call - nothing is simulated.
 */
export class OrchestrationService {
  readonly store: TaskStore;
  readonly orchestrator: Orchestrator;
  readonly agents: AgentRegistry;

  constructor(private readonly ctx: AppContext, private readonly chat: ChatService) {
    this.store = new TaskStore(ctx.db);
    this.orchestrator = new Orchestrator(this.store);
    this.agents = new AgentRegistry(ctx.db);
    this.agents.seed();
    this.orchestrator.register('ai.step', (step) => this.aiStep(step));
  }

  plan(input: OrchestrateInput): { rootId: string; stepIds: string[]; conversationId: string } {
    // An orchestration always lives inside a conversation, so the whole run is
    // visible in the chat history and the owner is resolvable from the task.
    const conversationId = input.conversationId
      ?? this.chat.openConversation(input.userId, input.title, { projectId: input.projectId ?? null, routingMode: input.routingMode });
    // Validate dependency indexes before writing anything.
    for (const [i, s] of input.steps.entries()) {
      for (const dep of s.dependsOn) {
        if (dep >= input.steps.length) {
          throw new NexusError('validation', `Step ${i} depends on out-of-range index ${dep}`);
        }
        if (dep >= i) {
          throw new NexusError('validation', `Step ${i} cannot depend on a later step (${dep})`);
        }
      }
      if (!this.agents.get(s.agent)) {
        throw new NexusError('validation', `Unknown agent "${s.agent}" on step ${i}`);
      }
    }

    const root = this.store.create({
      title: input.title,
      kind: 'plan',
      projectId: input.projectId ?? null,
      conversationId,
      agent: 'planner',
      acceptance: input.steps.map((s) => s.title),
      maxAttempts: 1,
    });

    const stepIds = input.steps.map((s, i) => this.store.create({
      title: s.title,
      kind: 'ai.step',
      parentId: root.id,
      projectId: input.projectId ?? null,
      conversationId,
      agent: s.agent,
      maxAttempts: s.maxAttempts,
      input: { prompt: s.prompt, task: s.task, routingMode: input.routingMode, index: i },
      acceptance: [`Step "${s.title}" produced an output`],
      // Every step depends on the plan node; inter-step edges are added below,
      // once all step ids exist.
      dependsOn: [root.id],
    }).id);

    // Re-link the real indexes now that every step exists.
    input.steps.forEach((s, i) => {
      for (const dep of s.dependsOn) this.store.addDependency(stepIds[i]!, stepIds[dep]!);
    });

    // The plan node itself is complete once the graph exists.
    this.store.setStatus(root.id, 'completed', { output: { steps: stepIds, conversationId } });
    return { rootId: root.id, stepIds, conversationId };
  }

  async execute(input: OrchestrateInput) {
    const { rootId } = this.plan(input);
    const events: { taskId: string; title: string; status: string; attempt: number; error?: string | null }[] = [];
    const report = await this.orchestrator.run(rootId, {
      onEvent: (e) => events.push({ ...e, status: e.status }),
    });
    this.ctx.audit.log({
      userId: input.userId, action: 'orchestrate.run', targetType: 'task', targetId: rootId,
      outcome: report.status === 'completed' ? 'ok' : report.status === 'cancelled' ? 'ok' : 'error',
      detail: { status: report.status, completed: report.completed, failed: report.failed, cancelled: report.cancelled, durationMs: report.durationMs },
    });
    return { rootId, report, events };
  }

  /** Resumability entry point: re-run a task graph left in a non-terminal state. */
  async resume(rootId: string, userId: string) {
    const root = this.store.get(rootId);
    if (!root) throw new NexusError('not_found', `Unknown task ${rootId}`);
    const report = await this.orchestrator.resume(rootId);
    this.ctx.audit.log({ userId, action: 'orchestrate.resume', targetType: 'task', targetId: rootId, detail: { status: report.status } });
    return report;
  }

  cancel(rootId: string, userId: string): void {
    const root = this.store.get(rootId);
    if (!root) throw new NexusError('not_found', `Unknown task ${rootId}`);
    this.orchestrator.cancelTree(rootId, 'cancelled by user');
    this.ctx.audit.log({ userId, action: 'orchestrate.cancel', targetType: 'task', targetId: rootId });
  }

  taskView(rootId: string): TaskRecord[] {
    return this.store.tree(rootId);
  }

  /** Real routed model call. Previous step outputs are passed as untrusted context. */
  private async aiStep(step: { task: TaskRecord; dependencyOutputs: Record<string, unknown> }): Promise<unknown> {
    const input = step.task.input as { prompt?: string; task?: string; routingMode?: RoutingMode };
    const userId = this.ctx.ownerOf(step.task.conversationId ?? step.task.projectId);
    if (!userId) throw new NexusError('unauthorized', 'This task is not attached to a user');

    const previous = Object.entries(step.dependencyOutputs)
      .filter(([id]) => id !== step.task.parentId)
      .map(([id, out]) => `--- sortie de ${id} ---\n${JSON.stringify(out)}`)
      .join('\n');

    const agent = this.agents.get(step.task.agent ?? 'orchestrator');
    const message = [
      agent ? `Rôle : ${agent.displayName}. ${agent.instructions}` : '',
      `Tâche : ${step.task.title}`,
      `Critère d'acceptation : ${step.task.acceptance.join('; ') || 'aucun'}`,
      previous ? wrapUntrusted(previous, 'previous-step-output', step.task.id.slice(-8)) : '',
      `Demande : ${input.prompt ?? ''}`,
    ].filter(Boolean).join('\n\n');

    const outcome = await this.chat.send(userId, {
      message,
      routingMode: input.routingMode ?? 'free_first',
      stream: false,
      conversationId: step.task.conversationId ?? undefined,
      projectId: step.task.projectId ?? undefined,
      agent: step.task.agent ?? undefined,
      task: (input.task ?? 'chat') as never,
    });

    this.agents.recordRun({
      agentKey: step.task.agent ?? 'orchestrator',
      taskId: step.task.id,
      projectId: step.task.projectId,
      modelId: outcome.modelId,
      status: 'ok',
      tokensIn: outcome.tokensIn,
      tokensOut: outcome.tokensOut,
      costUsd: outcome.cost.billedUsd ?? outcome.cost.estimatedUsd,
      costStatus: outcome.cost.status,
      result: { text: outcome.text.slice(0, 4000) },
      startedAt: Date.now() - outcome.latencyMs,
      finishedAt: Date.now(),
    });

    return { text: outcome.text, modelId: outcome.modelId, cost: outcome.cost };
  }
}
