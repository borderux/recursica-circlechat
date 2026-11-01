// Fork: tables that exist only in this fork. They are created by
// migrations/fork/*.sql (run by db/migrate.ts after drizzle's own
// migrations), not by drizzle-kit, so upstream's schema.ts and migration
// journal never change and the weekly upstream rebase has nothing to merge.
import { boolean, integer, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

// One row per task whose "Cloud models" setting is not the default. No row
// means cluster only. See lib/cloud-models-rules.ts.
export const taskCloudModels = pgTable("task_cloud_models", {
  taskId: varchar("task_id", { length: 32 }).primaryKey(),
  mode: varchar("mode", { length: 20 }).notNull().default("cluster_only"),
  maxStartWaitMinutes: integer("max_start_wait_minutes"),
  maxFinishMinutes: integer("max_finish_minutes"),
  updatedBy: varchar("updated_by", { length: 32 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// The workspace option that lets every member, not only admins, change a
// task's setting. No row means admins only.
export const workspaceCloudModelPolicy = pgTable("workspace_cloud_model_policy", {
  workspaceId: varchar("workspace_id", { length: 32 }).primaryKey(),
  membersCanChange: boolean("members_can_change").notNull().default(false),
  updatedBy: varchar("updated_by", { length: 32 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// A pending request to move a task off Cluster only (see
// lib/cloud-model-requests.ts). One row per task at most; an answer deletes
// the row.
export const taskCloudModelRequests = pgTable("task_cloud_model_requests", {
  id: varchar("id", { length: 32 }).primaryKey(),
  taskId: varchar("task_id", { length: 32 }).notNull().unique(),
  workspaceId: varchar("workspace_id", { length: 32 }).notNull(),
  mode: varchar("mode", { length: 20 }).notNull(),
  maxStartWaitMinutes: integer("max_start_wait_minutes"),
  maxFinishMinutes: integer("max_finish_minutes"),
  requestedBy: varchar("requested_by", { length: 32 }).notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
});

// A task's priority (see agents/turn-queue.ts). No row means normal.
export const taskPriorities = pgTable("task_priorities", {
  taskId: varchar("task_id", { length: 32 }).primaryKey(),
  priority: varchar("priority", { length: 10 }).notNull().default("normal"),
  updatedBy: varchar("updated_by", { length: 32 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// A request waiting for its agent's running turn to end (see
// agents/turn-queue.ts). The row holds the job, and goes when the job starts.
export const agentRunQueue = pgTable("agent_run_queue", {
  runId: varchar("run_id", { length: 32 }).primaryKey(),
  agentId: varchar("agent_id", { length: 32 }).notNull(),
  taskId: varchar("task_id", { length: 32 }),
  trigger: varchar("trigger", { length: 30 }).notNull(),
  payload: jsonb("payload").notNull(),
  position: integer("position").notNull().default(0),
  enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).defaultNow().notNull(),
});
