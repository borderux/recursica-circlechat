// Fork: a task's status follows its assignee's work. Observed: after the
// instruction for an assigned task stopped saying "move it to in_progress",
// no agent changed a task's status, and every task an agent was working on,
// or had delivered, sat in Backlog.
//
//   - An assignee's first comment or file on a task in Backlog moves it to In
//     progress.
//   - A deliverable landing on the task (a task artifact) moves it to Review,
//     unless the work says it is one part of several ("2 of 3"), when it stays
//     In progress.
//   - Never backwards, and never from Done, Blocked or Cancelled.
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { taskAssignees } from "../db/schema.js";
import { loadTask, updateTask } from "../lib/tasks-core.js";

const ORDER = ["backlog", "in_progress", "review"] as const;

// "interview 1 of 3", "part 2 of 4": a part of several, in the reply's first lines.
export function isPartOfSeveral(text: string | null | undefined): boolean {
  const head = String(text ?? "").split("\n").slice(0, 8).join("\n");
  for (const m of head.matchAll(/\b(\d{1,3})\s+of\s+(\d{1,3})\b/gi)) {
    const [n, total] = [Number(m[1]), Number(m[2])];
    if (n >= 1 && total > 1 && n < total) return true;
  }
  return false;
}

// The status a task moves to after its assignee's work, or null to leave it.
export function statusAfterAgentWork(
  current: string,
  work: { deliverable: boolean; text?: string | null },
): "in_progress" | "review" | null {
  const at = (ORDER as readonly string[]).indexOf(current);
  if (at < 0) return null; // done, blocked, cancelled or unknown: never touched
  const want = work.deliverable && !isPartOfSeveral(work.text) ? "review" : "in_progress";
  return ORDER.indexOf(want) > at ? want : null;
}

// Applies the rule for one piece of work. Best-effort: a refused move (a
// board stage's rules) is a trace line, never a failed action.
export async function advanceTaskForAgentWork(
  taskId: string,
  agentMemberId: string,
  workspaceId: string,
  work: { deliverable: boolean; text?: string | null },
  trace: string[],
): Promise<void> {
  const [assigned] = await db
    .select({ memberId: taskAssignees.memberId })
    .from(taskAssignees)
    .where(and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.memberId, agentMemberId)))
    .limit(1);
  if (!assigned) return;
  const task = await loadTask(taskId);
  if (!task) return;
  const next = statusAfterAgentWork(task.status, work);
  if (!next) return;
  const r = await updateTask(taskId, { status: next }, agentMemberId, workspaceId).catch((e: Error) => ({ error: e.message }));
  if (r && typeof r === "object" && "error" in r) {
    trace.push(`status ${task.status} → ${next} on ${taskId} not applied: ${String((r as { error: unknown }).error)}`);
    return;
  }
  trace.push(`status ${task.status} → ${next} on ${taskId}: the assignee's ${work.deliverable ? "deliverable" : "work"} landed`);
}
