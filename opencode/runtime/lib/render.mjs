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
 * JSON — copied verbatim), explorerPrompt, larkOperatorPrompt, hostConfigSource.
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
  const explorerBody = readFileSync(inputs.explorerPrompt.resolved.path, "utf8");
  const larkBody = frontmatterBody(readFileSync(inputs.larkOperatorPrompt.resolved.path, "utf8"));
  agents.explorer = { system: explorerBody };
  agents["lark-operator"] = { system: larkBody, mode: "all" };
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
 * `report` (optional) receives render metadata: droppedCredentialKeys and/or
 * preservedCredentialKeys.
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
