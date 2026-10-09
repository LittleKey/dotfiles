# Billion Context 0.1.189 Upgrade Implementation Plan

> Superseded before implementation: the user approved the official npm/latest lane on 2026-10-09. Use [the replacement plan](2026-10-09-billion-context-latest.md). The fixed-artifact steps below are historical and must not be executed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将本机 OpenCode 使用的固定 Billion Context 插件从 0.1.175 升级到本次核实的 npm 最新正式版 0.1.189，保留其他组件和可恢复的旧安装。

**Architecture:** 保持 `plugins/compressionPlugin/index.js` 包装入口与当前四插件顺序，替换其内部完整 npm 包及依赖。从当前激活清单派生只变更 compressionPlugin 的新候选，记录基线清单和替换文件摘要；隔离验收及回滚演练通过、用户批准后安装。当前 dotfiles 的其他配置整理不随此次升级部署。

**Tech Stack:** OpenCode 1.18.35、Node.js 25.6.1、npm、dotfiles 的 oprofile 清单与激活/回滚接口；Linux `/proc` 隔离检查。

**Spec:** 本文件“需求与已核实基线”，来源为用户 2026-10-09 的升级请求及下列官方版本/兼容文档。

## 需求与已核实基线

- 目标版本 `0.1.189`；npm gitHead `4d5dab982b733ec77029826abd9ea4faefd574d6`。
- 包完整性：`sha512-fh0nRfsp4+XnD/w5HFP5Xn+JaVLg5cVtDco9JN6B3obo92lxOCzUqLk1WTQ/4NQ2o5jJjYVLBvtTAWqXTnvH+Q==`；解包大小 `127601983` 字节。
- 本机 `/home/littlekey/.config/opencode/plugins/compressionPlugin/package.json` 精确依赖 `0.1.175`，包装文件直接导出 `./node_modules/billion-context/dist/agent/opencode-native.js`。新包默认 `exports["."]` 已是 DSH，OpenCode 的 `exports["./server"]` 仍指上述原生入口。
- 上游声明该入口支持 OpenCode `>=1.18.29` 的 v1 `server()` 及 v2 `setup()`。这不是本机新版实测结论。本次验收当前 v1；不升级 OpenCode、OMO 或 OpenChamber。
- `opencode/opencode.json`、`opencode/runtime/README.md`、`opencode/runtime/profile.json` 已有获批但未提交的 plugin 单源整理，必须保留。已提交的 OMO 技能清理仅是仓库状态，不能借此次升级改变生产技能。
- 调查时 `/home` 可用约 `381 MiB`，当前 compressionPlugin 约 `133 MiB`。`/tmp` 是 tmpfs，并非独立磁盘空间；其占用计入内存。下载/复制前重新核算空间，不能直接用 tmpfs 绕过资源不足。
- 参考：[npm 精确版本](https://registry.npmjs.org/billion-context/0.1.189)、[锁定版本 OpenCode 文档](https://github.com/ranxianglei/billion-context/blob/4d5dab982b733ec77029826abd9ea4faefd574d6/CLIENTS.md#opencode)。该版本 CHANGELOG 未提供完整的 0.1.176–0.1.189 分版记录，不能据此声称所有中间变更已经审计。

## Global Constraints

- 当前全局 `opencode.json`、其他插件、角色、权限、模型、凭据和技能的字节与模式保持不变；只替换 compressionPlugin 及其必要的部署记录。
- 保持一个压缩插件、原有加载顺序和 `compaction.auto=false`。保留固定产物的自动更新/公告更新禁用策略，执行前核对实际配置与环境来源。
- 不运行全局 `bili update` 或 `bili plugin install` 绕过现有所有权清单；不直接覆盖正在使用的 `node_modules`。
- 串行执行重活，`MemoryMax=3G`、`MemorySwapMax=0`；测试使用独立 HOME/XDG/数据库/缓存和 loopback 模型替身，真实模型请求为零。
- 唯一执行证据根目录：`/home/littlekey/github/dotfiles/.slim/deepwork/billion-context-0.1.189-20261009/`，下文简称升级目录。源代码、锁文件和报告留存；不删除旧候选、备份或会话数据，除非用户批准具体清单。
- 持久化候选和回滚空间先核算：当前可用字节须覆盖计划阶段同时存在的下载、安装树、候选、演练副本、回滚备份，以及额外 `256 MiB` 余量。不足时先报告可清理目录的用途和大小，等用户批准；不自行删除。
- 用户批准计划后执行任务 1–3；候选结论获批后才执行任务 4。提交、推送、停止服务或重启繁忙会话均不含在本次授权中。

## Review Focus

1. 默认包入口变化：包装仍绑定 OpenCode 原生入口；搬迁后自启动依赖不回读旧安装。
2. 单组件升级范围：源仓库中尚未部署的技能/配置变化不能进入生产候选。
3. 旧压缩状态：0.1.175 创建的隔离会话经新版重启后仍可恢复原文；旧备份可由旧版读取。
4. 漂移与失败：被用户修改的文件、路径逃逸、重复入口、缺文件均在写入前拒绝；可捕获的中途失败恢复原文件和 authority。
5. 生效证明：安装在磁盘、宿主加载版本、实际自启动代理版本分别核对，避免接入旧代理却报告新版通过。

---

### Task 1: 锁定新产物及完整依赖

**Files:** 创建升级目录中的 `prepare.mjs`、`artifact/package.json`、`artifact/package-lock.json`、`artifact/index.js`、`proof/BASELINE.json`、`proof/ARTIFACT.json`；创建 `artifact.test.mjs`。

**Interfaces:** `prepare.mjs` 无参数，只做基线采集和产物构建，不写生产。`ARTIFACT.json` 包含 `version`、`registryIntegrity`、`nativeEntrySha256`、`lockSha256`、逐文件 `files`（路径、SHA-256、模式）和 `baselineSha256`。

- [ ] 采集实际激活清单、插件树、全局配置及用户状态配置的摘要/模式，记录当前服务身份；完成空间门槛，未知漂移先解释。
- [ ] 在 `artifact.test.mjs` 写入版本等于 `0.1.189`、完整性等于上述值、包装明确导出 OpenCode 入口、入口提供 `server`/`setup` 的断言；运行 `node --test artifact.test.mjs`，产物缺失时必须失败。
- [ ] 使用 `npm install --save-exact --ignore-scripts --no-audit --no-fund billion-context@0.1.189` 在独立 artifact 目录安装，保存锁文件，核对 npm 完整性及所有依赖；复制原包装正文。隔离导入时关闭原生自启动；实际自启动留给任务 3。
- [ ] 把完整产物移到含空格的测试路径，在原路径不可用的条件下运行 `node --test artifact.test.mjs`；缺失入口/依赖的负例必须拒绝。通过后冻结逐文件清单，保留 optional sharp 的真实安装结果，不无声省略现有能力。

### Task 2: 构造单组件候选并同步版本声明

**Files:** 创建升级目录中的 `candidate.mjs`、`candidate.test.mjs`、`candidate/`、`proof/CANDIDATE.json`；修改 `opencode/runtime/profile.json`、`opencode/runtime/README.md`。

**Interfaces:** `candidate.mjs` 读取 `BASELINE.json`、`ARTIFACT.json` 和 active authority 指向的原始清单，生成新候选。`CANDIDATE.json` 包含 `baseManifestSha256`、`manifestSha256`、`candidateDir`、`compressionFiles`、`retiredCompressionFiles`、`unchangedFiles`。新清单明确记录单组件派生来源，不伪称重新 staging 了当前全部 profile。

- [ ] 在 `candidate.test.mjs` 写入断言：新旧候选差集只能是 `plugins/compressionPlugin/**` 和 `.oprofile` 部署元数据；其他文件路径、字节、模式相同；全局 JSON 及四插件顺序相同；基线不符或伪造完整性必须在写入前拒绝。
- [ ] 从已核对的当前激活文件构造候选，替换完整 compressionPlugin 树，记录新清单与旧组件退役路径。未受管理的本地文件保持原位。使用 `verifyCandidateAgainstManifest(candidateDir, manifest)` 验证全量候选。
- [ ] 同步 profile 的 v1/v2 `stockPlugins` 与 `compressionPlugin.replacesPlugin` 为 `billion-context@0.1.189`，增加新产物及验收状态说明，保留历史 tested 信息的真实版本边界；保留先前 plugin 单源整理。包装摘要相同不能代替新原生入口及依赖摘要。
- [ ] 运行 `node --test candidate.test.mjs`；从 `opencode/runtime` 运行 `node --test --test-concurrency=1 --experimental-test-module-mocks test/*.test.mjs`，全部通过；运行 `git diff --check`。已有 0.1.175 fixture 是历史输入，不做无依据的全仓字符串替换。

### Task 3: 实际宿主、压缩恢复和安装回滚验收

**Files:** 创建升级目录中的 `verify-host.mjs`、`verify-recovery.mjs`、`transaction.mjs`、`transaction.test.mjs`、`proof/HOST.json`、`proof/RECOVERY.json`、`proof/REHEARSAL.json`、`proof/ACCEPTANCE.md`。

**Interfaces:** 两个验证脚本读取 `CANDIDATE.json`，生成包含 `passed`、`checks`、`limitations`、候选摘要与宿主版本的报告。所有宿主通过 `opencode/runtime/lib/spawn.mjs` 的 `spawnSandboxed`，数据库必须有实际 `/proc` 文件描述符隔离证据。

`transaction.mjs --rehearse|--activate|--rollback` 无默认动作，读取固定候选、基线及通过报告；`--activate` 须由任务 4 获批后调用。复用现有 manifest/atomic/完整性接口，保存完整先前 authority；不得直接运行绑定旧 OMO 候选和删除范围的历史 `upgrade.mjs`。

- [ ] 使用真实 `/home/littlekey/.local/share/mise/installs/opencode/1.18.35/opencode` 启动隔离候选，验证恰好一个压缩入口、原四插件顺序及原角色/权限，采集自启动代理的 `version=0.1.189` 和进程归属。隔离 HOME/XDG/代理状态，拒绝复用生产或旧版代理。
- [ ] 用 loopback 替身完成一个确定性会话的请求→压缩→后续请求投影→解压；预先固定原文，验证恢复字节一致和会话标识不混用。不能以插件导入或工具可见替代此检查。
- [ ] 在独立目录用旧版创建合成压缩会话并干净停机；复制状态到新版隔离目录，验证重启、恢复原文及继续新一轮；保留未被新版写入的旧状态副本并用旧版恢复。原始数据不能来自真实用户会话，不宣称降级读取新版写入格式已获保证。
- [ ] 写入并运行 `node --test transaction.test.mjs`：基线/候选漂移、祖先软链、逃逸路径、重复入口、写入中途失败、重复安装、用户安装后修改等边界；只允许候选列出的 compression 路径，authority 含其余原管理文件的准确记录。
- [ ] `node transaction.mjs --rehearse` 在隔离副本执行安装→复装→回滚，逐字节/模式及先前 authority 恢复一致；旧组件退役文件移到 discovery 根之外的事务备份。说明跨文件断电原子性不在保证内。
- [ ] 串行完成上述检查并清理各阶段自己的进程；报告限制与失败原件。对产物、候选、验证及事务代码完成一次非作者最终审查，处理有证据的重要问题后汇总候选结论，等待用户批准生产切换。

### Task 4: 获批切换和新进程确认

**Files:** 创建升级目录中的 `proof/ACTIVATION.json`、`COMPLETION.md`；生产范围仅 `plugins/compressionPlugin/**` 及必要 `.oprofile` 元数据。

**Interfaces:** 使用任务 3 已验收的 `transaction.mjs --activate|--rollback` 和同一份候选及报告；脚本或产物摘要变化使原验收失效，不能直接切换。

- [ ] 用户明确批准后重新核对实际基线和空间，执行 `node transaction.mjs --activate`；其余全局文件摘要必须与切换前相同。可捕获失败恢复旧插件和原 authority，保留诊断原件。
- [ ] 由用户选择空闲时机重启宿主；新进程检查实际加载插件与代理版本。分别报告“已安装”和“已加载”；未重启时不得报告运行版本已经升级。提交最终结果及回滚位置，等待进一步操作授权。

## 计划自检

- 每个 Review Focus 均有对应断言；没有升级无关组件或部署仓库技能清理的步骤。
- 空间不足是实施前的明确门槛；未授权删除任意旧记录，也未把 tmpfs 当作免费磁盘。
- 修改范围包含先前未提交文件，提交/推送需另行授权；旧测试、源码快照和历史报告不改写成新版验收。
- 未下载或安装 0.1.189；目标与兼容声明来自已读取的 npm 元数据和固定 gitHead 文档，本机运行证据由任务 3 建立。
