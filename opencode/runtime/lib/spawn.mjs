// personal-profile runtime — the single validated child-process boundary.
//
// Incident (2026-10-01): an ad-hoc probe assigned the launcherEnv() RESULT —
// the wrapper object { env, notes } — directly to the spawn option `env`.
// The child lost every required override, resolved its global root from the
// production HOME, and migrated the production database. This module is the
// structural fix for that exact misuse:
//
//   - assertChildEnv(env) validates, in code, that an environment is a plain
//     string→string record BEFORE node:child_process.spawn is ever called,
//     and refuses the {env, notes} result shape with an error that names the
//     correct call (`result.env`).
//   - spawnSandboxed(file, args, opts) is the only spawn helper this lane
//     uses for hosts. With `sandbox: true` (the default) it additionally
//     refuses environments whose HOME is the caller's real home or whose
//     XDG_DATA_HOME touches the production data share — the sentinel paths
//     of the incident — again before any subprocess exists.
//   - childExit(child) awaits the child's actual exit on every path,
//     escalating to SIGKILL after a timeout, so no verify run ever leaves a
//     host process behind.
//
// Validation is deliberately NOT a comment or a type assertion: the checks
// run at runtime on every spawn.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

export class EnvRefused extends Error {
  constructor(rejections) {
    super(`child env refused before spawn:\n${rejections.map((l) => `  - ${l}`).join("\n")}`);
    this.name = "EnvRefused";
    this.code = 2;
    this.rejections = rejections;
  }
}

/** The production XDG data share relative to the launcher's real HOME. */
function productionDataRoot() {
  const home = process.env.HOME && isAbsolute(process.env.HOME) ? process.env.HOME : homedir();
  return join(home, ".local", "share", "opencode");
}

function isWithin(child, parent) {
  return child === parent || child.startsWith(parent + sep);
}

function refuse(rejections) {
  throw new EnvRefused(rejections);
}

/**
 * Validate a child environment before any subprocess is created.
 * requireSandbox:true (launch time) additionally enforces the isolation
 * invariants: a fresh absolute HOME distinct from the caller's real home,
 * and data/state/cache roots that cannot reach the production data share.
 * requireSandbox:false (stage time) checks value types only — the sandbox
 * HOME and per-run roots are chosen by the caller right before launch.
 * Returns the validated env unchanged on success; throws EnvRefused otherwise.
 */
export function assertChildEnv(env, { requireSandbox = true } = {}) {
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    refuse([`env must be a plain string→string record, got ${env === null ? "null" : Array.isArray(env) ? "an array" : typeof env}`]);
  }
  const reject = [];
  // The exact historical misuse: a {env, notes} result handed over as if it
  // were the environment itself.
  if (
    typeof env.env === "object" && env.env !== null &&
    "notes" in env
  ) {
    reject.push("this is a {env, notes} result object, not an environment — pass result.env (opts.env = launcher(...).env), never the result itself");
  }
  const nonString = Object.keys(env).filter((k) => typeof env[k] !== "string");
  if (nonString.length) {
    reject.push(`non-string env values in: ${nonString.map((k) => JSON.stringify(k)).join(", ")} — an env record maps names to strings only`);
  }
  if (requireSandbox) {
    const prodData = productionDataRoot();
    if (typeof env.HOME !== "string" || !isAbsolute(env.HOME)) {
      reject.push("HOME must be set to an absolute sandbox home before spawn");
    } else {
      const realHome = process.env.HOME && isAbsolute(process.env.HOME) ? process.env.HOME : homedir();
      if (env.HOME === realHome) {
        reject.push(`HOME equals the caller's real home (${realHome}) — a fresh sandbox HOME is required`);
      }
    }
    for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
      const v = env[key];
      if (typeof v !== "string" || !isAbsolute(v)) {
        reject.push(`${key} must be an absolute sandbox path before spawn`);
        continue;
      }
      if (key === "XDG_DATA_HOME" && (isWithin(v, prodData) || isWithin(prodData, v))) {
        reject.push(`XDG_DATA_HOME (${v}) overlaps the production opencode data root (${prodData}) — the session DB must live in an explicit sandbox`);
      }
    }
    // Explicit DB redirect (profile-composition-completion §4): launcherEnv
    // strips inherited OPENCODE_* values, so an OPENCODE_DB present here was
    // set deliberately by the caller. If set at all it must be an absolute
    // path INSIDE this run's sandbox data/state roots — never production,
    // never another absolute location outside the sandbox.
    if (typeof env.OPENCODE_DB === "string" && env.OPENCODE_DB !== "") {
      if (!isAbsolute(env.OPENCODE_DB)) {
        reject.push(`OPENCODE_DB must be an absolute path when set (got ${JSON.stringify(env.OPENCODE_DB)})`);
      } else {
        const sandboxRoots = [env.XDG_DATA_HOME, env.XDG_STATE_HOME].filter((r) => typeof r === "string" && isAbsolute(r));
        if (!sandboxRoots.some((root) => isWithin(env.OPENCODE_DB, root))) {
          reject.push(`OPENCODE_DB (${env.OPENCODE_DB}) is outside this run's sandbox data/state roots — an explicit DB redirect must live inside the per-run sandbox`);
        }
      }
    }
    // Config-redirect validation: arbitrary config injection is never allowed
    // at launch time, and a config-dir redirect must at least be absolute.
    for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT"]) {
      if (typeof env[key] === "string" && env[key] !== "") {
        reject.push(`${key} must not be set at launch — config content injection is stripped by launcherEnv and refused here`);
      }
    }
    if (typeof env.OPENCODE_CONFIG_DIR === "string" && env.OPENCODE_CONFIG_DIR !== "" && !isAbsolute(env.OPENCODE_CONFIG_DIR)) {
      reject.push(`OPENCODE_CONFIG_DIR must be an absolute path when set (got ${JSON.stringify(env.OPENCODE_CONFIG_DIR)})`);
    }
  }
  if (reject.length) refuse(reject);
  return env;
}

/**
 * The one spawn helper for host processes in this lane. Throws EnvRefused
 * BEFORE creating the subprocess on any misuse (result object passed as env,
 * non-string env values, missing sandbox invariants). opts.sandbox:false
 * opts out of the sandbox invariants (stage-time shapes); validation of the
 * string record always applies.
 */
export function spawnSandboxed(file, args, opts = {}) {
  if (opts && typeof opts === "object" && !Array.isArray(opts)) {
    // Second misuse shape: the launcher/stage RESULT passed as the options
    // object. It would often work by accident (opts.env happens to be the
    // inner record) — refuse it so the interface stays unambiguous.
    if ("notes" in opts || "candidateDir" in opts || "manifest" in opts || "components" in opts) {
      refuse(["a launcher/stage RESULT object was passed as spawn options — use { env: result.env, ... }"]);
    }
  }
  const { sandbox = true, ...rest } = opts ?? {};
  const env = assertChildEnv(rest.env, { requireSandbox: sandbox });
  const child = spawn(file, args, { ...rest, env });
  // Capture spawn failures (ENOENT, EACCES) so nothing crashes with an
  // unhandled 'error' event before childExit() can observe the exit path.
  child.on("error", (err) => {
    child.spawnError = child.spawnError ?? err;
  });
  return child;
}

/**
 * Await the child's actual exit on every path. If it is still running after
 * timeoutMs it is asked to terminate gracefully with killSignal (SIGTERM by
 * default), and if it is still alive escalateAfterMs later it is killed with
 * escalateSignal (SIGKILL) — the exit is awaited on every path, so this
 * helper never returns while the child lives and never rejects.
 * Resolves { code, signal, spawnError? }.
 *
 * Already-observed fast path (profile-composition-completion §4): exitCode,
 * signalCode and spawnError are set the moment the corresponding event fires.
 * If any is already observed when this helper is called, the events it would
 * wait on can never fire again — awaiting them would hang forever. Return
 * the observed state immediately instead of waiting.
 */
export async function childExit(child, { timeoutMs = 20000, killSignal = "SIGTERM", escalateSignal = "SIGKILL", escalateAfterMs = null } = {}) {
  if (!child || typeof child.once !== "function") return { code: null, signal: null };
  if (child.spawnError || child.exitCode !== null || child.signalCode !== null) {
    // A failed spawn records the negated errno as exitCode (e.g. -2 for
    // ENOENT); report the same shape as the awaited error path (code null +
    // spawnError), never a pseudo exit code.
    return {
      code: child.spawnError ? null : (child.exitCode ?? null),
      signal: child.spawnError ? null : (child.signalCode ?? null),
      spawnError: child.spawnError ?? null,
    };
  }
  const done = new Promise((resolveExit) => {
    let settled = false;
    const settle = (code, signal) => {
      if (!settled) {
        settled = true;
        resolveExit({ code, signal });
      }
    };
    child.once("exit", (code, signal) => settle(code, signal));
    child.once("close", (code, signal) => settle(code, signal));
    child.once("error", () => settle(null, null));
  });
  const alive = () => child.exitCode === null && child.signalCode === null;
  const timers = [];
  timers.push(setTimeout(() => {
    if (alive()) {
      try {
        child.kill(killSignal);
      } catch {}
    }
  }, timeoutMs));
  timers.push(setTimeout(() => {
    if (alive() && escalateSignal) {
      try {
        child.kill(escalateSignal);
      } catch {}
    }
  }, escalateAfterMs ?? timeoutMs * 2));
  try {
    return await done;
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
}
