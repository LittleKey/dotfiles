// personal-profile runtime — launcher environment per host flavor.
//
// VERIFIED DISCOVERY EVIDENCE (sandboxed probes, metadata-only):
// - v2.0.20: OPENCODE_CONFIG_DIR REPLACES the default global config root
//   (/api/config stack shows [candidate DOC, candidate DIR, project DOC] with
//   no HOME layer). XDG_CONFIG_HOME sets the default root; the explicit
//   OPENCODE_CONFIG_DIR wins when both are set.
// - v1.18.33: OPENCODE_CONFIG_DIR ADDS a config layer ON TOP of the default
//   global root (merged /config shows markers from BOTH). Using it alone would
//   keep the production global layer — credentials, plugins, ACP compressor —
//   active. Isolation on v1 must redirect the default root via XDG_CONFIG_HOME
//   and must NOT set OPENCODE_CONFIG_DIR.
// - v1.18.33 (second probe, falsified the XDG_CONFIG_HOME assumption above):
//   with a real HOME set, XDG_CONFIG_HOME is IGNORED — the global root is
//   strictly $HOME/.config/opencode (candidate config at XDG_CONFIG_HOME was
//   not merged; /config returned an empty config). v1 sandbox isolation must
//   therefore redirect HOME itself (opts.homeDir) to a sandbox home whose
//   .config/opencode points at the candidate. Activation into
//   ~/.config/opencode is unaffected: production HOME resolves that root
//   naturally.
//
// Both flavors additionally isolate data/state/cache so session DBs, logs and
// plugin caches never touch production (no v1 host DB is ever migrated), and
// strip request/env config overrides inherited from the caller.
//
// Subprocess hygiene (VERIFIED REQUIRED): the host binaries spawn `node`
// subprocesses, and the v2 native compression plugin self-spawns through node
// as well. With the resolved node executable directory FIRST in PATH and the
// documented compaction.auto=false, the stock native route works
// (compression-smoke-v2-fixed-node: search_context returned a healthy empty
// result; 0 real LLM calls). Without it, mise shim resolution breaks ("node
// is not a valid shim"). No proxy launcher, no provider URL rewrites — the
// native direct path is kept.

import { dirname } from "node:path";

/**
 * Build the launcher env for a staged candidate.
 * stateDir: sandbox root for data/state/cache (created by caller).
 * opts.cacheDir: optional explicit plugin-cache directory. The host installs
 *   plugin dependencies into XDG_CACHE_HOME/opencode — on a cold cache
 *   this needs the network and is nondeterministic (observed: the OMO plugin
 *   sometimes fails to register). Pass a pre-warmed cache dir for offline,
 *   reproducible verification. Never a build-time constant.
 * opts.homeDir: optional sandbox HOME (v1 isolation requires it — see the
 *   second v1 probe note in the header). Caller creates the directory,
 *   including a `.config/opencode` entry pointing at the candidate.
 * Returns { env, notes: string[] } — env is a complete child environment.
 * Spawn hosts ONLY via lib/spawn.mjs spawnSandboxed with opts.env = result.env;
 * passing the result object itself is refused before any subprocess exists.
 */
export function launcherEnv(flavor, candidateDir, stateDir, baseEnv = process.env, opts = {}) {
  const env = { ...baseEnv };
  // Strip EVERY inherited OPENCODE_* override before setting this candidate's
  // own values. A fixed strip list silently misses future override variables
  // (request/env config injection, config-dir redirects, server passwords —
  // any of them can point the child back at production); enumerating the
  // prefix is the only safe default. Whatever the flavor needs is re-set
  // explicitly below.
  for (const k of Object.keys(env)) {
    if (k.startsWith("OPENCODE_")) delete env[k];
  }
  const notes = [];
  // Preserve the known feature flag used by the existing managed host without
  // inheriting arbitrary OPENCODE_* config, database, or authentication input.
  env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "true";
  notes.push("Native background subagents explicitly enabled, matching the existing managed host.");
  env.XDG_DATA_HOME = `${stateDir}/data`;
  env.XDG_STATE_HOME = `${stateDir}/state`;
  env.XDG_CACHE_HOME = opts.cacheDir ? opts.cacheDir : `${stateDir}/cache`;
  const nodeDir = dirname(process.execPath);
  if (nodeDir) {
    env.PATH = `${nodeDir}:${env.PATH ?? ""}`;
    notes.push(`PATH prepended with ${nodeDir} so the host's node subprocesses stay resolvable while HOME is redirected (mise shim artifact otherwise).`);
  }
  const configParent = dirname(candidateDir);
  env.XDG_CONFIG_HOME = configParent;
  if (opts.homeDir) {
    env.HOME = opts.homeDir;
    if (flavor === "v1") env.XDG_CONFIG_HOME = `${opts.homeDir}/.config`;
    notes.push("HOME redirected to the sandbox; v1 HOME and XDG_CONFIG_HOME agree on the single .config/opencode candidate link.");
  }
  if (flavor === "v2") {
    // Replace semantics verified on 2.0.20; also set for any code path that
    // resolves the default root independently.
    env.OPENCODE_CONFIG_DIR = candidateDir;
    notes.push("v2.0.20 verified: OPENCODE_CONFIG_DIR replaces the global config root (no HOME layer in /api/config stack).");
  } else if (flavor === "v1") {
    notes.push("v1.18.33: OPENCODE_CONFIG_DIR adds a layer, so it is intentionally unset. The caller must place the candidate under the supplied sandbox HOME's .config/opencode; XDG_CONFIG_HOME alone does not replace that root.");
  } else {
    throw new Error(`unknown flavor ${JSON.stringify(flavor)}`);
  }
  return { env, notes };
}
