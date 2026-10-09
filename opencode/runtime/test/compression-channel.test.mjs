import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, verifyAllInputs } from "../lib/inputs.mjs";
import { renderV1, renderV2 } from "../lib/render.mjs";
import { stage, StageRefusal } from "../lib/stage.mjs";
import { inspectV1PluginSelection } from "../lib/verify.mjs";
import { fileURLToPath } from "node:url";

const profilePath = fileURLToPath(new URL("../profile.json", import.meta.url));

test("personal compression channel uses official npm latest without a frozen component", () => {
  const { profile } = loadProfile(profilePath);
  assert.equal(Object.hasOwn(profile.components, "compressionPlugin"), false);
  const inputs = verifyAllInputs(profile);
  const entries = ["vibeguardV1", "omoPluginV1", "bcpPlugin"].map(component => ({component, relPath: `plugins/${component}/index.js`}));
  for (const flavor of ["v1", "v2"]) {
    assert.deepEqual(profile.flavors[flavor].stockPlugins, ["billion-context@latest"]);
    const args = {...inputs, stockPlugins: profile.flavors[flavor].stockPlugins};
    const rendered = flavor === "v1" ? renderV1(args, entries) : renderV2(args);
    assert.deepEqual(flavor === "v1" ? rendered.plugin : rendered.plugins,
      ["billion-context@latest", ...(flavor === "v1" ? entries.map(e => `./${e.relPath}`) : [])]);
    assert.deepEqual(rendered.compaction, {auto: false});
  }
});

test("npm selection accepts only the declared channel, rejecting old or duplicate compressors", () => {
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  for (const specs of [["billion-context@latest", "billion-context@latest"], ["billion-context@0.1.175"], ["billion-context@latest", "file:///missing-compression-wrapper.js"]]) {
    assert.equal(inspectV1PluginSelection(specs, "/unused", profile, {}).ok, false);
  }
  assert.equal(inspectV1PluginSelection(["billion-context@latest"], "/unused", profile, {}).ok, true);
});

test("retired compression artifact is refused before any candidate write", () => {
  const {profile, profileSha256} = loadProfile(profilePath);
  const root = mkdtempSync(join(tmpdir(), "billion-channel-"));
  const outDir = join(root, "candidates");
  try {
    assert.throws(() => stage({flavor: "v2", profile, profilePath, profileSha256,
      host: {flavor: "v2", version: "2.0.20", executable: "/test-only"}, outDir,
      explicit: {compressionPlugin: root}}), error => error instanceof StageRefusal &&
        error.report.some(line => line.includes("compressionPlugin") && line.includes("no pinned profile definition")));
    assert.equal(existsSync(outDir), false);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
