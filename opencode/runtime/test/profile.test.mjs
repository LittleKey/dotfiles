// personal-profile runtime — lane test suite (node:test, no network, no model
// requests, no production writes). Covers the acceptance areas from the
// implementation brief: personal value preservation, narrow host vocabulary
// mapping (never BCP session_id), conflict/manifest/link-safe handling, and
// rollback.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, statSync, cpSync, readdirSync, renameSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadProfile, verifyAllInputs, verifyExplicit, RefusalError } from "../lib/inputs.mjs";
import { stage, StageRefusal, STOCK_INHERITED_SKILLS, refuseStockSkillShadow } from "../lib/stage.mjs";
import { renderV2, renderV1, frontmatterBody } from "../lib/render.mjs";
import { launcherEnv } from "../lib/hostenv.mjs";
import { planActivation, activate, rollback, adopt } from "../lib/activate.mjs";
import { readStageManifest } from "../lib/manifest.mjs";
import { checkDw } from "../lib/dwbridge.mjs";
import { probeHost } from "../bin/oprofile.mjs";
import { spawnSandboxed, childExit, assertChildEnv, EnvRefused } from "../lib/spawn.mjs";
import { isExcludedPromptFile } from "../lib/prompts.mjs";
import { sha256File } from "../lib/hash.mjs";
import { inspectV1PluginSelection } from "../lib/verify.mjs";
// This integration assertion reads the companion repository, independently of
// the dotfiles checkout/worktree depth. Override for another checkout layout.
const bcpRoot = process.env.OPROFILE_BCP_ROOT ?? join(homedir(), "github/opencode-bcp");
const { STOCK_INHERITED_SKILLS: BUILDER_STOCK_INHERITED_SKILLS } = await import(
  pathToFileURL(join(bcpRoot, "integrations/omo-slim/build-skills.mjs")).href
);

const RUNTIME = dirname(dirname(fileURLToPath(import.meta.url))); // .../opencode/runtime
let S; // sandbox root

before(() => {
  S = mkdtempSync(join(tmpdir(), "ppl-test-"));
});

after(() => {
  rmSync(S, { recursive: true, force: true });
});

function personalInputs(profile) {
  // resolve the real pinned inputs without mutating anything
  return verifyAllInputs(profile);
}

test("hostenv: v2 sets OPENCODE_CONFIG_DIR, v1 must not; both strip request overrides and keep node resolvable", () => {
  const cand = join(S, "cand");
  const state = join(S, "state");
  const base = {
    PATH: "/usr/bin:/home/x/.local/share/mise/shims",
    OPENCODE_CONFIG: "/should/disappear",
    OPENCODE_CONFIG_CONTENT: '{"x":1}',
    OPENCODE_SERVER_PASSWORD: "secret",
    OPENCODE_CONFIG_DIR: "/inherited/override",
    OPENCODE_FUTURE_FLAG: "inherited-override-not-in-any-fixed-list",
  };
  const v2 = launcherEnv("v2", cand, state, base);
  assert.equal(v2.env.OPENCODE_CONFIG_DIR, cand, "v2's own OPENCODE_CONFIG_DIR is set after the inherited one is cleared");
  assert.equal(v2.env.OPENCODE_CONFIG, undefined);
  assert.equal(v2.env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(v2.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS, "true");
  assert.equal(v2.env.OPENCODE_SERVER_PASSWORD, undefined);
  assert.equal(v2.env.XDG_DATA_HOME, join(state, "data"));
  assert.equal(v2.env.XDG_CACHE_HOME, join(state, "cache"));
  assert.ok(v2.env.PATH.startsWith(dirname(process.execPath)), "real node dir must precede shims");
  const v1 = launcherEnv("v1", cand, state, base);
  assert.equal(v1.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS, "true");
  assert.equal("OPENCODE_CONFIG_DIR" in v1.env, false, "v1: OPENCODE_CONFIG_DIR adds a layer — must stay unset");
  assert.equal(v1.env.OPENCODE_FUTURE_FLAG, undefined, "EVERY inherited OPENCODE_* override is cleared, not only a fixed strip list");
  assert.equal(v1.env.XDG_CONFIG_HOME, dirname(cand));
  const v1Home = launcherEnv("v1", cand, state, base, {homeDir: join(S, "fresh-home")});
  assert.equal(v1Home.env.XDG_CONFIG_HOME, join(S, "fresh-home", ".config"));
});

test("v1 loaded selection: canonical symlink aliases match; duplicate or outside plugins and a second compressor fail", () => {
  const root = join(S, "selection");
  mkdirSync(root);
  writeFileSync(join(root, "entry.js"), "export default {};");
  const alias = join(S, "selection-alias");
  symlinkSync(root, alias, "dir");
  const profile = {components:{compressionPlugin:{replacesPlugin:"billion-context@0.1.175"}},flavors:{v1:{stockPlugins:["billion-context@0.1.175"]}}};
  const staged = {compressionPlugin:{staged:true,relPath:"entry.js"}};
  const direct = `file://${join(root, "entry.js")}`;
  const linked = `file://${join(alias, "entry.js")}`;
  assert.equal(inspectV1PluginSelection([linked], root, profile, staged).ok, true);
  assert.equal(inspectV1PluginSelection([direct, linked], root, profile, staged).ok, false);
  assert.equal(inspectV1PluginSelection([linked, "billion-context@0.1.175"], root, profile, staged).ok, false);
  const outside = join(S, "outside-plugin.js");
  writeFileSync(outside, "export default {};");
  assert.equal(inspectV1PluginSelection([`file://${outside}`], root, profile, staged).ok, false);
  assert.equal(inspectV1PluginSelection(["file:///missing-owned-plugin.js"], root, profile, staged).ok, false);
});

test("render v2: personal value preservation — models, exact body, mode:all, native agents root only, no credentials; explorer pin retired (no inline system)", () => {
  const { profile } = loadProfile(join(RUNTIME, "profile.json"));
  const inputs = personalInputs(profile);
  // the profile no longer pins a full explorer prompt replacement (phase-1
  // follow-upstream): renderV2 must accept its absence and render NO inline
  // explorer system — the upstream default + explorer_append.md applies via
  // the OMO prompt lookup instead of a full-replacement shadow.
  assert.equal("explorerPrompt" in profile.inputs, false, "profile pins no explorerPrompt input anymore");
  const rendered = renderV2({
    hostConfigSource: inputs.hostConfigSource,
    larkOperatorPrompt: inputs.larkOperatorPrompt,
    stockPlugins: profile.flavors.v2.stockPlugins,
  });
  // original models preserved verbatim
  assert.equal(rendered.model, "newapi/glm-5.3");
  assert.equal(rendered.default_agent, "orchestrator");
  const src = JSON.parse(readFileSync(inputs.hostConfigSource.resolved.path, "utf8"));
  assert.deepEqual(rendered.provider.newapi.models, src.provider.newapi.models, "all 15 personal models preserved");
  assert.equal(rendered.provider.newapi.options.baseURL, src.provider.newapi.options.baseURL);
  assert.deepEqual(Object.keys(rendered.provider.newapi.options), ["baseURL"], "provider options carry baseURL only");
  // explicit personal agents preserved exactly
  assert.equal(rendered.agents["lark-operator"].mode, "all", "lark mode:all preserved (native-v2 retention fixture)");
  assert.equal(rendered.agents["lark-operator"].system, frontmatterBody(readFileSync(inputs.larkOperatorPrompt.resolved.path, "utf8")));
  assert.equal(Buffer.byteLength(rendered.agents["lark-operator"].system), 3275, "lark system bytes match the pinned live snapshot");
  // explorer: no inline system rendered at all when the input is absent
  // (upstream default + explorer_append.md applies via the OMO prompt
  // lookup); v2 gets NO canonical pin — the plugin snapshots the draft
  // before config agents exist, so no rendered entry can prevent the
  // builtin-explore alias clobber on v2 (blocker, see remediation.test.mjs).
  assert.equal(rendered.agents.explorer, undefined, "no inline explorer system, no v2 pin");
  // vocabulary: native agents root only, legacy conversions
  assert.equal(rendered.agent, undefined, "no legacy agent root on v2");
  assert.equal(rendered.agents.build.disabled, false);
  assert.equal(rendered.agents.plan.disabled, true);
  assert.deepEqual(rendered.plugins, ["billion-context@0.1.175"], "native transport still requires the external compression plugin");
  // compaction intent preserved on v2 (verified native route precondition)
  assert.equal(rendered.compaction.auto, false, "compaction.auto=false preserved on v2 (native self-spawn route)");
  // personal permission policy migrated to native v2 permissions — one
  // ordered rule per source pattern, insertion order preserved (the v1
  // pattern map and the v2 ruleset share last-match-wins resolution, so
  // order preservation keeps the meaning identical); no legacy root remains
  assert.equal(rendered.permission, undefined, "no legacy permission root on v2 output");
  assert.deepEqual(
    rendered.permissions,
    Object.entries(src.permission.external_directory).map(([resource, effect]) => ({
      action: "external_directory",
      resource,
      effect,
    })),
    "external_directory policy becomes ordered native rules preserving source order"
  );
  // no credentials in connection fields (prompt prose may legitimately contain
  // words like NEEDS_AUTHORIZATION — scan provider/options and file-level keys,
  // not free text)
  assert.ok(rendered.provider.newapi.options, "provider options kept");
  assert.deepEqual(Object.keys(rendered.provider.newapi.options), ["baseURL"], "provider options carry baseURL only — never auth material");
  assert.ok(!("apiKey" in rendered.provider.newapi), "no apiKey on provider");
  const flat = JSON.stringify(rendered);
  for (const banned of ["auth.json", '"apiKey"', '"accessToken"', '"refreshToken"']) {
    assert.ok(!flat.includes(banned), `rendered config must not contain ${banned}`);
  }

  // the explicit explorerPrompt input REMAINS supported (e.g. a future
  // deliberate re-pin): an explicit input renders the inline system verbatim
  const explicitExplorer = join(S, "explicit-explorer.md");
  writeFileSync(explicitExplorer, "EXPLICIT EXPLORER BODY");
  const explicit = renderV2({
    hostConfigSource: inputs.hostConfigSource,
    explorerPrompt: { resolved: { path: explicitExplorer, sha256: sha256File(explicitExplorer) } },
    larkOperatorPrompt: inputs.larkOperatorPrompt,
    stockPlugins: profile.flavors.v2.stockPlugins,
  });
  assert.equal(explicit.agents.explorer.system, "EXPLICIT EXPLORER BODY", "an explicitly pinned explorer prompt still renders verbatim");
});

test("render v1: legacy agent root only, compaction intent, stock spec first, plugin entries RELATIVE to the declaring config", () => {
  const { profile } = loadProfile(join(RUNTIME, "profile.json"));
  const inputs = personalInputs(profile);
  const cand = join(S, "v1-candidate");
  const rendered = renderV1(
    { hostConfigSource: inputs.hostConfigSource, stockPlugins: profile.flavors.v1.stockPlugins },
    [
      { component: "vibeguardV1", relPath: "plugins/vibeguard/index.js" },
      { component: "omoPluginV1", relPath: "plugins/omo/index.js" },
      { component: "bcpPlugin", relPath: "plugins/blackboard.ts" },
    ]
  );
  assert.equal(rendered.agents, undefined, "no native agents root on v1");
  assert.equal(rendered.agent.build.disable, false);
  assert.deepEqual(rendered.agent.plan, { disable: true });
  assert.equal(rendered.compaction.auto, false, "v1 compaction intent preserved");
  // Relative to the declaring config path: the same bytes resolve from the
  // staging candidate, a MOVED candidate, or the activated live root.
  assert.deepEqual(rendered.plugin, [
    "billion-context@0.1.175",
    "./plugins/vibeguard/index.js",
    "./plugins/omo/index.js",
    "./plugins/blackboard.ts",
  ]);
  assert.ok(!JSON.stringify(rendered).includes("/tmp/opencode"), "no /tmp paths baked in");
  assert.ok(!JSON.stringify(rendered).includes("file://"), "no absolute file URLs baked in (relocatability)");
});

test("personalCore/renderV2: unrelated user settings and provider options are preserved; credential-named keys are dropped BY NAME and recorded", () => {
  const { profile } = loadProfile(join(RUNTIME, "profile.json"));
  const inputs = personalInputs(profile);
  const srcPath = join(S, "rich-host-config.json");
  writeFileSync(
    srcPath,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "prov/some-model",
      default_agent: "orchestrator",
      tui: { theme: "solarized" },
      keybinds: { leader: "<c-x>" },
      autoupdate: false,
      provider: {
        prov: {
          name: "prov",
          npm: "@ai-sdk/openai-compatible",
          models: { m1: { name: "M1" } },
          options: { baseURL: "http://10.0.0.1:3000/v1", apiKey: "SK-NEVER-COPY-0123456789", requestTimeoutMs: 60000, maxOutputTokens: 4096, bypassProxy: false },
        },
      },
      permission: { external_directory: { "/tmp/**": "allow", "~/github/**": "ask" } },
      agent: { build: { disable: false }, plan: { disable: true } },
    })
  );
  const report = {};
  const rendered = renderV2(
    { hostConfigSource: { resolved: { path: srcPath } }, explorerPrompt: inputs.explorerPrompt, larkOperatorPrompt: inputs.larkOperatorPrompt },
    report
  );
  // unrelated user settings survive the render untouched
  assert.deepEqual(rendered.tui, { theme: "solarized" }, "unrelated top-level settings must not vanish from the whitelist");
  assert.deepEqual(rendered.keybinds, { leader: "<c-x>" });
  assert.equal(rendered.autoupdate, false);
  assert.equal(rendered.permission, undefined, "legacy permission root must not leak into v2 output");
  assert.deepEqual(
    rendered.permissions,
    [
      { action: "external_directory", resource: "/tmp/**", effect: "allow" },
      { action: "external_directory", resource: "~/github/**", effect: "ask" },
    ],
    "the permission intent is converted to ordered native rules — order and per-pattern effects preserved (later entries keep last-match meaning)"
  );
  // provider options preserved except credential-named keys
  assert.equal(rendered.provider.prov.options.baseURL, "http://10.0.0.1:3000/v1");
  assert.equal(rendered.provider.prov.options.requestTimeoutMs, 60000);
  assert.equal(rendered.provider.prov.options.maxOutputTokens, 4096, "token budgets are not authentication tokens");
  assert.equal(rendered.provider.prov.options.bypassProxy, false, "a substring 'pass' is not a password field");
  assert.ok(!("apiKey" in rendered.provider.prov.options));
  assert.ok(!("apiKey" in rendered.provider.prov), "no provider-level credential key survives either");
  assert.deepEqual(report.droppedCredentialKeys, ["provider.prov.options.apiKey"], "credential keys are recorded BY NAME only");
  assert.ok(!JSON.stringify(rendered).includes("SK-NEVER-COPY"), "credential values are never copied into any generated config");
  // flavor-owned roots still handled by the renderer, not passed through
  assert.equal(rendered.agents.build.disabled, false);
  assert.equal(rendered.agents.plan.disabled, true);
  assert.equal(rendered.agent, undefined);
});

test("renderV2 permission migration: unprovable names refused, native rules retained verbatim, nothing invented, v1 untouched", () => {
  // minimal prompt fixtures so renderV2 can run without the pinned inputs
  const dir = join(S, "perm-mig");
  mkdirSync(dir, { recursive: true });
  const explorerPath = join(dir, "explorer.md");
  const larkPath = join(dir, "lark-operator.md");
  writeFileSync(explorerPath, "EXPLORER BODY");
  writeFileSync(larkPath, "---\nname: lark\n---\nLARK BODY");
  let seq = 0;
  function migrate(source) {
    const srcPath = join(dir, `src-${++seq}.json`);
    writeFileSync(srcPath, JSON.stringify(source));
    return renderV2(
      {
        hostConfigSource: { resolved: { path: srcPath } },
        explorerPrompt: { resolved: { path: explorerPath } },
        larkOperatorPrompt: { resolved: { path: larkPath } },
      },
      {}
    );
  }
  const schema = "https://opencode.ai/config.json";
  // 1) v1 names without pinned v2 action-ID equivalence are REFUSED — never guessed
  assert.throws(
    () => migrate({ $schema: schema, permission: { edit: "allow" } }),
    (err) => err.message.includes("'edit'") && err.message.includes("refusing to invent"),
    "v1 'edit' has no pinned v2 action-ID equivalence — must block, not rename"
  );
  assert.throws(
    () => migrate({ $schema: schema, permission: { apply_patch: { "**/*.lock": "deny" } } }),
    /refusing to invent/,
    "v1 'apply_patch' is likewise refused (map-valued shape included)"
  );
  // 2) legacy + non-empty native policy: blending cannot preserve last-match order
  assert.throws(
    () =>
      migrate({
        $schema: schema,
        permission: { external_directory: { "/tmp/**": "allow" } },
        permissions: [{ action: "read", resource: "*.env", effect: "ask" }],
      }),
    /refusing to blend rule order/
  );
  // 3) effects outside the native Rule effect set are refused
  assert.throws(
    () => migrate({ $schema: schema, permission: { external_directory: { "/tmp/**": "maybe" } } }),
    /allow\|deny\|ask/
  );
  // 4) integer-like pattern keys are refused: JS reorders integer-like keys
  // ahead of insertion order, so rule order is not preservable
  assert.throws(
    () => migrate({ $schema: schema, permission: { external_directory: { "123": "allow", "/tmp/**": "allow" } } }),
    /integer-like/
  );
  // 5) plain-string effect → wildcard-resource rule (schema-proven resource shape)
  const fromString = migrate({ $schema: schema, permission: { external_directory: "ask" } });
  assert.deepEqual(fromString.permissions, [{ action: "external_directory", resource: "*", effect: "ask" }]);
  assert.equal(fromString.permission, undefined);
  // 6) already-native rulesets are retained verbatim (order included)
  const nativeRules = [
    { action: "*", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "ask" },
  ];
  const native = migrate({ $schema: schema, permissions: nativeRules });
  assert.deepEqual(native.permissions, nativeRules, "native ruleset retained verbatim");
  assert.equal(native.permission, undefined);
  // 7) no source permission → no ruleset invented; a null native slot is dropped, not emitted
  const none = migrate({ $schema: schema });
  assert.equal(none.permissions, undefined, "no permissions ruleset invented when the source has none");
  const nulled = migrate({ $schema: schema, permissions: null });
  assert.equal("permissions" in nulled, false, "native JSON null is not a ruleset — the key is omitted");
  // 8) an EMPTY native array carries no intent — legacy conversion overwrites it losslessly
  const emptyNative = migrate({
    $schema: schema,
    permission: { external_directory: { "/tmp/**": "allow" } },
    permissions: [],
  });
  assert.deepEqual(emptyNative.permissions, [{ action: "external_directory", resource: "/tmp/**", effect: "allow" }]);
  // 9) v1 lane regression: the legacy permission root stays verbatim there
  const legacyPermission = { external_directory: { "/tmp/**": "allow" } };
  const v1srcPath = join(dir, "src-v1.json");
  writeFileSync(v1srcPath, JSON.stringify({ $schema: schema, permission: legacyPermission }));
  const v1rendered = renderV1({ hostConfigSource: { resolved: { path: v1srcPath } }, stockPlugins: [] }, []);
  assert.deepEqual(v1rendered.permission, legacyPermission, "v1 lane is untouched: legacy permission root stays verbatim");
  assert.equal(v1rendered.permissions, undefined, "v1 lane never emits the native ruleset");
});

test("inputs: drift, missing and unpinned-extra inputs refuse with precise reasons", () => {
  const dir = join(S, "drift");
  mkdirSync(dir, { recursive: true });
  const srcFile = join(dir, "a.md");
  writeFileSync(srcFile, "body");
  const prof = {
    schemaVersion: 1,
    inputs: {
      ok: { kind: "file", source: srcFile, sha256: sha256File(srcFile) },
      drifted: { kind: "file", source: srcFile, sha256: "0".repeat(64) },
      gone: { kind: "file", source: join(dir, "missing.md"), sha256: "1".repeat(64) },
      dirIn: { kind: "dir", source: dir, files: { "a.md": sha256File(srcFile) } },
    },
  };
  // unpinned extra present
  writeFileSync(join(dir, "extra.md"), "surprise");
  let report = null;
  try {
    verifyAllInputs(prof);
  } catch (err) {
    report = err.report;
  }
  assert.ok(report, "must refuse");
  assert.ok(report.some((l) => l.includes("drifted: sha256 mismatch")), "drift reason");
  assert.ok(report.some((l) => l.includes("gone: source missing")), "missing reason");
  assert.ok(report.some((l) => l.includes("unpinned file present")), "unpinned-extra reason");
  rmSync(join(dir, "extra.md"));
  // now only drift + missing remain; ok resolves
  const clean = { schemaVersion: 1, inputs: { ok: prof.inputs.ok, gone: prof.inputs.gone } };
  assert.throws(() => verifyAllInputs(clean), RefusalError);
  const onlyOk = { schemaVersion: 1, inputs: { ok: prof.inputs.ok } };
  const resolved = verifyAllInputs(onlyOk);
  assert.equal(resolved.ok.resolved.sha256, sha256File(srcFile));
});

function fakeOmoPluginArtifact() {
  const dir = join(S, "omo-artifact");
  mkdirSync(join(dir, "server/dist/server"), { recursive: true });
  writeFileSync(join(dir, "omo-council.mjs"), "export const council = true;\n");
  writeFileSync(join(dir, "omo-delivery.mjs"), "export const delivery = true;\n");
  writeFileSync(join(dir, "server/dist/server/index.js"), 'import { council } from "../../../omo-council.mjs";\nexport default { id: "oh-my-opencode-slim" };\n');
  return dir;
}

// Minimal five stock skill resources mirroring the pinned OMO 3.0.1 v1
// artifact layout (flat dirs with SKILL.md; one extra file on clonedeps).
// GOAL1 (compatibility remediation): the v1 stage now requires these under
// plugins/<omoPluginV1>/server/src/skills/ and refuses without them.
function addStockSkillDirs(artifactDir) {
  for (const skill of STOCK_INHERITED_SKILLS) {
    mkdirSync(join(artifactDir, "server", "src", "skills", skill), { recursive: true });
    writeFileSync(join(artifactDir, "server", "src", "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: fake stock skill fixture\n---\nbody\n`);
  }
  writeFileSync(join(artifactDir, "server", "src", "skills", "clonedeps", "codemap.md"), "fake codemap resource\n");
}

test("stage v2 (fake plugin artifact): full candidate + manifest; refusal when required artifact missing", () => {
  const { profile, profilePath, profileSha256 } = loadProfile(join(RUNTIME, "profile.json"));
  const host = { flavor: "v2", version: "2.0.20", executable: "test://exe", runtimeTested: "2.0.20", minCompatible: "2.0.20" };
  const outDir = join(S, "stage-v2");
  mkdirSync(outDir, { recursive: true });

  // missing required explicit component → refusal, NOTHING written
  assert.throws(
    () => stage({ flavor: "v2", profile, profilePath, profileSha256, host, outDir, explicit: {} }),
    (err) => err instanceof StageRefusal && err.report.some((l) => l.includes("omoPlugin") && l.includes("--omo-plugin"))
  );
  assert.deepEqual(readdirSync(outDir), [], "refusal must leave the output dir empty");

  // supplied artifact → success
  const result = stage({ flavor: "v2", profile, profilePath, profileSha256, host, outDir, explicit: { omoPlugin: fakeOmoPluginArtifact() } });
  const inputs = personalInputs(profile);
  const cand = result.candidateDir;
  assert.ok(Object.isFrozen(result.env), "stage env must be read-only for workers");
  assert.ok(Object.isFrozen(result.notes), "stage notes must be read-only for workers");
  assert.ok(existsSync(join(cand, "opencode.json")));
  assert.ok(existsSync(join(cand, "AGENTS.md")));
  assert.ok(existsSync(join(cand, "oh-my-opencode-slim.json")));
  // 2026-10-06 owner repin: the full explorer prompt is retired from the
  // sources — upstream default + explorer_append.md applies (no inline copy)
  assert.ok(!existsSync(join(cand, "oh-my-opencode-slim", "explorer.md")), "explorer.md is not staged (source deleted; upstream lookup applies)");
  assert.ok(existsSync(join(cand, "oh-my-opencode-slim", "explorer_append.md")), "explorer_append.md is staged byte-identically");
  assert.ok(existsSync(join(cand, "agents", "lark-operator.md")));
  assert.ok(existsSync(join(cand, "skills")));
  // Council-replacement prompts and pre-optimization .bak files are never staged
  for (const excluded of ["council.md", "council_append.md", "council_append.md.bak-promptopt", "document-writer.md.bak-promptopt", "lark-operator.md.bak-promptopt", "oracle_append.md.bak-promptopt", "orchestrator_append.md.bak-promptopt"]) {
    assert.ok(!existsSync(join(cand, "oh-my-opencode-slim", excluded)), `${excluded} must never enter a candidate`);
  }
  // Byte-identical prompt staging (phase-1 transform retirement): staged
  // copies equal their pinned sources exactly — prompt policy lives in the
  // sources, never in staged-copy anchor surgery.
  const promptSrcPath = join(inputs.omoPromptDir.resolved.path, "orchestrator_append.md");
  const appendStaged = readFileSync(join(cand, "oh-my-opencode-slim", "orchestrator_append.md"), "utf8");
  assert.equal(appendStaged, readFileSync(promptSrcPath, "utf8"), "orchestrator_append.md stages byte-identical to the pinned source (whatever Council policy the source carries — staging never mutates it)");
  // 2026-10-06 owner repin: upstream orchestrator.md is deleted from the
  // sources — the plugin's prompt lookup applies it in-process on v2.
  assert.ok(!existsSync(join(inputs.omoPromptDir.resolved.path, "orchestrator.md")), "orchestrator.md is deleted from the pinned sources");
  assert.ok(!existsSync(join(cand, "oh-my-opencode-slim", "orchestrator.md")), "orchestrator.md is not staged (upstream lookup applies)");
  assert.equal(result.components.omoPlugin.status, "staged-differs-from-tested", "fake artifact recorded honestly against the tested reference");
  assert.equal(result.components.bcpPlugin.status, "absent-explicit", "privacy lane component explicitly absent, never fabricated");
  // v2 entry shim imports RELATIVELY (relocatable candidate)
  const v2Shim = readFileSync(join(cand, "plugins", "omoPlugin", "index.js"), "utf8");
  assert.equal(v2Shim, 'export {default} from "./server/dist/server/index.js";\n', "v2 shim re-exports the nested entry via a relative specifier");
  const { manifest } = readStageManifest(cand);
  assert.equal(manifest.flavor, "v2");
  assert.ok(manifest.files.length > 20, "manifest lists every staged file");
  const promptRec = manifest.files.find((f) => f.path === "oh-my-opencode-slim/orchestrator_append.md");
  assert.equal(promptRec.transform, undefined, "prompt copies carry no transform — they are byte-identical");
  assert.equal(promptRec.sha256, sha256File(join(cand, "oh-my-opencode-slim", "orchestrator_append.md")), "staged bytes are hashed, not just the source");
  assert.equal(promptRec.sourceSha256, sha256File(promptSrcPath), "staged bytes equal the pinned source bytes");
  assert.ok(JSON.stringify(manifest.notes).includes("bak-promptopt"), "the manifest records the prompt exclusions (Council replacements are gone from the source; pre-optimization backups remain excluded)");
  const renderedSha = sha256File(join(cand, "opencode.json"));
  assert.equal(manifest.renderedConfigSha256, renderedSha);
  // no /tmp paths anywhere; absolute file URLs only in GENERATED files
  // (pinned prompt prose may legitimately mention file:// — relocatability
  // requires the generated config and shims to be free of them)
  for (const f of manifest.files) {
    const bytes = readFileSync(join(cand, ...f.path.split("/")), "utf8");
    assert.ok(!bytes.includes("/tmp/opencode"), `${f.path} must not embed /tmp paths`);
    const generated = f.path === "opencode.json" || /^plugins\/[^/]+\/index\.js$/.test(f.path);
    if (generated) assert.ok(!bytes.includes("file://"), `${f.path} is generated and must not embed absolute file URLs`);
  }
  // repeat staging produces a second, independent candidate
  const again = stage({ flavor: "v2", profile, profilePath, profileSha256, host, outDir, explicit: { omoPlugin: fakeOmoPluginArtifact() } });
  assert.notEqual(again.candidateDir, cand);
});

test("stage v2: invalid explicit artifact (bad entry) refuses; deferred bcp artifact records honestly", () => {
  const { profile, profilePath, profileSha256 } = loadProfile(join(RUNTIME, "profile.json"));
  const host = { flavor: "v2", version: "2.0.20", executable: "test://exe", runtimeTested: "2.0.20", minCompatible: "2.0.20" };
  const outDir = join(S, "stage-v2b");
  mkdirSync(outDir, { recursive: true });
  const badDir = join(S, "bad-omo");
  mkdirSync(badDir, { recursive: true });
  assert.throws(
    () => stage({ flavor: "v2", profile, profilePath, profileSha256, host, outDir, explicit: { omoPlugin: badDir } }),
    (err) => err instanceof StageRefusal && err.report.some((l) => l.includes("entry"))
  );
  const fakeBcp = join(S, "fake-blackboard.ts");
  writeFileSync(fakeBcp, "export default {};\n");
  const result = stage({ flavor: "v2", profile, profilePath, profileSha256, host, outDir, explicit: { omoPlugin: fakeOmoPluginArtifact(), bcpPlugin: fakeBcp } });
  assert.equal(result.components.bcpPlugin.status, "staged-unverified", "privacy-lane artifact staged but never asserted complete");
});

test("stage v1 composition: vibeguard directory entry is NOT shimmed (no self-re-export, single listing), omo v1 directory gets a re-export shim, stock compression spec is rendered first", () => {
  const { profile, profilePath, profileSha256 } = loadProfile(join(RUNTIME, "profile.json"));
  const host = { flavor: "v1", version: "1.18.33", executable: "test://exe", runtimeTested: "1.18.33", minCompatible: "1.18.29" };
  const outDir = join(S, "stage-v1");
  mkdirSync(outDir, { recursive: true });

  // vibeguard v1 artifact: a real dependency DIRECTORY whose entry is index.js
  // (production local-plugins/dist/vibeguard/ has index.js + sibling modules —
  // an unbundled index.js alone is not installable)
  const vgDir = join(S, "fake-vibeguard-v1");
  mkdirSync(vgDir, { recursive: true });
  const vgIndex = 'import { engine } from "./engine.js";\nexport default { id: "vibeguard-fake", engine };\n';
  writeFileSync(join(vgDir, "index.js"), vgIndex);
  writeFileSync(join(vgDir, "engine.js"), "export const engine = () => true;\n");

  // omo v1 artifact: directory whose entry is NOT index.js → re-export shim
  // (the 3.0.1 v1 entry lives at index/dist/index.js and imports its helper
  // relatively: ../omo-delivery.mjs → index/omo-delivery.mjs)
  const omoV1Dir = join(S, "fake-omo-v1");
  mkdirSync(join(omoV1Dir, "index", "dist"), { recursive: true });
  writeFileSync(join(omoV1Dir, "index", "omo-delivery.mjs"), "export const delivery = true;\n");
  writeFileSync(join(omoV1Dir, "index", "dist", "index.js"), 'import { delivery } from "../omo-delivery.mjs";\nexport default { id: "oh-my-opencode-slim", delivery };\n');
  addStockSkillDirs(omoV1Dir);

  const bcpFile = join(S, "fake-blackboard-v1.ts");
  writeFileSync(bcpFile, "export default {};\n");

  const result = stage({ flavor: "v1", profile, profilePath, profileSha256, host, outDir, explicit: { vibeguardV1: vgDir, omoPluginV1: omoV1Dir, bcpPlugin: bcpFile } });
  const cand = result.candidateDir;
  assert.equal(result.components.vibeguardV1.status, "staged-differs-from-tested", "fake dependency dir recorded honestly against the pinned reference");
  assert.equal(result.components.omoPluginV1.status, "staged-differs-from-tested");
  assert.equal(result.components.bcpPlugin.status, "staged-unverified");

  // entry === index.js: the staged file IS the artifact entry, byte-identical —
  // a re-export shim here would shadow the dependency-relative imports
  const vgStagedPath = join(cand, "plugins", "vibeguardV1", "index.js");
  assert.equal(readFileSync(vgStagedPath, "utf8"), vgIndex, "vibeguard v1 entry must be staged as-is, never overwritten by a re-export shim");
  assert.ok(existsSync(join(cand, "plugins", "vibeguardV1", "engine.js")), "the dependency directory travels with the entry");
  assert.ok(!readFileSync(vgStagedPath, "utf8").includes("export {default}"), "no shim marker on an index.js entry");

  // entry !== index.js: shim at plugins/<name>/index.js re-exports the real entry
  const shimPath = join(cand, "plugins", "omoPluginV1", "index.js");
  const shim = readFileSync(shimPath, "utf8");
  assert.ok(shim.includes("export {default}"), "omo v1 gets the auto-discovery shim");
  assert.equal(shim, 'export {default} from "./index/dist/index.js";\n', "shim import is RELATIVE to the shim itself (relocatable candidate)");
  assert.ok(existsSync(join(cand, "plugins", "omoPluginV1", "index", "dist", "index.js")));
  assert.ok(existsSync(join(cand, "plugins", "omoPluginV1", "index", "omo-delivery.mjs")), "relative OMO helpers travel with the directory artifact");

  // rendered v1 config: stock compression spec first, then the staged entries in
  // the profile's plugin order — each component exactly once, all RELATIVE to
  // the declaring config path (resolve from candidate, moved dir, or live root)
  const rendered = JSON.parse(readFileSync(join(cand, "opencode.json"), "utf8"));
  assert.deepEqual(rendered.plugin, [
    "billion-context@0.1.175",
    "./plugins/vibeguardV1/index.js",
    "./plugins/omoPluginV1/index.js",
    "./plugins/fake-blackboard-v1.ts",
  ]);
  for (const entry of rendered.plugin.filter((p) => p.startsWith("./"))) {
    assert.ok(existsSync(join(cand, entry)), `relative plugin entry ${entry} resolves inside its own config root`);
  }
  assert.ok(!JSON.stringify(rendered).includes("file://"), "no absolute file URLs baked into the v1 config");
  assert.equal(rendered.compaction.auto, false, "compaction.auto=false rendered on v1 (stock engine single route, no ACP)");

  // v1 prompt staging is byte-identical too (no v1-specific rewrite existed
  // or remains): sources pass through untouched on both flavors.
  // 2026-10-06 owner repin: the upstream orchestrator.md was deleted from the
  // pinned sources — the plugin's prompt lookup applies it in-process, and
  // only appends + document-writer.md travel with the candidate.
  const v1Inputs = personalInputs(profile);
  assert.ok(!existsSync(join(cand, "oh-my-opencode-slim", "orchestrator.md")), "orchestrator.md is not staged (source deleted; upstream lookup applies)");
  const appendV1 = readFileSync(join(cand, "oh-my-opencode-slim", "orchestrator_append.md"), "utf8");
  assert.equal(appendV1, readFileSync(join(v1Inputs.omoPromptDir.resolved.path, "orchestrator_append.md"), "utf8"), "v1 append stages byte-identical (Council prune retired)");
  assert.ok(!existsSync(join(cand, "oh-my-opencode-slim", "council.md")));

  // manifest: relPaths recorded for verification, staged bytes hashed
  const { manifest } = readStageManifest(cand);
  assert.equal(manifest.components.vibeguardV1.relPath, "plugins/vibeguardV1/index.js");
  assert.equal(manifest.components.omoPluginV1.relPath, "plugins/omoPluginV1/index.js");
  assert.equal(manifest.components.bcpPlugin.relPath, "plugins/fake-blackboard-v1.ts");
  const vgRec = manifest.files.find((f) => f.path === "plugins/vibeguardV1/index.js");
  assert.equal(vgRec.transform, "component-entry");
  assert.equal(vgRec.sha256, sha256File(vgStagedPath));
  const shimRec = manifest.files.find((f) => f.path === "plugins/omoPluginV1/index.js");
  assert.ok(shimRec.transform === undefined, "the shim is generated, not a copied input");
  assert.ok(JSON.stringify(manifest.notes).includes("billion-context"), "manifest records the stock compression selection");
});

test("probeHost: floors, unknown majors, pre-releases", () => {
  const makeFake = (versionOut) => {
    const p = join(S, `fake-${randomBytes(4).toString("hex")}.sh`);
    writeFileSync(p, `#!/bin/sh\nprintf '%s' ${JSON.stringify(versionOut)}\n`);
    p && execFileSync("chmod", ["+x", p]);
    return p;
  };
  assert.equal(probeHost(makeFake("opencode 1.18.33")).flavor, "v1");
  assert.equal(probeHost(makeFake("2.0.20")).flavor, "v2");
  const low = probeHost;
  assert.throws(() => low(makeFake("opencode 1.18.28")), (e) => e.code === 3 && /floor/.test(e.message));
  assert.throws(() => low(makeFake("opencode 3.0.0")), (e) => e.code === 3 && /unknown host major/.test(e.message));
  assert.throws(() => low(makeFake("opencode 2.0.21-beta.0")), (e) => e.code === 3 && /pre-release/.test(e.message));
});

function minimalProfile(dir) {
  const a = join(dir, "a.md");
  const b = join(dir, "sub", "b.md");
  mkdirSync(dirname(b), { recursive: true });
  writeFileSync(a, "A");
  writeFileSync(b, "B");
  return {
    schemaVersion: 1,
    inputs: {},
    components: {},
    flavors: { v1: { pluginOrder: [], copyExtras: [] }, v2: { copyExtras: [] } },
    files: [
      { path: "a.md", source: a },
      { path: "sub/b.md", source: b },
    ],
  };
}

test("activate/rollback: link-safe updates, authority record, handled-failure rollback, blocked reporting", () => {
  const srcDir = join(S, "minimal-src");
  const prof = minimalProfile(srcDir);
  // candidate built by hand (stage() requires the real profile; the activation
  // logic only needs manifest.files)
  const cand = join(S, "minimal-candidate");
  mkdirSync(join(cand, "sub"), { recursive: true });
  mkdirSync(join(cand, ".oprofile"), { recursive: true });
  for (const f of prof.files) {
    cpSync(f.source, join(cand, ...f.path.split("/")));
  }
  const manifest = {
    schemaVersion: 1,
    lane: "personal-profile",
    flavor: "v2",
    files: prof.files.map((f) => ({ path: f.path, action: "create", source: f.source, sourceSha256: sha256File(f.source) })),
    limits: {},
  };
  writeFileSync(join(cand, ".oprofile", "profile-manifest.json"), JSON.stringify(manifest, null, 2));

  const live = join(S, "live-root");
  mkdirSync(live, { recursive: true });
  const twin = join(S, "twin-a.md");
  // pre-existing managed path, HARD-LINKED to a twin (production link-count-2 situation)
  writeFileSync(twin, "OLD");
  const link = join(live, "a.md");
  execFileSync("ln", [twin, link]);
  assert.equal(statSync(link).nlink, 2, "test setup: hard link established");

  // plan without authority: unmanaged existing file → conflict
  const plan0 = planActivation({ candidateDir: cand, liveRoot: live });
  assert.equal(plan0.ok, false);
  assert.ok(plan0.conflicts.some((c) => c.includes("a.md") && c.includes("unmanaged")));

  // adopt current bytes as baseline (records, writes nothing to managed files)
  const adopted = adopt({ liveRoot: live, managedPaths: ["a.md", "sub/b.md"] });
  assert.equal(adopted.files.find((f) => f.path === "a.md").sha256Before, sha256File(twin));

  // plan now passes; activation replaces a.md with a FRESH inode
  const plan1 = planActivation({ candidateDir: cand, liveRoot: live });
  assert.equal(plan1.ok, true, JSON.stringify(plan1.conflicts));
  const record = activate({ candidateDir: cand, liveRoot: live });
  assert.equal(readFileSync(link, "utf8"), "A");
  assert.equal(readFileSync(twin, "utf8"), "OLD", "hard-link twin keeps pre-activation bytes");
  assert.notEqual(statSync(link).ino, statSync(twin).ino, "managed write must not go through the link");
  assert.equal(record.files.find((f) => f.path === "a.md").action, "replace");
  assert.equal(record.files.find((f) => f.path === "sub/b.md").action, "create");
  assert.ok(existsSync(join(live, "sub", "b.md")));

  // second activation of a DIFFERENT stage refuses without --replace
  const cand2 = join(S, "minimal-candidate-2");
  mkdirSync(join(cand2, ".oprofile"), { recursive: true });
  cpSync(join(cand, "a.md"), join(cand2, "a.md"));
  writeFileSync(join(cand2, "a.md"), "A2");
  mkdirSync(join(cand2, "sub"), { recursive: true });
  writeFileSync(join(cand2, "sub", "b.md"), "B2");
  writeFileSync(
    join(cand2, ".oprofile", "profile-manifest.json"),
    JSON.stringify({ ...manifest, note: "different candidate build", files: [{ path: "a.md", action: "create", source: join(srcDir, "a.md"), sourceSha256: sha256File(join(srcDir, "a.md")) }, { path: "sub/b.md", action: "create", source: join(srcDir, "sub", "b.md"), sourceSha256: sha256File(join(srcDir, "sub", "b.md")) }] }, null, 2)
  );
  assert.throws(() => activate({ candidateDir: cand2, liveRoot: live }), (e) => e.code === 2 && /different stage/.test(e.message));

  // rollback of the active stage restores exact pre-activation bytes
  const rb = rollback({ liveRoot: live });
  assert.deepEqual(rb.blocked, []);
  assert.equal(readFileSync(link, "utf8"), "OLD");
  assert.equal(readFileSync(twin, "utf8"), "OLD");
  assert.ok(!existsSync(join(live, "sub", "b.md")), "created files removed");
  assert.equal(existsSync(join(live, ".oprofile", "active.json")), false, "authority removed");

  // handled failure mid-apply: sub exists as a FILE → dir creation fails after a.md applied
  execFileSync("ln", ["-f", twin, link]); // restore link state (link currently a fresh inode with OLD bytes)
  rmSync(join(live, "sub"), { recursive: true }); // rollback removed the file but leaves the dir
  writeFileSync(join(live, "sub"), "not-a-dir");
  adopt({ liveRoot: live, managedPaths: ["a.md", "sub/b.md"] }); // re-baseline after rollback
  const plan2 = planActivation({ candidateDir: cand, liveRoot: live });
  assert.equal(plan2.ok, true, JSON.stringify(plan2.conflicts));
  assert.throws(
    () => activate({ candidateDir: cand, liveRoot: live }),
    (e) => e.code === 2 && /rolled back/.test(e.message)
  );
  assert.equal(readFileSync(link, "utf8"), "OLD", "failed activation rolled the applied file back");
  const restoredAuth = JSON.parse(readFileSync(join(live, ".oprofile", "active.json"), "utf8"));
  assert.equal(restoredAuth.adopted, true, "previous (adopted) authority restored after failed activation");
  rmSync(join(live, "sub"));

  // blocked rollback: live bytes changed since activation
  const rec2 = activate({ candidateDir: cand, liveRoot: live });
  writeFileSync(join(live, "sub", "b.md"), "TAMPERED");
  const rb2 = rollback({ liveRoot: live });
  assert.ok(rb2.blocked.some((b) => b.includes("sub/b.md") && /changed since activation/.test(b)), "tampered file blocked, never overwritten");
  assert.equal(rb2.authorityKept, "kept (blocked entries need reconciliation)");
  assert.equal(existsSync(join(live, ".oprofile", "active.json")), true);
  assert.equal(readFileSync(join(live, "a.md"), "utf8"), "OLD", "untampered file rolled back normally");
});

test("symlink at a managed path is a refusal, never written through", () => {
  const srcDir = join(S, "mini-src-2");
  const prof = minimalProfile(srcDir);
  const cand = join(S, "mini-cand-2");
  mkdirSync(join(cand, ".oprofile"), { recursive: true });
  cpSync(join(srcDir, "a.md"), join(cand, "a.md"));
  const manifest = { schemaVersion: 1, lane: "personal-profile", flavor: "v1", files: [{ path: "a.md", action: "create", source: join(srcDir, "a.md"), sourceSha256: sha256File(join(srcDir, "a.md")) }], limits: {} };
  writeFileSync(join(cand, ".oprofile", "profile-manifest.json"), JSON.stringify(manifest));
  const live = join(S, "live-root-2");
  mkdirSync(live, { recursive: true });
  const target = join(S, "outside.md");
  writeFileSync(target, "PRECIOUS");
  symlinkSync(target, join(live, "a.md"));
  const plan = planActivation({ candidateDir: cand, liveRoot: live });
  assert.equal(plan.ok, false);
  assert.ok(plan.conflicts.some((c) => c.includes("symlink")));
  assert.throws(() => activate({ candidateDir: cand, liveRoot: live }), (e) => e.code === 2 && /symlink/.test(e.message));
  assert.equal(readFileSync(target, "utf8"), "PRECIOUS", "symlink target untouched");
});

test("dw bridge: ownership conflicts reported, vocabulary report-only, session_id/task_id untouched", () => {
  const target = join(S, "dw-target");
  mkdirSync(join(target, ".opencode", "agents"), { recursive: true });
  writeFileSync(
    join(target, ".opencode", "document-writer-install.json"),
    JSON.stringify({
      schemaVersion: 1,
      host: "v2",
      runtimeTested: "2.0.20",
      provenance: { bcpSessionId: "ses_abc123", metadataTaskId: "task_77" },
    })
  );
  writeFileSync(
    join(target, ".opencode", "agents", "lark-operator.md"),
    `---\ndescription: dw-rendered\nmode: subagent\n---\nbody\n`
  );
  const omoConfig = join(S, "personal-omo.json");
  writeFileSync(
    omoConfig,
    JSON.stringify({ agents: { "document-writer": { model: "newapi/glm-5.3-flash", variant: "max" }, "lark-operator": { model: "newapi/glm-5.3", variant: "max" } } })
  );
  const report = checkDw({ targetDir: target, flavor: "v2", personalOmoConfigPath: omoConfig });
  const ids = report.conflicts.map((c) => c.id);
  assert.ok(ids.includes("MODEL-OWNERSHIP"), "inheritModelFrom vs explicit pin must be reported");
  assert.ok(ids.includes("MODE-MISMATCH"), "subagent vs all must be reported");
  assert.ok(ids.includes("PROMPT-AUTHORITY"), "prompt authority duplication must be reported");
  assert.ok(report.conflicts.every((c) => c.severity !== "info" ? c.recommendation.includes("owner") : true), "generic-installer fixes are recommendations, not silent changes");
  assert.equal(report.delegationVocabulary.host, "subagent");
  assert.equal(report.delegationVocabulary.host, "subagent");
  assert.equal(report.pass, false);
  // vocabulary mapping is report-only: identifiers pass through untouched
  const manifest = JSON.parse(readFileSync(join(target, ".opencode", "document-writer-install.json"), "utf8"));
  assert.equal(manifest.provenance.bcpSessionId, "ses_abc123", "BCP session_id must never be rewritten");
  assert.equal(manifest.provenance.metadataTaskId, "task_77", "metadata task_id must never be rewritten");
  // v1 vocabulary maps to task
  const rep1 = checkDw({ targetDir: join(S, "empty-target"), flavor: "v1", personalOmoConfigPath: omoConfig });
  mkdirSync(join(S, "empty-target"), { recursive: true });
  assert.equal(checkDw({ targetDir: join(S, "empty-target"), flavor: "v1", personalOmoConfigPath: omoConfig }).delegationVocabulary.host, "task");
});

// ---- spawn boundary (post-incident 2026-10-01) ----

// A complete, launch-ready sandbox environment for boundary tests. The fresh
// HOME/data/state/cache stand in for the per-run dirs verify() builds.
function sandboxEnv(over = {}) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(S, "fresh-home"),
    XDG_DATA_HOME: join(S, "fresh-data"),
    XDG_STATE_HOME: join(S, "fresh-state"),
    XDG_CACHE_HOME: join(S, "fresh-cache"),
    ...over,
  };
}

test("spawn boundary: a {env, notes} launcher/stage result is refused BEFORE a process is created", () => {
  const cand = join(S, "cand-boundary");
  const state = join(S, "state-boundary");
  const { env, notes } = launcherEnv("v2", cand, state, { PATH: process.env.PATH ?? "/usr/bin" });
  // if a spawn ever ran, this marker file would appear — it must never do
  const sentinel = join(S, "sentinel-never-written");
  const markerArgs = ["-e", `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "spawned")`];

  // shape 1 (the production-DB incident): the result wrapped into the env OPTION
  assert.throws(
    () => spawnSandboxed(process.execPath, markerArgs, { env: { env, notes }, cwd: S }),
    (e) => e instanceof EnvRefused && /result\.env/.test(e.message) && e.code === 2
  );
  // shape 2: the result passed as the OPTIONS object itself
  assert.throws(
    () => spawnSandboxed(process.execPath, markerArgs, { env, notes, cwd: S }),
    (e) => e instanceof EnvRefused && /RESULT object was passed as spawn options/.test(e.message)
  );
  // a stage() shaped result is equally refused
  assert.throws(
    () => spawnSandboxed(process.execPath, markerArgs, { env: { candidateDir: cand, manifest: { flavor: "v2" }, env, notes }, cwd: S }),
    EnvRefused
  );
  assert.equal(existsSync(sentinel), false, "no subprocess may be created on any refused shape");
});

test("spawn boundary: sentinel production HOME/DB roots and non-string values are refused before spawn", () => {
  const prodHome = homedir(); // the test runner's real home stands in for the production home
  assert.throws(
    () => assertChildEnv(sandboxEnv({ HOME: prodHome })),
    (e) => e instanceof EnvRefused && /fresh sandbox HOME/.test(e.message)
  );
  assert.throws(
    () => assertChildEnv(sandboxEnv({ XDG_DATA_HOME: join(prodHome, ".local", "share") })),
    (e) => /production opencode data root/.test(e.message),
    "the bare production share is the DB root when XDG_DATA_HOME resolves through it — refused"
  );
  assert.throws(
    () => assertChildEnv(sandboxEnv({ XDG_DATA_HOME: join(prodHome, ".local", "share", "opencode") })),
    (e) => /production opencode data root/.test(e.message)
  );
  assert.throws(
    () => assertChildEnv(sandboxEnv({ XDG_DATA_HOME: join(prodHome, ".local", "share", "opencode", "nested") })),
    (e) => /production opencode data root/.test(e.message),
    "anything INSIDE the production data root is equally refused"
  );
  assert.throws(() => assertChildEnv(sandboxEnv({ HOME: undefined })), /HOME/, "a missing/non-string HOME is a refusal, never an implicit inherit");
  assert.throws(
    () => assertChildEnv(sandboxEnv({ PATH: ["not", "a", "string"] })),
    (e) => e instanceof EnvRefused && /non-string env values/.test(e.message)
  );
  // a correct sandbox env passes and is returned unchanged
  const ok = assertChildEnv(sandboxEnv());
  assert.equal(ok.HOME, join(S, "fresh-home"));
  // stage-time validation (requireSandbox:false) checks the record shape only
  assert.doesNotThrow(() => assertChildEnv(sandboxEnv(), { requireSandbox: false }));
});

test("spawnSandboxed + childExit: trivial child exit awaited; spawn failure captured; graceful SIGTERM first, SIGKILL only on escalation", async () => {
  const env = sandboxEnv();
  // pure node child — no real host binary, no network, no model
  const ok = spawnSandboxed(process.execPath, ["-e", "process.exit(0)"], { env, cwd: S });
  assert.equal((await childExit(ok)).code, 0, "childExit awaits the actual exit");

  const bad = spawnSandboxed(join(S, "definitely-missing-binary"), ["--version"], { env, cwd: S });
  const badResult = await childExit(bad);
  assert.ok(bad.spawnError, "spawn failure is captured, never unhandled");
  assert.equal(badResult.code, null);

  const stuck = spawnSandboxed(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env, cwd: S });
  const t0 = Date.now();
  const stuckResult = await childExit(stuck, { timeoutMs: 400 });
  assert.equal(stuckResult.signal, "SIGTERM", "the default termination is graceful (SIGTERM), not immediate SIGKILL");
  assert.ok(Date.now() - t0 < 5000, "graceful termination is prompt");

  // a child that ignores SIGTERM is escalated to SIGKILL
  const stubborn = spawnSandboxed(process.execPath, ["-e", `process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);`], { env, cwd: S });
  const t1 = Date.now();
  const stubbornResult = await childExit(stubborn, { timeoutMs: 300 });
  assert.equal(stubbornResult.signal, "SIGKILL", "a child ignoring SIGTERM is escalated");
  assert.ok(Date.now() - t1 < 5000, "escalation is prompt (default escalateAfterMs = 2x timeoutMs)");
});

test("childExit on an already-finished child returns the observed state immediately (no waiting on events that cannot recur)", async () => {
  const env = sandboxEnv();
  const guard = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("childExit hung on a finished child")), 3000))]);

  // exit fully observed BEFORE childExit is called
  const done = spawnSandboxed(process.execPath, ["-e", "process.exit(7)"], { env, cwd: S });
  await new Promise((r) => done.on("exit", r));
  const t0 = Date.now();
  const res = await guard(childExit(done));
  assert.equal(res.code, 7, "the observed exit code is returned");
  assert.ok(Date.now() - t0 < 1000, "returns immediately instead of awaiting listeners registered too late");

  // second call on the same child is equally immediate and stable
  assert.equal((await guard(childExit(done))).code, 7);

  // spawn error fully observed BEFORE childExit is called (the error event has
  // already fired — waiting on a fresh 'error' listener would hang forever)
  const failed = spawnSandboxed(join(S, "definitely-missing-binary-2"), ["--version"], { env, cwd: S });
  await childExit(failed);
  const t1 = Date.now();
  const again = await guard(childExit(failed));
  assert.equal(again.code, null);
  assert.ok(again.spawnError, "the captured spawn error is returned on later calls too");
  assert.ok(Date.now() - t1 < 1000, "already-errored children never hang");
});

test("assertChildEnv: explicit DB/config redirects are validated as strictly as HOME/data roots", () => {
  // OPENCODE_DB pointing outside this run's sandbox roots is the incident shape
  assert.throws(
    () => assertChildEnv(sandboxEnv({ OPENCODE_DB: "/var/lib/opencode/opencode.db" })),
    (e) => e instanceof EnvRefused && /OPENCODE_DB/.test(e.message) && /sandbox/.test(e.message),
    "an inherited explicit DB path outside the sandbox is refused"
  );
  assert.throws(
    () => assertChildEnv(sandboxEnv({ OPENCODE_DB: "relative.db" })),
    (e) => /OPENCODE_DB/.test(e.message) && /absolute/.test(e.message)
  );
  // an explicit DB INSIDE this run's sandbox data root is legitimate
  const ok = assertChildEnv(sandboxEnv({ OPENCODE_DB: join(S, "fresh-data", "opencode.db") }));
  assert.equal(ok.OPENCODE_DB, join(S, "fresh-data", "opencode.db"), "in-sandbox explicit DB passes through");
  // config redirects: inherited content/injection vectors are refused outright
  assert.throws(() => assertChildEnv(sandboxEnv({ OPENCODE_CONFIG: "/elsewhere/config.json" })), /OPENCODE_CONFIG/);
  assert.throws(() => assertChildEnv(sandboxEnv({ OPENCODE_CONFIG_CONTENT: '{"x":1}' })), /OPENCODE_CONFIG/);
  // a redirect to a config DIR must at least be absolute
  assert.throws(() => assertChildEnv(sandboxEnv({ OPENCODE_CONFIG_DIR: "relative/config" })), /OPENCODE_CONFIG_DIR.*absolute/);
  assert.doesNotThrow(() => assertChildEnv(sandboxEnv({ OPENCODE_CONFIG_DIR: join(S, "candidate") })));
});

test("prompts: exclusions stay; staged copies byte-identical; anchor transforms are retired (no prune, no task_id translation)", () => {
  const { profile } = loadProfile(join(RUNTIME, "profile.json"));
  const inputs = personalInputs(profile);
  const promptDir = inputs.omoPromptDir.resolved.path;

  // exclusions: Council replacements and pre-optimization backups are still
  // never staged (decision e000070 staging hygiene)
  assert.ok(isExcludedPromptFile("council.md"));
  assert.ok(isExcludedPromptFile("council_append.md"));
  assert.ok(isExcludedPromptFile("orchestrator_append.md.bak-promptopt"));
  assert.ok(!isExcludedPromptFile("orchestrator_append.md"));
  assert.ok(!isExcludedPromptFile("explorer.md"));

  // the retired anchors are gone from the staging vocabulary entirely:
  // BCP session_id / task_id identifiers and metadata fields are never
  // rewritten anywhere, and the old staged-copy transforms no longer exist.
  // 2026-10-06 owner repin (plan upstream-defaults-20261006): the full
  // upstream prompt files (orchestrator.md, explorer.md, …) were DELETED from
  // the pinned sources — the OMO plugin's own prompt lookup applies upstream
  // defaults + the staged appends, so only appends + document-writer.md
  // remain in the prompt lane.
  assert.ok(!existsSync(join(promptDir, "orchestrator.md")), "upstream orchestrator.md is deleted from the pinned sources (upstream lookup applies)");
  assert.ok(!existsSync(join(promptDir, "explorer.md")), "the full explorer prompt pin is retired in the sources (explorer_append.md applies)");
  const appendSrc = readFileSync(join(promptDir, "orchestrator_append.md"), "utf8");
  assert.ok(appendSrc.length > 0);
});

test("skills follow upstream: generated tree consistency, no stock-inherited shadows, guard refuses them", () => {
  const { profile } = loadProfile(join(RUNTIME, "profile.json"));
  // 1) the pinned generated tree resolves cleanly (fresh pins from the build
  //    manifest match the tree on disk — fail-closed if either drifts)
  const inputs = personalInputs(profile);
  const generatedTop = new Set(Object.keys(inputs.skillsDir.resolved.files).map((rel) => rel.split("/")[0]));
  assert.ok(generatedTop.has("codemap") && generatedTop.has("deepwork") && generatedTop.has("oh-my-opencode-slim"), "the three patched skills are staged from the generated tree");

  // 2) no stock-inherited name anywhere in the tree or the pins — a file copy
  //    would shadow the plugin artifact's in-process registration
  for (const name of STOCK_INHERITED_SKILLS) {
    assert.ok(!generatedTop.has(name), `${name} must be inherited from the artifact, never copied`);
  }
  assert.ok(!existsSync(join(inputs.skillsDir.resolved.path, "clonedeps")));
  assert.ok(!existsSync(join(inputs.skillsDir.resolved.path, "reflect")));
  assert.ok(!existsSync(join(inputs.skillsDir.resolved.path, "simplify")));
  assert.ok(!existsSync(join(inputs.skillsDir.resolved.path, "verification-planning")));
  assert.ok(!existsSync(join(inputs.skillsDir.resolved.path, "worktrees")));
  assert.ok(!existsSync(join(inputs.skillsDir.resolved.path, "loop-engineering")), "unregistered stock leftover is not staged either");

  // 3) required resources travel: every generated skill dir carries SKILL.md;
  //    codemap keeps its scripts and companion docs (base directory changes
  //    when shadowing the bundled registration — companions must travel)
  for (const top of generatedTop) {
    assert.ok(existsSync(join(inputs.skillsDir.resolved.path, top, "SKILL.md")), `${top}/SKILL.md present`);
  }
  assert.ok(existsSync(join(inputs.skillsDir.resolved.path, "codemap", "scripts", "codemap.mjs")));
  assert.ok(existsSync(join(inputs.skillsDir.resolved.path, "codemap", "codemap.md")));
  assert.ok(existsSync(join(inputs.skillsDir.resolved.path, "codemap", "README.md")));

  // 4) the auditable deltas actually applied (patch content markers), while
  //    the stock session-pinned deepwork contract stays intact
  const codemap = readFileSync(join(inputs.skillsDir.resolved.path, "codemap", "SKILL.md"), "utf8");
  assert.ok(codemap.includes("navigation index, not mandatory pre-reading"), "codemap navigation-index delta applied");
  assert.ok(codemap.includes("node scripts/codemap.mjs init"), "stock relative script paths kept (relocatable)");
  const deepwork = readFileSync(join(inputs.skillsDir.resolved.path, "deepwork", "SKILL.md"), "utf8");
  assert.ok(deepwork.includes("deepwork never commits on its own initiative"), "user-authorized-commits delta applied");
  assert.ok(deepwork.includes("keep live execution status in the Todo"), "todo-live-status delta applied");
  assert.ok(deepwork.includes("<session-id>.md"), "stock session-pinned deepwork file contract kept (hook embeds the same contract)");
  const omy = readFileSync(join(inputs.skillsDir.resolved.path, "oh-my-opencode-slim", "SKILL.md"), "utf8");
  assert.ok(omy.includes("Built-in agents also accept inline `prompt` and `orchestratorPrompt`"), "inline-prompt fact correction applied");
  assert.ok(omy.includes("shadows the bundled in-process skill"), "stock skill-shadow row kept — it documents this lane's mechanism");
  assert.ok(omy.includes("<project>/.opencode/oh-my-opencode-slim/{preset}/{agent}.md"), "project-local prompt rows applied");

  // 5) the stage guard refuses any skills input carrying an inherited name,
  //    and the runtime list equals the generator's canonical list
  assert.deepEqual([...STOCK_INHERITED_SKILLS].sort(), [...BUILDER_STOCK_INHERITED_SKILLS].sort(), "runtime guard and generator share one canonical inherited set");
  const refusals = refuseStockSkillShadow(["clonedeps/SKILL.md", "codemap/SKILL.md", "reflect/SKILL.md"]);
  assert.equal(refusals.length, 2, "only the inherited names refuse");
  assert.ok(refusals.every((l) => l.includes("shadow") && l.includes("registered in-process")));

  // 6) end-to-end: a staged tree that re-adds a stock-inherited copy refuses
  //    at stage() before anything is written
  const poisonedDir = join(S, "poisoned-skills");
  mkdirSync(join(poisonedDir, "clonedeps"), { recursive: true });
  writeFileSync(join(poisonedDir, "clonedeps", "SKILL.md"), "# clonedeps shadow copy\n");
  for (const [rel, sha] of Object.entries(inputs.skillsDir.resolved.files)) {
    const dest = join(poisonedDir, ...rel.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(inputs.skillsDir.resolved.path, ...rel.split("/"))));
  }
  const { profile: _, profilePath, profileSha256 } = loadProfile(join(RUNTIME, "profile.json"));
  const poisonedProfile = structuredClone(profile);
  poisonedProfile.inputs.skillsDir = { kind: "dir", source: poisonedDir, files: { ...structuredClone(inputs.skillsDir.resolved.files), "clonedeps/SKILL.md": sha256File(join(poisonedDir, "clonedeps", "SKILL.md")) } };
  const poisonOut = join(S, "poisoned-stage-out");
  mkdirSync(poisonOut, { recursive: true });
  assert.throws(
    () => stage({ flavor: "v2", profile: poisonedProfile, profilePath, profileSha256, host: PRIVATE_TEST_HOST_V2, outDir: poisonOut, explicit: { omoPlugin: fakeOmoPluginArtifact() } }),
    (err) => err instanceof StageRefusal && err.report.some((l) => l.includes("clonedeps") && l.includes("shadow") && l.includes("registered in-process"))
  );
  assert.deepEqual(readdirSync(poisonOut), [], "shadow refusal leaves the output dir empty");
});

// ---------------------------------------------------------------------------
// Production cutover lane: private staging, relocatability, compression
// component override, activation integrity, legacy plugin-twin guard.
// Synthetic credentials only — real secret values are never read or shown.

const SYNTH_API_KEY = "SK-TEST-NOT-REAL-cutover-0001";
const SYNTH_TOKEN = "TOK-TEST-NOT-REAL-cutover-0002";

/** Real profile clone whose host config source carries SYNTHETIC credentials. */
function privateProfileClone(dir) {
  const { profile, profilePath, profileSha256 } = loadProfile(join(RUNTIME, "profile.json"));
  const srcPath = join(dir, "synthetic-host-config.json");
  writeFileSync(
    srcPath,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "newapi/glm-5.3",
      default_agent: "orchestrator",
      autoupdate: false,
      provider: {
        newapi: {
          name: "newapi",
          npm: "@ai-sdk/openai-compatible",
          models: { "glm-5.3": { name: "GLM" } },
          options: { baseURL: "http://10.0.0.1:3000/v1", apiKey: SYNTH_API_KEY, token: SYNTH_TOKEN, requestTimeoutMs: 60000 },
          apiKey: SYNTH_API_KEY,
        },
      },
      permission: { external_directory: { "/tmp/**": "allow" } },
      agent: { build: { disable: false }, plan: { disable: true } },
    })
  );
  const clone = JSON.parse(JSON.stringify(profile));
  clone.inputs.hostConfigSource = { kind: "file", source: srcPath, sha256: sha256File(srcPath) };
  return { profile: clone, profilePath, profileSha256 };
}

const PRIVATE_TEST_HOST_V2 = { flavor: "v2", version: "2.0.20", executable: "test://exe", runtimeTested: "2.0.20", minCompatible: "2.0.20" };

test("production-private staging: credentials preserved ONLY in the 0600 opencode.json; names/counts recorded, values never in manifest or notes; default probe staging still scrubs", () => {
  const dir = join(S, "private-stage");
  mkdirSync(dir, { recursive: true });
  const { profile, profilePath, profileSha256 } = privateProfileClone(dir);
  const outDir = join(dir, "out");
  mkdirSync(outDir, { recursive: true });

  const priv = stage({ flavor: "v2", profile, profilePath, profileSha256, host: PRIVATE_TEST_HOST_V2, outDir, explicit: { omoPlugin: fakeOmoPluginArtifact() }, productionPrivate: true });
  const privCfg = readFileSync(join(priv.candidateDir, "opencode.json"), "utf8");
  assert.ok(privCfg.includes(SYNTH_API_KEY) && privCfg.includes(SYNTH_TOKEN), "private production staging keeps the synthetic credential values in the config");
  assert.equal(statSync(join(priv.candidateDir, "opencode.json")).mode & 0o777, 0o600, "the credential-bearing config is 0600 in the candidate");
  assert.ok(privCfg.includes("requestTimeoutMs") && privCfg.includes("baseURL"), "non-credential provider options survive unchanged");

  const { manifest: privManifest } = readStageManifest(priv.candidateDir);
  const manifestText = JSON.stringify(privManifest);
  assert.ok(!manifestText.includes(SYNTH_API_KEY) && !manifestText.includes(SYNTH_TOKEN), "manifest never contains credential VALUES — the file is pinned by sha256 only");
  assert.deepEqual(privManifest.privateProduction, {
    enabled: true,
    configFile: "opencode.json",
    fileMode: "0600",
    preservedCredentialKeys: ["provider.newapi.options.apiKey", "provider.newapi.options.token", "provider.newapi.apiKey"],
    credentialKeyCount: 3,
  }, "exactly the preserved KEY NAMES and their count are recorded");
  const privRecord = privManifest.files.find((f) => f.path === "opencode.json");
  assert.equal(privRecord.mode, "0600", "activation writes the live copy 0600");
  assert.ok(!JSON.stringify(priv.notes).includes(SYNTH_API_KEY), "worker notes never contain credential values");

  // default probe staging on the SAME synthetic source still scrubs
  const probe = stage({ flavor: "v2", profile, profilePath, profileSha256, host: PRIVATE_TEST_HOST_V2, outDir, explicit: { omoPlugin: fakeOmoPluginArtifact() } });
  const probeCfg = readFileSync(join(probe.candidateDir, "opencode.json"), "utf8");
  assert.ok(!probeCfg.includes(SYNTH_API_KEY) && !probeCfg.includes(SYNTH_TOKEN), "default probe staging keeps scrubbing credentials");
  const { manifest: probeManifest } = readStageManifest(probe.candidateDir);
  assert.equal(probeManifest.privateProduction, undefined, "no privateProduction block on probe stages");
  assert.ok(JSON.stringify(probeManifest.notes).includes("dropped BY NAME"), "probe manifest keeps the scrub audit note");
});

test("relocatable candidate: moved stage + removed old staging dir; relative shim/config resolve; CLI activation of a private stage with a hard-link twin leaks no secret; rollback restores", () => {
  const dir = join(S, "relocate");
  mkdirSync(dir, { recursive: true });
  const { profile, profilePath, profileSha256 } = privateProfileClone(dir);
  const outDir = join(dir, "candidates");
  const priv = stage({ flavor: "v2", profile, profilePath, profileSha256, host: PRIVATE_TEST_HOST_V2, outDir, explicit: { omoPlugin: fakeOmoPluginArtifact() }, productionPrivate: true });
  const original = priv.candidateDir;

  // move the candidate to an UNRELATED root and remove the old staging dir
  const moved = join(S, "unrelated-prep", "cand-v2-moved");
  mkdirSync(dirname(moved), { recursive: true });
  renameSync(original, moved);
  rmSync(outDir, { recursive: true, force: true });
  assert.ok(!existsSync(original), "old stage location gone");
  assert.equal(readFileSync(join(moved, "plugins", "omoPlugin", "index.js"), "utf8"), 'export {default} from "./server/dist/server/index.js";\n', "shim stays relative after the move");

  // no staged file references the old staging location
  const { manifest } = readStageManifest(moved);
  for (const f of manifest.files) {
    const bytes = readFileSync(join(moved, ...f.path.split("/")), "utf8");
    assert.ok(!bytes.includes(dir) && !bytes.includes(original), `${f.path} embeds a staging path`);
  }

  // live root with an existing HARD-LINKED opencode.json (production link-count-2)
  const live = join(S, "unrelated-live-root");
  mkdirSync(live, { recursive: true });
  const twin = join(dir, "live-config-twin.json");
  writeFileSync(twin, '{"old":"production-bytes"}\n');
  execFileSync("ln", [twin, join(live, "opencode.json")]);
  adopt({ liveRoot: live, managedPaths: ["opencode.json"] });

  // CLI activation — captured console output must carry NO credential value
  const cli = join(RUNTIME, "bin", "oprofile.mjs");
  const out = execFileSync(process.execPath, [cli, "activate", "--stage", moved, "--into", live], { encoding: "utf8" });
  assert.ok(out.includes("activated"), "CLI activation succeeded");
  assert.ok(!out.includes(SYNTH_API_KEY) && !out.includes(SYNTH_TOKEN), "console output carries no credential values");
  const liveCfg = join(live, "opencode.json");
  assert.ok(readFileSync(liveCfg, "utf8").includes(SYNTH_API_KEY), "private config bytes activated");
  assert.equal(statSync(liveCfg).mode & 0o777, 0o600, "live private config is 0600");
  assert.equal(readFileSync(twin, "utf8"), '{"old":"production-bytes"}\n', "hard-link twin keeps pre-activation bytes");
  assert.equal(statSync(liveCfg).nlink, 1, "managed write replaced the inode (twin untouched)");

  // rollback from the moved stage restores the pre-activation bytes
  const rb = rollback({ liveRoot: live });
  assert.deepEqual(rb.blocked, []);
  assert.equal(readFileSync(liveCfg, "utf8"), '{"old":"production-bytes"}\n', "rollback restored the old live config");
});

test("compression component (owner-frozen wrapper dir): staged copy replaces the stock npm spec in place on v1, removes it on v2; entry index.js needs no shim; unpinned flag refuses", () => {
  // fake frozen wrapper mirroring billion-frozen-20261002: root index.js
  // re-exports ONLY default './node_modules/billion-context/dist/agent/opencode-native.js'
  const frozenDir = join(S, "fake-billion-frozen");
  mkdirSync(join(frozenDir, "node_modules", "billion-context", "dist", "agent"), { recursive: true });
  writeFileSync(join(frozenDir, "index.js"), 'export {default} from "./node_modules/billion-context/dist/agent/opencode-native.js";\n');
  writeFileSync(join(frozenDir, "package.json"), JSON.stringify({ name: "billion-frozen", private: true, version: "2.0.0" }));
  writeFileSync(join(frozenDir, "node_modules", "billion-context", "package.json"), JSON.stringify({ name: "billion-context", version: "0.1.175" }));
  writeFileSync(join(frozenDir, "node_modules", "billion-context", "dist", "agent", "opencode-native.js"), 'export default { id: "billion-context-opencode-native", setup() {}, server: true };\n');
  writeFileSync(join(frozenDir, "node_modules", "billion-context", "dist", "index.js"), 'export {default} from "./agent/opencode-native.js";\n');

  const { profile: baseProfile, profilePath, profileSha256 } = loadProfile(join(RUNTIME, "profile.json"));
  const withCompression = () => {
    const clone = JSON.parse(JSON.stringify(baseProfile));
    clone.components.compressionPlugin = { kind: "artifact-dir", entry: "index.js", flavors: ["v1", "v2"], replacesPlugin: "billion-context@0.1.175" };
    return clone;
  };

  // v2: npm spec removed (auto-discovery loads the staged copy) — no drift
  const outV2 = join(S, "comp-v2");
  mkdirSync(outV2, { recursive: true });
  const resV2 = stage({ flavor: "v2", profile: withCompression(), profilePath, profileSha256, host: PRIVATE_TEST_HOST_V2, outDir: outV2, explicit: { omoPlugin: fakeOmoPluginArtifact(), compressionPlugin: frozenDir } });
  const renderedV2 = JSON.parse(readFileSync(join(resV2.candidateDir, "opencode.json"), "utf8"));
  assert.deepEqual(renderedV2.plugins, [], "stock npm spec removed — the host resolves only the staged frozen copy");
  const wrapperStaged = join(resV2.candidateDir, "plugins", "compressionPlugin", "index.js");
  assert.equal(readFileSync(wrapperStaged, "utf8"), readFileSync(join(frozenDir, "index.js"), "utf8"), "entry index.js staged as-is — no shim over the wrapper's own relative re-export");
  assert.ok(existsSync(join(resV2.candidateDir, "plugins", "compressionPlugin", "node_modules", "billion-context", "dist", "agent", "opencode-native.js")), "full dist + node_modules closure travels with the copy");
  assert.ok(existsSync(join(resV2.candidateDir, "plugins", "compressionPlugin", "node_modules", "billion-context", "dist", "index.js")), "native ../index.js resolve target present");
  assert.equal(resV2.components.compressionPlugin.status, "staged");
  const { manifest: manV2 } = readStageManifest(resV2.candidateDir);
  assert.ok(JSON.stringify(manV2.notes).includes("Stock-plugin override"), "manifest records the override explicitly");

  // v1: relative staged entry REPLACES the spec at its position; ordering preserved
  const hostV1 = { flavor: "v1", version: "1.18.33", executable: "test://exe", runtimeTested: "1.18.33", minCompatible: "1.18.29" };
  const outV1 = join(S, "comp-v1");
  mkdirSync(outV1, { recursive: true });
  const vgDir = join(S, "comp-vg-v1");
  mkdirSync(vgDir, { recursive: true });
  writeFileSync(join(vgDir, "index.js"), 'import { engine } from "./engine.js";\nexport default { id: "vibeguard-fake" };\n');
  writeFileSync(join(vgDir, "engine.js"), "export const engine = () => true;\n");
  const omoV1Dir = join(S, "comp-omo-v1");
  mkdirSync(join(omoV1Dir, "index", "dist"), { recursive: true });
  writeFileSync(join(omoV1Dir, "index", "dist", "index.js"), 'export default { id: "oh-my-opencode-slim" };\n');
  addStockSkillDirs(omoV1Dir);
  const bcpFile = join(S, "comp-blackboard-v1.ts");
  writeFileSync(bcpFile, "export default {};\n");
  const resV1 = stage({ flavor: "v1", profile: withCompression(), profilePath, profileSha256, host: hostV1, outDir: outV1, explicit: { compressionPlugin: frozenDir, vibeguardV1: vgDir, omoPluginV1: omoV1Dir, bcpPlugin: bcpFile } });
  const renderedV1 = JSON.parse(readFileSync(join(resV1.candidateDir, "opencode.json"), "utf8"));
  assert.deepEqual(renderedV1.plugin, [
    "./plugins/compressionPlugin/index.js",
    "./plugins/vibeguardV1/index.js",
    "./plugins/omoPluginV1/index.js",
    "./plugins/comp-blackboard-v1.ts",
  ], "staged frozen copy replaces the npm spec in its first position; profile ordering preserved");
  assert.ok(!JSON.stringify(renderedV1).includes("billion-context@0.1.175"), "npm spec gone — no package resolution at cutover");

  // the override flag WITHOUT a pinned profile definition refuses (no blind
  // dependency acceptance), leaving the output dir empty
  const outX = join(S, "comp-x");
  mkdirSync(outX, { recursive: true });
  const unpinnedProfile = structuredClone(baseProfile);
  delete unpinnedProfile.components.compressionPlugin;
  assert.throws(
    () => stage({ flavor: "v2", profile: unpinnedProfile, profilePath, profileSha256, host: PRIVATE_TEST_HOST_V2, outDir: outX, explicit: { omoPlugin: fakeOmoPluginArtifact(), compressionPlugin: frozenDir } }),
    (err) => err instanceof StageRefusal && err.report.some((l) => l.includes("compressionPlugin") && l.includes("no pinned profile definition"))
  );
  assert.deepEqual(readdirSync(outX), [], "refusal leaves the output dir empty");
});

test("activation integrity gate: dirty/missing candidate files and escaping manifest paths refuse BEFORE any write", () => {
  const srcDir = join(S, "integrity-src");
  const prof = minimalProfile(srcDir);
  const cand = join(S, "integrity-cand");
  mkdirSync(join(cand, "sub"), { recursive: true });
  mkdirSync(join(cand, ".oprofile"), { recursive: true });
  for (const f of prof.files) cpSync(f.source, join(cand, ...f.path.split("/")));
  const manifest = {
    schemaVersion: 1,
    lane: "personal-profile",
    flavor: "v2",
    files: prof.files.map((f) => ({ path: f.path, action: "create", source: f.source, sourceSha256: sha256File(f.source) })),
    limits: {},
  };
  writeFileSync(join(cand, ".oprofile", "profile-manifest.json"), JSON.stringify(manifest));
  const live = join(S, "integrity-live");
  mkdirSync(live, { recursive: true });

  // dirty candidate: staged bytes drift from the manifest
  writeFileSync(join(cand, "a.md"), "TAMPERED");
  const planDirty = planActivation({ candidateDir: cand, liveRoot: live });
  assert.equal(planDirty.ok, false);
  assert.ok(planDirty.conflicts.some((c) => c.includes("a.md") && c.includes("dirty")));
  assert.throws(() => activate({ candidateDir: cand, liveRoot: live }), (e) => e.code === 2 && /dirty/.test(e.message));
  assert.deepEqual(readdirSync(live), [], "nothing written into the live root on refusal");

  // unavailable component: a manifest-listed file missing from the candidate
  writeFileSync(join(cand, "a.md"), "A");
  rmSync(join(cand, "sub", "b.md"));
  assert.throws(() => activate({ candidateDir: cand, liveRoot: live }), (e) => e.code === 2 && /missing/.test(e.message));
  assert.deepEqual(readdirSync(live), []);
  writeFileSync(join(cand, "sub", "b.md"), "B");

  // a manifest path escaping the config root is refused outright
  const evil = join(S, "evil-cand");
  mkdirSync(join(evil, ".oprofile"), { recursive: true });
  writeFileSync(join(evil, "a.md"), "A");
  writeFileSync(
    join(evil, ".oprofile", "profile-manifest.json"),
    JSON.stringify({ ...manifest, files: [{ path: "../escape.md", action: "create", sourceSha256: sha256File(join(srcDir, "a.md")) }] })
  );
  assert.throws(() => activate({ candidateDir: evil, liveRoot: live }), (e) => e.code === 2 && /escapes the config root/.test(e.message));
  assert.ok(!existsSync(join(S, "escape.md")), "no write outside the live root");

  // the clean candidate activates normally
  const planOk = planActivation({ candidateDir: cand, liveRoot: live });
  assert.equal(planOk.ok, true, JSON.stringify(planOk.conflicts));
  const rec = activate({ candidateDir: cand, liveRoot: live });
  assert.equal(rec.files.length, 2);
  assert.equal(readFileSync(join(live, "a.md"), "utf8"), "A");
});

test("legacy auto-discovered twin (plugin/ vs plugins/): activation refuses with owner cleanup steps; unknown files preserved; explicit handover unblocks", () => {
  const srcDir = join(S, "twin-src");
  mkdirSync(srcDir, { recursive: true });
  const bbBytes = "export default {};\n";
  const bbSrc = join(srcDir, "blackboard.ts");
  writeFileSync(bbSrc, bbBytes);
  const cand = join(S, "twin-cand");
  mkdirSync(join(cand, "plugins"), { recursive: true });
  mkdirSync(join(cand, ".oprofile"), { recursive: true });
  writeFileSync(join(cand, "plugins", "blackboard.ts"), bbBytes);
  const manifest = {
    schemaVersion: 1,
    lane: "personal-profile",
    flavor: "v1",
    files: [{ path: "plugins/blackboard.ts", action: "create", source: bbSrc, sourceSha256: sha256File(bbSrc) }],
    limits: {},
  };
  writeFileSync(join(cand, ".oprofile", "profile-manifest.json"), JSON.stringify(manifest));
  const live = join(S, "twin-live");
  mkdirSync(join(live, "plugin"), { recursive: true });
  // the old canonical single-root copy, exactly as production keeps it
  writeFileSync(join(live, "plugin", "blackboard.ts"), bbBytes);
  writeFileSync(join(live, "plugin", "KEEP.txt"), "unrelated owner file — must survive");

  const plan = planActivation({ candidateDir: cand, liveRoot: live });
  assert.equal(plan.ok, false);
  assert.ok(plan.conflicts.some((c) => c.includes("plugin/blackboard.ts") && c.includes("twice")), "the double auto-discovery load is named");
  assert.ok(plan.conflicts.some((c) => c.includes("never deletes unmanaged files")), "the refusal states this lane never deletes unmanaged files");
  assert.throws(() => activate({ candidateDir: cand, liveRoot: live }), (e) => e.code === 2 && /twin/.test(e.message));
  assert.equal(readFileSync(join(live, "plugin", "blackboard.ts"), "utf8"), bbBytes, "old canonical artifact untouched by the refusal");
  assert.ok(!existsSync(join(live, "plugins")), "nothing staged into the live root");
  assert.ok(!existsSync(join(live, ".oprofile")), "no authority or backups created on refusal");

  // owner handover (explicit, backed, outside this lane) removes the twin
  rmSync(join(live, "plugin", "blackboard.ts"));
  const record = activate({ candidateDir: cand, liveRoot: live });
  assert.equal(record.files.length, 1);
  assert.equal(readFileSync(join(live, "plugins", "blackboard.ts"), "utf8"), bbBytes);
  assert.equal(readFileSync(join(live, "plugin", "KEEP.txt"), "utf8"), "unrelated owner file — must survive", "unknown files are preserved");

  const rb = rollback({ liveRoot: live });
  assert.deepEqual(rb.blocked, []);
  assert.ok(!existsSync(join(live, "plugins", "blackboard.ts")), "created file removed on rollback");
  assert.equal(readFileSync(join(live, "plugin", "KEEP.txt"), "utf8"), "unrelated owner file — must survive");
});
