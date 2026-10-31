// HTTP behaviour of the Cloud models routes, with the DB and auth replaced by
// fakes so no database or Redis is needed.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

const state = vi.hoisted(() => ({
  membersCanChange: false,
  setCalls: [] as Array<{ taskId: string; workspaceId: string; next: unknown; actor: string }>,
  policyCalls: [] as Array<{ workspaceId: string; membersCanChange: boolean; actor: string }>,
  requestCalls: [] as Array<{ taskId: string; workspaceId: string; setting: unknown; actor: string }>,
  answerCalls: [] as Array<{ requestId: string; answer: unknown }>,
}));

// Sessions: header x-user = admin | member | guest | spectator | approver.
// Agents: a bot token. Neither works on the other's routes, as in the real
// hooks. The approver is a plain member whose email is on CLOUD_APPROVERS.
const USERS: Record<string, { userId: string; memberId: string; email: string; spectator?: boolean }> = {
  admin: { userId: "u_admin", memberId: "m_admin", email: "admin@example.com" },
  member: { userId: "u_member", memberId: "m_member", email: "member@example.com" },
  guest: { userId: "u_guest", memberId: "m_guest", email: "guest@example.com" },
  spectator: { userId: "u_spec", memberId: "m_spec", email: "approver@example.com", spectator: true },
  approver: { userId: "u_appr", memberId: "m_appr", email: "Approver@Example.com" },
};
const ROLES: Record<string, string> = { u_admin: "admin", u_member: "member", u_guest: "guest", u_spec: "admin", u_appr: "member" };

vi.mock("../auth/session.js", () => ({
  requireWorkspace: async (req: FastifyRequest, reply: FastifyReply) => {
    const u = USERS[String(req.headers["x-user"] ?? "")];
    if (!u) return reply.code(401).send({ error: "unauthenticated" });
    (req as unknown as { auth: unknown }).auth = { ...u, workspaceId: "ws_1", user: { id: u.userId, email: u.email } };
    req.spectator = u.spectator;
  },
}));
vi.mock("../routes/agent-api.js", () => ({
  requireAgentToken: async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers.authorization !== "Bearer agent-token") return reply.code(401).send({ error: "invalid_token" });
    req.agentCtx = { agentId: "a_1", memberId: "m_agent", workspaceId: "ws_1", handle: "bot" };
  },
}));
vi.mock("../lib/access-control.js", async () => {
  const { BUILTIN_PERMISSIONS } = await vi.importActual<typeof import("../lib/access-control.js")>(
    "../lib/access-control.js",
  );
  return {
    workspaceAccess: async (_ws: string, userId: string) => ({
      role: ROLES[userId],
      permissions: BUILTIN_PERMISSIONS[ROLES[userId]],
    }),
  };
});
vi.mock("../lib/tasks-core.js", () => ({
  loadTask: async (id: string) => (id === "task_1" ? { id, workspaceId: "ws_1" } : id === "task_x" ? { id, workspaceId: "ws_2" } : null),
}));
vi.mock("../lib/cloud-models.js", () => ({
  getTaskCloudModels: async () => ({ mode: "cluster_only" }),
  membersCanChangeCloudModels: async () => state.membersCanChange,
  setMembersCanChangeCloudModels: async (workspaceId: string, membersCanChange: boolean, actor: string) => {
    state.policyCalls.push({ workspaceId, membersCanChange, actor });
  },
  setTaskCloudModels: async (taskId: string, workspaceId: string, next: unknown, actor: string) => {
    state.setCalls.push({ taskId, workspaceId, next, actor });
    return taskId === "task_1" ? { setting: next, unchanged: false } : { error: "not_found" };
  },
}));
vi.mock("../lib/cloud-model-requests.js", () => ({
  getPendingRequest: async () => null,
  createCloudModelsRequest: async (taskId: string, workspaceId: string, setting: unknown, actor: string) => {
    state.requestCalls.push({ taskId, workspaceId, setting, actor });
    return taskId === "task_1" ? { request: { id: "cmreq_1", setting } } : { error: "not_found" };
  },
  answerCloudModelsRequest: async (requestId: string, answer: unknown) => {
    state.answerCalls.push({ requestId, answer });
    return requestId === "cmreq_1" ? { taskId: "task_1", decision: "approve", setting: { mode: "cloud_now" } } : { error: "request_not_found" };
  },
}));

const { default: cloudModelsRoutes } = await import("../routes/cloud-models.js");

async function makeApp() {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    const e = err as Error & { issues?: unknown };
    if (e.issues) return reply.code(400).send({ error: "validation" });
    return reply.code(500).send({ error: e.message });
  });
  await app.register(cloudModelsRoutes, { prefix: "/api" });
  return app;
}

const AFTER_WAIT = { mode: "cloud_after_wait", maxStartWaitMinutes: 10, maxFinishMinutes: 90 };
const TOKEN = "t".repeat(40);

beforeEach(() => {
  state.membersCanChange = false;
  state.setCalls = [];
  state.policyCalls = [];
  state.requestCalls = [];
  state.answerCalls = [];
  vi.stubEnv("CLOUD_APPROVERS", " approver@example.com , someone-else@example.com");
  vi.stubEnv("CLOUD_APPROVAL_TOKEN", TOKEN);
});
afterEach(() => vi.unstubAllEnvs());

const put = (app: Awaited<ReturnType<typeof makeApp>>, who: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: "/api/tasks/task_1/cloud-models", headers: { "x-user": who }, payload });

describe("changing a task's setting", () => {
  it("an approver moves it off Cluster only directly, recorded against the approver's member id", async () => {
    const app = await makeApp();
    const r = await put(app, "approver", AFTER_WAIT);
    expect(r.statusCode).toBe(200);
    expect(state.setCalls).toEqual([{ taskId: "task_1", workspaceId: "ws_1", next: AFTER_WAIT, actor: "m_appr" }]);
  });

  it("an admin who is not an approver can't move it off Cluster only", async () => {
    const app = await makeApp();
    for (const payload of [AFTER_WAIT, { mode: "cloud_now" }]) {
      const r = await put(app, "admin", payload);
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ error: "cloud_models_needs_approval" });
    }
    expect(state.setCalls).toHaveLength(0);
  });

  it("moving back to Cluster only needs no approval", async () => {
    const app = await makeApp();
    expect((await put(app, "admin", { mode: "cluster_only" })).statusCode).toBe(200);
    state.membersCanChange = true;
    expect((await put(app, "member", { mode: "cluster_only" })).statusCode).toBe(200);
    expect(state.setCalls.map((c) => c.actor)).toEqual(["m_admin", "m_member"]);
  });

  it("a member can't change it by default, and can move it to Cluster only once the workspace option is on", async () => {
    const app = await makeApp();
    expect((await put(app, "member", { mode: "cluster_only" })).statusCode).toBe(403);
    state.membersCanChange = true;
    expect((await put(app, "member", { mode: "cluster_only" })).statusCode).toBe(200);
    expect((await put(app, "member", { mode: "cloud_now" })).json()).toEqual({ error: "cloud_models_needs_approval" });
  });

  it("guests and spectators can't, even with the option on and an approver's email", async () => {
    state.membersCanChange = true;
    const app = await makeApp();
    for (const who of ["guest", "spectator"]) {
      expect((await put(app, who, { mode: "cloud_now" })).statusCode, who).toBe(403);
      expect((await put(app, who, { mode: "cluster_only" })).statusCode, who).toBe(403);
    }
    expect(state.setCalls).toHaveLength(0);
  });

  it("with no approver list, nobody moves it off Cluster only directly", async () => {
    vi.stubEnv("CLOUD_APPROVERS", "");
    const app = await makeApp();
    expect((await put(app, "approver", { mode: "cloud_now" })).statusCode).toBe(403);
    expect((await put(app, "admin", { mode: "cloud_now" })).statusCode).toBe(403);
  });

  it("refuses a bad value and a task in another workspace", async () => {
    const app = await makeApp();
    const bad = await put(app, "approver", { mode: "cloud_after_wait" });
    expect(bad.statusCode).toBe(400);
    const other = await app.inject({ method: "PUT", url: "/api/tasks/task_x/cloud-models", headers: { "x-user": "approver" }, payload: { mode: "cloud_now" } });
    expect(other.statusCode).toBe(404);
  });

  it("tells the task view whether the caller can edit, is an approver, and what is pending", async () => {
    const app = await makeApp();
    const get = async (who: string) =>
      (await app.inject({ method: "GET", url: "/api/tasks/task_1/cloud-models", headers: { "x-user": who } })).json();
    expect(await get("member")).toEqual({
      setting: { mode: "cluster_only" },
      canEdit: false,
      isApprover: false,
      membersCanChange: false,
      pendingRequest: null,
    });
    expect(await get("admin")).toMatchObject({ canEdit: true, isApprover: false });
    expect(await get("approver")).toMatchObject({ canEdit: true, isApprover: true });
    expect(await get("spectator")).toMatchObject({ canEdit: false, isApprover: false });
  });
});

describe("requests", () => {
  const ask = (app: Awaited<ReturnType<typeof makeApp>>, who: string, payload: Record<string, unknown>, task = "task_1") =>
    app.inject({ method: "POST", url: `/api/tasks/${task}/cloud-models/requests`, headers: { "x-user": who }, payload });

  it("anyone who can change the setting can ask, and the request names the asker", async () => {
    const app = await makeApp();
    const r = await ask(app, "admin", AFTER_WAIT);
    expect(r.statusCode).toBe(201);
    expect(state.requestCalls).toEqual([{ taskId: "task_1", workspaceId: "ws_1", setting: AFTER_WAIT, actor: "m_admin" }]);
    expect(state.setCalls).toHaveLength(0);
  });

  it("a member asks only once the workspace option is on; guests and spectators never", async () => {
    const app = await makeApp();
    expect((await ask(app, "member", { mode: "cloud_now" })).statusCode).toBe(403);
    state.membersCanChange = true;
    expect((await ask(app, "member", { mode: "cloud_now" })).statusCode).toBe(201);
    for (const who of ["guest", "spectator"]) expect((await ask(app, who, { mode: "cloud_now" })).statusCode, who).toBe(403);
    expect(state.requestCalls.map((c) => c.actor)).toEqual(["m_member"]);
  });

  it("refuses a request for Cluster only, a bad value and a task in another workspace", async () => {
    const app = await makeApp();
    expect((await ask(app, "admin", { mode: "cluster_only" })).json()).toEqual({ error: "cluster_only_needs_no_approval" });
    expect((await ask(app, "admin", { mode: "cloud_after_wait" })).statusCode).toBe(400);
    expect((await ask(app, "admin", { mode: "cloud_now" }, "task_x")).statusCode).toBe(404);
  });
});

describe("the service API that answers a request", () => {
  const answer = (app: Awaited<ReturnType<typeof makeApp>>, authorization: string | undefined, payload: Record<string, unknown>, id = "cmreq_1") =>
    app.inject({
      method: "POST",
      url: `/api/cloud-models/requests/${id}/answer`,
      headers: authorization ? { authorization } : {},
      payload,
    });
  const APPROVE = { decision: "approve", approverEmail: "approver@example.com" };

  it("answers with the service token for an approver on the list", async () => {
    const app = await makeApp();
    const r = await answer(app, `Bearer ${TOKEN}`, { ...APPROVE, note: "Fine for this one." });
    expect(r.statusCode).toBe(200);
    expect(state.answerCalls).toEqual([{ requestId: "cmreq_1", answer: { ...APPROVE, note: "Fine for this one." } }]);
    const deny = await answer(app, `Bearer ${TOKEN}`, { decision: "deny", approverEmail: "SOMEONE-ELSE@example.com" });
    expect(deny.statusCode).toBe(200);
  });

  it("refuses a missing or wrong token, and a session", async () => {
    const app = await makeApp();
    expect((await answer(app, undefined, APPROVE)).statusCode).toBe(401);
    expect((await answer(app, `Bearer ${TOKEN}x`, APPROVE)).statusCode).toBe(401);
    expect((await answer(app, TOKEN, APPROVE)).statusCode).toBe(401);
    const asSession = await app.inject({ method: "POST", url: "/api/cloud-models/requests/cmreq_1/answer", headers: { "x-user": "approver" }, payload: APPROVE });
    expect(asSession.statusCode).toBe(401);
    expect(state.answerCalls).toHaveLength(0);
  });

  it("is off without a token, or with a token under 32 characters", async () => {
    for (const t of ["", "short-token"]) {
      vi.stubEnv("CLOUD_APPROVAL_TOKEN", t);
      const app = await makeApp();
      expect((await answer(app, `Bearer ${t}`, APPROVE)).statusCode, t).toBe(404);
    }
    expect(state.answerCalls).toHaveLength(0);
  });

  it("refuses an email that is not on the approver list, and a bad body", async () => {
    const app = await makeApp();
    const r = await answer(app, `Bearer ${TOKEN}`, { decision: "approve", approverEmail: "admin@example.com" });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "not_an_approver" });
    expect((await answer(app, `Bearer ${TOKEN}`, { decision: "maybe", approverEmail: "approver@example.com" })).statusCode).toBe(400);
    expect(state.answerCalls).toHaveLength(0);
  });

  it("answers 404 for a request that is gone", async () => {
    const app = await makeApp();
    expect((await answer(app, `Bearer ${TOKEN}`, APPROVE, "cmreq_old")).statusCode).toBe(404);
  });
});

describe("agents", () => {
  const headers = { authorization: "Bearer agent-token" };

  it("can read the setting of a task in their workspace", async () => {
    const app = await makeApp();
    const r = await app.inject({ method: "GET", url: "/api/agent-api/tasks/task_1/cloud-models", headers });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ taskId: "task_1", setting: { mode: "cluster_only" } });
    const other = await app.inject({ method: "GET", url: "/api/agent-api/tasks/task_x/cloud-models", headers });
    expect(other.statusCode).toBe(404);
  });

  it("can never change it", async () => {
    const app = await makeApp();
    for (const method of ["PUT", "POST", "PATCH", "DELETE"] as const) {
      const viaAgentApi = await app.inject({ method, url: "/api/agent-api/tasks/task_1/cloud-models", headers, payload: { mode: "cloud_now" } });
      expect(viaAgentApi.statusCode, method).toBe(404);
    }
    const viaPeopleRoute = await app.inject({ method: "PUT", url: "/api/tasks/task_1/cloud-models", headers, payload: { mode: "cloud_now" } });
    expect(viaPeopleRoute.statusCode).toBe(401);
    expect(state.setCalls).toHaveLength(0);
  });

  it("can't make a request or answer one", async () => {
    const app = await makeApp();
    const viaAgentApi = await app.inject({ method: "POST", url: "/api/agent-api/tasks/task_1/cloud-models/requests", headers, payload: { mode: "cloud_now" } });
    expect(viaAgentApi.statusCode).toBe(404);
    const viaPeopleRoute = await app.inject({ method: "POST", url: "/api/tasks/task_1/cloud-models/requests", headers, payload: { mode: "cloud_now" } });
    expect(viaPeopleRoute.statusCode).toBe(401);
    const answer = await app.inject({
      method: "POST",
      url: "/api/cloud-models/requests/cmreq_1/answer",
      headers,
      payload: { decision: "approve", approverEmail: "approver@example.com" },
    });
    expect(answer.statusCode).toBe(401);
    expect(state.requestCalls).toHaveLength(0);
    expect(state.answerCalls).toHaveLength(0);
  });
});

describe("the workspace option", () => {
  it("only admins can change it", async () => {
    const app = await makeApp();
    const asMember = await app.inject({ method: "PUT", url: "/api/cloud-models/policy", headers: { "x-user": "member" }, payload: { membersCanChange: true } });
    expect(asMember.statusCode).toBe(403);
    const asAdmin = await app.inject({ method: "PUT", url: "/api/cloud-models/policy", headers: { "x-user": "admin" }, payload: { membersCanChange: true } });
    expect(asAdmin.statusCode).toBe(200);
    expect(state.policyCalls).toEqual([{ workspaceId: "ws_1", membersCanChange: true, actor: "m_admin" }]);
  });
});
