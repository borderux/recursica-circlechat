// setTaskCloudModels writes the change and records it in the task's history,
// with an in-memory stand-in for the database.
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  activity: [] as Array<{ taskId: string; actor: string; kind: string; payload: Record<string, unknown> }>,
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock("../db/index.js", () => {
  const select = () => ({
    from: () => ({
      where: () => ({
        limit: async () => {
          const r = state.rows.get("task_1");
          return r ? [r] : [];
        },
      }),
    }),
  });
  const insert = () => ({
    values: (v: Record<string, unknown>) => ({
      onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => {
        const prev = state.rows.get(String(v.taskId));
        state.rows.set(String(v.taskId), prev ? { ...prev, ...set } : v);
      },
    }),
  });
  return { db: { select, insert } };
});
vi.mock("../lib/tasks-core.js", () => ({
  loadTask: async (id: string) => (id === "task_1" ? { id, workspaceId: "ws_1" } : null),
  hydrateTasks: async (rows: unknown[]) => rows,
  logActivity: async (taskId: string, actor: string, kind: string, payload: Record<string, unknown>) => {
    state.activity.push({ taskId, actor, kind, payload });
  },
}));
vi.mock("../lib/events.js", () => ({
  publishToWorkspace: async (_ws: string, ev: Record<string, unknown>) => {
    state.events.push(ev);
  },
}));

const { setTaskCloudModels, getTaskCloudModels, runTaskContext } = await import("../lib/cloud-models.js");

beforeEach(() => {
  state.rows.clear();
  state.activity = [];
  state.events = [];
});

describe("setTaskCloudModels", () => {
  it("records who changed it, from what, to what", async () => {
    const next = { mode: "cloud_after_wait" as const, maxStartWaitMinutes: 10, maxFinishMinutes: 90 };
    const r = await setTaskCloudModels("task_1", "ws_1", next, "m_admin");
    expect(r).toEqual({ setting: next, unchanged: false });
    expect(state.activity).toEqual([
      { taskId: "task_1", actor: "m_admin", kind: "cloud_models_changed", payload: { from: { mode: "cluster_only" }, to: next } },
    ]);
    expect(state.rows.get("task_1")).toMatchObject({ mode: "cloud_after_wait", maxStartWaitMinutes: 10, maxFinishMinutes: 90, updatedBy: "m_admin" });
    expect(state.rows.get("task_1")?.updatedAt).toBeInstanceOf(Date);
    expect(state.events).toMatchObject([{ type: "task.updated", taskId: "task_1" }]);
    expect(await getTaskCloudModels("task_1")).toEqual(next);
  });

  it("records each later change too, with the previous value", async () => {
    await setTaskCloudModels("task_1", "ws_1", { mode: "cloud_now" }, "m_admin");
    await setTaskCloudModels("task_1", "ws_1", { mode: "cluster_only" }, "m_member");
    expect(state.activity.map((a) => [a.actor, a.payload])).toEqual([
      ["m_admin", { from: { mode: "cluster_only" }, to: { mode: "cloud_now" } }],
      ["m_member", { from: { mode: "cloud_now" }, to: { mode: "cluster_only" } }],
    ]);
    // Switching away from "after a wait" clears the stored times.
    expect(state.rows.get("task_1")).toMatchObject({ mode: "cluster_only", maxStartWaitMinutes: null, maxFinishMinutes: null });
  });

  it("writes nothing to the history when the value doesn't change", async () => {
    const r = await setTaskCloudModels("task_1", "ws_1", { mode: "cluster_only" }, "m_admin");
    expect(r).toEqual({ setting: { mode: "cluster_only" }, unchanged: true });
    expect(state.activity).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });

  it("refuses a task in another workspace", async () => {
    expect(await setTaskCloudModels("task_1", "ws_2", { mode: "cloud_now" }, "m_admin")).toEqual({ error: "not_found" });
    expect(state.activity).toHaveLength(0);
  });
});

describe("runTaskContext", () => {
  it("gives a run its task and the setting as it stands now", async () => {
    await setTaskCloudModels("task_1", "ws_1", { mode: "cloud_now" }, "m_admin");
    expect(await runTaskContext("task_1")).toEqual({ taskId: "task_1", cloudModels: { mode: "cloud_now" } });
  });

  it("a run with no task gets Cluster only", async () => {
    expect(await runTaskContext(null)).toEqual({ taskId: null, cloudModels: { mode: "cluster_only" } });
  });
});
