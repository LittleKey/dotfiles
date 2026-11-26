# opencode v2 fresh-machine bootstrap (stock OMO migration)

## 2026-11-26 OMO 原生配置所有权移交与旧写入链退役（Ownership Handoff to `omo-coworkers` v6.0.0+ / v6.1.0 Config Manager）

- **OMO 原生提示词与受管配置已移交 `omo-coworkers` OpenChamber 扩展（`v6.0.0` 迁入，`v6.1.0` 升级为 OMO 配置管理器）**：
  - `oh-my-opencode-slim.json`、`oh-my-opencode-slim.jsonc` 及 `oh-my-opencode-slim/**`（7 份提示词文件与内置角色/ACP 指导文本配置叶节点）的实际部署与日常更新所有权已自 `v6.0.0` 起移交至 [`omo-coworkers`](https://github.com/LittleKey/omo-coworkers) OpenChamber 扩展，并在 **`v6.1.0`** 升级为直接管理原生 OMO 文件的 **OMO 配置管理器（Config Manager，API v2）**（支持自动读取受保护结构快照、普通模型/预设/ACP 字段差量编辑、提示词按需显式揭露、5 族独立内置增强模板与用户模板、真实 `before`/`after` 差异预览、条件撤销与中断恢复，取代了 `v6.0.0` 的七项声明与仅 10 个叶节点捆绑审批面板，不再经由本仓库安装器写入）。
  - `runtime/profile.json` 已记录退役所有权元数据：
    ```json
    "ownership": {
      "status": "retired",
      "owner": "omo-coworkers OpenChamber extension",
      "paths": ["oh-my-opencode-slim.json", "oh-my-opencode-slim.jsonc", "oh-my-opencode-slim/**"],
      "historicalInputsOnly": true
    }
    ```
- **代码层整条工作流写入前拒绝（无绕过参数）**：
  - `runtime/lib/ownership.mjs`（`assertLegacyOwnership`）与 `runtime/lib/activate.mjs` 实施独立于候选清单和 authority 记录的代码级保留路径围栏：凡候选清单（`manifest.files`）、现有活动 authority 记录（`.oprofile/active.json`）、`adopt` 路径集或 `rollback` 记录包含 `oh-my-opencode-slim.json`、`oh-my-opencode-slim.jsonc` 或 `oh-my-opencode-slim/**`（含归一化后的相对路径别名），`oprofile plan-activation`、`oprofile activate`（即使传入 `--replace`）、`oprofile adopt` 与 `oprofile rollback` **均在任何文件写入前拒绝整条工作流**（退出码 `2`）。
  - `node opencode/runtime/bin/update-writer-role.mjs`（`runtime/lib/writer-role-update.mjs` `updateWriterRole`）在检测到 `profile.ownership.status === "retired"` 时，会在访问源 Git 仓库或执行任何回调/文件写入前立即拒绝退出。
- **历史输入与实时配置漂移注意（`historicalInputsOnly: true`）**：
  - 本仓库保留的 `opencode/oh-my-opencode-slim.json`、`opencode/oh-my-opencode-slim/*.md`、`opencode/runtime/resources/writer-role/` 及 `oprofile stage` 仅作为**离线历史暂存（staging）与个人模型/技能/权限/ACP 传输配置参考**，不再是受支持的实时配置部署通道。
  - **切勿用本仓库历史 `oh-my-opencode-slim.json` 覆盖本机实时配置**：本仓库历史文件中 `acpAgents.antigravity.permissionMode` 仍为旧值 `"reject"`，而实际运行环境（live `~/.config/opencode/oh-my-opencode-slim.json`）已改为 `"ask"`。`omo-coworkers`（`v6.0.0+` / `v6.1.0` 配置管理器与 5 族独立内置模板）通过 JSONC AST 局部差量编辑保留用户未改动的 `model`、`permissions`、`skills`、ACP `command`、JSONC 注释与实时 `permissionMode`（`"ask"`），绝不将 `"reject"` 导入为默认值。

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
- **OMO prompt & config ownership retired to `omo-coworkers` (`v6.0.0+` / `v6.1.0` Config Manager)**:
  While `opencode/oh-my-opencode-slim/` and `opencode/oh-my-opencode-slim.json` remain
  pinned in `runtime/profile.json` as historical staging inputs (`historicalInputsOnly: true`)
  for personal role models, skills, permissions, and ACP transport definitions, live deployment
  and updates of `oh-my-opencode-slim.json(c)` and `oh-my-opencode-slim/**` now belong exclusively
  to the `omo-coworkers` OpenChamber extension (`v6.0.0+`; upgraded in `v6.1.0` to the OMO Config Manager
  with differential ordinary-field editing, 5 independent bundled template families, real before/after diff preview,
  conditional undo, explicit recovery, and `.omo-coworkers/behavior.json` plugin settings).
  `oprofile plan-activation`, `activate` (even with `--replace`), `adopt`, `rollback`,
  and `node opencode/runtime/bin/update-writer-role.mjs` refuse any operation touching those transferred
  paths before writing. Keep `OMO_COWORKERS_ENABLE_WRITER_ROLE` unset (off) when using native OMO configuration.
- **Historical `update-writer-role.mjs` & `SOURCE.json` record (retired for active updates)**:
  Prior to the `v6.0.0` ownership handoff, upstream `document-writer` payload updates were pulled
  offline via `node opencode/runtime/bin/update-writer-role.mjs /path/to/local/omo-coworkers <FULL_40_HEX_COMMIT>`.
  Because `runtime/profile.json` now has `ownership.status: "retired"`, `updateWriterRole` refuses active
  execution before any Git read or file write; `runtime/resources/writer-role/` and pure composition helpers
  remain in the repository solely as historical reference and isolated fixture test coverage.
- Existing `opencode/oh-my-opencode-slim.json` and `opencode/opencode.json` remain the
  historical personal configuration reference in this checkout; never overwrite live `~/.config/opencode/oh-my-opencode-slim.json(c)`
  with the historical dotfiles copy (which would revert live `acpAgents.antigravity.permissionMode: "ask"` to `"reject"`)
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

- opencode v2 (≥2.1.2), Node **≥20** (or ≥22.13 when `node:sqlite` is needed), Bun (for opencode-bcp build), git, mise optional.
- Network reachability for `http://10.126.126.10:3000/v1` (newapi gateway, home LAN) — model calls
  point there by default.

## Component matrix

| # | Component | Fresh-machine install | This-machine form | Gaps / notes |
|---|-----------|----------------------|-------------------|--------------|
| 1 | billion-context (official npm) | add `"billion-context"` (bare name per official docs; this machine uses `@latest` variant) to opencode.json `plugins` + `compaction.auto:false`. Host resolves + installs to `~/.cache/opencode/npm/...` on every start | `billion-context@latest`, currently v0.1.204 | no version pin by design; optional `bili` CLI adds doctor/update |
| 2 | oh-my-opencode-slim (official) | `bunx oh-my-opencode-slim@latest` (registered npm name) | manual `~/.config/opencode/plugins/omoPlugin` v3.0.5 + preset `newapi` + 8 `*_append.md` prompt assets + `acpAgents` block | manual assets backed up in `dotfiles/opencode/oh-my-opencode-slim/` — restore after installer; `acpAgents` (Claude Code) additionally needs `pnpm i -g @agentclientprotocol/claude-agent-acp` + Claude Code CLI + `claude /login` + hand-written config block + restart |
| 3 | opencode-bcp (self-built) | `git clone …/opencode-bcp && bun install && bash scripts/install.sh` → writes single canonical `~/.config/opencode/plugin/blackboard.ts` (v2 auto-discovery; no opencode.json entry) | same, verified byte-identical install manifest | no port/credential deps |
| 4 | omo-coworkers (self-built) | `claude-advisor` plugin: via dotfiles component (`--claude-advisor ~/github/omo-coworkers/plugins/claude-advisor`); portable skills + frozen `document-writer` payloads live in `omo-coworkers` | deployed `claude-advisor` copy diff-clean vs repo | in `4.0.0`, `omo-coworkers` is an OpenChamber extension + upstream `document-writer` payload source (no `coworkers-install.mjs`); `package.json` engines require Node `>=20` |
| 5 | dotfiles/opencode | `git clone …/dotfiles` → `node opencode/runtime/bin/oprofile.mjs stage --vibeguard-plugin … --claude-advisor … --stale-reasoning … (all required provideFlags)` → `verify` → `activate` | V2 active plugins: `oh-my-opencode-slim`, `vibeguard-privacy-v2`, `billion-context-opencode-native`, `claude-advisor`, `stale-reasoning` (`expectActive`: 5; plus legacy/rollback `omoPlugin` / `bcpPlugin` components where applicable) | component `testedEntrySha256` must be refreshed whenever source repos move; `vibeguard.config.json` canonical copy lives at `dotfiles/opencode/vibeguard.config.json` (input `vibeguardConfig` + copyExtras for both flavors — stage carries it, activate installs it at the live config root); credentials/auth never travel with dotfiles — re-run `opencode auth login/import` on the new machine |

## Suggested order

1. Install host prereqs (Node via mise, Bun, opencode v2).
2. Clone `dotfiles`, `opencode-bcp`, `omo-coworkers` under `~/github/`.
3. `oprofile stage` with all required provide flags → `verify` → `activate` (renders opencode.json incl.
   billion-context entry and agents from `runtime/assets/agents`).
4. `bunx oh-my-opencode-slim@latest`, then restore manual assets from `dotfiles/opencode/oh-my-opencode-slim/`.
5. `cd ~/github/opencode-bcp && bun install && bash scripts/install.sh`.
6. Auth: newapi key into opencode (+ `claude /login` if using acpAgents) → restart opencode.

## Known divergences (documented, not blocking)

- `dotfiles/opencode/opencode.json` source vs live host config can drift (live is authoritative
  after manual edits); re-sync source before `activate` on a new machine.
- `acp.jsonc` diverged: live uses ranxianglei/opencode-acp schema (summaryBuffer), dotfiles copy
  is the older DCP schema — refresh when touching ACP config.

## 2026-10-25 配置同步
- acp.jsonc 同步为 live 版(ranxianglei/opencode-acp schema + summaryBuffer)。
- skills 补齐: grilling(上游)/to-spec SKILL.md(live 新版)/writing-for-agents(自 .agents/skills 收编, 原位置已删)。
- oh-my-opencode-slim/ 补 document-writer.md + lark-operator.md。
- 新增 cli.json(light 主题/CLI 插件 pin) + tui.json。
- 用户已删除 ~/.config/opencode/AGENTS.md: user-global 静态发布目标文件若未来需要, 须先手工创建(D8 禁止插件建文件)。
