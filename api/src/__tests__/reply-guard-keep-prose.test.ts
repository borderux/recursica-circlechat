import { describe, it, expect } from "vitest";
import { checkReplyBody, withoutPastedCode } from "../agents/reply-guard.js";
import { guardKeepingProse, type ExecOutcome } from "../agents/executor.js";

// A reply refused for pasted code still holds what the person asked for: what was built and
// where to see it. The guard's refusal stands for the code; the prose posts without it, with
// each preview address the reply named, and the run records how much was removed, never the code.

// The shape of the refused reply: a short report, then a write_file-style diff of the page.
const report = [
  "Built the pricing page with the three plan cards and the comparison table.",
  "",
  "Here's the diff:",
  "+import { Card, Table } from \"./ui\";",
  "+export default function PricingPage() {",
  "+  const plans = loadPlans();",
  "+  return <Card title=\"Plans\" />;",
  "+}",
].join("\n");

const outcome = (): ExecOutcome => ({ actionsApplied: 0, errors: [], trace: [] });

describe("withoutPastedCode", () => {
  it("keeps the prose of a reply refused for a pasted diff, and drops the line that introduced it", () => {
    expect(checkReplyBody(report)).toEqual({ ok: false, reason: "code_diff_leak" });
    const kept = withoutPastedCode(report);
    expect(kept).not.toBeNull();
    expect(kept!.bodyMd).toBe("Built the pricing page with the three plan cards and the comparison table.");
    expect(kept!.removal).toMatchObject({ blocks: 0, lines: 5, previewsKept: 0 });
    expect(kept!.removal.chars).toBeGreaterThan(100);
  });

  it("adds back a preview route that only the removed code named", () => {
    const body = `${report}\n+// served at /preview/pricing-page`;
    const kept = withoutPastedCode(body)!;
    expect(kept.bodyMd).toContain("Built the pricing page");
    expect(kept.bodyMd).toContain("Preview: /preview/pricing-page");
    expect(kept.bodyMd).not.toMatch(/import|PricingPage\(|loadPlans/);
    expect(kept.removal.previewsKept).toBe(1);
  });

  it("names a preview address once when the prose already gives it", () => {
    const body = `Done. Open https://app.example.com/preview/pricing-page to see it.\n${report.split("\n").slice(3).join("\n")}`;
    const kept = withoutPastedCode(body)!;
    expect(kept.bodyMd).toBe("Done. Open https://app.example.com/preview/pricing-page to see it.");
    expect(kept.removal.previewsKept).toBe(0);
  });

  it("removes fenced blocks, diff headers and an unclosed fence, and keeps a list", () => {
    const body = [
      "The settings page is ready:",
      "- a header with the account name",
      "- a form for the email preferences",
      "```tsx",
      "export function Settings() { return null; }",
      "```",
      "diff --git a/src/Settings.tsx b/src/Settings.tsx",
      "--- a/src/Settings.tsx",
      "+++ b/src/Settings.tsx",
      "@@ -1,3 +1,4 @@",
      "+const a = 1;",
      "+const b = 2;",
      "-const c = 3;",
      "It shows at /preview/settings.",
      "```",
      "const unclosed = true;",
    ].join("\n");
    expect(checkReplyBody(body)).toMatchObject({ ok: false, reason: "code_diff_leak" });
    const kept = withoutPastedCode(body)!;
    expect(kept.bodyMd).toBe([
      "The settings page is ready:",
      "- a header with the account name",
      "- a form for the email preferences",
      "It shows at /preview/settings.",
    ].join("\n"));
    expect(kept.removal.blocks).toBe(2);
    expect(kept.removal.previewsKept).toBe(0);
  });

  it("returns nothing when only code was sent, or what remains would not pass on its own", () => {
    expect(withoutPastedCode(report.split("\n").slice(3).join("\n"))).toBeNull();
    expect(withoutPastedCode(`ok\n${report.split("\n").slice(3).join("\n")}`)).toBeNull();
    expect(withoutPastedCode("A reply with no code in it at all, nothing to remove.")).toBeNull();
  });
});

describe("guardKeepingProse", () => {
  it("posts the prose and records where the code was removed, never the code", () => {
    const out = outcome();
    const guard = guardKeepingProse(report, { hasAttachments: false }, out, { surface: "task_comment", conversationId: null, taskId: "task_1" });
    expect(guard).toEqual({ ok: true, bodyMd: "Built the pricing page with the three plan cards and the comparison table." });
    expect(out.codeRemoved).toEqual([
      expect.objectContaining({ surface: "task_comment", conversationId: null, taskId: "task_1", reason: "code_diff_leak", lines: 5, blocks: 0, previewsKept: 0 }),
    ]);
    expect(out.trace).toEqual(["task_comment: code_diff_leak; removed 5 line(s) of code for task_1 and posted the prose"]);
    expect(out.errors).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/import|PricingPage|loadPlans/);
  });

  it("keeps the refusal, with nothing recorded, when no prose is left or the reason is not pasted code", () => {
    const out = outcome();
    const codeOnly = report.split("\n").slice(3).join("\n");
    expect(guardKeepingProse(codeOnly, {}, out, { surface: "message", conversationId: "c_1" })).toEqual({ ok: false, reason: "code_diff_leak" });
    expect(guardKeepingProse("HEARTBEAT_OK", {}, out, { surface: "message", conversationId: "c_1" })).toMatchObject({ ok: false });
    expect(out.codeRemoved).toBeUndefined();
    expect(out.trace).toEqual([]);
  });

  it("leaves a reply the guard passes as it is", () => {
    const out = outcome();
    const body = "The pricing page is built and shows at /preview/pricing-page.";
    expect(guardKeepingProse(body, {}, out, { surface: "message", conversationId: "c_1" })).toEqual(checkReplyBody(body));
    expect(out.codeRemoved).toBeUndefined();
  });
});
