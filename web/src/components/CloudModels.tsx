// Fork: the "Cloud models" field in the task view, and the
// workspace option in Settings that decides who may change it.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { humanizeError } from "../api/errors";
import { bus } from "../ws/client";
import {
  CLOUD_MODE_LABELS,
  DEFAULT_WAIT,
  MAX_CLOUD_WAIT_MINUTES,
  describeCloudModels,
  parseMinutes,
  type CloudModelMode,
  type CloudModelsSetting,
} from "../lib/cloudModels";

type TaskCloudModels = { setting: CloudModelsSetting; canEdit: boolean; membersCanChange: boolean };

function errorText(e: unknown): string {
  const code = e instanceof Error ? e.message : "";
  if (code === "cloud_models_admin_only" || code === "admin_only") return "Only workspace admins can change this.";
  return humanizeError(e);
}

export function CloudModelsField({ taskId }: { taskId: string }) {
  const qc = useQueryClient();
  const key = ["task-cloud-models", taskId] as const;
  const q = useQuery<TaskCloudModels>({ queryKey: key, queryFn: () => api.get(`/tasks/${taskId}/cloud-models`) });

  // Someone else may change it while this task is open.
  useEffect(
    () =>
      bus.on((ev) => {
        if (ev.type === "task.updated" && (ev as { taskId?: string }).taskId === taskId) {
          qc.invalidateQueries({ queryKey: key });
        }
      }),
    [taskId, qc],
  );

  const setting = q.data?.setting;
  const [mode, setMode] = useState<CloudModelMode>("cluster_only");
  const [startWait, setStartWait] = useState(String(DEFAULT_WAIT.maxStartWaitMinutes));
  const [finish, setFinish] = useState(String(DEFAULT_WAIT.maxFinishMinutes));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!setting) return;
    setMode(setting.mode);
    if (setting.mode === "cloud_after_wait") {
      setStartWait(String(setting.maxStartWaitMinutes));
      setFinish(String(setting.maxFinishMinutes));
    }
  }, [JSON.stringify(setting)]);

  async function save(next: CloudModelsSetting) {
    setBusy(true);
    setErr(null);
    try {
      await api.put(`/tasks/${taskId}/cloud-models`, next);
      await qc.invalidateQueries({ queryKey: key });
      await qc.invalidateQueries({ queryKey: ["task", taskId] });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function pickMode(next: CloudModelMode) {
    setMode(next);
    // "Cloud after a wait" needs its two times first; the others save now.
    if (next !== "cloud_after_wait") void save({ mode: next });
  }

  const startN = parseMinutes(startWait);
  const finishN = parseMinutes(finish);
  const waitDirty =
    mode === "cloud_after_wait" &&
    !(setting?.mode === "cloud_after_wait" &&
      setting.maxStartWaitMinutes === startN &&
      setting.maxFinishMinutes === finishN);

  return (
    <div className="tm-rail-field">
      <div className="tm-rail-label">Cloud models</div>
      {!q.data ? (
        <div className="tm-rail-empty">{q.isError ? "Couldn't load." : "…"}</div>
      ) : !q.data.canEdit ? (
        <>
          <div className="text-[12px]">{describeCloudModels(setting)}</div>
          <div className="tm-verify-why">
            {q.data.membersCanChange ? "You can't change this." : "Only workspace admins can change this."}
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-1.5">
          <select
            className="tm-date"
            value={mode}
            disabled={busy}
            onChange={(e) => pickMode(e.target.value as CloudModelMode)}
            aria-label="Cloud models"
          >
            {(Object.keys(CLOUD_MODE_LABELS) as CloudModelMode[]).map((m) => (
              <option key={m} value={m}>
                {CLOUD_MODE_LABELS[m]}
              </option>
            ))}
          </select>
          {mode === "cloud_after_wait" && (
            <>
              <label className="tm-verify-why flex items-center gap-1.5">
                <span className="flex-1">Longest wait to start (min)</span>
                <input
                  className="tm-date w-[70px]"
                  inputMode="numeric"
                  value={startWait}
                  onChange={(e) => setStartWait(e.target.value)}
                />
              </label>
              <label className="tm-verify-why flex items-center gap-1.5">
                <span className="flex-1">Longest time to finish (min)</span>
                <input
                  className="tm-date w-[70px]"
                  inputMode="numeric"
                  value={finish}
                  onChange={(e) => setFinish(e.target.value)}
                />
              </label>
              {(startN === null || finishN === null) && (
                <div className="tm-verify-why">Enter whole minutes from 1 to {MAX_CLOUD_WAIT_MINUTES}.</div>
              )}
              {waitDirty && (
                <button
                  className="btn self-start"
                  disabled={busy || startN === null || finishN === null}
                  onClick={() =>
                    startN !== null &&
                    finishN !== null &&
                    save({ mode: "cloud_after_wait", maxStartWaitMinutes: startN, maxFinishMinutes: finishN })
                  }
                >
                  {busy ? "Saving…" : "Save"}
                </button>
              )}
            </>
          )}
        </div>
      )}
      {err && (
        <div role="alert" className="text-[11px] text-[var(--color-err)]">
          {err}
        </div>
      )}
    </div>
  );
}

// Admin-only section in Settings.
export function CloudModelsPolicySection() {
  const q = useQuery<{ membersCanChange: boolean }>({
    queryKey: ["cloud-models-policy"],
    queryFn: () => api.get("/cloud-models/policy"),
  });
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setBusy(true);
    setErr(null);
    try {
      await api.put("/cloud-models/policy", { membersCanChange: next });
      await qc.invalidateQueries({ queryKey: ["cloud-models-policy"] });
      await qc.invalidateQueries({ queryKey: ["task-cloud-models"] });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border border-[var(--color-hair)] rounded p-4 mb-4">
      <h2 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-2">Cloud models</h2>
      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={q.data?.membersCanChange ?? false}
          disabled={busy || !q.data}
          onChange={(e) => toggle(e.target.checked)}
        />
        Let every member change a task's Cloud models setting
      </label>
      <p className="text-[12px] text-[var(--color-muted)] mt-1">
        When this is off, only workspace admins can change it.
      </p>
      {err && <p role="alert" className="text-[12px] text-[var(--color-err)]">{err}</p>}
    </section>
  );
}
