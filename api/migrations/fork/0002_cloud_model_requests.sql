-- Fork: requests to move a task off Cluster only, waiting for an approver.
-- One pending request per task; an answer deletes the row. Runs on every
-- start (see src/db/migrate.ts), so every statement must be safe to repeat.
CREATE TABLE IF NOT EXISTS "task_cloud_model_requests" (
  "id" varchar(32) PRIMARY KEY,
  "task_id" varchar(32) NOT NULL UNIQUE REFERENCES "tasks" ("id") ON DELETE CASCADE,
  "workspace_id" varchar(32) NOT NULL REFERENCES "workspaces" ("id") ON DELETE CASCADE,
  "mode" varchar(20) NOT NULL,
  "max_start_wait_minutes" integer,
  "max_finish_minutes" integer,
  "requested_by" varchar(32) NOT NULL,
  "requested_at" timestamptz NOT NULL DEFAULT now()
);
