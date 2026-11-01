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

// An agent that asked a person something waits quietly for the answer.
// Observed: a gpt-oss agent asked what to make, then asked again on five
// heartbeats over three hours, because each heartbeat showed it the task with
// its own question as the latest word. A task waits on a person when the
// agent's newest comment is newer than every person's comment on it, and the
// task is blocked or that comment asks a question. A person's comment ends the
// wait (and wakes the agent with a task_comment turn).
export function taskIsWaiting(t: {
  status: string;
  agentCommentAt: Date | null;
  agentCommentBody: string | null;
  personCommentAt: Date | null;
}): boolean {
  if (!t.agentCommentAt) return false;
  if (t.personCommentAt && t.personCommentAt >= t.agentCommentAt) return false;
  return t.status === "blocked" || /\?/.test(t.agentCommentBody ?? "");
}

export function waitingTaskError(type: string, taskId: string): string {
  return `waiting_on_person: you asked a person on ${taskId} and nobody has answered yet, so this ${type} did not run. Wait quietly: a person's reply wakes you.`;
}

// Whether an ambient turn's packet holds any message to talk about.
export function ambientHasMessages(packet: { inbox?: Array<{ messages?: unknown[] }> }): boolean {
  return (packet.inbox ?? []).some((c) => (c.messages?.length ?? 0) > 0);
}

// The tasks among <taskIds> that wait on a person's answer to the agent.
export async function waitingTasksFor(agentMemberId: string, taskIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = [...new Set(taskIds.filter(Boolean))];
  if (!agentMemberId || !ids.length) return out;
  const rows = await db.select({ id: tasks.id, status: tasks.status }).from(tasks).where(inArray(tasks.id, ids));
  for (const r of rows) {
    const [mine] = await db
      .select({ ts: taskComments.ts, bodyMd: taskComments.bodyMd })
      .from(taskComments)
      .where(and(eq(taskComments.taskId, r.id), eq(taskComments.memberId, agentMemberId)))
      .orderBy(desc(taskComments.ts))
      .limit(1);
    if (!mine) continue;
    const [person] = await db
      .select({ ts: sql<Date>`max(${taskComments.ts})` })
      .from(taskComments)
      .innerJoin(members, eq(members.id, taskComments.memberId))
      .where(and(eq(taskComments.taskId, r.id), eq(members.kind, "user")));
    const waiting = taskIsWaiting({
      status: r.status,
      agentCommentAt: mine.ts,
      agentCommentBody: mine.bodyMd,
      personCommentAt: person?.ts ? new Date(person.ts) : null,
    });
    if (waiting) out.add(r.id);
  }
  return out;
}

// The newest comment by a person on each task: the request, which a
// heartbeat's task list shows next to the agent's own latest word.
export async function personRequestsFor(
  taskIds: string[],
): Promise<Map<string, { memberId: string; bodyMd: string; ts: Date }>> {
  const out = new Map<string, { memberId: string; bodyMd: string; ts: Date }>();
  const ids = [...new Set(taskIds.filter(Boolean))];
  if (!ids.length) return out;
  const rows = await db
    .select({ taskId: taskComments.taskId, memberId: taskComments.memberId, bodyMd: taskComments.bodyMd, ts: taskComments.ts })
    .from(taskComments)
    .innerJoin(members, eq(members.id, taskComments.memberId))
    .where(and(inArray(taskComments.taskId, ids), eq(members.kind, "user")))
    .orderBy(desc(taskComments.ts));
  for (const r of rows) if (!out.has(r.taskId)) out.set(r.taskId, r);
  return out;
}

// Where "new since the last turn" starts: when the agent's last real turn
// started. A turn reads the workspace when it starts, so whatever arrived
// during it is still new. A run that never reached the model (skipped, held
// in the queue, refused as busy) does not count. The cursor used to be the
// previous run's finish, whatever that run was: a request refused as busy
// 48 ms after a person's comment hid the comment from every later heartbeat.
export function heartbeatCursor(
  runs: Array<{ startedAt: Date; status: string; errorText: string | null; resultJson: unknown; contextJson: unknown }>,
): Date | null {
  const real = runs
    .filter((r) => {
      if (!["ok", "failed", "cancelled"].includes(r.status)) return false;
      if (!r.contextJson || typeof r.contextJson !== "object" || !Object.keys(r.contextJson).length) return false;
      if ((r.resultJson as { skipped?: unknown } | null)?.skipped) return false;
      return !(r.errorText ?? "").startsWith("agent_busy");
    })
    .sort((a, b) => +b.startedAt - +a.startedAt);
  return real[0]?.startedAt ?? null;
}
