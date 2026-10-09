# opencode personal-profile runtime

**Portability:** this is an owner-specific profile with absolute source paths,
external plugin inputs and installation-authority requirements. It is not a
drop-in upgrade for a normal upstream installation on another machine. The
current actual-host verifier requires Linux `/proc`; macOS needs separate
host/DB verification. For a macOS OMO-only build and isolated trial, use
`integrations/omo-slim/MACOS-TRIAL.md` in the matching `opencode-bcp` checkout.

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
- One compression engine per profile: the host-managed `billion-context@latest`
  package. v2 candidates disable legacy compaction (`compaction.auto: false`)
  and never stage an ACP/legacy compression plugin next to the native one;
  `verify` forbids the `acp` plugin id. v1 candidates select the same stock
  npm spec first. OpenCode resolves the public server export and owns package
  cache/lockfiles. The personal profile no longer declares `compressionPlugin`;
  supplying that artifact is refused. The deprecated production composition
  (ACP 1.18.2 + OMO 2.2.25, `acp.jsonc`, `tui.json`) is rollback material,
  not a new v1 build.
  Full compress/recover behaviour is **not** claimed by this tooling — it
  was only smoke-tested on the owner's sandbox host
  (`compression-smoke-v2-fixed-node`: 2 synthetic prompts, 3 HTTP requests,
  0 real LLM calls; search_context returned a healthy empty response).
- No v1 → v2 host DB migration. Session databases stay separate; staging
  never touches XDG data of either host.

## Prompt ownership and multi-host consistency

`runtime/` is the personal profile's build and installation tooling. It checks
source hashes, renders host-specific configuration, stages complete candidates,
verifies them in isolation, and records managed installation/rollback state.
It is not a second collection of builtin-role append prompts.

| Content | Maintenance source | Runtime responsibility |
| --- | --- | --- |
| Five builtin appends: designer, explorer, librarian, oracle, orchestrator | [`../oh-my-opencode-slim/*_append.md`](../oh-my-opencode-slim/) | Check `inputs.omoPromptDir.files` hashes and stage accepted files byte-identically. |
| Native Lark Operator definition | [`assets/agents/lark-operator.md`](assets/agents/lark-operator.md) | Preserve its full body and host-specific native registration; builtin appends do not supply this role. |
| Installable skills and companion files | `generated/skills/` | Package the pinned skill inputs, preserving bytes and executable modes. These are skill files, not role appends. |
| Prompt filtering | `lib/prompts.mjs` | Exclude retired Council overrides and backup files; no append body is embedded here. |

The `document-writer` package no longer mirrors the five appends. Edit them only
in this dotfiles checkout. Candidate and installed copies are outputs, and their
hash inventories are verification metadata, not independently maintained prose.
The repository-owned `profile.json` inputs point at the main checkout rather
than the former phase-1 worktree.

For consistent append content across machines:

1. Select the same approved dotfiles commit on every machine, including its
   `profile.json` prompt hash inventory. A branch name alone can move over time.
2. In each machine's deployment profile, set `inputs.omoPromptDir.source` to
   that checkout's `opencode/oh-my-opencode-slim`. Relocate the other source
   paths as needed. Keep prompt hashes unchanged when only paths change;
   reconcile machine-specific settings and external artifacts separately.
3. Stage through `oprofile`: missing, additional or modified prompt inputs
   refuse staging. After an intentional prompt edit, review the diff and update
   the shared pins; do not re-pin unexpected drift separately on each machine.
4. Install through the machine's existing deployment procedure. Compare the
   five installed file hashes with the selected inventory, and confirm that
   OMO resolves them from the intended directory. Project/preset prompt files
   or inline overrides can change the effective prompt despite identical
   global append files.

This provides one source and an exact-content installation check. It does not
make the complete personal profile machine-independent: local input paths,
plugins, ownership and the Linux-only actual-host verifier still need the
platform-specific handling described above.

## Plugin ownership and generated configuration

`../opencode.json` is the raw host-settings input. It intentionally has no
`plugin` or `plugins` list. Maintain plugin selection in `profile.json`:

- `components` defines the artifact requirements and stock-spec replacements.
- `flavors.v1.stockPlugins` and `flavors.v1.pluginOrder` define v1 selection
  and ordering; `flavors.v2.stockPlugins` defines the v2 stock selection.
- Explicit CLI artifact inputs supply the actual plugin files and directories.

The renderer discards plugin roots from raw host settings and derives them
from those inputs. For v1 it writes `plugin` entries relative to the generated
configuration file, such as `./plugins/omoPluginV1/index.js`, alongside the
host-managed `billion-context@latest` npm spec. For v2 it writes the native
`plugins` list and stages local artifacts for host discovery. The selected
artifact bytes and their manifest identities remain part of verification.

The three legacy absolute entries formerly in `../opencode.json` were ignored
by this process and have been removed. Do not maintain a second plugin list
there or copy the rendered global configuration back into the raw source.
After an intentional raw-settings change, review it and update only the
corresponding `inputs.hostConfigSource.sha256` pin. The installed configuration
is an output of the deployment process, not another maintenance source.

### Billion Context update ownership

Maintain the npm channel in `flavors.*.stockPlugins`, not a package version or
internal `dist/` import in a local wrapper. `latest` is a registry tag; actual
resolution and update cadence depend on OpenCode's package manager/cache.
Record resolved and loaded versions in runtime reports. A report's version is
evidence for that run, not a source-code compatibility allowlist. Host-owned npm
cache files do not belong in the oprofile managed-file inventory.

On OpenCode 1.18.35, an isolated test with an existing `@latest` cache containing
0.1.175 kept that version on startup. Updating that package directory with
`npm install --save-exact --ignore-scripts --no-audit --no-fund billion-context@latest`
and starting a fresh host/proxy loaded 0.1.189. This establishes an explicit
update procedure, not a guarantee about every cache age or future host version.
Find the actual host cache first; in this test it was
`$XDG_CACHE_HOME/opencode/packages/billion-context@latest/`. Run an update from
that directory while its host/proxy are stopped, then verify the resolved
package and fresh process. The host's generated lock may contain a concrete
version even though this profile continues to declare `latest`.

Existing fixed-directory installations need a one-time owner migration: remove
the old wrapper from discovery, change its config entry in place, and update
authority while retaining a rollback copy outside discovery roots. Generic
artifact replacement remains supported for historical/custom profiles, but is
not enabled in this personal profile. Source changes alone do not migrate the
live installation or prove compression/recovery compatibility.

#### Verified v1 deployment (2026-10-09)

The owner's v1 installation now uses this npm channel. After restarting the
OpenCode 1.18.35 backend, the resolved package and the running proxy's health
endpoint both reported 0.1.189. The old `plugins/compressionPlugin` directory
was absent from the live configuration root. This is an observed deployment
version, not a compatibility pin or a requirement for future installs.

The maintained configuration is `profile.json`: both flavors select
`billion-context@latest`; v1 then adds Vibeguard, OMO and BCP in `pluginOrder`,
with `compaction.auto=false`. The raw `../opencode.json` remains a host-settings
input without a second plugin list. The v2 channel declaration is source
configuration, not new v2 runtime acceptance. These startup checks do not
certify full compressed-session recovery.

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

### OMO 3.0.3 installation (2026-10-09, loaded-state acceptance passed)

The generated skill input now targets OMO 3.0.3, with a version-specific
`deepwork` override. Its pinned router/task-directory contract is retained;
the local delta keeps Todo as live status, original-source handoffs,
risk-based review and explicit authorization for commits. The other two
overrides apply to byte-identical upstream files. All twelve personal skills
and all 49 generated file modes are preserved, including the eight approved
plan-skill files and five executable helpers.

Use the committed generated tree as the complete personal source. The raw
`opencode/skills` directory retains the plan-skill sources but is not a complete
mirror: it lacks `grilling` and contains an older `to-spec`. Build into a
separate output and compare all hashes/modes before replacing the input.

At that acceptance, the host-config source was switched to the committed raw
`opencode.json`, after comparison with the installation authority and original
backup. Its preserved user settings, including provider values, matched
production. The later plugin-ownership cleanup removed the ignored legacy
plugin list; plugin selection now belongs solely to the profile and artifact
inputs described above.
Rendered production agent permissions are output and cannot be reused as raw
input. Historical `testedEntrySha256` values remain
distinct from the new build digests in `candidateNote`: a successful build is
not actual-host acceptance. The approved OMO 3.0.3 payload is now installed in
the production config, with 4,859 managed files verified and 34 obsolete OMO
files quarantined outside discovery roots. The user upgraded OpenCode to 1.18.35
and approved retaining it. Fresh isolated checks on that binary passed:
11 metadata, 58 role/permission/skill and 27 BCP checks. The existing production
process then passed exact role/model/variant/mode, readonly permission, skill
body and helper-mode checks. Evidence is recorded separately under
`/home/littlekey/github/opencode-bcp/.slim/deepwork/omo-3.0.3-20261008/proof/host-1.18.35/`;
historical 1.18.33 manifests and tested-version pins were not rewritten. The
OpenChamber installation was not changed. The probes use a scripted local
provider; real-model behavior and full compression recovery remain untested.

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
- `assets/agents/lark-operator.md` — retained full native Lark Operator
  definition, originally captured from `~/.config/opencode/agents/lark-operator.md`;
  it is distinct from the builtin-role appends and is required by the renderer.
- `generated/skills/` — personal skill installation tree, pinned by
  `profile.json`; the historical directory name is retained. OMO bundled
  skills come from the plugin artifact, not this tree.
- `lib/*.mjs` — hash/atomic/inputs/render/prompts/hostenv/spawn/stage/verify/
  activate/manifest/dwbridge (`lib/spawn.mjs` is the one validated spawn
  boundary; `lib/prompts.mjs` keeps the staging exclusions — the anchored
  staged-copy transforms were retired in phase 1; `lib/stage.mjs` carries the
  `STOCK_INHERITED_SKILLS` shadow guard).
- `bin/oprofile.mjs` — CLI.
- `test/profile.test.mjs` — unit tests (`node --test test/profile.test.mjs`). The skill checks no longer import a companion repository's mixed stock/personal generator. Run the complete suite from this directory with `node --test --experimental-test-module-mocks test/*.test.mjs`.

## Skills follow upstream (2026-10-09)

Dotfiles maintains **no copies of OMO's eight bundled skills** in either
`opencode/skills/` or `runtime/generated/skills/`:

`clonedeps`, `codemap`, `deepwork`, `oh-my-opencode-slim`, `reflect`,
`simplify`, `verification-planning`, `worktrees`.

All eight use the selected OMO artifact's original skill bytes and companion
resources. The former local overrides of `codemap`, `deepwork` and
`oh-my-opencode-slim` are retired, including their policy and documentation
changes. Staging refuses personal inputs under any of these eight names, so
an old mixed generated tree cannot silently restore the overrides.

- **v1:** stage exposes every bundled resource through relative file links
  into `plugins/omoPluginV1/server/src/skills/`. Links remain valid after
  candidate relocation; activation materializes managed copies of those
  artifact bytes for the host's file-based skill discovery. Missing required
  skill resources refuse staging.
- **v2:** the plugin registers bundled skills in-process. No same-name skill
  files are staged outside its artifact.
- **Personal skills:** `runtime/generated/skills/` contains 14 personal
  skills / 44 files. Their existing bytes and modes are retained, including
  the plan helpers and the guided-grilling composition. `profile.json`
  inventories this complete installation input.
- `loop-engineering` remains an unregistered legacy resource and is not part
  of the selected skill inventory.

The previous mixed `build-manifest.json` is removed. Do not use
`opencode-bcp/integrations/omo-slim/build-skills.mjs` to replace this tree: its
stock-patching mode would reintroduce the three retired overrides. Maintain
personal files and their companions directly, compare all retained bytes and
modes, and refresh only explained `skillsDir` pins. A broad `oprofile pin`
must not be used to absorb unknown source drift.

### Migrating the personal plan skills

The user-maintained `executing-plans` and `writing-plans` sources are retained
under `opencode/skills/` and their installable copies are pinned under
`runtime/generated/skills/`. The latter is the profile's installation input.
`executing-plans` includes its review template and five executable helpers;
copying only `SKILL.md` leaves it incomplete. Git retains the executable bits,
and stage/activation preserve every helper's `0755` mode.

On another machine, use the committed generated tree rather than requiring
the old machine's live skills directory. Relocate the profile input paths to
the new checkout and deliberately refresh pins after checking the changes.
Keep the complete personal tree, compare retained bytes and modes before
replacing it, and update only the explained profile pins. The upstream OMO
skill payload is supplied separately by the selected plugin artifact.

`test/personal-skills.test.mjs` checks both host stage layouts, byte/mode
identity against the retained sources, relocated installation, repeat install,
rollback, shell syntax, and direct `task-brief` execution with sibling resource
lookup. These are isolated installer checks, not a model-driven workflow test.

### Guided grilling: local composition, unchanged upstream

`opencode/skills/grilling-companion/SKILL.md` contains the local communication
guidance. `opencode/skills/guided-grilling/SKILL.md` is the entry point: it asks
the model to load the installed `grilling` and then `grilling-companion`.
Both have byte-identical installable copies in `runtime/generated/skills/`
and are included in the profile's skill inventory.
The retained upstream `grilling` and `grill-with-docs` files are unchanged.

Invoke it explicitly, for example: **“使用 guided-grilling 帮我梳理这个方案。”**
The companion adds clear explanations, context-aware questions and reasoned
recommendations. It preserves all ready questions, dependency ordering,
user-owned decisions and upstream completion/confirmation requirements. It
does not add a question cap, early stopping rule or the full `mama` persona.
Directly invoking `grilling` still uses the original workflow; existing
`grill-with-docs` calls are not automatically wrapped.

For another machine:

1. Pull this repository's `master` and use the committed generated skills.
2. Include the **two complete new directories** in that machine's normal skill
   deployment. For an ordinary upstream install, its selected skills root may
   be `~/.config/opencode/skills/`; for an existing managed profile, update its
   skill inputs and install through that profile's normal update process.
3. Preserve that machine's upstream `grilling`; it must be discoverable under
   that name and permitted alongside both new skills. The wrapper does not
   silently substitute `grill-me` or download a missing dependency. Do not copy
   this owner's absolute-path profile unchanged onto another machine.
4. Restart OpenCode after installation, then confirm that all three names are
   available. In a small interview, check that both dependency skills load,
   recommendations remain proposals, previously settled decisions are not
   needlessly repeated, and implementation waits for final confirmation.

Keep upstream updates separate from these two local skills. Review their
composition contract after an upstream workflow change. To edit the local
skills, update their `opencode/skills/` sources and corresponding installable
copies, compare all retained bytes/modes, and refresh only the explained
profile pins. The complete personal installation source is
`runtime/generated/skills/`; the editable collection under `opencode/skills/`
does not contain every retained personal skill.

The installer test checks these local sources through v1/v2 relocation,
installation, reinstall and rollback. It does not establish model adherence to
the communication guidance: composition is a prompt contract, not host-enforced
skill inheritance or instruction priority.

### Owner follow-ups (this lane's explicit handover)

1. **Prompt-lane re-pin**: when the prompt lane lands its source
   deletions/appends under `dotfiles/opencode/oh-my-opencode-slim/`, run
   `oprofile pin` (the current pins refuse the changed tree — fail-closed by
   design). The final managed-profile application of the source policy stays
   an owner step.
2. **Global shadow cleanup before cutover**: this repository cleanup does not
   remove files from `~/.config/opencode/skills/`. A v1 candidate replaces its
   managed bundled-skill files with current artifact bytes. A v2 transition
   needs explicit retirement of old global copies, which otherwise shadow
   in-process registration. The generic installer does not retire orphaned
   files or overwrite unmanaged conflicts; reconcile those during cutover.
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
