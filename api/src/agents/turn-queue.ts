// Fork: one turn at a time per agent, and a queue for the rest. No request is
// ever refused.
//
// Every turn of a Hermes agent runs in a container on the agent's one home, so
// only one turn runs at a time. A request that arrived during a turn used to be
// refused (agent_busy) and lost. Observed: a person assigned a task and, three
// seconds later, commented on it with the request itself. The comment's turn
// was refused because the assignment's turn was still running, and the agent,
// which had seen only the task's title, spent the afternoon asking what to make.
//
// Now a request (anything but a heartbeat) that arrives while the agent is in a
// turn, or while others are already waiting, joins the agent's queue. The queue
// is ordered by the priority of each request's task (a request without a task
// counts as normal), then by arrival, and is resequenced whenever a request
// arrives or a task's priority changes. When a turn ends, the worker starts the
// request at the front. A heartbeat (scheduled or ambient) is not a request: it
// is skipped while the agent is busy or has requests waiting.
//
// Stopping a running turn for an urgent request is left for later.
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentRuns, agents, tasks } from "../db/schema.js";
import { agentRunQueue, taskPriorities } from "../db/fork-schema.js";
import { publishToWorkspace } from "../lib/events.js";
import { envNum } from "../lib/env.js";
import { agentQueue, type AgentJobPayload } from "./queue.js";

export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export function isPriority(v: unknown): v is Priority {
  return typeof v === "string" && (PRIORITIES as readonly string[]).includes(v);
}

export function priorityRank(p: string | null | undefined): number {
  const i = (PRIORITIES as readonly string[]).indexOf(p ?? "normal");
  return i < 0 ? PRIORITIES.indexOf("normal") : i;
}

export type QueueEntry = { runId: string; priority: string | null; enqueuedAt: Date };

// The queue's order: higher priority first, then earlier arrival.
export function orderQueue<E extends QueueEntry>(entries: E[]): E[] {
  return [...entries].sort(
    (a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      +a.enqueuedAt - +b.enqueuedAt ||
      a.runId.localeCompare(b.runId),
  );
}

// A turn still holds the agent while its run is running and has neither
// passed its timeout nor run longer than a turn can. A worker that died
// mid-turn leaves a running row behind; it must not hold the agent forever.
const TURN_STALE_MS = envNum("CC_TURN_STALE_MS", 30 * 60 * 1000, { min: 60_000 });

export function turnHoldsAgent(
  run: { status: string; startedAt: Date; timeoutAt: Date | null },
  now = new Date(),
  staleMs = TURN_STALE_MS,
): boolean {
  if (run.status !== "running") return false;
  if (run.timeoutAt && run.timeoutAt <= now) return false;
  return +now - +run.startedAt < staleMs;
}

// What a run does when it reaches the worker:
//   go   — start the turn now;
//   hold — join the queue (a request while the agent is busy, or behind
//          requests already waiting; a request the queue just released goes);
//   skip — a heartbeat while the agent is busy or has requests waiting.
export type Claim = "go" | "hold" | "skip";

export function decideClaim(s: { heartbeat: boolean; busy: boolean; waiting: number; fromQueue: boolean }): Claim {
  if (s.heartbeat) return s.busy || s.waiting > 0 ? "skip" : "go";
  if (s.busy) return "hold";
  if (s.waiting > 0 && !s.fromQueue) return "hold";
  return "go";
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Every decision about one agent's turn and queue runs under one lock, so two
// requests arriving together cannot both start.
async function withAgentLock<T>(agentId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cc-turn:${agentId}`}))`);
    return fn(tx);
  });
}

async function agentBusy(tx: Tx, agentId: string, exceptRunId: string | null): Promise<boolean> {
  const rows = await tx
    .select({ status: agentRuns.status, startedAt: agentRuns.startedAt, timeoutAt: agentRuns.timeoutAt })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.agentId, agentId),
        eq(agentRuns.status, "running"),
        exceptRunId ? ne(agentRuns.id, exceptRunId) : undefined,
      ),
    );
  const now = new Date();
  return rows.some((r) => turnHoldsAgent(r, now));
}

// Writes each waiting request's place in line. Returns the queue in order.
async function resequence(tx: Tx, agentId: string): Promise<Array<QueueEntry & { taskId: string | null }>> {
  const rows = await tx
    .select({
      runId: agentRunQueue.runId,
      taskId: agentRunQueue.taskId,
      enqueuedAt: agentRunQueue.enqueuedAt,
      position: agentRunQueue.position,
      priority: taskPriorities.priority,
    })
    .from(agentRunQueue)
    .leftJoin(taskPriorities, eq(taskPriorities.taskId, agentRunQueue.taskId))
    .where(eq(agentRunQueue.agentId, agentId));
  const ordered = orderQueue(rows);
  for (const [i, r] of ordered.entries()) {
    if (r.position !== i + 1) {
      await tx.update(agentRunQueue).set({ position: i + 1 }).where(eq(agentRunQueue.runId, r.runId));
    }
  }
  return ordered;
}

async function announce(agentId: string): Promise<void> {
  const [a] = await db.select({ workspaceId: agents.workspaceId }).from(agents).where(eq(agents.id, agentId)).limit(1);
  if (a) await publishToWorkspace(a.workspaceId, { type: "agent.queue.updated", workspaceId: a.workspaceId, agentId });
}

// Called when a run reaches the worker. "go" marks the run running.
export async function claimTurn(
  agentId: string,
  runId: string,
  payload: AgentJobPayload,
  heartbeat: boolean,
): Promise<Claim> {
  let changed = false;
  const claim = await withAgentLock(agentId, async (tx) => {
    const busy = await agentBusy(tx, agentId, runId);
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(agentRunQueue)
      .where(and(eq(agentRunQueue.agentId, agentId), ne(agentRunQueue.runId, runId)));
    const c = decideClaim({ heartbeat, busy, waiting: n, fromQueue: payload.fromQueue === true });
    if (c === "go") {
      await tx.update(agentRuns).set({ status: "running" }).where(eq(agentRuns.id, runId));
      const gone = await tx.delete(agentRunQueue).where(eq(agentRunQueue.runId, runId)).returning({ runId: agentRunQueue.runId });
      changed = gone.length > 0;
    } else if (c === "hold") {
      const { fromQueue: _drop, ...job } = payload;
      await tx
        .insert(agentRunQueue)
        .values({ runId, agentId, taskId: payload.taskId ?? null, trigger: payload.trigger, payload: { ...job, runId } })
        .onConflictDoNothing();
      await resequence(tx, agentId);
      changed = true;
    }
    return c;
  });
  if (changed) await announce(agentId);
  return claim;
}

// Called when a turn ends, on every path. Starts the request at the front of
// the queue when the agent is free. Safe to call any number of times.
export async function releaseTurn(agentId: string): Promise<string | null> {
  const started = await withAgentLock(agentId, async (tx) => {
    if (await agentBusy(tx, agentId, null)) return null;
    const ordered = await resequence(tx, agentId);
    const head = ordered[0];
    if (!head) return null;
    const [row] = await tx
      .delete(agentRunQueue)
      .where(eq(agentRunQueue.runId, head.runId))
      .returning({ payload: agentRunQueue.payload });
    await resequence(tx, agentId);
    if (!row) return null;
    const job = { ...(row.payload as AgentJobPayload), fromQueue: true };
    // A job id of its own: the run's first job id is spent.
    await agentQueue.add(`run:${head.runId}`, job, { jobId: `${head.runId}-q${Date.now()}` });
    return head.runId;
  });
  if (started) await announce(agentId);
  return started;
}

// A task's priority changed: every agent with a request for the task waiting
// gets its queue resequenced.
export async function resequenceForTask(taskId: string): Promise<void> {
  const rows = await db
    .selectDistinct({ agentId: agentRunQueue.agentId })
    .from(agentRunQueue)
    .where(eq(agentRunQueue.taskId, taskId));
  for (const { agentId } of rows) {
    await withAgentLock(agentId, (tx) => resequence(tx, agentId));
    await announce(agentId);
  }
}

export type AgentQueueView = {
  running: { runId: string; trigger: string; startedAt: string; taskId: string | null; taskTitle: string | null } | null;
  waiting: Array<{
    runId: string;
    position: number;
    trigger: string;
    taskId: string | null;
    taskTitle: string | null;
    priority: Priority;
    enqueuedAt: string;
  }>;
};

// The agent page's view: the turn running now, and the requests waiting, in order.
export async function agentQueueView(agentId: string): Promise<AgentQueueView> {
  const runs = await db
    .select({ id: agentRuns.id, trigger: agentRuns.trigger, status: agentRuns.status, startedAt: agentRuns.startedAt, timeoutAt: agentRuns.timeoutAt, contextJson: agentRuns.contextJson })
    .from(agentRuns)
    .where(and(eq(agentRuns.agentId, agentId), eq(agentRuns.status, "running")))
    .orderBy(asc(agentRuns.startedAt));
  const live = runs.find((r) => turnHoldsAgent(r));
  const rows = await db
    .select({
      runId: agentRunQueue.runId,
      position: agentRunQueue.position,
      trigger: agentRunQueue.trigger,
      taskId: agentRunQueue.taskId,
      enqueuedAt: agentRunQueue.enqueuedAt,
      priority: taskPriorities.priority,
    })
    .from(agentRunQueue)
    .leftJoin(taskPriorities, eq(taskPriorities.taskId, agentRunQueue.taskId))
    .where(eq(agentRunQueue.agentId, agentId));
  const runningTaskId = (live?.contextJson as { task?: { id?: string } } | null)?.task?.id ?? null;
  const taskIds = [...new Set([...rows.map((r) => r.taskId), runningTaskId].filter((t): t is string => !!t))];
  const titles = new Map(
    taskIds.length
      ? (await db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(inArray(tasks.id, taskIds))).map((t) => [t.id, t.title])
      : [],
  );
  return {
    running: live
      ? { runId: live.id, trigger: live.trigger, startedAt: live.startedAt.toISOString(), taskId: runningTaskId, taskTitle: runningTaskId ? titles.get(runningTaskId) ?? null : null }
      : null,
    waiting: orderQueue(rows).map((r, i) => ({
      runId: r.runId,
      position: i + 1,
      trigger: r.trigger,
      taskId: r.taskId,
      taskTitle: r.taskId ? titles.get(r.taskId) ?? null : null,
      priority: isPriority(r.priority) ? r.priority : "normal",
      enqueuedAt: r.enqueuedAt.toISOString(),
    })),
  };
}
