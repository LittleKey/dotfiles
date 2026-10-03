// personal-profile runtime — candidate runtime verification (metadata-only).
//
// Boots the staged candidate against the selected host binary in a sandbox
// (launcherEnv isolation through lib/spawn.mjs spawnSandboxed) and checks,
// WITHOUT any model request:
//  - v2: /api/config layer stack (candidate replaces global root), agent
//    matrix (personal roles, models, modes, exact system bodies),
//    plugin registration (OMO active; ACP absent — single compression engine).
//  - v1: merged /config (legacy agent disables preserved, model preserved,
//    plugin entries point into the candidate or are the pinned stock specs).
// Isolation is enforced, not assumed (post-incident 2026-10-01): every run
// gets a fresh sandbox HOME (both flavors), per-run private data/state dirs
// and a fresh config root; every inherited OPENCODE_* override is cleared;
// the child is spawned only through the validated boundary (a {env, notes}
// result object passed as an environment is refused before spawn); and the
// `sandbox-db` check inspects open file descriptors under /proc across the
// serve child AND its owned descendants (a wrapper launcher delegates the DB
// to a grandchild) so the session DB position is proven, not inferred from
// config output. A DB file that merely exists on disk is NEVER proof — if no
// process in the owned tree holds the DB open, the check fails closed. The
// child's exit is awaited on every path (graceful SIGTERM first, bounded
// SIGKILL escalation via childExit).
// Compression is NEVER asserted runtime-ready: registration is a status only.
// The tested native route needs no extra launcher (resolved node dir first in
// PATH + compaction.auto=false; self-spawn confirmed with 0 real LLM calls);
// full compress/recover recovery is still pending upstream. No provider URL
// is rewritten.
//
// Honest limits: if the agent endpoint is unavailable the report says so and
// config-layer checks alone do not pass verification; if the child's open
// file descriptors cannot be inspected, `sandbox-db` fails closed; skill
// staging is file-level evidence only — runtime skill discovery is not
// asserted from a sandbox HOME, and a permission name alone does not
// establish that a skill is installed.

import { readdirSync, readlinkSync, readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync, realpathSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { launcherEnv } from "./hostenv.mjs";
import { spawnSandboxed, childExit } from "./spawn.mjs";
import { readStageManifest } from "./manifest.mjs";

function freePort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

async function fetchJson(url, { headers, timeoutMs = 4000 } = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: null, error: `${err.name}: ${err.message}` };
  }
}

function extractArray(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  return null;
}

export function inspectV1PluginSelection(pluginList, candidateDir, profile, stagedComponents) {
  const entries = Object.entries(stagedComponents).filter(([, c]) => c.staged && c.relPath);
  const canonical = value => value.startsWith("file://") ? realpathSync(fileURLToPath(value)) : value;
  const expectedFiles = entries.map(([, c]) => realpathSync(join(candidateDir, c.relPath)));
  const replaced = new Set(entries.map(([name]) => profile.components?.[name]?.replacesPlugin).filter(Boolean));
  const expectedSpecs = (profile.flavors.v1.stockPlugins ?? []).filter(spec => !replaced.has(spec));
  try {
    const actual = pluginList.map(canonical);
    const missing = [...expectedFiles, ...expectedSpecs].filter(value => !actual.includes(value));
    const unexpected = actual.filter(value => !expectedFiles.includes(value) && !expectedSpecs.includes(value));
    const duplicates = actual.filter((value, i) => actual.indexOf(value) !== i);
    return {ok: actual.length > 0 && !missing.length && !unexpected.length && !duplicates.length,
      compression: [...replaced].every(spec => !pluginList.includes(spec)) && expectedSpecs.every(spec => actual.includes(spec)),
      missing, unexpected, duplicates, replaced: [...replaced]};
  } catch (error) {
    return {ok:false, compression:false, error:error.message};
  }
}

/** Read /proc/<pid>/fd once; classify open paths. Fails closed on error. */
function scanChildFds(pid) {
  const fdsDir = `/proc/${pid}/fd`;
  try {
    const dbPaths = [];
    const allPaths = [];
    for (const fd of readdirSync(fdsDir)) {
      let target;
      try {
        target = readlinkSync(join(fdsDir, fd));
      } catch {
        continue; // descriptor closed between readdir and readlink
      }
      if (target.startsWith("socket:") || target.startsWith("pipe:") || target.startsWith("anon_inode:")) continue;
      allPaths.push(target);
      if (/\.db(-wal|-shm)?$/i.test(target)) dbPaths.push(target);
    }
    return { dbPaths, allPaths, error: null, fdsDir };
  } catch (err) {
    return { dbPaths: [], allPaths: [], error: `${err.name}: ${err.message}`, fdsDir };
  }
}

/**
 * Owned descendant PIDs of a process via /proc/<pid>/task/<tid>/children —
 * same-uid children only (the kernel file exists only for the owner's own
 * processes), bounded in depth so a runaway tree cannot stall verification.
 */
function readChildPids(pid) {
  const out = [];
  const taskDir = `/proc/${pid}/task`;
  let tids = [];
  try {
    tids = readdirSync(taskDir);
  } catch {
    return out;
  }
  for (const tid of tids) {
    try {
      const raw = readFileSync(join(taskDir, tid, "children"), "utf8");
      for (const c of raw.trim().split(/\s+/).filter(Boolean)) out.push(Number(c));
    } catch {
      // children file is ephemeral (child reaped between listing and read)
    }
  }
  return out;
}

function ownedDescendants(pid, maxDepth = 4) {
  const seen = new Set([pid]);
  let frontier = [pid];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next = [];
    for (const p of frontier) {
      for (const c of readChildPids(p)) {
        if (!seen.has(c)) {
          seen.add(c);
          next.push(c);
        }
      }
    }
    frontier = next;
  }
  return [...seen];
}

/**
 * Prove where the serve child's session DB actually lives: poll open
 * descriptors briefly across the child AND its owned descendants (a wrapper
 * launcher delegates the DB to a grandchild), then assert every DB path is
 * inside this run's sandbox and nothing is open under the production data
 * share. A DB file that merely exists on disk is NOT accepted as proof —
 * without a live descriptor from the owned process tree the check fails
 * closed. Returns { ok, detail }.
 */
async function sandboxDbEvidence(child, perRunData, perRunState, productionDataRoot) {
  if (!child.pid) {
    return { ok: false, detail: `serve pid unavailable (spawn failed: ${child.spawnError?.message ?? "unknown"}) — DB isolation unproven` };
  }
  const pids = ownedDescendants(child.pid);
  const descendants = pids.length - 1;
  const aggregate = { dbPaths: [], allPaths: [] };
  let lastError = null;
  let allErrored = true;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    aggregate.dbPaths.length = 0;
    aggregate.allPaths.length = 0;
    lastError = null;
    allErrored = true;
    for (const pid of pids) {
      const scan = scanChildFds(pid);
      if (scan.error) {
        lastError = `${pid}: ${scan.error}`;
        continue;
      }
      allErrored = false;
      aggregate.dbPaths.push(...scan.dbPaths);
      aggregate.allPaths.push(...scan.allPaths);
    }
    if (!lastError && aggregate.dbPaths.length > 0) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  if (aggregate.dbPaths.length === 0 && allErrored) {
    return { ok: false, detail: `cannot inspect open descriptors of serve pid ${child.pid} or its owned descendants (${lastError}) — DB isolation unproven (fail-closed)` };
  }
  const prodOpen = aggregate.allPaths.filter((p) => p === productionDataRoot || p.startsWith(productionDataRoot + "/"));
  if (prodOpen.length) {
    return { ok: false, detail: `serve tree holds production paths open: ${JSON.stringify(prodOpen.slice(0, 5))} — isolation violated` };
  }
  const sandboxRoots = [perRunData, perRunState];
  const outside = aggregate.dbPaths.filter((p) => !sandboxRoots.some((root) => p === root || p.startsWith(root + "/")));
  if (aggregate.dbPaths.length) {
    if (outside.length) {
      return { ok: false, detail: `DB file descriptors outside the per-run sandbox: ${JSON.stringify(outside.slice(0, 5))}` };
    }
    const tree = descendants > 0 ? ` (serve pid ${child.pid} + ${descendants} owned descendant${descendants === 1 ? "" : "s"} inspected)` : ` (serve pid ${child.pid}; no owned descendants)`;
    return {
      ok: true,
      detail: `open DB fds are inside the per-run sandbox (e.g. ${aggregate.dbPaths[0]})${tree}; nothing open under ${productionDataRoot}`,
    };
  }
  // No DB fd held anywhere in the owned tree — an existing DB file on disk is
  // NOT proof of this process's DB position: fail closed instead.
  return {
    ok: false,
    detail: `no DB descriptor held by serve pid ${child.pid}${descendants > 0 ? ` or its ${descendants} owned descendant(s)` : ""} — an existing file on disk is not proof of this process's DB position; DB isolation unproven (fail-closed)`,
  };
}

export async function verify({ candidateDir, opencodeExe, flavor, projectDir, profile, stagedComponents = {}, cacheDir = null }) {
  const checks = [];
  const check = (id, pass, detail) => {
    checks.push({ id, pass: Boolean(pass), detail });
    return Boolean(pass);
  };
  const runStamp = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const stateRoot = join(dirname(candidateDir), "state");
  // Per-run private data/state: sharing them across runs can surface a
  // half-initialized host DB ("Database is not empty and has no session
  // table"), and reusing one sandbox DB across runs would blur which run
  // touched it. Cache stays shared/cacheDir so warmed npm installs are reused.
  const perRunData = join(stateRoot, `data-${runStamp}`);
  const perRunState = join(stateRoot, `state-${runStamp}`);
  mkdirSync(perRunData, { recursive: true });
  mkdirSync(perRunState, { recursive: true });
  // Fresh sandbox HOME for BOTH flavors. v1.18.33 resolves its global config
  // root from $HOME only (XDG_CONFIG_HOME is ignored while HOME is set —
  // verified probe), so its sandbox home gets a `.config/opencode` entry
  // pointing at the candidate. v2 keeps an empty sandbox home layer:
  // OPENCODE_CONFIG_DIR replaces the default root (verified 2.0.20), so the
  // production HOME layer can never appear.
  const homeDir = join(stateRoot, `home-${runStamp}`);
  mkdirSync(join(homeDir, ".config"), { recursive: true });
  if (flavor === "v1") symlinkSync(candidateDir, join(homeDir, ".config", "opencode"), "dir");
  else if (existsSync(join(candidateDir, "vibeguard.config.json"))) {
    // VibeGuard's pinned loader uses HOME/.config/opencode for its global
    // rules, independently of the native host's OPENCODE_CONFIG_DIR.
    // Copy only the staged rules: do not add a second host-config layer.
    mkdirSync(join(homeDir, ".config", "opencode"), { recursive: true });
    writeFileSync(join(homeDir, ".config", "opencode", "vibeguard.config.json"),
      readFileSync(join(candidateDir, "vibeguard.config.json")), { mode: 0o600 });
  }
  const { env } = launcherEnv(flavor, candidateDir, stateRoot, process.env, { cacheDir, homeDir });
  env.XDG_DATA_HOME = perRunData;
  env.XDG_STATE_HOME = perRunState;
  env.OPENCODE_DB = join(perRunData, "opencode.db");
  for (const key of Object.keys(env)) {
    if (key.startsWith("BILI_") || key.startsWith("BILLION_")) delete env[key];
  }
  env.BILI_ADVISORY_CHECK = "0";
  const compressionConfig = join(homeDir, ".config", "billion-context");
  // Upstream resolves XDG_CONFIG_HOME before HOME. Bind this run's explicit
  // settings file rather than leaving its updater to a different directory.
  env.BILI_CONFIG_FILE = join(compressionConfig, "billion-context.json");
  env.ACP_AUTO_UPDATE = "0";
  env.BILI_ADVISORY_CHECK = "0";
  mkdirSync(compressionConfig, { recursive: true, mode: 0o700 });
  writeFileSync(join(compressionConfig, "billion-context.json"), JSON.stringify({ autoUpdate: false, advisoryCheck: false }), { mode: 0o600 });
  // Spawn ONLY through the validated boundary: a launcherEnv()/stage() result
  // object passed as `env`, non-string env values, or an env whose HOME/data
  // roots touch the production share is refused before any subprocess exists.
  const port = freePort();
  const child = spawnSandboxed(opencodeExe, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    env,
    cwd: projectDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  try {
    const deadline = Date.now() + 20000;
    let up = false;
    while (Date.now() < deadline) {
      const r = await fetchJson(`http://127.0.0.1:${port}/`, { timeoutMs: 1500 });
      if (r.status > 0) { up = true; break; }
      await new Promise((res) => setTimeout(res, 250));
    }
    if (!up) {
      check("server-up", false, `serve did not start; log: ${log.slice(0, 400)}`);
      return finish(checks, candidateDir, flavor);
    }
    check("server-up", true, `127.0.0.1:${port}`);

    // the password line can land just after the first successful HTTP response —
    // poll briefly rather than racing it
    let pw = null;
    const pwDeadline = Date.now() + 5000;
    while (Date.now() < pwDeadline) {
      pw = (/server password (\S+)/.exec(log) || [])[1] ?? null;
      if (pw) break;
      await new Promise((res) => setTimeout(res, 200));
    }
    const auth = pw ? { Authorization: "Basic " + Buffer.from(`opencode:${pw}`).toString("base64") } : {};
    if (!pw && flavor === "v2") {
      check("server-password", false, "server password never appeared in serve log — authenticated checks cannot run");
    } else if (!pw && flavor === "v1") {
      // v1.18.33 with OPENCODE_SERVER_PASSWORD stripped serves unsecured and
      // says so in the log; a v1 serve that is neither unsecured nor prints a
      // password would be unusable here and must fail loudly.
      check("server-password", log.includes("unsecured"), `v1 serve auth state unclear (no password line, no 'unsecured' warning)`);
    }

    // Authoritative DB-position evidence, BOTH flavors: inspect the child's
    // actual open file descriptors under /proc/<pid>/fd instead of trusting
    // config output (the 2026-10-01 incident migrated the production DB even
    // while its config looked staged). Every DB-looking fd must resolve under
    // this run's sandbox, and no open path may touch the production opencode
    // data share. Fails closed when the descriptors cannot be inspected.
    const realHome = process.env.HOME && isAbsolute(process.env.HOME) ? process.env.HOME : homedir();
    const dbEvidence = await sandboxDbEvidence(child, perRunData, perRunState, join(realHome, ".local", "share", "opencode"));
    check("sandbox-db", dbEvidence.ok, dbEvidence.detail);

    // External skill discovery honesty (profile-composition-completion §3):
    // this run redirected HOME into the sandbox. Staging proves file-level
    // presence in the candidate only — runtime skill discovery is NOT
    // asserted here, and the external_directory permission entries copied
    // from the source config do not establish that any skill is installed.
    let stagedSkillFiles = 0;
    try {
      const skillRoot = join(candidateDir, "skills");
      const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(dir, e.name));
          else if (e.isFile()) stagedSkillFiles++;
        }
      };
      if (existsSync(skillRoot)) walk(skillRoot);
    } catch {}
    check(
      "skills-discovery-honest",
      true,
      `${stagedSkillFiles} skill file(s) present in the candidate (file-level evidence only); runtime skill discovery NOT asserted from a sandbox HOME — the external_directory permission name alone does not establish that a skill is installed`
    );

    if (flavor === "v2") {
      // Verification must not create a config file in the caller's project.
      // Match the explicit location used for the agent and plugin checks below;
      // an unscoped config request is not evidence about that project.
      const cfg = await fetchJson(`http://127.0.0.1:${port}/api/config?location%5Bdirectory%5D=${encodeURIComponent(projectDir)}`, { headers: auth });
      const layers = extractArray(cfg.body);
      if (!check("config-stack-readable", Array.isArray(layers) && layers.length > 0, `status=${cfg.status}`)) {
        return finish(checks, candidateDir, flavor);
      }
      const stack = layers.map((l) => (l.type === "document" ? `DOC ${l.path}` : `DIR ${l.path}`));
      const expectedStack = [
        `DOC ${join(candidateDir, "opencode.json")}`,
        `DIR ${candidateDir}`,
        `DOC ${join(projectDir, "opencode.json")}`,
      ];
      check(
        "config-stack-isolation",
        JSON.stringify(stack) === JSON.stringify(expectedStack),
        `stack=${JSON.stringify(stack)}; expected exactly candidate layer + project layer, no production global layer (v2.0.20: OPENCODE_CONFIG_DIR replaces the global root)`
      );

      // agents and plugins warm up asynchronously (observed ~4-8s on v2.0.20), and
      // the OMO plugin applies role overrides AFTER ids first appear — poll until
      // the full expected matrix matches or the deadline passes
      const agentUrl = `http://127.0.0.1:${port}/api/agent?location%5Bdirectory%5D=${encodeURIComponent(projectDir)}`;
      const expectedAgents = profile.expected.v2.agents;
      const evalMatrix = (arr) => {
        const byId = Object.fromEntries(arr.map((a) => [a.id ?? a.name, a]));
        let ok = true;
        const details = [];
        for (const [id, exp] of Object.entries(expectedAgents)) {
          const a = byId[id];
          if (!a) { ok = false; details.push(`${id}: MISSING`); continue; }
          if (exp.mode && (a.mode ?? null) !== exp.mode) { ok = false; details.push(`${id}: mode ${JSON.stringify(a.mode)} != ${JSON.stringify(exp.mode)}`); }
          const modelId = a.model?.modelID ?? a.model?.id ?? null;
          if (exp.model && modelId !== exp.model) { ok = false; details.push(`${id}: model ${JSON.stringify(modelId)} != ${JSON.stringify(exp.model)}`); }
          if (exp.systemBytes && typeof a.system === "string" && Buffer.byteLength(a.system, "utf8") !== exp.systemBytes) {
            ok = false; details.push(`${id}: system ${Buffer.byteLength(a.system, "utf8")}B != expected ${exp.systemBytes}B`);
          } else if (exp.systemBytes && typeof a.system !== "string") {
            ok = false; details.push(`${id}: system body not exposed by endpoint (bytes not assertable here)`);
          }
        }
        return { ok, details };
      };
      let agentData = null;
      let agentNote = "unavailable";
      let matrix = { ok: false, details: ["endpoint never returned agents"] };
      const agentDeadline = Date.now() + 20000;
      while (Date.now() < agentDeadline) {
        const r = await fetchJson(agentUrl, { headers: auth });
        const arr = extractArray(r.body);
        if (r.status === 200 && arr && arr.length > 0) {
          agentData = arr;
          agentNote = "via location param";
          matrix = evalMatrix(arr);
          if (matrix.ok) break;
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
      if (!agentData) {
        check("agent-matrix", false, `agent endpoint unavailable (${agentNote}) — config-layer checks alone do not pass verification`);
      } else {
        const details = matrix.details;
        check("agent-matrix", matrix.ok, details.length ? details.join("; ") : `roles OK (${Object.keys(expectedAgents).join(", ")}) [${agentNote}]`);
      }

      // plugin registration also warms up — poll until every expected id is
      // registered (active) or the deadline passes
      const expectedActiveIds = profile.expected.v2.plugins.expectActive.filter((id) => {
        const entry = Object.entries(profile.components ?? {}).find(([, c]) => c.expectActivePluginId === id);
        return !entry || Boolean(stagedComponents[entry[0]]?.staged);
      });
      let statuses = {};
      const pluginDeadline = Date.now() + 20000;
      while (Date.now() < pluginDeadline) {
        const plg = await fetchJson(`http://127.0.0.1:${port}/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(projectDir)}`, { headers: auth });
        const plugins = extractArray(plg.body) ?? [];
        statuses = Object.fromEntries(plugins.map((p) => [p.id ?? p.name, p.state?.status ?? p.status ?? "unknown"]));
        if (expectedActiveIds.every((id) => statuses[id] === "active")) break;
        await new Promise((res) => setTimeout(res, 1000));
      }
      for (const id of expectedActiveIds) {
        check(`plugin-active:${id}`, statuses[id] === "active", `status=${JSON.stringify(statuses[id] ?? "absent")}`);
      }
      for (const id of profile.expected.v2.plugins.forbidIds ?? []) {
        check(`plugin-absent:${id}`, !(id in statuses), `registered statuses for ${id}: ${JSON.stringify(statuses[id] ?? "absent")} — single compression engine rule`);
      }
      check(
        "compression-not-claimed",
        true,
        "metadata-only run: registration never implies full compress/recover readiness; tested native route needs no extra launcher (node resolvable + compaction.auto=false); provider URLs untouched"
      );
    } else {
      const cfg = await fetchJson(`http://127.0.0.1:${port}/config`, { headers: auth, timeoutMs: 20000 });
      const merged = cfg.body;
      if (cfg.status !== 200 || !merged || typeof merged !== "object" || Array.isArray(merged)) {
        check("config-readable", false, `status=${cfg.status}; response kind=${JSON.stringify(merged?.name ?? typeof merged)}; error=${cfg.error ?? "none"}`);
        return finish(checks, candidateDir, flavor);
      }
      check("v1-agent-build-enabled", merged.agent?.build?.disable === false, `build.disable=${JSON.stringify(merged.agent?.build?.disable)}`);
      check(
        "v1-agent-others-disabled",
        ["plan", "explore", "general"].every((k) => merged.agent?.[k]?.disable === true),
        `plan/explore/general disables: ${JSON.stringify([merged.agent?.plan?.disable, merged.agent?.explore?.disable, merged.agent?.general?.disable])}`
      );
      check("v1-model-preserved", merged.model === profile.expected.v1.model, `model=${JSON.stringify(merged.model)}; config keys=${JSON.stringify(Object.keys(merged))}; data keys=${JSON.stringify(merged.data && typeof merged.data === "object" ? Object.keys(merged.data) : [])}`);
      const pluginList = (merged.plugin ?? []).map(String);
      const selection = inspectV1PluginSelection(pluginList, candidateDir, profile, stagedComponents);
      check(
        "v1-plugins-in-candidate",
        selection.ok,
        `plugin=${JSON.stringify(pluginList)}; exact canonical selection=${JSON.stringify(selection)}`
      );
      check(
        "v1-stock-compression",
        selection.ok && selection.compression,
        `fixed stock replacements=${JSON.stringify(selection.replaced ?? [])}; exact staged file selection required; no duplicate npm compressor`
      );
      check("v1-compaction-intent", merged.compaction?.auto === false, `compaction.auto=${JSON.stringify(merged.compaction?.auto)}`);
      check(
        "v1-no-native-agents-root",
        !merged.agents || Object.keys(merged.agents).length === 0,
        "v1 flavor must use the legacy agent root only"
      );
    }
    return finish(checks, candidateDir, flavor);
  } finally {
    // Await the child's ACTUAL exit on every path (success, failed startup,
    // exception): graceful termination first — SIGTERM lets the host flush
    // and close its session DB — then bounded SIGKILL escalation inside
    // childExit, which never returns while the child lives (and returns the
    // observed state immediately if it already exited), so no verify run can
    // strand a host process.
    await childExit(child, { timeoutMs: 5000 });
  }
}

function finish(checks, candidateDir, flavor) {
  const report = {
    schemaVersion: 1,
    lane: "personal-profile",
    kind: "verify-report",
    flavor,
    at: new Date().toISOString(),
    passed: checks.every((c) => c.pass),
    checks,
    limits: [
      "metadata-only: no model requests, no provider calls",
      "compression runtime readiness is NOT asserted; no mandatory launcher is required per upstream native README (150-199); provider URLs untouched",
      "isolation enforced at spawn time (fresh sandbox HOME + per-run data/state via lib/spawn.mjs) and evidenced post-startup by the sandbox-db check over /proc fds; unit tests cover the refusal logic, not a real host run",
      "if sandbox-db fails closed (e.g. /proc unavailable), verification passes nothing — treat as an environment gap, not a pass",
    ],
  };
  try {
    mkdirSync(join(candidateDir, ".oprofile"), { recursive: true });
    const latest = join(candidateDir, ".oprofile", "verify-report.json");
    if (existsSync(latest)) {
      const bytes = readFileSync(latest);
      const previous = JSON.parse(bytes);
      writeFileSync(join(candidateDir, ".oprofile", `verify-${String(previous.at).replace(/[:.]/g, "-")}.json`), bytes);
    }
    writeFileSync(join(candidateDir, ".oprofile", `verify-${report.at.replace(/[:.]/g, "-")}.json`), JSON.stringify(report, null, 2) + "\n");
    writeFileSync(latest, JSON.stringify(report, null, 2) + "\n");
  } catch {}
  return report;
}
