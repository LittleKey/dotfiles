// personal-profile runtime — explicit artifact inputs.
//
// profile.json is the ONE input authority for this lane. Every declared input
// pins: an absolute source path (outside /tmp), the expected sha256 (files) or
// per-file sha256 inventory (directories), and why it exists. `loadProfile`
// verifies every required input against disk BEFORE any staging write and
// refuses missing/invalid inputs (exit code 2 semantics at the CLI boundary) —
// the lane never fabricates a release from partial inputs.

import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { sha256File } from "./hash.mjs";

export class RefusalError extends Error {
  constructor(report) {
    super(`input refusals (nothing was staged):\n${report.map((l) => `  - ${l}`).join("\n")}`);
    this.name = "RefusalError";
    this.report = report;
    this.code = 2;
  }
}

export function loadProfile(profilePath) {
  if (!existsSync(profilePath)) {
    throw new RefusalError([`profile authority not found: ${profilePath}`]);
  }
  let profile;
  try {
    profile = JSON.parse(readFileSync(profilePath, "utf8"));
  } catch (err) {
    throw new RefusalError([`profile authority is not valid JSON: ${profilePath} (${err.message})`]);
  }
  if (profile.schemaVersion !== 1) {
    throw new RefusalError([`unsupported profile schemaVersion ${profile.schemaVersion} in ${profilePath}`]);
  }
  return { profile, profilePath, profileSha256: sha256File(profilePath) };
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

/**
 * Verify one input record against disk.
 * kind "file":     { source, sha256 }
 * kind "dir":      { source, files: { "<relpath>": sha256, ... } }
 * kind "explicit": caller-provided artifact; verified only when supplied
 *                  (see verifyExplicit below).
 * Returns a normalized record; collects refusals instead of throwing per item.
 */
export function verifyInput(name, input, report) {
  if (input.kind === "explicit") return { name, ...input, resolved: null };
  const source = input.source;
  if (!source || !existsSync(source)) {
    report.push(`input ${name}: source missing: ${JSON.stringify(source ?? null)}`);
    return null;
  }
  const st = statSync(source);
  if (input.kind === "file") {
    if (!st.isFile()) {
      report.push(`input ${name}: expected a file at ${source}`);
      return null;
    }
    const actual = sha256File(source);
    if (actual !== input.sha256) {
      report.push(`input ${name}: sha256 mismatch for ${source} (expected ${input.sha256}, found ${actual}); run \`oprofile pin\` if the change is intentional`);
      return null;
    }
    return { name, ...input, resolved: { path: source, sha256: actual } };
  }
  if (input.kind === "dir") {
    if (!st.isDirectory()) {
      report.push(`input ${name}: expected a directory at ${source}`);
      return null;
    }
    const actualFiles = {};
    for (const abs of listFilesRecursive(source)) {
      actualFiles[relative(source, abs).split(sep).join("/")] = sha256File(abs);
    }
    const expected = input.files ?? {};
    const missing = Object.keys(expected).filter((k) => !(k in actualFiles));
    const extra = Object.keys(actualFiles).filter((k) => !(k in expected));
    const drifted = Object.keys(expected).filter((k) => k in actualFiles && actualFiles[k] !== expected[k]);
    for (const m of missing) report.push(`input ${name}: pinned file missing: ${m}`);
    for (const e of extra) report.push(`input ${name}: unpinned file present (refusing): ${e} — re-pin with \`oprofile pin\``);
    for (const d of drifted) report.push(`input ${name}: pinned file changed: ${d} — re-pin with \`oprofile pin\` if intentional`);
    if (missing.length || extra.length || drifted.length) return null;
    return { name, ...input, resolved: { path: source, files: actualFiles } };
  }
  report.push(`input ${name}: unknown kind ${JSON.stringify(input.kind)}`);
  return null;
}

/** Verify all inputs; throws RefusalError when anything is unresolved. */
export function verifyAllInputs(profile) {
  const report = [];
  const resolved = {};
  for (const [name, input] of Object.entries(profile.inputs ?? {})) {
    const r = verifyInput(name, input, report);
    if (r) resolved[name] = r;
  }
  if (report.length > 0) throw new RefusalError(report);
  return resolved;
}

/**
 * Explicit artifact supplied on the command line (--component <name>=<path>).
 * kind "artifact-file": must be a file, sha recorded (compared to expectedSha256
 *                       when the profile pins one).
 * kind "artifact-dir":  must be a directory, recursively copied; sha recorded
 *                       per file; entry must exist inside it.
 */
export function verifyExplicit(name, input, suppliedPath, report) {
  if (!suppliedPath) {
    if (input.required === "always") report.push(`component ${name}: required explicit artifact was not provided (${input.provideFlag ?? "--component " + name + "=<path>"})`);
    return { name, staged: false, status: input.required === "always" ? "refused" : "absent-explicit" };
  }
  if (!existsSync(suppliedPath)) {
    report.push(`component ${name}: supplied artifact does not exist: ${suppliedPath}`);
    return { name, staged: false, status: "refused" };
  }
  const st = statSync(suppliedPath);
  if (input.kind === "artifact-file") {
    if (!st.isFile()) {
      report.push(`component ${name}: expected a file artifact, got directory: ${suppliedPath}`);
      return { name, staged: false, status: "refused" };
    }
    const sha = sha256File(suppliedPath);
    if (input.expectedSha256 && sha !== input.expectedSha256) {
      report.push(`component ${name}: artifact sha mismatch (expected ${input.expectedSha256}, found ${sha})`);
      return { name, staged: false, status: "refused", foundSha256: sha };
    }
    return { name, staged: true, status: input.acceptance === "deferred" ? "staged-unverified" : "staged", kind: "file", source: suppliedPath, sha256: sha };
  }
  if (input.kind === "artifact-dir") {
    if (!st.isDirectory()) {
      report.push(`component ${name}: expected a directory artifact, got file: ${suppliedPath}`);
      return { name, staged: false, status: "refused" };
    }
    const entryRel = input.entry;
    if (!entryRel || !existsSync(join(suppliedPath, ...entryRel.split("/")))) {
      report.push(`component ${name}: entry ${JSON.stringify(entryRel)} not found inside artifact dir ${suppliedPath}`);
      return { name, staged: false, status: "refused" };
    }
    const files = {};
    for (const abs of listFilesRecursive(suppliedPath)) files[relative(suppliedPath, abs).split(sep).join("/")] = sha256File(abs);
    const entrySha = files[entryRel];
    const testedRef = input.testedEntrySha256 ?? input.expectedEntrySha256;
    if (testedRef && entrySha !== testedRef) {
      // recorded, not refused: the owner may rebuild the plugin; the stage
      // manifest records exactly what was staged and verify reports the delta
      // against the tested reference build.
      return { name, staged: true, status: "staged-differs-from-tested", kind: "dir", source: suppliedPath, entry: entryRel, entrySha256: entrySha, testedEntrySha256: testedRef, files };
    }
    return { name, staged: true, status: "staged", kind: "dir", source: suppliedPath, entry: entryRel, entrySha256: entrySha, files };
  }
  report.push(`component ${name}: unknown artifact kind ${JSON.stringify(input.kind)}`);
  return { name, staged: false, status: "refused" };
}
