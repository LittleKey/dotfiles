// personal-profile runtime — manifest records.
//
// TWO records, ONE authority chain:
// - stage manifest  <candidate>/.oprofile/profile-manifest.json
//     Written at stage time. Exact bytes: every staged file with sha256,
//     source and source sha256; component statuses; host probe result;
//     launcher env template. This is the release's single source of truth.
// - active authority <liveRoot>/.oprofile/active.json
//     Written ONLY by `oprofile activate`. Records per managed file:
//     action, bytes before/after (sha256), backup location. Rollback consumes
//     exactly this record. Absent record = nothing managed; activation on top
//     of an existing record for a DIFFERENT stage is refused (re-rollback or
//     explicit --replace first).

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "./atomic.mjs";

export const STAGE_MANIFEST_REL = ".oprofile/profile-manifest.json";
export const ACTIVE_AUTHORITY_REL = ".oprofile/active.json";

export function writeStageManifest(candidateDir, manifest) {
  const path = join(candidateDir, STAGE_MANIFEST_REL);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  return path;
}

export function readStageManifest(candidateDir) {
  const path = join(candidateDir, STAGE_MANIFEST_REL);
  if (!existsSync(path)) {
    const err = new Error(`no stage manifest at ${path} — not a managed candidate`);
    err.code = 4;
    throw err;
  }
  return { manifest: JSON.parse(readFileSync(path, "utf8")), path };
}

export function activeAuthorityPath(liveRoot) {
  return join(liveRoot, ACTIVE_AUTHORITY_REL);
}

export function readActiveAuthority(liveRoot) {
  const path = activeAuthorityPath(liveRoot);
  if (!existsSync(path)) return null;
  return { record: JSON.parse(readFileSync(path, "utf8")), path };
}

export function writeActiveAuthority(liveRoot, record) {
  const path = activeAuthorityPath(liveRoot);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(record, null, 2) + "\n");
  return path;
}

export function removeActiveAuthority(liveRoot) {
  const path = activeAuthorityPath(liveRoot);
  if (!existsSync(path)) return null;
  // Keep a forensic copy; the live authority itself is removed.
  const kept = path + ".removed-" + new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(kept, readFileSync(path));
  rmSync(path);
  return kept;
}
