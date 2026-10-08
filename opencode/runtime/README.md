# opencode personal-profile runtime

Owner-owned staging/activation tooling for the personal OpenCode profile
(v1 `1.18.x` and native-v2 `2.0.x` hosts). This directory is **new** scope
(`dotfiles/opencode/runtime/**`); it never edits the hard-linked production
JSON, prompt sources, global files, or other repos.

Design constraints (from the approved implementation brief):

- One authority for the active profile: `<liveRoot>/.oprofile/active.json`.
  Nothing is "active" unless that record exists and matches.
- Explicit, exact inputs. Every staged byte comes from an input pinned by
  SHA-256 in `profile.json`. Missing, drifted, or unpinned inputs stop
  staging before anything is written (`RefusalError`, exit code 2).
- No `/tmp` paths baked into releases. Owner-provided artifacts (OMO plugin
  bundle, plugins, configs) are copied into the candidate; rendered configs
  and plugin shims reference only the candidate's own final paths.
- One compression engine per profile: the stock `billion-context@0.1.175`
  package. v2 candidates disable legacy compaction (`compaction.auto: false`)
  and never stage an ACP/legacy compression plugin next to the native one;
  `verify` forbids the `acp` plugin id. v1 candidates render the same stock
  npm spec first in the plugin list — the deprecated production composition
  (ACP 1.18.2 + OMO 2.2.25, `acp.jsonc`, `tui.json`) is rollback material,
  not a new v1 build.
  Full compress/recover behaviour is **not** claimed by this tooling — it
  was only smoke-tested on the owner's sandbox host
  (`compression-smoke-v2-fixed-node`: 2 synthetic prompts, 3 HTTP requests,
  0 real LLM calls; search_context returned a healthy empty response).
- No v1 → v2 host DB migration. Session databases stay separate; staging
  never touches XDG data of either host.

## Host discovery facts (verified, metadata-only probes)

- v2 `2.0.20`: `OPENCODE_CONFIG_DIR` **replaces** the `~/.config/opencode`
  root (the home layer does not appear in `/api/config` when the variable
  is set). Candidates therefore set it, plus isolated `XDG_*` homes.
- v1 `1.18.33`: `OPENCODE_CONFIG_DIR` **adds a layer on top of** the home
  root (both layers stay active). v1 probes use a fresh sandbox `HOME` with
  `.config/opencode` pointing at the candidate. `XDG_CONFIG_HOME` alone does
  not replace this host's home configuration root.
- v2 serve requires Basic auth (`opencode:<password from the
  `server password` log line>`); `Bearer` is rejected.
- v2 plugin discovery expects `plugins/<name>/index.js`; staged plugins are
  wired with a one-line re-export shim pointing at the copied artifact
  inside the candidate. An artifact whose own entry is already named
  `index.js` (e.g. the VibeGuard dependency directory) is staged as-is —
  a shim there would shadow its dependency-relative imports and double-list
  the plugin.
- The native compression plugin self-spawns `node`; the launcher therefore
  prepends the real Node binary directory to `PATH` (mise shims break under
  a redirected `HOME`).

## Spawn boundary (post-incident 2026-10-01, required)

A probe once passed the `launcherEnv()` **result object** (`{ env, notes }`)
directly to `spawn`'s `env` option; the child lost every override, resolved
its global root from the production `HOME`, and migrated the production DB.
`lib/spawn.mjs` is the structural fix, and the only spawn path for hosts in
this lane:

- `spawnSandboxed(file, args, { env, ... })` validates the environment IN
  CODE before `child_process.spawn` is called: a `{ env, notes }` result (in
  either misuse shape), any non-string env value, or an env whose `HOME` is
  the caller's real home / whose `XDG_DATA_HOME` overlaps the production
  `~/.local/share/opencode` tree is refused with `EnvRefused` (exit code 2)
  and **no subprocess is created**.
- `assertChildEnv(env, { requireSandbox })` is the validator;
  `requireSandbox: false` is for stage-time shape checks only. Explicit
  redirects are validated too: a non-empty `OPENCODE_DB` must be absolute
  and inside the run's `XDG_DATA_HOME`/`XDG_STATE_HOME` sandbox roots,
  `OPENCODE_CONFIG`/`OPENCODE_CONFIG_CONTENT` are refused outright, and a
  non-empty `OPENCODE_CONFIG_DIR` must be absolute.
- `childExit(child)` first returns the already-observed state when the
  child has exited or errored before the call (no waiting on events that
  cannot recur); otherwise it sends `SIGTERM` at `timeoutMs` and escalates
  to `SIGKILL` at `escalateAfterMs` (default `2x`) — no verify/probe run
  can strand a host process.
- Every verification run (both flavors) gets a fresh sandbox `HOME` (v1's
  points `.config/opencode` at the candidate; v2 relies on
  `OPENCODE_CONFIG_DIR` replace semantics), per-run private data/state dirs,
   an explicit sandbox DB root, and all inherited `OPENCODE_*` overrides
   cleared before the validated values are set. Both host flavors explicitly
   enable `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`, matching the
   current production host's native background-task capability. The
   `sandbox-db` verify check inspects the serve process's open
   file descriptors under `/proc/<pid>/fd` **and those of its owned
   descendants** (a wrapper launcher's children included) and fails closed
   if no DB descriptor can be found inside the run's sandbox — an existing
   DB file on disk is never accepted as proof of this process's DB
   position.
- Prompt staging (`lib/prompts.mjs`): Council replacement prompts
  (`council.md`, `council_append.md`) and pre-optimization `*.bak-promptopt`
  files never enter a candidate (decision 2026-09-30: Council returns to
  upstream OMO behaviour). Since the phase-1 follow-upstream
  (`upstream-defaults-20261006`) all other prompt files stage
  **byte-identical** to their pinned sources: the old staged-copy Council
  prune and the v2 `task_id`→`sessionID` translation were **retired** —
  prompt content policy lives in the sources themselves, and BCP
  `session_id` / metadata `task_id` identifiers are never rewritten anywhere.
- `probeHost`'s `--version` call is version detection only (no serve, no
  DB) and intentionally does not use the serve launcher.

## Commands (`bin/oprofile.mjs`)

```
oprofile pin                                   re-pin input hashes (deliberate owner action)
oprofile stage  --flavor v1|v2 --opencode <exe> [--out <dir>]
                [--omo-plugin <dir>] [--omo-v1-plugin <dir>] [--bcp-plugin <file>]
                [--vibeguard-plugin <dir>] [--vibeguard-v1 <dir>]
oprofile verify --stage <dir> --opencode <exe> [--project <dir>] [--cache-dir <dir>]
oprofile plan-activation --stage <dir> --into <root>
oprofile activate --stage <dir> --into <root> [--replace]
oprofile rollback --into <root>
oprofile adopt --stage <dir> --into <root>
oprofile check-dw --target <dir> --flavor v1|v2 [--omo-config <path>]
oprofile probe-config --opencode <exe> --project <dir> [--env OPENCODE_CONFIG_DIR=<dir>]
```

Exit codes: `0` ok · `1` usage · `2` refusal/conflict (nothing written, or
rolled back) · `3` host probe rejection (unknown major, pre-release,
below floor) · `4` missing state (no manifest / no authority record).

Host floors are `v1 >= 1.18.29`, `v2 >= 2.0.20`; tested versions are
`1.18.33` and `2.0.20`. Unknown majors and pre-releases are rejected.

## Lifecycle

### OpenChamber local-path display compatibility

OpenChamber 1.24.2 checks relative plugin paths against the selected project
directory, whereas OpenCode resolves them against the config file. For an
installed v1 profile, the optional maintenance command below converts local
registrations to absolute paths and removes options-free registrations already
covered by root-level plugin discovery. It does not delete plugin files or
restart the host. Staging still uses relocatable relative paths.
Plain absolute paths are intentional: this client version also classifies
`file://` URLs as npm package specs.

```bash
node bin/normalize-plugin-paths.mjs --root /absolute/installed/config/root
node bin/normalize-plugin-paths.mjs --root /absolute/installed/config/root --apply
```

The command requires matching installed authority and manifest hashes. It
backs up private bytes with mode `0600`, preserves unrelated settings, and
updates the installed hash records. If an owner handover also tracks the live
manifest as a rollback extra, supply `--handover-state /path/to/APPLIED.json`
so its existing checkpoint is updated after validation. It does not modify
the original staged candidate or its rollback baseline. Caught write failures
restore applied files; cross-file power-loss atomicity is not provided.

1. `pin` records SHA-256 of every source of record (dotfiles prompts, OMO
   config, `AGENTS.md`, live `agents/lark-operator.md`, production
   `opencode.json` as models source, the generated `generated/skills/` tree)
   into `profile.json`.
2. `stage` verifies all inputs, verifies any explicitly supplied owner
   artifacts (entry hash vs `testedEntrySha256`; a mismatch of an
   `explicit`-required artifact is a refusal, never a silent accept —
   note the OMO artifacts are directory copies whose entry hash records the
    tested build, so a rebuilt candidate is reported as
    `staged-differs-from-tested`, not silently accepted), copies
    inputs into a temp dir (prompt copies byte-identical; exclusions as
    above), renders
   `opencode.json` for the flavor, writes plugin shims, writes the stage
   manifest **into** the temp dir, then atomically renames it into place.
   A failed stage leaves no output.
3. `verify` boots the candidate against an isolated host binary through the
   validated spawn boundary (`lib/spawn.mjs`) with a fresh sandbox HOME,
   per-run private data/state dirs and an explicit sandbox DB, and asserts,
   metadata-only (no model requests): the `/api/config` layer stack is
   exactly candidate-doc → candidate-dir → project-doc; the expected agent
   matrix (id, mode, model, system bytes) matches; expected plugins are
   active (v1 additionally accepts the stock `billion-context` npm spec
   alongside the candidate's own staged plugin URLs) and forbidden ids are
   absent; and the serve process tree's actual session DB
   lives inside the run's sandbox (`sandbox-db`, proven via `/proc`
   descriptors of the child and its owned descendants, fail-closed). Cold-cache npm installs can make the OMO
   plugin miss its registration window — pass `--cache-dir` pointing at a
   warmed cache for stable runs. Plugin/agent registration is asynchronous
   and polled until the deadline.
4. `adopt` records the current live bytes as a baseline authority without
   writing managed files (first run on an unmanaged root).
5. `activate` refuses a different stage than the current authority unless
   `--replace` is given, refuses symlinks/unmanaged surprises, backs up each
   managed file, then atomically replaces them. Any mid-apply failure rolls
   back every applied file and restores the previous authority. The
   authority record is written last (commit point).
6. `rollback` restores each entry from its backup; a file modified after
   activation is **blocked**, never overwritten, and the authority record is
   kept for reconciliation.

## Handled-failure limits (honest)

- Activation is atomic per file, not transactional across files. A crash
  between two renames is not covered; power loss is not covered. Rollback
   repairs what `activate` tracked, from the backups it made.
- Rollback restores bytes, not inode/link topology. Hard-link twins of a
  managed file are preserved on replacement (new inode for the candidate
  copy) but are not re-linked by rollback.
- Activation checks authority membership, but does not generally compare
  managed live bytes against the old authority before replacement. The 2.0.0
  production handover separately checks a prepared hash/mode baseline before
  writing; that release-specific guard must not be attributed to every
  standalone `activate` call.
- `verify` is metadata-only: config stack, agent matrix, plugin ids. It does
  not prove prompt retention end-to-end, tool-definition equality, or
  compression behaviour; those need the owner's fixture harness and real
  sessions.
- Unit tests prove the spawn boundary refuses the `{env, notes}` misuse and
  sentinel production HOME/DB paths, and that exits are awaited — they do
  NOT substitute for a real zero-model host run; the owner runs that proof
  after review. `sandbox-db` fails closed when `/proc` is unavailable, which
  fails verification rather than assuming isolation.
- Combined document-writer/OMO precedence (native root vs plugin-expanded
  roles) is not established by this lane; `check-dw` reports the conflicts,
  it does not resolve them.

## document-writer bridge (`check-dw`)

Reports, never silently resolves:

- `DW-INSTALL-PRESENT` — a document-writer install manifest exists at the
  target (informational).
- `MODEL-OWNERSHIP` — dw's generic overlay sets
  `agents.<role>.inheritModelFrom: "session"` while the personal OMO config
  pins an explicit model/variant for the same role. Effective model becomes
  ambiguous. **Bounded fix requiring owner approval of the generic
  installer:** omit `inheritModelFrom` when the target profile pins an
  explicit model. Not applied by this lane.
- `MODE-MISMATCH` — dw renders `lark-operator.md` with hard-coded
  `mode: subagent` while the personal profile requires `mode: all`.
  **Bounded fix:** make the mode configurable in dw's renderer. Not applied
  here.
- `PROMPT-AUTHORITY` — dw ships its own role prompt files while the personal
  profile keeps prompt authority in the OMO prompt dir / native root;
  combined precedence is unestablished (report-only).
- Host delegation vocabulary is reported (`v1: task`, `v2: subagent`).
  BCP `session_id` and metadata `task_id` identifiers are never rewritten.

## Files

- `profile.json` — pinned inputs, components, flavor rules, expectations.
- `assets/agents/lark-operator.md` — snapshot of the live global
  `~/.config/opencode/agents/lark-operator.md` (exists only there today).
- `generated/skills/` — generated skills tree (build output, pinned by
  `profile.json`); see "Skills follow upstream" below.
- `lib/*.mjs` — hash/atomic/inputs/render/prompts/hostenv/spawn/stage/verify/
  activate/manifest/dwbridge (`lib/spawn.mjs` is the one validated spawn
  boundary; `lib/prompts.mjs` keeps the staging exclusions — the anchored
  staged-copy transforms were retired in phase 1; `lib/stage.mjs` carries the
  `STOCK_INHERITED_SKILLS` shadow guard).
- `bin/oprofile.mjs` — CLI.
- `test/profile.test.mjs` — unit tests (`node --test test/profile.test.mjs`). The stock-skill consistency assertion imports the companion `opencode-bcp` repository from `~/github/opencode-bcp`; set `OPROFILE_BCP_ROOT` to use another checkout. Run the complete suite from this directory with `node --test --experimental-test-module-mocks test/*.test.mjs`.

## Skills follow upstream (phase 1, `upstream-defaults-20261006`)

`oh-my-opencode-slim` 3.0.1 registers its packaged skills **in-process** from
the plugin artifact's own `src/skills/<name>/SKILL.md` (`CUSTOM_SKILLS`
registry). The staged OMO artifact carries `src/skills/**` verbatim, so stock
skills need no local copies — a same-named file copy under a skills root only
**shadows** the in-process registration (the plugin's own legacy-copy warning)
and drifts from the executing code. Skills are **not appendable** (no host or
plugin mechanism extends a packaged `SKILL.md`), so the only auditable way to
carry a local delta is a full file copy of pinned stock bytes + a small
anchored patch.

Layout:

- **Inherited, never copied** (provided by the artifact's in-process
  registration): `clonedeps`, `reflect`, `simplify`, `verification-planning`,
  `worktrees`. Staging refuses any of these names from a skills input
  (`refuseStockSkillShadow`) — remove a shadowing copy, never delete the skill.
- **Patched copies** (stock bytes + `integrations/omo-slim/skill-overrides/<name>.json`):
  `codemap` (navigation-index policy), `deepwork` (Todo-live-status state,
  user-authorized commits, risk-based Oracle gates; the stock session-pinned
  `.slim/deepwork/<session-id>.md` contract is kept — the plugin hook embeds
  it), `oh-my-opencode-slim` (config fact corrections verified against 3.0.1
  loader code: project-local config/prompts, 4-level prompt lookup,
  inline `prompt`/`orchestratorPrompt` support).
- **Personal skills**: copied verbatim from the pinned personal source into
  the generated tree.
- `loop-engineering` (packaged but not registered in-process) is excluded
  everywhere.

Regeneration (deterministic; refuses on version drift, missing/drifted stock
bytes, or anchor drift; emits `build-manifest.json` provenance):

```bash
node integrations/omo-slim/build-skills.mjs \
  --package-dir ~/.cache/opencode/packages/oh-my-opencode-slim@3.0.1/node_modules/oh-my-opencode-slim \
  --personal-dir ~/.config/opencode/skills \
  --out-dir dotfiles/opencode/runtime/generated
```

`runtime/generated/skills/` is the pinned `skillsDir` source; re-run the
builder, then `oprofile pin`, whenever stock or personal sources change.

### Migrating the personal plan skills

The user-maintained `executing-plans` and `writing-plans` sources are retained
under `opencode/skills/` and their installable copies are pinned under
`runtime/generated/skills/`. The latter is the profile's installation input.
`executing-plans` includes its review template and five executable helpers;
copying only `SKILL.md` leaves it incomplete. The generator records source and
output modes, and stage/activation preserve every helper's `0755` mode.

On another machine, use the committed generated tree rather than requiring
the old machine's live skills directory. Relocate the profile input paths to
the new checkout and deliberately refresh pins after checking the changes.
To regenerate from that tree, pass `runtime/generated/skills` as
`--personal-dir` and a separate output directory as `--out-dir`; compare the
new manifest before replacing the installation input. Never use an output
directory that contains the personal source.

`test/personal-skills.test.mjs` checks both host stage layouts, byte/mode
identity against the retained sources, relocated installation, repeat install,
rollback, shell syntax, and direct `task-brief` execution with sibling resource
lookup. These are isolated installer checks, not a model-driven workflow test.

### Owner follow-ups (this lane's explicit handover)

1. **Prompt-lane re-pin**: when the prompt lane lands its source
   deletions/appends under `dotfiles/opencode/oh-my-opencode-slim/`, run
   `oprofile pin` (the current pins refuse the changed tree — fail-closed by
   design). The final managed-profile application of the source policy stays
   an owner step.
2. **Global shadow cleanup before cutover**: old same-name copies under
   `~/.config/opencode/skills/` shadow the inherited registrations. The five
   inherited names are no longer installed by any candidate, so existing
   unmanaged copies at a live root must be archived/removed by the owner
   (this lane never deletes unmanaged files); the three patched names are
   reinstalled as managed files, but a pre-existing **unmanaged** copy at the
   same path makes activation refuse — archive it first, then activate.
3. **Host runtime verification**: `verify` counts the staged skill files only;
   it does NOT assert runtime skill discovery (the in-process v2 registration
   and any v1 `ctx.skill` behavior are untested on real hosts). Actual
   availability of the inherited skills on v1/v2 hosts must be confirmed by
   the owner's real matrix before cutover. If host discovery for a file-copy
   skill is missing on some host, do NOT delete skills to work around it —
   report the discovery gap for an upstream/launcher fix.

## What this lane deliberately does not do

- No production activation, no commits, no model requests against real
  providers, no writes outside `dotfiles/opencode/runtime/**` (staging and
  verification write only to owner-chosen `/tmp` or state dirs).
- No BCP privacy-transport artifact is staged: that lane's acceptance is
  unresolved, so the artifact input is `explicit`-required and staging
  refuses without it rather than fabricating a release.
- No v1 host DB migration, no dual compression engines, no edits to
  hard-linked core/OMO JSON or prompt sources.
