import { describe, it, expect } from "vitest";
import {
  CloudModelsAnswerBody,
  CloudModelsBody,
  DEFAULT_CLOUD_MODELS,
  MAX_CLOUD_WAIT_MINUTES,
  answerComment,
  approvalToken,
  canChangeCloudModels,
  cloudApprovers,
  cloudModelsAccess,
  describeCloudModels,
  isCloudApprover,
  needsApproval,
  rowFromSetting,
  runTaskId,
  sameSetting,
  settingFromRow,
  taskIdFromWorkflowInput,
} from "../lib/cloud-models-rules.js";
import { BUILTIN_PERMISSIONS } from "../lib/access-control.js";

describe("CloudModelsBody", () => {
  it("accepts the three values", () => {
    expect(CloudModelsBody.parse({ mode: "cluster_only" })).toEqual({ mode: "cluster_only" });
    expect(CloudModelsBody.parse({ mode: "cloud_now" })).toEqual({ mode: "cloud_now" });
    expect(
      CloudModelsBody.parse({ mode: "cloud_after_wait", maxStartWaitMinutes: 15, maxFinishMinutes: 120 }),
    ).toEqual({ mode: "cloud_after_wait", maxStartWaitMinutes: 15, maxFinishMinutes: 120 });
  });

  it("requires both times for Cloud after a wait, as whole minutes from 1 to a week", () => {
    const bad = [
      { mode: "cloud_after_wait" },
      { mode: "cloud_after_wait", maxStartWaitMinutes: 15 },
      { mode: "cloud_after_wait", maxStartWaitMinutes: 0, maxFinishMinutes: 10 },
      { mode: "cloud_after_wait", maxStartWaitMinutes: 1.5, maxFinishMinutes: 10 },
      { mode: "cloud_after_wait", maxStartWaitMinutes: 10, maxFinishMinutes: MAX_CLOUD_WAIT_MINUTES + 1 },
      { mode: "cloud_after_wait", maxStartWaitMinutes: "10", maxFinishMinutes: 10 },
    ];
    for (const b of bad) expect(CloudModelsBody.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  it("refuses unknown values and stray times", () => {
    expect(CloudModelsBody.safeParse({ mode: "cloud_sometimes" }).success).toBe(false);
    expect(CloudModelsBody.safeParse({ mode: "cloud_now", maxStartWaitMinutes: 5 }).success).toBe(false);
    expect(CloudModelsBody.safeParse({}).success).toBe(false);
  });
});

describe("stored rows", () => {
  it("no row means Cluster only", () => {
    expect(settingFromRow(null)).toEqual(DEFAULT_CLOUD_MODELS);
    expect(DEFAULT_CLOUD_MODELS).toEqual({ mode: "cluster_only" });
  });

  it("round-trips every value", () => {
    const all = [
      { mode: "cluster_only" as const },
      { mode: "cloud_now" as const },
      { mode: "cloud_after_wait" as const, maxStartWaitMinutes: 5, maxFinishMinutes: 60 },
    ];
    for (const s of all) expect(settingFromRow(rowFromSetting(s))).toEqual(s);
  });

  it("a half-filled or unknown row falls back to Cluster only, never to cloud", () => {
    expect(settingFromRow({ mode: "cloud_after_wait", maxStartWaitMinutes: 5, maxFinishMinutes: null })).toEqual(
      DEFAULT_CLOUD_MODELS,
    );
    expect(settingFromRow({ mode: "something_else", maxStartWaitMinutes: null, maxFinishMinutes: null })).toEqual(
      DEFAULT_CLOUD_MODELS,
    );
  });

  it("compares settings by value", () => {
    const a = { mode: "cloud_after_wait" as const, maxStartWaitMinutes: 5, maxFinishMinutes: 60 };
    expect(sameSetting(a, { ...a })).toBe(true);
    expect(sameSetting(a, { ...a, maxFinishMinutes: 61 })).toBe(false);
    expect(sameSetting({ mode: "cloud_now" }, { mode: "cluster_only" })).toBe(false);
  });
});

describe("canChangeCloudModels", () => {
  const admin = BUILTIN_PERMISSIONS.admin;
  const member = BUILTIN_PERMISSIONS.member;
  const guest = BUILTIN_PERMISSIONS.guest;

  it("by default only admins can change it", () => {
    expect(canChangeCloudModels({ permissions: admin, membersCanChange: false })).toBe(true);
    expect(canChangeCloudModels({ permissions: member, membersCanChange: false })).toBe(false);
    expect(canChangeCloudModels({ permissions: guest, membersCanChange: false })).toBe(false);
  });

  it("the workspace option lets every member change it, but not guests", () => {
    expect(canChangeCloudModels({ permissions: member, membersCanChange: true })).toBe(true);
    expect(canChangeCloudModels({ permissions: guest, membersCanChange: true })).toBe(false);
  });

  it("a custom role can grant it", () => {
    expect(canChangeCloudModels({ permissions: ["workspace.read", "tasks.cloud_models"], membersCanChange: false })).toBe(
      true,
    );
  });

  it("spectators never can, even as admins", () => {
    expect(canChangeCloudModels({ permissions: admin, membersCanChange: true, spectator: true })).toBe(false);
  });
});

describe("the task a run works on", () => {
  it("an agent run's own task wins", () => {
    expect(runTaskId({ taskId: "task_a" }, { taskId: "task_b" })).toBe("task_a");
  });

  it("a workflow run, webhook-started or not, names its task with taskId in its input", () => {
    expect(runTaskId({}, { taskId: "task_b", other: 1 })).toBe("task_b");
    expect(taskIdFromWorkflowInput({ taskId: "  task_c " })).toBe("task_c");
  });

  it("no task anywhere means none", () => {
    expect(runTaskId({})).toBeNull();
    expect(runTaskId({ taskId: null }, {})).toBeNull();
    expect(taskIdFromWorkflowInput({ taskId: 42 })).toBeNull();
    expect(taskIdFromWorkflowInput({ taskId: "  " })).toBeNull();
    expect(taskIdFromWorkflowInput(null)).toBeNull();
  });
});

describe("approvals", () => {
  const MEMBER = ["workspace.read", "workspace.write"];

  it("reads the approver list from CLOUD_APPROVERS, ignoring case and blanks", () => {
    const list = cloudApprovers({ CLOUD_APPROVERS: " One@Example.com,, two@example.com " });
    expect(list).toEqual(["one@example.com", "two@example.com"]);
    expect(isCloudApprover("ONE@example.com", list)).toBe(true);
    expect(isCloudApprover("three@example.com", list)).toBe(false);
    expect(isCloudApprover(null, list)).toBe(false);
    expect(cloudApprovers({})).toEqual([]);
  });

  it("only a move off Cluster only needs approval", () => {
    expect(needsApproval({ mode: "cluster_only" })).toBe(false);
    expect(needsApproval({ mode: "cloud_now" })).toBe(true);
    expect(needsApproval({ mode: "cloud_after_wait", maxStartWaitMinutes: 1, maxFinishMinutes: 1 })).toBe(true);
  });

  it("an approver needs a seat that can write, and is never a spectator", () => {
    const approvers = ["pat@example.com"];
    const base = { membersCanChange: false, email: "pat@example.com", approvers };
    expect(cloudModelsAccess({ ...base, permissions: MEMBER })).toEqual({ canEdit: true, isApprover: true });
    expect(cloudModelsAccess({ ...base, permissions: ["*"] })).toEqual({ canEdit: true, isApprover: true });
    expect(cloudModelsAccess({ ...base, permissions: ["workspace.read"] })).toEqual({ canEdit: false, isApprover: false });
    expect(cloudModelsAccess({ ...base, permissions: ["*"], spectator: true })).toEqual({ canEdit: false, isApprover: false });
  });

  it("everyone else keeps the old rule for who can edit, and is not an approver", () => {
    const base = { email: "sam@example.com", approvers: ["pat@example.com"] };
    expect(cloudModelsAccess({ ...base, permissions: ["*"], membersCanChange: false })).toEqual({ canEdit: true, isApprover: false });
    expect(cloudModelsAccess({ ...base, permissions: MEMBER, membersCanChange: false })).toEqual({ canEdit: false, isApprover: false });
    expect(cloudModelsAccess({ ...base, permissions: MEMBER, membersCanChange: true })).toEqual({ canEdit: true, isApprover: false });
  });

  it("turns the service API on only with a token of 32 characters or more", () => {
    expect(approvalToken({})).toBeNull();
    expect(approvalToken({ CLOUD_APPROVAL_TOKEN: "x".repeat(31) })).toBeNull();
    expect(approvalToken({ CLOUD_APPROVAL_TOKEN: ` ${"x".repeat(32)} ` })).toBe("x".repeat(32));
  });

  it("takes an answer with a decision, an approver's email and an optional note", () => {
    expect(CloudModelsAnswerBody.parse({ decision: "deny", approverEmail: " pat@example.com " })).toEqual({
      decision: "deny",
      approverEmail: "pat@example.com",
    });
    expect(() => CloudModelsAnswerBody.parse({ decision: "approve", approverEmail: "not-an-email" })).toThrow();
    expect(() => CloudModelsAnswerBody.parse({ decision: "approve", approverEmail: "pat@example.com", by: "agent" })).toThrow();
  });

  it("writes the answer's comment", () => {
    const requested = { mode: "cloud_after_wait" as const, maxStartWaitMinutes: 15, maxFinishMinutes: 120 };
    expect(describeCloudModels(requested)).toBe("Cloud after a wait (start within 15 min, finish within 120 min)");
    expect(answerComment({ decision: "approve", requesterName: "Sam", requested, current: requested })).toBe(
      "Approved the Cloud models request from Sam. The task now uses Cloud after a wait (start within 15 min, finish within 120 min).",
    );
    expect(
      answerComment({ decision: "deny", requesterName: "Sam", requested: { mode: "cloud_now" }, current: { mode: "cluster_only" }, note: "Not this week." }),
    ).toBe("Denied the Cloud models request from Sam for Cloud now. The task stays on Cluster only.\n\nNote: Not this week.");
  });
});
