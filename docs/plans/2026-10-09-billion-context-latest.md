# Billion Context official npm/latest migration

> Execution status (2026-10-09): the npm-channel migration and production restart verification are complete. Validation covered 59 runtime tests, 11 transaction tests, installation/reinstallation/rollback rehearsal, isolated host startup, and the running production proxy reporting 0.1.189. Full compression/decompression and old synthetic-state recovery were not certified; the original checklist below is a planning record, not a claim that every planned check ran. Current configuration and update guidance are in [the runtime README](../../opencode/runtime/README.md#billion-context-update-ownership). Machine-local deployment records and rollback backups remain outside the committed source.

**Goal:** Upgrade the current OpenCode installation using `billion-context@latest`, removing the manually frozen compression directory and per-version source maintenance.

**Architecture:** The profile owns the npm spec and plugin order. OpenCode owns npm package resolution/cache and loads the public `./server` export. Existing local OMO, VibeGuard and BCP artifacts remain unchanged. Reports record observed package/host versions; they do not become supported-version allowlists. The one-time migration moves the old managed compression tree outside discovery and updates the exact configuration/authority transactionally.

**Tech Stack:** OpenCode 1.18.35, Node.js, existing oprofile renderer/manifest/spawn helpers, node:test; Linux isolated HOME/XDG/database.

**Spec:** User approval on 2026-10-09 of official npm entry plus latest channel, followed by explicit permission to work in the current master checkout. This supersedes the fixed 0.1.189 plan. Latest observed during investigation was 0.1.189; resolve again during verification rather than prescribing that version in source.

## Constraints

- Preserve the three existing uncommitted plugin-source cleanup changes. No commits, pushes, or production activation without further approval. Candidate conclusion precedes live activation.
- Preserve production models, permissions, roles, skills and the other three plugin trees. Repository-only skill cleanup is not part of this deployment.
- Keep one compressor, its first position in the plugin array, and `compaction.auto=false`. No launcher/proxy route is introduced alongside native plugin mode.
- Heavy commands run serially with MemoryMax=3G and MemorySwapMax=0. Hosts use `spawnSandboxed`, fresh HOME/XDG/cache and actual DB-FD evidence. No real model requests or production state in fixtures.
- npm latest is a movable tag, not a promise of an update on each startup. Verify cached restart and explicit update behavior and document what is observed. Don't silently enable unrelated auto-update settings.
- Evidence goes in `.slim/deepwork/billion-latest-20261009/`; the execution ledger belongs to this plan's `.plans/` workspace. No historical evidence deletion. Disk expansion has removed the earlier capacity blocker.

## Review Focus

1. Default export is DSH in recent packages; prove OpenCode chooses its public server entry.
2. No duplicate compressor or old auto-discovered wrapper after migration.
3. No unrelated production files or private values in reports, and no production database/cache touched during verification.
4. Cached restart/update semantics are measured, not inferred from the word latest.
5. Rollback restores old bytes, modes and authority; user drift and escaping links are rejected before writes.

### Task 1: Remove personal version pins and prove renderer behavior

**Files:** `opencode/runtime/profile.json`, `opencode/runtime/README.md`, `opencode/runtime/lib/stage.mjs` comments, `opencode/runtime/test/profile.test.mjs`, new `opencode/runtime/test/compression-channel.test.mjs`.

**Interface:** `flavors.{v1,v2}.stockPlugins = ["billion-context@latest"]`; no current `components.compressionPlugin`. Existing generic explicit-artifact refusal remains applicable. Historical frozen-profile fixtures explicitly declare their own version.

- [ ] Add tests for current-profile npm-only selection, no staged compression directory, unchanged plugin order, rejected undeclared old artifact, and unexpected/duplicate compressors. Watch current-profile expectations fail before editing.
- [ ] Remove the current frozen component, update stock specs and current descriptions, preserve all input pins and unrelated components. Keep generic replacement support for historical/custom profiles.
- [ ] Run targeted tests, then `node --test --test-concurrency=1 --experimental-test-module-mocks test/*.test.mjs` in runtime. Expected: all pass; no host calls. Document current-vs-historical ownership.

### Task 2: Verify actual npm resolution and updates on the current host

**Files:** evidence-root `probe-npm.mjs`, `proof/NPM-HOST.json`, isolated case directories.

**Interface:** report includes registry observation, installed version/export/lock, active plugin/tool evidence, actual isolated DB paths, startup/restart results and explicit update observations. Keep raw failed runs.

- [ ] Start a minimal isolated 1.18.35 host with the npm spec, initialize a project, and prove the compression tools/native proxy originate from that package's server entry.
- [ ] Inspect installed cache/lock and restart the same sandbox. Exercise the supported explicit npm-cache update path against a disposable old-version cache if needed; do not modify production cache or infer startup update cadence.
- [ ] Gate: if public npm loading fails, stop with evidence rather than substitute a hidden local wrapper. Expected: actual latest native integration and a truthful update procedure.

### Task 3: Prepare the real-profile migration and verify it

**Files:** evidence-root `candidate.mjs`, `transaction.mjs`, `transaction.test.mjs`, `verify-recovery.mjs`, `proof/{BASELINE,CANDIDATE,HOST,RECOVERY,REHEARSAL}.json`, `ACCEPTANCE.md`.

**Interfaces:** candidate derives from current active authority, changes only the first plugin spec and managed compression removal. `transaction.mjs --rehearse|--activate|--rollback` has no implicit live action. Reports bind exact candidate/config hashes and observed npm resolution.

- [ ] Capture complete current affected bytes/modes/authority and reject unexplained drift or link escapes. Build a candidate from the active version, not the latest unrelated repository inputs.
- [ ] Write failing transaction tests for drift, partial-write recovery, repeated install, rollback authority restoration and post-install edits; implement the smallest bounded migration and obtain green tests.
- [ ] Exercise installation/reinstallation/rollback on an isolated copy; preserve the retired wrapper outside plugin discovery and keep npm cache host-owned rather than adding its files to oprofile ownership.
- [ ] Run the full candidate host with exactly four plugins, role/permission comparisons, and loopback compression/decompression plus old synthetic state recovery. Report any unsupported recovery boundary honestly; do not equate startup with full recovery.
- [ ] One fresh non-author final review of the diff, transaction and evidence; one bounded important-fix pass. Submit candidate conclusion and wait for live approval.

### Task 4: Approved production switch and loaded-version confirmation

**Files:** evidence-root `proof/ACTIVATION.json`, `COMPLETION.md`; live config's plugin entry, retired compression tree and necessary authority records only.

**Interface:** reuse reviewed transaction and unchanged candidate; latest drift between review and activation invalidates claims for the newly resolved version.

- [ ] After explicit approval, recheck baseline and npm resolution, apply the bounded transaction and verify all unrelated global files unchanged.
- [ ] User chooses an idle restart. Confirm new host process, actual loaded package/proxy version and single compression entry. Until restart, report disk installation separately from runtime activation.

## Pre-flight rulings

- Existing generic staging already rejects supplied components missing a profile definition, so no new version-specific CLI guard is needed.
- Historical fixed-wrapper fixtures remain explicit historical profiles; no global replacement of old version strings.
- The approved channel proposal authorizes this replacement plan; no additional design approval is needed before tasks 1–3. Production approval remains separate.
