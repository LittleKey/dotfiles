// personal-profile runtime — managed activation + rollback.
//
// ONE authority: <liveRoot>/.oprofile/active.json. Activation copies managed
// files from a verified stage into the live config root, each via temp+rename
// (fresh inode — hard-link twins of previously linked files keep their old
// bytes and keep working; that is the intended link-safe behavior). Bytes of
// every replaced file are backed up first. Rollback consumes exactly the
// authority record and restores pre-activation bytes.
//
// HONEST LIMITS (documented in every manifest):
// - Atomic per file, NOT transactional across files. Any handled failure
//   during apply triggers automatic rollback of already-applied files; power
//   loss between two file commits is NOT covered.
// - Conflicts refuse before the first write: unmanaged file already at a
//   managed path with different bytes, symlink at a managed path, or an
//   active authority for a different stage without --replace.
// - Unrelated files in the live root are never touched.
//
// Candidate integrity gate: BEFORE any write (plan time, which activate runs
// first) every managed file in the candidate is hash-verified against its
// manifest record (staged-bytes sha256, falling back to the pinned source
// sha256 for verbatim copies). A dirty or incomplete stage refuses with
// nothing written. Manifest paths that escape the config root are refused.
//
// Legacy plugin-twin guard: the stock host auto-discovers BOTH `plugin/` and
// `plugins/` roots. If the live root still holds an old canonical artifact at
// `plugin/<same relative path>` for a managed `plugins/<...>` file,
// activation REFUSES (nothing written) instead of silently leaving two
// auto-discovered copies of the same plugin. This lane never deletes
// unmanaged files — the owner performs the backed handover (back up + remove
// or rename the old artifact), then re-runs activation.
//
// File modes: every stage manifest record carries the staged file's own
// mode. Activation verifies the candidate's actual mode against that record
// (a drifted stage refuses before any write) and installs the actual mode —
// a recorded executable payload lands executable, a recorded 0600 private
// config lands 0600, never a silent 0755→0644. Replacements keep the
// existing file's mode only when the record has no mode (older manifests);
// the backup of a replaced file always keeps that file's own mode.
// Rollback restores the recorded modeBefore — the pre-activation mode,
// distinct from the after-mode — falling back to the record's mode and then
// the live file's current mode for older records.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { readStageManifest, readActiveAuthority, writeActiveAuthority, removeActiveAuthority } from "./manifest.mjs";
import { atomicWriteFileSync, isSymlinkPath } from "./atomic.mjs";
import { sha256, sha256File } from "./hash.mjs";

function managedFiles(manifest) {
  return manifest.files.filter((f) => f.path !== ".oprofile/profile-manifest.json");
}

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(p));
    else if (entry.isFile()) out.push(p);
  }
  return out.sort();
}

/** Numeric mode for a write, from an optional manifest record mode string. */
function recordModeValue(mode) {
  if (typeof mode !== "string" || !/^[0-7]{3,4}$/.test(mode)) return undefined;
  return parseInt(mode, 8) & 0o7777;
}

/** Canonical 4-digit octal string for a numeric permission mode ("0755"). */
function octalMode(mode) {
  return `${(mode & 0o777).toString(8).padStart(4, "0")}`;
}

/** Mode to use when rewriting an existing file: keep its own (never widen). */
function existingMode(absPath) {
  try {
    return statSync(absPath).mode & 0o777;
  } catch {
    return undefined;
  }
}

/**
 * Verify the candidate on disk against the staged manifest, BEFORE any write.
 * Returns a list of problems (empty = clean). Every managed file must exist
 * in the candidate and hash-match its pinned staged-bytes sha256 (verbatim
 * copies fall back to the pinned source sha256, which their staged bytes
 * equal by construction).
 */
export function verifyCandidateAgainstManifest(candidateDir, manifest) {
  const problems = [];
  for (const f of managedFiles(manifest)) {
    const relName = f.path;
    if (typeof f.path !== "string" || f.path.startsWith("/") || f.path.split("/").includes("..")) {
      problems.push(`${relName}: manifest path escapes the config root — refusing`);
      continue;
    }
    const expected = f.sha256 ?? f.sourceSha256;
    if (!expected) {
      problems.push(`${relName}: manifest record has no pinned hash — refusing`);
      continue;
    }
    const candAbs = join(candidateDir, ...f.path.split("/"));
    let candStat;
    try {
      candStat = statSync(candAbs);
    } catch {
      candStat = null;
    }
    if (!candStat || !candStat.isFile()) {
      problems.push(`${relName}: candidate file missing — stage is incomplete or a component is unavailable`);
      continue;
    }
    const actual = sha256File(candAbs);
    if (actual !== expected) {
      problems.push(`${relName}: candidate bytes do not match the manifest (${actual} ≠ ${expected}) — stage is dirty`);
    }
    // Mode gate: a record that pins a mode must match the candidate's actual
    // permission bits exactly — an executable payload whose bits were lost
    // (or a private config widened) between staging and activation refuses
    // here, before any live write. Records without a mode (older manifests)
    // keep bytes-only verification.
    if (typeof f.mode === "string" && /^[0-7]{3,4}$/.test(f.mode) && (candStat.mode & 0o777) !== (recordModeValue(f.mode) & 0o777)) {
      problems.push(`${relName}: candidate mode ${octalMode(candStat.mode)} does not match manifest mode ${f.mode} — stage is dirty`);
    }
  }
  return problems;
}

export function planActivation({ candidateDir, liveRoot, replace = false }) {
  const { manifest, path: manifestPath } = readStageManifest(candidateDir);
  const existing = readActiveAuthority(liveRoot);
  const plan = { manifestPath, flavor: manifest.flavor, actions: [], conflicts: [], notes: [] };
  // --replace intentionally skips ONLY the different-stage refusal below.
  // Every per-file guard in this plan (unmanaged or edited provenance,
  // symlinks, legacy plugin twins) still refuses — replace never overrides
  // those.
  if (existing && !replace && !existing.record.adopted && existing.record.stage.manifestSha256 !== manifestAuthoritySha(manifestPath)) {
    plan.conflicts.push(`live root already managed by a different stage: ${existing.record.stage.candidateDir} — roll back first or pass --replace`);
  }
  // Integrity gate first: a dirty or incomplete candidate refuses before any
  // live-root inspection or write happens.
  for (const problem of verifyCandidateAgainstManifest(candidateDir, manifest)) {
    plan.conflicts.push(problem);
  }
  for (const f of managedFiles(manifest)) {
    const dest = join(liveRoot, ...f.path.split("/"));
    const relName = f.path;
    if (typeof f.path !== "string" || f.path.startsWith("/") || f.path.split("/").includes("..")) {
      plan.conflicts.push(`${relName}: manifest path escapes the config root — refusing`);
      continue;
    }
    // Legacy auto-discovered twin (plugin/ vs plugins/) — see header. The
    // owner performs the backed handover; this lane never deletes unmanaged
    // files and never activates a double-loaded plugin silently.
    const segs = f.path.split("/");
    if (segs[0] === "plugins" && segs.length > 1) {
      const legacyAbs = join(liveRoot, "plugin", ...segs.slice(1));
      if (existsSync(legacyAbs)) {
        plan.conflicts.push(
          `${relName}: live root still has the legacy auto-discovered twin plugin/${segs.slice(1).join("/")} — activating would load this plugin twice. Owner handover required: back up, then remove or rename the old canonical artifact (this lane never deletes unmanaged files), then re-run activation`
        );
        continue;
      }
    }
    if (isSymlinkPath(dest)) {
      plan.conflicts.push(`${relName}: managed path is a symlink — refusing (link topology is owner-owned)`);
      continue;
    }
    if (!existsSync(dest)) {
      plan.actions.push({ path: relName, action: "create" });
      continue;
    }
    if (!statSync(dest).isFile()) {
      plan.conflicts.push(`${relName}: managed path exists and is not a file`);
      continue;
    }
    if (!existing) {
      plan.conflicts.push(`${relName}: unmanaged existing file with different provenance — refusing to overwrite without an authority record`);
      continue;
    }
    const prior = existing.record.files.find((x) => x.path === relName);
    if (!prior) {
      plan.conflicts.push(`${relName}: exists but is not managed by the current authority — refusing`);
      continue;
    }
    plan.actions.push({ path: relName, action: "replace" });
  }
  plan.ok = plan.conflicts.length === 0 && plan.actions.length > 0;
  return plan;
}

function manifestAuthoritySha(manifestPath) {
  return sha256File(manifestPath);
}

/**
 * Managed update of liveRoot from a staged candidate.
 * After a handled failure every applied file is rolled back before throwing.
 */
export function activate({ candidateDir, liveRoot, replace = false }) {
  const { manifest, path: manifestPath } = readStageManifest(candidateDir);
  const manifestSha = manifestAuthoritySha(manifestPath);
  const existing = readActiveAuthority(liveRoot);
  if (existing && !replace && !existing.record.adopted) {
    if (existing.record.stage.manifestSha256 !== manifestSha) {
      const err = new Error(`live root is managed by a different stage (${existing.record.stage.candidateDir}); roll back first or pass --replace`);
      err.code = 2;
      throw err;
    }
  }

  // preflight conflicts — refuse before the first write
  const plan = planActivation({ candidateDir, liveRoot, replace });
  if (plan.conflicts.length > 0) {
    const err = new Error(`activation refused (nothing written):\n${plan.conflicts.map((c) => `  - ${c}`).join("\n")}`);
    err.code = 2;
    throw err;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = join(liveRoot, ".oprofile", "backup", stamp);
  const applied = [];
  const record = {
    schemaVersion: 1,
    lane: "personal-profile",
    kind: "active-authority",
    activatedAt: new Date().toISOString(),
    stage: { candidateDir, manifestSha256: manifestSha, flavor: manifest.flavor },
    backupsRoot: backupRoot,
    files: [],
    limits: manifest.limits,
  };

  const rollbackApplied = (reason) => {
    const problems = [];
    for (const entry of applied.slice().reverse()) {
      try {
        const dest = join(liveRoot, ...entry.path.split("/"));
        if (entry.action === "create") {
          rmSync(dest);
        } else {
          // Restore the pre-activation mode first (modeBefore); older
          // in-flight entries without it fall back to the record mode, then
          // to the live file's current mode.
          const mode = recordModeValue(entry.modeBefore) ?? recordModeValue(entry.mode) ?? existingMode(dest);
          atomicWriteFileSync(dest, readFileSync(entry.backup), mode);
        }
      } catch (e) {
        problems.push(`${entry.path}: ${e.message}`);
      }
    }
    try {
      if (existing) writeActiveAuthority(liveRoot, existing.record);
      else removeActiveAuthority(liveRoot);
    } catch (e) {
      problems.push(`previous authority restore: ${e.message}`);
    }
    const err = new Error(
      `activation failed (${reason}); rolled back ${applied.length} applied file(s)` +
        (problems.length ? `; rollback problems: ${problems.join("; ")}` : "")
    );
    err.code = 2;
    err.rolledBack = applied.length;
    err.rollbackProblems = problems;
    throw err;
  };

  try {
    for (const f of managedFiles(manifest)) {
      const dest = join(liveRoot, ...f.path.split("/"));
      const action = existsSync(dest) ? "replace" : "create";
      let backup = null;
      let shaBefore = null;
      let modeBefore = null;
      let writeMode = recordModeValue(f.mode);
      if (action === "replace") {
        // Back up the replaced state faithfully — old bytes AND old mode —
        // then install the record's actual mode; only a record without a
        // mode (older manifests) keeps the file's existing mode (never
        // widened by a modeless rewrite).
        const oldMode = existingMode(dest);
        modeBefore = oldMode === undefined ? null : octalMode(oldMode);
        shaBefore = sha256File(dest);
        backup = join(backupRoot, ...f.path.split("/"));
        mkdirSync(dirname(backup), { recursive: true });
        atomicWriteFileSync(backup, readFileSync(dest), oldMode);
        writeMode = writeMode ?? oldMode;
      }
      mkdirSync(dirname(dest), { recursive: true });
      atomicWriteFileSync(dest, readFileSync(join(candidateDir, ...f.path.split("/"))), writeMode);
      applied.push({ path: f.path, action, backup, mode: f.mode ?? null, modeBefore });
      record.files.push({
        path: f.path,
        action,
        sha256Before: shaBefore,
        sha256After: sha256File(dest),
        backup: action === "replace" ? backup : null,
        mode: f.mode ?? null,
        modeBefore,
      });
    }
    // authority record last — it is the commit point, INSIDE the protected
    // apply: a failure here is caught like any other, so a caught rollback
    // restores every applied file AND the previous authority. A failed
    // activation can never leave the new files installed under the old
    // adopted authority.
    writeActiveAuthority(liveRoot, record);
  } catch (err) {
    rollbackApplied(err.message);
  }
  return record;
}

/**
 * Adopt current live bytes as the baseline authority WITHOUT changing any
 * file. This is the honest way to start managing an existing deployment:
 * afterwards, `activate` can replace managed paths and `rollback` can restore
 * these exact bytes.
 */
export function adopt({ liveRoot, managedPaths }) {
  if (readActiveAuthority(liveRoot)) {
    const err = new Error("live root is already managed — adopt is only for unmanaged roots");
    err.code = 2;
    throw err;
  }
  const record = {
    schemaVersion: 1,
    lane: "personal-profile",
    kind: "active-authority",
    adoptedAt: new Date().toISOString(),
    adopted: true,
    stage: { candidateDir: null, manifestSha256: null, flavor: null },
    backupsRoot: null,
    files: [],
    limits: {
      adoption: "adopt records bytes only; no file is modified",
      activation: "activate is atomic per file (temp+rename), not transactional across files; handled failures roll back; power loss is not covered",
    },
  };
  for (const rel of managedPaths) {
    const dest = join(liveRoot, ...rel.split("/"));
    if (isSymlinkPath(dest)) {
      const err = new Error(`adopt refused: ${rel} is a symlink (link topology is owner-owned)`);
      err.code = 2;
      throw err;
    }
    if (!existsSync(dest)) continue;
    const backup = join(liveRoot, ".oprofile", "backup", "adopt", ...rel.split("/"));
    mkdirSync(dirname(backup), { recursive: true });
    // Preserve the adopted file's own mode on the backup — an adopted 0600
    // private config must not become a 0644 copy.
    atomicWriteFileSync(backup, readFileSync(dest), existingMode(dest));
    record.files.push({
      path: rel,
      action: "adopt",
      sha256Before: sha256File(dest),
      sha256After: sha256File(dest),
      backup,
    });
  }
  writeActiveAuthority(liveRoot, record);
  return record;
}

/**
 * Rollback to pre-activation bytes using exactly the authority record.
 * Blocked entries (live bytes differ from the recorded after-state) are
 * reported, never silently overwritten; the authority record is kept so the
 * situation stays reconcilable.
 */
export function rollback({ liveRoot }) {
  const existing = readActiveAuthority(liveRoot);
  if (!existing) {
    const err = new Error(`no active authority at ${join(liveRoot, ".oprofile", "active.json")} — nothing to roll back`);
    err.code = 4;
    throw err;
  }
  const rec = existing.record;
  const restored = [];
  const blocked = [];
  for (const entry of rec.files.slice().reverse()) {
    const dest = join(liveRoot, ...entry.path.split("/"));
    if (!existsSync(dest)) {
      if (entry.action === "create") { restored.push(entry.path); continue; }
      blocked.push(`${entry.path}: managed file disappeared since activation`);
      continue;
    }
    const current = sha256File(dest);
    if (current !== entry.sha256After) {
      blocked.push(`${entry.path}: live bytes changed since activation (${current}) — not touching`);
      continue;
    }
    if (entry.action === "create") {
      rmSync(dest);
    } else {
      // Restore with the recorded PRE-activation mode (modeBefore — distinct
      // from the after-mode, e.g. a 0640→0600 replacement rolls back to
      // 0640). Fall back to the record mode and then the live file's current
      // mode for older records without modeBefore.
      const mode = recordModeValue(entry.modeBefore) ?? recordModeValue(entry.mode) ?? existingMode(dest);
      atomicWriteFileSync(dest, readFileSync(entry.backup), mode);
    }
    restored.push(entry.path);
  }
  let authorityKept = null;
  if (blocked.length === 0) {
    authorityKept = removeActiveAuthority(liveRoot) === null ? "was absent" : "removed";
  } else {
    authorityKept = "kept (blocked entries need reconciliation)";
  }
  return { restored, blocked, authorityKept, backupsRoot: rec.backupsRoot };
}
