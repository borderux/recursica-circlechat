// Fork: requests to move a task's "Cloud models" setting off Cluster only,
// for people who are not approvers (see cloud-models-rules.ts). A request
// leaves the setting unchanged. An approver answers the request through the
// service API, which posts a comment on the task and clears the request. A webhook
// announces each new request, so another tool can forward the request to the
// approvers.
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { members, users } from "../db/schema.js";
import { taskCloudModelRequests } from "../db/fork-schema.js";
import { config } from "./config.js";
import { publishToWorkspace } from "./events.js";
import { id } from "./ids.js";
import { signWebhook } from "./signed-webhook.js";
import { getTaskCloudModels, setTaskCloudModels } from "./cloud-models.js";
import { addComment, hydrateTasks, loadTask, logActivity } from "./tasks-core.js";
import {
  answerComment,
  rowFromSetting,
  settingFromRow,
  type CloudModelsSetting,
} from "./cloud-models-rules.js";

export type PendingRequest = {
  id: string;
  setting: CloudModelsSetting;
  requestedBy: { memberId: string; name: string };
  requestedAt: string;
};

type RequestRow = typeof taskCloudModelRequests.$inferSelect;

async function person(memberId: string): Promise<{ name: string; email: string | null }> {
  const [row] = await db
    .select({ name: users.name, email: users.email })
    .from(members)
    .innerJoin(users, eq(users.id, members.refId))
    .where(and(eq(members.id, memberId), eq(members.kind, "user")))
    .limit(1);
  return row ?? { name: "a former member", email: null };
}

async function view(row: RequestRow): Promise<PendingRequest> {
  return {
    id: row.id,
    setting: settingFromRow(row),
    requestedBy: { memberId: row.requestedBy, name: (await person(row.requestedBy)).name },
    requestedAt: row.requestedAt.toISOString(),
  };
}

export async function getPendingRequest(taskId: string): Promise<PendingRequest | null> {
  const [row] = await db
    .select()
    .from(taskCloudModelRequests)
    .where(eq(taskCloudModelRequests.taskId, taskId))
    .limit(1);
  return row ? view(row) : null;
}

async function announceTask(taskId: string, workspaceId: string): Promise<void> {
  const task = await loadTask(taskId);
  if (!task) return;
  const [hydrated] = await hydrateTasks([task]);
  await publishToWorkspace(workspaceId, { type: "task.updated", workspaceId, taskId, task: hydrated });
}

// Record a request. A new request on a task replaces the pending one, with a
// new id, so an answer to the old request finds nothing.
export async function createCloudModelsRequest(
  taskId: string,
  workspaceId: string,
  setting: CloudModelsSetting,
  requesterMemberId: string,
): Promise<{ error: "not_found" } | { request: PendingRequest }> {
  const task = await loadTask(taskId);
  if (!task || task.workspaceId !== workspaceId) return { error: "not_found" };
  const now = new Date();
  const values = { id: id("cmreq"), taskId, workspaceId, ...rowFromSetting(setting), requestedBy: requesterMemberId, requestedAt: now };
  await db
    .insert(taskCloudModelRequests)
    .values(values)
    .onConflictDoUpdate({ target: taskCloudModelRequests.taskId, set: values });
  await logActivity(taskId, requesterMemberId, "cloud_models_requested", { requestId: values.id, setting });
  await announceTask(taskId, workspaceId);

  const asker = await person(requesterMemberId);
  const request: PendingRequest = {
    id: values.id,
    setting,
    requestedBy: { memberId: requesterMemberId, name: asker.name },
    requestedAt: now.toISOString(),
  };
  void deliverRequestWebhook({
    type: "cloud_models.request.created",
    request: { ...request, requestedBy: { ...request.requestedBy, email: asker.email } },
    task: { id: taskId, workspaceId, title: task.title, url: `${config.publicBaseUrl.replace(/\/+$/, "")}/board?task=${taskId}` },
    answer: { method: "POST", path: `/api/cloud-models/requests/${values.id}/answer` },
  });
  return { request };
}

async function approverMember(workspaceId: string, email: string): Promise<string | null> {
  const [row] = await db
    .select({ memberId: members.id })
    .from(users)
    .innerJoin(members, and(eq(members.refId, users.id), eq(members.kind, "user"), eq(members.workspaceId, workspaceId)))
    .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`)
    .limit(1);
  return row?.memberId ?? null;
}

// Approve or deny a request, as the approver with this email. The caller has
// already checked the service token and that the email is on the approver
// list. The approver must also be a member of the task's workspace, because
// the answer's comment is posted as that member.
export async function answerCloudModelsRequest(
  requestId: string,
  answer: { decision: "approve" | "deny"; approverEmail: string; note?: string },
): Promise<
  | { error: "request_not_found" | "approver_not_in_workspace" }
  | { taskId: string; decision: "approve" | "deny"; setting: CloudModelsSetting }
> {
  const [pending] = await db
    .select()
    .from(taskCloudModelRequests)
    .where(eq(taskCloudModelRequests.id, requestId))
    .limit(1);
  if (!pending) return { error: "request_not_found" };
  const approver = await approverMember(pending.workspaceId, answer.approverEmail);
  if (!approver) return { error: "approver_not_in_workspace" };

  // Delete first, by id: of two answers sent at once, only one finds the row.
  const [taken] = await db
    .delete(taskCloudModelRequests)
    .where(eq(taskCloudModelRequests.id, requestId))
    .returning();
  if (!taken) return { error: "request_not_found" };

  const requested = settingFromRow(taken);
  if (answer.decision === "approve") {
    await setTaskCloudModels(taken.taskId, taken.workspaceId, requested, approver);
  }
  const current = await getTaskCloudModels(taken.taskId);
  await logActivity(taken.taskId, approver, "cloud_models_request_answered", {
    requestId,
    decision: answer.decision,
    requestedBy: taken.requestedBy,
    setting: requested,
  });
  await addComment(
    taken.taskId,
    answerComment({
      decision: answer.decision,
      requesterName: (await person(taken.requestedBy)).name,
      requested,
      current,
      note: answer.note || undefined,
    }),
    [taken.requestedBy],
    approver,
    taken.workspaceId,
  );
  await announceTask(taken.taskId, taken.workspaceId);
  return { taskId: taken.taskId, decision: answer.decision, setting: current };
}

// ───── the webhook ─────
//
// CLOUD_REQUEST_WEBHOOK_URL gets a POST for each new request. With
// CLOUD_REQUEST_WEBHOOK_SECRET set, the POST is signed the same way as the
// workflow webhooks: x-circlechat-signature is sha256=HMAC(secret,
// "<x-circlechat-timestamp>.<body>"). A failed POST is tried again twice; the
// request itself never waits for the webhook.

export function requestWebhookSettings(
  env: Record<string, string | undefined> = process.env,
): { url: string; secret: string | null } | null {
  const url = (env.CLOUD_REQUEST_WEBHOOK_URL ?? "").trim();
  if (!url) return null;
  return { url, secret: (env.CLOUD_REQUEST_WEBHOOK_SECRET ?? "").trim() || null };
}

export async function deliverRequestWebhook(
  event: Record<string, unknown>,
  opts: {
    settings?: { url: string; secret: string | null } | null;
    fetchImpl?: typeof fetch;
    retryDelaysMs?: number[];
    now?: () => Date;
  } = {},
): Promise<boolean> {
  const settings = opts.settings === undefined ? requestWebhookSettings() : opts.settings;
  if (!settings) return false;
  const doFetch = opts.fetchImpl ?? fetch;
  const delays = opts.retryDelaysMs ?? [5_000, 30_000];
  const body = JSON.stringify(event);
  const deliveryId = id("dlv");
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
    const timestamp = String(Math.floor((opts.now?.() ?? new Date()).getTime() / 1000));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-circlechat-event": String(event.type),
      "x-circlechat-delivery": deliveryId,
      "x-circlechat-timestamp": timestamp,
    };
    if (settings.secret) headers["x-circlechat-signature"] = signWebhook(settings.secret, timestamp, body);
    try {
      const res = await doFetch(settings.url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
      if (res.ok) return true;
      console.warn(`[cloud-models] request webhook answered ${res.status} (try ${attempt + 1})`);
    } catch (e) {
      console.warn(`[cloud-models] request webhook failed (try ${attempt + 1}): ${(e as Error).message}`);
    }
  }
  return false;
}
