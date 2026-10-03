// personal-profile runtime — atomic, link-safe writes.
//
// The live deployment hard-links global and dotfiles copies of opencode.json /
// oh-my-opencode-slim.json (link count 2) and the global prompt directory is a
// symlink into dotfiles. Every write is therefore computed in full first,
// written to a same-directory temp file, and committed with rename(), which
// replaces the directory entry with a fresh inode instead of writing through
// existing links. Managed paths that are symlinks are never rewritten; callers
// must treat them as conflicts. (Same discipline as the document-writer
// installer; reimplemented here so the dotfiles release is self-contained.)

import { writeFileSync, renameSync, rmSync, lstatSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * Atomic write with an optional explicit mode. When mode is given, the temp
 * file is CREATED with that mode (the mode is applied by the opening write()
 * itself, so a private 0600 temp file never briefly exists with wider
 * permissions), and is then explicitly chmod'd before rename, so the
 * committed inode's mode is exact regardless of umask — umask can only remove
 * bits at creation time, so the chmod is what guarantees requested bits like
 * executable bits survive, while creation-time mode is what guarantees
 * private files are never readable in between. Without a mode the platform
 * default applies (unchanged historical behavior).
 */
export function atomicWriteFileSync(absPath, data, mode = undefined) {
  const tmp = `${absPath}.oprofile-tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, absPath);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

/** True when the path exists AND is a symlink (does not follow the link). */
export function isSymlinkPath(absPath) {
  try { return lstatSync(absPath).isSymbolicLink(); } catch { return false; }
}
