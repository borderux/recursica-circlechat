import type { ContextPacket } from "../context.js";
import type { agents } from "../../db/schema.js";
import { callOpenClawWebhook } from "./openclaw.js";
import { callHermesSocket } from "./hermes.js";
import type { ReportedModelUsage } from "../../lib/model-routing.js";

type Agent = typeof agents.$inferSelect;

export interface AgentCallResponse {
  actions: unknown[];
  trace?: string[];
  usage?: ReportedModelUsage;
  // Explicit failure reason from the runtime/bridge (e.g. "empty_reply",
  // "runaway_max_iterations"). The worker records it as a FAILED run instead
  // of a silent ok; actions (if any) are still applied.
  error?: string;
  // Replies the runtime could not use, such as a turn that held only the
  // runtime's own text: where each was meant to go and why, never the text.
  dropped?: Array<{ conversationId: string | null; reason: string }>;
  // What the runtime saw the agent ask for that did not run, such as a tool
  // written as an <actions> entry. Recorded with the run's errors, which the
  // agent reads on its next turn.
  errors?: string[];
}

export async function callAgent(
  agent: Agent,
  kind: "heartbeat" | "event",
  packet: ContextPacket,
): Promise<AgentCallResponse | "HEARTBEAT_OK"> {
  if (agent.adapter === "webhook") {
    if (!agent.callbackUrl) throw new Error("no_callback_url");
    return callOpenClawWebhook({
      callbackUrl: agent.callbackUrl,
      botToken: agent.botToken,
      kind,
      packet,
    });
  }
  if (agent.adapter === "socket") {
    return callHermesSocket({ agentId: agent.id, kind, packet });
  }
  throw new Error(`unknown_adapter_${agent.adapter}`);
}
