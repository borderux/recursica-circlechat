import { describe, expect, it } from "vitest";
import { agentNetworkArgs, agentApiBase } from "../agents/agent-network.js";

describe("agentNetworkArgs", () => {
  it("keeps the computer's own network when no network is set", () => {
    expect(agentNetworkArgs({})).toEqual(["--network=host"]);
    expect(agentNetworkArgs({ CC_AGENT_NETWORK: "host" })).toEqual(["--network=host"]);
  });
  it("puts the agent on the named network, behind the filter", () => {
    const a = agentNetworkArgs({ CC_AGENT_NETWORK: "cc_agents", CC_AGENT_PROXY: "http://cc-egress:3128", CC_AGENT_NO_PROXY: "api,caddy" });
    expect(a.slice(0, 2)).toEqual(["--network", "cc_agents"]);
    expect(a).toContain("HTTPS_PROXY=http://cc-egress:3128");
    expect(a).toContain("no_proxy=api,caddy");
    expect(a).toContain("NODE_USE_ENV_PROXY=1");
  });
});

describe("agentApiBase", () => {
  it("prefers the agents' own address for CircleChat", () => {
    expect(agentApiBase({ CC_AGENT_API_BASE: "http://api:3300/api", CC_API_BASE: "http://localhost:3300/api" })).toBe("http://api:3300/api");
    expect(agentApiBase({})).toBe("http://localhost:3300/api");
  });
});
