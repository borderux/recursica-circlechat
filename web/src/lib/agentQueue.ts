// Fork: labels for a task's priority and an agent's queue of waiting requests
// (api/src/agents/turn-queue.ts).
export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

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

const TRIGGER_LABELS: Record<string, string> = {
  task_assigned: "Task assigned",
  task_comment: "Comment on a task",
  mention: "Mention",
  dm: "Direct message",
  thread_reply: "Thread reply",
  channel_post: "Channel post",
  approval_response: "Approval answered",
  continuation: "Follow-up",
  workflow: "Workflow step",
  scheduled: "Heartbeat",
  ambient: "Ambient",
};

export function describeRequest(r: { trigger: string; taskTitle: string | null }): string {
  const what = TRIGGER_LABELS[r.trigger] ?? r.trigger;
  return r.taskTitle ? `${what}: ${r.taskTitle}` : what;
}

// "waiting 3 min", from when the request arrived.
export function waitedFor(since: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(since)) / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}
