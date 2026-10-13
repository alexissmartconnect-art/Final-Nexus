# Implementation status

Updated 2026-10-12.

## Phase 0 — Foundations: DONE

- Monorepo (npm workspaces, 15 packages/apps), strict TypeScript, Vitest.
- `database/migrations/0001_init.sql` — 25 tables (users … audit_logs) with indexes
  and foreign keys, covering every entity required by the specification.
- Versioned migration runner that refuses to re-run an edited migration.
- Authentication: register / login / logout / me / change-password, scrypt hashing,
  server-side sessions, hashed cookie values, double-submit CSRF, rate limiting,
  audit logging, security headers + CSP.
- Secret vault (AES-256-GCM) + credential API that never returns plaintext.
- Guards: path traversal, symlink escape, SSRF, prompt injection, secret redaction.
- Capability registry exposed at `GET /api/meta/capabilities`.
- Premium dark/holographic UI with a real WebGL orb (three.js) and CSS fallback,
  code-split so the orb does not block first paint.

## Phase 1 — OpenRouter + Hugging Face: DONE (integration, not live calls)

Delivered:
- `packages/providers`: OpenRouter and Hugging Face Inference Providers clients.
  - `POST /api/v1/chat/completions` (both), streaming and non-streaming.
  - `GET /api/v1/models`, `GET /api/v1/key`, `GET /api/v1/credits` (OpenRouter).
  - `GET /v1/models` on the router and `GET /api/models` on the Hub (Hugging Face),
    kept apart: **listed on the Hub ≠ served by an Inference Provider**.
  - Only documented parameters are sent; anything else is reported in
    `unsupportedParams` instead of being silently transmitted.
  - Bounded retry on 408/409/429/5xx honouring `Retry-After`, no infinite loop.
  - Every request passes the SSRF guard; a non-allowlisted base URL is refused at
    construction time.
- `packages/model-registry`: unified catalogue in SQLite. Unknown capabilities stay
  `NULL`; free vs paid vs unknown pricing tiers; availability flag.
- API: `GET /api/providers`, `POST /api/providers/:provider/sync`, `GET /api/models`,
  `GET /api/conversations`, `GET /api/conversations/:id/messages`, `POST /api/chat`
  (JSON or SSE), `GET /api/usage`.
- Cost accounting distinguishes **billed** (provider reported `usage.cost`),
  **estimated** (computed from catalogue prices), **free** and **unknown**.
  Unknown is never reported as zero.
- `free_only` routing refuses to fall back to a paid model and answers 402 with an
  explicit message (acceptance test 2).
- Custom endpoints supported via `OPENROUTER_BASE_URL` / `HF_ROUTER_BASE_URL` /
  `HF_HUB_BASE_URL` for self-hosted proxies; the SSRF allowlist still applies.
- UI: Chat page (real SSE consumption, model + cost per answer, conversation list)
  and Models page (provider health, catalogue sync, filters).

**Not yet done in this phase:** no call has been made to the real `openrouter.ai` or
`huggingface.co` endpoints from this environment — those hosts are not reachable from
the build sandbox. The clients are verified against a real local HTTP server that
implements the documented response shapes (`tests/contracts/*`). The first live call
must be made with a real key to close the loop.

## Phase 2 — Routing & budgets: DONE

- `packages/finops` — Cost Engine: token estimation, price-based estimation,
  budget policies (`budget_policies`), reservation **before** the call,
  reconciliation with the provider-reported cost afterwards, per-model and per-day
  summaries. A genuinely free call is never blocked by a USD ceiling; an unknown
  price is never treated as free.
- `packages/router` — Smart Router: 8 modes (free_only, free_first, economic,
  balanced, quality, speed, manual, multi). Pipeline: task kind → required
  capabilities → context estimate → hard filters (availability, capabilities,
  context, privacy) → cost estimate → budget → ranking → bounded fallback chain.
  Every rejection keeps its reason.
- `POST /api/router/explain`: dry run that shows the choice and every rejection
  without calling a provider or spending anything.
- `GET/PUT /api/budgets`: policies + real consumption.
- `GET /api/usage` now returns the shared `UsageSummary` contract plus policies.
- UI: Budgets page (policy form, spend bar, per-model table) and a "Pourquoi ce
  modèle ?" disclosure in the chat showing the routing trace.

Acceptance criteria verified by `apps/api/tests/budget-router.test.ts` (8 tests):
- **Test 5** — budget exhausted: paid call blocked with `402 budget_exceeded`, an
  actionable alternative, and **zero** provider requests issued.
- **Test 6** — provider 429: exactly 3 bounded retries on the failing model, then
  fallback to a *capability-compatible* model, `chat.fallback` written to the audit
  log, no infinite loop.

## Phase 3 — Orchestrator & agents: DONE

- `database/migrations/0002_task_dependencies.sql` — `task_dependencies(task_id,
  depends_on_id)`, the DAG edges of a task graph.
- `packages/agents` — the 17 configurable roles of the specification
  (orchestrator, planner, researcher, analyst, architect, designer, frontend_dev,
  backend_dev, db_expert, tester, fixer, security_expert, performance_expert,
  seo_expert, deployer, documentalist, judge). An agent is a *configuration*
  (role, instructions, allowed tools, model preference, budget, run cap), not
  necessarily a distinct model. Seeded on first boot, editable, run-counted.
- `packages/orchestrator` — `TaskStore` (10 persisted states
  `created → planning → ready → running → waiting → validating → retrying →
  completed → failed → cancelled`, attempts/max_attempts, acceptance criteria,
  dependency edges with cycle detection) and `Orchestrator` (execution in
  dependency order, one attempt bump per execution, bounded retries, cancellation
  through an `AbortController`, tasks downstream of a failure cancelled rather
  than failed, `resume()` for interrupted runs, one `tool_executions` row per
  step). The orchestrator is model-independent: a step handler decides what a
  step does.
- `POST /api/orchestrate` — plans a validated DAG and runs it. Each step is a
  **real routed model call** through `ChatService` (budget reservation, cost
  accounting and audit included). `run:false` persists the plan without calling
  any model.
- `GET /api/agents`, `PATCH /api/agents/:key`, `GET /api/tasks/:rootId`,
  `POST /api/tasks/:rootId/resume`, `POST /api/tasks/:rootId/cancel`.
- UI: Agents page (orchestration builder, live per-task report, agent roster).
- An orchestration always opens a conversation, so the whole run is readable in
  the chat history.

Verified by `packages/agents/tests/registry.test.ts` (5),
`packages/orchestrator/tests/orchestrator.test.ts` (13) and
`apps/api/tests/orchestration.test.ts` (9). The API test drives a real local
HTTP provider and asserts that a 3-step DAG produces **exactly 3 model calls in
dependency order**, that the agent role and the previous step's output reach the
next prompt as untrusted content, that a failing step stops after
`maxAttempts` (2 × 3 = 6 bounded provider calls, never more) and cancels what
depends on it, and that an invalid plan executes nothing.

Live probe (this sandbox, no OpenRouter egress): `GET /api/agents` → 401 without
a session, 17 agents once authenticated; `POST /api/orchestrate run:false` →
`plan:completed, ai.step:created, ai.step:created`; `run:true` → `failed` with the
real reason *"No model has been synchronised yet"* and the dependent task
cancelled. No fake success is reported.

## Not started

| Phase | Content |
|---|---|
| 4 | AI Council, debate, Judge engine |
| 5 | Web Factory: projects, files, runner, terminal, dependencies, build, export |
| 6 | Playwright tests, preview, screenshots, self-healing loop |
| 7 | Deployment (Hostinger static/PHP, SFTP, verification, rollback) |
| 8 | Multimodal, RAG, memory, extra frameworks |

The packages `council`, `judge`, `web-factory` and `tools` are still reserved
slots exporting `IMPLEMENTED = false`. `router`, `finops`, `agents` and
`orchestrator` are implemented.
