// Fork: a task's priority: urgent, high, normal (the default) or low. It
// orders each agent's queue of waiting requests (agents/turn-queue.ts), and a
// change resequences every queue holding a request for the task.
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { taskPriorities } from "../db/fork-schema.js";
import { publishToWorkspace } from "./events.js";
import { hydrateTasks, loadTask, logActivity } from "./tasks-core.js";
import { isPriority, resequenceForTask, type Priority } from "../agents/turn-queue.js";

export async function getTaskPriority(taskId: string): Promise<Priority> {
  const [row] = await db
    .select({ priority: taskPriorities.priority })
    .from(taskPriorities)
    .where(eq(taskPriorities.taskId, taskId))
    .limit(1);
  return isPriority(row?.priority) ? row.priority : "normal";
}

export async function setTaskPriority(
  taskId: string,
  workspaceId: string,
  priority: Priority,
  actorMemberId: string,
): Promise<{ error: "not_found" } | { priority: Priority; unchanged: boolean }> {
  const task = await loadTask(taskId);
  if (!task || task.workspaceId !== workspaceId) return { error: "not_found" };
  const prev = await getTaskPriority(taskId);
  if (prev === priority) return { priority, unchanged: true };
  const now = new Date();
  await db
    .insert(taskPriorities)
    .values({ taskId, priority, updatedBy: actorMemberId, updatedAt: now })
    .onConflictDoUpdate({ target: taskPriorities.taskId, set: { priority, updatedBy: actorMemberId, updatedAt: now } });
  await logActivity(taskId, actorMemberId, "priority_changed", { from: prev, to: priority });
  const [hydrated] = await hydrateTasks([task]);
  await publishToWorkspace(workspaceId, { type: "task.updated", workspaceId, taskId, task: hydrated });
  await resequenceForTask(taskId);
  return { priority, unchanged: false };
}
