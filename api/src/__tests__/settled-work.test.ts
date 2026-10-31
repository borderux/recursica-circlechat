import { describe, it, expect, beforeAll } from "vitest";
import {
  HEARTBEAT_CREATE_TASK_ERROR,
  TASK_ACTIONS,
  isHeartbeatTrigger,
  newWorkMessages,
  settledTaskError,
  taskIsSettled,
} from "../agents/settled-work.js";
import { checkReplyBody, textThenToolCall } from "../agents/reply-guard.js";

// One night of a gpt-oss agent, with the names made generic. By 23:08 every
// task it owned was in review and its backlog was empty. At 02:55 an ambient
// turn showed it the channel's history, a request it delivered at 21:58 among
// it; it made a new task from that request, assigned the task to itself, which
// woke it, and wrote the transcript again. At 03:17 it did the same once more.

const PERSON = "m_person";
const AGENT = "m_agent";
const at = (s: string) => new Date(`2026-10-30T${s}:00-07:00`);
const next = (s: string) => new Date(`2026-10-31T${s}:00-07:00`);

// The channel as the 02:55 ambient turn saw it.
const CHANNEL = [
  { id: "m1", conversationId: "c_test", memberId: PERSON, ts: at("21:37"), bodyMd: "@writer Write 1 short fake meeting transcript, a 30-minute product demo call." },
  { id: "m2", conversationId: "c_test", memberId: AGENT, ts: at("21:57"), bodyMd: "The files are attached to the task." },
  { id: "m3", conversationId: "c_test", memberId: PERSON, ts: at("22:24"), bodyMd: "@writer a transcript" },
  { id: "m4", conversationId: "c_test", memberId: AGENT, ts: at("23:08"), bodyMd: "Added the completed files and marked the task ready for review." },
];
// The agent's last run before 02:55 finished at 02:39.
const SINCE = next("02:39");

describe("a heartbeat turn picks up only new work", () => {
  it("scheduled and ambient turns are heartbeats; a mention or a task turn is not", () => {
    expect(isHeartbeatTrigger("scheduled")).toBe(true);
    expect(isHeartbeatTrigger("ambient")).toBe(true);
    for (const t of ["mention", "dm", "task_assigned", "task_comment", "continuation", undefined]) {
      expect(isHeartbeatTrigger(t)).toBe(false);
    }
  });

  it("shows the 02:55 ambient turn none of the delivered requests", () => {
    expect(newWorkMessages(CHANNEL, AGENT, SINCE)).toEqual([]);
  });

  it("never counts the agent's own posts, and drops a request it answered after", () => {
    // Had the last run been at 21:30, the 21:37 request is answered at 21:57
    // and the 22:24 one at 23:08: nothing is left.
    expect(newWorkMessages(CHANNEL, AGENT, at("21:30"))).toEqual([]);
    // A person's message after the agent's last post is new work.
    const later = { id: "m5", conversationId: "c_test", memberId: PERSON, ts: next("02:50"), bodyMd: "@writer one more, please" };
    expect(newWorkMessages([...CHANNEL, later], AGENT, SINCE).map((m) => m.id)).toEqual(["m5"]);
    // An answer in another conversation does not finish this one.
    const elsewhere = { ...later, id: "m6", conversationId: "c_other", ts: at("21:40") };
    expect(newWorkMessages([...CHANNEL, elsewhere], AGENT, at("21:30")).map((m) => m.id)).toEqual(["m6"]);
  });

  it("refuses create_task on a heartbeat with nothing new from a person", () => {
    expect(HEARTBEAT_CREATE_TASK_ERROR).toMatch(/^heartbeat_create_task: .*create_task did not run/);
    expect(HEARTBEAT_CREATE_TASK_ERROR).toContain("A request you already delivered is finished");
  });
});

describe("a task in review or done stays untouched until a person comments", () => {
  const REVIEW = { status: "review", settledAt: at("21:58"), lastPersonCommentAt: at("21:37"), assignedByOtherAt: at("21:37") };

  it("the night's review tasks are settled: only the agent's own comments came after", () => {
    expect(taskIsSettled(REVIEW)).toBe(true);
    expect(taskIsSettled({ ...REVIEW, status: "done" })).toBe(true);
    expect(taskIsSettled({ ...REVIEW, status: "cancelled" })).toBe(true);
    // A task the agent made and assigned to itself: no person ever commented.
    expect(taskIsSettled({ status: "review", settledAt: next("03:14"), lastPersonCommentAt: null, assignedByOtherAt: null })).toBe(true);
  });

  it("a person's comment after it settled reopens it to its assignee", () => {
    expect(taskIsSettled({ ...REVIEW, lastPersonCommentAt: next("09:00") })).toBe(false);
  });

  it("someone else assigning it after it settled, such as a review stage's agent, is new work", () => {
    expect(taskIsSettled({ ...REVIEW, assignedByOtherAt: at("21:59") })).toBe(false);
  });

  it("a task still in progress or in the backlog is not settled", () => {
    expect(taskIsSettled({ ...REVIEW, status: "in_progress" })).toBe(false);
    expect(taskIsSettled({ ...REVIEW, status: "backlog" })).toBe(false);
  });

  it("refuses the actions that change a card, and says why", () => {
    expect([...TASK_ACTIONS].sort()).toEqual(["share_to_task", "task_comment", "update_task"]);
    expect(settledTaskError("share_to_task", "task_demo", "review")).toBe(
      "task_settled: task_demo is in review, so this share_to_task did not run. A finished task stays as it is until a person comments on it.",
    );
    expect(settledTaskError("update_task", "task_demo", "done")).toContain("task_demo is done");
  });
});

// The reply posted at 22:25: a heading, then a tool's arguments.
const TEXT_THEN_TOOL_CALL = `# Write 00_STUDY_PLAN.txt for test-2 project
{
 "session": "writer_test2",
 "code": "from pathlib import Path, os\\nbase = Path('test-2')\\nbase.mkdir(parents=True, exist_ok=True)\\nplan_path = base / '00_STUDY_PLAN.txt'\\ncontent = '''SYNTHETIC. Not real research.\\nParticipants: 2\\n''' \\nplan_path.write_text(content)\\nprint('Wrote', plan_path)\\n"
}`;

type Bridge = { looksLikeTextToolCall: (t: string) => boolean; textThenToolCall: (t: string) => boolean };
let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as Bridge;
});

describe("a line of text followed by a tool call", () => {
  it("the reply guard refuses the 22:25 post as a tool call written as text", () => {
    expect(textThenToolCall(TEXT_THEN_TOOL_CALL)).toBe(true);
    expect(checkReplyBody(TEXT_THEN_TOOL_CALL)).toEqual({ ok: false, reason: "tool_call_as_text" });
  });

  it("the bridge sees it too, so the turn reruns with the reminder", () => {
    expect(bridge.textThenToolCall(TEXT_THEN_TOOL_CALL)).toBe(true);
    expect(bridge.looksLikeTextToolCall(TEXT_THEN_TOOL_CALL)).toBe(true);
  });

  it("catches a fenced object and a few lines of lead-in", () => {
    const fenced = 'Writing the file now.\nOne moment.\n```json\n{"path": "/workspace/writer/a.txt", "content": "hi"}\n```';
    expect(textThenToolCall(fenced)).toBe(true);
    expect(bridge.textThenToolCall(fenced)).toBe(true);
  });

  it("leaves prose alone, and an object with no tool argument", () => {
    for (const ok of [
      "The transcript is attached to the task. Next I will write the second interview.",
      'The settings file now reads:\n{"theme": "dark", "size": 12}',
      // The object is not the end of the reply.
      'Here is the call I meant:\n{"code": "print(1)"}\nIt did not run, so I will try again.',
      // More than three lines of text first: a reply, not a tool call.
      'One.\nTwo.\nThree.\nFour.\n{"code": "print(1)"}',
    ]) {
      expect(textThenToolCall(ok)).toBe(false);
      expect(bridge.textThenToolCall(ok)).toBe(false);
    }
  });
});
