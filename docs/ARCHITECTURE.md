# NEXUS OMEGA — Architecture & technical decisions

Version 0.1 · 2026-10-12

## 1. Three planes, strictly separated

```
┌─────────────────────────────  CONTROL PLANE  ─────────────────────────────┐
│  apps/web   React + TypeScript + Vite (static build)                      │
│  apps/api   Fastify + TypeScript: auth, secrets, routing, budgets,         │
│             projects, tasks, council, judge, audit                        │
│  Storage    SQLite (better-sqlite3) + filesystem for artefacts/logs        │
└────────────────────────────────────────────────────────────────────────────┘
                                   │  HTTPS, JSON, SSE
┌─────────────────────────────  EXECUTION PLANE ────────────────────────────┐
│  apps/runner  Node.js + TypeScript. Runs commands, installs dependencies,  │
│               builds, serves previews, drives Playwright, exports ZIP.     │
│               Adapters: local sandbox · remote Docker · HTTPS runner ·     │
│                         static-only fallback                               │
│               Every runner *declares* its real capabilities.               │
└────────────────────────────────────────────────────────────────────────────┘
                                   │
┌─────────────────────────────  MODEL PLANE  ───────────────────────────────┐
│  packages/providers  OpenRouter + Hugging Face Inference Providers         │
│  packages/router     free-first smart routing + fallback                   │
│  packages/finops     estimation, reservation, reconciliation, caps         │
└────────────────────────────────────────────────────────────────────────────┘
```

Rule: **the control plane never executes a shell command.** Anything that needs a
process, a compiler or a browser goes through the runner, and the runner reports
what it actually did. A build is only "successful" when the process exited 0 *and*
the expected artefacts exist on disk.

## 2. Stack decision and justification

The reference proposal was "PHP on shared hosting for the API". It is **partially
adopted**, and the deviation is deliberate:

| Component | Chosen | Why |
|---|---|---|
| UI | React + TypeScript + Vite | As proposed. Produces a static bundle that shared hosting serves natively. |
| Control plane API | **Node.js + TypeScript (Fastify)** for development and for the runner host | (1) The execution plane is Node-only, so a PHP API would need a second language for the same domain model. (2) Shared TypeScript contracts across `packages/*` remove an entire class of drift bugs. (3) Streaming (SSE/WebSocket) and long-lived orchestrations are not viable under a PHP-FPM request model. (4) Shared hosting cannot run the runner at all, so the API would be split from its own tools. |
| Public hosting of the UI | Hostinger shared (LiteSpeed) | Static files only — genuinely supported. |
| Public hosting of the API | **Phase 7 decision**, two supported shapes: (a) static UI + a thin PHP gateway on shared hosting that forwards to an external API/runner, (b) static UI + external API on a VPS | Shared hosting cannot hold a Node daemon (see §3). |
| Data | SQLite for the control plane, MySQL/MariaDB available behind a driver interface | SQLite is zero-ops on a VPS; the repository layer isolates SQL so a MySQL driver can be added for the PHP/shared-hosting shape. |
| Runner isolation | Docker where available, otherwise an OS-level sandbox with a non-privileged user, resource limits and no host socket | Docker is not present on every dev machine; the adapter declares which mode is active. |
| Browser tests | Playwright inside the runner | As proposed. |

## 3. Hostinger shared hosting — assessed capabilities

Verified from public 2026 sources; **must be re-verified against the actual account
before any deployment** (`infrastructure/hostinger/probe.php`, Phase 7).

| Capability | Shared web hosting | Consequence |
|---|---|---|
| PHP 8.x + LiteSpeed | ✅ | PHP gateway is viable |
| MySQL / MariaDB + phpMyAdmin | ✅ | Relational storage is viable |
| Static files / `.htaccess` | ✅ | Vite build deploys directly |
| Cron jobs | ✅ (limited) | Scheduled maintenance only |
| FTP / SFTP | ✅ | Deployment transport |
| SSH + Git | ⚠️ higher plans only | Detect, never assume |
| Node.js / Python runtime | ❌ | No runner and no Node API on shared hosting |
| Docker | ❌ (VPS only) | Builds must run elsewhere |
| Zero-downtime / atomic deploy | ❌ | Deploy via staged directory + swap, with backup |

**Hard rule:** NEXUS OMEGA never treats a shared plan as a VPS. If the runner is
unreachable, the Web Factory reports `runner_unavailable` — it does not pretend to
have compiled anything.

## 4. Security model

1. **Secrets** live only in `apps/api`. AES-256-GCM (`packages/security/vault.ts`),
   key derived from `NEXUS_MASTER_KEY` with scrypt. The browser receives a
   fingerprint, never the key.
2. **Sessions** are database rows; only a SHA-256 of the cookie value is stored.
3. **CSRF** uses double-submit, and the submitted value must match the hash bound
   to the session — a stolen cookie alone is not enough.
4. **Validation** at the edge with Zod; unknown fields are rejected, not ignored.
5. **Untrusted content** (files, web content, model output) is scanned, fenced with
   a nonce and labelled as data (`packages/security/injection.ts`).
6. **Redaction** runs before anything is logged or sent to a model
   (`packages/security/redact.ts`).
7. **SSRF guard** allowlists model endpoints and refuses loopback/private targets
   (`packages/security/ssrf.ts`).
8. **Audit**: every sensitive action, denial and error lands in `audit_logs`.
9. **Cost control**: unknown cost is never treated as zero; a paid call requires an
   explicit policy, an available budget and compatible capabilities.

## 5. Persistence and resumability

`localStorage` is never a system of record. Projects, tasks, builds, tests,
deployments, usage and audit entries are SQLite rows. A task keeps
`status`, `attempt`, `max_attempts`, `input_json`, `output_json` and `error`, so an
interrupted run can be resumed or retried deterministically.

## 6. Capability registry

`packages/shared/src/capabilities.ts` is the single source of truth for "what does
this system really do". Each entry carries the official endpoint, the parameters,
the implementation status, the test that proves it and the date the documentation
was verified. `GET /api/meta/capabilities` exposes it, and the UI renders it — a
feature that is only planned is shown as planned.
