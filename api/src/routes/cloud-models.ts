// Fork: the "Cloud models" setting on a task (see
// lib/cloud-models-rules.ts).
//
// People read and change the setting here. Only approvers (CLOUD_APPROVERS)
// move the setting off Cluster only directly. Anyone else who can change the
// setting sends a request, and an approver answers the request through the
// service API below. Agents can read the setting through
// GET /agent-api/tasks/:id/cloud-models. Agents have no route that changes
// the setting, asks for a change or answers a request. The people routes take
// a person's session, and the answer route takes the service token, never an
// agent's bot token.
import { timingSafeEqual } from "node:crypto";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireWorkspace } from "../auth/session.js";
import { workspaceAccess } from "../lib/access-control.js";
import { loadTask } from "../lib/tasks-core.js";
import {
  getTaskCloudModels,
  membersCanChangeCloudModels,
  setMembersCanChangeCloudModels,
  setTaskCloudModels,
} from "../lib/cloud-models.js";
import {
  answerCloudModelsRequest,
  createCloudModelsRequest,
  getPendingRequest,
} from "../lib/cloud-model-requests.js";
import {
  CloudModelsAnswerBody,
  CloudModelsBody,
  approvalToken,
  cloudApprovers,
  cloudModelsAccess,
  isCloudApprover,
  needsApproval,
} from "../lib/cloud-models-rules.js";
import { requireAgentToken } from "./agent-api.js";

const PolicyBody = z.object({ membersCanChange: z.boolean() }).strict();

async function callerPermissions(req: FastifyRequest): Promise<string[]> {
  const access = await workspaceAccess(req.auth!.workspaceId!, req.auth!.userId);
  return access?.permissions ?? [];
}

async function callerAccess(req: FastifyRequest, membersCanChange: boolean) {
  return cloudModelsAccess({
    permissions: await callerPermissions(req),
    membersCanChange,
    spectator: req.spectator,
    email: req.auth!.user?.email,
    approvers: cloudApprovers(),
  });
}

async function taskInWorkspace(taskId: string, workspaceId: string, reply: FastifyReply): Promise<boolean> {
  const task = await loadTask(taskId);
  if (task && task.workspaceId === workspaceId) return true;
  reply.code(404).send({ error: "not_found" });
  return false;
}

function tokenMatches(header: unknown, token: string): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length).trim(), "utf8");
  const want = Buffer.from(token, "utf8");
  return given.length === want.length && timingSafeEqual(given, want);
}

export default async function cloudModelsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/tasks/:id/cloud-models", { preHandler: requireWorkspace }, async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const workspaceId = req.auth!.workspaceId!;
    if (!(await taskInWorkspace(taskId, workspaceId, reply))) return;
    const membersCanChange = await membersCanChangeCloudModels(workspaceId);
    const access = await callerAccess(req, membersCanChange);
    return {
      setting: await getTaskCloudModels(taskId),
      canEdit: access.canEdit,
      isApprover: access.isApprover,
      membersCanChange,
      pendingRequest: await getPendingRequest(taskId),
    };
  });

  app.put("/tasks/:id/cloud-models", { preHandler: requireWorkspace }, async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const workspaceId = req.auth!.workspaceId!;
    const body = CloudModelsBody.parse(req.body);
    const access = await callerAccess(req, await membersCanChangeCloudModels(workspaceId));
    if (!access.canEdit) return reply.code(403).send({ error: "cloud_models_admin_only" });
    if (needsApproval(body) && !access.isApprover) {
      return reply.code(403).send({ error: "cloud_models_needs_approval" });
    }
    const r = await setTaskCloudModels(taskId, workspaceId, body, req.auth!.memberId!);
    if ("error" in r) return reply.code(404).send({ error: r.error });
    return r;
  });

  // Ask an approver to move the task off Cluster only. The setting stays
  // unchanged until an approver answers.
  app.post("/tasks/:id/cloud-models/requests", { preHandler: requireWorkspace }, async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const workspaceId = req.auth!.workspaceId!;
    const body = CloudModelsBody.parse(req.body);
    if (!needsApproval(body)) return reply.code(400).send({ error: "cluster_only_needs_no_approval" });
    const access = await callerAccess(req, await membersCanChangeCloudModels(workspaceId));
    if (!access.canEdit) return reply.code(403).send({ error: "cloud_models_admin_only" });
    const r = await createCloudModelsRequest(taskId, workspaceId, body, req.auth!.memberId!);
    if ("error" in r) return reply.code(404).send({ error: r.error });
    return reply.code(201).send(r);
  });

  // The service API: another tool answers a request for an approver. The
  // token is CLOUD_APPROVAL_TOKEN. Without a token, the route answers 404.
  app.post("/cloud-models/requests/:id/answer", async (req, reply) => {
    const token = approvalToken();
    if (!token) return reply.code(404).send({ error: "not_found" });
    if (!tokenMatches(req.headers.authorization, token)) {
      return reply.code(401).send({ error: "invalid_token" });
    }
    const body = CloudModelsAnswerBody.parse(req.body);
    if (!isCloudApprover(body.approverEmail, cloudApprovers())) {
      return reply.code(403).send({ error: "not_an_approver" });
    }
    const r = await answerCloudModelsRequest((req.params as { id: string }).id, body);
    if ("error" in r) return reply.code(r.error === "request_not_found" ? 404 : 403).send({ error: r.error });
    return r;
  });

  // The workspace option: may every member change the setting, or only admins?
  app.get("/cloud-models/policy", { preHandler: requireWorkspace }, async (req) => {
    return { membersCanChange: await membersCanChangeCloudModels(req.auth!.workspaceId!) };
  });

  app.put("/cloud-models/policy", { preHandler: requireWorkspace }, async (req, reply) => {
    const body = PolicyBody.parse(req.body);
    if (req.spectator || !(await callerPermissions(req)).includes("*")) {
      return reply.code(403).send({ error: "admin_only" });
    }
    await setMembersCanChangeCloudModels(req.auth!.workspaceId!, body.membersCanChange, req.auth!.memberId!);
    return { membersCanChange: body.membersCanChange };
  });

  // Read-only for agents.
  app.get("/agent-api/tasks/:id/cloud-models", { preHandler: requireAgentToken }, async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    if (!(await taskInWorkspace(taskId, req.agentCtx!.workspaceId, reply))) return;
    return { taskId, setting: await getTaskCloudModels(taskId) };
  });
}
