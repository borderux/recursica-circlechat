// Reading and writing a file an agent names, in the shared workspace mounted at /workspace.
//
// Every agent can change everything under /workspace, so a path there can lead, through a link,
// to the api container's own files: its environment, its keys, another agent's home. So:
//   - the path must be absolute, inside the workspace, with no empty, "." or ".." part;
//   - the workspace folder and every folder from it down to the file must be a real folder, never
//     a link. The folders above the workspace belong to the operator and are not checked;
//   - the file is opened with O_NOFOLLOW, so a link at the file itself is refused, and with
//     O_NONBLOCK, so a planted FIFO cannot hold the api;
//   - the opened file must be a regular file at the path that was checked: a folder swapped for a
//     link between the check and the open is caught by asking where the open file really is;
//   - a read stops at a size cap.
// A write creates a new file next to the old one (O_EXCL), then renames it into place: a rename
// replaces the entry itself, so a link at the name is replaced, never followed.
import { constants, promises as fs, type Stats } from "node:fs";
import { randomBytes } from "node:crypto";

export class WorkspaceRefused extends Error {}

export function workspaceRoot(): string {
  return (process.env.CC_WORKSPACE_MOUNT || "/workspace").replace(/\/+$/, "") || "/workspace";
}

// The parts of <path> below <root>, or a refusal.
export function workspaceParts(path: string, root = workspaceRoot()): string[] {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) {
    throw new WorkspaceRefused(`${String(path)} is not an absolute path`);
  }
  if (!path.startsWith(root + "/")) throw new WorkspaceRefused(`${path} is not inside ${root}`);
  const parts = path.slice(root.length + 1).split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new WorkspaceRefused(`${path} has an empty, "." or ".." part`);
  }
  return parts;
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await fs.lstat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

// Refuses a link, or anything but a folder, at <root> and at each folder part below it.
async function assertRealFolders(root: string, folders: string[]): Promise<void> {
  let dir = root;
  for (const part of ["", ...folders]) {
    if (part) dir = `${dir}/${part}`;
    const st = await lstatOrNull(dir);
    if (!st) throw new WorkspaceRefused(`${dir} does not exist`);
    if (st.isSymbolicLink()) throw new WorkspaceRefused(`${dir} is a link`);
    if (!st.isDirectory()) throw new WorkspaceRefused(`${dir} is not a folder`);
  }
}

// The opened file is the one at <path>, reached through real folders. On Linux the kernel says
// where the descriptor points; elsewhere the folders are checked again and the file's identity
// compared with the entry at <path>.
async function assertOpenedAt(fd: number, st: Stats, root: string, parts: string[], path: string): Promise<void> {
  const where = await fs.readlink(`/proc/self/fd/${fd}`).catch(() => null);
  if (where !== null) {
    const realRoot = await fs.realpath(root);
    if (where !== `${realRoot}/${parts.join("/")}`) throw new WorkspaceRefused(`${path} leads outside ${root}`);
    return;
  }
  await assertRealFolders(root, parts.slice(0, -1));
  const now = await lstatOrNull(path);
  if (!now || now.isSymbolicLink() || now.ino !== st.ino || now.dev !== st.dev) {
    throw new WorkspaceRefused(`${path} changed while it was read`);
  }
}

// The bytes of the regular file at <path> in the workspace, at most <maxBytes> of them. Refuses
// a link anywhere on the path, a path outside the workspace, anything but a regular file, and a
// file over the cap.
export async function readWorkspaceFile(path: string, maxBytes: number, root = workspaceRoot()): Promise<Buffer> {
  const parts = workspaceParts(path, root);
  await assertRealFolders(root, parts.slice(0, -1));
  let handle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") throw new WorkspaceRefused(`${path} is a link`);
    if (code === "ENOENT") throw new WorkspaceRefused(`${path} does not exist`);
    throw e;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new WorkspaceRefused(`${path} is not a regular file`);
    if (st.size > maxBytes) throw new WorkspaceRefused(`${path} is ${st.size} bytes, over the ${maxBytes}-byte cap`);
    await assertOpenedAt(handle.fd, st, root, parts, path);
    const buf = Buffer.alloc(maxBytes + 1);
    let got = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, got, buf.length - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
      if (got > maxBytes) throw new WorkspaceRefused(`${path} grew past the ${maxBytes}-byte cap`);
    }
    return buf.subarray(0, got);
  } finally {
    await handle.close();
  }
}

// The text of the file at <path>, or "" when it is missing or refused. For the context reads,
// which are best-effort.
export async function readWorkspaceText(path: string, maxBytes: number, root = workspaceRoot()): Promise<string> {
  try {
    return (await readWorkspaceFile(path, maxBytes, root)).toString("utf8");
  } catch {
    return "";
  }
}

// Writes <text> to <path> in the workspace: a new file in the same folder, renamed into place.
// Missing folders are made one at a time, each checked to be a real folder. With append, the old
// file's text (read through readWorkspaceFile, so never through a link) comes first.
export async function writeWorkspaceFile(
  path: string,
  text: string,
  opts: { append?: boolean; maxBytes?: number } = {},
  root = workspaceRoot(),
): Promise<void> {
  const parts = workspaceParts(path, root);
  let dir = root;
  await assertRealFolders(root, []);
  for (let i = 0; i < parts.length - 1; i++) {
    dir = `${dir}/${parts[i]}`;
    if (!(await lstatOrNull(dir))) {
      await fs.mkdir(dir).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "EEXIST") throw e;
      });
    }
    await assertRealFolders(root, parts.slice(0, i + 1));
  }
  const existing = await lstatOrNull(path);
  if (existing && !existing.isFile()) throw new WorkspaceRefused(`${path} is not a regular file`);
  let body = text;
  if (opts.append && existing) {
    body = (await readWorkspaceFile(path, opts.maxBytes ?? 20 * 1024 * 1024, root)).toString("utf8") + text;
  }
  const temp = `${dir}/.${randomBytes(6).toString("hex")}.cc-new`;
  const handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    await handle.writeFile(body);
  } finally {
    await handle.close();
  }
  try {
    await assertRealFolders(root, parts.slice(0, -1));
    await fs.rename(temp, path);
  } catch (e) {
    await fs.rm(temp, { force: true });
    throw e;
  }
}
