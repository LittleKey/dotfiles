import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activate, adopt, rollback, planActivation } from "../lib/activate.mjs";
import { updateWriterRole } from "../lib/writer-role-update.mjs";

function snapshot(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .map(e => {
      const path = join(e.parentPath ?? e.path, e.name);
      return [path, e.isFile() ? readFileSync(path).toString("hex") : "directory"];
    }).sort();
}

test("old and malicious mixed write sets refuse entirely before any live mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "ownership-"));
  try {
    for (const path of ["oh-my-opencode-slim.json", "oh-my-opencode-slim.jsonc",
      "./oh-my-opencode-slim/prompt.md", "x/../oh-my-opencode-slim/prompt.md"]) {
      const candidateDir = join(root, "candidate"), liveRoot = join(root, "live");
      mkdirSync(join(candidateDir, ".oprofile"), { recursive: true });
      mkdirSync(join(liveRoot, ".oprofile"), { recursive: true });
      const files = [{ path: "unrelated.md", action: "create" }, { path, action: "create" }];
      writeFileSync(join(candidateDir, ".oprofile/profile-manifest.json"), JSON.stringify({ files, flavor: "v2" }));
      writeFileSync(join(liveRoot, ".oprofile/active.json"), JSON.stringify({ files, stage: {} }));
      writeFileSync(join(liveRoot, "unrelated.md"), "keep");
      const before = snapshot(root);
      const moved = /ownership moved to omo-coworkers OpenChamber extension/;
      assert.match(planActivation({ candidateDir, liveRoot, replace: true }).conflicts.join(), moved);
      assert.throws(() => activate({ candidateDir, liveRoot, replace: true }), moved);
      assert.throws(() => adopt({ liveRoot, managedPaths: files.map(f => f.path) }), moved);
      assert.throws(() => rollback({ liveRoot }), moved);
      assert.deepEqual(snapshot(root), before);
      // A clean candidate still cannot replace an old transferred authority.
      writeFileSync(join(candidateDir, ".oprofile/profile-manifest.json"), JSON.stringify({ files: [files[0]], flavor: "v2" }));
      const oldAuthority = snapshot(root);
      assert.throws(() => activate({ candidateDir, liveRoot, replace: true }), moved);
      assert.deepEqual(snapshot(root), oldAuthority);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("current personal profile updater refuses before source access or callback", () => {
  const root = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
  assert.equal(JSON.parse(readFileSync(join(root, "runtime/profile.json"))).ownership.status, "retired");
  assert.throws(() => updateWriterRole({
    root, sourceRepo: "/nonexistent", revision: "0".repeat(40),
    beforeWrite() { assert.fail("must not reach writes"); },
  }), /ownership moved to omo-coworkers OpenChamber extension/);
});
