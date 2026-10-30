import { describe, it, expect, beforeAll } from "vitest";
import { checkReplyBody } from "../agents/reply-guard.js";

// An agent's reply carries its actions in an <actions> block. Two bugs made a small format slip
// cost the whole turn:
//   - extractActions read only a JSON array. A single object inside <actions> fell to the bare-line
//     fallback, which ran the action but left the empty tags in the body, and the reply guard then
//     refused the post as actions_block_visible.
//   - The prose rewrites, which run before the actions are read, rewrote machine data too: a
//     message id inside the block became "an earlier message", so the react action failed with
//     message_not_found though the message existed.

type Action = Record<string, unknown>;
type Bridge = {
  extractReply: (raw: string) => string;
  extractActions: (text: string) => { body: string; actions: Action[] };
  sanitizeProse: (text: string) => string;
};

let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as unknown as Bridge;
});

// One reply from a live run, exactly as Hermes returned it: a greeting, then a single object
// inside <actions> instead of an array.
const LIVE_REPLY = 'Hello! 👋\n\n\n\n<actions>\n  {"type":"react","message_id":"m_gopm9ffobkrn4aqn47gb","emoji":"👋"}\n</actions>';

const read = (raw: string) => bridge.extractActions(bridge.extractReply(raw));

describe("an <actions> block with a small format slip", () => {
  it("the live reply: a single object runs as a list of one, keeps its message id, and leaves the body clean", () => {
    const { body, actions } = read(LIVE_REPLY);
    expect(body).toBe("Hello! 👋");
    expect(actions).toEqual([{ type: "react", message_id: "m_gopm9ffobkrn4aqn47gb", emoji: "👋" }]);
    // The post is no longer refused for a visible actions block. The reply came on a person's
    // @-mention, where a short reply is allowed, so it posts.
    const guard = checkReplyBody(body);
    if (!guard.ok) expect(guard.reason).not.toBe("actions_block_visible");
    expect(checkReplyBody(body, { allowShort: true })).toMatchObject({ ok: true, bodyMd: "Hello! 👋" });
  });

  it("an array still works as before", () => {
    const { body, actions } = read('Done.\n<actions>[{"type":"react","message_id":"m_abcdefghij0123456789","emoji":"✅"},{"type":"task_comment","task_id":"t_1","body_md":"noted"}]</actions>');
    expect(body).toBe("Done.");
    expect(actions.map((a) => a.type)).toEqual(["react", "task_comment"]);
    expect(actions[0].message_id).toBe("m_abcdefghij0123456789");
  });

  it("objects one per line inside the tags run as a list, and the tags leave the body", () => {
    const { body, actions } = read('On it.\n<actions>\n{"type":"react","message_id":"m_abcdefghij0123456789","emoji":"👍"}\n{"type":"task_comment","task_id":"t_1","body_md":"started"}\n</actions>');
    expect(body).toBe("On it.");
    expect(actions.map((a) => a.type)).toEqual(["react", "task_comment"]);
  });

  it("a block that is not JSON at all runs nothing, and still leaves the body", () => {
    const { body, actions } = read("Thanks!\n<actions>{not json}</actions>");
    expect(body).toBe("Thanks!");
    expect(actions).toEqual([]);
  });
});

describe("the prose rewrites leave machine data alone", () => {
  it("rewrites a message id in prose, and never one inside <actions>, <attachments> or a bare JSON line", () => {
    const text = [
      "I replied to m_abcdefghij0123456789 earlier.",
      '<actions>[{"type":"task_comment","task_id":"t_1","body_md":"see m_abcdefghij0123456789"}]</actions>',
      '{"type":"react","message_id":"m_zyxwvutsrq9876543210","emoji":"👀"}',
    ].join("\n");
    const out = bridge.sanitizeProse(text);
    expect(out.split("\n")[0]).toBe("I replied to an earlier message earlier.");
    expect(out).toContain('<actions>[{"type":"task_comment","task_id":"t_1","body_md":"see m_abcdefghij0123456789"}]</actions>');
    expect(out).toContain('{"type":"react","message_id":"m_zyxwvutsrq9876543210","emoji":"👀"}');
  });

  it("an action's type survives the vocabulary rewrites that turn task_comment into words in prose", () => {
    const { body, actions } = read('Left a task_comment.\n<actions>{"type":"task_comment","task_id":"t_1","body_md":"done"}</actions>');
    expect(body).not.toContain("task_comment");
    expect(actions).toEqual([{ type: "task_comment", task_id: "t_1", body_md: "done" }]);
  });
});
