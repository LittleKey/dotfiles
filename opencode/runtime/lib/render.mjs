// personal-profile runtime — v1/v2 config rendering.
//
// Evidence base:
// - v2.0.20 verified candidate (owner fixture personal-profile-native-v2):
//   native `agents` root ONLY (never legacy `agent`), explorer/lark-operator
//   explicit systems, plugins: [] with plugin packages under plugins/.
// - v1.18.33 production: legacy `agent` root, `plugin` key, compaction.auto
//   false (ACP compression era intent — preserved on v1 only).
//
// Hard rule (implementation brief §1): NEVER emit legacy `agent` and native
// `agents` roots in the same document, and never blend v1/v2 permission or
// delegation vocabulary. Personal model/prompt choices always win; this
// renderer copies them verbatim and never invents defaults for them.
//
// Permission migration (v2 lane only): the legacy `permission` root is
// converted into the native ordered `permissions` ruleset, but ONLY for
// shapes whose v2 action IDs are provable from the pinned @opencode/schema
// (2.0.20). Every other v1 permission name is refused with an explicit
// error instead of being renamed by guesswork (see
// convertLegacyPermissionToV2).

import { existsSync, readFileSync } from "node:fs";
import { dirname as pathDirname, join as pathJoin } from "node:path";
import { sha256File } from "./hash.mjs";

const CONFIG_SCHEMA = "https://opencode.ai/config.json";

export function stringifyConfig(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

/** Split lark-operator.md frontmatter the way profile-v2.py did: body = parts[2].strip(). */
export function frontmatterBody(md) {
  const text = md.toString("utf8");
  if (!text.startsWith("---")) {
    throw new Error("lark-operator prompt is missing frontmatter (expected leading '---')");
  }
  const parts = text.split("---", 3);
  if (parts.length < 3) {
    throw new Error("lark-operator prompt frontmatter is unterminated");
  }
  return parts[2].trim();
}

// Credential-named keys are dropped from copied provider options BY NAME —
// values are never printed, never logged, never archived anywhere. The KEY
// NAMES are recorded so the owner can audit what the candidate omits.
//
// Private production staging exception (opts.preserveCredentials): the same
// credential-named keys are PRESERVED instead of dropped, so the rendered
// config keeps authentication for the production cutover. The guardrails do
// not change: only the KEY NAMES are recorded (never values), the rendered
// bytes exist only as a sha256 in the manifest, and the staged/live file is
// written mode 0600 (stage.mjs / activate.mjs honor the record's mode).
const CREDENTIAL_KEY = /^(?:pass(?:word)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credential|auth[-_]?token|session[-_]?key)$/i;

/**
 * Build the shared personal core from the pinned production host config
 * source. Per profile-composition-completion §3 this is a PRESERVING pass,
 * not a whitelist: unrelated user settings survive verbatim, and provider
 * entries keep every user option (baseURL, labels, anything non-secret).
 * Only two things are changed:
 *   - roots this lane owns per flavor (`plugin`/`plugins`, `agent`/`agents`,
 *     `compaction`) are removed here and re-added by the flavor renderer;
 *   - credential-named keys in provider options are dropped BY NAME and
 *     recorded in `droppedCredentialKeys` (names only — never values), or —
 *     with opts.preserveCredentials (explicit private production staging) —
 *     kept verbatim and recorded in `preservedCredentialKeys` (names only).
 */
export function personalCore(sourceConfig, opts = {}) {
  const droppedCredentialKeys = [];
  const preservedCredentialKeys = [];
  const out = { ...sourceConfig };
  out.$schema = sourceConfig.$schema ?? CONFIG_SCHEMA;
  delete out.plugin;
  delete out.plugins;
  delete out.agent;
  delete out.agents;
  delete out.compaction;
  if (out.provider) {
    const providers = {};
    for (const [pid, prov] of Object.entries(sourceConfig.provider)) {
      const copy = { ...prov };
      if (copy.options && typeof copy.options === "object" && !Array.isArray(copy.options)) {
        const options = {};
        for (const [key, value] of Object.entries(copy.options)) {
          if (CREDENTIAL_KEY.test(key)) {
            const sink = opts.preserveCredentials ? preservedCredentialKeys : droppedCredentialKeys;
            sink.push(`provider.${pid}.options.${key}`);
            if (!opts.preserveCredentials) continue;
            options[key] = value;
            continue;
          }
          options[key] = value;
        }
        copy.options = options;
      }
      for (const key of Object.keys(copy)) {
        if (key !== "options" && CREDENTIAL_KEY.test(key)) {
          const sink = opts.preserveCredentials ? preservedCredentialKeys : droppedCredentialKeys;
          sink.push(`provider.${pid}.${key}`);
          if (opts.preserveCredentials) continue;
          delete copy[key];
        }
      }
      providers[pid] = copy;
    }
    out.provider = providers;
  }
  return { core: out, droppedCredentialKeys, preservedCredentialKeys };
}

// v1 legacy `permission` root → native v2 `permissions` ruleset.
//
// Native v2 shape (pinned @opencode/schema 2.0.20, config root): ordered
// Array<{action, resource, effect: "allow"|"deny"|"ask"}>; last matching
// rule wins — the shipped default ruleset puts the broad `*`/`*` allow
// first with specific refinements after. v1 pattern maps were resolved by
// the same last-match convention, so a 1:1 order-preserving mapping keeps
// the meaning intact.
//
// Convertible ONLY where the v2 action ID is provable from the pinned
// schema: `external_directory` (the shipped agent default ruleset uses that
// action with glob resources; a `*` resource and the three effects are
// schema-proven too). Any other v1 permission name — edit/bash/webfetch/
// write/apply_patch/tools/… — is REFUSED: v2 renamed the action vocabulary
// and the pinned types provide no equivalence for those names, so a rename
// could silently widen what the host allows. An already-native `permissions`
// array is kept verbatim; a non-empty legacy root together with a non-empty
// native array is refused (rule order across the two sources cannot be
// preserved, and appending would change which rule matches last).
const CONVERTIBLE_V1_PERMISSION_ACTIONS = new Set(["external_directory"]);
const RULE_EFFECTS = new Set(["allow", "deny", "ask"]);
// JS iterates integer-like keys ahead of insertion order regardless of
// position — a pattern that is a plain integer cannot preserve rule order.
const INTEGER_LIKE_KEY = /^(?:0|[1-9]\d*)$/;

function convertLegacyPermissionToV2(rendered, srcPath) {
  const legacyEntries = Object.entries(rendered.permission ?? {});
  const native = rendered.permissions;
  if (
    legacyEntries.length > 0 &&
    native != null &&
    !(Array.isArray(native) && native.length === 0)
  ) {
    throw new Error(
      `host config source carries BOTH legacy 'permission' and native 'permissions' policy — refusing to blend rule order (add ${srcPath})`
    );
  }
  delete rendered.permission;
  if (legacyEntries.length === 0) {
    // JSON null in the native slot is not a ruleset — omit rather than emit
    // an invalid value or invent a default ruleset.
    if (native === null) delete rendered.permissions;
    return;
  }
  const rules = [];
  for (const [name, value] of legacyEntries) {
    if (!CONVERTIBLE_V1_PERMISSION_ACTIONS.has(name)) {
      throw new Error(
        `legacy permission '${name}' has no pinned-2.0.20 native v2 action-ID equivalence — refusing to invent one (v2 renamed the action vocabulary; v1 names like edit/apply_patch/write/tools are not schema-proven) (add ${srcPath})`
      );
    }
    if (typeof value === "string") {
      if (!RULE_EFFECTS.has(value)) {
        throw new Error(`legacy permission '${name}' effect ${JSON.stringify(value)} is not allow|deny|ask (add ${srcPath})`);
      }
      rules.push({ action: name, resource: "*", effect: value });
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`legacy permission '${name}' value must be an effect string or a {pattern: effect} map (add ${srcPath})`);
    }
    for (const [pattern, effect] of Object.entries(value)) {
      if (INTEGER_LIKE_KEY.test(pattern)) {
        throw new Error(
          `legacy permission '${name}' pattern ${JSON.stringify(pattern)} is integer-like — JS key reordering would silently change rule order (add ${srcPath})`
        );
      }
      if (typeof effect !== "string" || !RULE_EFFECTS.has(effect)) {
        throw new Error(
          `legacy permission '${name}' pattern ${JSON.stringify(pattern)} effect must be allow|deny|ask, got ${JSON.stringify(effect)} (add ${srcPath})`
        );
      }
      rules.push({ action: name, resource: pattern, effect });
    }
  }
  rendered.permissions = rules;
}

/**
 * Render the v2 native profile (fixture-faithful + preserved personal policy).
 * inputs.resolved entries: agentsMd (unused in JSON), omoConfig (unused in
 * JSON — copied verbatim), explorerPrompt (OPTIONAL — when absent, no inline
 * explorer `system` is rendered and upstream default + explorer_append.md
 * applies), larkOperatorPrompt, hostConfigSource.
 * inputs.preserveCredentials: private production staging — keep credential-
 * named provider keys verbatim (report records KEY NAMES only).
 * inputs.pluginReplacements: [{spec, relEntry}] — staged component overrides;
 * any stockPlugins spec named here is REMOVED from the rendered plugins array
 * (the staged copy under plugins/<name>/index.js is picked up by v2
 * auto-discovery, so the npm spec must go to avoid a second, drifting load).
 * `report` (optional) receives render metadata: droppedCredentialKeys and/or
 * preservedCredentialKeys.
 */
export function renderV2(inputs, report = {}) {
  const src = JSON.parse(readFileSync(inputs.hostConfigSource.resolved.path, "utf8"));
  const { core, droppedCredentialKeys, preservedCredentialKeys } = personalCore(src, {
    preserveCredentials: Boolean(inputs.preserveCredentials),
  });
  if (report.droppedCredentialKeys === undefined) report.droppedCredentialKeys = droppedCredentialKeys;
  else report.droppedCredentialKeys.push(...droppedCredentialKeys);
  if (report.preservedCredentialKeys === undefined) report.preservedCredentialKeys = preservedCredentialKeys;
  else report.preservedCredentialKeys.push(...preservedCredentialKeys);
  const legacy = src.agent ?? {};
  const native = src.agents ?? {};
  if (Object.keys(legacy).length > 0 && Object.keys(native).length > 0) {
    throw new Error(`host config source carries BOTH legacy 'agent' and native 'agents' roots — refusing to blend (add ${inputs.hostConfigSource.resolved.path})`);
  }
  const agents = {};
  for (const [id, val] of Object.entries(legacy)) {
    const keys = Object.keys(val ?? {}).sort();
    if (keys.join(",") !== "disable") {
      throw new Error(`legacy agent '${id}' has unexpected keys [${keys}] — only {disable} is convertible`);
    }
    agents[id] = { disabled: Boolean(val.disable) };
  }
  const larkBody = frontmatterBody(readFileSync(inputs.larkOperatorPrompt.resolved.path, "utf8"));
  // explorerPrompt is OPTIONAL (phase-1 follow-upstream): when the profile no
  // longer pins a full explorer prompt replacement, the upstream default
  // prompt + any explorer_append.md applies via the OMO prompt lookup, and no
  // inline `system` is rendered for it at all (an inline prompt would override
  // the file prompt and shadow upstream defaults).
  if (inputs.explorerPrompt?.resolved?.path) {
    agents.explorer = { system: readFileSync(inputs.explorerPrompt.resolved.path, "utf8") };
  }
  agents["lark-operator"] = { system: larkBody, mode: "all" };
  // GOAL2 note (compatibility remediation): v2 gets NO alias pin — see the
  // LEGACY_ALIAS_PINS comment above: the plugin snapshots the draft before
  // config agents exist, so no rendered config entry can prevent the
  // builtin-explore alias clobber on v2 (blocker reported, upstream/plugin
  // fix required). v1 renders the pin (see renderV1).
  // compaction.auto=false is part of the personal intent AND of the verified
  // Native refers to the plugin's integration route, not a built-in engine:
  // the pinned external package must still be explicitly configured.
  const replacedSpecs = new Set((inputs.pluginReplacements ?? []).map((r) => r.spec));
  const rendered = {
    ...core,
    plugins: (inputs.stockPlugins ?? []).filter((spec) => !replacedSpecs.has(spec)),
    compaction: { auto: false },
    agents,
  };
  convertLegacyPermissionToV2(rendered, inputs.hostConfigSource.resolved.path);
  return rendered;
}

// OMO legacy agent alias pins (compatibility remediation, plan
// upstream-defaults-20261006 GOAL2). The pinned OMO 3.0.1 plugin artifact
// carries AGENT_ALIASES { explore→explorer, frontend-ui-ux-engineer→designer }
// (src/config/constants.ts) and its registry build resolves a host config
// entry for a canonical OMO agent as hostEntries[name] ?? hostEntries[
// displayName] ?? hostEntries[alias], then Object.assigns the FIRST hit onto
// the agent's SDK entry. A source `agent.explore.disable=true` therefore has
// a second, non-obvious effect on v1: the plugin merges {disable:true} from
// the alias name onto the OMO explorer entry and the host drops the agent
// entirely (evidence: effective-probe r11 GET /agent — 18 agents, no
// explorer; task(subagent_type='explorer') → 'Unknown agent type: explorer').
// When the source disables an alias name WITHOUT a canonical entry, the v1
// renderer adds a minimal canonical pin { disable:false } so the plugin's
// first-hit lookup resolves the canonical entry and never falls back to the
// alias. The stock v1 builtin of the alias name keeps its own untouched
// flag — agent.explore.disable=true still disables the builtin explore agent
// (that user intent is preserved verbatim). No plugin patch, no rename, no
// prompt copy: the OMO explorer keeps its upstream prompt + explorer_append.
//
// v2 has NO config-level fix for the same alias merge (empirically settled in
// remediation case remediation-v2-20261006-r2, host 2.0.20 + pinned dist):
// the plugin captures the draft snapshot INSIDE its own agent-transform
// callback (captureAgentDraft → draft.list() → registryBridge.finalize({agent:
// nativeAgentSnapshot.agents, ...})), and the host's config-agent transform
// runs AFTER that capture — proven by the phase-1 r2 evidence (the old
// candidate carried agents.explore.disabled=true and the builtin explore was
// STILL in the snapshot and STILL Object.assign-clobbered the OMO explorer
// prompt) and re-proven here (a rendered canonical agents.explorer={mode:
// "subagent"} pin did not change the served prompt: the builtin "You are a
// file search specialist..." text reached the model regardless). The first-hit
// lookup therefore always resolves the alias to the builtin snapshot for ANY
// configuration — fixing it requires a plugin/upstream change (skip builtin
// snapshots in the alias fallback), which is outside this lane's bounds. v1 is
// different: the v1 host reads the rendered config agent map directly
// (plugin config hook merges managedAgentConfig into opencodeConfig.agent), so
// a rendered canonical entry IS visible to the v1 plugin and the pin works.
export const LEGACY_ALIAS_PINS = Object.freeze({
  explore: "explorer",
  "frontend-ui-ux-engineer": "designer",
});

/** Mutates the legacy map; returns the pins applied (for the render report). */
function applyLegacyAliasPins(legacy) {
  const applied = [];
  for (const [alias, canonical] of Object.entries(LEGACY_ALIAS_PINS)) {
    const aliasEntry = legacy[alias];
    if (!aliasEntry || aliasEntry.disable !== true) continue;
    if (Object.prototype.hasOwnProperty.call(legacy, canonical)) continue;
    legacy[canonical] = { disable: false };
    applied.push({ alias, canonical });
  }
  return applied;
}

// OMO agent permission completion (upstream-defaults-20261006 phase 2,
// narrowed by the 2026-10-06 delta review: conditional per-path denies no
// longer imply a globally readonly role).
//
// The pinned OMO 3.0.1 plugin injects the user preset's per-agent `permission`
// maps into the v1 host config (definition build → applyOverrides → registry
// permission finalization → config hook merges managedAgentConfig into
// opencodeConfig.agent), and the v1 host ENFORCES those maps by removing
// fully-denied tools from the agent's advertised tool schema (empirically
// proven: the oracle preset names `write: "deny"` and the oracle agent serves
// no write tool at all; see the effective-probe evidence). The gap is NOT the
// host — it is that the explorer/librarian/observer preset maps only name
// `edit`/`apply_patch` and never `write`/`ast_grep_replace`, so those
// artifact-editor tools stay advertised and allowed (the observed explorer
// write success).
//
// The renderer therefore projects the EXPLICIT user maps into canonical v1
// core `agent.<id>.permission` maps itself: user-named keys are copied
// verbatim (user intent always wins), and only keys the plugin itself would
// have produced anyway are completed:
//   - the artifact-editor set (deny) — ONLY for a role the user marked
//     unequivocally readonly: a canonical known readonly preset role
//     (oracle/explorer/librarian/observer) with at least one artifact editor
//     unconditionally denied, or a custom role with ALL FOUR artifact editors
//     explicitly and unconditionally denied. A conditional per-path map like
//     {"*": "allow", "protected/**": "deny"} is a scoped restriction — it
//     must NOT become a global write/apply/AST deny (approval restores
//     upstream intent, it does not invent global rules from partial
//     restrictions);
//   - the same subagent defaults applyDefaultPermissions derives today
//     (task-control deny, wait_for_user/marketplace deny, question allow,
//     skill map replicated from the role's explicit `skills` list);
//   - `mcp_*` keys are deliberately NOT emitted: the plugin backfills them
//     from the role's mcps list at registry finalization.
// Role maps are evaluated AFTER the upstream merge: the resolved active
// preset's role map is the BASE and the top-level `agents` map the OVERRIDE,
// deep-merged per key — a same-id agents entry overrides only the keys it
// names (nested permission maps merge per-key) instead of replacing the whole
// role — with legacy alias keys (explore→explorer,
// frontend-ui-ux-engineer→designer) folded into their canonical role first,
// mirroring the pinned plugin's runtime.agents().
// A role is completed only when its effective map exists and is an object;
// string-form maps ({"*": effect}) are left to the plugin untouched, roles
// without an effective map are skipped, and roles in `disabled_agents` are
// never emitted. Writer roles (orchestrator/designer/fixer) and custom
// non-readonly agents (document-writer) never gain denies — nothing here
// bluntly forbids parent writes or removes tools beyond the completed map.
const OMO_ARTIFACT_EDITOR_TOOLS = ["edit", "write", "apply_patch", "ast_grep_replace"];
const OMO_TASK_CONTROL_TOOLS = ["task_cancel", "task_message", "task_revive", "task_status", "task_result"];
const OMO_AGENT_CONTROL_TOOLS = ["wait_for_user", "marketplace_inspect", "marketplace_manage"];
// Canonical known readonly preset roles — the ONLY preset roles for which a
// single unconditionally-denied artifact editor may stand for readonly intent.
const OMO_READONLY_PRESET_ROLES = new Set(["oracle", "explorer", "librarian", "observer"]);
// Pinned plugin AGENT_ALIASES (omoPluginV1 3.0.1 dist): alias role entries
// fold into their canonical role before preset/agents merging.
const OMO_AGENT_ALIASES = { explore: "explorer", "frontend-ui-ux-engineer": "designer" };
// Pinned plugin default granted skills (omoPluginV1 3.0.1 dist:
// CUSTOM_SKILLS + PERMISSION_ONLY_SKILLS → getDefaultGrantedSkillNames),
// applied ONLY when a role omits its `skills` list entirely — upstream never
// fails on an omitted list, so neither may the permission projection.
// Stable-version table: re-derive from the pinned dist if the plugin pin moves.
const OMO_DEFAULT_GRANTED_SKILLS = {
  oracle: ["simplify", "requesting-code-review"],
  orchestrator: ["codemap", "clonedeps", "deepwork", "reflect", "worktrees"],
};

/**
 * True ONLY for an unconditional whole-tool denial: the "deny" effect string,
 * or an explicit catch-all deny map with no exception. A path-only deny map
 * is insufficient evidence of whole-tool denial, irrespective of inherited
 * defaults; neither it nor an empty map may imply a globally readonly role.
 */
function omoUnconditionallyDenied(value) {
  if (value === "deny") return true;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value["*"] === "deny" && Object.values(value).every((effect) => effect === "deny");
  }
  return false;
}

/** Upstream deepMerge: override wins per key; plain objects merge recursively. */
function omoDeepMergeRoleMaps(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = merged[key];
    merged[key] =
      baseValue !== null && typeof baseValue === "object" && !Array.isArray(baseValue) &&
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? omoDeepMergeRoleMaps(baseValue, value)
        : value;
  }
  return merged;
}

/** Fold legacy alias role keys into their canonical roles (deep-merging collisions). */
function omoCanonicalizeRoleMap(map) {
  const canonical = {};
  for (const [name, entry] of Object.entries(map)) {
    const id = OMO_AGENT_ALIASES[name] ?? name;
    canonical[id] = canonical[id] !== undefined ? omoDeepMergeRoleMaps(canonical[id], entry) : entry;
  }
  return canonical;
}

/**
 * Replicates the plugin's getSkillPermissionsForAgent. An explicit `skills`
 * list (even empty) denies everything it does not grant; an OMITTED list
 * never throws — upstream falls back to the role's default granted skills
 * (OMO_DEFAULT_GRANTED_SKILLS). `disabledSkills` (config `disabled_skills`)
 * deny their names in both paths, exactly as the plugin folds them.
 */
function omoSkillMap(skills, role, disabledSkills) {
  if (skills !== undefined && !Array.isArray(skills)) {
    throw new Error(
      `OMO role '${role}' carries an explicit permission map but its 'skills' field is ${JSON.stringify(skills)} — refusing to invent a skill policy (name the skills list explicitly or drop the permission map)`
    );
  }
  const list = skills ?? OMO_DEFAULT_GRANTED_SKILLS[role] ?? [];
  const map = { "*": "deny" };
  for (const entry of list) {
    if (typeof entry !== "string") {
      throw new Error(`OMO role '${role}' skills entry ${JSON.stringify(entry)} is not a string (add explicit plugin config instead)`);
    }
    if (entry === "*") map["*"] = "allow";
    else if (entry.startsWith("!")) map[entry.slice(1)] = "deny";
    else if (!disabledSkills.has(entry)) map[entry] = "allow";
  }
  for (const name of disabledSkills) map[name] = "deny";
  return map;
}

/**
 * Derive canonical v1 agent.<id>.permission maps from an explicit OMO
 * configuration (the user preset's per-role maps plus custom `agents`).
 * Returns { entries, applied, skipped } where entries maps agent id →
 * permission object, applied records which keys each map completed beyond the
 * user's explicit keys, and skipped records roles intentionally left to the
 * plugin. Throws (refuses) instead of guessing whenever the OMO config shape
 * is not explicitly supported.
 */
export function deriveV1AgentPermissionMaps(omoConfig) {
  if (omoConfig === null || typeof omoConfig !== "object" || Array.isArray(omoConfig)) {
    throw new Error("OMO config is not a JSON object — refusing permission derivation");
  }
  const entries = {};
  const applied = [];
  const skipped = [];
  const presetName = omoConfig.preset;
  let rolePresets = {};
  if (presetName != null) {
    const presets = omoConfig.presets ?? {};
    const preset = presets[presetName];
    if (preset === undefined || preset === null || typeof preset !== "object" || Array.isArray(preset)) {
      throw new Error(`OMO config preset '${presetName}' has no presets entry — refusing to guess a role set`);
    }
    // REAL PLUGIN SHAPE (omoPluginV1): role entries sit DIRECTLY on the preset
    // object — presets.<name>.explorer / presets.<name>.oracle / … — next to
    // the council section (which carries no role permission map and is
    // naturally skipped by the "no explicit permission map" rule below).
    rolePresets = preset;
  }
  const customAgents = omoConfig.agents ?? {};
  const disabled = new Set(omoConfig.disabled_agents ?? []);
  const disabledSkills = new Set(omoConfig.disabled_skills ?? []);
  // Upstream precedence (pinned plugin runtime.agents()): the resolved active
  // preset is the BASE role map and top-level `agents` the OVERRIDE —
  // deep-merged per key, so a same-id agents entry overrides only the keys it
  // names (a partially overridden preset permission map keeps its other keys
  // instead of being replaced wholesale). Alias keys fold into canonical
  // roles first.
  const canonicalPreset = omoCanonicalizeRoleMap(rolePresets);
  const canonicalAgents = omoCanonicalizeRoleMap(customAgents);
  const mergedRoles = omoDeepMergeRoleMaps(canonicalPreset, canonicalAgents);
  const originFor = (id) => {
    const inPreset = Object.prototype.hasOwnProperty.call(canonicalPreset, id);
    const inAgents = Object.prototype.hasOwnProperty.call(canonicalAgents, id);
    if (inPreset && inAgents) return `presets.${presetName}+agents`;
    return inAgents ? "agents" : `presets.${presetName}`;
  };
  for (const [id, entry] of Object.entries(mergedRoles)) {
    if (disabled.has(id)) {
      skipped.push({ id, reason: "disabled_agents" });
      continue;
    }
    const perm = entry?.permission;
    if (perm === undefined || perm === null) {
      skipped.push({ id, reason: "no explicit permission map" });
      continue;
    }
    if (typeof perm === "string") {
      skipped.push({ id, reason: "string-form permission map left to the plugin" });
      continue;
    }
    if (typeof perm !== "object" || Array.isArray(perm)) {
      throw new Error(`OMO role '${id}' permission must be an effect string or a {tool: effect} map, got ${typeof perm}`);
    }
    for (const [tool, value] of Object.entries(perm)) {
      if (typeof value !== "string" && (value === null || typeof value !== "object" || Array.isArray(value))) {
        throw new Error(`OMO role '${id}' permission '${tool}' must be an effect string or a {pattern: effect} map`);
      }
      if (typeof value === "string" && !["allow", "deny", "ask"].includes(value)) {
        throw new Error(`OMO role '${id}' permission '${tool}' effect ${JSON.stringify(value)} is not allow|deny|ask`);
      }
    }
    const unconditionallyDeniedEditors = OMO_ARTIFACT_EDITOR_TOOLS.filter((tool) => omoUnconditionallyDenied(perm[tool]));
    // Eligibility: infer the missing artifact-editor denies ONLY for a role
    // the user marked unequivocally readonly — a canonical known readonly
    // preset role (oracle/explorer/librarian/observer) with at least one
    // artifact editor unconditionally denied, or a custom role with ALL FOUR
    // artifact editors explicitly and unconditionally denied. Conditional
    // per-path denies (any allow/ask escape hatch) are scoped restrictions
    // and never make a role readonly; unclear cases stay with the plugin
    // instead of silently broadening into global tool denies.
    const isCanonicalReadonlyRole = OMO_READONLY_PRESET_ROLES.has(id);
    const eligible = isCanonicalReadonlyRole
      ? unconditionallyDeniedEditors.length > 0
      : unconditionallyDeniedEditors.length === OMO_ARTIFACT_EDITOR_TOOLS.length;
    if (!eligible) {
      skipped.push({ id, reason: "no unequivocal whole-tool artifact-editor denial (scoped restriction or writer role — left to the plugin)" });
      continue;
    }
    const completedKeys = [];
    const canonical = { ...perm };
    for (const tool of OMO_ARTIFACT_EDITOR_TOOLS) {
      if (!Object.prototype.hasOwnProperty.call(perm, tool)) {
        canonical[tool] = "deny";
        completedKeys.push(tool);
      }
    }
    for (const tool of [...OMO_TASK_CONTROL_TOOLS, ...OMO_AGENT_CONTROL_TOOLS]) {
      if (!Object.prototype.hasOwnProperty.call(perm, tool)) {
        canonical[tool] = "deny";
        completedKeys.push(tool);
      }
    }
    if (!Object.prototype.hasOwnProperty.call(perm, "question")) {
      canonical.question = "allow";
      completedKeys.push("question");
    }
    if (!Object.prototype.hasOwnProperty.call(perm, "skill")) {
      canonical.skill = omoSkillMap(entry.skills, id, disabledSkills);
      completedKeys.push("skill");
    }
    entries[id] = canonical;
    applied.push({ id, origin: originFor(id), completedKeys });
  }
  return { entries, applied, skipped };
}

/** Resolve the OMO config the renderer derives permission maps from. */
function resolveOmoPermissionSource(inputs, report) {
  const pinned = inputs.omoConfig?.resolved?.path;
  if (pinned) {
    return { path: pinned, resolvedVia: "inputs.omoConfig" };
  }
  // The v1 stage always copies the OMO config next to the rendered config
  // root, and the pinned host config source is read from its live directory —
  // so the sibling of the host config source is the OMO config this render
  // pairs with. Its path + sha256 are recorded in the report for drift audit.
  const sibling = pathJoin(pathDirname(inputs.hostConfigSource.resolved.path), "oh-my-opencode-slim.json");
  if (!existsSync(sibling)) {
    report.omoPermissionSource = null;
    report.omoPermissionRoles = [];
    report.omoPermissionSkipped = [];
    return null;
  }
  return { path: sibling, resolvedVia: "hostConfigSource-sibling" };
}

/**
 * Render the v1 legacy profile. pluginEntries are {component, relPath} where
 * relPath is the plugin entry's path inside the config root; entries are
 * rendered RELATIVE to the declaring config file (owner-verified: stock v1
 * config supports relative plugin paths, resolved against the config's
 * directory). The same staged bytes therefore resolve whether the config root
 * is the staging candidate, a moved candidate, or the activated live root —
 * no staging path, production path, or /tmp path is ever baked in.
 * inputs.pluginReplacements: [{spec, relEntry}] — a staged component override
 * REPLACES the named stock npm spec in place, preserving the profile's
 * explicit plugin ordering (e.g. the compression selection keeps its first
 * position, now backed by the staged frozen copy instead of an npm resolve).
 * inputs.preserveCredentials: private production staging — keep credential-
 * named provider keys verbatim (report records KEY NAMES only).
 *   `report` (optional) receives render metadata: droppedCredentialKeys and/or
 * preservedCredentialKeys, and legacyAliasPins (the GOAL2 canonical pins this
 * render applied, [{alias, canonical}]).
 * inputs.omoConfig (OPTIONAL): pinned OMO config input — when absent, the
 * OMO config staged next to the host config source is used instead; when
 * neither exists, no permission maps are derived and
 * report.omoPermissionSource is null (the v1 plugin keeps managing agent
 * permission maps exactly as before). When an OMO config IS resolved, the
 * explicit per-role permission maps are projected into canonical v1 core
 * agent.<id>.permission entries (see deriveV1AgentPermissionMaps) and the
 * report records omoPermissionSource (path/sha256/resolvedVia),
 * omoPermissionRoles ([{id, origin, completedKeys}]) and omoPermissionSkipped.
 */
export function renderV1(inputs, pluginEntries, report = {}) {
  const src = JSON.parse(readFileSync(inputs.hostConfigSource.resolved.path, "utf8"));
  if (src.agents && Object.keys(src.agents).length > 0) {
    throw new Error(`v1 source unexpectedly carries native 'agents' root — refusing (${inputs.hostConfigSource.resolved.path})`);
  }
  const { core, droppedCredentialKeys, preservedCredentialKeys } = personalCore(src, {
    preserveCredentials: Boolean(inputs.preserveCredentials),
  });
  if (report.droppedCredentialKeys === undefined) report.droppedCredentialKeys = droppedCredentialKeys;
  else report.droppedCredentialKeys.push(...droppedCredentialKeys);
  if (report.preservedCredentialKeys === undefined) report.preservedCredentialKeys = preservedCredentialKeys;
  else report.preservedCredentialKeys.push(...preservedCredentialKeys);
  const legacy = {};
  for (const [id, val] of Object.entries(src.agent ?? {})) {
    const keys = Object.keys(val ?? {}).sort();
    if (keys.join(",") !== "disable") {
      throw new Error(`legacy agent '${id}' has unexpected keys [${keys}] — only {disable} is convertible`);
    }
    legacy[id] = { disable: Boolean(val.disable) };
  }
  // GOAL2 minimal correction: stop the OMO legacy-alias suppression of the
  // default OMO explorer dispatch (see LEGACY_ALIAS_PINS above). Applied only
  // when the alias entry is disabled and no canonical entry exists — a source
  // that already pins the canonical agent keeps full control.
  report.legacyAliasPins = applyLegacyAliasPins(legacy);
  // Phase-2 correction: project the OMO preset's explicit per-role permission
  // maps into canonical v1 core agent.<id>.permission entries (see
  // deriveV1AgentPermissionMaps above). The v1 host enforces these maps
  // structurally (fully-denied tools are removed from the advertised tool
  // schema), so completing the artifact-editor denies at the config layer —
  // not a plugin patch — restores the existing readonly intent for explorer/
  // librarian/observer/oracle/lark-operator while writer roles keep their
  // maps exactly as the plugin produces them today.
  const omoSource = resolveOmoPermissionSource(inputs, report);
  if (omoSource) {
    const omoConfig = JSON.parse(readFileSync(omoSource.path, "utf8"));
    const { entries, applied, skipped } = deriveV1AgentPermissionMaps(omoConfig);
    for (const [id, permission] of Object.entries(entries)) {
      const existing = Object.prototype.hasOwnProperty.call(legacy, id) ? legacy[id] : { disable: false };
      legacy[id] = { ...existing, permission };
    }
    report.omoPermissionSource = {
      path: omoSource.path,
      sha256: sha256File(omoSource.path),
      resolvedVia: omoSource.resolvedVia,
    };
    report.omoPermissionRoles = applied;
    report.omoPermissionSkipped = skipped;
  }
  core.compaction = { auto: false };
  const stock = Array.isArray(inputs.stockPlugins) ? inputs.stockPlugins : [];
  const replacements = inputs.pluginReplacements ?? [];
  const replacedRelEntries = new Set(replacements.map((r) => r.relEntry));
  const pluginList = stock.map((spec) => {
    const hit = replacements.find((r) => r.spec === spec);
    return hit ? hit.relEntry : spec;
  });
  for (const entry of pluginEntries) {
    const relEntry = `./${entry.relPath}`;
    if (replacedRelEntries.has(relEntry)) continue; // already placed at the stock spec's position
    pluginList.push(relEntry);
  }
  core.plugin = pluginList;
  core.agent = legacy;
  return core;
}
