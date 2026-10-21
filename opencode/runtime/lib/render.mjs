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

import { readFileSync } from "node:fs";

const CONFIG_SCHEMA = "https://opencode.ai/config.json";

export function stringifyConfig(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

function convertLegacyAgent(id, value, disabledKey) {
  const keys = Object.keys(value ?? {});
  if (!keys.length || keys.some((key) => key !== "disable" && key !== "mode")) {
    throw new Error(`legacy agent '${id}' has unexpected keys [${keys}] — only disable and mode are convertible`);
  }
  if (value.mode !== undefined && !["primary", "subagent", "all"].includes(value.mode)) {
    throw new Error(`legacy agent '${id}' has invalid mode ${JSON.stringify(value.mode)}`);
  }
  return {
    ...(Object.hasOwn(value, "disable") ? { [disabledKey]: Boolean(value.disable) } : {}),
    ...(value.mode !== undefined ? { mode: value.mode } : {}),
  };
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
  // Both provider roots are supported SHAPE-PRESERVING: the legacy singular
  // `provider` (v1 host vocabulary) and the native plural `providers`
  // (consolidation 7e3549f). Carrying BOTH is refused — a split root is how
  // model lists drift from their overrides (the exact bug the consolidation
  // fixed). Credential sink names keep the `provider.` prefix for both
  // shapes so reports stay stable across the vocabulary change.
  const providerRoots = ["provider", "providers"].filter((root) => out[root]);
  if (providerRoots.length === 2) {
    throw new Error(
      "host config source carries BOTH legacy 'provider' and native 'providers' roots — refusing to blend (consolidate to one root)"
    );
  }
  for (const root of providerRoots) {
    const providers = {};
    for (const [pid, prov] of Object.entries(sourceConfig[root])) {
      const copy = { ...prov };
      for (const container of ["options", "settings"]) {
        if (!copy[container] || typeof copy[container] !== "object" || Array.isArray(copy[container])) continue;
        const options = {};
        for (const [key, value] of Object.entries(copy[container])) {
          if (CREDENTIAL_KEY.test(key)) {
            const sink = opts.preserveCredentials ? preservedCredentialKeys : droppedCredentialKeys;
            sink.push(`provider.${pid}.${container}.${key}`);
            if (!opts.preserveCredentials) continue;
            options[key] = value;
            continue;
          }
          options[key] = value;
        }
        copy[container] = options;
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
    out[root] = providers;
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
 * inputs.resolved entries: omoConfig (unused in
 * JSON — copied verbatim), explorerPrompt (OPTIONAL — when absent, no inline
 * explorer `system` is rendered and upstream default + explorer_append.md
 * applies), hostConfigSource. Lark's prompt and mode live in the staged
 * the OMO prompt directory, not a second inline/native agent definition.
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
  const agents = { ...native };
  for (const [id, val] of Object.entries(legacy)) {
    agents[id] = convertLegacyAgent(id, val, "disabled");
  }
  // explorerPrompt is OPTIONAL (phase-1 follow-upstream): when the profile no
  // longer pins a full explorer prompt replacement, the upstream default
  // prompt + any explorer_append.md applies via the OMO prompt lookup, and no
  // inline `system` is rendered for it at all (an inline prompt would override
  // the file prompt and shadow upstream defaults).
  if (inputs.explorerPrompt?.resolved?.path) {
    agents.explorer = { system: readFileSync(inputs.explorerPrompt.resolved.path, "utf8") };
  }
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
    plugins: [
      ...(inputs.stockPlugins ?? []).filter((spec) => !replacedSpecs.has(spec)),
      // Staged components declaring v2Options append the v2 object form
      // {"package", "options"}; options reach setup() via ctx.options.
      // Components without v2Options stay discovery-only (no twin entry).
      ...(inputs.pluginConfigEntries ?? []).map((e) => ({ package: e.package, options: e.options })),
    ],
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

/**
 * Render the v1 legacy profile. pluginEntries are {component, relPath,
 * options?} where relPath is the plugin entry's path inside the config root;
 * entries are
 * rendered RELATIVE to the declaring config file (owner-verified: stock v1
 * config supports relative plugin paths, resolved against the config's
 * directory). An entry with options renders as the v1 tuple form
 * [path, options] (per-plugin options, e.g. supervisor's {"mode":"inject"}). The same staged bytes therefore resolve whether the config root
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
 * OMO role configuration is consumed only by the plugin, never copied into
 * the host config or expanded into additional permission rules here.
 */
function legacyProvider(provider) {
  if (!provider.package) return provider;
  if (provider.package !== "@opencode/ai/providers/openai-compatible") {
    throw new Error(`v1 provider package conversion is not defined: ${provider.package}`);
  }
  const { package: _, settings, models = {}, ...rest } = provider;
  return {
    ...rest, npm: "@ai-sdk/openai-compatible", options: settings,
    models: Object.fromEntries(Object.entries(models).map(([id, model]) => {
      const { capabilities = {}, settings: options, variants, ...fields } = model;
      return [id, {
        ...fields,
        modalities: { input: capabilities.input, output: capabilities.output },
        tool_call: capabilities.tools,
        reasoning: capabilities.reasoning?.supported ?? false,
        ...(options ? { options } : {}),
        ...(variants ? { variants: Object.fromEntries(variants.map(({ id, settings, body }) => [id, { ...settings, ...body }])) } : {}),
      }];
    })),
  };
}

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
  // The pinned host source may carry the native plural 'providers' root
  // (key consolidation 7e3549f); a v1 host reads the legacy singular
  // 'provider'. Convert plural→singular AFTER credential scrubbing so v1
  // candidates keep their model catalog. A source with BOTH roots is
  // refused inside personalCore.
  if (core.providers && !core.provider) {
    core.provider = Object.fromEntries(Object.entries(core.providers).map(([id, provider]) => [id, legacyProvider(provider)]));
    delete core.providers;
  }
  const legacy = {};
  for (const [id, val] of Object.entries(src.agent ?? {})) {
    legacy[id] = convertLegacyAgent(id, val, "disable");
  }
  // GOAL2 minimal correction: stop the OMO legacy-alias suppression of the
  // default OMO explorer dispatch (see LEGACY_ALIAS_PINS above). Applied only
  // when the alias entry is disabled and no canonical entry exists — a source
  // that already pins the canonical agent keeps full control.
  report.legacyAliasPins = applyLegacyAliasPins(legacy);
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
    pluginList.push(entry.options ? [relEntry, entry.options] : relEntry);
  }
  core.plugin = pluginList;
  core.agent = legacy;
  return core;
}
