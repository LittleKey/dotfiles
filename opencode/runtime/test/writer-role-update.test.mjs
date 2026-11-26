import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PAYLOAD_HASHES, SOURCE_PREFIX, SNAPSHOT, OUTPUTS, sha256, sourceManifest,
  updateWriterRole, composeOutputs, replaceJsonValues,
} from "../lib/writer-role-update.mjs";

const maintained = fileURLToPath(new URL("../../", import.meta.url));
const payloads = Object.fromEntries(Object.keys(PAYLOAD_HASHES).map(name =>
  [name, readFileSync(join(maintained, SNAPSHOT, name))]));
const origin = "https://example.invalid/reviewed/writer-role.git";
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function fixture(run) {
  const temp = mkdtempSync(join(tmpdir(), "writer-role-update-"));
  const root = join(temp, "dotfiles"), sourceRepo = join(temp, "source");
  mkdirSync(root); mkdirSync(sourceRepo);
  const git = (...args) => execFileSync("git", ["--no-replace-objects", "--no-lazy-fetch", "-C", sourceRepo, ...args], { env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = () => {
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "reviewed fixture");
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q");
    git("remote", "add", "origin", origin);
    for (const [name, bytes] of Object.entries(payloads)) {
      const path = join(sourceRepo, SOURCE_PREFIX, name);
      mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, bytes);
    }
    const revision = commit();
    const outputs = Object.fromEntries(OUTPUTS.map(path => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      const bytes = readFileSync(join(maintained, path));
      writeFileSync(join(root, path), bytes);
      return [path, bytes];
    }));
    cpSync(join(maintained, SNAPSHOT), join(root, SNAPSHOT), { recursive: true });
    const manifestPath = join(root, SNAPSHOT, "SOURCE.json");
    writeFileSync(manifestPath, JSON.stringify(sourceManifest({ origin, sourceCommit: null, payloads, outputs }), null, 2) + "\n");
    const options = { root, sourceRepo, revision };
    const readManifest = () => JSON.parse(readFileSync(manifestPath));
    const record = () => Object.fromEntries([...OUTPUTS, ...Object.keys(PAYLOAD_HASHES).map(n => `${SNAPSHOT}/${n}`), `${SNAPSHOT}/SOURCE.json`].map(path => [path, sha256(readFileSync(join(root, path)))]));
    const allowOutput = path => {
      const manifest = readManifest();
      manifest.outputs[path] = sha256(readFileSync(join(root, path)));
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    };
    run({ ...options, options, git, commit, record, readManifest, manifestPath, allowOutput });
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

test("offline immutable binding changes only SOURCE; replay byte-identical; ignores dirty working tree", () => fixture(f => {
  // The specified git objects, never the current worktree, are authoritative.
  writeFileSync(join(f.sourceRepo, SOURCE_PREFIX, "audience.md"), "dirty and unapproved\n");
  const before = f.record();
  assert.deepEqual(updateWriterRole(f.options).changed, [`${SNAPSHOT}/SOURCE.json`]);
  const manifest = f.readManifest();
  assert.equal(manifest.sourceCommit, f.revision);
  assert.equal(manifest.deployable, true);
  assert.equal(manifest.repository, origin);
  for (const [path, hash] of Object.entries(before)) {
    if (!path.endsWith("/SOURCE.json")) assert.equal(f.record()[path], hash);
  }
  const bound = f.record();
  assert.deepEqual(updateWriterRole(f.options).changed, []);
  assert.deepEqual(f.record(), bound);
}));

test("no null, symbolic, abbreviated, missing commit or unreviewed source hash; no mutation", () => fixture(f => {
  const before = f.record();
  for (const revision of [null, undefined, "HEAD", f.revision.slice(0, 12), "0".repeat(40)]) {
    assert.throws(() => updateWriterRole({ ...f.options, revision }));
    assert.deepEqual(f.record(), before);
  }
  writeFileSync(join(f.sourceRepo, SOURCE_PREFIX, "audience.md"), "unreviewed\n");
  const revision = f.commit();
  assert.throws(() => updateWriterRole({ ...f.options, revision }), /unapproved payload hash/);
  assert.deepEqual(f.record(), before);
}));

test("snapshot hash, allowlist and composed-output drift refuse before writes", () => {
  fixture(f => {
    writeFileSync(join(f.root, SNAPSHOT, "routing.json"), "{}\n");
    const before = f.record();
    assert.throws(() => updateWriterRole(f.options), /snapshot drift/);
    assert.deepEqual(f.record(), before);
  });
  fixture(f => {
    writeFileSync(join(f.root, SNAPSHOT, "extra.md"), "not allowed\n");
    const before = f.record();
    assert.throws(() => updateWriterRole(f.options), /allowlist mismatch/);
    assert.deepEqual(f.record(), before);
  });
  fixture(f => {
    writeFileSync(join(f.root, OUTPUTS[1]), readFileSync(join(f.root, OUTPUTS[1])) + " ");
    const before = f.record();
    assert.throws(() => updateWriterRole(f.options), /composed output drift/);
    assert.deepEqual(f.record(), before);
  });
});

test("unknown/custom/duplicate anchors refuse even with manually refreshed output guard", () => {
  for (const [path, edit] of [
    [OUTPUTS[0], () => "custom writer\n"],
    [OUTPUTS[1], s => replaceJsonValues(s, [[["agents", "document-writer", "description"], "custom"]])],
    [OUTPUTS[2], s => s + "\n# Audience and dispatch\ncustom\n"],
    [OUTPUTS[2], s => s.replace("# Audience and dispatch\n", "# Audience and dispatch\ncustom\n")],
    [OUTPUTS[2], s => s + "\nUse document-writer as duplicated routing.\n"],
    [OUTPUTS[3], s => s + payloads["oracle-line.txt"].toString()],
    [OUTPUTS[3], s => s.replace("Route purely editorial issues", "Custom editorial issues")],
  ]) fixture(f => {
    writeFileSync(join(f.root, path), edit(readFileSync(join(f.root, path), "utf8")));
    f.allowOutput(path);
    const before = f.record();
    assert.throws(() => updateWriterRole(f.options), /custom|duplicate/);
    assert.deepEqual(f.record(), before);
  });
});

test("prewrite race and linked target refuse; no other output or metadata writes", () => {
  fixture(f => {
    const before = f.record(), path = OUTPUTS[2];
    assert.throws(() => updateWriterRole({ ...f.options, beforeWrite() {
      writeFileSync(join(f.root, path), "concurrent owner change\n");
    } }), /concurrent change/);
    const after = f.record();
    for (const key of Object.keys(before)) if (key !== path) assert.equal(after[key], before[key]);
  });
  fixture(f => {
    const path = join(f.root, OUTPUTS[0]), target = join(f.root, "linked-body");
    writeFileSync(target, readFileSync(path)); rmSync(path); symlinkSync(target, path);
    const before = f.record();
    assert.throws(() => updateWriterRole(f.options), /symlink target/);
    assert.deepEqual(f.record(), before);
  });
});

test("JSON replacement preserves every other byte/value and rejects duplicate keys", () => {
  const text = '{ "agents" : {"document-writer": {"description":"old", "model" : "owner/model", "nested":[{"x":1}],"orchestratorPrompt":"old route"}}, "providers":{"private":"untouched"} }\n';
  const replacements = [
    [["agents", "document-writer", "description"], "new"],
    [["agents", "document-writer", "orchestratorPrompt"], "new route"],
  ];
  const output = replaceJsonValues(text, replacements);
  assert.equal(output, text.replace('"old"', '"new"').replace('"old route"', '"new route"'));
  assert.throws(() => replaceJsonValues('{"x":1,"x":2}', []), /duplicate JSON key/);
});

test("reviewed payloads, single JSON routing, personal policy and model/profile metadata", () => {
  const outputs = Object.fromEntries(OUTPUTS.map(path => [path, readFileSync(join(maintained, path))]));
  assert.deepEqual(composeOutputs(outputs, payloads), outputs, "offline reconstruction is byte-identical");
  for (const [name, hash] of Object.entries(PAYLOAD_HASHES)) assert.equal(sha256(payloads[name]), hash);
  const writer = JSON.parse(outputs[OUTPUTS[1]]).agents["document-writer"];
  const route = JSON.parse(payloads["routing.json"]);
  for (const key of Object.keys(route)) assert.equal(writer[key], route[key]);
  const append = outputs[OUTPUTS[2]].toString();
  assert.equal(append.includes(route.orchestratorPrompt), false);
  assert.equal((append.match(/^# Audience and dispatch$/gm) ?? []).length, 1);
  assert.ok(append.includes("# Search tools\n"));
  assert.ok(append.includes("at most two re-reviews, only after substantive corrections."));
  assert.equal(append.includes("not include human request review"), false);
  const profile = JSON.parse(outputs[OUTPUTS[4]]);
  assert.equal(profile.expected.v2.agents["document-writer"].model, writer.model.split("/").at(-1));
  assert.equal(profile.expected.v2.agents["document-writer"].systemBytes, payloads["document-writer.md"].length);
  assert.deepEqual(profile.flavors.v2.stockPlugins, ["billion-context@latest", "oh-my-opencode-slim@3.0.8"]);
  assert.ok(readdirSync(join(maintained, "runtime/resources")).includes("omo-3.0.7"), "historical resources retained");
});

test("known legacy anchors migrate with routing-only JSON locality and untouched prompt surroundings", () => {
  const current = Object.fromEntries(OUTPUTS.map(path => [path, readFileSync(join(maintained, path))]));
  const legacyDescription = "Create, edit and review formal product, technical and management documents; exclude internal agent plans/state.";
  const legacyRoute = "Use document-writer for formal documents: MODE: WRITE for creation/body edits; MODE: REVIEW for document review. Reuse a suitable writer for revisions, never to independently review its own output. Keep internal plans/state in the main session; independent platform work goes to lark-operator. Follow the main-session review policy.";
  current[OUTPUTS[1]] = Buffer.from(replaceJsonValues(current[OUTPUTS[1]].toString(), [
    [["agents", "document-writer", "description"], legacyDescription],
    [["agents", "document-writer", "orchestratorPrompt"], legacyRoute],
  ]));
  const prefix = "# Handoff and review\n- Keep owner review policy exactly.\n\n";
  const suffix = "# Search tools\n\n- Preserve search safety exactly.\n";
  current[OUTPUTS[2]] = Buffer.from(prefix + "# Audience and dispatch\n- Default audience: software developer; avoid teaching familiar basics.\n- Dispatch in the recipient's working language with readable sources, constraints and expected output; send only missing context/deltas to continuing sessions. Claude's dedicated routing specifies its transport and output contract.\n- Use document-writer for formal-document wording.\n\n" + suffix);
  const first = "- Verdict: retained verbatim.\n", third = "- Re-review: retained verbatim.\n";
  current[OUTPUTS[3]] = Buffer.from(first + "- Tie findings to the inspected version, coverage and limits; include severity, location and evidence/gap. Send purely editorial formal-document issues to document-writer unless meaning changes.\n" + third);
  const out = composeOutputs(current, payloads);
  assert.equal(out[OUTPUTS[2]].toString(), prefix + payloads["audience.md"].toString() + "\n" + suffix);
  assert.equal(out[OUTPUTS[3]].toString(), first + payloads["oracle-line.txt"].toString() + third);
  const before = JSON.parse(current[OUTPUTS[1]]), after = JSON.parse(out[OUTPUTS[1]]);
  after.agents["document-writer"].description = before.agents["document-writer"].description;
  after.agents["document-writer"].orchestratorPrompt = before.agents["document-writer"].orchestratorPrompt;
  assert.deepEqual(after, before);
  assert.equal(out[OUTPUTS[1]].toString(), current[OUTPUTS[1]].toString()
    .replace(JSON.stringify(legacyDescription), JSON.stringify(JSON.parse(payloads["routing.json"]).description))
    .replace(JSON.stringify(legacyRoute), JSON.stringify(JSON.parse(payloads["routing.json"]).orchestratorPrompt)));
  assert.deepEqual(composeOutputs(out, payloads), out);
});

test("git symlink payload and manifest source-path substitution refuse without writes", () => {
  fixture(f => {
    const path = join(f.sourceRepo, SOURCE_PREFIX, "audience.md");
    rmSync(path); symlinkSync("document-writer.md", path);
    const revision = f.commit(), before = f.record();
    assert.throws(() => updateWriterRole({ ...f.options, revision }), /non-regular\/missing git payload/);
    assert.deepEqual(f.record(), before);
  });
  fixture(f => {
    const manifest = f.readManifest();
    manifest.files["audience.md"].path = "../../unexpected";
    writeFileSync(f.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const before = f.record();
    assert.throws(() => updateWriterRole(f.options), /snapshot drift/);
    assert.deepEqual(f.record(), before);
  });
});

test("original BAD commit with replace BAD GOOD is rejected unchanged despite hostile environment", () => fixture(f => {
  writeFileSync(join(f.sourceRepo, SOURCE_PREFIX, "audience.md"), "unapproved original commit body\n");
  const bad = f.commit();
  assert.notEqual(sha256(Buffer.from(f.git("show", `${bad}:${SOURCE_PREFIX}audience.md`) + "\n")), PAYLOAD_HASHES["audience.md"]);
  f.git("replace", bad, f.revision);
  assert.equal(f.git("rev-parse", `refs/replace/${bad}`), f.revision, "replacement really exists");
  const before = f.record();
  const original = process.env.GIT_NO_REPLACE_OBJECTS;
  try {
    for (const value of [undefined, "0", "false", ""]) {
      if (value === undefined) delete process.env.GIT_NO_REPLACE_OBJECTS;
      else process.env.GIT_NO_REPLACE_OBJECTS = value;
      assert.throws(() => updateWriterRole({ ...f.options, revision: bad }), /unapproved payload hash/);
      assert.deepEqual(f.record(), before);
    }
  } finally {
    if (original === undefined) delete process.env.GIT_NO_REPLACE_OBJECTS;
    else process.env.GIT_NO_REPLACE_OBJECTS = original;
  }
}));

test("missing promisor blob fails without any fetch attempt, including hostile inherited environment", () => fixture(f => {
  const blob = f.git("rev-parse", `${f.revision}:${SOURCE_PREFIX}audience.md`);
  rmSync(join(f.sourceRepo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  f.git("config", "remote.origin.promisor", "true");
  f.git("config", "protocol.allow", "never"); // forbid real network even if regression occurs
  const before = f.record(), tracePath = join(f.root, "git-trace.log");
  const keys = ["GIT_TRACE", "GIT_ALLOW_PROTOCOL", "GIT_NO_LAZY_FETCH"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.GIT_TRACE = tracePath;
    process.env.GIT_ALLOW_PROTOCOL = "";
    for (const value of [undefined, "0", "false", ""]) {
      if (value === undefined) delete process.env.GIT_NO_LAZY_FETCH;
      else process.env.GIT_NO_LAZY_FETCH = value;
      writeFileSync(tracePath, "");
      let caught;
      try { updateWriterRole(f.options); } catch (error) { caught = error; }
      assert.ok(caught, "missing blob must fail");
      assert.notEqual(caught.status, 0);
      assert.match(caught.message, /git --no-replace-objects --no-lazy-fetch /);
      const trace = readFileSync(tracePath, "utf8");
      assert.match(trace, /rev-parse/);
      assert.match(trace, /show/);
      // Match a fetch command token, not the mandated --no-lazy-fetch flag.
      assert.doesNotMatch(trace, /(?:^|[ \t])fetch(?:[ \t]|$)|fetch-pack|remote-https?/m);
      assert.doesNotMatch(caught.stderr.toString(), /transport .*not allowed/);
      assert.deepEqual(f.record(), before);
    }
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}));
