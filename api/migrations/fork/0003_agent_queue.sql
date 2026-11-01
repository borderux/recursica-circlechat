-- Fork: each task's priority, and each agent's queue of requests waiting for
-- its running turn to end (see src/agents/turn-queue.ts). Runs on every start
-- (see src/db/migrate.ts), so every statement must be safe to repeat.

-- No row means normal.
CREATE TABLE IF NOT EXISTS "task_priorities" (
  "task_id" varchar(32) PRIMARY KEY REFERENCES "tasks" ("id") ON DELETE CASCADE,
  "priority" varchar(10) NOT NULL DEFAULT 'normal',
  "updated_by" varchar(32) NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- One row per request that arrived while its agent was in a turn. The row
-- holds the job, so the worker can start it when it reaches the front.
CREATE TABLE IF NOT EXISTS "agent_run_queue" (
  "run_id" varchar(32) PRIMARY KEY REFERENCES "agent_runs" ("id") ON DELETE CASCADE,
  "agent_id" varchar(32) NOT NULL REFERENCES "agents" ("id") ON DELETE CASCADE,
  "task_id" varchar(32),
  "trigger" varchar(30) NOT NULL,
  "payload" jsonb NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  "enqueued_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "agent_run_queue_agent_idx" ON "agent_run_queue" ("agent_id", "position");
CREATE INDEX IF NOT EXISTS "agent_run_queue_task_idx" ON "agent_run_queue" ("task_id");
