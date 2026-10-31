// What a heartbeat turn may pick up, and what stays finished.
//
// Observed overnight from a gpt-oss agent: every task it owned sat in review
// and its backlog was empty, yet it redid the same transcripts for hours. The
// ambient turns showed it the channel's last twenty messages, requests it had
// long since delivered among them; it made a new task from one, assigned the
// task to itself (which woke it again), and wrote the transcripts over. Its
// review tasks were in every heartbeat's task list too, and it re-shared and
// re-commented them. So:
//   - a heartbeat turn (scheduled or ambient) sees only messages since the
//     agent's last run, never its own posts, and never a message the agent has
//     already answered by posting after it;
//   - a heartbeat turn may create a task only when a person posted, commented
//     or assigned something since the last run;
//   - a task in review, done or cancelled is settled: it leaves a heartbeat's
//     task list, and its assignee's actions on it are refused, until a person
//     comments on it or someone else assigns it again;
//   - an agent assigning a task to itself does not wake it.
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { members, taskActivity, taskAssignees, taskComments, tasks } from "../db/schema.js";

export const SETTLED_STATUSES: ReadonlySet<string> = new Set(["review", "done", "cancelled"]);

// The actions that change a task's card.
export const TASK_ACTIONS: ReadonlySet<string> = new Set(["update_task", "task_comment", "share_to_task"]);

export function isHeartbeatTrigger(trigger: string | null | undefined): boolean {
  return trigger === "scheduled" || trigger === "ambient";
}

// A settled task stays settled until a person comments on it, or someone other
// than the agent assigns it to the agent, after it settled.
export function taskIsSettled(t: {
  status: string;
  settledAt: Date;
  lastPersonCommentAt: Date | null;
  assignedByOtherAt: Date | null;
}): boolean {
  if (!SETTLED_STATUSES.has(t.status)) return false;
  if (t.lastPersonCommentAt && t.lastPersonCommentAt > t.settledAt) return false;
  if (t.assignedByOtherAt && t.assignedByOtherAt > t.settledAt) return false;
  return true;
}

// The messages a heartbeat turn shows: those after <sinceTs>, without the
// agent's own posts, and without a message the agent answered by posting later
// in the same conversation.
export function newWorkMessages<M extends { memberId: string; conversationId: string; ts: Date }>(
  msgs: M[],
  agentMemberId: string,
  sinceTs: Date,
): M[] {
  const lastOwn = new Map<string, number>();
  for (const m of msgs) {
    if (m.memberId !== agentMemberId) continue;
    lastOwn.set(m.conversationId, Math.max(lastOwn.get(m.conversationId) ?? 0, +m.ts));
  }
  return msgs.filter(
    (m) => m.memberId !== agentMemberId && m.ts > sinceTs && +m.ts > (lastOwn.get(m.conversationId) ?? 0),
  );
}

export function settledTaskError(type: string, taskId: string, status: string): string {
  return `task_settled: ${taskId} is ${status === "review" ? "in review" : status}, so this ${type} did not run. A finished task stays as it is until a person comments on it.`;
}

export const HEARTBEAT_CREATE_TASK_ERROR =
  "heartbeat_create_task: no person asked for anything new since your last turn, so create_task did not run. A request you already delivered is finished; do not make it again.";

// The tasks among <taskIds> that are settled for the agent: it is assigned to
// them, they are in review, done or cancelled, and no person commented and no
// one else assigned them to the agent since they got there. Maps id → status.
export async function settledTasksFor(agentMemberId: string, taskIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(taskIds.filter(Boolean))];
  if (!agentMemberId || !ids.length) return out;
  const rows = await db
    .select({ id: tasks.id, status: tasks.status, createdAt: tasks.createdAt, assignedBy: taskAssignees.assignedBy, assignedAt: taskAssignees.assignedAt })
    .from(tasks)
    .innerJoin(taskAssignees, and(eq(taskAssignees.taskId, tasks.id), eq(taskAssignees.memberId, agentMemberId)))
    .where(and(inArray(tasks.id, ids), inArray(tasks.status, [...SETTLED_STATUSES])));
  for (const r of rows) {
    // When the task reached its status: its latest status change, else its creation.
    const [moved] = await db
      .select({ ts: taskActivity.ts })
      .from(taskActivity)
      .where(and(eq(taskActivity.taskId, r.id), eq(taskActivity.kind, "status_changed")))
      .orderBy(desc(taskActivity.ts))
      .limit(1);
    const [person] = await db
      .select({ ts: sql<Date>`max(${taskComments.ts})` })
      .from(taskComments)
      .innerJoin(members, eq(members.id, taskComments.memberId))
      .where(and(eq(taskComments.taskId, r.id), eq(members.kind, "user"), ne(taskComments.memberId, agentMemberId)));
    const settled = taskIsSettled({
      status: r.status,
      settledAt: moved?.ts ?? r.createdAt,
      lastPersonCommentAt: person?.ts ? new Date(person.ts) : null,
      assignedByOtherAt: r.assignedBy !== agentMemberId ? r.assignedAt : null,
    });
    if (settled) out.set(r.id, r.status);
  }
  return out;
}
