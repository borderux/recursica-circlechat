import { describe, it, expect } from "vitest";
import {
  describeCloudModels,
  describePendingRequest,
  formatMinutes,
  keepChoiceLabel,
  parseMinutes,
  MAX_CLOUD_WAIT_MINUTES,
} from "./cloudModels";

describe("describeCloudModels", () => {
  it("names each value, with the two times for Cloud after a wait", () => {
    expect(describeCloudModels({ mode: "cluster_only" })).toBe("Cluster only");
    expect(describeCloudModels({ mode: "cloud_now" })).toBe("Cloud now");
    expect(describeCloudModels({ mode: "cloud_after_wait", maxStartWaitMinutes: 15, maxFinishMinutes: 150 })).toBe(
      "Cloud after a wait (start within 15 min, finish within 2 h 30 min)",
    );
  });

  it("treats a missing setting as Cluster only", () => {
    expect(describeCloudModels(undefined)).toBe("Cluster only");
  });
});

describe("minutes", () => {
  it("formats minutes and hours", () => {
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(120)).toBe("2 h");
  });

  it("accepts whole minutes from 1 to a week only", () => {
    expect(parseMinutes(" 30 ")).toBe(30);
    expect(parseMinutes(String(MAX_CLOUD_WAIT_MINUTES))).toBe(MAX_CLOUD_WAIT_MINUTES);
    for (const bad of ["", "0", "1.5", "-3", "abc", String(MAX_CLOUD_WAIT_MINUTES + 1)]) {
      expect(parseMinutes(bad), bad).toBeNull();
    }
  });
});

describe("requests to an approver", () => {
  it("says what the pending request asks for, who asked, and when", () => {
    const pending = {
      id: "cmreq_1",
      setting: { mode: "cloud_now" as const },
      requestedBy: { memberId: "m_1", name: "Sam" },
      requestedAt: "2026-10-31T17:00:00.000Z",
    };
    expect(describePendingRequest(pending, (iso) => iso.slice(0, 10))).toBe(
      "Waiting for an approver: Cloud now, asked by Sam on 2026-10-31.",
    );
  });

  it("names the dialog's choice that sends no request", () => {
    expect(keepChoiceLabel({ mode: "cluster_only" })).toBe("Keep the task on the cluster");
    expect(keepChoiceLabel({ mode: "cloud_now" })).toBe("Keep the current setting");
  });
});
