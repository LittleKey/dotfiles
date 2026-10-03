#!/usr/bin/env node
// personal-profile runtime — oprofile CLI.
//
// Lane tooling: pin / stage / verify / plan-activation / activate / rollback /
// adopt / check-dw / probe-config. One manifest chain (stage manifest → active
// authority). No production activation, no model requests, no commits happen
// inside this tool unless the owner explicitly runs the activation commands
// against a live root; every refusal path writes NOTHING.
//
// Exit codes: 0 ok · 1 usage · 2 refusal/conflict (nothing written) ·
// 3 host detection · 4 missing manifest/authority.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { sha256File } from "../lib/hash.mjs";
import { loadProfile, RefusalError } from "../lib/inputs.mjs";
import { stage, StageRefusal } from "../lib/stage.mjs";
import { verify } from "../lib/verify.mjs";
import { planActivation, activate, rollback, adopt } from "../lib/activate.mjs";
import { readStageManifest, readActiveAuthority } from "../lib/manifest.mjs";
import { checkDw } from "../lib/dwbridge.mjs";
import { spawnSandboxed, childExit } from "../lib/spawn.mjs";

const RUNTIME_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PROFILE_PATH = join(RUNTIME_DIR, "profile.json");

const HOST_POLICY = {
  v1: { floor: "1.18.29", tested: "1.18.33" },
  v2: { floor: "2.0.20", tested: "2.0.20" },
};

function usage(code = 1, message) {
  const text = `usage: oprofile <command> [options]

commands:
  pin [--profile <path>]                  re-pin input hashes in profile.json (deliberate owner action)
  stage --flavor v1|v2 --opencode <exe>   build a candidate (refuses on any invalid input)
        [--out <dir>] [--omo-plugin <dir>] [--omo-v1-plugin <dir>] [--bcp-plugin <file>]
        [--vibeguard-plugin <dir>] [--vibeguard-v1 <dir>] [--compression-plugin <dir>]
        [--production-private]           private production staging: keep credential-named
                                         provider keys in opencode.json (written 0600; key
                                         NAMES recorded only, never values). Default off —
                                         probe staging scrubs credentials.
  verify --stage <dir> --opencode <exe> [--project <dir>]
                                          metadata-only runtime verification of a candidate
  plan-activation --stage <dir> --into <root>
  activate --stage <dir> --into <root> [--replace]
  rollback --into <root>
  adopt --stage <dir> --into <root>       record current live bytes as baseline authority (no writes to managed files)
  check-dw --target <dir> --flavor v1|v2 [--omo-config <path>]
  probe-config --opencode <exe> --project <dir> [--env OPENCODE_CONFIG_DIR=<dir>]
                                          dump the /api/config layer stack (discovery evidence);
                                          sandboxed like verify (fresh HOME/data/state per run)
`;
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(text);
  process.exit(code);
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function collectComponents(args) {
  const out = {};
  const map = {
    "--omo-plugin": "omoPlugin",
    "--omo-v1-plugin": "omoPluginV1",
    "--bcp-plugin": "bcpPlugin",
    "--vibeguard-plugin": "vibeguardV2",
    "--vibeguard-v1": "vibeguardV1",
    // Owner-pinned frozen compression wrapper dir (kind dir, entry index.js,
    // full package dist + node_modules closure; e.g. billion-frozen-*). The
    // name must exist as a pinned component definition in profile.json — a
    // supplied path without one is refused, never accepted blindly.
    "--compression-plugin": "compressionPlugin",
  };
  for (const [flag, name] of Object.entries(map)) {
    const v = argValue(args, flag);
    if (v) out[name] = resolve(v);
  }
  return out;
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(-.*)?$/.exec(String(v).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: Boolean(m[4]), raw: String(v).trim() };
}

function compare(a, b) {
  const [a1, a2, a3] = a.split(".").map(Number);
  const [b1, b2, b3] = b.split(".").map(Number);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

/** Probe a host executable: flavor + version with explicit floor/tested policy. */
export function probeHost(exe) {
  if (!exe || !existsSync(exe)) {
    const err = new Error(`host executable not found: ${exe}`);
    err.code = 3;
    throw err;
  }
  // A `--version` call is not a host launch: no serve, no session DB, no
  // config resolution — inherited env is fine here and it never goes through
  // the serve launcher. Everything that RUNS a host goes through
  // lib/spawn.mjs spawnSandboxed.
  let out;
  try {
    out = execFileSync(exe, ["--version"], { encoding: "utf8", timeout: 15000 });
  } catch (err) {
    const e = new Error(`host --version failed: ${err.message}`);
    e.code = 3;
    throw e;
  }
  const versionRaw = (/(\d+\.\d+\.\d+(?:[-+][^\s]*)?)/.exec(out) || [])[1];
  const version = versionRaw ? parseVersion(versionRaw) : null;
  if (!version) {
    const e = new Error(`cannot parse host version from: ${JSON.stringify(out.slice(0, 120))}`);
    e.code = 3;
    throw e;
  }
  if (version.prerelease) {
    const e = new Error(`host ${version.raw} is a pre-release — rejected (only accepted stable floors are supported)`);
    e.code = 3;
    throw e;
  }
  const flavor = version.major === 1 ? "v1" : version.major === 2 ? "v2" : null;
  if (!flavor) {
    const e = new Error(`unknown host major ${version.major} (${version.raw}) — rejected`);
    e.code = 3;
    throw e;
  }
  const policy = HOST_POLICY[flavor];
  if (compare(version.raw, policy.floor) < 0) {
    const e = new Error(`host ${version.raw} is below the ${flavor} floor ${policy.floor}`);
    e.code = 3;
    throw e;
  }
  return {
    flavor,
    version: version.raw,
    executable: exe,
    runtimeTested: policy.tested,
    minCompatible: policy.floor,
    note: version.raw === policy.tested ? "matches the tested runtime" : "above floor but not the tested runtime — verify before relying on behavior",
  };
}

function defaultOut() {
  const state = process.env.XDG_STATE_HOME || join(process.env.HOME ?? "", ".local", "state");
  return join(state, "opencode-personal-profile", "candidates");
}

async function main() {
  const [, , command, ...rest] = process.argv;
  if (!command) return usage(1, "missing command");
  const profilePath = argValue(rest, "--profile") ?? PROFILE_PATH;

  switch (command) {
    case "pin": {
      const { profile } = loadProfile(profilePath);
      const report = [];
      const updated = pinInputs(profile, report);
      writeFileSync(profilePath, JSON.stringify(updated, null, 2) + "\n");
      process.stdout.write(`pinned ${report.length} input(s) in ${profilePath}\n${report.join("\n")}\n`);
      return process.exit(0);
    }
    case "stage": {
      const flavor = argValue(rest, "--flavor");
      if (flavor !== "v1" && flavor !== "v2") return usage(1, "--flavor must be v1 or v2");
      const host = probeHost(argValue(rest, "--opencode"));
      if (host.flavor !== flavor) {
        const e = new Error(`selected binary is ${host.flavor} (${host.version}) but --flavor ${flavor} was requested`);
        e.code = 3;
        throw e;
      }
      const { profile, profilePath: pp, profileSha256 } = loadProfile(profilePath);
      const outDir = argValue(rest, "--out") ? resolve(argValue(rest, "--out")) : defaultOut();
      const productionPrivate = rest.includes("--production-private");
      const result = stage({ flavor, profile, profilePath: pp, profileSha256, host, outDir, explicit: collectComponents(rest), productionPrivate });
      process.stdout.write(`staged ${result.candidateDir}\n`);
      process.stdout.write(`components: ${JSON.stringify(Object.fromEntries(Object.entries(result.components).map(([k, v]) => [k, v.status])), null, 2)}\n`);
      if (productionPrivate) {
        const priv = result.manifest.privateProduction;
        // Names and counts only — credential values never reach the console.
        process.stdout.write(`private production staging: ${priv.credentialKeyCount} credential key(s) preserved by name in opencode.json (mode 0600): ${priv.preservedCredentialKeys.join(", ") || "none"}\n`);
      }
      return process.exit(0);
    }
    case "verify": {
      const stageDir = argValue(rest, "--stage");
      const { manifest } = readStageManifest(stageDir);
      const exe = argValue(rest, "--opencode");
      const projectDir = resolve(argValue(rest, "--project") ?? process.cwd());
      const { profile } = loadProfile(profilePath);
      const report = await verify({
        candidateDir: resolve(stageDir),
        opencodeExe: exe,
        flavor: manifest.flavor,
        projectDir,
        profile,
        stagedComponents: manifest.components ?? {},
        cacheDir: argValue(rest, "--cache-dir") ?? null,
      });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return process.exit(report.passed ? 0 : 2);
    }
    case "plan-activation": {
      const plan = planActivation({ candidateDir: resolve(argValue(rest, "--stage")), liveRoot: resolve(argValue(rest, "--into")) });
      process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
      return process.exit(plan.ok ? 0 : 2);
    }
    case "activate": {
      const record = activate({
        candidateDir: resolve(argValue(rest, "--stage")),
        liveRoot: resolve(argValue(rest, "--into")),
        replace: rest.includes("--replace"),
      });
      process.stdout.write(`activated ${record.files.length} managed file(s); authority: ${join(resolve(argValue(rest, "--into")), ".oprofile", "active.json")}\n`);
      return process.exit(0);
    }
    case "rollback": {
      const result = rollback({ liveRoot: resolve(argValue(rest, "--into")) });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return process.exit(result.blocked.length === 0 ? 0 : 2);
    }
    case "adopt": {
      const { manifest } = readStageManifest(resolve(argValue(rest, "--stage")));
      const managedPaths = manifest.files.map((f) => f.path).filter((p) => p !== ".oprofile/profile-manifest.json");
      const record = adopt({ liveRoot: resolve(argValue(rest, "--into")), managedPaths });
      process.stdout.write(`adopted ${record.files.length} existing file(s) as baseline authority\n`);
      return process.exit(0);
    }
    case "check-dw": {
      const report = checkDw({
        targetDir: resolve(argValue(rest, "--target")),
        flavor: argValue(rest, "--flavor") ?? "v2",
        personalOmoConfigPath: argValue(rest, "--omo-config") ?? join(RUNTIME_DIR, "..", "oh-my-opencode-slim.json"),
      });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return process.exit(report.pass ? 0 : 2);
    }
    case "probe-config": {
      const exe = argValue(rest, "--opencode");
      const projectDir = resolve(argValue(rest, "--project") ?? process.cwd());
      const envDir = argValue(rest, "--env");
      // Same isolation rules as verify(): fresh sandbox HOME/config/data/
      // state per run, every inherited OPENCODE_* override cleared, the real
      // node dir first in PATH, and the child spawned only through the one
      // validated boundary (a {env, notes} result as env is refused before
      // spawn). The discovery hook --env OPENCODE_CONFIG_DIR=<dir> is kept.
      const sandbox = mkdtempSync(join(tmpdir(), "oprofile-probe-"));
      const home = join(sandbox, "home");
      mkdirSync(join(home, ".config"), { recursive: true });
      const env = { ...process.env };
      for (const k of Object.keys(env)) {
        if (k.startsWith("OPENCODE_")) delete env[k];
      }
      env.HOME = home;
      env.XDG_CONFIG_HOME = join(home, ".config");
      env.XDG_DATA_HOME = join(sandbox, "data");
      env.XDG_STATE_HOME = join(sandbox, "state");
      env.XDG_CACHE_HOME = join(sandbox, "cache");
      env.PATH = `${dirname(process.execPath)}:${env.PATH ?? ""}`;
      if (envDir) env.OPENCODE_CONFIG_DIR = resolve(envDir.split("=", 2)[1] ?? "");
      const port = 24000 + Math.floor(Math.random() * 10000);
      const child = spawnSandboxed(exe, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { env, cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] });
      let log = "";
      child.stdout.on("data", (d) => (log += d));
      child.stderr.on("data", (d) => (log += d));
      let out;
      try {
        const deadline = Date.now() + 20000;
        let up = false;
        while (Date.now() < deadline) {
          try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) }); up = true; break; } catch { await new Promise((r) => setTimeout(r, 250)); }
        }
        const pw = (/server password (\S+)/.exec(log) || [])[1];
        const headers = pw ? { Authorization: "Basic " + Buffer.from(`opencode:${pw}`).toString("base64") } : {};
        out = { up, endpoints: {}, sandbox: { home, data: env.XDG_DATA_HOME, state: env.XDG_STATE_HOME } };
        if (up) {
          for (const ep of ["/api/config", "/api/agent", "/config", "/agent"]) {
            const r = await fetch(`http://127.0.0.1:${port}${ep}`, { headers, signal: AbortSignal.timeout(3000) });
            const t = await r.text();
            out.endpoints[ep] = { status: r.status, body: t.slice(0, 4000) };
          }
        } else out.log = log.slice(0, 500);
      } finally {
        // the child's actual exit is awaited on every path, then the private
        // sandbox is removed — a failed probe leaves no process and no state
        await childExit(child, { timeoutMs: 10000 });
        rmSync(sandbox, { recursive: true, force: true });
      }
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      return process.exit(0);
    }
    default:
      return usage(1, `unknown command ${command}`);
  }
}

function pinInputs(profile, report) {
  const files = (p) => {
    const out = {};
    for (const entry of readdirRecursive(p)) out[entry.rel] = sha256File(entry.abs);
    return out;
  };
  const updated = JSON.parse(JSON.stringify(profile));
  for (const [name, input] of Object.entries(updated.inputs ?? {})) {
    if (input.kind === "file") {
      if (!existsSync(input.source)) throw new Error(`pin: source missing for ${name}: ${input.source}`);
      input.sha256 = sha256File(input.source);
      if (input.liveSource && existsSync(input.liveSource)) input.liveObservedSha256 = sha256File(input.liveSource);
      report.push(`${name}: ${input.sha256}`);
    } else if (input.kind === "dir") {
      if (!existsSync(input.source)) throw new Error(`pin: source missing for ${name}: ${input.source}`);
      input.files = files(input.source);
      report.push(`${name}: ${Object.keys(input.files).length} file(s)`);
    }
  }
  updated.pinnedAt = new Date().toISOString();
  return updated;
}

function readdirRecursive(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readdirRecursive(abs, base));
    else if (entry.isFile()) out.push({ abs, rel: abs.slice(base.length + 1).split(sep).join("/") });
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

const isMain = process.argv[1] && (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith("/oprofile.mjs"));
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`oprofile: ${err.message}\n`);
    process.exit(Number.isInteger(err.code) ? err.code : 1);
  });
}
