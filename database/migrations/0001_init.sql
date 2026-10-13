-- NEXUS OMEGA - initial schema
-- Dialect: SQLite (control plane). Versioned migration; never edit a released file,
-- add a new one instead.
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- identity
CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  password_hash   TEXT NOT NULL,              -- scrypt$N$r$p$salt$hash
  role            TEXT NOT NULL DEFAULT 'user', -- user | admin
  status          TEXT NOT NULL DEFAULT 'active',
  prefs_json      TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_login_at   INTEGER
);

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,       -- sha256(cookie value); raw value never stored
  csrf_token_hash TEXT NOT NULL,
  user_agent      TEXT,
  ip              TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  revoked_at      INTEGER
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ---------------------------------------------------------------- secrets
CREATE TABLE api_credentials (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,              -- openrouter | huggingface | runner | ...
  label           TEXT NOT NULL DEFAULT 'default',
  cipher_text     TEXT NOT NULL,              -- AES-256-GCM payload (iv|tag|ct)
  key_fingerprint TEXT NOT NULL,              -- sha256 prefix, safe to display
  scopes_json     TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'active', -- active | invalid | revoked
  last_verified_at INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(user_id, provider, label)
);

-- ---------------------------------------------------------------- models
CREATE TABLE providers (
  id              TEXT PRIMARY KEY,           -- openrouter | huggingface
  display_name    TEXT NOT NULL,
  base_url        TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_sync_at    INTEGER,
  last_sync_error TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE models (
  id              TEXT PRIMARY KEY,           -- canonical internal id: provider:externalId
  provider_id     TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  external_id     TEXT NOT NULL,
  name            TEXT NOT NULL,
  author          TEXT,
  license         TEXT,
  description     TEXT,
  context_length  INTEGER,                    -- NULL = unknown, never guessed
  max_output      INTEGER,
  modality_json   TEXT NOT NULL DEFAULT '[]',
  supports_tools  INTEGER,                    -- 1/0/NULL(unknown)
  supports_json   INTEGER,
  supports_stream INTEGER,
  supports_reasoning INTEGER,
  supports_vision INTEGER,
  supports_audio  INTEGER,
  supports_video  INTEGER,
  supports_embeddings INTEGER,
  pricing_tier    TEXT NOT NULL DEFAULT 'unknown', -- free | promo_credit | paid | unknown
  is_available    INTEGER NOT NULL DEFAULT 0,
  availability_note TEXT,
  inference_providers_json TEXT NOT NULL DEFAULT '[]',
  raw_json        TEXT,
  synced_at       INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(provider_id, external_id)
);
CREATE INDEX idx_models_provider ON models(provider_id);
CREATE INDEX idx_models_tier ON models(pricing_tier);
CREATE INDEX idx_models_available ON models(is_available);

CREATE TABLE model_capabilities (
  model_id        TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  value_json      TEXT NOT NULL,
  verified_at     INTEGER NOT NULL,
  PRIMARY KEY (model_id, key)
);

CREATE TABLE model_prices (
  id              TEXT PRIMARY KEY,
  model_id        TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  currency        TEXT NOT NULL DEFAULT 'USD',
  prompt_per_mtok REAL,                       -- NULL = unknown
  completion_per_mtok REAL,
  image_per_unit  REAL,
  request_price   REAL,
  is_free         INTEGER NOT NULL DEFAULT 0,
  free_quota_json TEXT,
  source          TEXT NOT NULL DEFAULT 'provider_catalog',
  synced_at       INTEGER NOT NULL
);
CREATE INDEX idx_prices_model ON model_prices(model_id);

-- ---------------------------------------------------------------- chat
CREATE TABLE conversations (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT,
  project_id      TEXT,
  mode            TEXT NOT NULL DEFAULT 'chat',  -- chat | council | factory
  routing_mode    TEXT NOT NULL DEFAULT 'free_first',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_conv_user ON conversations(user_id, updated_at DESC);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,                 -- user | assistant | system | tool
  content         TEXT NOT NULL,
  model_id        TEXT,
  agent           TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  cost_usd        REAL,                          -- NULL = unknown, never 0 by default
  cost_status     TEXT NOT NULL DEFAULT 'unknown', -- free | estimated | billed | unknown
  latency_ms      INTEGER,
  finish_reason   TEXT,
  tool_calls_json TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_msg_conv ON messages(conversation_id, created_at);

-- ---------------------------------------------------------------- projects
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  brief           TEXT,
  stack_json      TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'created', -- created|building|testing|ready|failed
  workspace_path  TEXT NOT NULL,
  budget_usd      REAL,
  spent_usd       REAL NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_projects_user ON projects(user_id);

CREATE TABLE project_files (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path            TEXT NOT NULL,                 -- workspace-relative, '/' separated
  kind            TEXT NOT NULL DEFAULT 'file',  -- file | dir
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  content_hash    TEXT,
  is_binary       INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  UNIQUE(project_id, path)
);

CREATE TABLE project_versions (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  manifest_json   TEXT NOT NULL,                 -- path -> sha256 snapshot
  backup_path     TEXT,
  created_by      TEXT NOT NULL DEFAULT 'system',
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_versions_project ON project_versions(project_id, created_at DESC);

-- ---------------------------------------------------------------- tasks / agents
CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  parent_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'created',
  -- created|planning|ready|running|waiting|validating|retrying|completed|failed|cancelled
  attempt         INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  input_json      TEXT NOT NULL DEFAULT '{}',
  output_json     TEXT,
  error           TEXT,
  acceptance_json TEXT,
  started_at      INTEGER,
  finished_at     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);

CREATE TABLE agent_definitions (
  id              TEXT PRIMARY KEY,
  key             TEXT NOT NULL UNIQUE,          -- planner | architect | builder | ...
  display_name    TEXT NOT NULL,
  role            TEXT NOT NULL,
  instructions    TEXT NOT NULL,
  tools_json      TEXT NOT NULL DEFAULT '[]',
  model_prefs_json TEXT NOT NULL DEFAULT '{}',
  budget_usd      REAL,
  max_runs        INTEGER NOT NULL DEFAULT 25,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE agent_runs (
  id              TEXT PRIMARY KEY,
  agent_key       TEXT NOT NULL REFERENCES agent_definitions(key) ON DELETE CASCADE,
  task_id         TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
  model_id        TEXT,
  status          TEXT NOT NULL DEFAULT 'running',
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  cost_usd        REAL,
  cost_status     TEXT NOT NULL DEFAULT 'unknown',
  result_json     TEXT,
  error           TEXT,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX idx_agent_runs_agent ON agent_runs(agent_key, started_at DESC);

-- ---------------------------------------------------------------- council / judge
CREATE TABLE council_sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  topic           TEXT NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'debate',  -- consult|compare|debate|critique|consensus|vote|judge|review
  status          TEXT NOT NULL DEFAULT 'created',
  participants_json TEXT NOT NULL DEFAULT '[]',
  rounds_json     TEXT NOT NULL DEFAULT '[]',
  synthesis       TEXT,
  total_cost_usd  REAL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE judge_evaluations (
  id              TEXT PRIMARY KEY,
  council_session_id TEXT REFERENCES council_sessions(id) ON DELETE CASCADE,
  task_id         TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  judge_model_id  TEXT,
  rubric_json     TEXT NOT NULL,
  scores_json     TEXT NOT NULL,
  ranking_json    TEXT NOT NULL DEFAULT '[]',
  recommended     TEXT,
  justification   TEXT,
  risks_json      TEXT NOT NULL DEFAULT '[]',
  uncertainties_json TEXT NOT NULL DEFAULT '[]',
  ground_truth_json TEXT,   -- real build/test results, always weigh above model opinions
  created_at      INTEGER NOT NULL
);

-- ---------------------------------------------------------------- execution
CREATE TABLE tool_executions (
  id              TEXT PRIMARY KEY,
  task_id         TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
  tool            TEXT NOT NULL,
  runner_id       TEXT,
  status          TEXT NOT NULL DEFAULT 'running', -- running|ok|error|denied|timeout
  input_json      TEXT NOT NULL,
  output_json     TEXT,
  error           TEXT,
  duration_ms     INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_tool_exec_tool ON tool_executions(tool, created_at DESC);

CREATE TABLE build_runs (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tool_exec_id    TEXT REFERENCES tool_executions(id) ON DELETE SET NULL,
  framework       TEXT NOT NULL,
  command         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running',
  exit_code       INTEGER,
  log_path        TEXT,
  artifacts_json  TEXT NOT NULL DEFAULT '[]',
  errors_json     TEXT NOT NULL DEFAULT '[]',
  duration_ms     INTEGER,
  created_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX idx_build_runs_project ON build_runs(project_id, created_at DESC);

CREATE TABLE test_runs (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,                 -- unit|browser|responsive|a11y|network|console
  status          TEXT NOT NULL DEFAULT 'running',
  passed          INTEGER NOT NULL DEFAULT 0,
  failed          INTEGER NOT NULL DEFAULT 0,
  skipped         INTEGER NOT NULL DEFAULT 0,
  report_json     TEXT,
  screenshots_json TEXT NOT NULL DEFAULT '[]',
  duration_ms     INTEGER,
  created_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX idx_test_runs_project ON test_runs(project_id, created_at DESC);

CREATE TABLE deployments (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target          TEXT NOT NULL,                 -- zip | hostinger_static | hostinger_php | sftp | github_actions | external
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|authorized|running|verified|failed|rolled_back
  authorized_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  authorized_at   INTEGER,
  artifact_path   TEXT,
  target_path     TEXT,
  public_url      TEXT,
  http_check_json TEXT,
  backup_path     TEXT,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX idx_deploy_project ON deployments(project_id, created_at DESC);

-- ---------------------------------------------------------------- finops
CREATE TABLE usage_records (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id     TEXT,
  model_id        TEXT,
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  agent_key       TEXT,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL DEFAULT 'completion',
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  cost_estimated_usd REAL,
  cost_billed_usd REAL,                        -- from provider usage.cost when returned
  cost_status     TEXT NOT NULL DEFAULT 'unknown', -- free|estimated|billed|unknown
  latency_ms      INTEGER,
  status          TEXT NOT NULL DEFAULT 'ok',
  error_code      TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_usage_user ON usage_records(user_id, created_at DESC);
CREATE INDEX idx_usage_project ON usage_records(project_id, created_at DESC);

CREATE TABLE budget_policies (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL DEFAULT 'account', -- account | project | agent
  scope_id        TEXT,
  limit_usd       REAL NOT NULL,
  period          TEXT NOT NULL DEFAULT 'total',   -- total | daily | monthly
  spent_usd       REAL NOT NULL DEFAULT 0,
  allow_paid      INTEGER NOT NULL DEFAULT 0,
  free_only       INTEGER NOT NULL DEFAULT 0,
  action_on_exceed TEXT NOT NULL DEFAULT 'block',  -- block | warn
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_budget_user ON budget_policies(user_id, scope);

-- ---------------------------------------------------------------- knowledge
CREATE TABLE knowledge_documents (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  source          TEXT,
  mime_type       TEXT,
  size_bytes      INTEGER,
  content_hash    TEXT NOT NULL,
  storage_path    TEXT NOT NULL,
  embedding_status TEXT NOT NULL DEFAULT 'pending', -- pending|indexed|unsupported|failed
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_knowledge_user ON knowledge_documents(user_id, created_at DESC);

-- ---------------------------------------------------------------- audit
CREATE TABLE audit_logs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT,
  actor           TEXT NOT NULL DEFAULT 'system',
  action          TEXT NOT NULL,
  target_type     TEXT,
  target_id       TEXT,
  outcome         TEXT NOT NULL DEFAULT 'ok',     -- ok | denied | error | blocked
  ip              TEXT,
  user_agent      TEXT,
  detail_json     TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_audit_user ON audit_logs(user_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at DESC);
CREATE INDEX idx_audit_outcome ON audit_logs(outcome, created_at DESC);
