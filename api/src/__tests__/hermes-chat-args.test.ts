import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Hermes 0.22 declares session.create's `source` as one of cli, tui, gui, acp, tool or oneshot, and
// its gateway refuses any other value with `invalid_params` (field `source`). The bridges passed
// `--source circlechat`, so every agent turn failed with "Hermes couldn't start the model
// connection: invalid_params" before the model was called. `tool` is the source Hermes documents
// for a third-party integration.

type Bridge = { hermesChatArgs: (prompt: string, modelOverride?: string) => string[] };

let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as unknown as Bridge;
});

describe("hermesChatArgs", () => {
  it("runs one quiet turn with the session source Hermes accepts for an integration", () => {
    expect(bridge.hermesChatArgs("hello")).toEqual(["chat", "-q", "hello", "-Q", "--yolo", "--source", "tool"]);
  });

  it("adds the model override after the fixed arguments", () => {
    expect(bridge.hermesChatArgs("hello", "local-large")).toEqual([
      "chat", "-q", "hello", "-Q", "--yolo", "--source", "tool", "-m", "local-large",
    ]);
  });

  it("never passes a session source Hermes refuses", () => {
    const accepted = ["cli", "tui", "gui", "acp", "tool", "oneshot"];
    const args = bridge.hermesChatArgs("hello", "local-large");
    expect(accepted).toContain(args[args.indexOf("--source") + 1]);
  });
});

describe("the single-agent bridge", () => {
  it("passes the same session source", () => {
    const src = readFileSync(fileURLToPath(new URL("../../hermes-bridge.mjs", import.meta.url)), "utf8");
    expect(src).toContain('"--source", "tool"');
    expect(src).not.toMatch(/"--source", "(?!tool")/);
  });
});
