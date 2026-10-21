import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The agents' network, filter and MCP settings reach CircleChat only when compose.agents.yml
// passes them into each container that starts agent turns. Without this, the outgoing filter is
// silently off.
describe("compose.agents.yml", () => {
  const compose = parse(readFileSync(join(__dirname, "../../../compose.agents.yml"), "utf8"));
  for (const service of ["api", "worker", "bridge"]) {
    it(`passes the agent settings into ${service}`, () => {
      const env = compose.services[service].environment;
      for (const k of ["CC_AGENT_NETWORK", "CC_AGENT_PROXY", "CC_AGENT_NO_PROXY", "CC_AGENT_API_BASE", "CC_AGENT_MCP_SERVERS", "CC_HERMES_IMAGE"]) {
        if (service === "worker" && k === "CC_HERMES_IMAGE") continue;
        expect(env, `${service} ${k}`).toHaveProperty(k);
      }
    });
  }
});
