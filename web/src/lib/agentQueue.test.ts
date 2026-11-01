import { describe, it, expect } from "vitest";
import { PRIORITIES, PRIORITY_LABELS, describeRequest, waitedFor } from "./agentQueue";

describe("the agent page's queue", () => {
  it("names each waiting request by what it is and its task", () => {
    expect(describeRequest({ trigger: "task_comment", taskTitle: "writer test 3" })).toBe("Comment on a task: writer test 3");
    expect(describeRequest({ trigger: "dm", taskTitle: null })).toBe("Direct message");
    expect(describeRequest({ trigger: "something_new", taskTitle: null })).toBe("something_new");
  });

  it("says how long a request has waited", () => {
    const now = Date.parse("2026-10-31T13:47:59Z");
    expect(waitedFor("2026-10-31T13:44:59Z", now)).toBe("3 min");
    expect(waitedFor("2026-10-31T13:47:50Z", now)).toBe("just now");
    expect(waitedFor("2026-10-31T11:44:59Z", now)).toBe("2 h 3 min");
  });

  it("labels every priority, most urgent first", () => {
    expect(PRIORITIES).toEqual(["urgent", "high", "normal", "low"]);
    for (const p of PRIORITIES) expect(PRIORITY_LABELS[p]).toBeTruthy();
  });
});
