import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadProfile, verifyAllInputs } from "../lib/inputs.mjs";
import { stage } from "../lib/stage.mjs";
import { renderV2 } from "../lib/render.mjs";
import { activate, rollback, planActivation } from "../lib/activate.mjs";

const profilePath = fileURLToPath(new URL("../profile.json", import.meta.url));
test("stock V2 stages offline resources without executable OMO/BCP artifacts; migration fails closed", () => {
  const root = mkdtempSync(fileURLToPath(new URL("../.stock-test-", import.meta.url)));
  try {
    const { profile, profileSha256 } = loadProfile(profilePath);
    assert.equal(Object.hasOwn(profile.inputs, "coworkerPrompts"), false);
    assert.equal(Object.hasOwn(profile.authority.sourcesOfRecord, "coworkerPrompts"), false);
    assert.ok(!JSON.stringify(profile.inputs).includes("omo-coworkers/prompts"),
      "staging has no sibling coworkers prompt input");
    const inputs = verifyAllInputs(profile);
    const explicit = {};
    for (const [name, definition] of Object.entries(profile.components)) {
      if (!definition.flavors.includes("v2") || definition.required !== "always") continue;
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      const entry = typeof definition.entry === "string" ? definition.entry : definition.entry.v2;
      mkdirSync(join(dir, entry, ".."), { recursive: true });
      writeFileSync(join(dir, entry), "export default {};\n");
      if (name === "claudeAdvisor") {
        // Representative of the real shipped guard test: not imported by
        // the discovery entry and must not be mistaken for OMO provenance.
        writeFileSync(join(dir, "guard.test.mjs"), 'const config = "oh-my-opencode-slim.json";\n');
      }
      explicit[name] = dir;
    }
    const args = { flavor: "v2", profile, profilePath, profileSha256,
      host: { flavor: "v2", version: "2.1.4", executable: "/fixture-only" },
      outDir: join(root, "stages"), explicit };
    const result = stage(args);
    assert.deepEqual(readFileSync(join(result.candidateDir, "oh-my-opencode-slim.json")),
      readFileSync(inputs.omoConfig.resolved.path), "personal OMO config is never replaced by an overlay");
    for (const role of ["document-writer", "lark-operator"]) {
      const rel = `${role}.md`;
      assert.deepEqual(readFileSync(join(result.candidateDir, "oh-my-opencode-slim", rel)),
        readFileSync(join(inputs.omoPromptDir.resolved.path, rel)), "local role bytes remain exact");
      assert.equal(existsSync(join(result.candidateDir, "agents", rel)), false, "no native shadow");
      const record = result.manifest.files.find(file => file.path === `oh-my-opencode-slim/${rel}`);
      assert.equal(record.source, inputs.omoPromptDir.resolved.path);
      assert.equal(record.sha256, inputs.omoPromptDir.resolved.files[rel]);
      assert.equal(record.transform, undefined);
    }
    const config = JSON.parse(readFileSync(join(result.candidateDir, "opencode.json")));
    assert.deepEqual(config.plugins.filter(x => typeof x === "string"),
      ["billion-context@latest", "oh-my-opencode-slim@3.0.8"]);
    assert.equal(existsSync(join(result.candidateDir, "plugins/omoPlugin")), false);
    assert.equal(readFileSync(join(result.candidateDir, "skills/deepwork/SKILL.md"), "utf8"),
      readFileSync(join(inputs.omoStockSkills308.resolved.path, "deepwork/SKILL.md"), "utf8"));
    // Real filesystem activation in an isolated fixture is not a host/plugin
    // runtime proof: the sibling entries here are deliberately synthetic.
    const cleanLive = join(root, "clean-live");
    mkdirSync(cleanLive);
    writeFileSync(join(cleanLive, "owner-unrelated.txt"), "keep me\n");
    assert.equal(planActivation({ candidateDir: result.candidateDir, liveRoot: cleanLive }).ok, true);
    activate({ candidateDir: result.candidateDir, liveRoot: cleanLive });
    const installed = JSON.parse(readFileSync(join(cleanLive, "opencode.json"), "utf8"));
    assert.deepEqual(installed.plugins, config.plugins);
    assert.equal(readFileSync(join(cleanLive, "skills/deepwork/SKILL.md"), "utf8"),
      readFileSync(join(inputs.omoStockSkills308.resolved.path, "deepwork/SKILL.md"), "utf8"));
    assert.equal(existsSync(join(cleanLive, "plugins/omoPlugin")), false);
    assert.equal(readFileSync(join(cleanLive, "owner-unrelated.txt"), "utf8"), "keep me\n");
    assert.equal(planActivation({ candidateDir: result.candidateDir, liveRoot: cleanLive }).ok, true);
    const firstAuthority = readFileSync(join(cleanLive, ".oprofile/active.json"));
    activate({ candidateDir: result.candidateDir, liveRoot: cleanLive });
    assert.deepEqual(rollback({ liveRoot: cleanLive }).blocked, []);
    writeFileSync(join(cleanLive, ".oprofile/active.json"), firstAuthority);
    assert.deepEqual(rollback({ liveRoot: cleanLive }).blocked, []);
    assert.equal(existsSync(join(cleanLive, "opencode.json")), false);
    assert.equal(readFileSync(join(cleanLive, "owner-unrelated.txt"), "utf8"), "keep me\n");
    assert.throws(() => stage({ ...args, explicit: { ...explicit, omoPlugin: root } }), /explicit component 'omoPlugin'/);
    assert.throws(() => stage({ ...args, explicit: { ...explicit, bcpPlugin: root } }), /explicit component 'bcpPlugin'/);
    const source = join(root, "source.json");
    writeFileSync(source, JSON.stringify({ plugins: ["oh-my-opencode-slim@3.0.6"] }));
    assert.throws(() => renderV2({ hostConfigSource: { resolved: { path: source } },
      stockPlugins: profile.flavors.v2.stockPlugins }), /OMO migration preflight/);
    const liveRoot = join(root, "live");
    mkdirSync(join(liveRoot, "plugins/renamed"), { recursive: true });
    writeFileSync(join(liveRoot, "plugins/renamed/index.js"), 'const id = "oh-my-opencode-slim";');
    assert.ok(planActivation({ candidateDir: result.candidateDir, liveRoot, replace: true })
      .conflicts.some(x => x.includes("OMO migration preflight")));
    assert.throws(() => activate({ candidateDir: result.candidateDir, liveRoot, replace: true }), /OMO migration preflight/);
    assert.equal(existsSync(join(liveRoot, "opencode.json")), false);
    rmSync(join(liveRoot, "plugins"), { recursive: true });
    const assertRefuses = () => assert.throws(() =>
      activate({ candidateDir: result.candidateDir, liveRoot, replace: true }), /OMO migration preflight/);
    mkdirSync(join(liveRoot, "plugins"), { recursive: true });
    const linkedSource = join(root, "renamed-entry");
    writeFileSync(linkedSource, 'export default { id: "oh-my-opencode-slim" };\n');
    symlinkSync(linkedSource, join(liveRoot, "plugins/innocent.js"));
    assertRefuses();
    rmSync(join(liveRoot, "plugins/innocent.js"));
    symlinkSync(join(root, "missing"), join(liveRoot, "plugins/dangling.js"));
    assertRefuses();
    rmSync(join(liveRoot, "plugins/dangling.js"));
    mkdirSync(join(liveRoot, "plugins/unknown"));
    writeFileSync(join(liveRoot, "plugins/unknown/renamed.mjs"), 'export default { id: "opencode-bcp" };\n');
    assertRefuses();
    rmSync(join(liveRoot, "plugins/unknown"), { recursive: true });
    mkdirSync(join(liveRoot, "plugins/packaged"));
    writeFileSync(join(liveRoot, "plugins/packaged/package.json"),
      JSON.stringify({ name: "oh-my-opencode-slim", main: "entry.js" }));
    writeFileSync(join(liveRoot, "plugins/packaged/entry.js"), "export default {};\n");
    assertRefuses();
    rmSync(join(liveRoot, "plugins/packaged"), { recursive: true });
    mkdirSync(join(liveRoot, "plugins/closure"));
    writeFileSync(join(liveRoot, "plugins/closure/index.js"), 'export { default } from "./renamed.mjs";\n');
    writeFileSync(join(liveRoot, "plugins/closure/renamed.mjs"), 'export default { id: "oh-my-opencode-slim" };\n');
    assertRefuses();
    const external = join(root, "external.mjs");
    writeFileSync(external, 'export default { id: "oh-my-opencode-slim" };\n');
    for (const specifier of [external, pathToFileURL(external).href,
      join(root, "missing.mjs"), pathToFileURL(join(root, "missing.mjs")).href, "file:///%ZZ.mjs"]) {
      writeFileSync(join(liveRoot, "plugins/closure/index.js"),
        `export { default } from ${JSON.stringify(specifier)};\n`);
      assertRefuses();
    }
    // Literal external imports are not intrinsically legacy: unrelated
    // plugins with a fully resolvable, clean closure remain allowed.
    writeFileSync(external, "export default {};\n");
    for (const specifier of [external, pathToFileURL(external).href]) {
      writeFileSync(join(liveRoot, "plugins/closure/index.js"),
        `export { default } from ${JSON.stringify(specifier)};\n`);
      assert.equal(planActivation({ candidateDir: result.candidateDir, liveRoot, replace: true }).ok, true);
    }
    rmSync(join(liveRoot, "plugins"), { recursive: true });
    for (const entries of [
      ["oh-my-opencode-slim@3.0.6"],
      ["oh-my-opencode-slim@3.0.8", "oh-my-opencode-slim@3.0.8"],
      ["oh-my-opencode-slim@3.0.8", "./plugins/blackboard.ts"],
    ]) {
      const bytes = JSON.stringify({ plugins: entries, unrelated: "preserve" });
      writeFileSync(join(liveRoot, "opencode.json"), bytes);
      assert.throws(() => activate({ candidateDir: result.candidateDir, liveRoot, replace: true }), /OMO migration preflight/);
      assert.equal(readFileSync(join(liveRoot, "opencode.json"), "utf8"), bytes);
      assert.equal(existsSync(join(liveRoot, ".oprofile/active.json")), false);
    }
    rmSync(join(liveRoot, "opencode.json"));
    writeFileSync(join(liveRoot, "opencode.jsonc"), "// owner reconciliation required\n{}");
    assert.throws(() => activate({ candidateDir: result.candidateDir, liveRoot, replace: true }), /OMO migration preflight/);
    assert.equal(readFileSync(join(liveRoot, "opencode.jsonc"), "utf8"), "// owner reconciliation required\n{}");
    assert.equal(profile.flavors.v1.stockPlugins.includes("oh-my-opencode-slim@3.0.8"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
