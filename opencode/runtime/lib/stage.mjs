// personal-profile runtime — candidate staging.
//
// Builds a complete candidate config root in a temp dir and commits it with a
// single rename. The existing deployment is untouched on any failure (input
// refusals happen BEFORE the first write). /tmp example paths from the owner's
// composition session are never baked into anything: every artifact is either
// a pinned source of record or an explicit --component input verified here.
//
// Compression note (confirmed 2026-10-01): the v2 native compression route
// needs no extra launcher — with the resolved node executable directory first
// in PATH (hostenv) and compaction.auto=false, the stock native plugin
// self-spawns and search_context answers correctly. Full compress/recover is
// still pending upstream (evidence: compression-smoke-v2-fixed-node, 0 real
// LLM calls). Activation and verify never claim compression readiness from
// plugin status alone; no provider URL is ever rewritten.
// Composition (profile-composition-completion §1): both flavors select the
// stock billion-context@0.1.175 compression engine (profile
// flavors.*.stockPlugins — a host-resolved npm spec on v1, host-native on v2;
// never staged by this lane), OMO 3.0.1 directory artifacts with per-host
// entries, and the explicit dual-host BCP artifact. Prompt staging excludes
// private Council replacements and *.bak-promptopt backups and prunes the two
// private Council requirements from the staged orchestrator_append copy only
// (lib/prompts.mjs, decision e000070).
//
// Relocatability: component entry shims import their target RELATIVE to the
// shim itself (plugins/<name>/index.js → "./dist/server/index.js"), and v1
// `core.plugin` entries are rendered RELATIVE to the declaring config path
// (owner-verified: stock v1 config supports relative plugin paths). A
// candidate therefore keeps resolving its imports and plugin paths after it
// is moved to an unrelated live root or the staging dir is removed — no
// staging path, production path, or /tmp path is baked into any staged file.
//
// Stock-plugin override: a staged dir component may declare `replacesPlugin`
// (npm spec, string or array) in its pinned profile definition. When staged,
// the frozen local copy overrides the host-resolved package so cutover cannot
// silently drift to a different package version: on v1 the relative staged
// entry REPLACES the spec in place inside core.plugin (profile plugin order
// is preserved); on v2 the spec is REMOVED from plugins (the staged
// plugins/<name>/index.js is auto-discovered — keeping the spec would load
// the package twice). The owner-pinned frozen compression wrapper
// (billion-frozen-20261002: root index.js re-exports only
// './node_modules/billion-context/dist/agent/opencode-native.js') stages via
// the generic dir component path with entry "index.js" — no shim, full
// package dist + node_modules closure copied verbatim.
//
// Private production staging (opts.productionPrivate): an explicit,
// operator-requested mode for the cutover candidate. The rendered
// opencode.json KEEPS credential-named provider keys so the live root keeps
// authentication; the ONLY place credential values exist is that one config
// file, written mode 0600 (candidate, live root, and its activation backup).
// Values never enter any report, note, or manifest field — only KEY NAMES
// are recorded for audit — and the manifest pins the file by sha256 only
// (never its content). The default probe staging keeps scrubbing credentials.

import { existsSync, mkdirSync, cpSync, renameSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { verifyAllInputs, verifyExplicit } from "./inputs.mjs";
import { renderV2, renderV1, stringifyConfig } from "./render.mjs";
import { isExcludedPromptFile, transformPromptFile } from "./prompts.mjs";
import { writeStageManifest, STAGE_MANIFEST_REL } from "./manifest.mjs";
import { launcherEnv } from "./hostenv.mjs";
import { assertChildEnv } from "./spawn.mjs";
import { sha256, sha256File } from "./hash.mjs";

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(p));
    else if (entry.isFile()) out.push(p);
  }
  return out.sort();
}

export class StageRefusal extends Error {
  constructor(report) {
    super(`stage refused (nothing was written):\n${report.map((l) => `  - ${l}`).join("\n")}`);
    this.name = "StageRefusal";
    this.code = 2;
    this.report = report;
  }
}

/**
 * @param opts { flavor, profile, profilePath, profileSha256, host, outDir,
 *   explicit: { componentName: suppliedPath },
 *   productionPrivate: private production staging — preserve credential-named
 *   provider keys in opencode.json (written 0600; key NAMES recorded only,
 *   never values). Default false: probe staging scrubs credentials. }
 * @returns { candidateDir, manifest, components, env, notes }
 */
export function stage(opts) {
  const { flavor, profile, profilePath, profileSha256, host, outDir, explicit = {}, productionPrivate = false } = opts;
  if (flavor !== "v1" && flavor !== "v2") {
    throw new StageRefusal([`unknown flavor ${JSON.stringify(flavor)} — use v1 or v2`]);
  }
  if (!host || !host.flavor) {
    throw new StageRefusal(["host probe result required (run document-writer detect first)"]);
  }

  // 1) pinned inputs — refusal happens before any write
  const inputs = verifyAllInputs(profile);

  // 2) explicit components for this flavor
  const report = [];
  const components = {};
  const unknownExplicit = [];
  for (const [name, comp] of Object.entries(profile.components ?? {})) {
    if (!(comp.flavors ?? ["v1", "v2"]).includes(flavor)) continue;
    components[name] = verifyExplicit(name, comp, explicit[name], report);
  }
  // An explicitly supplied artifact with no pinned profile definition is an
  // operator error, not something to accept blindly (the option must accept
  // verified component/profile definitions only — never a missing dependency
  // smuggled in as a path).
  for (const supplied of Object.keys(explicit)) {
    if (!Object.prototype.hasOwnProperty.call(profile.components ?? {}, supplied)) {
      unknownExplicit.push(supplied);
      report.push(
        `explicit component '${supplied}' has no pinned profile definition — refusing (this lane stages only owner-pinned component definitions, never an unpinned dependency path)`
      );
    }
  }
  if (Object.values(components).some((c) => c.status === "refused") || unknownExplicit.length > 0) {
    throw new StageRefusal(report);
  }

  // 3) build candidate in temp, commit with a single rename
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const candidateDir = join(outDir, `${flavor}-${stamp}`);
  if (existsSync(candidateDir)) {
    throw new StageRefusal([`candidate path already exists: ${candidateDir}`]);
  }
  mkdirSync(outDir, { recursive: true });
  const tmp = join(outDir, `.tmp-${flavor}-${stamp}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });

  try {
    const files = [];
    // Every record carries the staged bytes' own sha256 (actual staged
    // identity), the pinned source sha256 it came from, and — for transformed
    // files — which staged-only transformation produced it. Every record also
    // carries the staged file's OWN permission mode, so activation can verify
    // and install the actual mode: executable payloads (packaged native CLI
    // binaries must land executable, private configs must land 0600) must not
    // silently drop their bits between staging and the live root. Modes are
    // read from the staged regular file itself — the source symlink/hardlink
    // refusal policy is unchanged and no source inode identity is recorded.
    const stagedMode = (abs) => `${(statSync(abs).mode & 0o777).toString(8).padStart(4, "0")}`;
    const record = (relPath, source, sourceSha, extra = {}) => {
      files.push({ path: relPath, action: "create", source, sourceSha256: sourceSha, ...extra });
    };
    const recordStaged = (relPath, source, sourceSha, destAbs, transform = null) => {
      const extra = { sha256: sha256File(destAbs), mode: stagedMode(destAbs) };
      if (transform) extra.transform = transform;
      record(relPath, source, sourceSha, extra);
    };

    // personal core files
    cpSync(inputs.agentsMd.resolved.path, join(tmp, "AGENTS.md"));
    recordStaged("AGENTS.md", inputs.agentsMd.resolved.path, inputs.agentsMd.resolved.sha256, join(tmp, "AGENTS.md"));
    cpSync(inputs.omoConfig.resolved.path, join(tmp, "oh-my-opencode-slim.json"));
    recordStaged("oh-my-opencode-slim.json", inputs.omoConfig.resolved.path, inputs.omoConfig.resolved.sha256, join(tmp, "oh-my-opencode-slim.json"));
    const promptDir = join(tmp, "oh-my-opencode-slim");
    mkdirSync(promptDir, { recursive: true });
    const promptExcluded = [];
    const promptTransformed = [];
    for (const [rel, sha] of Object.entries(inputs.omoPromptDir.resolved.files)) {
      const sourceAbs = join(inputs.omoPromptDir.resolved.path, ...rel.split("/"));
      if (isExcludedPromptFile(rel)) {
        // Private Council prompt replacements and *.bak-promptopt backups are
        // pinned (so source drift still refuses) but never staged: upstream
        // OMO 3.0.1 Council guidance stands unmodified (decision e000070).
        promptExcluded.push(rel);
        continue;
      }
      const destAbs = join(promptDir, ...rel.split("/"));
      mkdirSync(dirname(destAbs), { recursive: true });
      const transform = transformPromptFile(rel, flavor);
      if (transform) {
        const bytes = transform.apply(readFileSync(sourceAbs, "utf8"));
        writeFileSync(destAbs, bytes);
        recordStaged(`oh-my-opencode-slim/${rel}`, inputs.omoPromptDir.resolved.path, sha, destAbs, transform.kind);
        promptTransformed.push(`${rel} (${transform.kind})`);
      } else {
        cpSync(sourceAbs, destAbs);
        recordStaged(`oh-my-opencode-slim/${rel}`, inputs.omoPromptDir.resolved.path, sha, destAbs);
      }
    }
    mkdirSync(join(tmp, "agents"), { recursive: true });
    cpSync(inputs.larkOperatorPrompt.resolved.path, join(tmp, "agents", "lark-operator.md"));
    recordStaged("agents/lark-operator.md", inputs.larkOperatorPrompt.resolved.path, inputs.larkOperatorPrompt.resolved.sha256, join(tmp, "agents", "lark-operator.md"));
    const skillsDir = join(tmp, "skills");
    mkdirSync(skillsDir, { recursive: true });
    let stagedSkillCount = 0;
    for (const [rel, sha] of Object.entries(inputs.skillsDir.resolved.files)) {
      const dest = join(skillsDir, ...rel.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(inputs.skillsDir.resolved.path, ...rel.split("/")), dest);
      recordStaged(`skills/${rel}`, inputs.skillsDir.resolved.path, sha, dest);
      stagedSkillCount++;
    }

    // explicit plugin components → plugins/…
    const stagedPlugins = [];
    for (const [name, comp] of Object.entries(components)) {
      if (!comp.staged) continue;
      if (comp.kind === "dir") {
        const relBase = `plugins/${name}`;
        cpSync(comp.source, join(tmp, relBase), { recursive: true });
        for (const [rel, sha] of Object.entries(comp.files)) {
          // A per-host selected entry may coexist with a legacy index.js in
          // the source package. The generated discovery shim replaces that
          // entry; record its final bytes once below, not a stale hash twice.
          if (comp.entry !== "index.js" && rel === "index.js") continue;
          if (rel === comp.entry) {
            // Actual staged identity of the entry the host will load.
            const entryAbs = join(tmp, relBase, ...rel.split("/"));
            record(`${relBase}/${rel}`, comp.source, sha, {
              sha256: sha256File(entryAbs),
              mode: stagedMode(entryAbs),
              transform: "component-entry",
            });
          } else {
            record(`${relBase}/${rel}`, comp.source, sha, { mode: stagedMode(join(tmp, relBase, ...rel.split("/"))) });
          }
        }
        if (comp.entry === "index.js") {
          // The copied entry already occupies the auto-discovered path
          // (plugins/<name>/index.js): writing a shim here would overwrite
          // the entry with a self-re-export and list the same file twice.
          // No shim — the entry file itself is the plugin.
          stagedPlugins.push({ component: name, relPath: `${relBase}/${comp.entry}` });
          components[name] = { ...comp, stagedAt: relBase, relPath: `${relBase}/${comp.entry}` };
        } else {
          // Nested entry: v2 discovers plugins/<name>/index.js — write a shim
          // that re-exports the copied artifact entry INSIDE the candidate
          // (never the external source path). The import specifier is
          // RELATIVE to the shim, so the candidate stays relocatable: the
          // shim resolves its target wherever the config root lives (staging
          // dir, moved dir, or activated live root).
          const shimRel = `${relBase}/index.js`;
          const shimBody = `export {default} from "./${comp.entry}";\n`;
          const shimAbs = join(tmp, shimRel);
          writeFileSync(shimAbs, shimBody);
          record(shimRel, null, sha256(shimBody), { sha256: sha256(shimBody), mode: stagedMode(shimAbs) });
          stagedPlugins.push({ component: name, relPath: shimRel });
          components[name] = { ...comp, stagedAt: relBase, shim: shimRel, relPath: shimRel };
        }
      } else {
        const relBase = `plugins/${basename(comp.source)}`;
        mkdirSync(join(tmp, "plugins"), { recursive: true });
        cpSync(comp.source, join(tmp, relBase));
        recordStaged(relBase, comp.source, comp.sha256, join(tmp, relBase));
        stagedPlugins.push({ component: name, relPath: relBase });
        components[name] = { ...comp, stagedAt: relBase, relPath: relBase };
      }
    }

    // Stock-plugin overrides from THIS stage's committed layout. A staged
    // component whose pinned profile definition declares replacesPlugin takes
    // over the named npm spec so the cutover candidate cannot drift to a
    // different package at resolve time. (The pinned definition lives in
    // profile.components; the verified record above carries relPath.)
    const replacements = []; // { component, spec, relEntry }
    const replacedBy = new Map();
    for (const [name, comp] of Object.entries(components)) {
      if (!comp.staged || !comp.relPath) continue;
      const declared = profile.components?.[name]?.replacesPlugin;
      if (declared == null) continue;
      const specs = Array.isArray(declared) ? declared : [declared];
      for (const spec of specs.map(String)) {
        const prior = replacedBy.get(spec);
        if (prior) {
          throw new StageRefusal([
            `components '${prior}' and '${name}' both declare replacesPlugin ${JSON.stringify(spec)} — refusing an ambiguous stock-plugin override`,
          ]);
        }
        replacedBy.set(spec, name);
        replacements.push({ component: name, spec, relEntry: `./${comp.relPath}` });
      }
    }

    // rendered host config — plugin references are RELATIVE to the declaring
    // config path (relocatable: staging dir, moved dir, and live root all
    // resolve them), and credential handling follows the staging mode.
    const renderReport = {};
    const renderInputs = {
      hostConfigSource: inputs.hostConfigSource,
      preserveCredentials: productionPrivate,
      pluginReplacements: replacements,
    };
    let rendered;
    if (flavor === "v2") {
      rendered = renderV2(
        {
          ...renderInputs,
          explorerPrompt: inputs.explorerPrompt,
          larkOperatorPrompt: inputs.larkOperatorPrompt,
          stockPlugins: profile.flavors.v2.stockPlugins ?? [],
        },
        renderReport
      );
    } else {
      rendered = renderV1(
        {
          ...renderInputs,
          stockPlugins: profile.flavors.v1.stockPlugins ?? [],
        },
        (profile.flavors.v1.pluginOrder ?? [])
          .map((name) => stagedPlugins.find((p) => p.component === name))
          .filter(Boolean),
        renderReport
      );
    }
    const droppedCredentialKeys = renderReport.droppedCredentialKeys ?? [];
    const preservedCredentialKeys = renderReport.preservedCredentialKeys ?? [];
    const renderedBytes = stringifyConfig(rendered);
    // The rendered config is ALWAYS written 0600 inside the candidate (it is
    // derived from the production host config source); its actual staged mode
    // is recorded so activation keeps the live copy and its backup 0600 too.
    const cfgAbs = join(tmp, "opencode.json");
    writeFileSync(cfgAbs, renderedBytes, { mode: 0o600 });
    record("opencode.json", `rendered:${flavor}`, null, {
      sha256: sha256(renderedBytes),
      mode: stagedMode(cfgAbs),
    });

    // flavor extras (live personal files, pinned)
    for (const extra of profile.flavors[flavor].copyExtras ?? []) {
      const input = inputs[extra.input];
      if (!input?.resolved) throw new StageRefusal([`flavor ${flavor} extra ${extra.input} is not a resolved input`]);
      const dest = join(tmp, extra.as);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(input.resolved.path, dest);
      recordStaged(extra.as, input.resolved.path, input.resolved.sha256, dest);
    }

    // Stage-time env validation: the string record is checked here so a bad
    // shape refuses staging instead of failing (or silently mis-launching) at
    // spawn time. The sandbox invariants (fresh HOME, per-run data/state) are
    // enforced at launch time by lib/spawn.mjs — requireSandbox:false here.
    const { env, notes } = launcherEnv(flavor, candidateDir, join(dirname(candidateDir), "state"));
    assertChildEnv(env, { requireSandbox: false });
    const manifest = {
      schemaVersion: 1,
      lane: "personal-profile",
      flavor,
      stagedAt: new Date().toISOString(),
      profileAuthority: { path: profilePath, sha256: profileSha256 },
      host,
      notes: [
        ...notes,
        "Compression: the configured stock package uses its native self-spawn route. A synthetic v2.0.20 compression/export case preserved all ten source messages byte-for-byte; this does not validate this entire staged profile or every transport.",
        "Spawn boundary: every host child this lane launches goes through lib/spawn.mjs spawnSandboxed — the environment is validated before subprocess creation and a {env, notes} result object passed as an environment is refused (2026-10-01 production-DB incident regression).",
        `Prompt staging (decision e000070): ${promptExcluded.length} pinned prompt file(s) excluded from the candidate [${promptExcluded.join(", ") || "none"}]; staged-copy transforms: ${promptTransformed.join(", ") || "none"}. Sources are byte-identical; upstream Council guidance stands unmodified.`,
        productionPrivate
          ? `Private production staging: ${preservedCredentialKeys.length} provider credential key(s) PRESERVED BY NAME in opencode.json [${preservedCredentialKeys.join(", ") || "none"}] — key NAMES only, values never enter any record; the config file is written mode 0600 in the candidate, at the live root, and in its activation backup, and the manifest pins it by sha256 only (never its content).`
          : `Credential scrub: ${droppedCredentialKeys.length} provider option key(s) dropped BY NAME from the rendered config [${droppedCredentialKeys.join(", ") || "none"}] — values were never read into any record.`,
        `Stock compression: profile selection ${JSON.stringify(profile.flavors[flavor].stockPlugins ?? [])}; package installation is performed by the host.`,
        ...(replacements.length > 0
          ? [
              `Stock-plugin override: staged frozen component(s) ${replacements.map((r) => `${r.component} → ${r.relEntry}`).join(", ")} replace the npm spec(s) ${JSON.stringify(replacements.map((r) => r.spec))} for this flavor, so cutover resolves the pinned local copy and no package drift can occur at activation (v1: in-place entry replacement in core.plugin; v2: npm spec removed — the staged plugins/<name>/index.js is auto-discovered).`,
            ]
          : []),
      ],
      components,
      files,
      renderedConfigSha256: sha256(renderedBytes),
      ...(productionPrivate
        ? {
            privateProduction: {
              enabled: true,
              configFile: "opencode.json",
              fileMode: "0600",
              preservedCredentialKeys: [...preservedCredentialKeys],
              credentialKeyCount: preservedCredentialKeys.length,
            },
          }
        : {}),
      envTemplate: {
        OPENCODE_CONFIG_DIR: flavor === "v2" ? "<candidate>" : "(intentionally unset on v1 — adds a layer there)",
        XDG_CONFIG_HOME: "<candidateParent>",
        XDG_DATA_HOME: "<stateDir>/data",
        XDG_STATE_HOME: "<stateDir>/state",
        XDG_CACHE_HOME: "<stateDir>/cache",
        stripped: ["OPENCODE_* (every inherited override variable is cleared before the flavor's own values are set)"],
      },
      limits: {
        activation: "activate is atomic per file (temp+rename), not transactional across files; handled failures roll back; power loss is not covered",
        privacy: "Privacy transport acceptance is separate from BCP provenance acceptance; staging alone establishes neither.",
        verification: "verify is metadata-only (config stack, agent matrix, plugin status); no model requests are made",
      },
    };
    writeStageManifest(tmp, manifest);
    renameSync(tmp, candidateDir);
    // Freeze the launcher result: the env/notes a worker receives are
    // read-only complete values, and the object shape is exactly what
    // lib/spawn.mjs refuses when mistaken for an environment.
    return { candidateDir, manifest, components, env: Object.freeze(env), notes: Object.freeze(notes) };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}
