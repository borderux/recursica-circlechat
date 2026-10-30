import { describe, it, expect, beforeAll } from "vitest";
import { checkReplyBody, MIN_AGENT_BODY_CHARS } from "../agents/reply-guard.js";
import { needsNoReplyNote } from "../agents/executor.js";
import { personWaits, NO_REPLY_NOTE } from "../agents/waiting.js";
import { droppedFrom } from "../agents/adapters/hermes.js";

// A reply nobody sees is a failure a person never hears about. Three rules:
//   - a person waiting on a DM or a person's @-mention may get a short reply, such as "Hello! 👋";
//   - when a reply for that person still cannot be posted, a short note goes to the conversation;
//   - every reply that could not be used is recorded in the run's result_json as `dropped`, with
//     the conversation and the reason and never the text, so a host can tell an operator.

type Bridge = { NO_REPLY_NOTE: string; personWaits: (trigger: string, packet: unknown, last: unknown) => boolean };
let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as unknown as Bridge;
});

const packet = (lastFrom: string) => ({
  members: {
    m_person: { memberId: "m_person", kind: "user" as const, name: "Pat", handle: "pat" },
    m_bot: { memberId: "m_bot", kind: "agent" as const, name: "Bot", handle: "bot" },
  },
  inbox: [{ conversationId: "c_1", messages: [{ id: "m1", memberId: lastFrom, bodyMd: "hi" }] }],
}) as unknown as Parameters<typeof personWaits>[1];

describe("a short reply for a waiting person", () => {
  it("passes the guard only when a person waits; every other post keeps the length floor", () => {
    expect("Hello! 👋".length).toBeLessThan(MIN_AGENT_BODY_CHARS);
    expect(checkReplyBody("Hello! 👋")).toEqual({ ok: false, reason: "too_short" });
    expect(checkReplyBody("Hello! 👋", { allowShort: true })).toMatchObject({ ok: true, bodyMd: "Hello! 👋" });
  });

  it("still refuses what no person should see, short or not", () => {
    expect(checkReplyBody("👍", { allowShort: true })).toEqual({ ok: false, reason: "emoji_only" });
    expect(checkReplyBody("HEARTBEAT_OK", { allowShort: true })).toMatchObject({ ok: false });
  });
});

describe("who waits", () => {
  it("a DM and a person's @-mention; never an agent's @-mention or a background trigger", () => {
    expect(personWaits("dm", packet("m_person"))).toBe(true);
    expect(personWaits("mention", packet("m_person"))).toBe(true);
    expect(personWaits("mention", packet("m_bot"))).toBe(false);
    for (const trigger of ["scheduled", "ambient", "thread_reply", "channel_post", "task_assigned"]) {
      expect(personWaits(trigger, packet("m_person"))).toBe(false);
    }
  });

  it("the bridge keeps the same rule and the same note", () => {
    for (const [trigger, from] of [["dm", "m_person"], ["mention", "m_person"], ["mention", "m_bot"], ["ambient", "m_person"]] as const) {
      const q = packet(from);
      const last = q?.inbox[0].messages[0];
      expect(bridge.personWaits(trigger, q, last)).toBe(personWaits(trigger, q));
    }
    expect(bridge.NO_REPLY_NOTE).toBe(NO_REPLY_NOTE);
  });
});

describe("the no-reply note", () => {
  it("goes out when the waiting person's reply was dropped and nothing else reached them", () => {
    const dropped = [{ conversationId: "c_1", reason: "actions_block_visible" }];
    expect(needsNoReplyNote("c_1", dropped, undefined)).toBe(true);
    expect(needsNoReplyNote("c_1", dropped, new Set(["c_1"]))).toBe(false);
    expect(needsNoReplyNote("c_1", [{ conversationId: "c_2", reason: "too_short" }], undefined)).toBe(false);
    expect(needsNoReplyNote("c_1", undefined, undefined)).toBe(false);
    expect(needsNoReplyNote(null, dropped, undefined)).toBe(false);
  });

  it("passes the guard, and names no runtime detail", () => {
    expect(checkReplyBody(NO_REPLY_NOTE).ok).toBe(true);
    expect(NO_REPLY_NOTE).not.toMatch(/Hermes|HEARTBEAT|invalid_params|rejected/);
  });
});

describe("the bridge's record of a dropped reply", () => {
  it("keeps a conversation id and a reason code, and nothing else", () => {
    expect(droppedFrom([{ conversation_id: "c_1", reason: "no_reply_after_retry", body_md: "secret text", extra: 1 }])).toEqual([
      { conversationId: "c_1", reason: "no_reply_after_retry" },
    ]);
  });

  it("cleans a reason down to a short code, and drops an entry with none", () => {
    const [d] = droppedFrom([{ conversation_id: "c_1", reason: "hermes_runtime_text: agent_init_failed <b>\n" + "x".repeat(200) }]);
    expect(d.reason).toMatch(/^[a-z0-9_:, -]+$/i);
    expect(d.reason.length).toBeLessThanOrEqual(80);
    expect(droppedFrom([{ conversation_id: "c_1" }, null, "x"])).toEqual([]);
    expect(droppedFrom("not a list")).toEqual([]);
  });
});
