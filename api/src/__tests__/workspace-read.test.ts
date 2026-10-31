import { describe, it, expect, beforeEach, vi } from "vitest";
import { promises as fs, existsSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readWorkspaceFile,
  readWorkspaceText,
  writeWorkspaceFile,
  workspaceParts,
  WorkspaceRefused,
} from "../lib/workspace-read.js";

// Every agent can change everything in the shared workspace, and the api mounts it at /workspace.
// A file an agent names there must never lead the api to its own files: only a regular file
// inside the workspace is read, never through a link anywhere on the path, and never over a cap.

const uploads: Array<{ key: string; size: number }> = [];
vi.mock("../lib/storage.js", () => ({
  putObject: async (key: string, buf: Buffer) => {
    uploads.push({ key, size: buf.length });
  },
  publicUrl: (key: string) => `/files/${key}`,
  readObject: async () => null,
}));

let base: string, ws: string, apiFiles: string, secret: string;
beforeEach(async () => {
  base = await fs.mkdtemp(join(tmpdir(), "workspace-read-"));
  ws = join(base, "workspace");
  // Stands in for the api container's own files: its environment and keys.
  apiFiles = join(base, "app");
  secret = join(apiFiles, ".env");
  await fs.mkdir(join(ws, "writer", "Transcripts_demo"), { recursive: true });
  await fs.mkdir(apiFiles);
  await fs.writeFile(secret, "SESSION_SECRET=not-for-agents\n");
  await fs.writeFile(join(ws, "writer", "Transcripts_demo", "01_interview.txt"), "Researcher 00:00:05\nThanks for joining.\n");
  uploads.length = 0;
});

const refused = async (p: Promise<unknown>, why: RegExp) => {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(WorkspaceRefused);
  expect((e as Error).message).toMatch(why);
};

describe("readWorkspaceFile", () => {
  it("reads a regular file inside the workspace", async () => {
    const buf = await readWorkspaceFile(join(ws, "writer", "Transcripts_demo", "01_interview.txt"), 1024, ws);
    expect(buf.toString("utf8")).toContain("Thanks for joining.");
  });

  it("refuses a link planted to the api container's own files, and never reads them", async () => {
    const link = join(ws, "writer", "Transcripts_demo", "02_interview.txt");
    await fs.symlink(secret, link);
    await refused(readWorkspaceFile(link, 1024, ws), /is a link/);
    expect(await readWorkspaceText(link, 1024, ws)).toBe("");
    // The same with a system file the api container holds, by absolute path.
    const passwd = join(ws, "writer", "passwd");
    await fs.symlink("/etc/passwd", passwd);
    await refused(readWorkspaceFile(passwd, 1024 * 1024, ws), /is a link/);
    if (existsSync("/proc/self/environ")) {
      const environ = join(ws, "writer", "environ");
      await fs.symlink("/proc/self/environ", environ);
      await refused(readWorkspaceFile(environ, 1024 * 1024, ws), /is a link/);
    }
  });

  it("refuses a link to a folder anywhere on the path", async () => {
    // writer/keys → the api's folder: writer/keys/.env is the api's .env through the link.
    await fs.symlink(apiFiles, join(ws, "writer", "keys"));
    await refused(readWorkspaceFile(join(ws, "writer", "keys", ".env"), 1024, ws), /writer\/keys is a link/);
    // A whole agent folder swapped for a link.
    await fs.rm(join(ws, "writer"), { recursive: true });
    await fs.symlink(apiFiles, join(ws, "writer"));
    await refused(readWorkspaceFile(join(ws, "writer", ".env"), 1024, ws), /writer is a link/);
  });

  it("refuses the workspace itself when it is a link", async () => {
    const linked = join(base, "linked-workspace");
    await fs.symlink(apiFiles, linked);
    await refused(readWorkspaceFile(join(linked, ".env"), 1024, linked), /is a link/);
  });

  it("refuses a ../ path, an empty or . part, and a path outside the workspace", async () => {
    await refused(readWorkspaceFile(`${ws}/../app/.env`, 1024, ws), /"\.\."/);
    await refused(readWorkspaceFile(`${ws}/writer/../../app/.env`, 1024, ws), /"\.\."/);
    await refused(readWorkspaceFile(`${ws}/writer/./Transcripts_demo/01_interview.txt`, 1024, ws), /"\."/);
    await refused(readWorkspaceFile(`${ws}/writer//Transcripts_demo/01_interview.txt`, 1024, ws), /empty/);
    await refused(readWorkspaceFile(secret, 1024, ws), /not inside/);
    await refused(readWorkspaceFile("/tmp/x.pdf", 1024, ws), /not inside/);
    await refused(readWorkspaceFile("/opt/data/cache/x.png", 1024, ws), /not inside/);
    await refused(readWorkspaceFile("writer/Transcripts_demo/01_interview.txt", 1024, ws), /not an absolute path/);
    // A prefix of the workspace's name is not inside it.
    await fs.mkdir(`${ws}-other`);
    await fs.writeFile(`${ws}-other/x.txt`, "x");
    await refused(readWorkspaceFile(`${ws}-other/x.txt`, 1024, ws), /not inside/);
    expect(() => workspaceParts("/workspace/a/../b")).toThrow(WorkspaceRefused);
  });

  it("refuses a folder, a missing file, and a file over the cap", async () => {
    await refused(readWorkspaceFile(join(ws, "writer", "Transcripts_demo"), 1024, ws), /not a regular file/);
    await refused(readWorkspaceFile(join(ws, "writer", "missing.txt"), 1024, ws), /does not exist/);
    await fs.writeFile(join(ws, "writer", "big.txt"), "x".repeat(2048));
    await refused(readWorkspaceFile(join(ws, "writer", "big.txt"), 1024, ws), /over the 1024-byte cap/);
    expect((await readWorkspaceFile(join(ws, "writer", "big.txt"), 2048, ws)).length).toBe(2048);
  });
});

describe("writeWorkspaceFile", () => {
  it("refuses a link at the name, and leaves the link and the file it names alone", async () => {
    const link = join(ws, "writer", "status.md");
    await fs.symlink(secret, link);
    await refused(writeWorkspaceFile(link, "# status\n", {}, ws), /not a regular file/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(secret, "utf8")).toBe("SESSION_SECRET=not-for-agents\n");
  });

  it("refuses a linked folder on the path, and appends through the guarded read", async () => {
    await fs.symlink(apiFiles, join(ws, "projects"));
    await refused(writeWorkspaceFile(join(ws, "projects", "demo", "log.md"), "x", {}, ws), /projects is a link/);
    expect(existsSync(join(apiFiles, "demo"))).toBe(false);
    const log = join(ws, "writer", "log.md");
    await writeWorkspaceFile(log, "one\n", { append: true }, ws);
    await writeWorkspaceFile(log, "two\n", { append: true }, ws);
    expect(readFileSync(log, "utf8")).toBe("one\ntwo\n");
    expect((await fs.readdir(join(ws, "writer"))).filter((n) => n.endsWith(".cc-new"))).toEqual([]);
  });
});

describe("share_to_task and share_files read only through the guard", () => {
  it("attaches a regular file in the workspace and skips a planted link, a linked folder and a ../ path", async () => {
    process.env.CC_WORKSPACE_MOUNT = ws;
    const { fetchAgentAttachments } = await import("../agents/executor.js");
    await fs.symlink(secret, join(ws, "writer", "leak.txt"));
    await fs.symlink(apiFiles, join(ws, "writer", "keys"));
    const trace: string[] = [];
    const { attachments, skips } = await fetchAgentAttachments(
      [
        { path: join(ws, "writer", "Transcripts_demo", "01_interview.txt"), name: "01_interview.txt" },
        { path: join(ws, "writer", "leak.txt") },
        { path: join(ws, "writer", "keys", ".env") },
        { path: `${ws}/writer/../../app/.env` },
        { path: "/opt/data/.env" },
      ],
      trace,
      "share_to_task",
    );
    expect(attachments.map((a) => a.name)).toEqual(["01_interview.txt"]);
    expect(uploads).toHaveLength(1);
    expect(skips).toHaveLength(4);
    expect(skips.join("\n")).toMatch(/leak\.txt is a link/);
    expect(skips.join("\n")).toMatch(/keys is a link/);
    expect(skips.join("\n")).toMatch(/"\.\."/);
    expect(skips.join("\n")).toMatch(/not inside/);
    expect(trace.join("\n")).not.toContain("not-for-agents");
  });
});
