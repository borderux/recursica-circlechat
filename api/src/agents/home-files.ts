// Reading and replacing a file inside an agent's Hermes home without following a symlink.
//
// The agent's own container can change everything in its home, so a file there can be replaced
// with a symlink to a file the api can write and the agent cannot, such as another agent's
// config.yaml. A plain fs.writeFile follows that symlink. So:
//   - every path part from the home down to the file must be a real folder or a real file, never a
//     symlink, the home itself included. The folders above the home belong to the operator and
//     are not checked.
//   - a read opens the file with O_NOFOLLOW, so a symlink swapped in after the check is refused too.
//   - a write creates a new file next to the old one (O_EXCL, so the new name is never an existing
//     file or symlink), with the old file's mode and owner, then renames the new file into place.
//     A rename replaces the directory entry itself: a symlink at the name is replaced, never
//     followed, and a reader sees the old file or the new one, never half of either.
import { constants, promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export class SymlinkRefused extends Error {}

// Refuses a symlink at the home or at any path part below it, down to <file>. A missing part ends
// the check: nothing below it exists yet.
export async function assertNoSymlink(home: string, file: string): Promise<void> {
  const rel = relative(home, file);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new SymlinkRefused(`${file} is not inside the agent's home ${home}`);
  }
  let p = home;
  for (const part of ["", ...rel.split(sep)]) {
    if (part) p = join(p, part);
    let st;
    try {
      st = await fs.lstat(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    if (st.isSymbolicLink()) throw new SymlinkRefused(`${p} is a symlink, so nothing was written there`);
  }
}

// The text of <file> in <home>, read without following a symlink.
export async function readHomeFile(home: string, file: string): Promise<string> {
  await assertNoSymlink(home, file);
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw new SymlinkRefused(`${file} is a symlink, so it was not read`);
    throw e;
  }
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

// Replaces <file> in <home> with <text>: a new file, moved into place. The new file keeps the old
// file's mode and, where the api may set it, the old file's owner, so the agent's container can
// still read the file. With no old file, the mode is 0644.
export async function writeHomeFile(home: string, file: string, text: string): Promise<void> {
  await assertNoSymlink(home, file);
  let mode = 0o644, owner: { uid: number; gid: number } | null = null;
  try {
    const st = await fs.lstat(file);
    if (!st.isFile()) throw new SymlinkRefused(`${file} is not a regular file, so nothing was written there`);
    mode = st.mode & 0o777;
    owner = { uid: st.uid, gid: st.gid };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const temp = join(dirname(file), `.${randomBytes(6).toString("hex")}.cc-new`);
  const handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await handle.writeFile(text);
    if (owner) {
      // Only a privileged api can give the file to another account. Otherwise the file stays the
      // api's, as a plain write by the api would have left a new file.
      await handle.chown(owner.uid, owner.gid).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "EPERM") throw e;
      });
    }
    await handle.chmod(mode);
    await handle.sync();
  } catch (e) {
    await handle.close();
    await fs.rm(temp, { force: true });
    throw e;
  }
  await handle.close();
  try {
    // A folder swapped for a symlink since the first check would move the file elsewhere.
    await assertNoSymlink(home, file);
    await fs.rename(temp, file);
  } catch (e) {
    await fs.rm(temp, { force: true });
    throw e;
  }
}

// Creates a new agent's home, mode 0700 whatever the umask, so no other account on the computer can
// read the agent's secrets or write to the home. Hermes also refuses a home that another account
// can write to. The folders above the home are created as needed and keep their own modes. The
// home itself must not exist: a folder, file or symlink at the path is refused, and left as it is.
//
// Under Docker, the agent's container still gets the home: the Hermes image starts as root, gives
// the home to its own hermes user, then switches to that user. An OpenClaw container runs as root.
export async function createAgentHome(home: string): Promise<void> {
  await fs.mkdir(dirname(home), { recursive: true });
  await fs.mkdir(home, { mode: 0o700 });
  await fs.chmod(home, 0o700);
}
