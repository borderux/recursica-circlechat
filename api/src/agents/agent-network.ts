// The network an agent container runs on, and the filter its outgoing connections go through.
//
//   CC_AGENT_NETWORK   a Docker network name; unset keeps the computer's own network ("host")
//   CC_AGENT_PROXY     the outgoing filter's URL, such as http://cc-egress:3128
//   CC_AGENT_NO_PROXY  hosts the agent reaches directly, such as api,caddy,cc-gateway
//
// With a closed network (a Docker network with no route out) and a filter, an agent reaches only
// the sites the filter allows, and a program that ignores the proxy settings reaches nothing.
export function agentNetworkArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const network = (env.CC_AGENT_NETWORK ?? "").trim();
  if (!network || network === "host") return ["--network=host"];
  // A name server that answers nothing: Docker still resolves the network's own names (api,
  // egress), and every other lookup fails, so no data leaves inside a lookup.
  const args = ["--network", network, "--dns", "127.0.0.1"];
  const proxy = (env.CC_AGENT_PROXY ?? "").trim();
  if (proxy) {
    const noProxy = (env.CC_AGENT_NO_PROXY ?? "").trim();
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) args.push("-e", `${k}=${proxy}`);
    if (noProxy) for (const k of ["NO_PROXY", "no_proxy"]) args.push("-e", `${k}=${noProxy}`);
    // Node's fetch follows the proxy settings only with this switch.
    args.push("-e", "NODE_USE_ENV_PROXY=1");
  }
  return args;
}

// The CircleChat address an agent container uses. On a closed network, the computer's localhost
// is out of reach, so the agent uses the api's name on that network instead.
export function agentApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.CC_AGENT_API_BASE ?? env.CC_API_BASE ?? "http://localhost:3300/api";
}
