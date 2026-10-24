# opencode v2 fresh-machine bootstrap (portability matrix)

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
| 5 | dotfiles/opencode | `git clone …/dotfiles` → `node opencode/runtime/bin/oprofile.mjs stage --supervisor-plugin … --stale-reasoning … (all provideFlags)` → `verify` → `activate` | components: omoPlugin, bcpPlugin, vibeguardV2, claudeAdvisor, staleReasoning, supervisor (expectActive 7) | component `testedEntrySha256` must be refreshed whenever source repos move (supervisor refreshed to 06778534… on 2026-10-24); credentials/auth never travel with dotfiles — re-run `opencode auth login/import` on the new machine |

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
