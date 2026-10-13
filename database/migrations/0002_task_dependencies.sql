-- Explicit task DAG edges. A task runs only when every dependency has completed.
CREATE TABLE task_dependencies (
  task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);
CREATE INDEX idx_task_deps_dep ON task_dependencies(depends_on_id);
