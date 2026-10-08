// personal-profile runtime — readonly-permission focus tests (node:test,
// no network, no model requests, no production writes).
//
// Plan upstream-defaults-20261006 PHASE2 coverage (bounds: render.mjs only —
// stage/profile/builder/core are untouched, and the v2 lane must stay
// byte-for-byte unaffected), narrowed by the 2026-10-06 DELTA review:
//   PROJECTION — deriveV1AgentPermissionMaps projects the EXPLICIT OMO role
//   permission maps into canonical v1 core agent.<id>.permission
//   maps: user-named keys verbatim, artifact-editor denies completed ONLY for
//   roles marked unequivocally readonly (canonical readonly preset role with
//   ≥1 unconditionally-denied artifact editor, or custom role with ALL FOUR
//   unconditionally denied), subagent defaults replicated exactly as the
//   plugin's applyDefaultPermissions produces them today (task-control deny,
//   wait_for_user/marketplace deny, question allow, skill map from the
//   explicit skills list — an OMITTED list falls back to the plugin's default
//   granted skills instead of failing), mcp_* deliberately left to the plugin
//   backfill.
//   ELIGIBILITY — a conditional per-path deny ({"*": "allow",
//   "protected/**": "deny"}) is a scoped restriction: it must NOT turn the
//   role into a globally readonly one, and unclear cases stay with the
//   plugin instead of silently broadening into global tool denies.
//   MERGE — the resolved active preset is the BASE role map and top-level
//   `agents` the OVERRIDE, deep-merged per key (a same-id agents entry
//   overrides only the keys it names); legacy alias roles (explore→explorer)
//   fold into their canonical role first; renderV1 emits the maps as
//   agent.<id>={disable:false, permission} without disturbing the alias
//   pins, the builtin alias disable flags, or any other core root; writer
//   roles (orchestrator/designer/fixer/document-writer) never gain denies.
//   REFUSAL — unsupported OMO shapes refuse with explicit errors instead of
//   inventing policy; a render with NO resolvable OMO config renders exactly
//   as before (report.omoPermissionSource null, no permission keys) so the
//   plugin-managed behavior is unchanged.
//   V2 UNAFFECTED — renderV2 output is identical with and without an
//   inputs.omoConfig; the native `agents` root never carries the derived
//   maps.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderV2, renderV1, deriveV1AgentPermissionMaps } from "../lib/render.mjs";
import { sha256File } from "../lib/hash.mjs";

const RUNTIME = dirname(dirname(fileURLToPath(import.meta.url))); // .../opencode/runtime
let S; // sandbox root

before(() => {
  S = mkdtempSync(join(tmpdir(), "ppl-readonly-perm-"));
});

after(() => {
  rmSync(S, { recursive: true, force: true });
});

// Abridge of the pinned shadow OMO config's role shapes: same permission
// maps, same skills-field presence, same writer/readonly split. REAL PLUGIN
// SHAPE: role entries sit DIRECTLY on the preset object
// (presets.<name>.<role>), next to the council section.
const OMO_CONFIG = {
  $schema: "https://example.invalid/omo.json",
  preset: "newapi",
  disabled_agents: [],
  presets: {
    newapi: {
      council: { default_preset: "default", councillors: {} },
      orchestrator: { permission: { task: { "*": "allow" }, apply_patch: "allow" }, skills: ["writing-plans"] },
      explorer: { permission: { edit: "deny", apply_patch: "deny" }, skills: [] },
      librarian: { permission: { edit: "deny", apply_patch: "deny" }, skills: ["context7-docs"] },
      oracle: { permission: { edit: "deny", write: "deny", apply_patch: "deny", ast_grep_replace: "deny" }, skills: ["find-code-simplifications"] },
      observer: { permission: { edit: "deny", apply_patch: "deny" }, skills: [] },
      designer: { permission: { apply_patch: "allow" }, skills: [] },
      fixer: { permission: { apply_patch: "allow" }, skills: ["use-modern-go"] },
    },
  },
  agents: {
    "lark-operator": {
      permission: { read: "allow", edit: "deny", write: "deny", apply_patch: "deny", ast_grep_replace: "deny", task: "deny", question: "deny", webfetch: "allow" },
      skills: ["lark-doc"],
    },
    "document-writer": { permission: { task: "deny", question: "deny" }, skills: ["lark-doc"] },
  },
};

function writeOmoConfig(config = OMO_CONFIG) {
  const file = join(S, `omo-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return file;
}

function writeHostConfig(extra = {}) {
  const dir = join(S, `host-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "opencode.json");
  writeFileSync(file, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "newapi/glm-5.3",
    provider: { newapi: { options: { baseURL: "https://example.invalid/v1" } } },
    permission: { external_directory: { "/tmp/**": "allow" } },
    compaction: { auto: true },
    plugin: ["stock-a"],
    agent: {
      build: { disable: false },
      plan: { disable: true },
      explore: { disable: true },
      general: { disable: true },
    },
    ...extra,
  }, null, 2) + "\n");
  return file;
}

const TASK_CONTROL = ["task_cancel", "task_message", "task_revive", "task_status", "task_result"];
const AGENT_CONTROL = ["wait_for_user", "marketplace_inspect", "marketplace_manage"];
const ARTIFACT_EDITORS = ["edit", "write", "apply_patch", "ast_grep_replace"];

test("PROJECTION: explicit maps are preserved verbatim and completed exactly like the plugin's own defaults", () => {
  const { entries, applied, skipped } = deriveV1AgentPermissionMaps(OMO_CONFIG);

  // readonly-intent preset roles + custom artifact-readonly agent, nothing else
  assert.deepEqual(Object.keys(entries).sort(), ["explorer", "lark-operator", "librarian", "observer", "oracle"]);

  // explorer: user keys verbatim FIRST (order preserved), artifact editors +
  // plugin-replicated subagent defaults completed after
  const explorer = entries.explorer;
  assert.deepEqual(Object.keys(explorer).slice(0, 2), ["edit", "apply_patch"]);
  assert.equal(explorer.edit, "deny");
  assert.equal(explorer.apply_patch, "deny");
  for (const tool of ARTIFACT_EDITORS) assert.equal(explorer[tool], "deny", `explorer ${tool} deny`);
  for (const tool of [...TASK_CONTROL, ...AGENT_CONTROL]) assert.equal(explorer[tool], "deny", `explorer ${tool} deny`);
  assert.equal(explorer.question, "allow");
  assert.deepEqual(explorer.skill, { "*": "deny" }); // explicit empty skills list → deny-all (plugin parity)

  // oracle: the user already named ALL artifact editors — none is "completed"
  const oracleApplied = applied.find((a) => a.id === "oracle");
  assert.ok(oracleApplied);
  for (const tool of ARTIFACT_EDITORS) assert.ok(!oracleApplied.completedKeys.includes(tool), `oracle ${tool} user-named`);
  assert.deepEqual(entries.oracle.skill, { "*": "deny", "find-code-simplifications": "allow" });

  // lark-operator: user-named question stays "deny" (never overwritten),
  // unrelated user keys (read/webfetch) survive verbatim
  const lark = entries["lark-operator"];
  assert.equal(lark.question, "deny");
  assert.equal(lark.read, "allow");
  assert.equal(lark.webfetch, "allow");
  assert.equal(lark.task, "deny");
  const larkApplied = applied.find((a) => a.id === "lark-operator");
  assert.ok(!larkApplied.completedKeys.includes("question"), "user-named question is not completed");
  assert.ok(!larkApplied.completedKeys.includes("task"), "user-named task is not completed");
  assert.ok(!Object.keys(lark).some((k) => k.startsWith("mcp_")), "mcp_* left to the plugin backfill");

  // writer roles are skipped with reasons — no invented denies
  const skippedIds = skipped.map((s) => s.id).sort();
  assert.deepEqual(skippedIds, ["council", "designer", "document-writer", "fixer", "orchestrator"]);
  assert.ok(skipped.every((s) => typeof s.reason === "string" && s.reason.length > 0));
});

test("MERGE: renderV1 emits canonical agent.<id>.permission entries, preserves alias pins + builtin flags + every other core root", () => {
  const host = writeHostConfig();
  const omo = writeOmoConfig();
  const report = {};
  const rendered = renderV1(
    { hostConfigSource: { resolved: { path: host } }, omoConfig: { resolved: { path: omo } }, stockPlugins: ["stock-a"], pluginReplacements: [] },
    [],
    report
  );

  // alias pins: explorer canonical pin exists AND carries the completed map;
  // the builtin explore keeps its user disable flag verbatim
  assert.deepEqual(report.legacyAliasPins, [{ alias: "explore", canonical: "explorer" }]);
  assert.deepEqual(rendered.agent.explore, { disable: true });
  assert.equal(rendered.agent.explorer.disable, false);
  assert.equal(rendered.agent.explorer.permission.write, "deny");
  assert.equal(rendered.agent.explorer.permission.edit, "deny");

  // derived entries emitted; writer roles and the second alias target absent
  assert.equal(rendered.agent.librarian.permission.write, "deny");
  assert.equal(rendered.agent.observer.permission.edit, "deny");
  assert.equal(rendered.agent.oracle.permission.write, "deny");
  assert.equal(rendered.agent["lark-operator"].permission.write, "deny");
  assert.equal(rendered.agent.orchestrator, undefined);
  assert.equal(rendered.agent.designer, undefined);
  assert.equal(rendered.agent.fixer, undefined);
  assert.equal(rendered.agent["document-writer"], undefined);

  // builtin agents keep their flags; nothing else moved
  assert.deepEqual(rendered.agent.build, { disable: false });
  assert.deepEqual(rendered.agent.plan, { disable: true });
  assert.deepEqual(rendered.agent.general, { disable: true });

  // personal core untouched: model, plugin, compaction intent, global
  // permission policy (no blunt global artifact-editor forbidding)
  assert.equal(rendered.model, "newapi/glm-5.3");
  assert.deepEqual(rendered.plugin, ["stock-a"]);
  assert.deepEqual(rendered.compaction, { auto: false });
  assert.deepEqual(rendered.permission, { external_directory: { "/tmp/**": "allow" } });
  assert.deepEqual(rendered.provider, { newapi: { options: { baseURL: "https://example.invalid/v1" } } });

  // report provenance: pinned source with sha256 + audit trail
  assert.equal(report.omoPermissionSource.resolvedVia, "inputs.omoConfig");
  assert.equal(report.omoPermissionSource.path, omo);
  assert.equal(report.omoPermissionSource.sha256, sha256File(omo));
  assert.deepEqual(report.omoPermissionRoles.map((r) => r.id).sort(), ["explorer", "lark-operator", "librarian", "observer", "oracle"]);
});

test("REFUSAL: unsupported OMO shapes refuse with explicit errors; disabled roles are never emitted", () => {
  assert.throws(
    () => deriveV1AgentPermissionMaps({ preset: "newapi", presets: {} }),
    /preset 'newapi' has no presets entry/
  );
  // an OMITTED skills list no longer refuses (upstream defaults it) — but a
  // PRESENT non-array list still refuses: the projection must not invent a
  // skill policy from a malformed shape
  assert.throws(
    () => deriveV1AgentPermissionMaps({ preset: "p", presets: { p: { explorer: { permission: { edit: "deny" }, skills: "everything" } } } }),
    /refusing to invent a skill policy/
  );
  assert.throws(
    () => deriveV1AgentPermissionMaps({ preset: "p", presets: { p: { explorer: { permission: { edit: "block" }, skills: [] } } } }),
    /is not allow\|deny\|ask/
  );
  assert.throws(
    () => deriveV1AgentPermissionMaps({ preset: "p", presets: { p: { explorer: { permission: { edit: 42 }, skills: [] } } } }),
    /must be an effect string or a \{pattern: effect\} map/
  );

  // disabled_agents: the role is skipped and NOT emitted (a rendered
  // {disable:false} must never resurrect a disabled role)
  const disabled = deriveV1AgentPermissionMaps({ ...OMO_CONFIG, disabled_agents: ["librarian"] });
  assert.equal(disabled.entries.librarian, undefined);
  assert.ok(disabled.skipped.some((s) => s.id === "librarian" && s.reason === "disabled_agents"));
});

test("ELIGIBILITY: conditional per-path denies never imply a readonly role; completion needs unequivocal whole-tool denial", () => {
  const derived = deriveV1AgentPermissionMaps({
    preset: "p",
    disabled_agents: [],
    presets: {
      p: {
        council: {},
        // canonical readonly role, but the marker editor is a SCOPED
        // restriction (allow escape hatch) — not readonly intent
        oracle: {
          skills: ["find-code-simplifications"],
          permission: { edit: { "*": "allow", "protected/**": "deny" } },
        },
        // canonical readonly role gated with "ask" — not an unequivocal denial
        observer: { skills: [], permission: { edit: "ask", apply_patch: { "*": "deny" } } },
        // writer-flavored custom roles with conditional/partial restrictions
        writer: {
          skills: ["use-modern-go"],
          permission: {
            edit: { "*": "allow", "protected/**": "deny" },
            write: { "*": "allow" },
            apply_patch: "allow",
            ast_grep_replace: { "legacy/**": "deny" },
          },
        },
        "document-writer": { skills: ["lark-doc"], permission: { task: "deny", question: "deny" } },
        // custom role with ALL FOUR artifact editors unconditionally denied —
        // eligible (explicit catch-all maps without allow/ask exceptions)
        "protected-editor": {
          skills: [],
          permission: {
            edit: "deny",
            write: { "*": "deny", "src/**": "deny" },
            apply_patch: { "*": "deny", "docs/**": "deny" },
            ast_grep_replace: { "*": "deny" },
          },
        },
      },
    },
    agents: {},
  });

  // the brief's exact hazard: {"*":"allow","protected/**":"deny"} on edit must
  // NOT become global write/apply/AST denies — no entry is emitted at all
  assert.equal(derived.entries.writer, undefined);
  assert.equal(derived.entries.oracle, undefined);
  assert.equal(derived.entries["document-writer"], undefined);
  assert.ok(derived.skipped.some((s) => s.id === "writer" && /unequivocal/.test(s.reason)));
  assert.ok(derived.skipped.some((s) => s.id === "oracle" && /unequivocal/.test(s.reason)));

  // observer: "ask" is a gate, not a denial — but its apply_patch map IS an
  // unequivocal whole-tool denial, so the canonical readonly role stays
  // eligible; the ask-gated edit and the explicit map stay verbatim, only
  // absent editors/defaults are completed
  const observer = derived.entries.observer;
  assert.ok(observer, "canonical role with one unequivocal editor denial stays eligible");
  assert.equal(observer.edit, "ask");
  assert.deepEqual(observer.apply_patch, { "*": "deny" });
  assert.equal(observer.write, "deny");
  assert.equal(observer.ast_grep_replace, "deny");

  // all-four-unconditional custom role still completes (its own absent keys
  // only — its explicit editor maps stay verbatim)
  const custom = derived.entries["protected-editor"];
  assert.ok(custom, "custom all-four-denied role stays eligible");
  assert.equal(custom.edit, "deny"); // explicit string map preserved verbatim
  assert.deepEqual(custom.write, { "*": "deny", "src/**": "deny" }); // explicit map verbatim
  assert.deepEqual(custom.apply_patch, { "*": "deny", "docs/**": "deny" });
  assert.deepEqual(custom.ast_grep_replace, { "*": "deny" });
  for (const tool of [...TASK_CONTROL, ...AGENT_CONTROL]) assert.equal(custom[tool], "deny", `custom ${tool} deny`);
  assert.deepEqual(custom.skill, { "*": "deny" });
});

test("ELIGIBILITY: path-only deny and empty maps do not establish whole-tool denial", () => {
  for (const edit of [{ "protected/**": "deny" }, {}]) {
    const derived = deriveV1AgentPermissionMaps({
      preset: "p",
      presets: { p: { explorer: { skills: [], permission: { edit } } } },
    });
    assert.equal(derived.entries.explorer, undefined);
  }
});

test("MERGE PRECEDENCE: resolved preset is the BASE role map, top-level agents the OVERRIDE (per-key deep merge); alias roles fold canonically", () => {
  const derived = deriveV1AgentPermissionMaps({
    preset: "p",
    disabled_agents: [],
    presets: {
      p: {
        council: {},
        explorer: {
          skills: [],
          permission: { edit: "deny", apply_patch: "deny", bash: "ask" },
        },
        // legacy alias key folds INTO explorer before the agents merge
        explore: { permission: { webfetch: "deny" }, skills: [] },
      },
    },
    agents: {
      // partial same-id override: only apply_patch is re-shaped; every other
      // preset/alias key survives (upstream deepMerge semantics — the agents
      // entry must NOT replace the whole preset role map)
      explorer: { permission: { apply_patch: { "vendor/**": "allow", "*": "deny" } }, skills: [] },
    },
  });

  const explorer = derived.entries.explorer;
  assert.equal(explorer.edit, "deny"); // preset key survives the override
  assert.equal(explorer.bash, "ask"); // preset key survives the override
  assert.equal(explorer.webfetch, "deny"); // folded from the alias role
  // agents override wins ONLY for the key it names — and a conditional map it
  // names stays verbatim (present keys are never rewritten by completion)
  assert.deepEqual(explorer.apply_patch, { "vendor/**": "allow", "*": "deny" });
  // completion fills only what nobody named
  for (const tool of ["write", "ast_grep_replace"]) assert.equal(explorer[tool], "deny", `explorer ${tool} completed`);
  const appliedExplorer = derived.applied.find((a) => a.id === "explorer");
  assert.ok(appliedExplorer.completedKeys.includes("write"));
  assert.ok(appliedExplorer.completedKeys.includes("ast_grep_replace"));
  assert.ok(!appliedExplorer.completedKeys.includes("apply_patch"), "user-shaped apply_patch is not completed");
  // the alias key itself is not emitted as a separate role
  assert.equal(derived.entries.explore, undefined);
});

test("SKILLS: an omitted list falls back to the plugin's default granted skills (no refusal); disabled_skills fold as denies", () => {
  const derived = deriveV1AgentPermissionMaps({
    preset: "p",
    disabled_agents: [],
    disabled_skills: ["context7-docs"],
    presets: {
      p: {
        council: {},
        // oracle omits skills: upstream default-grants simplify +
        // requesting-code-review (pinned 3.0.1 dist); explorer grants nothing
        oracle: { permission: { edit: "deny" } },
        explorer: { permission: { edit: "deny" } },
        librarian: { skills: ["context7-docs", "gh-grep-docs"], permission: { edit: "deny" } },
      },
    },
    agents: {},
  });
  // disabled_skills fold as denies into every skill map, including the
  // default-granted path
  assert.deepEqual(derived.entries.oracle.skill, {
    "*": "deny",
    simplify: "allow",
    "requesting-code-review": "allow",
    "context7-docs": "deny",
  });
  assert.deepEqual(derived.entries.explorer.skill, { "*": "deny", "context7-docs": "deny" });
  // named-but-disabled skill is denied, the other named skill allowed
  assert.deepEqual(derived.entries.librarian.skill, {
    "*": "deny",
    "gh-grep-docs": "allow",
    "context7-docs": "deny",
  });
});

test("NO OMO CONFIG: render stays exactly as before — no permission keys, report.omoPermissionSource null", () => {
  const host = writeHostConfig(); // isolated dir: no sibling OMO config
  const report = {};
  const rendered = renderV1(
    { hostConfigSource: { resolved: { path: host } }, stockPlugins: ["stock-a"], pluginReplacements: [] },
    [],
    report
  );
  assert.equal(report.omoPermissionSource, null);
  assert.deepEqual(report.omoPermissionRoles, []);
  assert.deepEqual(report.omoPermissionSkipped, []);
  for (const [id, entry] of Object.entries(rendered.agent)) {
    assert.equal(entry.permission, undefined, `agent.${id} carries no permission map`);
  }
  assert.deepEqual(rendered.agent.explore, { disable: true });
});

test("SIBLING FALLBACK: the OMO config staged next to the host config source is used and recorded", () => {
  const host = writeHostConfig();
  const dir = dirname(host);
  const omoSibling = join(dir, "oh-my-opencode-slim.json");
  writeFileSync(omoSibling, JSON.stringify(OMO_CONFIG, null, 2) + "\n");
  const report = {};
  const rendered = renderV1(
    { hostConfigSource: { resolved: { path: host } }, stockPlugins: [], pluginReplacements: [] },
    [],
    report
  );
  assert.equal(report.omoPermissionSource.resolvedVia, "hostConfigSource-sibling");
  assert.equal(report.omoPermissionSource.path, omoSibling);
  assert.equal(report.omoPermissionSource.sha256, sha256File(omoSibling));
  assert.equal(rendered.agent.explorer.permission.write, "deny");
});

test("V2 UNAFFECTED: renderV2 output is identical with and without an OMO config; no permission maps leak into the native lane", () => {
  // Build the v2 source directly: native `agents` root, no legacy `agent`.
  const v2File = join(S, "v2-host.json");
  writeFileSync(v2File, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "newapi/glm-5.3",
    provider: { newapi: { options: { baseURL: "https://example.invalid/v1" } } },
    permission: { external_directory: { "/tmp/**": "allow" } },
    plugins: ["stock-b"],
    agents: { explorer: { mode: "subagent" } },
  }, null, 2) + "\n");
  const promptFile = join(S, "lark-operator.md");
  writeFileSync(promptFile, "---\ndescription: fake\n---\nfake lark body\n");
  const omo = writeOmoConfig();
  const base = { hostConfigSource: { resolved: { path: v2File } }, larkOperatorPrompt: { resolved: { path: promptFile } }, stockPlugins: ["stock-b"], pluginReplacements: [] };
  const without = renderV2(base, {});
  const withOmo = renderV2({ ...base, omoConfig: { resolved: { path: omo } } }, {});
  assert.deepEqual(withOmo, without, "v2 render bytes identical with an OMO config present");
  assert.equal(without.agent, undefined, "v2 keeps the native agents root only");
  for (const [id, entry] of Object.entries(without.agents)) {
    assert.equal(entry.permission, undefined, `v2 agents.${id} carries no derived permission map`);
  }
  assert.deepEqual(without.agents["lark-operator"], { system: "fake lark body", mode: "all" });
  assert.deepEqual(without.compaction, { auto: false });
});
