// The commit email check: which addresses pass, that a failure never prints the address, and that
// commits already on the original repository are skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allowed, problems } from "./check-commit-emails.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-commit-emails.mjs");
const NOREPLY = "1234+someone@users.noreply.github.com";
const PERSONAL = "someone@example.com";

test("a GitHub no-reply address, GitHub's bots, GitHub's web committer and Anthropic's no-reply address pass", () => {
  for (const e of [NOREPLY, "someone@users.noreply.github.com", "41898282+github-actions[bot]@users.noreply.github.com", "49699333+dependabot[bot]@users.noreply.github.com", "noreply@github.com", "noreply@anthropic.com", "NoReply@Anthropic.com"]) {
    assert.ok(allowed(e), e);
  }
  for (const e of [PERSONAL, "noreply@example.com", "someone@users.noreply.github.com.example.com"]) {
    assert.ok(!allowed(e), e);
  }
});

test("every GitHub bot passes, Dependabot's sign-off included, and a person at GitHub does not", () => {
  // A Dependabot commit as GitHub writes it: the bot's no-reply author, GitHub's web committer and
  // the bot's Signed-off-by line.
  assert.deepEqual(problems({
    sha: "5d51c20aaaaaaaa",
    author: "49699333+dependabot[bot]@users.noreply.github.com",
    committer: "noreply@github.com",
    message: "build(deps): bump a package\n\nBumps a package.\n\nSigned-off-by: dependabot[bot] <support@github.com>",
  }), []);
  for (const e of ["support@github.com", "Support@GitHub.com", "41898282+github-actions[bot]@users.noreply.github.com"]) assert.ok(allowed(e), e);
  // Only GitHub's two exact role addresses: anyone else at github.com is a person.
  for (const e of ["someone@github.com", "support@github.com.example.com", "support@github.co", "dependabot@github.com"]) {
    assert.ok(!allowed(e), e);
  }
});

test("each place in a commit is named by its kind and line, and the address never appears", () => {
  const found = problems({
    sha: "0123456789abcdef",
    author: PERSONAL,
    committer: PERSONAL,
    message: `Subject\n\nBody\n\nCo-authored-by: Someone <${PERSONAL}>\nco-authored-by: Model <noreply@anthropic.com>\nsigned-off-by: Someone <${PERSONAL}>`,
  });
  assert.deepEqual(found, ["0123456: author", "0123456: committer", "0123456: message line 5, Co-authored-by", "0123456: message line 7, Signed-off-by"]);
  assert.ok(found.every((p) => !p.includes(PERSONAL)));
  // Only the two trailers count. A trailer with no address, and an address in other text, do not.
  assert.deepEqual(problems({ sha: "0123456", author: NOREPLY, committer: NOREPLY, message: `Subject\n\nWrite to ${PERSONAL}.\n\nReported-by: Someone <${PERSONAL}>\nSigned-off-by: Someone` }), []);
});

// A repository whose commits carry the given addresses. Identity comes from GIT_AUTHOR_* and
// GIT_COMMITTER_*, so no git config is read or written.
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commit-emails-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (args, extra = {}) => execFileSync("git", args, { cwd: dir, env: { ...env, ...extra }, encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  let n = 0;
  const commit = (author, committer, message) => {
    fs.writeFileSync(path.join(dir, "file.txt"), `${++n}\n`);
    git(["add", "file.txt"]);
    git(["commit", "-q", "-m", message], { GIT_AUTHOR_NAME: "Someone", GIT_AUTHOR_EMAIL: author, GIT_COMMITTER_NAME: "Someone", GIT_COMMITTER_EMAIL: committer });
    return git(["rev-parse", "HEAD"]);
  };
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
  return { commit, run };
}

test("the script checks only the pull request's commits, and exits 2 naming each bad one", () => {
  const r = repo();
  // Already on the base branch: published before the check, and not the pull request's to fix.
  const base = r.commit(PERSONAL, PERSONAL, "Old work");
  const good = r.commit(NOREPLY, "noreply@github.com", `Good\n\nCo-authored-by: Model <noreply@anthropic.com>\nSigned-off-by: Someone <${NOREPLY}>`);
  const clean = r.run(base, good);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /✓ 1 commit\(s\)/);
  const bad = r.commit(NOREPLY, NOREPLY, `Bad\n\nSigned-off-by: Someone <${PERSONAL}>`);
  const failed = r.run(base, bad);
  assert.equal(failed.status, 2);
  assert.match(failed.stdout, new RegExp(`${bad.slice(0, 7)}: message line 3, Signed-off-by`));
  assert.doesNotMatch(failed.stdout, new RegExp(good.slice(0, 7)));
  assert.doesNotMatch(failed.stdout + failed.stderr, /example\.com/, "the log never shows the address");
});

test("commits already on the original repository's branch are skipped, and the fork's own are not", () => {
  const r = repo();
  const base = r.commit(NOREPLY, NOREPLY, "The fork's branch");
  // A commit the original repository published, with its author's own address.
  const original = r.commit(PERSONAL, PERSONAL, "Upstream work");
  assert.equal(r.run(base, original).status, 2, "checked when nothing says it is upstream");
  assert.equal(r.run(base, original, "--skip-reachable-from", original).status, 0);
  const fork = r.commit(NOREPLY, PERSONAL, "The fork's own change, rebased");
  const out = r.run(base, fork, "--skip-reachable-from", original);
  assert.equal(out.status, 2);
  assert.match(out.stdout, new RegExp(`${fork.slice(0, 7)}: committer`));
  assert.doesNotMatch(out.stdout, new RegExp(original.slice(0, 7)));
});

test("the script exits 1 on a range git cannot read, or on bad arguments", () => {
  const r = repo();
  const head = r.commit(NOREPLY, NOREPLY, "One");
  assert.equal(r.run("0000000000000000000000000000000000000000", head).status, 1);
  assert.equal(r.run().status, 1);
  assert.equal(r.run(head, head, "--skip-reachable-from").status, 1);
});
