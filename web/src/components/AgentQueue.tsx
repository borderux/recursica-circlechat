// Fork: an agent's queue of waiting requests on its page, and a task's
// priority in the task view (api/src/agents/turn-queue.ts). A request that
// arrives during the agent's turn waits here, ordered by its task's priority.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { humanizeError } from "../api/errors";
import { bus } from "../ws/client";
import {
  PRIORITIES,
  PRIORITY_LABELS,
  describeRequest,
  waitedFor,
  type AgentQueueView,
  type Priority,
} from "../lib/agentQueue";

export function AgentQueue({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const key = ["agent-queue", agentId] as const;
  const q = useQuery<AgentQueueView>({ queryKey: key, queryFn: () => api.get(`/agents/${agentId}/queue`) });

  useEffect(
    () =>
      bus.on((ev) => {
        const e = ev as { type: string; agentId?: string };
        if (
          (e.type === "agent.queue.updated" || e.type === "agent.run.started" || e.type === "agent.run.finished") &&
          e.agentId === agentId
        ) {
          qc.invalidateQueries({ queryKey: key });
        }
      }),
    [agentId, qc],
  );

  if (!q.data) {
    return <div className="text-[12px] text-[var(--color-muted)]">{q.isError ? "Couldn't load the queue." : "…"}</div>;
  }
  const { running, waiting } = q.data;
  return (
    <div className="flex flex-col gap-1.5 text-[13px]">
      <div>
        <span className="text-[var(--color-muted)]">Now: </span>
        {running ? describeRequest(running) : "Idle"}
      </div>
      {waiting.length === 0 ? (
        <div className="text-[var(--color-muted)]">Nothing waiting.</div>
      ) : (
        <ol className="flex flex-col gap-1">
          {waiting.map((r) => (
            <li key={r.runId} className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-[var(--color-muted)] w-5 text-right">{r.position}</span>
              <span className="flex-1">{describeRequest(r)}</span>
              <span className="font-mono text-[11px]">{PRIORITY_LABELS[r.priority]}</span>
              <span className="font-mono text-[11px] text-[var(--color-muted)]">{waitedFor(r.enqueuedAt)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function TaskPriorityField({ taskId }: { taskId: string }) {
  const qc = useQueryClient();
  const key = ["task-priority", taskId] as const;
  const q = useQuery<{ priority: Priority; canEdit: boolean }>({
    queryKey: key,
    queryFn: () => api.get(`/tasks/${taskId}/priority`),
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(
    () =>
      bus.on((ev) => {
        if (ev.type === "task.updated" && (ev as { taskId?: string }).taskId === taskId) {
          qc.invalidateQueries({ queryKey: key });
        }
      }),
    [taskId, qc],
  );

  async function save(priority: Priority) {
    setBusy(true);
    setErr(null);
    try {
      await api.put(`/tasks/${taskId}/priority`, { priority });
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tm-rail-field">
      <div className="tm-rail-label">Priority</div>
      {!q.data ? (
        <div className="tm-rail-empty">{q.isError ? "Couldn't load." : "…"}</div>
      ) : !q.data.canEdit ? (
        <div className="text-[12px]">{PRIORITY_LABELS[q.data.priority]}</div>
      ) : (
        <select
          className="tm-date"
          value={q.data.priority}
          disabled={busy}
          onChange={(e) => save(e.target.value as Priority)}
          aria-label="Priority"
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
      )}
      {err && <div className="tm-verify-why">{err}</div>}
    </div>
  );
}
