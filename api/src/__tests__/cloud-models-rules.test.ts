import { describe, it, expect } from "vitest";
import {
  CloudModelsBody,
  DEFAULT_CLOUD_MODELS,
  MAX_CLOUD_WAIT_MINUTES,
  canChangeCloudModels,
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
