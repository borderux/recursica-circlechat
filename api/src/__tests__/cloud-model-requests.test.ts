// Requests to move a task off Cluster only: how a request is stored, how an
// answer applies the request, comments on the task and clears the request,
// and the webhook that announces each request. The database is an in-memory
// stand-in that understands just the queries in lib/cloud-model-requests.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { verifyWebhookSignature } from "../lib/signed-webhook.js";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  tables: {
    task_cloud_model_requests: [] as Record<string, unknown>[],
    users: [] as Record<string, unknown>[],
    members: [] as Record<string, unknown>[],
  } as Record<string, Record<string, unknown>[]>,
  setting: { mode: "cluster_only" } as Record<string, unknown>,
  setCalls: [] as Array<{ taskId: string; next: unknown; actor: string }>,
  activity: [] as Array<{ taskId: string; actor: string; kind: string; payload: Record<string, unknown> }>,
  comments: [] as Array<{ taskId: string; body: string; mentions: string[]; actor: string }>,
  events: [] as Array<Record<string, unknown>>,
}));

// Tables and columns are plain descriptors, and eq/and/sql build plain
// conditions that the stand-in database evaluates.
vi.mock("../db/schema.js", () => {
  const table = (name: string) =>
    new Proxy({ __table: name }, { get: (t, col: string) => (col === "__table" ? t.__table : { key: `${name}.${col}`, table: name, col }) });
  return { users: table("users"), members: table("members") };
});
vi.mock("../db/fork-schema.js", () => {
  const name = "task_cloud_model_requests";
  return {
    taskCloudModelRequests: new Proxy({ __table: name }, {
      get: (t, col: string) => (col === "__table" ? t.__table : { key: `${name}.${col}`, table: name, col }),
    }),
  };
});
vi.mock("drizzle-orm", () => ({
  eq: (c: unknown, v: unknown) => ({ eq: [c, v] }),
  and: (...cs: unknown[]) => ({ and: cs }),
  sql: (_s: TemplateStringsArray, ...vals: unknown[]) => ({ lower: vals }),
}));

vi.mock("../db/index.js", () => {
  type Col = { key: string; table: string; col: string };
  type Cond = { eq?: [Col, unknown]; and?: Cond[]; lower?: [Col, string] };
  const isCol = (v: unknown): v is Col => !!v && typeof v === "object" && "key" in v;
  const prefixed = (table: string, r: Row) => ({
    __raw: r,
    ...Object.fromEntries(Object.entries(r).map(([k, v]) => [`${table}.${k}`, v])),
  });
  const holds = (row: Row, c: Cond): boolean => {
    if (c.and) return c.and.every((x) => holds(row, x));
    if (c.eq) {
      const [a, b] = c.eq;
      return row[a.key] === (isCol(b) ? row[b.key] : b);
    }
    if (c.lower) return String(row[c.lower[0].key]).toLowerCase() === c.lower[1];
    return true;
  };
  const tableOf = (t: { __table: string }) => state.tables[t.__table];

  const select = (fields?: Record<string, Col>) => {
    let rows: Row[] = [];
    const q = {
      from(t: { __table: string }) {
        rows = tableOf(t).map((r) => prefixed(t.__table, r));
        return q;
      },
      innerJoin(t: { __table: string }, on: Cond) {
        rows = rows.flatMap((a) => tableOf(t).map((b) => ({ ...a, ...prefixed(t.__table, b), __raw: a.__raw })).filter((r) => holds(r, on)));
        return q;
      },
      where(c: Cond) {
        rows = rows.filter((r) => holds(r, c));
        return q;
      },
      async limit(n: number) {
        return rows.slice(0, n).map((r) => (fields ? Object.fromEntries(Object.entries(fields).map(([k, c]) => [k, r[c.key]])) : r.__raw));
      },
    };
    return q;
  };
  const insert = (t: { __table: string }) => ({
    values: (v: Row) => ({
      onConflictDoUpdate: async ({ set }: { set: Row }) => {
        const rows = tableOf(t);
        const i = rows.findIndex((r) => r.taskId === v.taskId);
        if (i >= 0) rows[i] = { ...rows[i], ...set };
        else rows.push({ ...v });
      },
    }),
  });
  const del = (t: { __table: string }) => ({
    where: (c: Cond) => ({
      returning: async () => {
        const rows = tableOf(t);
        const gone = rows.filter((r) => holds(prefixed(t.__table, r), c));
        state.tables[t.__table] = rows.filter((r) => !gone.includes(r));
        return gone;
      },
    }),
  });
  return { db: { select, insert, delete: del } };
});

vi.mock("../lib/config.js", () => ({ config: { publicBaseUrl: "https://chat.example.com/" } }));
vi.mock("../lib/events.js", () => ({
  publishToWorkspace: async (_ws: string, ev: Record<string, unknown>) => {
    state.events.push(ev);
  },
}));
vi.mock("../lib/cloud-models.js", () => ({
  getTaskCloudModels: async () => state.setting,
  setTaskCloudModels: async (taskId: string, _ws: string, next: Record<string, unknown>, actor: string) => {
    state.setCalls.push({ taskId, next, actor });
    state.setting = next;
    return { setting: next, unchanged: false };
  },
}));
vi.mock("../lib/tasks-core.js", () => ({
  loadTask: async (id: string) => (id === "task_1" ? { id, workspaceId: "ws_1", title: "Write the launch notes" } : null),
  hydrateTasks: async (rows: unknown[]) => rows,
  logActivity: async (taskId: string, actor: string, kind: string, payload: Record<string, unknown>) => {
    state.activity.push({ taskId, actor, kind, payload });
  },
  addComment: async (taskId: string, body: string, mentions: string[], actor: string) => {
    state.comments.push({ taskId, body, mentions, actor });
    return { comment: { id: "tcom_1" } };
  },
}));

const { answerCloudModelsRequest, createCloudModelsRequest, deliverRequestWebhook, getPendingRequest, requestWebhookSettings } =
  await import("../lib/cloud-model-requests.js");

const AFTER_WAIT = { mode: "cloud_after_wait" as const, maxStartWaitMinutes: 10, maxFinishMinutes: 90 };
const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }));

beforeEach(() => {
  state.tables.task_cloud_model_requests = [];
  state.tables.users = [
    { id: "u_ask", email: "asker@example.com", name: "Sam Asker" },
    { id: "u_appr", email: "Approver@Example.com", name: "Pat Approver" },
    { id: "u_out", email: "outsider@example.com", name: "Lee Outsider" },
  ];
  state.tables.members = [
    { id: "m_ask", workspaceId: "ws_1", kind: "user", refId: "u_ask" },
    { id: "m_appr", workspaceId: "ws_1", kind: "user", refId: "u_appr" },
    { id: "m_out", workspaceId: "ws_2", kind: "user", refId: "u_out" },
  ];
  state.setting = { mode: "cluster_only" };
  state.setCalls = [];
  state.activity = [];
  state.comments = [];
  state.events = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("CLOUD_REQUEST_WEBHOOK_URL", "https://hooks.example.com/cloud");
  vi.stubEnv("CLOUD_REQUEST_WEBHOOK_SECRET", "hook-secret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a new request", () => {
  it("leaves the setting alone and records who asked, for what, and when", async () => {
    const r = await createCloudModelsRequest("task_1", "ws_1", AFTER_WAIT, "m_ask");
    if ("error" in r) throw new Error(r.error);
    expect(state.setCalls).toHaveLength(0);
    expect(state.setting).toEqual({ mode: "cluster_only" });
    const pending = await getPendingRequest("task_1");
    expect(pending).toEqual({
      id: r.request.id,
      setting: AFTER_WAIT,
      requestedBy: { memberId: "m_ask", name: "Sam Asker" },
      requestedAt: r.request.requestedAt,
    });
    expect(Date.now() - Date.parse(pending!.requestedAt)).toBeLessThan(5_000);
    expect(state.activity).toEqual([
      { taskId: "task_1", actor: "m_ask", kind: "cloud_models_requested", payload: { requestId: r.request.id, setting: AFTER_WAIT } },
    ]);
    expect(state.events.map((e) => e.type)).toEqual(["task.updated"]);
  });

  it("announces the request with a signed webhook", async () => {
    const r = await createCloudModelsRequest("task_1", "ws_1", { mode: "cloud_now" }, "m_ask");
    if ("error" in r) throw new Error(r.error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/cloud");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-circlechat-event"]).toBe("cloud_models.request.created");
    const body = String(init.body);
    expect(
      verifyWebhookSignature({ secret: "hook-secret", timestamp: headers["x-circlechat-timestamp"], signature: headers["x-circlechat-signature"], rawBody: body }),
    ).toEqual({ ok: true });
    expect(JSON.parse(body)).toEqual({
      type: "cloud_models.request.created",
      request: {
        id: r.request.id,
        setting: { mode: "cloud_now" },
        requestedBy: { memberId: "m_ask", name: "Sam Asker", email: "asker@example.com" },
        requestedAt: r.request.requestedAt,
      },
      task: { id: "task_1", workspaceId: "ws_1", title: "Write the launch notes", url: "https://chat.example.com/board?task=task_1" },
      answer: { method: "POST", path: `/api/cloud-models/requests/${r.request.id}/answer` },
    });
  });

  it("replaces a pending request, so an answer to the old one finds nothing", async () => {
    const first = await createCloudModelsRequest("task_1", "ws_1", { mode: "cloud_now" }, "m_ask");
    const second = await createCloudModelsRequest("task_1", "ws_1", AFTER_WAIT, "m_ask");
    if ("error" in first || "error" in second) throw new Error("not created");
    expect(state.tables.task_cloud_model_requests).toHaveLength(1);
    expect((await getPendingRequest("task_1"))?.id).toBe(second.request.id);
    const old = await answerCloudModelsRequest(first.request.id, { decision: "approve", approverEmail: "approver@example.com" });
    expect(old).toEqual({ error: "request_not_found" });
    expect(state.setCalls).toHaveLength(0);
  });

  it("refuses a task in another workspace", async () => {
    expect(await createCloudModelsRequest("task_1", "ws_2", { mode: "cloud_now" }, "m_ask")).toEqual({ error: "not_found" });
    expect(state.tables.task_cloud_model_requests).toHaveLength(0);
  });
});

describe("an answer", () => {
  async function pending(setting: Parameters<typeof createCloudModelsRequest>[2] = AFTER_WAIT): Promise<string> {
    const r = await createCloudModelsRequest("task_1", "ws_1", setting, "m_ask");
    if ("error" in r) throw new Error(r.error);
    state.activity = [];
    state.events = [];
    return r.request.id;
  }

  it("approval applies the setting as the approver, comments, and clears the request", async () => {
    const id = await pending();
    const r = await answerCloudModelsRequest(id, { decision: "approve", approverEmail: "APPROVER@example.com", note: "Fine for this one." });
    expect(r).toEqual({ taskId: "task_1", decision: "approve", setting: AFTER_WAIT });
    expect(state.setCalls).toEqual([{ taskId: "task_1", next: AFTER_WAIT, actor: "m_appr" }]);
    expect(state.comments).toEqual([
      {
        taskId: "task_1",
        body:
          "Approved the Cloud models request from Sam Asker. The task now uses Cloud after a wait (start within 10 min, finish within 90 min).\n\nNote: Fine for this one.",
        mentions: ["m_ask"],
        actor: "m_appr",
      },
    ]);
    expect(await getPendingRequest("task_1")).toBeNull();
    expect(state.activity.map((a) => [a.kind, a.actor, a.payload.decision])).toEqual([["cloud_models_request_answered", "m_appr", "approve"]]);
    expect(state.events.map((e) => e.type)).toEqual(["task.updated"]);
  });

  it("denial leaves the setting alone, comments, and clears the request", async () => {
    const id = await pending({ mode: "cloud_now" });
    const r = await answerCloudModelsRequest(id, { decision: "deny", approverEmail: "approver@example.com" });
    expect(r).toEqual({ taskId: "task_1", decision: "deny", setting: { mode: "cluster_only" } });
    expect(state.setCalls).toHaveLength(0);
    expect(state.comments.map((c) => c.body)).toEqual([
      "Denied the Cloud models request from Sam Asker for Cloud now. The task stays on Cluster only.",
    ]);
    expect(await getPendingRequest("task_1")).toBeNull();
  });

  it("refuses an approver outside the task's workspace, and keeps the request", async () => {
    const id = await pending();
    const r = await answerCloudModelsRequest(id, { decision: "approve", approverEmail: "outsider@example.com" });
    expect(r).toEqual({ error: "approver_not_in_workspace" });
    expect(state.setCalls).toHaveLength(0);
    expect(state.comments).toHaveLength(0);
    expect((await getPendingRequest("task_1"))?.id).toBe(id);
  });

  it("only the first of two answers counts", async () => {
    const id = await pending();
    const first = await answerCloudModelsRequest(id, { decision: "deny", approverEmail: "approver@example.com" });
    const second = await answerCloudModelsRequest(id, { decision: "approve", approverEmail: "approver@example.com" });
    expect(first).toMatchObject({ decision: "deny" });
    expect(second).toEqual({ error: "request_not_found" });
    expect(state.setCalls).toHaveLength(0);
    expect(state.comments).toHaveLength(1);
  });
});

describe("the webhook", () => {
  it("is off without a URL, and unsigned without a secret", async () => {
    expect(requestWebhookSettings({})).toBeNull();
    expect(requestWebhookSettings({ CLOUD_REQUEST_WEBHOOK_URL: " https://hooks.example.com/x " })).toEqual({
      url: "https://hooks.example.com/x",
      secret: null,
    });
    expect(await deliverRequestWebhook({ type: "t" }, { settings: null, fetchImpl: fetchMock as unknown as typeof fetch })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    await deliverRequestWebhook({ type: "t" }, { settings: { url: "https://hooks.example.com/x", secret: null }, fetchImpl: fetchMock as unknown as typeof fetch });
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>)["x-circlechat-signature"]).toBeUndefined();
  });

  it("tries a failed POST twice more, with the same delivery id", async () => {
    const flaky = vi
      .fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(new Response("", { status: 502 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = await deliverRequestWebhook({ type: "t" }, { settings: { url: "https://hooks.example.com/x", secret: "s" }, fetchImpl: flaky as unknown as typeof fetch, retryDelaysMs: [0, 0] });
    expect(ok).toBe(true);
    expect(flaky).toHaveBeenCalledTimes(3);
    const ids = flaky.mock.calls.map((c) => (c[1].headers as Record<string, string>)["x-circlechat-delivery"]);
    expect(new Set(ids).size).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
