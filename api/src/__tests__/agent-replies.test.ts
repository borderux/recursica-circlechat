import { describe, it, expect, beforeAll } from "vitest";
import { checkReplyBody } from "../agents/reply-guard.js";
import { CHAT_BODY_MAX, SUMMARY_MAX, TASK_BODY_MAX, bodyLimit, splitLongReply } from "../agents/long-reply.js";
import {
  deliverablesOnlyFrom,
  fileActionsFirst,
  notAttachedNote,
  reviewDenial,
  type ApplyCtx,
} from "../agents/executor.js";
import { CLAIMED_FILES_REPLY, TOOL_CALL_AS_TEXT_REPLY } from "./fixtures/agent-replies.js";

// Two replies a gpt-oss agent gave on one day (fixtures/agent-replies.ts):
//   1. a tool call written as text, {"code": "import os, …"}, posted to a channel cut to 2,000
//      characters;
//   2. "have been created and attached to the task", for four files it never wrote, with a
//      share_to_task that attached nothing and an update_task to review that went through.

type Turn = { exitError?: string; rawText: string; runtimeFound: string[] };
type Bridge = {
  looksLikeTextToolCall: (text: string) => boolean;
  extractActions: (raw: string) => { body: string; actions: Array<{ type: string }> };
  clipChatBody: (text: string) => string;
  turnForWaitingPerson: (
    runOnce: (prompt: string) => Promise<Turn>,
    prompt: string,
    opts: { waiting: boolean; timeoutMs: number; now?: () => number },
  ) => Promise<Turn & { retried: boolean; reran: boolean; silent: boolean; note: boolean; toolCallAsText: boolean }>;
  TOOL_CALL_REMINDER: string;
  DELIVERABLES_ONLY_RULE: string;
  buildPrompt: (entry: unknown, packet: unknown) => string;
};
let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as Bridge;
});

const turns = (...replies: string[]) => {
  const prompts: string[] = [];
  const runOnce = async (prompt: string): Promise<Turn> => {
    prompts.push(prompt);
    return { rawText: replies[prompts.length - 1] ?? "", runtimeFound: [] };
  };
  return { runOnce, prompts };
};

describe("a tool call written as text is never posted", () => {
  it("the bridge knows today's reply for a tool call, and prose for prose", () => {
    expect(TOOL_CALL_AS_TEXT_REPLY.length).toBeGreaterThan(CHAT_BODY_MAX);
    expect(TOOL_CALL_AS_TEXT_REPLY.startsWith('{\n  "code": "import os')).toBe(true);
    expect(bridge.looksLikeTextToolCall(TOOL_CALL_AS_TEXT_REPLY)).toBe(true);
    expect(bridge.looksLikeTextToolCall("```json\n" + TOOL_CALL_AS_TEXT_REPLY + "\n```")).toBe(true);
    expect(bridge.looksLikeTextToolCall('{"command": "ls -R /workspace"')).toBe(true);
    expect(bridge.looksLikeTextToolCall('<|start|>assistant<|channel|>commentary to=functions.write_file')).toBe(true);
    expect(bridge.looksLikeTextToolCall("Done: the transcript is on the task card.")).toBe(false);
    expect(bridge.looksLikeTextToolCall('The config uses {"retries": 3} by default, which is fine.')).toBe(false);
    expect(bridge.looksLikeTextToolCall(bridge.extractActions(CLAIMED_FILES_REPLY).body)).toBe(false);
  });

  it("reruns the turn once with the reminder, and posts the rerun's prose", async () => {
    const t = turns(TOOL_CALL_AS_TEXT_REPLY, "Both transcripts are written and attached to the task.");
    const r = await bridge.turnForWaitingPerson(t.runOnce, "PROMPT", { waiting: true, timeoutMs: 480_000 });
    expect(t.prompts).toEqual(["PROMPT", `PROMPT\n\n${bridge.TOOL_CALL_REMINDER}`]);
    expect(r).toMatchObject({ reran: true, silent: false, toolCallAsText: false });
  });

  it("posts nothing when the rerun is a tool call as text again, and says so to a waiting person", async () => {
    const t = turns(TOOL_CALL_AS_TEXT_REPLY, TOOL_CALL_AS_TEXT_REPLY);
    const r = await bridge.turnForWaitingPerson(t.runOnce, "PROMPT", { waiting: true, timeoutMs: 480_000 });
    expect(t.prompts.length).toBe(2);
    expect(r).toMatchObject({ reran: true, silent: true, toolCallAsText: true, note: true });
    // In the background, the same: dropped, and no note.
    const quiet = turns(TOOL_CALL_AS_TEXT_REPLY, TOOL_CALL_AS_TEXT_REPLY);
    const q = await bridge.turnForWaitingPerson(quiet.runOnce, "PROMPT", { waiting: false, timeoutMs: 480_000 });
    expect(q).toMatchObject({ silent: true, toolCallAsText: true, note: false });
  });

  it("reruns only when the first turn left time for it", async () => {
    let clock = 0;
    const t = turns(TOOL_CALL_AS_TEXT_REPLY, "unused");
    const runOnce = async (p: string) => {
      clock += 300_000;
      return t.runOnce(p);
    };
    const r = await bridge.turnForWaitingPerson(runOnce, "PROMPT", { waiting: true, timeoutMs: 480_000, now: () => clock });
    expect(t.prompts.length).toBe(1);
    expect(r).toMatchObject({ reran: false, silent: true, toolCallAsText: true });
  });

  it("the api refuses it too, whole or cut with the bridge's old note", () => {
    expect(checkReplyBody(TOOL_CALL_AS_TEXT_REPLY)).toMatchObject({ ok: false, reason: "tool_call_as_text" });
    const cut = bridge.clipChatBody(TOOL_CALL_AS_TEXT_REPLY);
    expect(cut).toMatch(/_Cut to fit chat: \d+ more characters were not posted/);
    expect(checkReplyBody(cut)).toMatchObject({ ok: false });
  });
});

describe("a long reply is attached as a file, never cut", () => {
  const long = JSON.parse(TOOL_CALL_AS_TEXT_REPLY).code.split("'''")[1] as string;

  it("keeps the opening paragraph in the message and the whole text in reply.md", () => {
    expect(long.length).toBeGreaterThan(CHAT_BODY_MAX);
    const split = splitLongReply(long, CHAT_BODY_MAX);
    expect(split.file?.name).toBe("reply.md");
    expect(split.file?.text.trimEnd()).toBe(long.trimEnd());
    expect(split.body.length).toBeLessThan(600);
    expect(split.body).toContain("⚠️ SYNTHETIC");
    expect(split.body).toMatch(/_The full text \([\d,]+ characters\) is attached as reply\.md\._$/);
    expect(checkReplyBody(split.body, { hasAttachments: true }).ok).toBe(true);
  });

  it("leaves a reply that fits alone, and uses a summary's length for a deliverables-only agent", () => {
    expect(splitLongReply("Short answer.", CHAT_BODY_MAX)).toEqual({ body: "Short answer.", file: null });
    expect(bodyLimit("chat", false)).toBe(CHAT_BODY_MAX);
    expect(bodyLimit("task", false)).toBe(TASK_BODY_MAX);
    expect(bodyLimit("chat", true)).toBe(SUMMARY_MAX);
    expect(bodyLimit("task", true)).toBe(SUMMARY_MAX);
    expect(splitLongReply(long.slice(0, 1500), bodyLimit("chat", true)).file).not.toBeNull();
  });
});

describe("a claim of files that do not exist is flagged", () => {
  const prose = () => bridge.extractActions(CLAIMED_FILES_REPLY).body.trim();

  it("today's 'have been created and attached to the task' counts as a claim", () => {
    // The executor always says whether anything attached.
    const none = { hasAttachments: false };
    expect(checkReplyBody(prose(), none)).toMatchObject({ ok: false, reason: "attachment_claim_no_file" });
    expect(checkReplyBody(prose(), { hasAttachments: true }).ok).toBe(true);
    for (const claim of [
      "The report has been uploaded to the task card for your review.",
      "I've uploaded the transcript to the task card for your review.",
      "Both files were written and attached, ready for the review step.",
    ]) {
      expect(checkReplyBody(claim, none)).toMatchObject({ ok: false, reason: "attachment_claim_no_file" });
    }
    // A file someone else attached is not a claim.
    expect(checkReplyBody("I read the PDF attached to the task and the numbers match the brief.", none).ok).toBe(true);
  });

  it("runs the share first, so the message is checked against what really attached", () => {
    const actions = bridge.extractActions(CLAIMED_FILES_REPLY).actions;
    const turn = [{ type: "post_message" }, ...actions];
    expect(turn.map((a) => a.type)).toEqual(["post_message", "share_to_task", "update_task"]);
    expect(fileActionsFirst(turn).map((a) => a.type)).toEqual(["share_to_task", "post_message", "update_task"]);
    expect(fileActionsFirst([{ type: "attach_to_task" }, { type: "task_comment" }]).map((a) => a.type)).toEqual(["attach_to_task", "task_comment"]);
  });

  it("the note names what was not found, and is not itself a claim", () => {
    const missing = [
      "/workspace/writer/Transcripts_demo/00_STUDY_PLAN.txt",
      "/workspace/writer/Transcripts_demo/01_Tech Enthusiast_Alex_Rivera.txt",
    ];
    const note = notAttachedNote(missing);
    expect(note).toContain("`/workspace/writer/Transcripts_demo/00_STUDY_PLAN.txt`");
    expect(note).toContain("were not found in /workspace, so nothing was shared");
    expect(checkReplyBody(note, { hasAttachments: false }).ok).toBe(true);
    expect(checkReplyBody(notAttachedNote([]), { hasAttachments: false }).ok).toBe(true);
    expect(notAttachedNote(Array.from({ length: 7 }, (_, i) => `/workspace/w/${i}.txt`))).toContain("and 2 more");
  });

  it("a task does not go to review when every share in the turn failed, or without a deliverable for a deliverables-only agent", async () => {
    const failed: ApplyCtx = { filesAttached: 0, filesMissing: ["/workspace/writer/Transcripts_demo/00_STUDY_PLAN.txt"] };
    expect(await reviewDenial("task_demo", failed, async () => 1)).toMatch(/review_without_deliverable — none of the files/);
    expect(await reviewDenial("task_demo", { filesAttached: 1, filesMissing: ["/workspace/x"] }, async () => 0)).toBeNull();
    expect(await reviewDenial("task_demo", { filesAttached: 0, filesMissing: [] }, async () => 0)).toBeNull();
    expect(await reviewDenial("task_demo", { deliverablesOnly: true }, async () => 0)).toMatch(/has no deliverable/);
    expect(await reviewDenial("task_demo", { deliverablesOnly: true }, async () => 2)).toBeNull();
  });
});

describe("the deliverables-only setting", () => {
  it("is read from the agent's config, and only a true value turns it on", () => {
    expect(deliverablesOnlyFrom({ deliverablesOnly: true })).toBe(true);
    for (const c of [{}, null, undefined, { deliverablesOnly: "true" }, { deliverablesOnly: false }]) {
      expect(deliverablesOnlyFrom(c)).toBe(false);
    }
  });

  it("puts its rule in the prompt only for an agent that has it", () => {
    const packet = (deliverablesOnly: boolean) => ({
      trigger: "mention",
      agent: { handle: "writer", name: "Writer", memberId: "m_agent", deliverablesOnly },
      members: { m_person: { kind: "user", handle: "pat" } },
      inbox: [
        {
          conversationId: "c_test",
          conversationKind: "channel",
          conversationName: "test",
          conversationMembers: ["m_person", "m_agent"],
          messages: [{ id: "m1", memberId: "m_person", memberHandle: "pat", bodyMd: "@writer write a 500-word transcript" }],
        },
      ],
    });
    const on = bridge.buildPrompt({ handle: "writer", name: "Writer" }, packet(true));
    const off = bridge.buildPrompt({ handle: "writer", name: "Writer" }, packet(false));
    expect(on).toContain(bridge.DELIVERABLES_ONLY_RULE);
    // The transcript can be the reply itself: past 600 characters it is saved as a file.
    expect(on).toContain("A text document can be your reply itself. Past 600 characters the reply is saved as a file");
    expect(on).toContain("write it with the write_file tool under /workspace/<your handle>/");
    expect(off).not.toContain("DELIVERABLES ONLY");
  });
});
