import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { storageVerdict } from "../lib/storage-probe.js";

// An agent's 7 KB deliverable, saved as reply.md on a task, opened in the
// browser as "Couldn't load file, http_404". The worker had saved it in its
// container's own ./storage; the api, which serves /files/<key>, looked in
// its own, empty one. Neither was a volume, so every stored file was also lost
// whenever the containers were recreated.
describe("compose.yml: one durable file store for the api and the worker", () => {
  const compose = parse(readFileSync(join(__dirname, "../../../compose.yml"), "utf8"));

  for (const service of ["api", "worker"]) {
    it(`${service} keeps its files on the storage volume, at STORAGE_DIR`, () => {
      const s = compose.services[service];
      expect(s.environment.STORAGE_DIR).toBe("/app/storage");
      expect(s.volumes).toContain("storage:/app/storage");
    });
  }

  it("the storage volume is a named volume, so a rebuild keeps it", () => {
    expect(compose.volumes).toHaveProperty("storage");
  });
});

describe("the api checks it sees the worker's files", () => {
  it("shared when the api finds the id the worker announced", () => {
    expect(storageVerdict("a1b2c3", "a1b2c3")).toBe("shared");
    expect(storageVerdict("a1b2c3", "a1b2c3\n")).toBe("shared");
  });

  it("not shared when the worker's probe is missing or stale in the api's store", () => {
    expect(storageVerdict("a1b2c3", null)).toBe("not_shared");
    expect(storageVerdict("a1b2c3", "ffeedd")).toBe("not_shared");
  });

  it("unknown before the worker has started", () => {
    expect(storageVerdict(null, null)).toBe("unknown");
  });
});
