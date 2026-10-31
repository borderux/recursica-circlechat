// A reply too long for its surface is never cut: the full text becomes an
// attached Markdown file, and the message keeps its opening paragraph and a
// line saying where the rest is. A cut used to drop the end of a reply, which
// is often the part that matters (a review's findings, a transcript's close).
//
// An agent with the deliverables-only setting gets a lower bar: anything past
// a short summary goes into the file, so a transcript or a report is always a
// file on the task, never a wall of text in chat.

export const CHAT_BODY_MAX = 2000;
export const TASK_BODY_MAX = 6000;
export const SUMMARY_MAX = 600;
const LEAD_MAX = 400;

// Cut <text> to at most <max> characters at a paragraph break, else a
// sentence end, else whitespace, never mid-word when it can be helped.
export function truncateAtBoundary(text: string, max: number): string {
  const s = String(text || "");
  if (s.length <= max) return s;
  const window = s.slice(0, max);
  const floor = Math.floor(max * 0.5);
  let cut = window.lastIndexOf("\n\n");
  if (cut < floor) {
    let last = -1;
    for (const m of window.matchAll(/[.!?…](?=\s)/g)) last = (m.index ?? 0) + 1;
    cut = last;
  }
  if (cut < floor) cut = window.lastIndexOf("\n");
  if (cut < floor) cut = window.search(/\s[^\s]*$/);
  if (cut < floor) cut = max;
  return s.slice(0, cut).trimEnd();
}

// The first paragraph of <text>, at most <max> characters.
export function leadOf(text: string, max = LEAD_MAX): string {
  const s = String(text || "").trim();
  const para = s.split(/\n\s*\n/)[0] || s;
  return truncateAtBoundary(para, max);
}

export interface SplitReply {
  body: string;
  file: { name: string; text: string } | null;
}

// <body> as it should be posted on a surface that holds <max> characters:
// unchanged when it fits, otherwise its lead plus a pointer, with the whole
// text as reply.md.
export function splitLongReply(body: string, max: number, name = "reply.md"): SplitReply {
  if (body.length <= max) return { body, file: null };
  const lead = leadOf(body);
  return {
    body: `${lead}\n\n_The full text (${body.length.toLocaleString("en-US")} characters) is attached as ${name}._`,
    file: { name, text: body.endsWith("\n") ? body : `${body}\n` },
  };
}

// The most a message or a task comment may hold before its text goes into a
// file, for an agent with or without the deliverables-only setting.
export function bodyLimit(surface: "chat" | "task", deliverablesOnly: boolean): number {
  if (deliverablesOnly) return SUMMARY_MAX;
  return surface === "chat" ? CHAT_BODY_MAX : TASK_BODY_MAX;
}
