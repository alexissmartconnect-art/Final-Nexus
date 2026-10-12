# NEXUS OMEGA

**AI Operating System · Multi-agent intelligence · Universal Web Factory**

NEXUS OMEGA is a single product where you talk to AI models, make several of them
collaborate and debate, control exactly what they cost, and have them build, test,
preview and publish real web projects.

Built from an empty repository — there is no legacy NEXUS code in here.

---

## Current status — Phase 0 delivered and verified

| Area | State | Proof |
|---|---|---|
| Monorepo, TypeScript, workspaces | ✅ done | `npm run typecheck` — 15 workspaces, 0 errors |
| Database schema + versioned migrations | ✅ done | 25 tables, `packages/db/tests/migrate.test.ts` |
| Authentication (sessions, CSRF, rate limit) | ✅ done | `apps/api/tests/auth.test.ts` (13 tests) |
| Encrypted secret vault (AES-256-GCM) | ✅ done | `packages/security/tests/vault.test.ts` |
| Path traversal / symlink / SSRF guards | ✅ done | `paths.test.ts`, `ssrf.test.ts` |
| Prompt-injection & secret redaction | ✅ done | `injection.test.ts`, `redact.test.ts` |
| Capability registry (OpenRouter / HF) | ✅ done | `GET /api/meta/capabilities` |
| Premium UI + WebGL orb | ✅ done | `npm run build -w @nexus/web` |
| API boot over real TCP | ✅ done | `tests/e2e/boot.test.ts` |
| Live model calls (OpenRouter / HF) | ⛔ Phase 1 | code not written yet |
| Smart router, budgets, council, judge | ⛔ Phase 2-4 | reserved packages |
| Web Factory, runner, Playwright | ⛔ Phase 5-6 | reserved packages |
| Deployment | ⛔ Phase 7 | reserved packages |

`⛔` means **not implemented**. Nothing in the interface pretends otherwise: unimplemented
sections are visible but disabled and labelled with their phase.

Test suite: **71 tests, 10 files, all passing** (`npm test`).

---

## Quick start

```bash
npm install
npm run setup      # creates .env with a generated master key, installs deps, migrates the DB
npm run db:migrate # optional, setup already does it

npm run dev:api    # control plane API  -> http://localhost:8787
npm run dev:web    # UI                 -> http://localhost:5173  (proxies /api to the API)
```

Or simply `bash scripts/dev.sh` to start both.

Open http://localhost:5173, create an account — **the first account becomes the administrator**.

## Tests

```bash
npm test                # full suite (unit + integration + e2e over real TCP)
npm run typecheck       # every workspace
npm run build           # production build of the UI
```

## Layout

```
apps/
  web/       React + TypeScript + Vite UI (static build, Hostinger-compatible)
  api/       Fastify + TypeScript control plane (auth, secrets, routing, projects)
  runner/    reserved: isolated execution plane
packages/
  shared/         contracts, schemas, capability registry
  security/       vault, password hashing, path/SSRF/injection/redaction guards
  db/             SQLite access + versioned migrations
  providers/      reserved: OpenRouter + Hugging Face clients
  model-registry/ router/ finops/ orchestrator/ agents/ council/ judge/
  web-factory/ tools/      reserved for later phases
database/migrations/       versioned SQL, never edit an applied file
docs/                      architecture and decisions
infrastructure/            docker + hostinger deployment assets
tests/                     cross-cutting e2e tests
```

## Security posture (already enforced)

- API keys are encrypted at rest with AES-256-GCM and **never** returned to the browser;
  the client only ever sees a fingerprint.
- Sessions are server-side rows; the cookie value is stored hashed (SHA-256).
- State-changing routes require a double-submit CSRF token bound to the session.
- CSP, `X-Frame-Options: DENY`, `nosniff`, referrer and permissions policies on every response.
- Passwords hashed with scrypt (N=16384, r=8, p=1) and compared in constant time.
- Login and per-route rate limits return `429` with a Nexus error code.
- Every sensitive action is written to `audit_logs`; secrets are redacted before any log.
- Workspace path validation rejects traversal, absolute paths, NUL bytes, `.git`/`node_modules`
  and symlinks that escape the workspace.
- Outbound model traffic is confined to an allowlist and refuses private/loopback addresses.

## What is explicitly *not* claimed

- No model call has been made from this repository yet — the provider clients are Phase 1.
- No build, test or deployment has been executed on a third-party service.
- Hostinger shared hosting is **not** assumed to run Docker, a Node.js daemon or Python;
  see `docs/ARCHITECTURE.md` for the real capability assessment.
