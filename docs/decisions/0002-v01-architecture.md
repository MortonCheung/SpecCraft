# ADR 0002 — SpecCraft v0.1 架构方案

- 状态：已接受（待 Owner 批准后进入施工）
- 日期：2026-08-31
- 里程碑：Milestone 1 — v0.1 Core Workflow（目标分支 `feat/v0.1-core-workflow`）

---

## 1. 核心定位

SpecCraft 不是 Coding Agent，也不是另一个多 Agent 框架。

它负责完成一件事：

> 把 Owner 的模糊想法，经过认知、调研、设计、审批和真实项目勘察，逐步加工成 Execution Agent 可以直接执行的精确施工规格。

角色固定：

```text
Owner           决定要什么
      ↓
Planner / SpecCraft  负责主要思考、调研、产品设计、技术设计、施工规划
      ↓
Execution Agent 按施工手册实施
```

Execution Agent 只有工程实施权，没有主要产品设计权。

## 2. 总体技术原则

> **File-first + Declarative Workflow + Lightweight Runtime**

- 工作流和 Artifact 首先是普通文件；
- 人可以直接阅读和修改；
- Git 可以直接管理历史；
- 不依赖数据库；
- 不把状态隐藏在某个 AI 会话里；
- Runtime 只负责状态、校验、Hook、模板和上下文编译。

保证：换 Agent / 换 IDE / 换模型 / 关闭会话 / 几个月后重开，项目仍可继续。

## 3. 技术栈

- 核心 Runtime：**TypeScript + Node.js 20+ + ESM**
- 原因：Node 在 Agent 工具生态适配性已验证；跨平台；CLI/Hook/文件处理方便；后续 Adapter 易实现；避免同时维护 Python + Node 两套 Runtime。
- Python 项目中的优秀逻辑只借设计，不引入 Python Runtime。

## 4. SpecCraft 项目结构

```text
SpecCraft/
├── src/
│   ├── core/
│   │   ├── workflow/
│   │   ├── state/
│   │   ├── artifacts/
│   │   ├── context/
│   │   ├── guards/
│   │   └── templates/
│   ├── cli/
│   └── utils/
├── skills/
│   ├── discovery/  research/  design/  build-brief/
│   ├── site-survey/  execution-manual/  verification/
├── commands/
├── hooks/
├── adapters/
│   ├── generic/  claude-code/  codex/  opencode/
├── templates/
├── schemas/
│   └── default-workflow.yaml
├── docs/
├── third-party/
└── tests/
```

现有 `core/ skills/ commands/ ...` 在代码实现时迁入 `src/`。Skill、Template、Adapter 保留在项目根目录，用户可直接查看。

## 5. 项目运行时目录

SpecCraft 安装到一个真实项目后，在项目内创建：

```text
.speccraft/
├── project.yaml
├── state.yaml
├── workflow.yaml
├── artifacts/
│   ├── idea.md  feasibility.md  discovery.md  requirements.md
│   ├── concept.md  research.md  design.md  build-brief.md
│   ├── site-survey.md  execution-manual.md  verification.md  handoff.md
├── decisions/
└── logs/
    └── workflow.log
```

`.speccraft/` 就是某个项目的 SpecCraft 工作现场，必须能直接进入 Git。

## 6. Artifact 格式

**Markdown + YAML Frontmatter**：

```yaml
---
artifact: design
stage: DESIGN
status: approved
version: 1
---

# Product Design
```

- Markdown：人类阅读 / AI 阅读 / Git diff / 编辑。
- YAML Frontmatter：状态、ID、来源、版本、依赖关系。
- 不用把长产品文档塞进 JSON。

## 7. Workflow 不写死（声明式）

吸收 OpenSpec 优点，建立 `schemas/default-workflow.yaml`，声明 16 个阶段：

```text
IDEA → FEASIBILITY → DISCOVERY → REQUIREMENT → CONCEPT → RESEARCH
→ DESIGN → OWNER_APPROVAL → BUILD_BRIEF → SITE_SURVEY → EXECUTION_MANUAL
→ READY_TO_IMPLEMENT → IMPLEMENTATION → VERIFICATION → OWNER_ACCEPTANCE → HANDOFF
```

每个阶段声明：`id` / `requires` / `produces` / `gate` / `skill` / `template` / `next`。

```yaml
id: execution-manual
requires: [build-brief, site-survey]
produces: [execution-manual]
gate:
  type: all_required_completed
```

以后可定义别的 Workflow，无需改核心代码。

## 8. 状态不通过「文件存在」判断

明确不采用 OpenSpec 的「文件存在即完成」。

建立 `.speccraft/state.yaml`：

```yaml
current_stage: DESIGN
stages:
  research:
    status: completed
  design:
    status: waiting_owner_approval
  build_brief:
    status: locked
```

合法状态第一版：`pending` / `in_progress` / `waiting_owner_approval` / `approved` / `completed` / `blocked` / `locked`。

> `design.md` 存在 ≠ Design 已经批准。

## 9. Owner Approval 是硬门禁

```text
DESIGN → WAITING_OWNER_APPROVAL → Owner 明确批准 → APPROVED → BUILD_BRIEF
```

没有 Approval，`BUILD_BRIEF = locked`。不能让 Agent 自行判断「方案不错，继续开发」。后续提供 `speccraft approve design` 记录明确审批。

## 10. Context Compiler

吸收 BMAD `compile-epic-context` 思想。生成最终施工手册前，将 Requirement / Research / Design / Owner Decisions / Build Brief / Site Survey / Rules 编译成 Execution Context，只保留施工真正需要的信息，避免 Prompt 无限膨胀。

```text
所有历史 Artifact → Context Compiler → Relevant Context → Execution Manual
```

## 11. Execution Manual Skill（最核心）

来源 Superpowers `writing-plans`，按 SpecCraft 理念重设计。

必须说明：在哪里、先看什么、为什么、改什么、怎么改、用什么、按什么顺序、哪些不能改、数据怎样流、模块职责、怎么测试、怎样算完成。

但不替 Agent 写完整源码。

- SpecCraft 负责：Architecture / Interfaces / Data Flow / Responsibilities / Constraints / Implementation Strategy / Verification。
- Agent 负责：具体函数实现、局部变量、局部工程判断、代码细节。

## 12. Skill 格式

每个 Skill 是独立目录：`skills/<name>/SKILL.md` + `templates/`。

`SKILL.md` Frontmatter：

```yaml
---
id: design
stage: DESIGN
requires: [requirements, research]
produces: [design]
authority: planner
---
```

Skill 必须明确：输入、输出、权限、禁止行为、完成标准。

## 13. Agent 权限模型

三个 Authority：`OWNER` / `PLANNER` / `EXECUTOR`。

| 阶段 | Authority |
|---|---|
| Discovery | OWNER + PLANNER |
| Design | PLANNER（+ Owner Approval） |
| Site Survey | EXECUTOR |
| Execution Manual | PLANNER |
| Implementation | EXECUTOR |

Execution Agent 处于 `IMPLEMENTATION` 时，不允许修改 Design Artifact。

## 14. Guards

`src/core/guards/`，第一版四个：

- **Design Guard**：`design != approved` → 禁止 Build Brief。
- **Survey Guard**：`site-survey != completed` → 禁止 Final Execution Manual。
- **Execution Guard**：`execution-manual != completed` → 禁止 Implementation。
- **Completion Guard**：`verification != passed` → 禁止宣布完成。

## 15. Hooks

吸收 Ponytail + Spec Kit 思想，重新设计。第一版生命周期：

```text
before_stage / after_stage
before_artifact / after_artifact
before_implement / after_implement
before_complete
```

例：`before_implement` → 检查 Execution Manual → 检查 Owner Approval → 加载执行规则 → 允许施工。

## 16. Ponytail 如何进入 SpecCraft

不安装完整 Ponytail，抽取原则形成 `skills/execution-guard/`，施工 Agent 开始前自动注入：

```text
先查项目是否已有实现 → 标准库能否完成 → 现有依赖能否完成
→ 平台原生能力能否完成 → 最后才新增实现
```

即内置 Complexity / Reuse Guard。同时保留：YAGNI、No needless abstraction、No dependency without justification、No silent architecture expansion。

## 17. Commands

v0.1 第一批命令：

```text
speccraft init
speccraft status
speccraft next
speccraft approve <stage>
speccraft artifact <stage>
speccraft validate
```

以后 Adapter 再映射为 `/speccraft`、`/speccraft-status` 等，核心 CLI 与 Agent 平台解耦。

## 18. Adapter 架构

SpecCraft Core 不知道 Claude / Codex / Trae 是什么。统一定义 Adapter：

```text
Adapter
├── install()
├── injectContext()
├── registerCommands()
├── registerHooks()
└── uninstall()
```

v0.1 暂定：Generic / Claude Code / Codex。Trae 在 Adapter 接口稳定后加入。

## 19. 开源能力最终归位

| 项目 | 归位 |
|---|---|
| Superpowers | Execution Manual / Verification / Debug / Review 方法论 |
| Ponytail | Hooks / Context Injection / Execution Guard / Rule Consistency |
| Spec Kit | Artifact 分层 / Template Resolver / Validate / Analyze |
| OpenSpec | Declarative Workflow / Artifact DAG / Context Rules（不作 Runtime / persistence dependency） |
| BMAD | Discovery / PRD / Architecture / Context Compilation / Decision Log（Persona 与 Party Mode 不进入） |
| Taskmaster | 设计储备：Dependency Graph / Next Task / Complexity（v0.1 不实现任务引擎） |

## 20. v0.1 实现范围

只打通：

```text
speccraft init → Workflow/State → Discovery → Research → Design
→ Owner Approval → Build Brief → Site Survey → Execution Manual → READY_TO_IMPLEMENT
```

到此停止，暂时不自动执行 Agent。

## 21. 后续版本

- **v0.2**：Implementation / Verification / Code Review / Iteration。
- **v0.3**：Agent Adapter / Hooks / 自动上下文注入。
- **v0.4**：Task Graph / Parallel Execution / Complexity Analysis。

## 22. Git 工作方式

- 远端：`https://github.com/MortonCheung/SpecCraft.git`。
- Milestone 1 全部在 `feat/v0.1-core-workflow` 分支施工。
- 未经 Owner 验收，不直接合并 `main`。

## 23. Definition of Done（v0.1）

1. 空项目可运行 `speccraft init`。
2. 自动创建 `.speccraft/`。
3. 正确读取 Workflow。
4. 记录真实阶段状态。
5. Owner Approval 是硬门禁。
6. 缺少上游 Artifact 时不能跳阶段。
7. 能生成/管理阶段 Artifact。
8. 能执行 `speccraft status`。
9. 能执行 `speccraft next`。
10. 能执行 `speccraft validate`。
11. Design 未批准时不能进入 Build Brief。
12. Site Survey 未完成时不能生成最终 Execution Manual。
13. 能最终达到 `READY_TO_IMPLEMENT`。
14. 不能因为文件存在就自动认为阶段完成。
15. Runtime 不依赖数据库或某一个 AI 平台。
16. 所有第三方代码复用均有来源和 License 记录。

## 最终架构原则

> **Human decisions are explicit.
> Workflow state is persistent.
> Artifacts are inspectable.
> Agents execute; they do not invent the product.**
