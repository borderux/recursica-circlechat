import { describe, it, expect, beforeAll } from "vitest";
import { errorsFrom } from "../agents/adapters/hermes.js";
import { RUN_CODE_TOOL_ERROR, TOOLS_AS_ACTIONS_REPLY } from "./fixtures/agent-replies.js";

// A gpt-oss agent, asked on a task for one transcript (fixtures/agent-replies.ts, reply 3):
//   - its one tool call was run_code, a CircleChat action name, and Hermes said the tool does not
//     exist;
//   - its reply was an <actions> block holding write_file and read_file entries, Hermes tools. The
//     bridge dropped them without a word, so no file was written and nobody was told;
//   - it answered an older request from the channel instead of the task's.

type Turn = { exitError?: string; rawText: string; runtimeFound: string[] };
type Bridge = {
  extractActions: (raw: string) => { body: string; actions: Array<{ type: string }>; dropped: string[] };
  toolsInActions: (raw: string) => string[];
  isTextToolCall: (raw: string) => boolean;
  droppedActionErrors: (dropped: string[]) => string[];
  turnForWaitingPerson: (
    runOnce: (prompt: string) => Promise<Turn>,
    prompt: string,
    opts: { waiting: boolean; timeoutMs: number; now?: () => number },
  ) => Promise<Turn & { reran: boolean; silent: boolean; note: boolean; toolCallAsText: boolean }>;
  TOOL_CALL_REMINDER: string;
  TOOLS_VS_ACTIONS: string;
  taskRequestBlock: (packet: unknown) => string;
  buildPrompt: (entry: unknown, packet: unknown) => string;
  turnContainerName: (handle: string, id?: string) => string;
  buildHermesSpawn: (home: string, args: string[], env?: Record<string, string>, handle?: string) => { cmd: string; args: string[] };
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

const GOOD_REPLY =
  'Wrote the transcript and attached it to the task.\n<actions>[{"type":"share_to_task","task_id":"task_demo","files":[{"path":"/workspace/writer/test-1/01_interview.txt"}]}]</actions>';

describe("a tool written as an <actions> entry", () => {
  it("is found in this turn's reply, and the CircleChat actions are kept apart", () => {
    const { actions, dropped, body } = bridge.extractActions(TOOLS_AS_ACTIONS_REPLY);
    expect(body).toBe("");
    expect(actions.map((a) => a.type)).toEqual(["update_task", "share_to_task", "update_task"]);
    expect(dropped).toEqual(["write_file", "write_file", "read_file", "read_file"]);
    expect(bridge.toolsInActions(TOOLS_AS_ACTIONS_REPLY)).toEqual(["write_file", "read_file"]);
    expect(bridge.isTextToolCall(TOOLS_AS_ACTIONS_REPLY)).toBe(true);
    expect(bridge.isTextToolCall(GOOD_REPLY)).toBe(false);
  });

  it("knows every tool Hermes listed in its run_code error", () => {
    const tools = RUN_CODE_TOOL_ERROR.split("Available tools: ")[1].split(", ");
    expect(tools).toContain("write_file");
    for (const tool of tools) {
      expect(bridge.toolsInActions(`<actions>[{"type":"${tool}"}]</actions>`)).toEqual([tool]);
    }
  });

  it("reruns the turn once with the reminder, which says actions cannot write files", async () => {
    expect(bridge.TOOL_CALL_REMINDER).toContain("write_file and read_file are tools you call now; <actions> run after your turn ends and cannot write files.");
    const t = turns(TOOLS_AS_ACTIONS_REPLY, GOOD_REPLY);
    const r = await bridge.turnForWaitingPerson(t.runOnce, "PROMPT", { waiting: false, timeoutMs: 480_000 });
    expect(t.prompts).toEqual(["PROMPT", `PROMPT\n\n${bridge.TOOL_CALL_REMINDER}`]);
    expect(r).toMatchObject({ rawText: GOOD_REPLY, reran: true, silent: false, toolCallAsText: false });
  });

  it("drops a second one as tool_call_as_text, actions and all", async () => {
    const t = turns(TOOLS_AS_ACTIONS_REPLY, TOOLS_AS_ACTIONS_REPLY);
    const r = await bridge.turnForWaitingPerson(t.runOnce, "PROMPT", { waiting: true, timeoutMs: 480_000 });
    expect(r).toMatchObject({ reran: true, silent: true, toolCallAsText: true, note: true });
  });
});

describe("every dropped action is reported", () => {
  it("says which entries did not run, once each, a tool apart from an unknown action", () => {
    const errors = bridge.droppedActionErrors(bridge.extractActions(TOOLS_AS_ACTIONS_REPLY).dropped);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/^tool_in_actions: write_file is a tool, not an action\./);
    expect(errors[1]).toMatch(/^tool_in_actions: read_file is a tool/);
    const unknown = bridge.extractActions('<actions>[{"type":"frobnicate"},{"type":"react","message_id":"m1","emoji":"👍"}]</actions>');
    expect(unknown.actions.map((a) => a.type)).toEqual(["react"]);
    expect(bridge.droppedActionErrors(unknown.dropped)).toEqual(["unknown_action: frobnicate is not a CircleChat action, so it did not run."]);
  });

  it("runs the actions the prompt offers that the bridge used to drop", () => {
    const raw = `<actions>${JSON.stringify([
      { type: "delegate_to", to: "@pat", objective: "Review the plan" },
      { type: "memory_append", label: "notes", text: "one line" },
      { type: "memory_rethink", label: "notes", value: "short" },
      { type: "run_code", language: "python", code: "print(1)" },
    ])}</actions>`;
    const { actions, dropped } = bridge.extractActions(raw);
    expect(actions.map((a) => a.type)).toEqual(["delegate_to", "memory_append", "memory_rethink", "run_code"]);
    expect(dropped).toEqual([]);
  });

  it("the api keeps the bridge's errors, at most ten short lines", () => {
    expect(errorsFrom(["tool_in_actions: write_file …", 3, "", null])).toEqual(["tool_in_actions: write_file …"]);
    expect(errorsFrom(Array.from({ length: 15 }, (_, i) => `e${i}`))).toHaveLength(10);
    expect(errorsFrom(["x".repeat(500)])[0]).toHaveLength(300);
    expect(errorsFrom(undefined)).toEqual([]);
  });
});

const PERSON = "m_person";
const AGENT = "m_agent";
const taskPacket = (trigger: string) => ({
  trigger,
  agent: { handle: "writer", name: "Writer", memberId: AGENT },
  members: { [PERSON]: { kind: "user", handle: "pat" }, [AGENT]: { kind: "agent", handle: "writer" } },
  task: {
    id: "task_demo",
    title: "Fake transcript test",
    status: "backlog",
    recentComments: [
      { memberId: PERSON, memberHandle: "pat", bodyMd: "@writer Make one fake 15-minute transcript, about 500 words: 2 participants, 1 persona, project name test-1." },
      { memberId: AGENT, memberHandle: "writer", bodyMd: "On it." },
    ],
  },
  inbox: [
    {
      conversationId: "c_test",
      conversationKind: "channel",
      conversationName: "test",
      conversationMembers: [PERSON, AGENT],
      messages: [
        { id: "m1", memberId: PERSON, memberHandle: "pat", bodyMd: "@writer Write 2 fake 30-minute product demo transcripts." },
      ],
    },
  ],
});

describe("the prompt", () => {
  it("leads a task turn with the task's request, ahead of an older request in the channel", () => {
    const prompt = bridge.buildPrompt({ handle: "writer", name: "Writer" }, taskPacket("task_comment"));
    const request = prompt.indexOf(`THIS TURN'S REQUEST (task "Fake transcript test", task_demo):`);
    expect(request).toBeGreaterThan(-1);
    expect(prompt).toContain("@pat on the task: @writer Make one fake 15-minute transcript");
    expect(request).toBeLessThan(prompt.indexOf("Write 2 fake 30-minute product demo transcripts"));
    // The agent's own comment is not the request.
    expect(bridge.taskRequestBlock(taskPacket("task_assigned"))).not.toContain("On it.");
    // Not a task turn: no request block.
    expect(bridge.taskRequestBlock(taskPacket("mention"))).toBe("");
    // A task with no comment from a person: its title.
    const quiet = taskPacket("task_assigned");
    quiet.task.recentComments = [];
    expect(bridge.taskRequestBlock(quiet)).toContain("Fake transcript test");
  });

  it("tells a Hermes agent tools from actions, and offers run_code only to an agent without tools", () => {
    const hermes = bridge.buildPrompt({ handle: "writer", name: "Writer", hermesHome: "/opt/hermes-homes/.hermes-writer" }, taskPacket("task_comment"));
    expect(hermes).toContain(bridge.TOOLS_VS_ACTIONS);
    expect(hermes).not.toContain('{"type":"run_code"');
    const openclaw = bridge.buildPrompt({ handle: "writer", name: "Writer", kind: "openclaw", openclawHome: "/opt/oc" }, taskPacket("task_comment"));
    expect(openclaw).not.toContain(bridge.TOOLS_VS_ACTIONS);
    expect(openclaw).toContain('{"type":"run_code"');
  });
});

describe("turn containers are named after their agent", () => {
  it("cc-turn-<agent>-<id>, with a handle made safe for Docker", () => {
    expect(bridge.turnContainerName("writer", "1a2b3c4d")).toBe("cc-turn-writer-1a2b3c4d");
    expect(bridge.turnContainerName("Ana María!", "ff")).toBe("cc-turn-ana-mar-a-ff");
    expect(bridge.turnContainerName("", "ff")).toBe("cc-turn-agent-ff");
    expect(bridge.turnContainerName("writer")).toMatch(/^cc-turn-writer-[0-9a-f]{8}$/);
  });

  it("the turn's docker run carries the name, and two turns get two names", () => {
    const one = bridge.buildHermesSpawn("/opt/hermes-homes/.hermes-writer", ["chat", "-q", "hi"], {}, "writer");
    const two = bridge.buildHermesSpawn("/opt/hermes-homes/.hermes-writer", ["chat", "-q", "hi"], {}, "writer");
    const nameOf = (args: string[]) => args[args.indexOf("--name") + 1];
    expect(one.args.slice(0, 3)).toEqual(["run", "--rm", "-i"]);
    expect(nameOf(one.args)).toMatch(/^cc-turn-writer-[0-9a-f]{8}$/);
    expect(nameOf(two.args)).not.toBe(nameOf(one.args));
    expect(bridge.buildHermesSpawn("/opt/hermes-homes/.hermes-writer", ["chat"]).args).not.toContain("--name");
  });
});
