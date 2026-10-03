// install-modes tests — the release-gate properties this remediation pass
// pins down (node:test, offline, no host/model requests, no production
// writes; everything lives in a mkdtemp sandbox):
//
//  1. stage records every copied file's OWN permission mode in the manifest
//     (executable payloads like packaged native CLI binaries must not lose
//     their bits between staging and the live root; no silent 0755→0644)
//  2. activation VERIFIES the candidate's mode against the manifest — not
//     bytes only; records without a mode (older manifests) stay bytes-only
//  3. activation INSTALLS the recorded mode: a created 0755 file lands 0755,
//     a replacement restores a degraded exec bit
//  4. atomicWriteFileSync creates private temp files restrictive FROM
//     CREATION (the write-then-chmod window is gone) while the pre-rename
//     chmod still pins the exact final mode under restrictive umasks;
//     optional-mode calls keep the platform default (compat)
//  5. planActivation honors replace:true for the different-stage refusal but
//     STILL refuses unmanaged files; activation enforces the same
//  6. an authority-commit failure inside the protected apply rolls back
//     every applied file AND restores the previous authority — a failed
//     activation can never leave new files under the old adopted authority
//  7. rollback restores the PRE-activation mode (modeBefore, distinct from
//     the after-mode); old records without modeBefore keep their fallback
//
// Run (bounded):
//   node --test --experimental-test-module-mocks test/install-modes.test.mjs
//
// The module-mocks flag installs a RECORDING PASS-THROUGH over the real fs:
// every function is the real implementation, writeFileSync/renameSync merely
// record their call arguments (creation-time modes) and renameSync can be
// hooked ONCE (in the dedicated failure test) to inject a single failure at
// the authority commit path. No outcome is ever faked.

import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME = dirname(dirname(fileURLToPath(import.meta.url))); // .../opencode/runtime

let S; // sandbox root
let OLD_UMASK;
let libs; // lib modules — imported AFTER the recording fs facade is installed
let calls; // recorded fs calls
let hooks; // injection hooks for the recording facade

before(async () => {
  S = mkdtempSync(join(tmpdir(), "opl-install-modes-"));
  OLD_UMASK = process.umask(0o022); // deterministic default for every test

  // Recording pass-through facade over the REAL fs. Only writeFileSync and
  // renameSync are wrapped; every other export is the untouched original.
  calls = { writeFileSync: [], renameSync: [] };
  hooks = { renameSync: null };
  const wrapped = { ...fs };
  wrapped.writeFileSync = function (file, data, options) {
    calls.writeFileSync.push({ path: String(file), mode: options === undefined ? undefined : options?.mode });
    return fs.writeFileSync(file, data, options);
  };
  wrapped.renameSync = function (from, to) {
    calls.renameSync.push({ from: String(from), to: String(to) });
    if (hooks.renameSync) return hooks.renameSync((a, b) => fs.renameSync(a, b), String(from), String(to));
    return fs.renameSync(from, to);
  };
  wrapped.default = wrapped;
  mock.module("node:fs", { namedExports: wrapped });

  // lib modules must resolve their node:fs bindings AFTER the facade install
  libs = {
    atomic: await import("../lib/atomic.mjs"),
    activate: await import("../lib/activate.mjs"),
    stage: await import("../lib/stage.mjs"),
    manifest: await import("../lib/manifest.mjs"),
    inputs: await import("../lib/inputs.mjs"),
    hash: await import("../lib/hash.mjs"),
  };
});

after(() => {
  process.umask(OLD_UMASK);
  if (S) rmSync(S, { recursive: true, force: true });
});

const octal = (m) => `${(m & 0o777).toString(8).padStart(4, "0")}`;
const modeOf = (p) => octal(statSync(p).mode);

// Build a synthetic candidate with real staged bytes and a manifest whose
// records pin exactly what is on disk (sourceSha256 = staged bytes' sha, so
// the integrity gate passes; source paths point at an untracked dir).
function buildCandidate(name, filesSpec) {
  const cand = join(S, name);
  for (const f of filesSpec) {
    const abs = join(cand, ...f.path.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.bytes);
    if (f.mode !== undefined) chmodSync(abs, f.mode);
  }
  const manifest = {
    schemaVersion: 1,
    lane: "personal-profile",
    flavor: "v2",
    files: filesSpec.map((f) => ({
      path: f.path,
      action: "create",
      source: join(S, "untracked-src", f.path),
      sourceSha256: libs.hash.sha256File(join(cand, ...f.path.split("/"))),
      ...(f.mode === undefined ? {} : { mode: octal(f.mode) }),
    })),
    limits: {},
  };
  mkdirSync(join(cand, ".oprofile"), { recursive: true });
  writeFileSync(join(cand, ".oprofile", "profile-manifest.json"), JSON.stringify(manifest, null, 2));
  return { cand, manifest };
}

const V2_HOST = { flavor: "v2", version: "2.0.20", executable: "test://exe", runtimeTested: "2.0.20", minCompatible: "2.0.20" };

// Fake omoPlugin artifact with an EXECUTABLE payload, mirroring the packaged
// native CLI binaries in the real v1 stage (bin/ + entry).
function fakeOmoArtifact(name) {
  const artifact = join(S, name);
  mkdirSync(join(artifact, "server", "dist", "server"), { recursive: true });
  mkdirSync(join(artifact, "bin"), { recursive: true });
  writeFileSync(join(artifact, "omo-council.mjs"), "export const council = true;\n");
  writeFileSync(join(artifact, "omo-delivery.mjs"), "export const delivery = true;\n");
  writeFileSync(join(artifact, "server", "dist", "server", "index.js"), 'import { council } from "../../../omo-council.mjs";\nexport default { id: "oh-my-opencode-slim" };\n');
  writeFileSync(join(artifact, "bin", "native-tool"), "#!/bin/sh\necho fake-native\n");
  chmodSync(join(artifact, "bin", "native-tool"), 0o755);
  return artifact;
}

test("stage records every copied file's own mode in the manifest, and activation installs it (exec 0755 lands 0755)", () => {
  const { profile, profilePath, profileSha256 } = libs.inputs.loadProfile(join(RUNTIME, "profile.json"));
  const outDir = join(S, "stage-out");
  mkdirSync(outDir, { recursive: true });
  const result = libs.stage.stage({
    flavor: "v2", profile, profilePath, profileSha256, host: V2_HOST,
    outDir, explicit: { omoPlugin: fakeOmoArtifact("omo-fake-t1") },
  });
  const cand = result.candidateDir;
  const { manifest } = libs.manifest.readStageManifest(cand);

  // the executable payload is recorded with its own staged mode
  const toolRel = "plugins/omoPlugin/bin/native-tool";
  const tool = manifest.files.find((f) => f.path === toolRel);
  assert.ok(tool, "exec payload present in the manifest");
  assert.equal(tool.mode, "0755", `exec payload mode must be recorded (staged stat: ${modeOf(join(cand, ...toolRel.split("/")))})`);
  assert.equal(modeOf(join(cand, ...toolRel.split("/"))), "0755", "the staged copy itself keeps the exec bits");

  // plain copies, the shim and the rendered config all carry modes too
  assert.equal(manifest.files.find((f) => f.path === "plugins/omoPlugin/omo-council.mjs").mode, "0644");
  assert.equal(manifest.files.find((f) => f.path === "plugins/omoPlugin/index.js").mode, "0644", "the re-export shim records its mode");
  const cfg = manifest.files.find((f) => f.path === "opencode.json");
  assert.equal(cfg.mode, "0600", "rendered config records 0600 even on probe stages");
  assert.equal(modeOf(join(cand, "opencode.json")), "0600");

  // EVERY managed record carries a valid mode equal to the staged file's
  // actual mode — no copied category left out
  for (const f of manifest.files) {
    assert.ok(typeof f.mode === "string" && /^[0-7]{3,4}$/.test(f.mode), `${f.path} must record its staged mode`);
    assert.equal(f.mode, modeOf(join(cand, ...f.path.split("/"))), `${f.path} recorded mode must equal the staged file's actual mode`);
  }

  // end-to-end: the recorded mode is what lands at the live root
  const live = join(S, "live-t1");
  mkdirSync(live, { recursive: true });
  const plan = libs.activate.planActivation({ candidateDir: cand, liveRoot: live });
  assert.deepEqual(plan.conflicts, [], JSON.stringify(plan.conflicts));
  const rec = libs.activate.activate({ candidateDir: cand, liveRoot: live });
  assert.equal(modeOf(join(live, ...toolRel.split("/"))), "0755", "created exec payload must land executable — never a silent 0755→0644");
  assert.equal(modeOf(join(live, "opencode.json")), "0600", "created private config lands 0600");
  assert.equal(rec.files.find((f) => f.path === toolRel).mode, "0755");
});

test("activation verifies candidate MODE against the manifest — a drifted stage refuses before any write; modeless records stay bytes-only", () => {
  const { cand, manifest } = buildCandidate("vf-cand", [
    { path: "tools/native", bytes: "#!/bin/sh\n", mode: 0o755 },
    { path: "a.md", bytes: "A\n", mode: 0o644 },
  ]);
  assert.deepEqual(libs.activate.verifyCandidateAgainstManifest(cand, manifest), []);

  chmodSync(join(cand, "tools", "native"), 0o644);
  const problems = libs.activate.verifyCandidateAgainstManifest(cand, manifest);
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.match(problems[0], /tools\/native: candidate mode 0644 does not match manifest mode 0755/);

  // old-style records WITHOUT a mode keep bytes-only verification (compat)
  const oldManifest = { ...manifest, files: manifest.files.map(({ mode, ...rest }) => rest) };
  chmodSync(join(cand, "tools", "native"), 0o600);
  assert.deepEqual(libs.activate.verifyCandidateAgainstManifest(cand, oldManifest), [], "modeless records must not invent a mode gate");
});

test("activation installs the recorded mode: created 0755 lands 0755, and a replacement restores a degraded exec bit", () => {
  const live = join(S, "live-t3");
  mkdirSync(live, { recursive: true });
  const { cand } = buildCandidate("im-cand-a", [
    { path: "tools/native", bytes: "#!/bin/sh\necho a\n", mode: 0o755 },
    { path: "a.md", bytes: "A\n", mode: 0o640 },
  ]);
  const plan = libs.activate.planActivation({ candidateDir: cand, liveRoot: live });
  assert.deepEqual(plan.conflicts, [], JSON.stringify(plan.conflicts));
  libs.activate.activate({ candidateDir: cand, liveRoot: live });
  assert.equal(modeOf(join(live, "tools", "native")), "0755", "created exec file must land executable (was: silent 0644)");
  assert.equal(modeOf(join(live, "a.md")), "0640", "created file lands with its recorded mode");

  // live payload degraded to 0644 (the legacy broken-install state): the
  // record's 0755 wins on replacement
  chmodSync(join(live, "tools", "native"), 0o644);
  const { cand: candB } = buildCandidate("im-cand-b", [
    { path: "tools/native", bytes: "#!/bin/sh\necho b\n", mode: 0o755 },
    { path: "a.md", bytes: "A\n", mode: 0o640 },
  ]);
  libs.activate.activate({ candidateDir: candB, liveRoot: live, replace: true });
  assert.equal(modeOf(join(live, "tools", "native")), "0755", "replacement must install the recorded mode, not keep the degraded 0644");
  assert.equal(readFileSync(join(live, "tools", "native"), "utf8"), "#!/bin/sh\necho b\n");
});

test("atomicWriteFileSync creates the private temp WITH its mode (no write-then-chmod window) and still pins the exact final mode", () => {
  const target = join(S, "priv", "config.json");
  mkdirSync(dirname(target), { recursive: true });
  calls.writeFileSync.length = 0;
  libs.atomic.atomicWriteFileSync(target, "{}\n", 0o600);
  const tmpCalls = calls.writeFileSync.filter((c) => c.path.startsWith(`${target}.oprofile-tmp-`));
  assert.equal(tmpCalls.length, 1);
  assert.equal(tmpCalls[0].mode, 0o600, "the temp file must be CREATED with mode 0600 — the old code called writeFileSync without a mode (write-then-chmod window)");
  assert.equal(statSync(target).mode & 0o7777, 0o600);

  // the pre-rename chmod stays: exact requested mode even under a
  // restrictive umask (umask alone could strip execute bits at creation)
  const execTarget = join(S, "priv", "tool");
  try {
    process.umask(0o077);
    calls.writeFileSync.length = 0;
    libs.atomic.atomicWriteFileSync(execTarget, "#!\n", 0o755);
    assert.equal(statSync(execTarget).mode & 0o7777, 0o755, "requested bits must survive a restrictive umask via the pre-rename chmod");
  } finally {
    process.umask(0o022);
  }

  // optional-mode compat: no mode → platform default, unchanged
  const plain = join(S, "priv", "plain.txt");
  calls.writeFileSync.length = 0;
  libs.atomic.atomicWriteFileSync(plain, "x\n");
  const plainCalls = calls.writeFileSync.filter((c) => c.path.startsWith(`${plain}.oprofile-tmp-`));
  assert.equal(plainCalls.length, 1);
  assert.equal(plainCalls[0].mode, undefined, "no-mode writes keep the platform default (compat)");
  assert.equal(statSync(plain).mode & 0o7777, 0o644);
});

test("planActivation honors replace:true for the different-stage refusal but STILL refuses unmanaged files", () => {
  const live = join(S, "live-t5");
  mkdirSync(live, { recursive: true });
  const { cand: candA } = buildCandidate("rp-cand-a", [{ path: "a.md", bytes: "A\n", mode: 0o644 }]);
  libs.activate.activate({ candidateDir: candA, liveRoot: live });
  const { cand: candB } = buildCandidate("rp-cand-b", [
    { path: "a.md", bytes: "B\n", mode: 0o644 },
    { path: "new.md", bytes: "NEW\n", mode: 0o644 },
  ]);
  // unmanaged file squatting at a managed path
  writeFileSync(join(live, "new.md"), "SQUATTER\n");

  const planNoReplace = libs.activate.planActivation({ candidateDir: candB, liveRoot: live });
  assert.ok(planNoReplace.conflicts.some((c) => /different stage/.test(c)), "different-stage refusal present without replace");
  assert.ok(planNoReplace.conflicts.some((c) => c.includes("new.md")), "unmanaged file refused alongside");

  const planReplace = libs.activate.planActivation({ candidateDir: candB, liveRoot: live, replace: true });
  assert.ok(!planReplace.conflicts.some((c) => /different stage/.test(c)), "replace:true skips ONLY the different-stage refusal (was: ignored entirely)");
  assert.ok(planReplace.conflicts.some((c) => c.includes("new.md")), "unmanaged file still refuses under replace:true");

  // activation enforces the same plan: refuses, writes nothing
  assert.throws(
    () => libs.activate.activate({ candidateDir: candB, liveRoot: live, replace: true }),
    (e) => e.code === 2
  );
  assert.equal(readFileSync(join(live, "a.md"), "utf8"), "A\n", "nothing changed by the refused activation");

  rmSync(join(live, "new.md"));
  libs.activate.activate({ candidateDir: candB, liveRoot: live, replace: true });
  assert.equal(readFileSync(join(live, "a.md"), "utf8"), "B\n", "after the squatter is gone, replace proceeds");
});

test("authority-commit failure rolls back applied files AND restores the previous authority", () => {
  const live = join(S, "live-t6");
  mkdirSync(live, { recursive: true });
  const { cand: candA } = buildCandidate("ac-cand-a", [{ path: "a.md", bytes: "A\n", mode: 0o640 }]);
  libs.activate.activate({ candidateDir: candA, liveRoot: live });
  const activeJson = join(live, ".oprofile", "active.json");
  const authorityBytesBefore = readFileSync(activeJson);

  const { cand: candB } = buildCandidate("ac-cand-b", [
    { path: "a.md", bytes: "B2\n", mode: 0o644 },
    { path: "extra.md", bytes: "EXTRA\n", mode: 0o644 },
  ]);
  // inject ONE renameSync failure exactly at the authority commit target
  let failed = 0;
  hooks.renameSync = (realRename, from, to) => {
    if (to === activeJson && failed === 0) {
      failed++;
      throw new Error("injected ENOSPC at authority commit");
    }
    return realRename(from, to);
  };
  let caught = null;
  try {
    libs.activate.activate({ candidateDir: candB, liveRoot: live, replace: true });
  } catch (e) {
    caught = e;
  } finally {
    hooks.renameSync = null;
  }
  assert.ok(caught, "the injected authority-commit failure must surface as a caught activation error");
  assert.equal(caught.code, 2);
  assert.match(caught.message, /rolled back 2 applied file/);
  assert.deepEqual(caught.rollbackProblems, [], "the rollback itself must have succeeded");
  assert.equal(failed, 1, "exactly the authority commit failed");
  assert.equal(readFileSync(join(live, "a.md"), "utf8"), "A\n", "replaced file's bytes restored");
  assert.equal(statSync(join(live, "a.md")).mode & 0o7777, 0o640, "replaced file restored with its PRE-activation mode (modeBefore), not the new record mode");
  assert.ok(!existsSync(join(live, "extra.md")), "created file removed");
  assert.deepEqual(readFileSync(activeJson), authorityBytesBefore, "previous authority byte-identical after the failed commit");
});

test("rollback restores the PRE-activation mode (modeBefore); old records without modeBefore keep their fallback", () => {
  const live = join(S, "live-t7");
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, "a.md"), "ORIGINAL\n");
  chmodSync(join(live, "a.md"), 0o640);
  libs.activate.adopt({ liveRoot: live, managedPaths: ["a.md"] });

  const { cand } = buildCandidate("rb-cand", [{ path: "a.md", bytes: "REWRITTEN\n", mode: 0o600 }]);
  libs.activate.activate({ candidateDir: cand, liveRoot: live });
  assert.equal(statSync(join(live, "a.md")).mode & 0o7777, 0o600, "after activation: the recorded (after-)mode is installed");
  assert.equal(readFileSync(join(live, "a.md"), "utf8"), "REWRITTEN\n");

  const rec = libs.manifest.readActiveAuthority(live).record;
  assert.equal(rec.files[0].mode, "0600");
  assert.equal(rec.files[0].modeBefore, "0640", "the authority records the pre-activation mode distinctly from the after-mode");

  const rb = libs.activate.rollback({ liveRoot: live });
  assert.deepEqual(rb.blocked, []);
  assert.equal(readFileSync(join(live, "a.md"), "utf8"), "ORIGINAL\n");
  assert.equal(statSync(join(live, "a.md")).mode & 0o7777, 0o640, "rollback restores modeBefore 640, NOT the after-mode 600 (was: restored 0600)");

  // old-style record (mode but no modeBefore): fallback semantics preserved
  writeFileSync(join(live, "a.md"), "CURRENT\n");
  chmodSync(join(live, "a.md"), 0o600);
  libs.activate.adopt({ liveRoot: live, managedPaths: ["a.md"] });
  const backupDir = join(live, ".oprofile", "manual-backup");
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, "a.md"), "ANCIENT\n");
  chmodSync(join(backupDir, "a.md"), 0o664);
  libs.manifest.writeActiveAuthority(live, {
    schemaVersion: 1,
    lane: "personal-profile",
    flavor: "v2",
    stage: { candidateDir: join(S, "rb-cand-manual"), manifestSha256: "x".repeat(64) },
    files: [{ path: "a.md", action: "replace", sha256After: libs.hash.sha256(Buffer.from("CURRENT\n")), backup: join(backupDir, "a.md"), mode: "600" }],
    limits: {},
  });
  const rb2 = libs.activate.rollback({ liveRoot: live });
  assert.deepEqual(rb2.blocked, []);
  assert.equal(readFileSync(join(live, "a.md"), "utf8"), "ANCIENT\n", "bytes still restore from the backup");
  assert.equal(statSync(join(live, "a.md")).mode & 0o7777, 0o600, "old record: entry.mode fallback preserved (no modeBefore → uses the record mode)");
});
