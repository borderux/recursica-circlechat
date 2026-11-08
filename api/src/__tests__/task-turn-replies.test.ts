import { describe, it, expect, beforeAll } from "vitest";
import { statusAfterAgentWork } from "../agents/task-status-follows-work.js";

// One morning's turn, with names made generic. A person assigned a designer agent the task
// "Test: pricing page". The turn's inbox held the person's direct message first, then a channel,
// and the bridge posted the agent's whole reply, its questions, into that direct message as
// post_message. Nothing went on the task: the person had no questions on the card to answer there,
// and with no comment from its assignee the card stayed in Backlog.
const REPLY = `Hello Alex, I'm ready to help you with creating a pricing page for your app. Before I start, I need to understand a few things about what you're looking for.

First, could you clarify what kind of information should be included in each pricing plan? For example, should it show features, price, or any other specific details?

Also, do you have preferences for how the plans should be presented on the page? For instance, would you like them in a table format, cards, or another layout? 

Once I have these details, I'll be able to design and build an appropriate pricing page.`;

const TASK = {
  id: "task_demo",
  title: "Test: pricing page",
  bodyMd: "I need a pricing page for our app with three plans, and a button to pick one.",
  status: "backlog",
  recentComments: [] as Array<Record<string, string>>,
};
const DM = {
  conversationId: "c_dm_demo",
  conversationKind: "dm",
  conversationName: null,
  conversationMembers: ["m_person", "m_agent"],
  messages: [{ id: "m1", memberId: "m_person", memberHandle: "alex", bodyMd: "Morning! Anything you need from me today?" }],
};
const CHANNEL = {
  conversationId: "c_demo",
  conversationKind: "channel",
  conversationName: "general",
  conversationMembers: ["m_person", "m_agent"],
  messages: [{ id: "m2", memberId: "m_person", memberHandle: "alex", bodyMd: "Standup moved to 10." }],
};
const ENTRY = { handle: "designer", name: "Designer", hermesHome: "/opt/hermes-homes/.hermes-designer" };
const assigned = {
  trigger: "task_assigned",
  agent: { handle: "designer", name: "Designer", memberId: "m_agent" },
  members: { m_person: { kind: "user", handle: "alex" }, m_agent: { kind: "agent", handle: "designer" } },
  task: TASK,
  inbox: [DM, CHANNEL],
  myTasks: [{ id: "task_demo", title: "Test: pricing page", status: "backlog" }],
};
// The person's answer on the card, and the agent's questions before it, oldest first.
const answered = {
  ...assigned,
  trigger: "task_comment",
  task: {
    ...TASK,
    recentComments: [
      { id: "tc1", memberId: "m_agent", memberHandle: "designer", bodyMd: REPLY, ts: "2026-01-01T16:27:39Z" },
      { id: "tc2", memberId: "m_person", memberHandle: "alex", bodyMd: "Cards, with the price and five features each.", ts: "2026-01-01T16:40:00Z" },
    ],
  },
};

type Routed = { actions: Array<Record<string, unknown>>; notes: string[] };
type Bridge = {
  routeTurnReply: (a: Record<string, unknown>) => Routed;
  taskTurnId: (p: unknown) => string | null;
  buildPrompt: (entry: unknown, packet: unknown) => string;
};
let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as Bridge;
});

describe("a turn started by a task posts its reply on the task", () => {
  it("the morning's turn: the questions go on the task as a comment, never into the direct message", () => {
    expect(bridge.taskTurnId(assigned)).toBe("task_demo");
    // The bridge gives a task turn no chat conversation; even handed the direct message, the reply
    // still goes on the task.
    for (const conv of [undefined, DM]) {
      const r = bridge.routeTurnReply({ packet: assigned, conv, postBody: REPLY, sideActions: [], chatMax: 2000 });
      expect(r.actions).toEqual([{ type: "task_comment", task_id: "task_demo", body_md: REPLY }]);
      expect(r.actions.some((a) => a.type === "post_message")).toBe(false);
    }
  });

  it("keeps attachments on the comment, and moves a post the agent aimed at the direct message onto the task", () => {
    const file = { key: "u/f1/plans.png", name: "plans.png", contentType: "image/png", size: 10, url: "/files/u/f1/plans.png" };
    const r = bridge.routeTurnReply({
      packet: assigned,
      conv: undefined,
      postBody: "Two layouts attached.",
      attachments: [file],
      sideActions: [
        { type: "post_message", conversation_id: "c_dm_demo", body_md: "Which layout do you prefer?" },
        { type: "post_message", conversation_id: "c_demo", body_md: "Pricing page draft is on its card." },
        { type: "update_task", task_id: "task_demo", progress: 10 },
      ],
      chatMax: 2000,
    });
    expect(r.actions).toEqual([
      { type: "task_comment", task_id: "task_demo", body_md: "Two layouts attached.", attachments: [file] },
      { type: "task_comment", task_id: "task_demo", body_md: "Which layout do you prefer?" },
      { type: "post_message", conversation_id: "c_demo", body_md: "Pricing page draft is on its card." },
      { type: "update_task", task_id: "task_demo", progress: 10 },
    ]);
  });

  it("the person's answer on the card continues the conversation, and the next reply goes on the card too", () => {
    expect(bridge.taskTurnId(answered)).toBe("task_demo");
    const r = bridge.routeTurnReply({ packet: answered, conv: undefined, postBody: "Cards it is. Building the page now.", sideActions: [], chatMax: 2000 });
    expect(r.actions).toEqual([{ type: "task_comment", task_id: "task_demo", body_md: "Cards it is. Building the page now." }]);
  });

  it("other turns keep posting in their conversation", () => {
    const dmTurn = { ...assigned, trigger: "dm", task: undefined };
    expect(bridge.taskTurnId(dmTurn)).toBeNull();
    const r = bridge.routeTurnReply({ packet: dmTurn, conv: DM, postBody: "Nothing needed today.", sideActions: [], chatMax: 2000 });
    expect(r.actions).toEqual([{ type: "post_message", conversation_id: "c_dm_demo", body_md: "Nothing needed today." }]);
    // A task trigger without a task in the packet has no card to post on.
    expect(bridge.taskTurnId({ trigger: "task_assigned" })).toBeNull();
  });
});

describe("the prompt of a task turn", () => {
  it("says the reply goes on the task, not in the direct message the inbox starts with", () => {
    const prompt = bridge.buildPrompt(ENTRY, assigned);
    expect(prompt).toContain('You are currently in the comments on the task "Test: pricing page". Your reply is posted there as a comment, never in a channel or a direct message');
    expect(prompt).not.toContain("You are currently in a direct message (1:1)");
    expect(prompt).not.toContain("a few at a time");
    expect(prompt).not.toContain("Your reply body will be dropped");
  });

  it("on the person's answer, shows the whole conversation on the task, oldest first, and takes the answer as the request", () => {
    const prompt = bridge.buildPrompt(ENTRY, answered);
    expect(prompt).toContain("The conversation on this task, oldest first:");
    // The agent's own questions show whole, not cut at 200 characters.
    expect(prompt).toContain(`@designer: ${REPLY}`);
    expect(prompt.indexOf(`@designer: ${REPLY.slice(0, 40)}`)).toBeLessThan(prompt.indexOf("@alex: Cards, with the price"));
    expect(prompt).toContain("@alex on the task: Cards, with the price and five features each.");
    expect(prompt).toContain("it continues from your last comment there");
  });
});

describe("the first comment moves the card to In progress (#28's rule)", () => {
  it("the morning's questions, as the assignee's first comment on a card in Backlog, move it to In progress", () => {
    expect(statusAfterAgentWork("backlog", { deliverable: false, text: REPLY })).toBe("in_progress");
  });
});
