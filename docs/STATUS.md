# Implementation status

Updated 2026-10-12.

## Phase 0 — Foundations: DONE

Delivered:
- Monorepo (npm workspaces, 15 packages/apps), strict TypeScript, Vitest.
- `database/migrations/0001_init.sql` — 25 tables covering every entity required by
  the specification (users … audit_logs), with indexes and foreign keys.
- Versioned migration runner that refuses to re-run an edited migration.
- Authentication: register / login / logout / me / change-password, scrypt hashing,
  server-side sessions, hashed cookie values, double-submit CSRF, rate limiting,
  audit logging, security headers + CSP.
- Secret vault (AES-256-GCM) + credential API that never returns plaintext.
- Guards: path traversal, symlink escape, SSRF, prompt injection, secret redaction.
- Capability registry exposed at `GET /api/meta/capabilities`.
- Premium dark/holographic UI with a real WebGL orb (three.js) and CSS fallback,
  code-split so the orb does not block first paint.

Verified by:
- `npm run typecheck` → 15 workspaces, 0 errors.
- `npm test` → 71 tests / 10 files, all passing, including an end-to-end test that
  boots the API on a real TCP port and drives it with `fetch`.
- `npm run build -w @nexus/web` → production bundle built.

## Not started

| Phase | Content |
|---|---|
| 1 | OpenRouter + Hugging Face clients, model sync, chat, streaming, usage |
| 2 | Smart router (free-first), fallback, budgets, cost dashboard |
| 3 | Orchestrator, task graph, agent registry, resumability |
| 4 | AI Council, debate, Judge engine |
| 5 | Web Factory: projects, files, runner, terminal, dependencies, build, export |
| 6 | Playwright tests, preview, screenshots, self-healing loop |
| 7 | Deployment (Hostinger static/PHP, SFTP, verification, rollback) |
| 8 | Multimodal, RAG, memory, extra frameworks |

The packages `providers`, `model-registry`, `router`, `finops`, `orchestrator`,
`agents`, `council`, `judge`, `web-factory` and `tools` exist as reserved slots.
They export `IMPLEMENTED = false` and are wired to nothing.
