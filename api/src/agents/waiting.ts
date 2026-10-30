// A person waiting on an agent's turn, and the note they get when no reply of
// the agent's can reach them.
//
// A person waits on a DM, and on an @-mention by a person rather than by another
// agent. The prompt already says those turns need a real reply (the bridge's
// buildPrompt). On those turns a short reply is allowed, and a reply that cannot
// be posted is replaced with NO_REPLY_NOTE, so the person is never left waiting
// on nothing. The bridge (hermes-multi-bridge.mjs, personWaits and NO_REPLY_NOTE)
// keeps the same rule and the same note; a test holds the two equal.
import type { ContextPacket } from "./context.js";

export const NO_REPLY_NOTE = "_I couldn't put a reply together this time. Please try again in a moment._";

type WaitingPacket = Pick<ContextPacket, "members" | "inbox">;

export function personWaits(trigger: string, packet: WaitingPacket | null | undefined): boolean {
  if (trigger === "dm") return true;
  if (trigger !== "mention") return false;
  const messages = packet?.inbox?.[0]?.messages ?? [];
  const last = messages[messages.length - 1];
  if (!last) return false;
  return packet?.members?.[last.memberId]?.kind !== "agent";
}
