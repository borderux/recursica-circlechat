import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs, readdirSync, readFileSync, lstatSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHomeFile, writeHomeFile, SymlinkRefused } from "../agents/home-files.js";
import { addExtraMcpServers } from "../agents/hermes-equip.js";

// An agent's own container can change everything in its Hermes home, so Equip must never follow a
// symlink there: a config.yaml replaced with a symlink would let Equip write a file the agent
// cannot, such as another agent's config.yaml.

let root: string, home: string, outside: string, config: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "home-files-"));
  home = join(root, ".hermes-alice");
  outside = join(root, "outside");
  await fs.mkdir(home);
  await fs.mkdir(outside);
  await fs.writeFile(join(outside, "target.yaml"), "outside: true\n");
  config = join(home, "config.yaml");
});

const SETTING = JSON.stringify({ alice: { docs: { command: "node", args: ["/opt/data/docs/server.mjs"] } } });

describe("writeHomeFile", () => {
  it("writes a new file and moves it into place, with the old file's mode, and leaves no temporary file", async () => {
    await fs.writeFile(config, "model: {}\n", { mode: 0o640 });
    await fs.chmod(config, 0o640);
    const before = statSync(config).ino;
    await writeHomeFile(home, config, "model:\n  default: x\n");
    expect(readFileSync(config, "utf8")).toBe("model:\n  default: x\n");
    expect(statSync(config).ino).not.toBe(before);
    expect(statSync(config).mode & 0o777).toBe(0o640);
    expect(readdirSync(home)).toEqual(["config.yaml"]);
  });

  it("refuses a symlinked config.yaml, and leaves the symlink and the file it names alone", async () => {
    await fs.symlink(join(outside, "target.yaml"), config);
    await expect(writeHomeFile(home, config, "taken: true\n")).rejects.toBeInstanceOf(SymlinkRefused);
    await expect(readHomeFile(home, config)).rejects.toBeInstanceOf(SymlinkRefused);
    expect(lstatSync(config).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, "target.yaml"), "utf8")).toBe("outside: true\n");
    expect(readdirSync(home)).toEqual(["config.yaml"]);
  });

  it("refuses a symlink anywhere on the path, the home itself included", async () => {
    // A folder inside the home that is a symlink.
    await fs.symlink(outside, join(home, "skills"));
    await expect(writeHomeFile(home, join(home, "skills", "target.yaml"), "taken: true\n")).rejects.toThrow(/skills is a symlink/);
    // The home itself.
    const linked = join(root, ".hermes-bob");
    await fs.symlink(outside, linked);
    await expect(writeHomeFile(linked, join(linked, "target.yaml"), "taken: true\n")).rejects.toThrow(/\.hermes-bob is a symlink/);
    expect(readFileSync(join(outside, "target.yaml"), "utf8")).toBe("outside: true\n");
    expect(readdirSync(outside)).toEqual(["target.yaml"]);
  });

  it("refuses a file outside the home", async () => {
    await expect(writeHomeFile(home, join(outside, "target.yaml"), "taken: true\n")).rejects.toThrow(/not inside the agent's home/);
  });
});

describe("addExtraMcpServers (Equip's CC_AGENT_MCP_SERVERS step)", () => {
  it("adds the handle's servers beside the servers already there", async () => {
    await fs.writeFile(config, "mcp_servers:\n  circlechat:\n    command: node\n");
    expect(await addExtraMcpServers(home, SETTING)).toBe(true);
    const text = readFileSync(config, "utf8");
    expect(text).toMatch(/circlechat:\n {4}command: node/);
    expect(text).toMatch(/docs:\n {4}command: node\n {4}args:\n {6}- \/opt\/data\/docs\/server\.mjs/);
  });

  it("writes nothing for a handle with no servers", async () => {
    await fs.writeFile(config, "model: {}\n");
    expect(await addExtraMcpServers(home, JSON.stringify({ bob: { docs: {} } }))).toBe(false);
    expect(readFileSync(config, "utf8")).toBe("model: {}\n");
  });

  it("refuses a symlinked config.yaml, and writes nothing through the symlink", async () => {
    await fs.symlink(join(outside, "target.yaml"), config);
    await expect(addExtraMcpServers(home, SETTING)).rejects.toBeInstanceOf(SymlinkRefused);
    expect(readFileSync(join(outside, "target.yaml"), "utf8")).toBe("outside: true\n");
    expect(lstatSync(config).isSymbolicLink()).toBe(true);
  });
});
