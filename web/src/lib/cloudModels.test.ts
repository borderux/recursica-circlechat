import { describe, it, expect } from "vitest";
import { describeCloudModels, formatMinutes, parseMinutes, MAX_CLOUD_WAIT_MINUTES } from "./cloudModels";

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
