// personal-profile runtime — hashing helpers.
// Part of the dotfiles personal-profile lane (opencode/runtime). Generic
// installer logic stays in opencode-bcp/document-writer; this is lane glue.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function sha256File(absPath) {
  return sha256(readFileSync(absPath));
}
