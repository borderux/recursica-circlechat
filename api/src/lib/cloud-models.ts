// Fork: reads and writes for a task's "Cloud models" setting and the
// workspace option that decides who may change it. The rules themselves are
// in cloud-models-rules.ts.
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { tasks } from "../db/schema.js";
import { taskCloudModels, workspaceCloudModelPolicy } from "../db/fork-schema.js";
import { publishToWorkspace } from "./events.js";
import { hydrateTasks, loadTask, logActivity } from "./tasks-core.js";
import {
  DEFAULT_CLOUD_MODELS,
  rowFromSetting,
  sameSetting,
  settingFromRow,
  taskIdFromWorkflowInput,
  type CloudModelsSetting,
} from "./cloud-models-rules.js";

export async function getTaskCloudModels(taskId: string): Promise<CloudModelsSetting> {
  const [row] = await db.select().from(taskCloudModels).where(eq(taskCloudModels.taskId, taskId)).limit(1);
  return settingFromRow(row);
}

export async function membersCanChangeCloudModels(workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ membersCanChange: workspaceCloudModelPolicy.membersCanChange })
    .from(workspaceCloudModelPolicy)
    .where(eq(workspaceCloudModelPolicy.workspaceId, workspaceId))
    .limit(1);
  return row?.membersCanChange ?? false;
}

export async function setMembersCanChangeCloudModels(
  workspaceId: string,
  membersCanChange: boolean,
  actorMemberId: string,
): Promise<void> {
  const now = new Date();
  await db
    .insert(workspaceCloudModelPolicy)
    .values({ workspaceId, membersCanChange, updatedBy: actorMemberId, updatedAt: now })
    .onConflictDoUpdate({
      target: workspaceCloudModelPolicy.workspaceId,
      set: { membersCanChange, updatedBy: actorMemberId, updatedAt: now },
    });
}

// Change a task's setting and record it in the task's history. Allowed at any
// status, including while the task's work is running: runs read the setting
// when they need it, so the change takes effect on their next read.
export async function setTaskCloudModels(
  taskId: string,
  workspaceId: string,
  next: CloudModelsSetting,
  actorMemberId: string,
): Promise<{ error: "not_found" } | { setting: CloudModelsSetting; unchanged: boolean }> {
  const task = await loadTask(taskId);
  if (!task || task.workspaceId !== workspaceId) return { error: "not_found" };
  const prev = await getTaskCloudModels(taskId);
  if (sameSetting(prev, next)) return { setting: prev, unchanged: true };

  const now = new Date();
  const row = rowFromSetting(next);
  await db
    .insert(taskCloudModels)
    .values({ taskId, ...row, updatedBy: actorMemberId, updatedAt: now })
    .onConflictDoUpdate({ target: taskCloudModels.taskId, set: { ...row, updatedBy: actorMemberId, updatedAt: now } });
  // The activity row is the history: who (actor_member_id), when (ts), what.
  await logActivity(taskId, actorMemberId, "cloud_models_changed", { from: prev, to: next });

  const [hydrated] = await hydrateTasks([task]);
  await publishToWorkspace(workspaceId, { type: "task.updated", workspaceId, taskId, task: hydrated });
  return { setting: next, unchanged: false };
}

// A workflow run, webhook-started or manual, may name its task with `taskId`
// in its input. Refuse a run that names one outside the workspace, so the
// task a run reports is always real.
export async function assertWorkflowRunTask(workspaceId: string, input: Record<string, unknown>): Promise<void> {
  if (!("taskId" in input)) return;
  const taskId = taskIdFromWorkflowInput(input);
  if (!taskId) throw new Error("invalid_task_id");
  const [t] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)))
    .limit(1);
  if (!t) throw new Error("task_not_found");
}

// What an agent run is told about its task: which one, and the setting as it
// stood when the run started. `taskId: null` means the run has no task, and
// the default (cluster only) applies.
export async function runTaskContext(
  taskId: string | null,
): Promise<{ taskId: string | null; cloudModels: CloudModelsSetting }> {
  if (!taskId) return { taskId: null, cloudModels: DEFAULT_CLOUD_MODELS };
  return { taskId, cloudModels: await getTaskCloudModels(taskId) };
}
