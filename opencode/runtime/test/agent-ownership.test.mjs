// Host rendering must not duplicate OMO role settings or native agent files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderV1, renderV2 } from "../lib/render.mjs";

test("both renderers leave OMO permissions and models to the plugin", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ppl-agent-owner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = join(dir, "opencode.json");
  const omo = join(dir, "oh-my-opencode-slim.json");
  writeFileSync(host, JSON.stringify({ agent: { build: { disable: false }, oracle: { mode: "subagent" } } }));
  writeFileSync(omo, JSON.stringify({
    agents: { oracle: { model: "test/reviewer", permission: { edit: "deny" } } },
  }));
  const inputs = {
    hostConfigSource: { resolved: { path: host } },
    omoConfig: { resolved: { path: omo } },
  };
  assert.deepEqual(renderV1(inputs, []).agent, { build: { disable: false }, oracle: { mode: "subagent" } });
  assert.deepEqual(renderV2(inputs).agents, { build: { disabled: false }, oracle: { mode: "subagent" } });
  delete inputs.omoConfig;
  // Even a sibling OMO file is not a second input to host rendering.
  assert.deepEqual(renderV1(inputs, []).agent, { build: { disable: false }, oracle: { mode: "subagent" } });
});

test("v2 preserves explicit native agents without inventing a Lark override", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ppl-native-agent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = join(dir, "opencode.json");
  const agents = { custom: { mode: "all", model: "test/custom", system: "Owner prompt" } };
  writeFileSync(host, JSON.stringify({ agents }));
  assert.deepEqual(renderV2({ hostConfigSource: { resolved: { path: host } } }).agents, agents);
});
