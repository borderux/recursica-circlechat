// Fork: each agent's queue of waiting requests, and the task priority that
// orders it (agents/turn-queue.ts, lib/task-priority.ts). People read the
// queue on the agent's page and set a task's priority in the task view.
// Agents have no route that changes a priority.
import { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireWorkspace } from "../auth/session.js";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";
import { loadTask } from "../lib/tasks-core.js";
import { getTaskPriority, setTaskPriority } from "../lib/task-priority.js";
import { PRIORITIES, agentQueueView } from "../agents/turn-queue.js";

const PriorityBody = z.object({ priority: z.enum(PRIORITIES) }).strict();

export default async function agentQueueRoutes(app: FastifyInstance): Promise<void> {
  app.get("/agents/:id/queue", { preHandler: requireWorkspace }, async (req, reply) => {
    const agentId = (req.params as { id: string }).id;
    const [a] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, req.auth!.workspaceId!)))
      .limit(1);
    if (!a) return reply.code(404).send({ error: "not_found" });
    return agentQueueView(agentId);
  });

  app.get("/tasks/:id/priority", { preHandler: requireWorkspace }, async (req, reply) => {
    const taskId = (req.params as { id: string }).id;
    const task = await loadTask(taskId);
    if (!task || task.workspaceId !== req.auth!.workspaceId) return reply.code(404).send({ error: "not_found" });
    return { priority: await getTaskPriority(taskId), canEdit: !req.spectator };
  });

  app.put("/tasks/:id/priority", { preHandler: requireWorkspace }, async (req, reply) => {
    if (req.spectator) return reply.code(403).send({ error: "read_only" });
    const taskId = (req.params as { id: string }).id;
    const body = PriorityBody.parse(req.body);
    const r = await setTaskPriority(taskId, req.auth!.workspaceId!, body.priority, req.auth!.memberId!);
    if ("error" in r) return reply.code(404).send({ error: r.error });
    return r;
  });
}
