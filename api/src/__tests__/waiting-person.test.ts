import { describe, it, expect, beforeAll } from "vitest";
import { checkReplyBody } from "../agents/reply-guard.js";

// Two ways an agent left a person waiting on nothing:
//   - Hermes's own runtime text ("Hermes couldn't start the model connection", the settings-upgrade
//     banner) was posted as the agent's message. Later turns read it as the agent's own replies, and
//     a model that sees the same failure three times as "you:" can decide any reply would repeat
//     itself and answer HEARTBEAT_OK.
//   - A HEARTBEAT_OK to a DM or a person's @-mention posted nothing at all.

type Turn = { exitError?: string; rawText: string; runtimeFound: string[] };
type Bridge = {
  stripHermesRuntimeText: (text: string) => { text: string; found: string[] };
  personWaits: (trigger: string, packet: unknown, last: unknown) => boolean;
  isOnlyHeartbeat: (text: string) => boolean;
  historyMessages: (messages: unknown[], agentMemberId: string) => Array<{ id: string }>;
  turnForWaitingPerson: (
    runOnce: (prompt: string) => Promise<Turn>,
    prompt: string,
    opts: { waiting: boolean; timeoutMs: number; now?: () => number },
  ) => Promise<Turn & { retried: boolean; reran: boolean; silent: boolean; note: boolean }>;
  WAITING_REMINDER: string;
  NO_REPLY_NOTE: string;
  buildPrompt: (entry: unknown, packet: unknown) => string;
};

let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as unknown as Bridge;
});

const INIT_FAILED =
  "Hermes couldn't start the model connection: invalid_params. Your message was not\r\nsent. Run `hermes doctor` to check the setup, or /model to pick a different \r\nprovider.";
const BANNER = [
  " ✓ Migrated 1 custom provider(s) to providers: section",
  " → gateway: http://gateway:4000/v1",
  " ⚠ platform 'homeassistant' references unknown toolset 'hermes-homeassistant'",
  "Config version: 0 → 51",
].join("\n");

describe("Hermes's own runtime text stays out of conversations", () => {
  it("removes the failed-connection copy, and the upgrade banner with it", () => {
    expect(bridge.stripHermesRuntimeText(INIT_FAILED)).toEqual({ text: "", found: ["agent_init_failed"] });
    const both = bridge.stripHermesRuntimeText(`${BANNER}\n\n${INIT_FAILED.replace("invalid_params", "Gateway starting: deadline")}`);
    expect(both.text).toBe("");
    expect(both.found).toEqual(["settings_upgrade_banner", "agent_init_failed"]);
  });

  it("removes a failed model request and a provider that never answered, and keeps the agent's own words", () => {
    const failed = bridge.stripHermesRuntimeText("The model request failed. Run /model to switch or `hermes doctor` to check the setup.\nDetails: HTTP 500");
    expect(failed).toEqual({ text: "", found: ["model_request_failed"] });
    const retries = bridge.stripHermesRuntimeText(
      "Here is the summary you asked for.\ncustom didn't answer after 3 attempts — it looks temporarily unavailable.\nProvider said: HTTP 404: no route",
    );
    expect(retries).toEqual({ text: "Here is the summary you asked for.", found: ["provider_unavailable"] });
  });

  it("leaves an ordinary reply alone, arrows and check marks included", () => {
    const reply = "Done:\n ✓ Migrated the button styles\n → next: the table";
    expect(bridge.stripHermesRuntimeText(reply)).toEqual({ text: reply, found: [] });
  });

  it("drops the agent's earlier runtime-text messages and no-reply notes from the history a prompt shows", () => {
    const me = "m_agent", human = "m_person";
    const messages = [
      { id: "1", memberId: human, bodyMd: "hello" },
      { id: "2", memberId: me, bodyMd: `${BANNER}\n\n${INIT_FAILED}` },
      { id: "3", memberId: human, bodyMd: "hello 2" },
      { id: "4", memberId: me, bodyMd: bridge.NO_REPLY_NOTE },
      { id: "5", memberId: me, bodyMd: "Hi! What are we designing today?" },
      // A person quoting the error is the person's message, and stays.
      { id: "6", memberId: human, bodyMd: INIT_FAILED },
    ];
    expect(bridge.historyMessages(messages, me).map((m) => m.id)).toEqual(["1", "3", "5", "6"]);
  });

  it("builds the prompt's recent messages without them", () => {
    const prompt = bridge.buildPrompt(
      { handle: "alice", name: "Alice" },
      {
        trigger: "dm",
        agent: { handle: "alice", name: "Alice", memberId: "m_agent" },
        members: { m_person: { kind: "user", handle: "pat" }, m_agent: { kind: "agent", handle: "alice" } },
        inbox: [
          {
            conversationId: "c_dm",
            conversationKind: "dm",
            conversationMembers: ["m_person", "m_agent"],
            messages: [
              { id: "m1", memberId: "m_person", memberHandle: "pat", bodyMd: "hello" },
              { id: "m2", memberId: "m_agent", memberHandle: "alice", bodyMd: INIT_FAILED },
              { id: "m3", memberId: "m_person", memberHandle: "pat", bodyMd: "hello again" },
            ],
          },
        ],
      },
    );
    expect(prompt).toContain("@pat: hello again");
    expect(prompt).not.toContain("couldn't start the model connection");
  });

  it("the api's reply guard refuses the same text from anywhere else", () => {
    for (const body of [INIT_FAILED, BANNER]) {
      const r = checkReplyBody(body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("hermes_runtime_text");
    }
  });
});

describe("a person waiting on a DM or an @-mention always gets something", () => {
  const packet = { members: { m_person: { kind: "user" }, m_bot: { kind: "agent" } } };

  it("counts a DM and a person's @-mention as waiting, and an agent's @-mention or a heartbeat as not", () => {
    expect(bridge.personWaits("dm", packet, { memberId: "m_person" })).toBe(true);
    expect(bridge.personWaits("mention", packet, { memberId: "m_person" })).toBe(true);
    expect(bridge.personWaits("mention", packet, { memberId: "m_bot" })).toBe(false);
    for (const trigger of ["scheduled", "ambient", "thread_reply", "channel_post", "task_assigned"]) {
      expect(bridge.personWaits(trigger, packet, { memberId: "m_person" })).toBe(false);
    }
  });

  // Stand-in turns: each call returns the next reply and records the prompt it got.
  const turns = (...replies: string[]) => {
    const prompts: string[] = [];
    const runOnce = async (prompt: string): Promise<Turn> => {
      prompts.push(prompt);
      return { rawText: replies[prompts.length - 1] ?? "", runtimeFound: [] };
    };
    return { runOnce, prompts };
  };

  it("reruns a HEARTBEAT_OK once with the reminder, and posts the rerun's reply", async () => {
    const t = turns("HEARTBEAT_OK", "Hi! What can I help with?");
    const r = await bridge.turnForWaitingPerson(t.runOnce, "PROMPT", { waiting: true, timeoutMs: 480_000 });
    expect(t.prompts).toEqual(["PROMPT", `PROMPT\n\n${bridge.WAITING_REMINDER}`]);
    expect(r).toMatchObject({ rawText: "Hi! What can I help with?", reran: true, silent: false, note: false });
  });

  it("posts the no-reply note when the rerun gives HEARTBEAT_OK or nothing again", async () => {
    for (const second of ["HEARTBEAT_OK", "", "  "]) {
      const t = turns("HEARTBEAT_OK", second);
      const r = await bridge.turnForWaitingPerson(t.runOnce, "PROMPT", { waiting: true, timeoutMs: 480_000 });
      expect(t.prompts.length).toBe(2);
      expect(r).toMatchObject({ reran: true, silent: true, note: true });
    }
  });

  it("never reruns more than once, or when nobody waits", async () => {
    const t = turns("HEARTBEAT_OK", "HEARTBEAT_OK", "HEARTBEAT_OK");
    await bridge.turnForWaitingPerson(t.runOnce, "PROMPT", { waiting: true, timeoutMs: 480_000 });
    expect(t.prompts.length).toBe(2);
    const quiet = turns("HEARTBEAT_OK");
    const r = await bridge.turnForWaitingPerson(quiet.runOnce, "PROMPT", { waiting: false, timeoutMs: 480_000 });
    expect(quiet.prompts.length).toBe(1);
    expect(r).toMatchObject({ reran: false, silent: false, note: false });
  });

  it("posts the note without a rerun when the first turn used half the time the api waits on", async () => {
    let clock = 0;
    const t = turns("HEARTBEAT_OK", "late");
    const runOnce = async (p: string) => { clock += 250_000; return t.runOnce(p); };
    const r = await bridge.turnForWaitingPerson(runOnce, "PROMPT", { waiting: true, timeoutMs: 480_000, now: () => clock });
    expect(t.prompts.length).toBe(1);
    expect(r).toMatchObject({ retried: true, reran: false, silent: true, note: true });
  });

  it("posts the note when a waiting person's turn held only Hermes's runtime text", async () => {
    const runOnce = async (): Promise<Turn> => {
      const { text, found } = bridge.stripHermesRuntimeText(INIT_FAILED);
      return { rawText: text, runtimeFound: found };
    };
    const r = await bridge.turnForWaitingPerson(runOnce, "PROMPT", { waiting: true, timeoutMs: 480_000 });
    expect(r).toMatchObject({ reran: false, silent: true, note: true, runtimeFound: ["agent_init_failed"] });
  });

  it("the no-reply note itself passes the api's reply guard, and holds no runtime detail", () => {
    expect(checkReplyBody(bridge.NO_REPLY_NOTE).ok).toBe(true);
    expect(bridge.NO_REPLY_NOTE).not.toMatch(/Hermes|invalid_params|HEARTBEAT/);
  });
});
