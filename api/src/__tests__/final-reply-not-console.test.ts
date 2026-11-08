import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkReplyBody, withoutPastedCode } from "../agents/reply-guard.js";
import {
  recordRefusal,
  refusalNeedingNote,
  refusedForRun,
  refusedReplyNote,
  REFUSED_EXCERPT_CHARS,
  type ExecOutcome,
} from "../agents/executor.js";

// Built from a task_assigned turn in which the agent rewrote one page file seven times, then
// answered in 765 characters with no code. The console showed the diff of every write before the
// answer (fixtures/hermes-console-file-writes.txt, rebuilt from the run's own writes), and the
// bridge took the console as the reply: its header lines were dropped, its removed TSX lines were
// not, the code check refused the whole comment, the prose-keeper found nothing it could take
// out, and nothing reached the task. Three rules follow:
//   - the reply is the agent's final message from its Hermes session, and the console's text,
//     used only when the session has none, has every diff Hermes printed after a file write dropped;
//   - the prose-keeper removes every line the code check counts, at any indent and in any case;
//   - a task turn whose comment was refused gets a short note on the task, and the run keeps the
//     start of the refused text.

type Bridge = {
  extractReply: (raw: string) => string;
  dropFileWriteDiffs: (text: string) => string;
  sessionIdFrom: (text: string) => string | null;
  hermesTurnReply: (args: { stdout?: string; stderr?: string; hermesHome?: string; startedSec?: number }) => Promise<{
    text: string;
    fromSession: boolean;
    runaway: boolean;
    sessionSkip?: string;
  }>;
};
let bridge: Bridge;
beforeAll(async () => {
  process.env.CC_BRIDGE_IMPORT_ONLY = "1";
  // @ts-ignore — untyped .mjs module
  bridge = (await import("../../hermes-multi-bridge.mjs")) as unknown as Bridge;
});

const FIXTURES = join(__dirname, "fixtures");
const CONSOLE = readFileSync(join(FIXTURES, "hermes-console-file-writes.txt"), "utf8");
const FINAL = readFileSync(join(FIXTURES, "hermes-final-message.txt"), "utf8");
const SESSION_ID = "20260101_120000_abc123";
const TURN_STARTED = 1767268800;

// What the bridge posted before: the console without the diff header lines it already dropped.
const OLD_BODY = CONSOLE.split("\n")
  .filter((l) => !/^\s*┊|^[ab]\/\S+ → |^@@|^(?:---|\+\+\+) /.test(l) && !/^session_id:/.test(l))
  .join("\n")
  .trim();
// The run's removed and added lines, then its answer.
const SIGNED_LINES_AND_ANSWER = `${CONSOLE.slice(0, CONSOLE.indexOf(FINAL)).split("\n").filter((l) => /^[+-](?![+-]{2} )/.test(l)).join("\n")}\n\n${FINAL}`;
// The console's text once the diffs are dropped: the answer, as the bridge's text rewrites leave it.
const answered = (text: string) => {
  expect(text).toContain("I've completed the sample page as requested.");
  expect(text).toContain("The task is complete and ready for review");
  expect(text).not.toMatch(/^[-+ ]\s*(?:<|import |const |\}|Table)/m);
  expect(checkReplyBody(text)).toMatchObject({ ok: true });
};

// A Hermes home with the session tables the bridge reads. Homes sit side by side, as the agents'
// homes do, under a folder whose path holds no link (the temporary folder's own path may).
let homes: string, home: string;
function writeSessions(rows: Array<{ id: string; source: string; startedAt: number; messages: Array<{ role: string; content: string | null; toolCalls?: string }> }>, into = home) {
  const db = new DatabaseSync(join(into, "state.db"));
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at REAL NOT NULL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
      tool_calls TEXT, timestamp REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1);`);
  for (const s of rows) {
    db.prepare("INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)").run(s.id, s.source, s.startedAt);
    s.messages.forEach((m, i) =>
      db.prepare("INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?)")
        .run(s.id, m.role, m.content, m.toolCalls ?? null, s.startedAt + i),
    );
  }
  db.close();
}
const WRITE_CALL = JSON.stringify([{ type: "function", function: { name: "write_file", arguments: "{}" } }]);
const turnMessages = (last: { content: string | null; toolCalls?: string }) => [
  { role: "user", content: "You are an agent…" },
  { role: "assistant", content: "Let me first look at the project structure:", toolCalls: WRITE_CALL },
  { role: "tool", content: "{\"bytes_written\": 3670}" },
  { role: "assistant", content: "I've successfully created a sample page with three plans.", toolCalls: WRITE_CALL },
  { role: "tool", content: "{\"bytes_written\": 3183}" },
  { role: "assistant", ...last },
];

beforeEach(async () => {
  homes = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "hermes-homes-")));
  home = join(homes, "agent-a");
  await fs.mkdir(home);
});
afterEach(async () => {
  await fs.rm(homes, { recursive: true, force: true });
});

describe("the turn's console", () => {
  it("is what the code check refused, with nothing the prose-keeper could take out before", () => {
    expect(OLD_BODY.length).toBeGreaterThan(9_000);
    expect(checkReplyBody(OLD_BODY)).toEqual({ ok: false, reason: "code_diff_leak" });
    // The agent's own answer passes on its own.
    expect(checkReplyBody(FINAL)).toMatchObject({ ok: true });
  });
});

describe("the reply is the agent's final message", () => {
  it("is read from the session the console names, word for word", async () => {
    writeSessions([{ id: SESSION_ID, source: "tool", startedAt: TURN_STARTED + 6, messages: turnMessages({ content: FINAL }) }]);
    expect(bridge.sessionIdFrom(CONSOLE)).toBe(SESSION_ID);
    const r = await bridge.hermesTurnReply({ stdout: CONSOLE, hermesHome: home, startedSec: TURN_STARTED });
    expect(r).toEqual({ text: FINAL, fromSession: true, runaway: false });
  });

  it("without a session_id line, is the newest tool session since the turn began, never a cron session or an older turn", async () => {
    writeSessions([
      { id: "older_turn", source: "tool", startedAt: TURN_STARTED - 600, messages: [{ role: "assistant", content: "An older answer." }] },
      { id: "this_turn", source: "tool", startedAt: TURN_STARTED + 6, messages: turnMessages({ content: FINAL }) },
      { id: "cron_job", source: "cron", startedAt: TURN_STARTED + 60, messages: [{ role: "assistant", content: "Cron output." }] },
    ]);
    const stdout = CONSOLE.replace(/\nsession_id: .*\n$/, "\n");
    expect(bridge.sessionIdFrom(stdout)).toBeNull();
    const r = await bridge.hermesTurnReply({ stdout, hermesHome: home, startedSec: TURN_STARTED });
    expect(r.text).toBe(FINAL);
    expect(r.fromSession).toBe(true);
  });

  it("falls back to the console when the session ended on a tool call or cannot be read, with every file-write diff dropped", async () => {
    writeSessions([{ id: SESSION_ID, source: "tool", startedAt: TURN_STARTED + 6, messages: turnMessages({ content: "Writing the file now.", toolCalls: WRITE_CALL }) }]);
    const midTool = await bridge.hermesTurnReply({ stdout: CONSOLE, hermesHome: home, startedSec: TURN_STARTED });
    expect(midTool.fromSession).toBe(false);
    answered(midTool.text);
    const noHome = await bridge.hermesTurnReply({ stdout: CONSOLE, hermesHome: join(home, "missing"), startedSec: TURN_STARTED });
    expect(noHome.fromSession).toBe(false);
    answered(noHome.text);
  });

  it("is read with its write-ahead log, as Hermes leaves it before a checkpoint", async () => {
    const db = new DatabaseSync(join(home, "state.db"));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at REAL NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
        tool_calls TEXT, timestamp REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1);`);
    db.prepare("INSERT INTO sessions VALUES (?, 'tool', ?)").run(SESSION_ID, TURN_STARTED + 6);
    db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'assistant', ?, ?)").run(SESSION_ID, FINAL, TURN_STARTED + 7);
    expect(await fs.stat(join(home, "state.db-wal")).then((s) => s.size > 0)).toBe(true);
    const r = await bridge.hermesTurnReply({ stdout: CONSOLE, hermesHome: home, startedSec: TURN_STARTED });
    db.close();
    expect(r).toEqual({ text: FINAL, fromSession: true, runaway: false });
  });

  it("stays empty when the console held only a crash, without reading the session", async () => {
    writeSessions([{ id: SESSION_ID, source: "tool", startedAt: TURN_STARTED + 6, messages: turnMessages({ content: FINAL }) }]);
    const crash = "Traceback (most recent call last):\n  File \"cli.py\", line 1\nKeyboardInterrupt\n";
    expect(await bridge.hermesTurnReply({ stdout: crash, hermesHome: home, startedSec: TURN_STARTED })).toEqual({ text: "", fromSession: false, runaway: false });
  });
});

// The bridge runs as root with every agent's home mounted, and an agent can replace its own
// state.db. The bridge never follows a link on the way to it, reads only a regular file with one
// name inside that agent's own home, opens a private copy read-only, and otherwise falls back to
// the console, with the reason on the run.
describe("an agent's state.db that is not its own regular file", () => {
  const OTHER_FINAL = "Another agent's private answer, which must never be posted here.";
  const fallsBack = async (reason: RegExp) => {
    const r = await bridge.hermesTurnReply({ stdout: CONSOLE, hermesHome: home, startedSec: TURN_STARTED });
    expect(r.fromSession).toBe(false);
    expect(r.text).not.toContain(OTHER_FINAL);
    answered(r.text);
    expect(r.sessionSkip).toMatch(reason);
    return r;
  };
  const otherHome = async () => {
    const other = join(homes, "agent-b");
    await fs.mkdir(other);
    writeSessions([{ id: SESSION_ID, source: "tool", startedAt: TURN_STARTED + 6, messages: turnMessages({ content: OTHER_FINAL }) }], other);
    return other;
  };

  it("is refused when it is a link to another agent's state.db", async () => {
    const other = await otherHome();
    await fs.symlink(join(other, "state.db"), join(home, "state.db"));
    await fallsBack(/^state\.db is a link$/);
  });

  it("is refused when it is a link to a file outside the homes", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "outside-")));
    try {
      writeSessions([{ id: SESSION_ID, source: "tool", startedAt: TURN_STARTED + 6, messages: turnMessages({ content: OTHER_FINAL }) }], outside);
      await fs.symlink(join(outside, "state.db"), join(home, "state.db"));
      await fallsBack(/^state\.db is a link$/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("is refused when a folder stands in its place", async () => {
    await fs.mkdir(join(home, "state.db"));
    await fallsBack(/^state\.db is not a regular file$/);
  });

  it("is refused when it is a hard link to another agent's state.db", async () => {
    const other = await otherHome();
    await fs.link(join(other, "state.db"), join(home, "state.db"));
    await fallsBack(/^state\.db has 2 names \(a hard link\)$/);
  });

  it("is refused when its write-ahead log is a link, or the home's own path holds a link", async () => {
    writeSessions([{ id: SESSION_ID, source: "tool", startedAt: TURN_STARTED + 6, messages: turnMessages({ content: FINAL }) }]);
    const other = await otherHome();
    await fs.writeFile(join(other, "state.db-wal"), "");
    await fs.symlink(join(other, "state.db-wal"), join(home, "state.db-wal"));
    await fallsBack(/^state\.db-wal is a link$/);
    await fs.rm(join(home, "state.db-wal"));
    const linkedHome = join(homes, "agent-a-link");
    await fs.symlink(home, linkedHome);
    const r = await bridge.hermesTurnReply({ stdout: CONSOLE, hermesHome: linkedHome, startedSec: TURN_STARTED });
    expect(r).toMatchObject({ fromSession: false, sessionSkip: "the home's path holds a link" });
  });

  it("leaves no copy behind, and never writes the agent's home", async () => {
    writeSessions([{ id: SESSION_ID, source: "tool", startedAt: TURN_STARTED + 6, messages: turnMessages({ content: FINAL }) }]);
    const before = (await fs.readdir(home)).sort();
    const copiesBefore = (await fs.readdir(tmpdir())).filter((n) => n.startsWith("cc-state-")).length;
    expect((await bridge.hermesTurnReply({ stdout: CONSOLE, hermesHome: home, startedSec: TURN_STARTED })).fromSession).toBe(true);
    expect((await fs.readdir(home)).sort()).toEqual(before);
    expect((await fs.readdir(tmpdir())).filter((n) => n.startsWith("cc-state-")).length).toBe(copiesBefore);
  });
});

describe("the console's diffs after a file write", () => {
  it("are dropped whole: headers, context, removed and added lines, for every write", () => {
    const out = bridge.dropFileWriteDiffs(CONSOLE);
    expect(out).not.toMatch(/review diff|→ b\/|^@@|^[-+ ]\s*<Table|^[-+ ]\s*import/m);
    expect(out.trim()).toBe(`${FINAL}\n\nsession_id: ${SESSION_ID}`);
    answered(bridge.extractReply(CONSOLE));
  });

  it("leave a reply without a diff unchanged, its list included", () => {
    const reply = "Built the page.\n\n- three plans\n- a button for each\n\nIt is at /pages/sample.";
    expect(bridge.dropFileWriteDiffs(reply)).toBe(reply);
  });
});

describe("the prose-keeper removes every line the code check counts", () => {
  it("keeps the answer under the turn's removed and added lines, without any of its code", () => {
    expect(checkReplyBody(SIGNED_LINES_AND_ANSWER)).toEqual({ ok: false, reason: "code_diff_leak" });
    const kept = withoutPastedCode(SIGNED_LINES_AND_ANSWER);
    expect(kept).not.toBeNull();
    expect(kept!.bodyMd).toContain("I've completed the sample page as requested.");
    expect(kept!.bodyMd).toContain("`/pages/sample`");
    for (const line of kept!.bodyMd.split("\n")) {
      expect(line).not.toMatch(/^\s*[+-]\s*(?:import |const |<\/?[a-z])/i);
    }
    expect(checkReplyBody(kept!.bodyMd)).toMatchObject({ ok: true });
  });

  it("at any indent and in any case, the JSX removed lines included", () => {
    const body = [
      "-                  <Table.Th key={plan.id} ta=\"center\">",
      "-        <Text align=\"center\">",
      "  + const plans = loadPlans();",
      "-  Import { Card } from \"./ui\";",
      "The page is built and opens at /preview/sample-page.",
    ].join("\n");
    expect(checkReplyBody(body)).toEqual({ ok: false, reason: "code_diff_leak" });
    expect(withoutPastedCode(body)!.bodyMd).toBe("The page is built and opens at /preview/sample-page.");
  });
});

describe("a task turn's refused comment", () => {
  const out = (): ExecOutcome => ({ actionsApplied: 0, errors: [], trace: [] });

  it("is saved on the run with the start of its text, secrets redacted", () => {
    const o = out();
    recordRefusal(o, "task_sample", "code_diff_leak", `token cc_a1b2c3d4e5f6a1b2c3d4e5f6\n${OLD_BODY}`);
    expect(o.refused).toHaveLength(1);
    expect(o.refused![0]).toMatchObject({ surface: "task_comment", taskId: "task_sample", reason: "code_diff_leak" });
    expect(o.refused![0].excerpt).toHaveLength(REFUSED_EXCERPT_CHARS);
    const saved = refusedForRun(o.refused);
    expect(saved[0].excerpt).not.toContain("a1b2c3d4e5f6a1b2c3d4e5f6");
    expect(saved[0].excerpt).toContain("import { PageFrame }");
  });

  it("gets a note on the task saying why, unless a comment of the run reached the task", () => {
    const o = out();
    recordRefusal(o, "task_sample", "code_diff_leak", OLD_BODY);
    expect(refusalNeedingNote("task_sample", o)?.reason).toBe("code_diff_leak");
    expect(refusalNeedingNote(null, o)).toBeUndefined();
    expect(refusalNeedingNote("task_other", o)).toBeUndefined();
    expect(refusalNeedingNote("task_sample", { ...o, commented: new Set(["task_sample"]) })).toBeUndefined();
    expect(refusalNeedingNote("task_sample", out())).toBeUndefined();
  });

  it("says why in plain words and where the text is kept", () => {
    expect(refusedReplyNote("code_diff_leak", "run_1")).toBe(
      "_My reply couldn't be posted here: it held pasted code or a diff (code_diff_leak). The start of it is saved on run run_1._",
    );
    expect(refusedReplyNote("cot_leak", "run_1")).toContain("the reply check refused it (cot_leak)");
  });
});
