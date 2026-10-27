// Fork: the "Cloud models" setting on a task (see
// lib/cloud-models-rules.ts).
//
// People read and change it here. Agents can read it through
// GET /agent-api/tasks/:id/cloud-models but have no route that changes it:
// the PUT below takes a person's session, never an agent's bot token.
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
import { CloudModelsBody, canChangeCloudModels } from "../lib/cloud-models-rules.js";
import { requireAgentToken } from "./agent-api.js";

const PolicyBody = z.object({ membersCanChange: z.boolean() }).strict();

async function callerPermissions(req: FastifyRequest): Promise<string[]> {
  const access = await workspaceAccess(req.auth!.workspaceId!, req.auth!.userId);
  return access?.permissions ?? [];
}

async function canEdit(req: FastifyRequest, membersCanChange: boolean): Promise<boolean> {
  return canChangeCloudModels({
    permissions: await callerPermissions(req),
    membersCanChange,
    spectator: req.spectator,
  });
}

async function taskInWorkspace(taskId: string, workspaceId: string, reply: FastifyReply): Promise<boolean> {
  const task = await loadTask(taskId);
  if (task && task.workspaceId === workspaceId) return true;
  reply.code(404).send({ error: "not_found" });
  return false;
}

export default async function cloudModelsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/tasks/:id/cloud-models", { preHandler: requireWorkspace }, async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const workspaceId = req.auth!.workspaceId!;
    if (!(await taskInWorkspace(taskId, workspaceId, reply))) return;
    const membersCanChange = await membersCanChangeCloudModels(workspaceId);
    return {
      setting: await getTaskCloudModels(taskId),
      canEdit: await canEdit(req, membersCanChange),
      membersCanChange,
    };
  });

  app.put("/tasks/:id/cloud-models", { preHandler: requireWorkspace }, async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const workspaceId = req.auth!.workspaceId!;
    const body = CloudModelsBody.parse(req.body);
    if (!(await canEdit(req, await membersCanChangeCloudModels(workspaceId)))) {
      return reply.code(403).send({ error: "cloud_models_admin_only" });
    }
    const r = await setTaskCloudModels(taskId, workspaceId, body, req.auth!.memberId!);
    if ("error" in r) return reply.code(404).send({ error: r.error });
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
