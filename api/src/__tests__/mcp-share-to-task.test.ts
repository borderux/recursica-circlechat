import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline";

// The MCP server's share_to_task tool sends one share_to_task action to /agent-api/act, so a file
// is attached only through the executor's own read of the shared workspace: a regular file, never
// through a link, at most 20 MB. A path outside /workspace, such as the agent's home, never reaches
// the api. The stand-in api below hands each action's files to the real fetchAgentAttachments, with
// /workspace mapped to a temporary folder, as the api container mounts the shared workspace.

const uploads: Array<{ key: string; size: number }> = [];
vi.mock("../lib/storage.js", () => ({
  putObject: async (key: string, buf: Buffer) => {
    uploads.push({ key, size: buf.length });
  },
  publicUrl: (key: string) => `/files/${key}`,
  readObject: async () => null,
}));

const SCRIPT = resolve(__dirname, "../../scripts/circlechat-mcp.mjs");
const SECRET = "BOT_TOKEN=not-for-chat";

let base: string, ws: string, home: string;
let server: Server, requests: Array<{ path: string; auth: string; body: any }>;
let mcp: ChildProcess, replies: Map<number, any>, nextId: number;

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const id = nextId++;
  mcp.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method: name === "tools/list" ? "tools/list" : "tools/call", params: name === "tools/list" ? {} : { name, arguments: args } }) + "\n");
  for (let i = 0; i < 200 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 25));
  if (!replies.has(id)) throw new Error(`no reply to ${name}`);
  return replies.get(id);
}

beforeEach(async () => {
  base = await fs.mkdtemp(join(tmpdir(), "mcp-share-"));
  ws = join(base, "workspace");
  home = join(base, "home");
  await fs.mkdir(join(ws, "writer"), { recursive: true });
  await fs.mkdir(home);
  // The agent's home, with its .env: outside the workspace.
  await fs.writeFile(join(home, ".env"), `${SECRET}\n`);
  await fs.writeFile(join(ws, "writer", "report.md"), "# Report\n");
  await fs.symlink(join(home, ".env"), join(ws, "writer", "notes.md"));
  const big = await fs.open(join(ws, "writer", "big.bin"), "w");
  await big.truncate(20 * 1024 * 1024 + 1);
  await big.close();
  uploads.length = 0;
  process.env.CC_WORKSPACE_MOUNT = ws;
  const { fetchAgentAttachments } = await import("../agents/executor.js");

  requests = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path: req.url ?? "", auth: String(req.headers.authorization ?? ""), body });
      const a = body.action ?? {};
      const files = (a.files ?? []).map((f: { path: string }) => ({ path: f.path.replace(/^\/workspace(?=\/)/, ws) }));
      const trace: string[] = [];
      const { attachments, skips } = await fetchAgentAttachments(files, trace, "share_to_task");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: skips.length === 0, applied: attachments.length, errors: skips, trace, names: attachments.map((x) => x.name) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;

  replies = new Map();
  nextId = 1;
  mcp = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, CC_BOT_TOKEN: "bot-test", CC_API_BASE: `http://127.0.0.1:${port}/api` }, stdio: ["pipe", "pipe", "pipe"] });
  createInterface({ input: mcp.stdout! }).on("line", (line) => {
    const msg = JSON.parse(line);
    replies.set(msg.id, msg);
  });
});

afterEach(async () => {
  mcp.kill();
  await new Promise((r) => server.close(r));
  await fs.rm(base, { recursive: true, force: true });
});

describe("the MCP server's share_to_task tool", () => {
  it("is listed, takes only paths, and has no url form", async () => {
    const list = await call("tools/list", {});
    const tool = list.result.tools.find((t: { name: string }) => t.name === "share_to_task");
    expect(tool).toBeTruthy();
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["bodyMd", "paths", "taskId"]);
    expect(tool.inputSchema.properties.paths.maxItems).toBe(10);
  });

  it("refuses the agent's .env in its home, and a ../ path to it, before anything reaches the api", async () => {
    for (const p of ["/opt/data/.env", "/workspace/../opt/data/.env", "/tmp/report.md", "workspace/writer/report.md"]) {
      const r = await call("share_to_task", { taskId: "t_1", paths: [p] });
      expect(r.error?.message, p).toMatch(/share_to_task refused: .*(not inside \/workspace|"\.\." part)/);
    }
    expect(requests).toEqual([]);
    expect(uploads).toEqual([]);
  });

  it("sends a link pointing out of /workspace to the checked endpoint, which refuses it and never reads what it points to", async () => {
    const r = await call("share_to_task", { taskId: "t_1", paths: ["/workspace/writer/notes.md"] });
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe("/api/agent-api/act");
    const out = JSON.parse(r.result.content[0].text);
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(0);
    expect(out.errors.join("\n")).toMatch(/notes\.md is a link/);
    expect(JSON.stringify(r)).not.toContain("not-for-chat");
    expect(uploads).toEqual([]);
  });

  it("attaches a regular file under /workspace through /agent-api/act with the agent's own token, and skips a file over 20 MB", async () => {
    const r = await call("share_to_task", { taskId: "t_1", bodyMd: "The report.", paths: ["/workspace/writer/report.md", "/workspace/writer/big.bin"] });
    expect(requests).toHaveLength(1);
    expect(requests[0].auth).toBe("Bearer bot-test");
    expect(requests[0].body).toEqual({
      action: {
        type: "share_to_task",
        task_id: "t_1",
        body_md: "The report.",
        files: [{ path: "/workspace/writer/report.md" }, { path: "/workspace/writer/big.bin" }],
      },
    });
    const out = JSON.parse(r.result.content[0].text);
    expect(out.names).toEqual(["report.md"]);
    expect(out.errors.join("\n")).toMatch(/big\.bin/);
    expect(uploads).toHaveLength(1);
  });
});

describe("CircleChat's own registration of the server", () => {
  it("never lists upload_file, which uploads any file in the container and skips the executor", async () => {
    const { MCP_READ_TOOLS } = await import("../agents/hermes-equip.js");
    expect(MCP_READ_TOOLS).not.toContain("upload_file");
  });
});
