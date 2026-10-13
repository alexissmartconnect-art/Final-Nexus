import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().min(3).max(254).email();
export const passwordSchema = z.string().min(10).max(256);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(80).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
  remember: z.boolean().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

export const credentialSchema = z.object({
  provider: z.enum(['openrouter', 'huggingface', 'runner']),
  label: z.string().trim().min(1).max(60).default('default'),
  secret: z.string().min(8).max(4096),
});

export const routingModeSchema = z.enum([
  'free_only', 'free_first', 'economic', 'balanced', 'quality', 'speed', 'manual', 'multi',
]);
export type RoutingMode = z.infer<typeof routingModeSchema>;

export const taskKindSchema = z.enum([
  'chat', 'code', 'analysis', 'summarization', 'translation',
  'structured_output', 'tool_use', 'vision', 'reasoning',
]);
export type TaskKindInput = z.infer<typeof taskKindSchema>;

export const chatRequestSchema = z.object({
  conversationId: z.string().min(1).optional(),
  message: z.string().min(1).max(100_000),
  routingMode: routingModeSchema.default('free_first'),
  modelId: z.string().min(1).optional(),
  stream: z.boolean().default(true),
  projectId: z.string().min(1).optional(),
  agent: z.string().min(1).max(40).optional(),
  task: taskKindSchema.default('chat'),
  privacy: z.enum(['any', 'no_training']).default('any'),
});

export const orchestrateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  routingMode: routingModeSchema.default('free_first'),
  conversationId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  steps: z.array(z.object({
    title: z.string().trim().min(1).max(200),
    prompt: z.string().min(1).max(100_000),
    agent: z.string().min(1).max(40).default('orchestrator'),
    task: taskKindSchema.default('chat'),
    /** Indexes (0-based, within `steps`) of the steps this one depends on. */
    dependsOn: z.array(z.number().int().min(0)).default([]),
    maxAttempts: z.number().int().min(1).max(10).default(2),
  })).min(1).max(50),
  run: z.boolean().default(true),
});

export const agentUpdateSchema = z.object({
  instructions: z.string().min(1).max(20_000).optional(),
  tools: z.array(z.string().min(1).max(60)).max(50).optional(),
  budgetUsd: z.number().min(0).nullable().optional(),
  maxRuns: z.number().int().min(1).max(10_000).optional(),
  enabled: z.boolean().optional(),
});

export const budgetUpsertSchema = z.object({
  limitUsd: z.number().min(0).max(1_000_000),
  scope: z.enum(['account', 'project', 'agent']).default('account'),
  scopeId: z.string().min(1).optional(),
  period: z.enum(['total', 'daily', 'monthly']).default('total'),
  allowPaid: z.boolean().default(false),
  freeOnly: z.boolean().default(false),
  actionOnExceed: z.enum(['block', 'warn']).default('block'),
});

export const routeExplainSchema = z.object({
  message: z.string().min(1).max(100_000),
  routingMode: routingModeSchema.default('free_first'),
  task: taskKindSchema.default('chat'),
  privacy: z.enum(['any', 'no_training']).default('any'),
  modelId: z.string().min(1).optional(),
  maxOutputTokens: z.number().int().min(1).max(32_000).default(512),
});

export const budgetSchema = z.object({
  scope: z.enum(['account', 'project', 'agent']).default('account'),
  scopeId: z.string().optional(),
  limitUsd: z.number().min(0).max(1_000_000),
  period: z.enum(['total', 'daily', 'monthly']).default('total'),
  allowPaid: z.boolean().default(false),
  freeOnly: z.boolean().default(false),
  actionOnExceed: z.enum(['block', 'warn']).default('block'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CredentialInput = z.infer<typeof credentialSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type BudgetInput = z.infer<typeof budgetSchema>;
