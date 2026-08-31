# Project

仓库根：`/Users/morton_cheung/Desktop/AI/SpecCraft/references/spec-kit`（GitHub 官方开源项目 `github/spec-kit`，Python 包名 `specify-cli`）。以下所有结论均基于对真实源码、命令模板、脚本与清单文件的直接阅读。

## What it solves

Spec Kit 是一套"规格驱动开发（Spec-Driven Development, SDD）"的工具箱，目标是把开发流程从"先写代码、规格靠后"反转为"规格是源头、代码是规格的生成产物"。它解决的核心问题是：让任意 AI 编码 Agent（Claude、Copilot、Gemini、Codex、Trae 等 40+ 种）能按固定、可复现、可审计的阶段，从一句自然语言需求逐步生成规格、技术计划、任务清单，最终生成代码，并通过"收敛（converge）"命令把实现与规格之间的差距持续补齐。

它不生成代码本身，而是通过"命令模板（command prompt） + 模板文件（template） + 辅助脚本（script）"三层结构，约束 LLM 在每一步只产出该步该有的、可被下一步消费的结构化工件。

## Repository architecture

顶层分两类：**运行时资产**（会被 `specify init` 装进目标项目）与 **CLI 实现**（在项目里生成这些资产）。

- `templates/` —— 核心资产：`commands/`（10 个命令模板：constitution、specify、clarify、plan、tasks、analyze、checklist、implement、converge、taskstoissues）+ 5 个模板（`spec-template.md`、`plan-template.md`、`tasks-template.md`、`constitution-template.md`、`checklist-template.md`）。
- `scripts/` —— 辅助脚本，三份等价实现：`bash/`、`powershell/`、`python/`（`common`、`check_prerequisites`、`create_new_feature`、`setup_plan`、`setup_tasks`、`resolve_template`）。
- `src/specify_cli/` —— Python CLI：`commands/init.py`（`specify init` 脚手架）、`integrations/`（40+ Agent 集成子包 + `base.py`/`manifest.py`）、`extensions/`（扩展管理器、注册表、HookExecutor）、`presets/`、`bundler/`、`workflows/`（YAML 工作流引擎）、`authentication/`。
- `extensions/`、`presets/`、`bundles/`、`integrations/`、`examples/bundles/` —— 打包与分发各类可复用组件，并各自带 `catalog.json` / `catalog.community.json` 目录。
- `docs/` —— 文档站点源（DocFX），含 `concepts/`、`guides/`、`reference/`。
- `tests/` —— 契约测试、集成测试、hook 测试、脚本 parity 测试。

## Runtime architecture

`specify init <dir> --integration <agent> --script sh|ps|py` 把资产物化到目标项目的 `.specify/` 目录，并在 Agent 目录下写命令文件。运行时形态（在目标项目里）：

```text
.specify/
├── templates/                     # 核心命令与模板（核心层）
│   ├── commands/*.md
│   ├── spec-template.md  plan-template.md  tasks-template.md  ...
│   └── overrides/                 # 项目级覆盖（最高优先级）
├── memory/constitution.md         # 项目宪法（一次性生成，后续可改）
├── feature.json                   # 当前活动 feature 目录指针
├── integrations/<key>.manifest.json  # 每个集成装过哪些文件（SHA-256 追踪）
├── extensions/  presets/  workflows/  # 可选组件
└── scripts/                       # 所选 script type 的辅助脚本
specs/
└── <NNN-slug>/                    # 每个 feature 一个目录
    ├── spec.md  plan.md  tasks.md
    ├── research.md  data-model.md  quickstart.md
    ├── contracts/
    └── checklists/
```

运行时没有常驻服务，全部是"命令模板里的指令 + 脚本输出的 JSON 行"驱动的无状态执行。命令模板通过 `scripts:` frontmatter 声明要调用的脚本；脚本向 stdout 打印 `KEY: value` 或 `--json` 单行 JSON，Agent 解析后拿到绝对路径继续执行。

## Important Skills

Spec Kit 把"命令"在不同 Agent 上映射成 slash command 或 skill。核心技能（skill 名 `speckit-<name>`）与命令一一对应：

- `speckit-constitution` / `speckit-specify` / `speckit-clarify` / `speckit-plan` / `speckit-tasks` / `speckit-analyze` / `speckit-checklist` / `speckit-implement` / `speckit-converge` / `speckit-taskstoissues`。
- 可选扩展技能：`speckit-assess-*`（intake/research/define/shape/decide）、`speckit-bug-*`（assess/fix/test）、`speckit-agent-context-update`、`speckit-git-*`（feature/validate/remote/initialize/commit）。

每个技能 = 一个 Markdown 提示文件，内含 `description` frontmatter、`$ARGUMENTS` 占位、`scripts:` 脚本引用、`handoffs:`（下一步推荐命令）、以及固定的"Pre-Execution Checks / Outline / Mandatory Post-Execution Hooks / Completion Report / Done When"骨架。

## Important Commands

全部位于 `templates/commands/*.md`：

1. **`speckit.constitution`**（constitution.md）—— 创建/更新 `.specify/memory/constitution.md`。调用 `resolve_template constitution-template`，按语义化版本（MAJOR/MINOR/PATCH）维护版本号，写入 HTML 注释形式的 Sync Impact Report。是唯一只写宪法、拒绝执行其它意图的命令（有 Scope Guard）。
2. **`speckit.specify`**（specify.md）—— 从自然语言生成 `specs/<NNN-slug>/spec.md`。自动编号（顺序 3 位或时间戳）、创建目录、持久化 `.specify/feature.json`、做质量 checklist（`checklists/requirements.md`）、最多 3 个 `[NEEDS CLARIFICATION]` 标记。只关心 WHAT/WHY，禁止 HOW。
3. **`speckit.clarify`**（clarify.md）—— 规格定稿前最多问 5 个结构化澄清问题，答案逐条回写进 spec 的 `## Clarifications / ### Session YYYY-MM-DD` 并就地更新对应章节，再重验 requirements checklist。
4. **`speckit.plan`**（plan.md）—— 调 `setup-plan` 复制 plan-template，读取 spec + constitution，产出 `research.md`（Phase 0）、`data-model.md` + `contracts/` + `quickstart.md`（Phase 1）。执行宪法 Gate 检查。
5. **`speckit.tasks`**（tasks.md）—— 调 `setup-tasks` 解析模板并列出 AVAILABLE_DOCS，读取 plan/spec 及可选文档，按用户故事（US1/US2…）拆解成带 `- [ ] T001 [P?] [US?]` 严格格式的 `tasks.md`（Phase 1 Setup → Phase 2 Foundational → 每故事一 Phase → Polish）。
6. **`speckit.analyze`**（analyze.md）—— 只读的跨工件一致性分析（spec/plan/tasks），输出 CRITICAL/HIGH/MEDIUM/LOW 分级报告，不写文件。
7. **`speckit.checklist`**（checklist.md）—— 生成"需求的单元测试"（`checklists/<domain>.md`），校验需求书写质量而非实现行为。
8. **`speckit.implement`**（implement.md）—— 调 `check-prerequisites --require-tasks`，逐 Phase 执行 tasks.md，TDD 顺序，完成后把任务勾选为 `[X]`。
9. **`speckit.converge`**（converge.md）—— 只读评估代码相对 spec/plan/tasks 的差距，把剩余工作以 `## Phase N: Convergence` 追加到 tasks.md（append-only），供 implement 再次消费。
10. **`speckit.taskstoissues`**（taskstoissues.md）—— 依赖 GitHub MCP 工具，把 tasks.md 转成 GitHub issue（去重、仅限 remote 匹配的仓库）。

## Important Hooks

Hook 是扩展在核心命令生命周期事件上挂接自身命令的机制，事件在 `.specify/extensions.yml` 的 `hooks.<event>` 下注册。标准事件：`before_/after_` × {constitution, specify, clarify, plan, tasks, analyze, checklist, implement, converge, taskstoissues}。

Hook 定义字段（见 `extensions/EXTENSION-API-REFERENCE.md`）：`command`、`priority`（≥1，越小越先跑，默认 10）、`optional`（默认 true）、`prompt`、`description`、`condition`。可选 hook 打印提示让用户决定是否执行；必选 hook 打印 `EXECUTE_COMMAND:` 并要求 Agent 实际调用并等待完成。`condition` 表达式由 `HookExecutor` 求值，命令模板明确要求 LLM 不自行解释条件。

典型实例 `extensions/git/extension.yml`：`before_specify` → `speckit.git.feature`（必选，建分支），几乎所有 before/after 事件挂 `speckit.git.commit`（可选，自动提交）。`extensions/agent-context/extension.yml`：`after_specify`/`after_plan` → 刷新 Agent 上下文文件（CLAUDE.md 等）的 Spec Kit 段。

## Important Templates

位于 `templates/`（核心）与 `presets/`、`extensions/` 内的覆盖层，按优先级栈解析（高→低：`.specify/templates/overrides/` → `.specify/presets/<id>/templates/` → `.specify/extensions/<id>/templates/` → `.specify/templates/`）：

- **`spec-template.md`** —— 规格骨架：User Scenarios & Testing（P1/P2/P3 用户故事 + Given/When/Then 验收场景）、Functional Requirements（FR-###）、Key Entities、Success Criteria（SC-###，可度量、技术无关）、Assumptions。要求每个故事可独立测试。
- **`plan-template.md`** —— 计划骨架：Summary、Technical Context（Language/Dependencies/Storage/Testing 等，未知填 NEEDS CLARIFICATION）、Constitution Check（Gate）、Project Structure（文档树 + 源码树）、Complexity Tracking（记录宪法违规的正当理由）。
- **`tasks-template.md`** —— 任务骨架：明确的 `[ID] [P?] [Story] Description` 格式约定、Phase 结构、依赖与并行示例、MVP 优先策略。实际生成时会被替换为真实任务。
- **`constitution-template.md`** —— 宪法骨架：Core Principles（占位 5 条）、可扩展 section、Governance、`Version | Ratified | Last Amended`。
- **`checklist-template.md`** —— checklist 骨架：`- [ ] CHK###` 全局递增 ID、reviewer 所有权说明。

模板解析的关键实现：`scripts/python/common.py` 的 `resolve_template()` / `resolve_template_content()`（与 bash/ps 三份等价），支持 `replace/prepend/append/wrap` 四种组合策略（wrap 用 `{CORE_TEMPLATE}` 占位）。组合策略仅 preset 可用；extension 提供的模板/脚本永远是 `replace`。

## Important Scripts

三份等价实现（sh/ps/py），契约一致（`--json` 单行 JSON 输出）。关键脚本：

- `scripts/python/common.py` —— 核心共享库：`get_repo_root()`（向上找 `.specify`）、`get_feature_paths()`（解析 FEATURE_DIR 及各文件路径）、`persist_feature_json()`、`resolve_template[_content]()`。
- `scripts/python/create_new_feature.py` —— 编号/短名生成、目录创建、复制 spec-template、写 `.specify/feature.json`。
- `scripts/python/setup_plan.py` —— 复制 plan-template 到 feature 目录，输出 `FEATURE_SPEC/IMPL_PLAN/SPECS_DIR/BRANCH`。
- `scripts/python/setup_tasks.py` —— 校验 spec/plan 存在，解析 tasks-template，输出 `FEATURE_DIR/AVAILABLE_DOCS/TASKS_TEMPLATE_CONTENT`。
- `scripts/python/check_prerequisites.py` —— 统一前置校验，`--require-tasks --include-tasks`（implement/analyze/converge 用）、`--paths-only`（clarify 用）、`--template`（checklist 用）。
- `scripts/python/resolve_template.py` —— 独立命令：解析并输出某模板的组合后内容。

## State / Artifact management

状态与工件分层（核心价值点）：

- **项目级状态**：`.specify/feature.json`（`{"feature_directory": "specs/NNN-slug"}`）是"当前活动 feature"的唯一指针，被 specify 写入、被 plan/tasks/implement/analyze/converge 读取，从而不依赖 git 分支名。`.specify/memory/constitution.md` 是跨 feature 的项目治理约束。`.specify/integrations/<key>.manifest.json` 用 SHA-256 追踪每个集成写入的文件，实现安全卸载（用户改过的文件不覆盖）。
- **feature 级工件链**（`specs/<NNN-slug>/`）：

| 命令 | 产出 | 消费方 |
|---|---|---|
| specify | `spec.md` + `checklists/requirements.md` | plan / clarify / tasks |
| clarify | 更新 `spec.md` | plan |
| plan | `plan.md` + `research.md` + `data-model.md` + `contracts/` + `quickstart.md` | tasks / implement |
| tasks | `tasks.md` | implement / analyze / converge / taskstoissues |
| implement | 应用代码 + 勾选 tasks.md | converge |
| converge | 追加 `tasks.md` 的 Convergence Phase | implement |

- **依赖约束**：`setup_tasks.py` 硬性要求 `plan.md`、`spec.md` 存在才产出；`check_prerequisites.py --require-tasks` 硬性要求 `tasks.md` 存在；`analyze`/`converge` 缺任一层都会 STOP 并给出应运行的前置命令名。模板与脚本的层间传值靠 stdout JSON 契约，不靠文件约定。

## Agent integration model

每个 Agent 是 `src/specify_cli/integrations/<key>/__init__.py` 里的一个类，继承 `IntegrationBase` 的子类（`MarkdownIntegration`/`TomlIntegration`/`YamlIntegration`/`SkillsIntegration`），声明 `key`、`config`（folder、commands_subdir、requires_cli）、`registrar_config`（dir、format、args 占位、extension）。注册表 `INTEGRATION_REGISTRY` 由 `_register_builtins()` 组装，是集成元数据的唯一事实来源。

命令文件格式按 Agent 分：Markdown（`$ARGUMENTS`）、TOML（Gemini/Qwen/Tabnine，`{{args}}`）、YAML（Goose recipe）、Skills（Codex 的 `.agents/skills/speckit-*/SKILL.md`）、Copilot 双模式（skills 或 `.agent.md`+`.prompt.md`）。命令模板里的 `{SCRIPT}` 占位在安装时按 `--script` 选择替换为 sh/ps/py 三选一；`__AGENT__` 替换为 Agent 名。

关键边界：CLI **不管理任何 Agent 上下文文件**（CLAUDE.md 等），该职责完全交给 opt-in 的 `agent-context` 扩展。

## Extensibility

三层扩展机制 + 一层打包：

1. **Extensions（扩展能力）**：`extension.yml` 声明 `provides.commands/templates/scripts/config` 与 `hooks`。命令名模式 `speckit.<ext-id>.<cmd>`。安装命令 `specify extension add/remove/search/enable/disable`，来源目录/URL/目录栈（`.specify/extension-catalogs.yml`，`install_allowed` 控制能否安装）。
2. **Presets（覆盖核心）**：`preset.yml` 覆盖核心与扩展的模板/命令/脚本，支持 `replace/prepend/append/wrap` 组合，可多 preset 按 `priority` 堆叠。
3. **Project-local Overrides（单项目微调）**：`.specify/templates/overrides/`，最高优先级。
4. **Bundles（角色化组合）**：`bundle.yml` 把 extensions/presets/steps/workflows 打包为带版本的角色化安装集（`specify bundle search/info/install/remove`）。

另有 **Workflow 引擎**（`src/specify_cli/workflows/`）：YAML 定义的编排器，支持 `init/prompt/shell/command/gate/if_then/switch/do_while/while_loop/fan_in/fan_out` 等步骤类型与状态持久化/续跑。

## Licensing

**许可证：MIT License**，版权方 `Copyright GitHub, Inc.`。来源文件：`/Users/morton_cheung/Desktop/AI/SpecCraft/references/spec-kit/LICENSE`（已逐字阅读，标准 MIT 文本）。仓库内扩展/预设清单中亦标注 `license: MIT`（如 `extensions/git/extension.yml`、`extensions/agent-context/extension.yml`）。另有 `CITATION.cff`、`CODE_OF_CONDUCT.md`、`SECURITY.md`，无 COPYING 类其它许可文件。

## Components useful to SpecCraft

按可复用价值排序：

1. **命令模板 + 模板 + 脚本三层 SDD 流水线**（`templates/commands/*.md` + `templates/*-template.md` + `scripts/python/*.py`）—— 整套 Spec→Plan→Tasks→Implement→Converge 的工件分层与状态契约，可直接作为 SpecCraft 的核心流程参照或底座。
2. **模板优先级栈解析器**（`scripts/python/common.py` 的 `resolve_template[_content]`，及 `src/specify_cli/presets.py`）—— 干净、三份等价实现、支持组合策略，是"可定制规格体系"的现成实现。
3. **扩展 + Hook 模型**（`extensions/EXTENSION-API-REFERENCE.md`、`extensions/*/extension.yml`、`.specify/extensions.yml`）—— 声明式 manifest + 生命周期事件钩子，扩展性设计的范本。
4. **`speckit.converge` / `speckit.analyze` 命令**（`templates/commands/converge.md`、`analyze.md`）—— 差距收敛与跨工件一致性检测的提示工程范本。
5. **Agent 集成抽象层**（`src/specify_cli/integrations/base.py` + `manifest.py`）—— 用 SHA-256 manifest 追踪文件、多种命令格式渲染，可直接支撑"把命令下发到多种 Agent"的需求。

## Components not useful to SpecCraft

- `src/specify_cli/integrations/` 下 40+ 具体 Agent 子包（claude/gemini/copilot 等具体实现）—— 若不打算支持海量第三方 Agent，仅需 `base.py` 思路，具体子包价值低。
- `src/specify_cli/authentication/`（GitHub/Azure DevOps 认证）—— 与 SpecCraft 目标无关。
- `bundler/`、`bundle.yml`、`catalog*.json` 打包分发体系 —— 若不做社区市场，属过度工程。
- `docs/`（DocFX 站点）、`media/`、`newsletters/`、`.github/` workflows —— 项目自身运营资产，与功能无关。
- `workflows/` 引擎（YAML 编排 + fan_out/while 等）—— 与命令模板式的流程重复，若 SpecCraft 走"命令模板"路线则不需要。

## Risks of integration

- **强耦合到命令提示工程**：核心流程的正确性几乎完全依赖 Markdown 命令模板里的指令文本（checklist 格式、`EXECUTE_COMMAND` 约定、`[NEEDS CLARIFICATION]` 等），复制后需同步维护，改一处易破坏下游契约。
- **脚本三份等价维护**：sh/ps/py 三套必须行为一致（项目有 parity 测试约束），若只取 Python 版需自行保证不与上游语义漂移。
- **状态指针脆弱**：`.specify/feature.json` 是单活动 feature 指针，天然不适合多 feature 并行（官方方案是"spec of specs"拆子 feature 或用 worktree 隔离）。
- **MIT 但带品牌与社区目录**：核心流程与名称 `speckit.*`/`specify` 深度绑定，复用需改名，且 catalog 默认指向 GitHub raw URL。
- **无权限边界**：workflow 的 shell 步骤以用户权限执行，`requires.permissions` 明确不是安全边界（engine.py 注释）。

## Recommendation

建议 SpecCraft 采用 **ADAPT** 路线：不要整体 fork，而是抽取"命令模板 + 模板 + 脚本"的工件分层契约与状态管理模型（`.specify/feature.json` 指针、`specs/<slug>/` 目录、stdout JSON 契约、优先级栈模板解析）作为核心流程设计蓝本，用自有命名重写命令模板，并借鉴 converge/analyze 的差距收敛思路。扩展机制（extension.yml + hooks）作为可选扩展层的设计参考（REFERENCE_ONLY）。具体的 40+ Agent 集成、认证、bundler、workflow 引擎不纳入。许可证为 MIT，可直接引用但需保留版权声明。
