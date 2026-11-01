import { describe, it, expect, beforeAll } from "vitest";
import { checkReplyBody } from "../agents/reply-guard.js";

// One morning's reply from a qwen3-coder agent, newly assigned a task whose description asked for
// a page, with the task id made generic. The whole reply, 290 characters:
const QWEN_REPLY = `I'll help you create a team page for the app. Let me start by asking some clarifying questions to understand what you need.

<actions>
<parameter=type>
update_task
</parameter>
<parameter=task_id>
task_demo
</parameter>
<parameter=status>
in_progress
</parameter>
</actions>`;
// The model wrote the <actions> block in its own tool-call form, not JSON. The bridge could not
// read it, the reply guard refused the post because a literal <actions> tag was left in it
// (actions_block_visible), and the person saw nothing: not the prose, not a status change.
const PROSE = "I'll help you create a team page for the app. Let me start by asking some clarifying questions to understand what you need.";

type Extracted = { body: string; actions: Array<Record<string, unknown>>; dropped: string[]; unreadable?: string[] };
type Bridge = {
  extractActions: (raw: string) => Extracted;
  droppedActionErrors: (dropped: string[], unreadable?: string[]) => string[];
  buildPrompt: (entry: unknown, packet: unknown) => string;
};
let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as Bridge;
});

describe("an <actions> block in the <parameter=name>value</parameter> form", () => {
  it("is read: the morning's reply runs its update_task and posts its prose", () => {
    const r = bridge.extractActions(QWEN_REPLY);
    expect(r.body).toBe(PROSE);
    expect(r.actions).toEqual([{ type: "update_task", task_id: "task_demo", status: "in_progress" }]);
    expect(r.dropped).toEqual([]);
    expect(r.unreadable).toBeUndefined();
    // What is left passes the reply guard.
    expect(checkReplyBody(r.body)).toMatchObject({ ok: true });
  });

  it("reads several actions, by <function=…> or a second type, and JSON values", () => {
    const raw = `Starting now.
<actions>
<function=update_task>
<parameter=task_id>task_demo</parameter>
<parameter=progress>10</parameter>
</function>
<parameter=type>task_comment</parameter>
<parameter=task_id>task_demo</parameter>
<parameter=body_md>Asked three questions in the thread.</parameter>
</actions>`;
    const r = bridge.extractActions(raw);
    expect(r.body).toBe("Starting now.");
    expect(r.actions).toEqual([
      { type: "update_task", task_id: "task_demo", progress: 10 },
      { type: "task_comment", task_id: "task_demo", body_md: "Asked three questions in the thread." },
    ]);
  });

  it("still drops an entry that is not a CircleChat action, and says so", () => {
    const r = bridge.extractActions("Done.\n<actions><parameter=type>write_file</parameter><parameter=path>/workspace/x</parameter></actions>");
    expect(r.actions).toEqual([]);
    expect(r.dropped).toEqual(["write_file"]);
  });
});

describe("a block that still cannot be read", () => {
  for (const [name, raw] of [
    ["prose inside the tags", `${PROSE}\n<actions>\nmove the task to in progress\n</actions>`],
    ["a cut-off JSON array", `${PROSE}\n<actions>[{"type":"update_task","task_id":"task_demo",`],
    ["an unclosed block", `${PROSE}\n<actions>\n<parameter=type>`],
  ] as const) {
    it(`is stripped and the prose posts: ${name}`, () => {
      const r = bridge.extractActions(raw);
      expect(r.body).toBe(PROSE);
      expect(r.actions).toEqual([]);
      expect(r.unreadable).toHaveLength(1);
      expect(r.unreadable![0]).toMatch(/^<actions>/);
      expect(r.unreadable![0].length).toBeLessThanOrEqual(200);
      expect(checkReplyBody(r.body)).toMatchObject({ ok: true });
    });
  }

  it("is recorded on the run, with how to write actions", () => {
    const r = bridge.extractActions(`${PROSE}\n<actions>\nmove the task to in progress\n</actions>`);
    const errors = bridge.droppedActionErrors(r.dropped, r.unreadable);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^unreadable_actions: an <actions> block could not be read, so nothing in it ran; your text was posted without it\./);
    expect(errors[0]).toContain('<actions>[{"type":"update_task"');
    expect(errors[0]).toContain("move the task to in progress");
  });

  it("leaves a JSON block as it was", () => {
    const r = bridge.extractActions(`${PROSE}\n<actions>[{"type":"update_task","task_id":"task_demo","status":"in_progress"}]</actions>`);
    expect(r.body).toBe(PROSE);
    expect(r.actions).toEqual([{ type: "update_task", task_id: "task_demo", status: "in_progress" }]);
    expect(r.unreadable).toBeUndefined();
  });
});

describe("the instruction for a newly assigned task", () => {
  const packet = {
    trigger: "task_assigned",
    agent: { handle: "designer", name: "Designer", memberId: "m_agent" },
    members: { m_person: { kind: "user", handle: "pat" }, m_agent: { kind: "agent", handle: "designer" } },
    task: { id: "task_demo", title: "Rehearsal: team page", bodyMd: "I need a team page for our app where people can see who's on their team.", status: "backlog", recentComments: [] },
    // As in the morning's turn, the assignment's turn ran in the person's direct message.
    inbox: [
      {
        conversationId: "c_dm_demo",
        conversationKind: "dm",
        conversationName: null,
        conversationMembers: ["m_person", "m_agent"],
        messages: [{ id: "m1", memberId: "m_agent", memberHandle: "designer", bodyMd: "What would you like help with today?" }],
      },
    ],
    myTasks: [],
  };

  it("says to follow the persona and start the work in this turn, questions first when the persona asks them", () => {
    const prompt = bridge.buildPrompt({ handle: "designer", name: "Designer", hermesHome: "/opt/hermes-homes/.hermes-designer" }, packet);
    expect(prompt).toContain("Follow your persona, and start the work in this turn");
    expect(prompt).toContain("when your persona asks questions before working, post those questions now, as plain text, a few at a time");
    expect(prompt).toContain("Never only move the task's status: a status change alone is not a turn's work.");
  });

  it("no longer says to move the task to in_progress and stop, or to answer HEARTBEAT_OK", () => {
    const prompt = bridge.buildPrompt({ handle: "designer", name: "Designer", hermesHome: "/opt/hermes-homes/.hermes-designer" }, packet);
    expect(prompt).not.toContain("move it to in_progress via the task API and optionally comment");
    expect(prompt).not.toContain('Return "HEARTBEAT_OK" if you acknowledged via the task itself');
  });
});
