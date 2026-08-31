# Project

- 仓库：`Fission-AI/OpenSpec`（本机 clone：`/Users/morton_cheung/Desktop/AI/SpecCraft/references/openspec`）
- npm 包名：`@fission-ai/openspec`，版本 `1.11.0`（`package.json`）
- 语言/运行时：TypeScript（`"type": "module"`，ESM），Node.js `>=20.19.0`，包管理 `pnpm@9.15.9`
- 核心依赖（`package.json`）：`commander@14`（CLI）、`zod@4`（schema 校验）、`yaml@2`（解析）、`@inquirer/prompts`（交互）、`fast-glob`、`diff`、`chalk`、`ora`、`cross-spawn`

## What it solves

OpenSpec 是一个 **AI-native 的 spec-driven development 系统**：在写代码之前，先让人类与 AI 在「纯 Markdown 的 spec」上对齐「要建什么」。核心诉求是解决「需求只活在聊天历史里导致 AI 编码不可预测」的问题。

它的核心抽象：

- 每个 **change（变更）** 拥有独立目录，内含按 schema 定义的 **artifacts（工件）**：默认 `spec-driven` schema 下是 `proposal → specs → design → tasks` 四个工件，由依赖图（DAG）串联。
- 工件内容是**带约定结构的纯 Markdown**（如 `### Requirement:` / `#### Scenario:` / `WHEN-THEN`），没有自定义语法。
- 变更完成后通过 `archive` 把 delta spec **合并进主 specs/**，成为持续演进的行为契约。
- 通过 **skills + slash commands + `--json` 输出** 驱动 30+ 个 AI 编码工具（Claude Code / Codex / Cursor / Copilot 等）执行工作流。
- 提供 **Stores（beta）** 支持跨仓库共享 specs/changes（把规划放进独立 git 仓库）。
- 定位上把自己与 `github/spec-kit`（重、阶段门禁多）和 `kiro`（绑定 IDE）对比，主张「fluid not rigid、iterative not waterfall、brownfield 友好」。

注意：README 里 `/opsx:propose` 的用法是「AI 直接起草 proposal」，即**把产品规划下放给 AI**——这与 SpecCraft 的「Owner decides what，不把主要产品思考下放给 Coding Agent」存在哲学张力（见 Risks of integration）。

## Repository architecture

顶层目录（基于真实 `LS`）：

- `src/cli/index.ts` — CLI 入口（commander 注册全部命令）
- `src/commands/` — 命令实现：`change.ts` `completion.ts` `config.ts` `context.ts` `doctor.ts` `feedback.ts` `schema.ts` `show.ts` `spec.ts` `store.ts` `validate.ts` `workset*.ts` `shared-*.ts`，以及 `workflow/`（`index.ts` `status.ts` `instructions.ts` `new-change.ts` `templates.ts` `schemas.ts` `shared.ts`）
- `src/core/` — 核心逻辑，分两类：
  - `artifact-graph/` — 工件图引擎（`types.ts` `schema.ts` `graph.ts` `state.ts` `outputs.ts` `resolver.ts` `instruction-loader.ts` `index.ts`）
  - `change-metadata/` — 变更元数据 schema（`schema.ts` `index.ts`）
  - `command-generation/` — 命令生成器 + `adapters/`（30+ 个 AI 工具适配器，含 `trae.ts` `codex.ts` `cursor.ts` `claude.ts` 等）
  - `parsers/` — Markdown 解析（`markdown-parser.ts` `requirement-blocks.ts` `requirement-text.ts` `spec-structure.ts` `change-parser.ts` `code-fence.ts`）
  - `completions/` — shell 补全（bash/zsh/fish/powershell）
  - 大量单文件模块：`archive.ts`（归档/合并）、`specs-apply.ts`、`project-config.ts`、`config.ts`、`global-config.ts`、`openspec-root.ts`（目录常量与巡检）、`planning-home.ts`、`root-selection.ts`、`change-status-policy.ts`、`init.ts`、`update.ts`、`list.ts`、`view.ts`、`validation/`、`store/`、`references.ts`、`id.ts`、`file-state.ts` 等
- `schemas/spec-driven/` — 内置 schema：`schema.yaml` + `templates/{proposal,spec,design,tasks}.md`
- `skills/` — 12 个 `openspec-*` 技能（每个含 `SKILL.md`）
- `scripts/` — 构建辅助（`generate-skillssh.mjs` `regen-parity-hashes.mjs` `pack-version-check.mjs` 等）
- `bin/openspec.js` — 可执行入口
- `docs/` 与 `docs-lab/` — 用户文档与重构中的参考文档
- `openspec/` — **OpenSpec 用 OpenSpec 自举**：`specs/`（能力 spec）、`changes/`（在途变更）、`changes/archive/`（已归档）、`config.yaml`
- `.agents/skills/` `build.js` `flake.nix` `CHANGELOG.md` 等

## Runtime architecture

- 纯本地 CLI，无服务端。`bin/openspec.js` 加载 `dist/`（由 `build.js` 用 esbuild/tsc 产出）。
- 所有命令走 commander；命令分「人类可读输出」与「`--json` 机器输出」两种形态。**`--json` 是公开的 agent contract**：失败时 stdout 仍只输出一个合法 JSON 文档（null-shape + `status[]`），保证 agent 可解析（见 `src/cli/index.ts` 的 `failWithError` 与 `src/commands/workflow/status.ts` 的 `BATCH_STATUS_FAILURE_PAYLOAD`）。
- 目录约定（硬编码，见 `src/core/openspec-root.ts`）：

  ```text
  openspec/
    config.yaml          # 项目配置（schema/context/rules/operations/store/references）
    specs/<capability>/spec.md
    changes/<change-name>/{proposal.md, specs/**, design.md, tasks.md, .openspec.yaml}
    changes/archive/<YYYY-MM-DD>-<change-name>/
  ```

- 三个常量是根基：`OPENSPEC_ROOT_DIR='openspec'`、`OPENSPEC_SPECS_DIR`、`OPENSPEC_CHANGES_DIR`、`OPENSPEC_ARCHIVE_DIR`、`DEFAULT_OPENSPEC_SCHEMA='spec-driven'`。
- 「root 解析」有三级 fallback（`--store` 标志 > 本地 `openspec/` > 项目 `store:` 指针 > 全局 `defaultStore`），供跨 repo 场景使用。
- 交互式 prompt（`@inquirer`）在非 TTY/agent 场景下会主动降级为「抛出带 `Fix:` 建议的阻塞错误」，而不是挂死（见 `archive.ts` 的 `confirmOrBlock`/`selectChange`）。

## Important Skills

`skills/` 下的 12 个技能（`src/core/config.ts` 的 `OPENSPEC_SKILL_NAMES` 与其一致），均由模板生成、驱动 CLI：

- `openspec-propose` / `openspec-new-change` / `openspec-continue-change` — 创建/推进 change
- `openspec-explore` — 写方案前的「思考伙伴」
- `openspec-apply-change` — 按 tasks 实施代码
- `openspec-update-change` — 修订已有工件并保持一致性
- `openspec-ff-change` / `openspec-bulk-archive-change` / `openspec-archive-change` — 归档
- `openspec-sync-specs` — 同步 specs
- `openspec-verify-change` — 校验
- `openspec-onboard` — 项目接入

技能文件是带 frontmatter 的 Markdown（`name`/`description`/`allowed-tools`/`license`/`metadata`），如 `skills/openspec-new-change/SKILL.md` 的 `allowed-tools: Bash(openspec:*)`，正文是「步骤 + Guardrails」的分步指令，明确「只读状态、不越权推进」。

## Important Commands

（来源 `src/cli/index.ts` 注册 + `package.json` bin）

- `openspec init [path]` — 初始化目录、生成 skills/commands、支持 `--tools`/`--profile`/`--language`
- `openspec update [path]` — 刷新 agent 指令文件
- `openspec list [--specs] [--json]` — 列出 changes 或 specs
- `openspec view` — 交互式仪表盘
- `openspec status [--change <id>] [--all] [--json]` — 工件完成状态（含 `artifactPaths`、`nextSteps`、`actionContext`）
- `openspec instructions <artifact|apply|archive> --change <id> [--json]` — 输出「enriched 指令」（模板 + 上下文 + 规则 + 依赖状态）
- `openspec templates [--schema] [--json]` — 展示 schema 各工件模板路径
- `openspec schemas [--json]` — 列出可用 schema
- `openspec new change <name> [--schema]` — 创建变更目录
- `openspec archive [change-name] [--yes] [--skip-specs] [--no-validate] [--json]` — 归档并合并 delta spec
- `openspec validate [item] [--all|--changes|--specs|--archived] [--strict] [--json]` — 校验
- `openspec show [item] [--json] [--deltas-only] [--diff]` — 展示 change/spec（含 per-requirement diff）
- 其余：`openspec spec` `config` `schema` `store` `context` `doctor` `workset` `completion` `feedback`
- 已废弃的 noun 命令：`openspec change ...`（preAction hook 打印 deprecation 警告）

## Important Hooks

- **commander 生命周期 hook**（非 git hooks）：`preAction`（设置 `NO_COLOR`、首次 telemetry 通知、`trackCommand` 埋点）与 `postAction`（补全提示、telemetry flush），见 `src/cli/index.ts`。
- `change` 命令组的 `preAction` deprecation 提示。
- **未发现** git hooks、文件系统 watcher、CI 内嵌的提交前钩子（`.github/workflows/ci.yml` 存在，是常规 CI，非运行时 hook）。「钩子/事件系统」这一项在本仓库不存在，标注为**未发现**。

## Important Templates

- 内置 schema 工件模板：`schemas/spec-driven/templates/{proposal.md, spec.md, design.md, tasks.md}`
- 模板由 `schema.yaml` 的 `artifacts[].template` 字段指向，`templates` 命令与 `loadTemplate()` 负责解析与读取（带 `assertPathWithin` 路径逃逸防护）。
- 技能/命令模板由 `src/core/command-generation/` 的生成器 + `adapters/` 输出（skills 目录说明「由模板生成，勿手改」）。

## Important Scripts

（`package.json` scripts + `scripts/` 目录）

- `build`（`node build.js`）、`generate:skills`（`scripts/generate-skillssh.mjs`）、`regen:parity-hashes`（`scripts/regen-parity-hashes.mjs`）、`check:pack-version`、`test`（vitest）
- `scripts/`：`generate-skillssh.mjs`、`skillssh-shared.mjs`、`parity-hash-shared.mjs`、`regen-parity-hashes.mjs`、`pack-version-check.mjs`、`update-flake.sh`
- 说明：skills 有「生成物 parity」机制——`skillssh-parity.test.ts` 保证手改模板后必须重跑生成，否则测试失败（`skills/README.md`）。

## State / Artifact management

这是 OpenSpec 最核心、对 SpecCraft 最有参考价值的部分。

**1. 工件由声明式 schema 定义**（`schemas/spec-driven/schema.yaml` + `src/core/artifact-graph/types.ts` 的 `SchemaYamlSchema`）：

```yaml
name: spec-driven
version: 1
artifacts:
  - id: proposal
    generates: proposal.md
    template: proposal.md
    instruction: |
      ...（如何写这个工件的内置指引）
    requires: []
  - id: specs
    generates: "specs/**/*.md"   # 支持 glob
    template: spec.md
    requires: [proposal]
  - id: design
    generates: design.md
    requires: [proposal]
  - id: tasks
    generates: tasks.md
    requires: [specs, design]
apply:
  requires: [tasks]
  tracks: tasks.md               # apply 阶段通过 tasks.md 的 checkbox 追踪进度
```

字段：`id`（kebab）、`generates`（相对路径或 glob，强制校验路径逃逸）、`description`、`template`、`instruction`（可选，注入到 agent 指令）、`requires`（依赖 id）。`apply` 段定义实施阶段的前置工件与进度追踪文件。

**2. 依赖图引擎**（`src/core/artifact-graph/graph.ts` `ArtifactGraph`）：`getBuildOrder()` 用 Kahn 算法做拓扑排序（同层按声明顺序打破并列，保证 `proposal→specs→design→tasks` 的确定性顺序）；`getNextArtifacts()` / `getBlocked()` / `isComplete()` 支持「就绪/阻塞/完成」查询；`parseSchema()` 校验重复 id、无效依赖引用、循环依赖（DFS 检测并报告完整环路径）。

**3. 完成状态 = 文件存在性**（`src/core/artifact-graph/state.ts` `detectCompleted()`）：某工件的 `generates` 文件（或 glob 匹配到文件）在 change 目录下存在即视为完成。**没有内容哈希/签名/账本**——这一点在 `openspec/changes/add-update-workflow/proposal.md` 中被明确记录为「刻意不建」（不加 digest、不加 ledger，让 agent 直接读文件判断一致性）。

**4. change 元数据**（`.openspec.yaml`，`src/core/change-metadata/schema.ts` `ChangeMetadataSchema`）：`schema`（必填）、`created`（YYYY-MM-DD）、`goal`、`affected_areas`、`initiative`（跨 store 链接）、`skip_specs`（声明无 spec delta，纯重构/工具/文档）、`retire_capabilities`（声明本变更可删除某个 capability 的最后一个 requirement，因删除只能靠 git 恢复，故必须作者显式声明）。

**5. change 生命周期**（`src/core/archive.ts` + `src/core/specs-apply.ts`）：
- `new change` 建目录 → `status` 查就绪 → `instructions` 取模板与指引 → agent 写工件 → 重复至 `isPlanningComplete` → `apply`（按 tasks checkbox 实施）→ `archive`。
- `archive` 流程极其谨慎：校验 proposal（仅提示）、校验 delta spec、统计未完成任务（未完成需 `--yes`）、预览 spec 更新并征求确认、**写前/写后/归档移动全程做 SHA-256 fingerprint 校验**防止并发篡改（`fingerprintDirectoryContents`、`fingerprintPath`、`assertCopiedDirectoryUnchanged`）、用 `.openspec-archive.lock` 声明文件做并发互斥、失败时按 snapshot 回滚。归档命名 `YYYY-MM-DD-<change-name>`，已带日期前缀则不再叠加。
- delta 合并语义：`## ADDED / MODIFIED / REMOVED / RENAMED Requirements` 四种操作，`MODIFIED` 必须带完整 requirement 块（否则归档丢内容），归档前对重建后的 spec 再次校验。

**6. 项目上下文注入**（`src/core/project-config.ts` + `openspec/config.yaml`）：`context`（≤50KB，注入每个工件指令）、`rules`（按 artifact id 追加规则）、`operations`（apply/archive 的建议指引）、`references`（引用外部 store 的 spec 索引）、`store`（fallback root）。字段独立校验、坏字段降级告警不致命。

## Agent integration model

- **三层交付**：`skills/`（Agent Skills 规范）+ slash commands（`command-generation/adapters/` 为 30+ 工具生成对应目录，如 `.claude/commands`、`.agents/skills`）+ **`--json` 的 agent contract**。
- `config.ts` 的 `AI_TOOLS` 表为每个工具记录 `skillsDir`（如 `.claude`、`.agents`、`.cursor`、`.codex`）、`detectionPaths`、`requiresIdeRestart` 等，`init` 据此把生成物落到正确位置。含 `trae.ts` 适配器。
- **核心 agent 契约是 `openspec status --json` 与 `openspec instructions <id> --json`**：`status` 返回 `artifactPaths`（每工件现有文件绝对路径）、`artifacts[].status`（done/skipped/ready/blocked）、`nextSteps`（下一步应运行什么命令）、`actionContext`（机器可读约束，如 `allowedEditRoots`）。`instructions` 返回 `template` + `instruction` + `context` + `rules` + `dependencies` + `unlocks`，即「教 agent 写下一个工件所需的一切」。
- 所有 `--json` 失败路径都保证 stdout 是单一合法 JSON（null-shape + `status[]`），这是 agent 可编程性的关键工程约定。
- 技能 Guardrails 风格：明确「只做 X、不做 Y、需要用户确认」；如 `openspec-new-change/SKILL.md` 明确「只展示第一个工件模板，不创建任何工件，STOP 等待用户」。

## Extensibility

- **自定义 schema**：`schema.yaml` 完全声明式，可定义任意 artifact 序列与依赖。解析优先级 `project-local（openspec/schemas/<name>/）> user（~/.config/openspec/schemas/ 或 XDG）> package built-in`（`src/core/artifact-graph/resolver.ts`）。支持 `schema fork` / `schema init` 复制与改名。
- **项目级定制**：`config.yaml` 的 `context` / `rules` / `operations` / `references` / `store`。
- **机器级定制**：`~/.config/openspec/config.json`（`profile: core|custom`、`delivery: both|skills|commands`、`workflows` 列表、`featureFlags`、`defaultStore`、`openers`、`telemetry`）。
- **Stores（beta）**：把 `openspec/` 形状放到独立 git 仓库、跨 repo 共享；`workset` / `initiative` 概念在演进中。
- **Community schemas**：第三方 schema 包，类似 spec-kit 的 extension catalog（文档提及，本仓库内未内置实例）。
- 多语言支持（`--language`）、shell 补全生成器。

## Licensing

- **许可证：MIT License**（来源文件：`/Users/morton_cheung/Desktop/AI/SpecCraft/references/openspec/LICENSE`，版权行 `Copyright (c) 2024 OpenSpec Contributors`）。
- `package.json` 的 `"license": "MIT"` 与 README 徽标一致。
- MIT 允许 SpecCraft 复用/改造/再分发（需保留版权声明），无 copyleft 传染、无集成阻碍。

## Components useful to SpecCraft

按「对 SpecCraft 的 Artifact / Workflow persistence layer 设计」的相关度排序：

1. **声明式 artifact 定义 + 依赖图引擎**
   - 路径：`src/core/artifact-graph/`（`types.ts` `schema.ts` `graph.ts` `state.ts` `outputs.ts`）+ `schemas/spec-driven/schema.yaml`
   - 价值：SpecCraft 有 18 阶段流水线（IDEA→…→HANDOFF），需要「阶段→工件→依赖→就绪判定」的建模。这套「schema.yaml 声明工件 + DAG 拓扑排序 + 就绪/阻塞查询」是可直接借鉴的工件层设计蓝图，且支持 glob 输出、循环依赖检测、声明序确定性。
   - 决策建议：**ADAPT**（思想与模型照搬，但 SpecCraft 的工件集与 `requires` 语义需重定义，不能直接套 `proposal→specs→design→tasks`）。

2. **Markdown 需求解析器（Requirement / Scenario / Delta）**
   - 路径：`src/core/parsers/`（`markdown-parser.ts` `requirement-blocks.ts` `requirement-text.ts` `spec-structure.ts` `change-parser.ts` `code-fence.ts`）
   - 价值：健壮的「代码围栏掩码 + 标题层级解析 + requirement 块切分 + ADDED/MODIFIED/REMOVED/RENAMED delta 解析 + scenario 丢失检测」纯函数集合，独立于 CLI。若 SpecCraft 也需要「纯 Markdown 表达可验证需求 + delta 合并」，这是现成的高质量参考。
   - 决策建议：**REFERENCE_ONLY**（解析器与 OpenSpec 的 spec 语法强绑定，SpecCraft 的需求/验收表达未必一致；借鉴其「围栏掩码、大小写不敏感 section 匹配、scenario 多重性比较」等工程细节）。

3. **project context / rules 注入机制**
   - 路径：`src/core/project-config.ts` + `openspec/config.yaml` + `src/core/artifact-graph/instruction-loader.ts`（`generateInstructions`）
   - 价值：`context`（项目背景注入每个工件）+ `rules`（按工件 id 追加规则）+ 字段独立校验/降级告警，与 SpecCraft 用户规则「以上下文完整为荣」高度契合；`instruction-loader` 的「template + instruction + context + rules + dependencies + unlocks」组装结构可直接迁移为 SpecCraft 的「阶段指令组装」。
   - 决策建议：**ADAPT**。

4. **agent 契约（`status`/`instructions` 的 `--json` 输出）**
   - 路径：`src/commands/workflow/status.ts` `instructions.ts` + `src/core/artifact-graph/instruction-loader.ts` + `src/core/change-status-policy.ts`（`buildNextSteps`/`buildActionContext`）
   - 价值：「状态查询返回 nextSteps + actionContext + artifactPaths」是 agent 驱动的稳定接口；`--json` 失败也输出单一合法 JSON 的契约，值得 SpecCraft 未来的 Agent Adapter 层照搬。
   - 决策建议：**REFERENCE_ONLY**（作为 SpecCraft 未来 Milestone 实现 Agent Adapter / 状态机时的接口设计参照）。

5. **change 生命周期与归档合并（delta→主 spec）**
   - 路径：`src/core/archive.ts` + `src/core/specs-apply.ts` + `src/core/change-metadata/`（`schema.ts`）
   - 价值：把「在途变更的 delta」原子合并进「长期 spec」的完整工程（fingerprint 防并发、锁文件、snapshot 回滚、`skip_specs`/`retire_capabilities` marker、能力删除需作者显式声明），是「阶段产物→长期状态」的持久化范式参考。
   - 决策建议：**REFERENCE_ONLY**。

6. **30+ AI 工具适配器清单**
   - 路径：`src/core/command-generation/adapters/` + `src/core/config.ts`（`AI_TOOLS`）
   - 价值：SpecCraft 未来要做 Agent Adapter，这份「工具→目录→安装路径→重启要求」清单是最新、最全的现成调研材料（含 Trae、Codex、Cursor、Copilot 等）。
   - 决策建议：**REFERENCE_ONLY**。

## Components not useful to SpecCraft

- **shell 补全**（`src/core/completions/`、`completion` 命令）：与 SpecCraft 目标无关。
- **telemetry / feedback**（`src/telemetry/`、`feedback` 命令）：外部遥测，无需引入。
- **GitHub Copilot cloud-agent**（`src/core/github-copilot/`）：特定平台集成，非通用。
- **workset / store / initiative**（beta）：跨 repo 规划与多工作区打开，超出 SpecCraft 当前 Milestone 范围，且处于快速演进的 beta 状态，不适合作为稳定依赖。
- **legacy-cleanup / migration / converters/json-converter**：历史兼容与迁移逻辑。
- **flake.nix / pnpm-workspace / changeset**：仓库工程化，与 SpecCraft 无关。
- **`openspec change ...` 旧 noun 命令**：已废弃。
- **交互式 `view` 仪表盘 / `@inquirer` prompt 层**：SpecCraft 不依赖交互 UI。

## Risks of integration

1. **语言/运行时耦合**：OpenSpec 是 TypeScript + Node.js ESM，核心逻辑与 `commander`/`@inquirer`/`ora`/`chalk` 深度交织，没有提供独立的「库」边界（`exports` 只暴露 `dist/index.js`）。若 SpecCraft 技术栈非 Node，几乎无法「引库」，只能重写或复制逻辑。
2. **目录约定硬编码**：`OPENSPEC_ROOT_DIR='openspec'` 及 `openspec/specs|changes|archive` 结构是硬编码常量（`src/core/openspec-root.ts`）。SpecCraft 若自建持久化层，直接复用会导致目录命名与 SpecCraft 自有 workflow 的 artifact 约定强耦合/冲突。
3. **schema 与 workflow 语义冲突**：OpenSpec 的工件图是「轻量 4 工件、file-existence 即完成、fluid 无门禁」。SpecCraft 是「18 阶段、Owner 审批门禁、真实勘察才可产出施工手册、阶段不得静默跳过（Rule 2/3）」。两者的状态机与「完成」定义根本不同，不能把 OpenSpec 的状态模型直接当作 SpecCraft 的持久化层。
4. **哲学冲突**：OpenSpec 默认 `/opsx:propose` 让 AI 直接起草 proposal（AI 主导规划），而 SpecCraft 第一条原则是「Execution Agents do not own primary product design」。若采用其 agent 集成方式，需反转「谁主导规划」。
5. **状态模型过于简单**：无内容哈希/签名/账本（项目自述为刻意为之），靠 agent 读文件判断一致性；SpecCraft 需要更强的阶段推进约束（审批、不可跳过、基于真实勘察），需另建状态机。
6. **版本演进快、beta 面大**：v1.11.0，stores/workset/initiative 均为 beta，`docs-lab/` 与 `docs/` 双轨重构中，接口可能持续变动，不适合做稳定依赖。

## Recommendation

**结论：OpenSpec 不适合作为 SpecCraft 的 Artifact / Workflow persistence layer 直接采用（REJECT 直接作为持久化层），但其「声明式 schema + 依赖图 + Markdown delta 合并 + context 注入 + `--json` agent 契约」这一整套**模型**是 SpecCraft 自建 Workflow Engine 时最值得借鉴的蓝本（ADAPT / REFERENCE_ONLY）。**

理由与分层建议：

- **不要 DIRECT_USE / INTEGRATE 其 CLI 或运行时**：语言绑定 Node、目录硬编码 `openspec/`、状态模型（file-existence）与 SpecCraft 的审批门禁 + 不可跳过阶段 + 基于真实勘察 三条规则相抵触，直接集成会与 SpecCraft 自有 workflow 正面冲突。
- **强烈建议 ADAPT 三样东西作为设计蓝本**：
  1. `schema.yaml` 的声明式工件定义（id/generates/template/instruction/requires）+ `ArtifactGraph` 的拓扑排序/就绪查询 → 用来建模 SpecCraft 的 18 阶段流水线与阶段依赖（`docs/workflow/core-workflow.md` 已是契约，缺的就是这种可执行建模）。
  2. `project-config.ts` 的 `context`/`rules` 逐工件注入 + `instruction-loader.ts` 的指令组装结构 → 落地 SpecCraft「上下文完整」原则。
  3. `archive.ts` 的「delta → 主 spec」原子合并 + fingerprint/锁/回滚 + `retire_capabilities` 显式删除授权 → 作为「阶段产物如何落盘为长期状态」的工程范式。
- **REFERENCE_ONLY**：`parsers/` 的 Markdown 解析细节、`status`/`instructions` 的 `--json` 契约、`change-status-policy.ts` 的 nextSteps/actionContext、`command-generation/adapters/` 的 30+ 工具清单（未来 Agent Adapter 的现成调研）。
- **下一步（若进入实现里程碑）**：先照 `schema.yaml` 的语法为 SpecCraft 定义自己的阶段/工件 schema（而非复用 `spec-driven`），再决定是否用 TypeScript 重写一个轻量版 `ArtifactGraph`；确认技术栈后再评估「复制逻辑 vs 以子进程调用 CLI 两难」。

许可证：MIT，可自由借鉴/改造，仅需保留版权声明，无集成法务障碍。
