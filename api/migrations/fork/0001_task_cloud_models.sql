-- Fork: the "Cloud models" setting on tasks. Runs on every start
-- (see src/db/migrate.ts), so every statement must be safe to repeat.
CREATE TABLE IF NOT EXISTS "task_cloud_models" (
  "task_id" varchar(32) PRIMARY KEY REFERENCES "tasks" ("id") ON DELETE CASCADE,
  "mode" varchar(20) NOT NULL DEFAULT 'cluster_only',
  "max_start_wait_minutes" integer,
  "max_finish_minutes" integer,
  "updated_by" varchar(32) NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "workspace_cloud_model_policy" (
  "workspace_id" varchar(32) PRIMARY KEY REFERENCES "workspaces" ("id") ON DELETE CASCADE,
  "members_can_change" boolean NOT NULL DEFAULT false,
  "updated_by" varchar(32) NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
