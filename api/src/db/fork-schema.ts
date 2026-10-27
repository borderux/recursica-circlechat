// Fork: tables that exist only in this fork. They are created by
// migrations/fork/*.sql (run by db/migrate.ts after drizzle's own
// migrations), not by drizzle-kit, so upstream's schema.ts and migration
// journal never change and the weekly upstream rebase has nothing to merge.
import { boolean, integer, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

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
