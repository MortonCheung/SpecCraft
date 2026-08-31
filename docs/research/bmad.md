# Project

仓库根：`/Users/morton_cheung/Desktop/AI/SpecCraft/references/bmad`（开源项目 `bmad-code-org/BMAD-METHOD`，npm 包名 `bmad-method`，当前版本 6.11.0）。以下所有结论均基于对真实源码、SKILL.md、customize.toml、模板与脚本文件的直接阅读；未发现的内容一律标注"未发现"。

## What it solves

BMad Method（简称 BMAD/BMM）自称 "Breakthrough Method of Agile AI-driven Development"，是一套**面向 AI 编码 Agent 的敏捷交付框架**。它解决的核心问题是：让 LLM 在"从想法到可交付代码"的全程中，把本会留在脑子里的假设、产品决策、架构决策显式化，并以**可跨会话复用的产物文件**把这些决策向后传递，从而避免每个新会话都重新解释上下文、避免各阶段各自为政做出不一致决策。

它的实现方式不是让多个 AI 角色自动互相对话，而是：

- 把流程拆成**按阶段排列的 workflow skill**（brainstorm → brief/PRFAQ → PRD → UX → Architecture → Epics/Stories → Sprint Planning → Build → Code Review → Retrospective）；
- 每个 skill 是一个**单 Agent 顺序执行的 Markdown 工作流**，靠"读取上一阶段的产物文件 + 写入本阶段的产物文件"完成交接；
- 用 **append-only 的 `.memlog.md`（记忆日志）** 作为单个文档/决策的"权威运行记录"，最终产物（PRD.md、SPEC.md、spine）是从 memlog **派生（derive）** 出来的，而非手写编辑。

因此它对"多人/多角色协作"的建模是**产物契约 + 稳定 ID 引用**，而不是**角色对话**（详见后文 "Agent integration model"）。

## Repository architecture

顶层目录：

- `src/` —— 技能定义的唯一权威来源，分三块：
  - `src/bmm-skills/` —— **BMad Method 模块**（`code: bmm`），含 5 个 Agent 角色 + 规划/交付技能：
    - `agents/`：`bmad-agent-analyst`、`bmad-agent-pm`、`bmad-agent-ux-designer`、`bmad-agent-architect`、`bmad-agent-dev`（各含 `SKILL.md` + `customize.toml`）。
    - `plan/`：`bmad-architecture`、`bmad-create-epics-and-stories`、`bmad-generate-project-context`、`bmad-prd`、`bmad-prfaq`、`bmad-product-brief`、`bmad-project-context`、`bmad-spec`、`bmad-sprint-planning`、`bmad-ux`。
    - `ship/`：`bmad-build`、`bmad-build-auto`、`bmad-code-review`、`bmad-correct-course`、`bmad-qa-generate-e2e-tests`、`bmad-retrospective`、`bmad-walkthrough`。
    - `v6-shims/`：旧技能名的**转发器**（如 `bmad-create-prd`、`bmad-create-architecture`），仅做兼容，指向新技能。
  - `src/core-skills/` —— **核心模块**（`code: core`，总是安装）：`bmad-help`、`bmad-advanced-elicitation`、`bmad-brainstorming`、`bmad-customize`、`bmad-deep-recon`、`bmad-forge-idea`、`bmad-party-mode`、`bmad-review`，另含其自己的 `v6-shims/`。
  - `src/scripts/` —— **Python 运行时脚本**：`config_utils.py`、`resolve_config.py`、`resolve_customization.py`、`render_skill.py`、`memlog.py`（各带 `tests/`）。
- `tools/` —— 安装器与校验工具：`installer/bmad-cli.js`（CLI 入口）、`installer/core/`、`installer/commands/`、`installer/modules/`（channel/version/plugin 解析）、`validate-skills.js`、`validate-file-refs.js`、`skill-validator.md` 等。
- `test/` —— 安装器/渲染器/技能校验的 Node 与 Python 测试。
- `docs/` —— 多语言文档站（`cs/`、`fr/`、`ko-kr/`、`vi-vn/`、`zh-cn/` 等），基于 Astro Starlight；`docs/reference/skills-and-agents.md` 是技能与 Agent 的权威清单。
- `website/` —— Astro 站点源码（与 `docs/` 内容重排）。
- `web-bundles/` —— 把部分规划工作流打包成 Gemini Gems / ChatGPT Custom GPTs 的"网页版"变体。
- 顶层工程文件：`bmad-modules.yaml`（官方模块注册表）、`package.json`、`LICENSE`、`TRADEMARK.md`、`AGENTS.md`。

每个 skill 目录的标准形态：`SKILL.md`（入口/流程正文）+ `customize.toml`（可定制面）+ 可选 `references/`、`assets/`、`steps/`、`scripts/`、`templates/`。`bmad-build` 等 ship 技能采用 **step-file 架构**（`workflow.md` 是骨架，`step-01…step-05` 是逐步加载的微文件）。

## Runtime architecture

- **安装**：`npx bmad-method install`（或 `bmad install`）把选中的模块技能物化到目标 IDE 的技能目录（Claude Code → `.claude/skills/`；Cursor/Windsurf/Codex/Codex 等 → `.agents/skills/`；Cline → `.cline/skills/` 等），并把运行时会话状态落到项目根的 `_bmad/` 目录。
- **运行前提**：Node.js 20.12+、Python 3.11+、`uv`（所有 Python 脚本统一用 `uv run` 执行，避免环境漂移）。
- **配置分层**（四层 TOML 合并，见 `config_utils.py::load_central_config`）：
  1. `_bmad/config.toml`（必填）
  2. `_bmad/config.user.toml`
  3. `_bmad/custom/config.toml`
  4. `_bmad/custom/config.user.toml`
  - 合并规则：标量覆盖、表深合并、带 `code`/`id` 键的表数组按键替换、其余数组追加。
- **技能定制分层**（三层，见 `load_customization`）：`<skill>/customize.toml`（默认）→ `_bmad/custom/<skill>.toml`（团队）→ `_bmad/custom/<skill>.user.toml`（个人）。
- **渲染**：`render_skill.py` 把 `SKILL.md` + `workflow.md` + 各 `.md` 源文件里的三类 token 替换掉：
  - `{{config.x.y}}` / `{{.key}}` → 中央配置值；
  - `{workflow.x}` → `customize.toml` 的 `[workflow]` 字段；
  - `[[bmad-snapshot:xxx.md]]` → 渲染快照内文件绝对路径。
  - 产物落到 `_bmad/render/<skill>/<slug-hash>/<generation-hash>/`，带 `manifest.json`（SHA-256 校验）保证**不可变快照**；重跑幂等。
- **记忆日志**：`memlog.py`（`init` / `append` / `set`）维护每个运行文件夹下的 `.memlog.md`——追加式、单行一条、原子写入（temp + fsync + rename）、无生命周期状态字段（"完成"也只是一条 `event` 条目）。

`_bmad/` 目录的最终形态（安装后）：`config.yaml`、`custom/`（覆盖 TOML）、`render/`（渲染快照）、`scripts/`（上述 Python 脚本副本）、`_config/bmad-help.csv`（安装后组装的全模块技能目录）。

## Important Skills

**Agent 角色（persona skills，均含 `SKILL.md` + `customize.toml`）**

| Skill | 角色名 | 职责 |
| --- | --- | --- |
| `bmad-agent-analyst` | Mary（Business Analyst） | 市场/竞争/领域/用户研究、头脑风暴、product brief、PRFAQ、project context |
| `bmad-agent-pm` | John（Product Manager） | PRD 创建/更新/校验、epics/stories、实现就绪、correct course |
| `bmad-agent-architect` | Winston（System Architect） | 架构 spine、实现就绪 |
| `bmad-agent-dev` | Amelia（Senior Engineer） | Build、QA 测试生成、代码审查、sprint planning、retrospective |
| `bmad-agent-ux-designer` | Sally（UX Designer） | UX 设计（`DESIGN.md`/`EXPERIENCE.md`） |

**规划（plan）工作流**

- `bmad-product-brief`：引导式对话产出产品简报（比 PRFAQ 更轻）。
- `bmad-prfaq`：Amazon Working Backwards PRFAQ（先写新闻稿，再回答 FAQ），含 `agents/`（artifact-analyzer、web-researcher）两个 subagent 定义。
- `bmad-prd`：PRD 创建/更新/校验。核心方法论是 **Coaching path（默认）/ Fast path**、**elicitation 而非 direction**、**Research subagents**、**concern scan**、**User Journeys 捕获而非编造**、`addendum.md` 承接溢出内容。
- `bmad-spec`：**spec-kernel**（见下 "State / Artifact management"）。把任意输入蒸馏成五字段 `SPEC.md`（Why / Capabilities / Constraints / Non-goals / Success signal）+ companions，并可 break 成 `stories.yaml`。
- `bmad-ux`：产出 `DESIGN.md` + `EXPERIENCE.md`。
- `bmad-architecture`：产出 **architecture spine**（只记"不变量"，其余为 seed），核心测试句：*"如果两个下一级单元独立构建，是否会做出不兼容的选择？"*。
- `bmad-create-epics-and-stories`：把 PRD/架构拆成 epics + stories（含 acceptance criteria）。
- `bmad-sprint-planning`：实现就绪门（PASS/CONCERNS/FAIL）+ 生成 `sprint-status.yaml`。
- `bmad-project-context`：生成/刷新仓库的 `AGENTS.md` 托管块（setup/adopt/refresh/record/audit）。
- `bmad-generate-project-context`：旧版项目上下文生成（已被 `bmad-project-context` 取代）。

**交付（ship）工作流**

- `bmad-build`：标准实现流程（clarify → plan → implement → review → present），step-file 架构，`compile-epic-context.md` 负责从规划产物编译出 epic 上下文。
- `bmad-build-auto`：无人值守开发循环（一次迭代）。
- `bmad-code-review`：独立代码审查 + 分诊。
- `bmad-correct-course`：sprint 中期重大变更评估。
- `bmad-qa-generate-e2e-tests`：生成 API/E2E 测试。
- `bmad-retrospective`：epic 完成后的回顾（带 git evidence 脚本）。
- `bmad-walkthrough`：人工走查变更。

**核心（core）技能**

- `bmad-help`：扫描产物文件检测进度，推荐下一步技能（读取 `_config/bmad-help.csv`）。
- `bmad-review`：多视角审查（adversarial / edge-case / verification-gap / structure / prose）。
- `bmad-brainstorming`：引导式头脑风暴（100+ 想法）。
- `bmad-deep-recon`：研究（market/domain/technical/competitive/user-voice/academic-lit + 候选选择）。
- `bmad-forge-idea`：对抗式拷问半成品想法。
- `bmad-party-mode`：**唯一的多 Agent 对话机制**（见下），可选，不在主流程。
- `bmad-advanced-elicitation`：用命名推理方法（pre-mortem、first principles、red team 等）对刚产出内容做二次精化。
- `bmad-customize`：用自然语言写定制覆盖 TOML。

## Important Commands

（均来自 `package.json` 与 `tools/installer/`）

- `npx bmad-method install` / `bmad install`：安装 CLI（`bin: bmad`、`bin: bmad-method` 均指向 `tools/installer/bmad-cli.js`）。
- `npm run quality`：合并所有检查（format + eslint + markdownlint + docs 构建 + 多组测试 + `validate:refs` + `validate:skills` + sidebar 校验）。
- `npm run validate:skills`：技能结构校验（`tools/validate-skills.js --strict`，规则见 `tools/skill-validator.md`）。
- `npm run test`：安装器/渲染器/引用 CSV 等完整测试。
- 运行时技能脚本统一 `uv run <project-root>/_bmad/scripts/<name>.py …`（resolve_config、resolve_customization、render_skill、memlog）。

## Important Hooks

- **`.husky/pre-commit`**：提交前钩子（跑 `lint-staged`，见 `package.json` 的 `lint-staged` 段：js→lint+format、yaml→eslint+format、json→format、md→markdownlint）。
- **activation_steps_prepend / activation_steps_append**：每个 skill 的 `customize.toml` 里声明的**激活钩子**，分别在标准激活前/问候后执行，供团队注入预检、合规检查、上下文加载。
- **on_complete**：workflow 完成钩子（`customize.toml` 的 `[workflow]`，字符串或指令数组，Finalize 末尾执行）。
- **external_handoffs**：Finalize 阶段把产物推送到外部系统（Confluence/Notion/ticket 系统）的 MCP 工具路由。
- **`.github/workflows/`**：CI 流程（`quality.yaml`、`publish.yaml`、`docs.yaml`、`discord.yaml`、`coderabbit-review.yaml`）；`AGENTS.md` 要求 push 前跑 `npm ci && npm run quality`。
- **Reviewer Gate**（非 git hook，是工作流内的质量门槛）：架构/PRD/spec 等技能在 Finalize 前用 parallel subagents 做审查（见 "Agent integration model"）。

## Important Templates

- `src/bmm-skills/plan/bmad-prd/assets/prd-template.md` —— PRD 模板：Essential Spine（Document Purpose / Vision / Target User 含 JTBD + Key User Journeys / Glossary / Features 含嵌套 FR + Consequences / Non-Goals / MVP Scope / Success Metrics 含 counter-metrics / Open Questions / Assumptions Index），FR 全局编号、UJ 编号、Glossary 术语唯一化、内联 `[ASSUMPTION]`。
- `src/bmm-skills/plan/bmad-architecture/assets/spine-template.md` —— 架构 spine 模板：frontmatter（type/purpose/altitude/paradigm/status/binds/companions）+ Design Paradigm / Inherited Invariants / Invariants & Rules（AD-n：Binds/Prevents/Rule）/ Consistency Conventions / Stack（seed）/ Structural Seed / Capability→Architecture Map / Deferred。
- `src/bmm-skills/plan/bmad-spec/assets/spec-template.md` —— 五字段 spec kernel 模板（Why / Capabilities 含 intent+success / Constraints / Non-goals / Success signal / Assumptions / Open Questions）。
- `src/bmm-skills/plan/bmad-spec/assets/stories-schema.md` —— `stories.yaml` 字段定义与校验规则（未逐行读，由 SKILL.md 引用）。
- `src/bmm-skills/plan/bmad-create-epics-and-stories/templates/epics-template.md` —— epic/story 分解模板（含 Requirements Inventory、FR Coverage Map、Given/When/Then AC）。
- `src/bmm-skills/plan/bmad-product-brief/assets/brief-template.md` —— 产品简报模板（Executive Summary / Problem / Solution / Differentiation / Who This Serves / Success Criteria / Scope / Vision）。
- `src/bmm-skills/plan/bmad-prfaq/assets/prfaq-template.md` —— PRFAQ 模板（未逐行读）。
- `src/bmm-skills/plan/bmad-sprint-planning/sprint-status-template.yaml` —— sprint 状态文件模板。
- `src/bmm-skills/ship/bmad-build/spec-template.md` —— build 阶段的工作项 spec 模板。
- `src/bmm-skills/plan/bmad-project-context/references/template.md` —— AGENTS.md 托管块模板。

## Important Scripts

**核心运行时（`src/scripts/`，会被复制到 `_bmad/scripts/`）**

- `config_utils.py` —— 严格 TOML 加载 + `structural_merge`（标量覆盖/表深合并/键控数组替换/其余数组追加），是整个定制体系的算法核心。
- `resolve_config.py` —— 合并四层中央 TOML 并输出 JSON（支持 `--key` 点路径提取）。
- `resolve_customization.py` —— 合并三层 `customize.toml`，`--key workflow` 或 `--key agent` 提取对应块。
- `render_skill.py` —— 把 skill 源渲染成带 SHA-256 manifest 的不可变快照（token 替换 + 幂等发布）。
- `memlog.py` —— append-only 记忆日志（`init`/`append`/`set`，原子写入、无状态字段）。

**skill 内脚本**

- `bmad-architecture/scripts/lint_spine.py` —— spine 的确定性 lint（Reviewer Gate 的机械底线）。
- `bmad-sprint-planning/scripts/sprint_plan.py`、`bmad-retrospective/scripts/{git_evidence,sprint_status}.py` —— 跟踪/证据收集。
- `core-skills` 内：`brain.py`（头脑风暴方法选择）、`recon_kit.py`（研究）、`pick_methods.py`（elicitation 方法）、`resolve_party.py`（party 名册）、`word_metrics.py`（审查）、`resolve_personas.py`、`list_customizable_skills.py`。

**安装/校验（`tools/`）**

- `installer/bmad-cli.js`（CLI 入口）、`installer/core/installer.js`、`installer/modules/*.js`（channel/version/plugin 解析）、`validate-skills.js`、`validate-file-refs.js`、`validate-published-implementation-model.mjs`。

## State / Artifact management

- **三个产物目录**（懒创建，由先写入的 skill 建立）：`planning_artifacts`（Phase 1-3 产物）、`implementation_artifacts`（Phase 4 产物）、`project_knowledge`（长期知识，默认 `docs`）。
- **记忆日志 `.memlog.md` 是每个运行文件夹的权威记录**：追加式、按时间、单行一条（带 `(type)` 标签）、跨会话续跑靠重读 memlog 而非重读渲染产物。**最终产物从 memlog 派生**：`bmad-spec` 明确 "SPEC.md 从 memlog derive，从不手改；bmad-spec 是唯一写入者"。
- **稳定 ID 契约**（跨技能引用的握手基础）：PRD 用 `FR-N`/`UJ-N`/`SM-N`；spec 用 `CAP-N`；架构用 `AD-n`；story 用 `N.M`。ID 全局稳定、不复用、不重排。
- **产物 frontmatter `status: draft|final`** 标记完成态；`bmad-help` 靠扫描产物文件 + status 检测进度。
- **spec 的 companions/sources 分界**：`companions:`（下游必须读的配套文件，含 adopted 的上游产物）+ `sources:`（已被完全吸收、仅供审计的上游文件）。
- **`_bmad/_config/bmad-help.csv`**：安装后组装的全模块技能目录（列：module,skill,display-name,menu-code,description,action,args,phase,preceded-by,followed-by,required,output-location,outputs），是 `bmad-help` 路由的数据源。

## Agent integration model

**核心结论：BMAD 不是"大量 AI 角色互相自动对话"的系统。它的角色编排是"persona 皮肤 + 产物契约交接"，多 Agent 对话只是可选项。**

真实机制分三层：

1. **Agent = persona skill，由用户显式调用。** 5 个 Agent 的 `SKILL.md` 是同一模板的实例：激活 → `resolve_customization.py --key agent` 解析 persona → 加载 persistent_facts → 加载 config → 问候（带 icon 前缀）→ 呈现 `[[agent.menu]]` 菜单 → 按用户选择 **dispatch 到真正的 workflow skill**。菜单项是 `skill = "bmad-brainstorming"`（调用已注册技能）或 `prompt = "…"`（执行一段提示文本，如"调用 bmad-deep-recon 并预选 market 类型"）。**Agent 之间从不互相自动对话**——每次交互都是"用户 ↔ 单个 Agent 会话"。

2. **编排靠依赖链 + 产物文件交接，而非角色对话。** 依赖关系声明在 `module-help.csv` 的 `preceded-by` / `followed-by` / `required` / `phase` 列（如 `bmad-architecture` 的 followed-by 是 `bmad-create-epics-and-stories`；`bmad-build` 的 preceded-by 是 `bmad-sprint-planning`）。每个 skill 在 **Finalize 步骤末尾**给出 "Common next: bmad-ux / bmad-architecture / …" 的软路由建议，并引导 `bmad-help` 做权威路由。**交接物是文件**：PRD.md → DESIGN.md/EXPERIENCE.md → ARCHITECTURE-SPINE.md → epics/stories → sprint-status.yaml → build 的 `epic-<N>-context.md`。`compile-epic-context.md` 是明确的"交接编译"约定：从规划产物里**按目的提炼、不引来源章节号、不复制全文、目标 800-1500 token**，产出开发者就绪的上下文文件。

3. **subagent 用于"并行研究/审查"，不用于"角色对话"。** PRD 的 Research subagents、`bmad-prfaq` 的 artifact-analyzer/web-researcher、以及 **Reviewer Gate**（把每个 review lens 作为 parallel subagent 派发到产物文件，各写 `review-{slug}.md`，只回传一句话结论 + 前几条 finding，父进程从不持有全文）——这些都是"一个主 Agent + 若干一次性 worker"，worker 不产生对话、不持有 persona。

**是否有明确的握手/交接约定？有，但是轻量、文件化的，不是对话式的**：

- 上游产物写入约定路径（`customize.toml` 里的 `prd_output_path`/`spine_output_path`/`spec_output_path` + `run_folder_pattern`）；
- 稳定 ID 契约（下游引用 `FR-N`/`CAP-N`/`AD-n`，架构继承父 spine 时"原 ID 只读、不重排"）；
- 产物 frontmatter `status: final` 作为"上游完成"信号；
- Reviewer Gate 作为"交接前质量门槛"（Finalize 时自跑一遍；Validate 意图时产出 HTML 报告）。

**是否高度依赖多 Agent 对话？否。** 唯一的多 Agent 对话能力是 `bmad-party-mode`（core skill，可选，四种 mode：session/auto/subagent/agent-team），它被明确排除在主流程之外，只在用户主动要求"多视角讨论"时使用。主流程（Discovery → Product → Architecture → Build）全程是**单 Agent 顺序执行 + 文件交接**。

## Extensibility

- **定制分层（三层 TOML 合并）**：团队/个人在 `_bmad/custom/<skill>.toml` / `<skill>.user.toml` 写覆盖，无需改 `customize.toml`（该文件标注 "DO NOT EDIT -- overwritten on every update"）。可定制面：`activation_steps_prepend/append`、`persistent_facts`、`on_complete`、`external_sources`、`external_handoffs`、`finalize_reviewers`、模板路径、输出路径、`run_folder_pattern`、`doc_standards`，以及 Agent 的 `role/identity/communication_style/principles/menu`。
- **自定义 Agent**：`module.yaml` 的 `agents:` 段声明名册，完整 persona/菜单在各 Agent 的 `customize.toml`；用户可在 `_bmad/custom/config.toml` / `config.user.toml` 添加自己的 Agent（真实或虚构）。
- **模块系统**：`bmad-modules.yaml`（官方注册表，含 deprecated 标记、aliases、marketplace-plugin 标记）+ 每个模块的 `module.yaml`（code/name/agents/配置项）+ `module-help.csv`（技能目录）。安装器据此组装。
- **插件机制**：`.claude-plugin/marketplace.json` 用于把技能解析为插件；`marketplace-plugin: true` 的模块（如 bmad-loop）走 plugin resolver。
- **`bmad-customize` skill**：自然语言描述改动 → 选 scope → 写 `_bmad/custom/` 覆盖 → 校验合并结果，无需手写 TOML。
- **审查 lens 可扩展**：`bmad-review` 的 lens 集合可通过 `customize.toml` 增删。

## Licensing

- **许可证：MIT License**。来源文件：`/Users/morton_cheung/Desktop/AI/SpecCraft/references/bmad/LICENSE`，版权声明 `Copyright (c) 2025 BMad Code, LLC`，并注明"incorporates contributions from the open source community"（见 CONTRIBUTORS.md）。
- 附 **商标通知**（在 LICENSE 末尾 + 独立 `TRADEMARK.md`）：`BMad™`、`BMad Method™`、`BMad Core™` 是 BMad Code, LLC 的商标，**软件里的商标使用不授予任何商标权利**；在 SpecCraft 中复用其文字/命名时需避开这些商标。

## Components useful to SpecCraft

（按对 SpecCraft"吸收 Discovery / Product / Architecture 方法、且不变成多角色对话系统"目标的价值排序）

1. **`bmad-spec` 的 spec-kernel 方法**（`src/bmm-skills/plan/bmad-spec/SKILL.md` + `assets/spec-template.md` + `assets/stories-schema.md`）：五字段 kernel + companions 分界 + "从 memlog 派生、单一写入者" + Spec Law 八条 + 双 pass 自校验。**与 SpecCraft 命名最贴合**，是最值得直接借鉴的"单一契约文档"范式。
2. **`bmad-architecture` 的 spine 方法论**（`SKILL.md` + `assets/spine-template.md` + `references/reviewer-gate.md` + `scripts/lint_spine.py`）："只记不变量、其余为 seed"、一条测试句判断决策归属、AD-n 的 Binds/Prevents/Rule、Coach 优先的引导方式。
3. **`bmad-prd` 的 Discovery 方法**（`SKILL.md` + `assets/prd-template.md` + `assets/prd-validation-checklist.md`）：brain dump → stakes 校准 → Coaching/Fast 双路径 → elicitation 而非 direction → concern scan → UJ 捕获而非编造 → addendum 承接溢出 → Reviewer Gate。
4. **`memlog.py` + "产物派生自日志"机制**（`src/scripts/memlog.py`）：append-only、原子写入、无状态字段、跨会话续跑。是"决策可追溯 + 免 merge 漂移"的通用基础设施，可直接复用。
5. **`compile-epic-context.md` 的上下文编译交接**（`src/bmm-skills/ship/bmad-build/compile-epic-context.md`）：把上游规划产物"按目的提炼、不引章节号、不复制全文"编译成下游就绪的短上下文——这是 SpecCraft 想要的"交接而非对话"的现成范式。
6. **`customize.toml` + `resolve_customization.py` 三层合并定制**（`src/scripts/config_utils.py` + `resolve_customization.py`）：团队/个人覆盖、键控数组替换、激活钩子（prepend/append/on_complete）。
7. **`module-help.csv` 依赖链声明**（`src/bmm-skills/module-help.csv`）：用数据表（而非硬编码）声明技能的前后依赖与 required 门，`bmad-help` 据此路由。
8. **`bmad-prfaq` / `bmad-product-brief` 模板**（`assets/prfaq-template.md`、`assets/brief-template.md`）：Working Backwards 与简报的现成结构。
9. **`bmad-project-context` 的 AGENTS.md 托管块方法**（`SKILL.md` + `references/template.md` + `references/best-practices.md`）：setup/adopt/refresh/record/audit 五意图 + ledger 账本 + 并行 subagent 验证 + "show before write"。

## Components not useful to SpecCraft

（避免引入，以免把 SpecCraft 拖入"多角色对话系统"或引入无关复杂度）

1. **5 个 Agent 角色 persona 层**（`src/bmm-skills/agents/*`）：persona 化角色（Mary/John/Winston/Amelia/Sally + icon + 沟通风格）对 SpecCraft 的"单 Agent 结构化产出"目标无价值，是造成"看起来像多角色系统"的主要来源。
2. **`bmad-party-mode`**（`src/core-skills/bmad-party-mode/*`）：多 Agent 圆桌讨论（session/auto/subagent/agent-team 四模式）——正是任务要求避免的形态，不应吸收。
3. **`bmad-build` / `bmad-build-auto` / `bmad-code-review` / `bmad-walkthrough` / `bmad-qa-generate-e2e-tests` 等 ship 层**：面向"把 story 变成代码"的实现流程，SpecCraft 定位在规格/架构产出，不涉及代码实现，暂不需吸收。
4. **安装器与分发基建**（`tools/installer/*`、`web-bundles/*`、`website/*`、`.claude-plugin/*`）：与 SpecCraft 自身的运行时无关。
5. **`v6-shims/*` 旧名转发器**：纯历史兼容层，无方法论价值。
6. **`bmad-sprint-planning` / `bmad-retrospective` 的 YAML 状态跟踪 + git 证据脚本**：面向敏捷 sprint 管理，超出 SpecCraft 范围。
7. **`render_skill.py` 的不可变快照渲染机制**：token 替换 + SHA-256 manifest 是为"技能分发到多种 IDE"服务的，SpecCraft 若为单一内部工具，可直接用纯 Markdown + 简单模板，无需此复杂度（除非要支持多 IDE 分发）。

## Risks of integration

1. **商标风险（低但真实）**：BMad / BMad Method / BMad Core 是注册商标；复用其模板文案时须去商标化改写，不能用其命名（"architecture spine"、"SPEC.md"、"memlog" 这类通用术语本身无商标问题，但应避免照搬带 "BMad" 的措辞）。
2. **Python/uv 运行时依赖**：`memlog.py`、`resolve_customization.py` 等核心脚本是 Python（`uv run`），若 SpecCraft 希望零外部依赖或纯 Node/TypeScript，需要重写（脚本本身很薄、可移植）。
3. **过度工程风险**：BMAD 的定制分层（四层 config + 三层 customize + 渲染快照 + 模块注册表）是为"多 IDE 分发 + 团队规模定制"设计的；直接整套照搬会让 SpecCraft 变重。应按需裁剪（很可能只需要 memlog + 模板 + 依赖链表）。
4. **"spine vs 传统架构文档"的语义差异**：`bmad-architecture` 的 spine 是"极简不变量契约"，与许多用户预期的"完整架构文档"不同；吸收时需明确取舍，否则用户会困惑于产出过薄。
5. **多 Agent 印象风险**：即便只吸收 workflow 层，BMAD 的文档与术语（agents、party-mode、menu dispatch）容易诱导后续把它做成"多角色对话"，需要在 SpecCraft 的设计约束里显式排除。
6. **文件格式依赖**：交接依赖 `.memlog.md` 前缀/frontmatter 约定与稳定 ID 交叉引用，若 SpecCraft 改了产物格式，需同步维护这些约定，否则下游引用断裂。

## Recommendation

**总体建议：REFERENCE_ONLY 吸收方法论与模板，ADAPT 少量基础设施（memlog、依赖链表、上下文编译），REJECT persona 层与 ship 层。** SpecCraft 应定位为"单 Agent、结构化、文件交接"的规格/架构产出工具——这恰好是 BMAD 去掉 persona 皮肤与实现层之后的骨架。

具体落地路径建议：

1. **直接移植（ADAPT）**：`memlog.py` 的 append-only 日志范式（可移植为 SpecCraft 自己的脚本或纯 Markdown 约定）——这是 BMAD 里最通用、最少耦合、最值得直接用的单点。
2. **提炼复用（REFERENCE_ONLY → 改写为 SpecCraft 模板）**：`spec-template.md` 五字段 kernel、`spine-template.md` 的 AD-n/不变量结构、`prd-template.md` 的 FR/UJ/SM 编号与 Glossary 唯一化、`brief-template.md`、`prfaq-template.md`——去商标化、按 SpecCraft 命名重写。
3. **方法论吸收（REFERENCE_ONLY）**：`bmad-prd` 的 Discovery（brain dump → stakes → Coaching/Fast → elicitation → concern scan → UJ 捕获）、`bmad-architecture` 的 Coach 优先 + 一条测试句、`bmad-spec` 的"产物派生自日志 + 单一写入者 + companions 分界 + 双 pass 自校验"、`compile-epic-context.md` 的"按目的提炼"交接。
4. **轻量借鉴（INTEGRATE 可选）**：`module-help.csv` 的依赖链表（用数据声明 phase/required/preceded-by/followed-by）+ `bmad-help` 的"扫描产物检测进度"路由思路。
5. **明确排除（REJECT）**：`agents/*` persona 层、`bmad-party-mode`、ship 层（build/code-review/walkthrough/qa）、安装器/多 IDE 分发/渲染快照基建、v6-shims。

对每个候选组件的初始 Decision（详见最终汇报）：`bmad-spec`=REFERENCE_ONLY、`bmad-architecture`=REFERENCE_ONLY、`bmad-prd`=REFERENCE_ONLY、`memlog.py`=ADAPT、`compile-epic-context.md`=INTEGRATE、`module-help.csv` 依赖链=INTEGRATE、`customize.toml` 定制层=REFERENCE_ONLY、`agents/*` persona=REJECT、`bmad-party-mode`=REJECT、ship 层=REJECT。
