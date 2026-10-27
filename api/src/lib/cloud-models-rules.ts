// Fork: the "Cloud models" setting on a task — whether the task's
// runs stay on the cluster's own models or may use a cloud model.
//
//   • cluster_only      (default) never use a cloud model;
//   • cloud_after_wait  use a cloud model when the cluster has not started the
//                       work within `maxStartWaitMinutes`, or has not finished
//                       it within `maxFinishMinutes`;
//   • cloud_now         use a cloud model straight away.
//
// Pure rules only, safe to import from tests: the DB reads and writes live in
// cloud-models.ts.
import { z } from "zod";

export const CLOUD_MODEL_MODES = ["cluster_only", "cloud_after_wait", "cloud_now"] as const;
export type CloudModelMode = (typeof CLOUD_MODEL_MODES)[number];

export type CloudModelsSetting =
  | { mode: "cluster_only" }
  | { mode: "cloud_after_wait"; maxStartWaitMinutes: number; maxFinishMinutes: number }
  | { mode: "cloud_now" };

export const DEFAULT_CLOUD_MODELS: CloudModelsSetting = { mode: "cluster_only" };

// A week: long enough for any real wait, short enough to catch a typo.
export const MAX_CLOUD_WAIT_MINUTES = 7 * 24 * 60;

const minutes = z.number().int().min(1).max(MAX_CLOUD_WAIT_MINUTES);

export const CloudModelsBody = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("cluster_only") }).strict(),
  z
    .object({
      mode: z.literal("cloud_after_wait"),
      maxStartWaitMinutes: minutes,
      maxFinishMinutes: minutes,
    })
    .strict(),
  z.object({ mode: z.literal("cloud_now") }).strict(),
]);

// Turn a stored row (or no row) into a setting. Unknown or half-filled rows
// fall back to the default rather than guessing at cloud use.
export function settingFromRow(
  row: { mode: string; maxStartWaitMinutes: number | null; maxFinishMinutes: number | null } | null | undefined,
): CloudModelsSetting {
  if (!row) return DEFAULT_CLOUD_MODELS;
  if (row.mode === "cloud_now") return { mode: "cloud_now" };
  if (row.mode === "cloud_after_wait" && row.maxStartWaitMinutes && row.maxFinishMinutes) {
    return {
      mode: "cloud_after_wait",
      maxStartWaitMinutes: row.maxStartWaitMinutes,
      maxFinishMinutes: row.maxFinishMinutes,
    };
  }
  return DEFAULT_CLOUD_MODELS;
}

export function rowFromSetting(s: CloudModelsSetting): {
  mode: CloudModelMode;
  maxStartWaitMinutes: number | null;
  maxFinishMinutes: number | null;
} {
  return s.mode === "cloud_after_wait"
    ? { mode: s.mode, maxStartWaitMinutes: s.maxStartWaitMinutes, maxFinishMinutes: s.maxFinishMinutes }
    : { mode: s.mode, maxStartWaitMinutes: null, maxFinishMinutes: null };
}

export function sameSetting(a: CloudModelsSetting, b: CloudModelsSetting): boolean {
  const ra = rowFromSetting(a);
  const rb = rowFromSetting(b);
  return ra.mode === rb.mode && ra.maxStartWaitMinutes === rb.maxStartWaitMinutes && ra.maxFinishMinutes === rb.maxFinishMinutes;
}

// Who may change a task's setting. Admins ("*") always; a custom role that
// grants `tasks.cloud_models`; and, when the workspace option is on, anyone
// who can write to the workspace (the built-in member role). Spectators never.
export const CLOUD_MODELS_PERMISSION = "tasks.cloud_models";

export function canChangeCloudModels(input: {
  permissions: string[];
  membersCanChange: boolean;
  spectator?: boolean;
}): boolean {
  if (input.spectator) return false;
  const p = input.permissions;
  if (p.includes("*") || p.includes(CLOUD_MODELS_PERMISSION)) return true;
  return input.membersCanChange && p.includes("workspace.write");
}

// The task a run works on. An agent run carries it when a task event started
// it (assignment, comment, stage move, continuation). A workflow run carries
// it when whoever started it, a webhook included, put `taskId` in the input.
// A run with neither (a heartbeat, a chat mention) has no task.
export function taskIdFromWorkflowInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const v = (input as { taskId?: unknown }).taskId;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function runTaskId(payload: { taskId?: string | null }, workflowInput?: unknown): string | null {
  return payload.taskId || taskIdFromWorkflowInput(workflowInput);
}
