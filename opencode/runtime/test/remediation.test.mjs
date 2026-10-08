// personal-profile runtime — compatibility-remediation focus tests (node:test,
// no network, no model requests, no production writes).
//
// Plan upstream-defaults-20261006 PHASE1 remediation coverage:
//   GOAL1 — v1 exposes the pinned OMO artifact's five stock skills via the
//   default <configroot>/skills discovery: skills/<name>/ stages as a real
//   directory of RELATIVE file links into plugins/omoPluginV1/server/src/
//   skills/<name>/ (zero duplicated bytes, relocation-safe, no config key,
//   no CLI flag). Missing required resources refuse the stage. v2 keeps the
//   plugin's in-process registration and stages no stock-skill links.
//   GOAL2 — v1 gets a minimal canonical agent entry so the pinned OMO
//   plugin's alias merge (AGENT_ALIASES explore→explorer, first-hit
//   hostEntries lookup) can no longer suppress the default OMO explorer
//   registration: a source that disables the legacy alias name `explore`
//   without a canonical `explorer` entry gets a pin { disable:false }; the
//   builtin v1 core agent keeps its own untouched disable flag. v2 gets NO
//   pin — the plugin captures its host-entry snapshot from the draft BEFORE
//   config agents are applied, so the builtin explore snapshot clobbers the
//   OMO explorer prompt on v2 for ANY configuration (empirically proven in
//   remediation case remediation-v2-20261006-r2 on host 2.0.20); fixing it
//   requires a plugin/upstream change and is reported as a blocker.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, existsSync, rmSync, statSync, readdirSync, renameSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProfile } from "../lib/inputs.mjs";
import { stage, StageRefusal, STOCK_INHERITED_SKILLS } from "../lib/stage.mjs";
import { renderV2, renderV1 } from "../lib/render.mjs";
import { readStageManifest } from "../lib/manifest.mjs";
import { verifyCandidateAgainstManifest } from "../lib/activate.mjs";
import { sha256File } from "../lib/hash.mjs";

const RUNTIME = dirname(dirname(fileURLToPath(import.meta.url))); // .../opencode/runtime
let S; // sandbox root

before(() => {
  S = mkdtempSync(join(tmpdir(), "ppl-remediation-"));
});

after(() => {
  rmSync(S, { recursive: true, force: true });
});

const HOST_V1 = { flavor: "v1", version: "1.18.33", executable: "test://exe", runtimeTested: "1.18.33", minCompatible: "1.18.29" };
const HOST_V2 = { flavor: "v2", version: "2.0.20", executable: "test://exe", runtimeTested: "2.0.20", minCompatible: "2.0.20" };

function writeFakeOmoV1({ omitSkill = null, omitSkillMd = null, omitSkillsRoot = false } = {}) {
  // Fake OMO v1 artifact: nested entry (index/dist/index.js) + the five stock
  // skill resources (server/src/skills/<skill>/SKILL.md). Optional holes let a
  // test drop a required resource and observe the stage refusal.
  const dir = join(S, `omo-v1-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(dir, "index", "dist"), { recursive: true });
  writeFileSync(join(dir, "index", "dist", "index.js"), 'export default { id: "oh-my-opencode-slim" };\n');
  if (!omitSkillsRoot) {
    for (const skill of STOCK_INHERITED_SKILLS) {
      if (skill === omitSkill) continue;
      mkdirSync(join(dir, "server", "src", "skills", skill), { recursive: true });
      if (skill === omitSkillMd) continue;
      writeFileSync(join(dir, "server", "src", "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: fake stock skill\n---\nbody\n`);
    }
    writeFileSync(join(dir, "server", "src", "skills", "clonedeps", "codemap.md"), "fake codemap resource\n");
  }
  return dir;
}

function stageV1(omoV1Dir, pinned = loadProfile(join(RUNTIME, "profile.json"))) {
  const { profile, profilePath, profileSha256 } = pinned;
  const outDir = join(S, `out-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(outDir, { recursive: true });
  const vgDir = join(S, "vg-fake");
  if (!existsSync(vgDir)) {
    mkdirSync(vgDir, { recursive: true });
    writeFileSync(join(vgDir, "index.js"), 'export default { id: "vibeguard-fake" };\n');
  }
  const bcpFile = join(S, "blackboard-fake.ts");
  if (!existsSync(bcpFile)) writeFileSync(bcpFile, "export default {};\n");
  return stage({
    flavor: "v1", profile, profilePath, profileSha256, host: HOST_V1, outDir,
    explicit: { vibeguardV1: vgDir, omoPluginV1: omoV1Dir, bcpPlugin: bcpFile },
  });
}

test("v1 staging projects the pinned OMO input despite a conflicting host-source sibling", () => {
  const pinned = loadProfile(join(RUNTIME, "profile.json"));
  const dir = join(S, "pinned-permissions");
  mkdirSync(dir);
  const host = join(dir, "opencode.json");
  const omo = join(dir, "frozen-omo.json");
  writeFileSync(host, JSON.stringify({ agent: { explore: { disable: true } } }));
  writeFileSync(omo, JSON.stringify({ agents: { oracle: { permission: { edit: "deny" } } } }));
  writeFileSync(join(dir, "oh-my-opencode-slim.json"), JSON.stringify({ agents: { oracle: { permission: { edit: "allow" } } } }));
  pinned.profile.inputs.hostConfigSource = { kind: "file", source: host, sha256: sha256File(host) };
  pinned.profile.inputs.omoConfig = { kind: "file", source: omo, sha256: sha256File(omo) };
  const result = stageV1(writeFakeOmoV1(), pinned);
  const rendered = JSON.parse(readFileSync(join(result.candidateDir, "opencode.json"), "utf8"));
  assert.equal(rendered.agent.oracle.permission.edit, "deny");
  assert.equal(rendered.agent.oracle.permission.write, "deny");
  assert.equal(readFileSync(join(result.candidateDir, "oh-my-opencode-slim.json"), "utf8"), readFileSync(omo, "utf8"));
  assert.deepEqual(result.manifest.v1PermissionProjection.source, { path: omo, sha256: sha256File(omo), resolvedVia: "inputs.omoConfig" });
  // Mutating the unrelated live sibling cannot alter the next staged output.
  writeFileSync(join(dir, "oh-my-opencode-slim.json"), "not JSON");
  const again = stageV1(writeFakeOmoV1(), pinned);
  assert.equal(readFileSync(join(again.candidateDir, "opencode.json"), "utf8"), readFileSync(join(result.candidateDir, "opencode.json"), "utf8"));
});

test("GOAL1 v1 stage: five stock skills staged as relative file links into the staged artifact; manifest records read-through identity", () => {
  const result = stageV1(writeFakeOmoV1());
  const cand = result.candidateDir;

  for (const skill of STOCK_INHERITED_SKILLS) {
    const skillDir = join(cand, "skills", skill);
    assert.ok(statSync(skillDir).isDirectory(), `skills/${skill}/ is a real staged directory`);
    const skillMd = join(skillDir, "SKILL.md");
    assert.ok(statSync(skillMd).isFile(), `skills/${skill}/SKILL.md discoverable through the link farm`);
    // the staged entry is a RELATIVE link resolving INSIDE the candidate, at
    // the staged artifact's own resource path (no absolute /tmp target)
    const target = readFileSync(skillMd, "utf8") && readlinkSafe(skillMd);
    assert.ok(!target.startsWith("/"), `skills/${skill}/SKILL.md link target is relative (${target})`);
    const resolved = realpathSync(skillMd);
    assert.ok(resolved.endsWith(join("plugins", "omoPluginV1", "server", "src", "skills", skill, "SKILL.md")), `link resolves to the staged artifact resource (${resolved})`);
    // byte-identity: the discovered content IS the artifact's bytes
    assert.equal(
      readFileSync(skillMd, "utf8"),
      readFileSync(join(cand, "plugins", "omoPluginV1", "server", "src", "skills", skill, "SKILL.md"), "utf8"),
      "linked skill content equals the artifact bytes (zero-copy, no stale same-name local copy)"
    );
  }
  assert.ok(statSync(join(cand, "skills", "clonedeps", "codemap.md")).isFile(), "non-SKILL.md resource files are linked too");

  // patched + personal skills remain real staged copies next to the links
  assert.ok(existsSync(join(cand, "skills")), "skills/ root present");
  for (const patched of ["codemap", "deepwork", "oh-my-opencode-slim"]) {
    const rec = JSON.parse(readFileSync(join(cand, "opencode.json"), "utf8"));
    assert.ok(typeof rec === "object", "rendered config parses");
    if (existsSync(join(cand, "skills", patched))) {
      assert.ok(!isLink(join(cand, "skills", patched, "SKILL.md")), `patched skill ${patched} stays a real staged copy (precedence kept)`);
    }
  }

  // manifest honesty: one record per linked file with the RELATIVE link target
  // and the read-through sha256 (which verify then re-checks against bytes)
  const { manifest } = readStageManifest(cand);
  const linkRecs = manifest.files.filter((f) => f.path.startsWith("skills/") && f.link);
  const expectedLinks = STOCK_INHERITED_SKILLS.reduce((n, s) => n + readdirSync(join(cand, "skills", s)).length, 0);
  assert.equal(linkRecs.length, expectedLinks, "every linked file is a manifest record");
  for (const rec of linkRecs) {
    const linkAbs = join(cand, ...rec.path.split("/"));
    assert.equal(readlinkSafe(linkAbs), rec.link, "recorded link target equals the staged relative link");
    assert.equal(rec.sha256, sha256File(linkAbs), "recorded sha256 is the read-through artifact identity");
    assert.ok(!rec.path.includes("..") && !rec.link.startsWith("/"), "link stays inside the config root");
  }
  assert.ok(
    manifest.notes.some((n) => n.includes("Stock skills (compatibility remediation)") && n.includes("relative file link")),
    "manifest documents the link-farm mechanism explicitly"
  );

  // the activation integrity gate accepts the staged candidate (statSync and
  // sha256File read through the links: candidate matches its manifest)
  assert.deepEqual(verifyCandidateAgainstManifest(cand, manifest), [], "staged link farm passes the candidate integrity gate");

  // relocation safety: move the whole candidate; every link still resolves
  const moved = join(S, `moved-${Math.random().toString(36).slice(2, 8)}`);
  renameSync(cand, moved);
  assert.equal(
    readFileSync(join(moved, "skills", "reflect", "SKILL.md"), "utf8"),
    readFileSync(join(moved, "plugins", "omoPluginV1", "server", "src", "skills", "reflect", "SKILL.md"), "utf8"),
    "after a move the relative links still resolve inside the (relocated) config root"
  );
});

test("GOAL1 refusals: missing skill directory, missing SKILL.md, missing whole skills root — nothing committed", () => {
  // one skill directory missing entirely
  let refused = null;
  try {
    stageV1(writeFakeOmoV1({ omitSkill: "simplify" }));
  } catch (err) {
    refused = err;
  }
  assert.ok(refused instanceof StageRefusal, "missing resource directory refuses the stage");
  assert.ok(
    refused.report.some((l) => l.includes("server/src/skills/simplify/") && l.includes("missing")),
    `refusal names the missing skill directory: ${refused.report.join(" | ")}`
  );
  assert.ok(refused.report.every((l) => !l.includes("clonedeps") || !l.includes("missing")), "present resources are not falsely reported");

  // SKILL.md missing from an otherwise present directory
  refused = null;
  try {
    stageV1(writeFakeOmoV1({ omitSkillMd: "reflect" }));
  } catch (err) {
    refused = err;
  }
  assert.ok(refused instanceof StageRefusal, "missing SKILL.md refuses the stage");
  assert.ok(refused.report.some((l) => l.includes("server/src/skills/reflect/SKILL.md")), `refusal names the missing manifest file: ${refused.report.join(" | ")}`);

  // the whole resource root missing
  refused = null;
  try {
    stageV1(writeFakeOmoV1({ omitSkillsRoot: true }));
  } catch (err) {
    refused = err;
  }
  assert.ok(refused instanceof StageRefusal, "missing skills root refuses the stage");
  assert.equal(refused.report.filter((l) => l.includes("required stock skill resource directory")).length, STOCK_INHERITED_SKILLS.length, "every required skill is named");
});

test("GOAL1 v2 unchanged: no stock-skill links are staged (in-process registration)", () => {
  const { profile, profilePath, profileSha256 } = loadProfile(join(RUNTIME, "profile.json"));
  const outDir = join(S, "v2-out");
  mkdirSync(outDir, { recursive: true });
  // v2 fake artifact WITHOUT any server/src/skills — v2 stage must not care
  const artifact = join(S, "omo-v2-fake");
  mkdirSync(join(artifact, "server", "dist", "server"), { recursive: true });
  writeFileSync(join(artifact, "server", "dist", "server", "index.js"), 'export default { id: "oh-my-opencode-slim" };\n');
  const result = stage({ flavor: "v2", profile, profilePath, profileSha256, host: HOST_V2, outDir, explicit: { omoPlugin: artifact } });
  const cand = result.candidateDir;
  for (const skill of STOCK_INHERITED_SKILLS) {
    assert.ok(!existsSync(join(cand, "skills", skill)), `v2 stages no skills/${skill} link farm (in-process registration covers it)`);
  }
  const { manifest } = readStageManifest(cand);
  assert.equal(manifest.files.filter((f) => f.link).length, 0, "v2 manifest carries no link records");
});

test("GOAL2 v1 render pin: disabled legacy alias gains a minimal canonical pin; builtin flag untouched; no pin without the trigger", () => {
  const srcPath = join(S, "v1-src.json");
  writeFileSync(srcPath, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "newapi/glm-5.3",
    agent: { build: { disable: false }, plan: { disable: true }, explore: { disable: true }, general: { disable: true } },
  }));
  const report = {};
  const rendered = renderV1({ hostConfigSource: { resolved: { path: srcPath } }, stockPlugins: [] }, [], report);
  // the alias-triggered canonical pin: first-hit lookup now resolves
  // hostEntries['explorer'] and never falls back to the suppressed alias
  assert.deepEqual(rendered.agent.explorer, { disable: false }, "canonical explorer pin rendered disable:false");
  assert.deepEqual(rendered.agent.explore, { disable: true }, "the source's builtin explore disable intent is preserved verbatim");
  assert.deepEqual(rendered.agent.plan, { disable: true }, "unrelated entries stay verbatim");
  assert.deepEqual(report.legacyAliasPins, [{ alias: "explore", canonical: "explorer" }], "the render report records the applied pin");
  assert.equal(rendered.agent.designer, undefined, "frontend-ui-ux-engineer is not disabled in the source → no designer pin");
  assert.equal(Object.keys(rendered.agents ?? {}).length, 0, "v1 lane never emits a native agents root");

  // a source that already pins the canonical agent keeps full control
  writeFileSync(srcPath, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    agent: { explore: { disable: true }, explorer: { disable: false } },
  }));
  const pinned = {};
  const renderedPinned = renderV1({ hostConfigSource: { resolved: { path: srcPath } }, stockPlugins: [] }, [], pinned);
  assert.deepEqual(renderedPinned.agent.explorer, { disable: false }, "pre-existing canonical entry is copied verbatim (never overwritten)");
  assert.deepEqual(pinned.legacyAliasPins, [], "no extra pin applied when the canonical entry already exists");

  // alias present but NOT disabled → no pin; alias absent → no pin
  writeFileSync(srcPath, JSON.stringify({ $schema: "https://opencode.ai/config.json", agent: { explore: { disable: false } } }));
  const notDisabled = {};
  renderV1({ hostConfigSource: { resolved: { path: srcPath } }, stockPlugins: [] }, [], notDisabled);
  assert.deepEqual(notDisabled.legacyAliasPins, [], "no pin when the alias entry is not disabled");
  writeFileSync(srcPath, JSON.stringify({ $schema: "https://opencode.ai/config.json", agent: { build: { disable: false } } }));
  const noAlias = {};
  renderV1({ hostConfigSource: { resolved: { path: srcPath } }, stockPlugins: [] }, [], noAlias);
  assert.deepEqual(noAlias.legacyAliasPins, [], "no pin without a disabled alias entry");

  // the designer alias pair works the same way when it is the disabled one
  writeFileSync(srcPath, JSON.stringify({ $schema: "https://opencode.ai/config.json", agent: { "frontend-ui-ux-engineer": { disable: true } } }));
  const designerPin = {};
  const renderedDesigner = renderV1({ hostConfigSource: { resolved: { path: srcPath } }, stockPlugins: [] }, [], designerPin);
  assert.deepEqual(renderedDesigner.agent.designer, { disable: false }, "frontend-ui-ux-engineer alias pins the canonical designer");
  assert.deepEqual(designerPin.legacyAliasPins, [{ alias: "frontend-ui-ux-engineer", canonical: "designer" }]);
});

test("GOAL2 end-to-end on a staged v1 candidate: rendered agent root carries the pin next to the untouched builtin flags", () => {
  const result = stageV1(writeFakeOmoV1());
  const rendered = JSON.parse(readFileSync(join(result.candidateDir, "opencode.json"), "utf8"));
  // the pinned production source disables explore (builtin explore off) — the
  // staged candidate must show BOTH the preserved builtin intent and the
  // canonical OMO explorer pin
  assert.equal(rendered.agent.explore.disable, true, "builtin explore stays disabled (source intent preserved)");
  assert.equal(rendered.agent.explorer.disable, false, "canonical OMO explorer pin present → default OMO Explorer dispatch restored");
  assert.equal(rendered.agent.plan.disable, true, "plan stays disabled verbatim");
  assert.equal(rendered.agent.general.disable, true, "general stays disabled verbatim");
});

test("GOAL2 v2: no config-level fix exists — legacy explore converts verbatim and NO pin is invented (blocker documented)", () => {
  const srcPath = join(S, "v2-src.json");
  writeFileSync(srcPath, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    agent: { explore: { disable: true }, plan: { disable: true } },
  }));
  const report = {};
  const rendered = renderV2(
    {
      hostConfigSource: { resolved: { path: srcPath } },
      stockPlugins: [],
      larkOperatorPrompt: { resolved: { path: fixtureLarkPrompt() } },
    },
    report
  );
  assert.deepEqual(rendered.agents.explore, { disabled: true }, "legacy disable converts to native disabled verbatim");
  assert.equal(rendered.agents.explorer, undefined, "no v2 pin: the plugin snapshots the draft BEFORE config agents exist (captureAgentDraft → registryBridge.finalize), so the AGENT_ALIASES fallback resolves 'explore' to the builtin snapshot and clobbers the OMO explorer prompt for ANY configuration (empirically proven in remediation case remediation-v2-20261006-r2: even a rendered canonical agents.explorer={mode:'subagent'} pin did not change the served builtin 'file search specialist' prompt). Fix requires a plugin/upstream change — outside this lane's bounds; reported as blocker.");
  assert.deepEqual(rendered.agents.plan, { disabled: true }, "unrelated conversions unchanged");
});

function fixtureLarkPrompt() {
  const p = join(S, "lark-operator.md");
  if (!existsSync(p)) writeFileSync(p, "---\nname: lark-operator\ndescription: fixture\n---\nfixture body\n");
  return p;
}

function isLink(abs) {
  try {
    readlinkSync(abs);
    return true;
  } catch {
    return false;
  }
}

function readlinkSafe(abs) {
  try {
    return readlinkSync(abs);
  } catch {
    return null;
  }
}
