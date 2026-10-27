// HTTP behaviour of the Cloud models routes, with the DB and auth replaced by
// fakes so no database or Redis is needed.
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

const state = vi.hoisted(() => ({
  membersCanChange: false,
  setCalls: [] as Array<{ taskId: string; workspaceId: string; next: unknown; actor: string }>,
  policyCalls: [] as Array<{ workspaceId: string; membersCanChange: boolean; actor: string }>,
}));

// Sessions: header x-user = admin | member | guest | spectator. Agents: a bot
// token. Neither works on the other's routes, as in the real hooks.
const USERS: Record<string, { userId: string; memberId: string; spectator?: boolean }> = {
  admin: { userId: "u_admin", memberId: "m_admin" },
  member: { userId: "u_member", memberId: "m_member" },
  guest: { userId: "u_guest", memberId: "m_guest" },
  spectator: { userId: "u_spec", memberId: "m_spec", spectator: true },
};
const ROLES: Record<string, string> = { u_admin: "admin", u_member: "member", u_guest: "guest", u_spec: "admin" };

vi.mock("../auth/session.js", () => ({
  requireWorkspace: async (req: FastifyRequest, reply: FastifyReply) => {
    const u = USERS[String(req.headers["x-user"] ?? "")];
    if (!u) return reply.code(401).send({ error: "unauthenticated" });
    (req as unknown as { auth: unknown }).auth = { ...u, workspaceId: "ws_1", user: { id: u.userId } };
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

beforeEach(() => {
  state.membersCanChange = false;
  state.setCalls = [];
  state.policyCalls = [];
});

describe("changing a task's setting", () => {
  it("an admin can, and the change is recorded against the admin's member id", async () => {
    const app = await makeApp();
    const r = await app.inject({ method: "PUT", url: "/api/tasks/task_1/cloud-models", headers: { "x-user": "admin" }, payload: AFTER_WAIT });
    expect(r.statusCode).toBe(200);
    expect(state.setCalls).toEqual([{ taskId: "task_1", workspaceId: "ws_1", next: AFTER_WAIT, actor: "m_admin" }]);
  });

  it("a member can't by default, and can once the workspace option is on", async () => {
    const app = await makeApp();
    const put = () =>
      app.inject({ method: "PUT", url: "/api/tasks/task_1/cloud-models", headers: { "x-user": "member" }, payload: { mode: "cloud_now" } });
    expect((await put()).statusCode).toBe(403);
    expect(state.setCalls).toHaveLength(0);
    state.membersCanChange = true;
    expect((await put()).statusCode).toBe(200);
    expect(state.setCalls[0].actor).toBe("m_member");
  });

  it("guests and spectators can't, even with the option on", async () => {
    state.membersCanChange = true;
    const app = await makeApp();
    for (const who of ["guest", "spectator"]) {
      const r = await app.inject({ method: "PUT", url: "/api/tasks/task_1/cloud-models", headers: { "x-user": who }, payload: { mode: "cloud_now" } });
      expect(r.statusCode, who).toBe(403);
    }
    expect(state.setCalls).toHaveLength(0);
  });

  it("refuses a bad value and a task in another workspace", async () => {
    const app = await makeApp();
    const bad = await app.inject({ method: "PUT", url: "/api/tasks/task_1/cloud-models", headers: { "x-user": "admin" }, payload: { mode: "cloud_after_wait" } });
    expect(bad.statusCode).toBe(400);
    const other = await app.inject({ method: "PUT", url: "/api/tasks/task_x/cloud-models", headers: { "x-user": "admin" }, payload: { mode: "cloud_now" } });
    expect(other.statusCode).toBe(404);
  });

  it("tells the task view whether the caller can edit", async () => {
    const app = await makeApp();
    const asMember = await app.inject({ method: "GET", url: "/api/tasks/task_1/cloud-models", headers: { "x-user": "member" } });
    expect(asMember.json()).toEqual({ setting: { mode: "cluster_only" }, canEdit: false, membersCanChange: false });
    const asAdmin = await app.inject({ method: "GET", url: "/api/tasks/task_1/cloud-models", headers: { "x-user": "admin" } });
    expect(asAdmin.json().canEdit).toBe(true);
  });
});

describe("agents", () => {
  it("can read the setting of a task in their workspace", async () => {
    const app = await makeApp();
    const r = await app.inject({ method: "GET", url: "/api/agent-api/tasks/task_1/cloud-models", headers: { authorization: "Bearer agent-token" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ taskId: "task_1", setting: { mode: "cluster_only" } });
    const other = await app.inject({ method: "GET", url: "/api/agent-api/tasks/task_x/cloud-models", headers: { authorization: "Bearer agent-token" } });
    expect(other.statusCode).toBe(404);
  });

  it("can never change it", async () => {
    const app = await makeApp();
    const headers = { authorization: "Bearer agent-token" };
    for (const method of ["PUT", "POST", "PATCH", "DELETE"] as const) {
      const viaAgentApi = await app.inject({ method, url: "/api/agent-api/tasks/task_1/cloud-models", headers, payload: { mode: "cloud_now" } });
      expect(viaAgentApi.statusCode, method).toBe(404);
    }
    const viaPeopleRoute = await app.inject({ method: "PUT", url: "/api/tasks/task_1/cloud-models", headers, payload: { mode: "cloud_now" } });
    expect(viaPeopleRoute.statusCode).toBe(401);
    expect(state.setCalls).toHaveLength(0);
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
