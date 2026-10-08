import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectV2ConfigStack, inspectV2AgentMatrix } from "../lib/verify.mjs";

test("v2 layers accept an empty project or its existing config and refuse missing, duplicate or foreign sources", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ppl-layer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const candidate = join(root, "candidate");
  const project = join(root, "project");
  mkdirSync(candidate);
  mkdirSync(project);
  writeFileSync(join(candidate, "opencode.json"), "{}");
  const base = [{ type: "document", path: join(candidate, "opencode.json") }, { type: "directory", path: candidate }];
  const doc = { type: "document", path: join(project, "opencode.json") };
  const check = (layers) => inspectV2ConfigStack(layers, candidate, project).ok;
  assert.equal(check(base), true);
  assert.equal(existsSync(doc.path), false, "verification must not create project config");
  assert.equal(check([...base, doc]), false, "a nonexistent project source is not allowed");
  writeFileSync(doc.path, "{}");
  assert.equal(check([...base, doc]), true);
  assert.equal(check(base), false, "a present project config cannot silently disappear");
  assert.equal(check([...base, doc, doc]), false);
  assert.equal(check([...base, doc, { type: "directory", path: "/production/.config/opencode" }]), false);
  assert.equal(check([base[1], base[0], doc]), false, "layer order remains checked");
  assert.equal(check([{ ...base[0], type: "unknown" }, base[1], doc]), false);
});

test("v2 agent identity rejects same-length prompt corruption and native mode loss", () => {
  const expected = { custom: { mode: "all", model: "kept", systemBytes: 4 } };
  const native = { custom: { system: "kept" } };
  const agent = { id: "custom", mode: "all", model: { modelID: "kept" }, system: "kept" };
  assert.equal(inspectV2AgentMatrix([agent], expected, native).ok, true);
  assert.equal(inspectV2AgentMatrix([{ ...agent, system: "lost" }], expected, native).ok, false);
  assert.equal(inspectV2AgentMatrix([{ ...agent, mode: "subagent" }], expected, native).ok, false);
  assert.equal(inspectV2AgentMatrix([{ ...agent, system: undefined }], expected, native).ok, false);
});
