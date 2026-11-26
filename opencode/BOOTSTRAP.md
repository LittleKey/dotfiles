# opencode v2 fresh-machine bootstrap (stock OMO migration)

## Current V2 lane

- Select **`oh-my-opencode-slim@3.0.8`** directly in `plugins` through
  `runtime/profile.json`. The host resolves the official, unpatched npm package.
  Do not run the OMO installer afterward: that could change config or add another source.
- No `--omo-plugin` or `--bcp-plugin` on V2. The old patched V2 component is
  retained under `rollbacks.patchedV2OMO` only. V1 is explicitly legacy (patched
  3.0.5 artifact) and is not upgraded to 3.0.8; official 3.0.8 (or 3.0.7) compatibility
  on V1 is not established here.
- Same-release `src/skills` bytes (20 skill files) and upstream `LICENSE` are vendored
  unchanged under `runtime/resources/omo-3.0.8/skills` and `runtime/resources/omo-3.0.8/LICENSE`
  (pinned by `inputs.omoStockSkills308`; see `runtime/resources/omo-3.0.8/PROVENANCE.md`).
  The earlier `runtime/resources/omo-3.0.7/` directory is retained as historical resource
  inventory. These are offline resources, not a second executable plugin.
- Preserve role presets, append prompts, ACP Claude routing and the separate
  Claude guard component. Stage still requires the other declared component flags.
  While `omo-coworkers` (`openchamber/plugin/roles/{document-writer.md,routing.json,audience.md,oracle-line.txt}`)
  is the upstream semantic source for the four reader-aware `document-writer` payloads,
  dotfiles `opencode/oh-my-opencode-slim/` and `opencode/oh-my-opencode-slim.json` own
  the complete static Document Writer and Lark Operator bodies, routing, models, skills
  and permissions: staging copies those pinned local bytes unchanged, without sibling
  coworkers prompts or native-agent shadows. Static OMO routing for `document-writer`
  lives **only** in `opencode/oh-my-opencode-slim.json` (`agents["document-writer"].orchestratorPrompt`)
  and is never duplicated in `orchestrator_append.md`. Do **not** enable the `omo-coworkers`
  extension's legacy `OMO_COWORKERS_ENABLE_WRITER_ROLE=1` runtime transform alongside
  static dotfiles delivery (both extension plugin hooks default off, and uninstalling the
  extension does not remove dotfiles files).
- Future upstream `document-writer` payload updates are applied explicitly and offline
  from a committed local `omo-coworkers` Git revision (after reviewing and updating any
  changed payload SHA-256 pins in `runtime/lib/writer-role-update.mjs`) by running
  `node opencode/runtime/bin/update-writer-role.mjs /path/to/local/omo-coworkers <FULL_40_HEX_COMMIT>`
  from the dotfiles root, then staging and activating through `oprofile`. Source commits
  and `runtime/resources/writer-role/SOURCE.json` binding (`deployable: true` once bound to
  immutable Git objects; initially `sourceCommit: null`, `deployable: false` while pending
  the reviewed source commit) record provenance readiness only—they do not automatically
  stage, install, or activate changes in `~/.config/opencode`, and `deployable: false` is
  descriptive provenance status rather than an enforced programmatic `oprofile stage` gate.
- Existing `opencode/oh-my-opencode-slim.json` and `opencode/opencode.json` remain the
  personal configuration sources; never overwrite them with a generic coworkers overlay
  or auto-import live credentials/settings. Existing global skills/guard migration collisions
  require explicit resolution, not automatic deactivation.
- Before activation, back up and explicitly retire old OMO/BCP config entries
  and discovered artifacts under **both** `plugin/` and `plugins/`. Migration
  preflight refuses old/duplicate sources even with `--replace`; it never
  silently deletes them. JSONC requiring reconciliation also refuses.
- Run stage into a disk-backed candidate directory. Review `plan-activation` before
  any separately authorized activation. No real deployment is performed by repository commits
  or snapshot updates.
- Required real acceptance: isolated V2 host with dedicated HOME/config/data/state/cache
  and no production DB, official package resolution/version evidence, exactly one
  OMO load and no BCP, preserved role models/prompts/modes, Claude ACP and guard
  routing, skill listing and relocation checks. Static assembly determinism and
  metadata/fixture checks (`systemBytes: 9985`, expected model) do not guarantee
  upstream LLM provider prompt-cache hit rates and are not runtime, ACP, model,
  compression or privacy acceptance. After authorized deployment, verify the actual
  served `system` body, `description`, `orchestrator`/`oracle` routing, `model`, and
  `permissions` on the running server (a process restart alone is insufficient).
  Installing/resolving packages, restarting production and paid calls require separate
  authorization.

## Historical bootstrap snapshot (not current install instructions)

The following records the previous patched/BCP deployment; do **not** execute its
installer sequence for the current stock lane.

Verified 2026-10-24 against live host + repos. Goal: replicate this plugin stack on a machine
that has ONLY opencode v2 installed.

## Prerequisites (host)

- opencode v2 (≥2.1.2), Node **≥22.13** (node:sqlite without flag; supervisor evidence reads
  `~/.local/share/opencode/opencode.db` read-only), Bun (for opencode-bcp build), git, mise optional.
- Network reachability for `http://10.126.126.10:3000/v1` (newapi gateway, home LAN) — model calls
  and `digest --draft` both point there by default.

## Component matrix

| # | Component | Fresh-machine install | This-machine form | Gaps / notes |
|---|-----------|----------------------|-------------------|--------------|
| 1 | billion-context (official npm) | add `"billion-context"` (bare name per official docs; this machine uses `@latest` variant) to opencode.json `plugins` + `compaction.auto:false`. Host resolves + installs to `~/.cache/opencode/npm/...` on every start | `billion-context@latest`, currently v0.1.204 | no version pin by design; optional `bili` CLI adds doctor/update |
| 2 | oh-my-opencode-slim (official) | `bunx oh-my-opencode-slim@latest` (registered npm name) | manual `~/.config/opencode/plugins/omoPlugin` v3.0.5 + preset `newapi` + 8 `*_append.md` prompt assets + `acpAgents` block | manual assets backed up in `dotfiles/opencode/oh-my-opencode-slim/` — restore after installer; `acpAgents` (Claude Code) additionally needs `pnpm i -g @agentclientprotocol/claude-agent-acp` + Claude Code CLI + `claude /login` + hand-written config block + restart |
| 3 | opencode-bcp (self-built) | `git clone …/opencode-bcp && bun install && bash scripts/install.sh` → writes single canonical `~/.config/opencode/plugin/blackboard.ts` (v2 auto-discovery; no opencode.json entry) | same, verified byte-identical install manifest | no port/credential deps |
| 4 | omo-coworkers (self-built) | supervisor plugin: via dotfiles component (`--supervisor-plugin ~/github/omo-coworkers/plugins/supervisor`) or manual `cp -r plugins/supervisor ~/.config/opencode/managed-plugins/`; CLI = `node ~/github/omo-coworkers/bin/supervisor-memory.mjs`; store = `supervisor-memory init` (explicit, refuses overwrite) | deployed copy diff-clean vs repo (excl. test/) | `coworkers-install.mjs` installs agents/skills/overlay/claude-advisor but NOT supervisor; `package.json` engines (≥20) looser than reality (≥22.5/22.13) |
| 5 | dotfiles/opencode | `git clone …/dotfiles` → `node opencode/runtime/bin/oprofile.mjs stage --supervisor-plugin … --stale-reasoning … (all provideFlags)` → `verify` → `activate` | components: omoPlugin, bcpPlugin, vibeguardV2, claudeAdvisor, staleReasoning, supervisor (expectActive 7) | component `testedEntrySha256` must be refreshed whenever source repos move (supervisor refreshed to 06778534… on 2026-10-24); `vibeguard.config.json` canonical copy lives at `dotfiles/opencode/vibeguard.config.json` (input `vibeguardConfig` + copyExtras for both flavors — stage carries it, activate installs it at the live config root); credentials/auth never travel with dotfiles — re-run `opencode auth login/import` on the new machine |

## Suggested order

1. Install host prereqs (Node via mise, Bun, opencode v2).
2. Clone `dotfiles`, `opencode-bcp`, `omo-coworkers` under `~/github/`.
3. `oprofile stage` with all provide flags → `verify` → `activate` (renders opencode.json incl.
   supervisor options `{mode:"inject", memory:{enable:true, delivery:"inject"}}`, billion-context entry, agents from `runtime/assets/agents`).
4. `bunx oh-my-opencode-slim@latest`, then restore manual assets from `dotfiles/opencode/oh-my-opencode-slim/`.
5. `cd ~/github/opencode-bcp && bun install && bash scripts/install.sh`.
6. `node ~/github/omo-coworkers/bin/supervisor-memory.mjs init`.
7. Auth: newapi key into opencode (+ `claude /login` if using acpAgents) → restart opencode.

## Known divergences (documented, not blocking)

- `dotfiles/opencode/opencode.json` source vs live host config can drift (live is authoritative
  after manual edits); re-sync source before `activate` on a new machine.
- `acp.jsonc` diverged: live uses ranxianglei/opencode-acp schema (summaryBuffer), dotfiles copy
  is the older DCP schema — refresh when touching ACP config.
- supervisor memory store lives OUTSIDE dotfiles (`~/.local/share/opencode-supervisor/memory/`);
  back it up separately (it is the approved-rule corpus).

## 2026-10-25 配置同步
- acp.jsonc 同步为 live 版(ranxianglei/opencode-acp schema + summaryBuffer)。
- skills 补齐: grilling(上游)/to-spec SKILL.md(live 新版)/writing-for-agents(自 .agents/skills 收编, 原位置已删)。
- oh-my-opencode-slim/ 补 document-writer.md + lark-operator.md。
- 新增 cli.json(light 主题/CLI 插件 pin) + tui.json。
- 用户已删除 ~/.config/opencode/AGENTS.md: user-global 静态发布目标文件若未来需要, 须先手工创建(D8 禁止插件建文件)。
