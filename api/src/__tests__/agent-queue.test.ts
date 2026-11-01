import { describe, it, expect, beforeAll } from "vitest";
import { decideClaim, orderQueue, priorityRank, turnHoldsAgent, isPriority } from "../agents/turn-queue.js";
import { ambientHasMessages, heartbeatCursor, taskIsWaiting, waitingTaskError } from "../agents/settled-work.js";

// One afternoon of a gpt-oss agent, with the names made generic:
//   13:44:37  a person creates a task titled "writer test 3", no description
//   13:44:56  assigns it to the agent; the agent's turn starts, sees the title only
//   13:44:59.099  the person comments the request: one fake 15-minute transcript…
//   13:44:59.101  the comment's turn is refused: agent_busy, finished 13:44:59.147
//   13:45:56  the first turn ends with a question: "a transcript, an answer key, or…?"
//   13:56, 14:10, 14:34, 15:17, 16:45  the same question again, from heartbeats
//            (one scheduled, four ambient), none of which showed the comment.
const t = (hms: string) => new Date(`2026-10-31T${hms}-07:00`);
const REQUEST = "@writer One fake 15-minute transcript, 2 speakers, a product demo at Acme Corp. Made-up names only.";
const QUESTION = "Could you clarify the exact deliverable required for “writer test 3”? For example, is it a synthetic transcript, an answer key, or another artifact?";

describe("no request is ever refused: it joins the agent's queue", () => {
  it("the comment that arrived during the assignment's turn waits for that turn, then goes", () => {
    // 13:44:59: the assignment's turn is running.
    expect(decideClaim({ heartbeat: false, busy: true, waiting: 0, fromQueue: false })).toBe("hold");
    // 13:45:56: the turn ended; the queue releases the comment, ahead of anything newer.
    expect(decideClaim({ heartbeat: false, busy: false, waiting: 2, fromQueue: true })).toBe("go");
  });

  it("a request never jumps the queue, even between turns", () => {
    expect(decideClaim({ heartbeat: false, busy: false, waiting: 1, fromQueue: false })).toBe("hold");
    expect(decideClaim({ heartbeat: false, busy: false, waiting: 0, fromQueue: false })).toBe("go");
  });

  it("a heartbeat is not a request: it is skipped while the agent is busy or has requests waiting", () => {
    expect(decideClaim({ heartbeat: true, busy: true, waiting: 0, fromQueue: false })).toBe("skip");
    expect(decideClaim({ heartbeat: true, busy: false, waiting: 1, fromQueue: false })).toBe("skip");
    expect(decideClaim({ heartbeat: true, busy: false, waiting: 0, fromQueue: false })).toBe("go");
  });

  it("orders the queue by the task's priority, then by arrival; a request without a task is normal", () => {
    const queue = [
      { runId: "r_comment", priority: null, enqueuedAt: t("13:44:59") },
      { runId: "r_low", priority: "low", enqueuedAt: t("13:44:58") },
      { runId: "r_urgent", priority: "urgent", enqueuedAt: t("13:45:30") },
      { runId: "r_dm", priority: null, enqueuedAt: t("13:45:00") },
      { runId: "r_high", priority: "high", enqueuedAt: t("13:45:40") },
    ];
    expect(orderQueue(queue).map((e) => e.runId)).toEqual(["r_urgent", "r_high", "r_comment", "r_dm", "r_low"]);
  });

  it("resequences when a task's priority changes", () => {
    const queue = [
      { runId: "r_a", priority: "normal", enqueuedAt: t("13:44:59") },
      { runId: "r_b", priority: "normal", enqueuedAt: t("13:45:10") },
    ];
    expect(orderQueue(queue).map((e) => e.runId)).toEqual(["r_a", "r_b"]);
    queue[1]!.priority = "urgent";
    expect(orderQueue(queue).map((e) => e.runId)).toEqual(["r_b", "r_a"]);
  });

  it("knows the four priorities, and treats anything else as normal", () => {
    expect(["urgent", "high", "normal", "low"].every(isPriority)).toBe(true);
    expect(isPriority("asap")).toBe(false);
    expect(priorityRank("asap")).toBe(priorityRank("normal"));
    expect(priorityRank(null)).toBe(priorityRank("normal"));
  });

  it("a running turn holds the agent, but not one past its timeout or long dead", () => {
    const now = t("13:45:00");
    expect(turnHoldsAgent({ status: "running", startedAt: t("13:44:56"), timeoutAt: null }, now)).toBe(true);
    expect(turnHoldsAgent({ status: "ok", startedAt: t("13:44:56"), timeoutAt: null }, now)).toBe(false);
    expect(turnHoldsAgent({ status: "running", startedAt: t("13:44:56"), timeoutAt: t("13:44:58") }, now)).toBe(false);
    expect(turnHoldsAgent({ status: "running", startedAt: t("12:00:00"), timeoutAt: null }, now, 30 * 60_000)).toBe(false);
  });
});

type SlotResult = { ok: true; done: () => void } | { ok: false; droppable: boolean; reason: string };
type Bridge = {
  claimAgentSlot: (handle: string, trigger: string, now?: number) => SlotResult;
  waitForAgentSlot: (handle: string, trigger: string) => Promise<SlotResult>;
  buildPrompt: (entry: unknown, packet: unknown) => string;
};
let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as Bridge;
});

describe("the bridge waits instead of refusing", () => {
  it("the comment's turn waits for the assignment's turn to end, then takes the home", async () => {
    const first = bridge.claimAgentSlot("writer-q", "task_assigned");
    expect(first.ok).toBe(true);
    let started = false;
    const second = bridge.waitForAgentSlot("writer-q", "task_comment").then((s) => {
      started = true;
      return s;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(false);
    if (first.ok) first.done();
    const s = await second;
    expect(s.ok).toBe(true);
    if (s.ok) s.done();
  });

  it("still drops a stale background beat", async () => {
    const first = bridge.claimAgentSlot("writer-b", "mention");
    const beat = await bridge.waitForAgentSlot("writer-b", "ambient");
    expect(beat.ok).toBe(false);
    if (first.ok) first.done();
  });
});

describe("a refused or skipped run does not move the heartbeat cursor", () => {
  const packet = { agent: { handle: "writer" } };
  const runs = [
    // The comment's turn, refused 48 ms after the comment.
    { startedAt: t("13:44:59.101"), status: "failed", errorText: "agent_busy: a task_assigned turn …", resultJson: {}, contextJson: packet },
    // A scheduled tick that skipped.
    { startedAt: t("13:48:00"), status: "ok", errorText: null, resultJson: { skipped: "no_activity" }, contextJson: {} },
    // The assignment's turn, the last one that reached the model.
    { startedAt: t("13:44:56.170"), status: "ok", errorText: null, resultJson: { applied: 1 }, contextJson: packet },
    // A request still waiting in the queue.
    { startedAt: t("13:47:00"), status: "queued", errorText: null, resultJson: {}, contextJson: {} },
  ];

  it("starts at the last real turn's start, so the 13:44:59 comment is new", () => {
    const cursor = heartbeatCursor(runs);
    expect(cursor).toEqual(t("13:44:56.170"));
    expect(t("13:44:59.099") > cursor!).toBe(true);
  });

  it("has no cursor when no turn ever reached the model", () => {
    expect(heartbeatCursor(runs.filter((r) => r.contextJson !== packet))).toBeNull();
  });
});

describe("an agent that asked waits quietly until a person replies", () => {
  it("each of the afternoon's repeats came while the task waited on the person", () => {
    // 13:56: the task in backlog, the agent's question newer than the request.
    expect(taskIsWaiting({ status: "backlog", agentCommentAt: t("13:45:56"), agentCommentBody: QUESTION, personCommentAt: t("13:44:59") })).toBe(true);
    // 14:34 on: the agent had set it to blocked with a "Waiting for…" note.
    expect(
      taskIsWaiting({
        status: "blocked",
        agentCommentAt: t("14:10:06"),
        agentCommentBody: "Waiting for the requester to specify whether the deliverable should be a synthetic transcript, an answer key, or another artifact.",
        personCommentAt: t("13:44:59"),
      }),
    ).toBe(true);
  });

  it("a person's reply ends the wait", () => {
    expect(taskIsWaiting({ status: "blocked", agentCommentAt: t("14:10:06"), agentCommentBody: QUESTION, personCommentAt: t("14:20:00") })).toBe(false);
  });

  it("a progress note that asks nothing on a task in progress does not wait", () => {
    expect(
      taskIsWaiting({ status: "in_progress", agentCommentAt: t("14:00:00"), agentCommentBody: "First transcript attached; writing the second.", personCommentAt: t("13:44:59") }),
    ).toBe(false);
    expect(taskIsWaiting({ status: "backlog", agentCommentAt: null, agentCommentBody: null, personCommentAt: t("13:44:59") })).toBe(false);
  });

  it("refuses a heartbeat's repeat, and says to wait", () => {
    expect(waitingTaskError("task_comment", "task_demo")).toBe(
      "waiting_on_person: you asked a person on task_demo and nobody has answered yet, so this task_comment did not run. Wait quietly: a person's reply wakes you.",
    );
  });
});

describe("no ambient turn in task-only mode", () => {
  it("an ambient packet with no channel message has nothing to talk about", () => {
    expect(ambientHasMessages({ inbox: [] })).toBe(false);
    expect(ambientHasMessages({ inbox: [{ messages: [] }] })).toBe(false);
    expect(ambientHasMessages({})).toBe(false);
    expect(ambientHasMessages({ inbox: [{ messages: [{ id: "m1" }] }] })).toBe(true);
  });
});

describe("a heartbeat's task list shows the request, not only the agent's own question", () => {
  it("names the person's comment as the request", () => {
    const packet = {
      trigger: "scheduled",
      agent: { handle: "writer", name: "Writer", memberId: "m_agent" },
      members: {},
      inbox: [],
      myTasks: [
        {
          id: "task_demo",
          title: "writer test 3",
          status: "backlog",
          progress: 0,
          dueAt: null,
          conversationId: null,
          conversationName: null,
          labels: [],
          commentCount: 2,
          latestComment: { memberId: "m_agent", memberHandle: "writer", bodyMd: QUESTION, ts: "2026-10-31T20:45:56.000Z" },
          request: { memberId: "m_person", memberHandle: "pat", bodyMd: REQUEST, ts: "2026-10-31T20:44:59.099Z" },
        },
      ],
    };
    const prompt = bridge.buildPrompt({ handle: "writer", name: "Writer", hermesHome: "/opt/hermes-homes/.hermes-writer" }, packet);
    const line = prompt.indexOf("task_demo [backlog] writer test 3");
    expect(line).toBeGreaterThan(-1);
    expect(prompt.indexOf(`request from @pat: ${REQUEST}`)).toBeGreaterThan(line);
    expect(prompt).toContain(`↳ @writer: ${QUESTION.slice(0, 60)}`);
  });

  it("shows the request once when it is also the latest comment", () => {
    const ts = "2026-10-31T20:44:59.099Z";
    const packet = {
      trigger: "scheduled",
      agent: { handle: "writer", name: "Writer", memberId: "m_agent" },
      members: {},
      inbox: [],
      myTasks: [
        {
          id: "task_demo",
          title: "writer test 3",
          status: "backlog",
          progress: 0,
          dueAt: null,
          conversationId: null,
          conversationName: null,
          labels: [],
          commentCount: 1,
          latestComment: { memberId: "m_person", memberHandle: "pat", bodyMd: REQUEST, ts },
          request: { memberId: "m_person", memberHandle: "pat", bodyMd: REQUEST, ts },
        },
      ],
    };
    const prompt = bridge.buildPrompt({ handle: "writer", name: "Writer", hermesHome: "/opt/hermes-homes/.hermes-writer" }, packet);
    expect(prompt.split("One fake 15-minute transcript").length - 1).toBe(1);
  });
});

describe("every agent reads a request the same way", () => {
  type B = { REQUEST_RULES: string; buildPrompt: (e: unknown, p: unknown) => string };
  const taskTurn = {
    trigger: "task_comment",
    agent: { handle: "writer", name: "Writer", memberId: "m_agent" },
    members: { m_person: { kind: "user", handle: "pat" }, m_agent: { kind: "agent", handle: "writer" } },
    task: {
      id: "task_demo",
      title: "writer test 3",
      status: "backlog",
      recentComments: [{ memberId: "m_person", memberHandle: "pat", bodyMd: REQUEST }],
    },
    inbox: [],
    myTasks: [],
  };

  it("the rules are generic: the newest comment is the request, the title a label, asking is the persona's call, and a question is asked once", () => {
    const rules = (bridge as unknown as B).REQUEST_RULES;
    expect(rules).toContain("On a task it is the person's newest comment; the task's title is only a label");
    expect(rules).toContain("Whether to ask questions before you start is your persona's call. Follow it.");
    expect(rules).toContain("When you ask, ask once, then wait quietly for the answer");
    // The prompt no longer tells an agent not to ask, or to just do it.
    expect(rules).not.toMatch(/is clear\. Make it|Ask only when|Do exactly this/);
    expect(rules).not.toMatch(/transcript|writer/i);
  });

  it("reach a Hermes agent and an OpenClaw agent, on a task turn and on a task-only heartbeat", () => {
    const b = bridge as unknown as B;
    const hermes = b.buildPrompt({ handle: "writer", name: "Writer", hermesHome: "/opt/hermes-homes/.hermes-writer" }, taskTurn);
    const openclaw = b.buildPrompt({ handle: "writer", name: "Writer", kind: "openclaw", openclawHome: "/opt/oc" }, taskTurn);
    const heartbeat = b.buildPrompt({ handle: "writer", name: "Writer" }, { ...taskTurn, trigger: "scheduled", task: undefined });
    for (const p of [hermes, openclaw, heartbeat]) expect(p).toContain(b.REQUEST_RULES);
    // On the task turn, the person's comment leads as the request.
    expect(hermes.indexOf(`THIS TURN'S REQUEST (task "writer test 3", task_demo):`)).toBeLessThan(hermes.indexOf(b.REQUEST_RULES));
    expect(hermes).toContain(`@pat on the task: ${REQUEST}`);
    for (const p of [hermes, openclaw, heartbeat]) expect(p).not.toContain("Do exactly this");
  });
});
