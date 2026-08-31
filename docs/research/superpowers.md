# Project

- 名称：Superpowers（npm 包名 `superpowers`）
- 版本：6.3.0（见 `package.json`、`.claude-plugin/plugin.json` 等多处清单）
- 作者：Jesse Vincent（`jesse@fsck.com`），Prime Radiant
- 仓库：https://github.com/obra/superpowers
- 设计定位：零第三方依赖（zero-dependency）的编码代理（coding agent）"软件开发方法论"插件。核心产物是一组可组合的 skill 文档 + 一个让代理在会话开始时自动加载这些 skill 的运行时 bootstrap。

## What it solves

解决"编码代理拿到需求后直接跳进去写代码、产出一堆难维护且未经验证的代码"的问题。它强制一条从想法到可合并分支的流水线：

1. 在写任何代码前先做设计澄清（brainstorming），把粗糙想法提炼成 spec；
2. 把 spec 转成低判断成本、几乎逐行给出代码的实施计划（writing-plans）；
3. 用 subagent 逐任务执行 + 两级审查（subagent-driven-development）或批量执行 + 人工 checkpoint（executing-plans）；
4. 全程强制 TDD（test-driven-development）、根因调试（systematic-debugging）、"有证据才能声称完成"（verification-before-completion）；
5. 最后通过工作区隔离（using-git-worktrees）和合并决策（finishing-a-development-branch）收尾。

核心哲学：系统性优于即兴、复杂度最小化、证据优于断言、YAGNI、DRY。

## Repository architecture

顶层按"一份技能内容 + 每个 harness 一份插件清单/引导"组织：

- `skills/` —— 核心资产。每个 skill 一个目录，内含 `SKILL.md`（YAML frontmatter 的 name/description + Markdown 正文），部分 skill 附带 `scripts/`、`*.md` 参考文件、prompt 模板。共 14 个 skill 目录。
- `hooks/` —— 会话启动引导脚本。`session-start`（bash）、`hooks.json`（Claude Code 格式）、`hooks-cursor.json`（Cursor 格式）、`run-hook.cmd`（Windows polyglot 包装器）。
- 每 harness 一个清单目录：`.claude-plugin/`、`.cursor-plugin/`、`.codex-plugin/`、`.devin-plugin/`、`.kimi-plugin/`、`.hermes-plugin/`、`.opencode/`、`.pi/`、`.agents/`，以及根目录 `gemini-extension.json`。
- `scripts/` —— 发布/打包/版本工具（与运行时无关）。
- `tests/` —— 各 harness 的插件基础设施集成测试（`test-*.sh` / `*.test.js` / pytest）。
- `docs/superpowers/` —— 该项目用它自己的方法论开发自己：`specs/`（design 文档）与 `plans/`（实施计划），是方法论本身的使用范例。
- `assets/` —— 图标。
- 根目录 `package.json`（`"type": "module"`，`main` 指向 `.opencode/plugins/superpowers.js`）、`LICENSE`、`CLAUDE.md`、`GEMINI.md`、`.version-bump.json`、`.pre-commit-config.yaml`。

## Runtime architecture

运行时没有共享引擎，靠"会话开始注入 bootstrap"让每个 harness 里的代理知道该检查并使用 skill：

- **bootstrap 内容** = `skills/using-superpowers/SKILL.md` 的正文（剥离 frontmatter），被包进 `<EXTREMELY_IMPORTANT>…</EXTREMELY_IMPORTANT>` 块注入。它规定：任何响应/动作前必须检查并调用相关 skill；处理类 skill 优先于实现类 skill；附带一张"合理化借口 → 现实"的 Red Flags 表。
- **三种注入机制**（按 harness 分派）：
  1. `hooks/session-start`（bash）：读取 using-superpowers 内容，按平台输出不同 JSON 字段（Claude Code 的 `hookSpecificOutput.additionalContext`、Cursor/Copilot 的 `additional_context`/`additionalContext`）。由 `hooks.json` / `hooks-cursor.json` 在 `SessionStart`（matcher `startup|clear|compact`）触发。
  2. `.opencode/plugins/superpowers.js`：两个钩子——`config` 钩子把 `skills/` 路径注册进 OpenCode 配置；`experimental.chat.messages.transform` 钩子把 bootstrap 注入首个用户消息（带缓存与去重）。
  3. `.pi/extensions/superpowers.ts`：`resources_discover` 注册 skills 路径；`session_start`/`session_compact` 时注入 bootstrap，`agent_end` 关闭注入；含 Pi 专属工具映射。

技能本身是纯 Markdown（加少量 graphviz dot 图），不含代码执行——行为靠 prompt 约束，不靠库。

## Important Skills

全部 14 个 skill 的 `SKILL.md` 均已通读。重点：

- **brainstorming**（`skills/brainstorming/SKILL.md`）：任何创造性工作前的设计澄清。先分类为 Spike（可行性探针）/ Bounded（已有代码的小改动）/ Architectural（新项目/新子系统），不同路径有不同仪式，但**批准门槛不随规模变化**——不得到用户批准不得进入实现。Architectural 路径：探索上下文 → 逐个提问 → 提 2-3 方案 → 分段呈现设计并逐段获批 → 写 spec 到 `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` → spec 自审 → 用户复核 → 移交 writing-plans。有可选的可视化伴侣（浏览器 mockup，见脚本）。
- **writing-plans**（`skills/writing-plans/SKILL.md`）：把 spec 转成实施计划，见下节专述。
- **subagent-driven-development**（`skills/subagent-driven-development/SKILL.md`，简称 SDD）：每个任务派一个 fresh implementer subagent，之后派 task reviewer（spec 合规 + 代码质量两个裁决），最多 5 轮 fix loop（1-3 轮复用原 implementer，4-5 轮换更强模型），最终全分支评审。用 ledger 文件记录进度与裁决，跨 compaction 存活。明确"subagent 不得再派发 subagent"契约；明确模型选择策略（机械任务用最便宜模型、最终评审用最强模型）。
- **executing-plans**（`skills/executing-plans/SKILL.md`）：无 subagent 环境下的降级方案，顺序执行 + checkpoint，遇阻即停问人。
- **dispatching-parallel-agents**（`skills/dispatching-parallel-agents/SKILL.md`）：2+ 个无共享状态、无顺序依赖的问题域时，同一响应里并行派发多个 subagent。这是仓库中唯一的"parallel agent"能力（SDD 明确禁止并行派发多个实现 subagent）。
- **test-driven-development**（`skills/test-driven-development/SKILL.md`）：RED-GREEN-REFACTOR 铁律——"没有先失败的测试就不写生产代码"，测试先行、看它失败、写最小实现、看它通过、提交。违反即删代码重来。
- **systematic-debugging**（`skills/systematic-debugging/SKILL.md`）：四阶段（根因调查 → 模式分析 → 假设与最小验证 → 实现修复）；3 次修复失败则质疑架构。附 `root-cause-tracing.md`、`defense-in-depth.md`、`condition-based-waiting.md` 等参考。
- **verification-before-completion**（`skills/verification-before-completion/SKILL.md`）：任何成功声称前必须运行验证命令并读到输出；"应该能过/之前跑过"一律不算。
- **requesting-code-review**（`skills/requesting-code-review/SKILL.md`）+ **receiving-code-review**（`skills/receiving-code-review/SKILL.md`）：前者派发审查 subagent（附 `code-reviewer.md` 模板）；后者要求技术性验证后回应，禁止表演式附和（"You're absolutely right!"），不确定就先澄清。
- **using-git-worktrees**（`skills/using-git-worktrees/SKILL.md`）：优先用平台原生 worktree 工具，其次 `git worktree add` 回退；强调先检测是否已在隔离区、子模块守卫、目录必须 git-ignore。
- **finishing-a-development-branch**（`skills/finishing-a-development-branch/SKILL.md`）：验证测试 → 检测环境（普通仓库 / 命名分支 worktree / detached HEAD）→ 给 3 或 2 个菜单选项 → 执行 → 清理。
- **using-superpowers**（`skills/using-superpowers/SKILL.md`）：元技能，bootstrap 本体。
- **writing-skills**（`skills/writing-skills/SKILL.md`）：用 TDD 方式创建/验证 skill（先跑压力场景看代理违规 → 写 skill → 看代理合规 → 堵漏洞）。

### writing-plans：如何把设计转成低判断成本实施计划

- **输入**：已批准并提交的 spec/design 文档（brainstorming Architectural 路径的产物）；假设执行者是"对我们的代码库零上下文、品味差、不熟悉测试设计"的工程师。
- **输出**：单个 Markdown 计划，默认存 `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`。
- **前置**：若 spec 覆盖多个独立子系统，先拆成多个 plan，每个 plan 各自产出可运行的软件。
- **步骤**：
  1. **File Structure**：先规划将创建/修改哪些文件、各自职责。文件按"一起变化的放一起、按职责而非技术层拆分"。
  2. **Task Right-Sizing**：任务是"带独立测试周期、值得独立审查门槛"的最小单元；每个任务以可独立测试的交付物结尾。
  3. **计划头**（固定格式）：`Goal`（一句话）、`Architecture`（2-3 句）、`Tech Stack`、`Spec`（指向 spec 路径，spec 随计划走）、`Global Constraints`（从 spec 逐字复制的项目级约束：版本下限、依赖上限、命名/文案规则、平台要求，逐行原文）。
  4. **每个 Task N** 固定结构：`Files`（`Create: 精确路径` / `Modify: 精确路径:行号` / `Test: 路径`）、`Interfaces`（`Consumes` 上游任务给什么 / `Produces` 下游任务靠什么——精确函数名、参数与返回类型；因为 implementer 只看到自己的任务，靠这段获知相邻任务的签名）、随后是 `- [ ] Step 1..N` 复选框步骤。
  5. **Bite-sized 步骤**（每步一个动作，2-5 分钟）：写失败测试 → 运行确认失败 → 写最小实现 → 运行确认通过 → 提交（附确切命令与预期输出）。
  6. **No Placeholders**：禁止 TBD/TODO/"添加适当的错误处理"/"类似 Task N"（必须重复代码）；代码步骤必须带代码块；不得引用未在任何任务中定义的类型/函数。
  7. **Self-Review**（作者自查，非 subagent）：spec 覆盖率（每个需求能否指向一个任务）、占位符扫描、类型一致性（后文引用的签名必须与前文定义一致）。
  8. **Execution Handoff**：计划保存后让用户在"Subagent-Driven（推荐，每任务 fresh subagent + 两级审查）"与"Inline（executing-plans 批量 + checkpoint）"之间选择。

低判断成本的关键机制：完整代码、精确文件与行号、精确接口签名、逐字复制的全局约束、每步带命令与预期输出的 TDD 步骤，使执行者（尤其 subagent）几乎无需自行设计决策。

## Important Commands

仓库自身没有 CLI 入口；关键命令是 skill 内部脚本与发布脚本：

- SDD 工件脚本（`skills/subagent-driven-development/scripts/`）：
  - `sdd-workspace PLAN_FILE` —— 解析并创建该 plan 的 git-ignored 工作目录 `<repo>/.superpowers/sdd/<plan-basename>/`，打印绝对路径。
  - `task-brief PLAN_FILE N` —— 用 awk 提取第 N 个任务全文到 `task-N-brief.md`，供 implementer 一次读取。
  - `review-package PLAN_FILE BASE HEAD` —— 生成 commit 列表 + `--stat` + `git diff -U10` 到一个 diff 文件，供 reviewer 一次读取（默认输出 `review-<base7>..<head7>.diff`）。
- 可视化伴侣（`skills/brainstorming/scripts/`）：`start-server.sh [--project-dir PATH] [--host H] [--open] [--foreground]`、`stop-server.sh`（零依赖 Node WebSocket 服务 `server.cjs`）。
- 发布/维护（`scripts/`）：`bump-version.sh <ver>|--check|--audit`（多清单版本同步与漂移检测）、`lint-shell.sh`（ShellCheck + shfmt）、`package-codex-plugin.sh`（打包 Codex 插件 zip/tar.gz）、`sync-to-codex-plugin.sh`（同步到 openai-codex-plugins 仓库并开 PR）。
- 测试：各 `tests/<harness>/` 目录下的 `run-*.sh` / `test-*.sh` / `npm test`。

## Important Hooks

- `hooks/session-start`：bootstrap 注入的核心脚本。按环境变量（`CURSOR_PLUGIN_ROOT`、`CLAUDE_PLUGIN_ROOT`、`COPILOT_CLI`）输出对应平台的 JSON 字段；用 bash 参数替换做 JSON 转义；用 `printf` 而非 heredoc（规避 bash 5.3+ heredoc 挂起）。
- `hooks/hooks.json`：Claude Code 的 hook 配置，`SessionStart`，matcher `startup|clear|compact`，触发 `run-hook.cmd session-start`。
- `hooks/hooks-cursor.json`：Cursor 的 `sessionStart` 配置，同样指向 `run-hook.cmd session-start`。
- `hooks/run-hook.cmd`：跨平台 polyglot 包装器（Windows 批处理找 Git bash 执行；Unix 侧直接 exec bash）。

## Important Templates

（均为"派发 subagent 时填充的 prompt 模板"）

- `skills/subagent-driven-development/implementer-prompt.md`：实现 subagent 的派发模板。含"你不派发 subagent"契约、BLOCKED/NEEDS_CONTEXT/DONE_WITH_CONCERNS 四种状态报告、写报告文件而非回传全文、TDD 证据要求。
- `skills/subagent-driven-development/task-reviewer-prompt.md`：任务审查模板。输出 Spec Compliance（✅/❌/⚠️）+ Strengths + Issues（Critical/Important/Minor）+ Task quality 两裁决；"不要信任实现者的报告"。
- `skills/subagent-driven-development/re-review-prompt.md`：scoped 复检模板。只裁决每个 finding 是 ADDRESSED 还是 NOT ADDRESSED + 检查 fix diff 新破坏，不重做全量审查。
- `skills/requesting-code-review/code-reviewer.md`：全分支/merge 前审查模板。输出 Strengths / Issues(三档) / Recommendations / Assessment(Ready to merge?)。
- `skills/writing-plans/plan-document-reviewer-prompt.md`：计划文档审查模板（Completeness / Spec Alignment / Task Decomposition / Buildability）。
- `skills/brainstorming/spec-document-reviewer-prompt.md`：spec 文档审查模板（同族）。
- `skills/brainstorming/scripts/frame-template.html`：可视化伴侣的浏览器帧模板。

## Important Scripts

- `skills/subagent-driven-development/scripts/{sdd-workspace,task-brief,review-package}`：见 Important Commands。它们实现"工件以文件传递、不经过 controller 上下文"这一核心机制。
- `skills/brainstorming/scripts/{server.cjs,start-server.sh,stop-server.sh,helper.js}`：可视化伴侣的零依赖实现——`server.cjs` 用 Node 标准库手写 RFC 6455 WebSocket（含 auth token、生命周期管理、idle 超时）。
- `scripts/bump-version.sh`：由 `.version-bump.json` 驱动，跨 `.claude-plugin/.cursor-plugin/.codex-plugin/.devin-plugin/.kimi-plugin/.hermes-plugin/package.json/gemini-extension.json` 等多清单同步版本号，含 `--audit` 仓库级漏改扫描。
- `scripts/package-codex-plugin.sh`、`scripts/sync-to-codex-plugin.sh`：发布/同步工具，含确定性归档（`TZ=UTC` 定时间戳、canonical 权限、排除 source-only 路径）。
- `scripts/lint-shell.sh`：ShellCheck + shfmt 的自检工具。

## State / Artifact management

- **SDD ledger**（`<repo>/.superpowers/sdd/<plan-basename>/progress.md`）：进度与裁决的唯一持久记录。首行声明 plan 文件路径；每任务以 `Task <N>: complete (commits <base7>..<head7>, review clean)` 或 fix-round 行记录；`Ruling:` 行记录 controller 做的每个裁决及"错了的代价"。设计目的是在会话 compaction 后靠 ledger + `git log` 恢复，避免重跑已完成任务（该仓库记录的"最昂贵失败模式"）。
- **工件以文件传递**：task brief、implementer report、review package 全部落盘为文件，subagent 一次 Read 读取，controller 上下文不承载 diff 与报告全文。
- **每个 plan 独立工作目录**，防止不同 plan 互相读写；`.superpowers/sdd/` 下放 `*` 的 `.gitignore` 使其不入 git。
- **可视化伴侣**：session 文件放 `--project-dir/.superpowers/brainstorm/<session-id>/`（含 server.log、`.last-port`、`.last-token`）或 `/tmp/brainstorm-<id>/`；`umask 077` 保证 token 仅 owner 可读。
- 版本由 `.version-bump.json` 集中声明，脚本保证多清单一致。

## Agent integration model

- **bootstrap 触发**：harness 的 session-start（或等价）钩子把 `using-superpowers` 内容注入，代理据此在每次动作前自查是否有适用 skill。验收测试（见 `CLAUDE.md`/`AGENTS.md`）：干净会话里发 `Let's make a react todo list`，必须自动触发 brainstorming 才算真集成。
- **controller + subagent 分工**：主会话做协调（读 plan、派发、裁决、记 ledger），实现与审查全部下沉到 fresh subagent。subagent 不得继承 controller 会话上下文，只拿到精炼的 brief/报告/diff 文件路径。
- **no-subagents 契约**：implementer 与 reviewer 的模板都明令禁止再派发 subagent（避免重复审查席位与成本）。
- **模型选择**：按任务复杂度显式指定 subagent 模型（转录类用最便宜、集成/判断类用标准、最终评审用最强），并警告"省略 model 会静默继承最贵模型"。
- **多平台适配**：`using-superpowers/references/{codex,pi,antigravity,hermes,gemini}-tools.md` 提供各 harness 的工具映射。

## Extensibility

- **新增 harness**：需一个清单目录 + 一个 session-start 引导（bootstrap 注入），并附端到端会话 transcript（见 CLAUDE.md "New Harness Support"）。已有 Claude Code、Cursor、Codex（App/CLI）、Devin、Kimi、Hermes、OpenCode、Pi、Gemini、Antigravity、Copilot CLI、Grok 等 13+ 集成。
- **新增 skill**：放 `skills/<name>/SKILL.md`，用 `writing-skills` 的 TDD 方法验证（先看代理无 skill 时如何违规，再写 skill，再验证合规）。核心 repo 只收通用技能，领域/项目专属内容须另发插件。
- **零依赖原则**：核心不接受第三方依赖（除非为支持新 harness）；skill 内容对"合规性改写"极敏感，需 eval 证据才接受改动。

## Licensing

- **许可证**：MIT License，版权 `Copyright (c) 2025 Jesse Vincent`。
- **来源文件**：`/Users/morton_cheung/Desktop/AI/SpecCraft/references/superpowers/LICENSE`（真实读取，非猜测）。多个插件清单（`.claude-plugin/plugin.json` 等）亦声明 `"license": "MIT"`。
- 另有 `CODE_OF_CONDUCT.md`、`FUNDING.yml`（无额外法律约束）。
- 注：可视化伴侣默认从 Prime Radiant 网站加载 logo（含版本号，属可选遥测，可用 `SUPERPOWERS_DISABLE_TELEMETRY` 关闭）。

## Components useful to SpecCraft

按对"SpecCraft（把需求转成结构化 spec/计划）"的可复用价值排序：

1. `skills/writing-plans/SKILL.md` —— 把 spec 转成低判断成本实施计划的方法论（任务结构、Interfaces 块、No Placeholders、Global Constraints、Self-Review）。是 SpecCraft 计划生成环节最直接的参考。
2. `skills/brainstorming/SKILL.md` —— 需求澄清与设计确认的三路径（Spike/Bounded/Architectural）+ 硬批准门槛 + 分段呈现设计。对应 SpecCraft 的 spec 生成前交互。
3. `skills/subagent-driven-development/SKILL.md` + 其 `scripts/`（sdd-workspace/task-brief/review-package）与三个 prompt 模板 —— 计划执行、两级审查、ledger 工件管理的完整参考实现。
4. `skills/verification-before-completion/SKILL.md` —— "证据先于声称"的完成门禁，可直接借鉴为 SpecCraft 的验收标准。
5. `skills/test-driven-development/SKILL.md` + `systematic-debugging/SKILL.md` —— 执行阶段的行为约束（若 SpecCraft 也产出可执行计划）。
6. `hooks/session-start` + `.opencode/plugins/superpowers.js` + `.pi/extensions/superpowers.ts` —— 多 harness 的 bootstrap 注入范式（SpecCraft 若要"自动触发"，可借鉴其按平台输出不同字段的做法）。

## Components not useful to SpecCraft

- `scripts/{bump-version.sh,package-codex-plugin.sh,sync-to-codex-plugin.sh,lint-shell.sh}` —— 纯发布/打包/CI 工具，与 SpecCraft 无关。
- `skills/using-git-worktrees`、`skills/finishing-a-development-branch` —— 强耦合 git 工作流与平台原生工具，SpecCraft 若不做执行/集成阶段则用不上。
- `skills/using-superpowers` 的"强制在任何响应前调用 skill"的元规则与 Red Flags 表 —— 是 harness 绑定机制，非可移植内容。
- `assets/`、`docs/`、`tests/`、各 harness 清单目录 —— 项目自身基础设施。
- `skills/brainstorming/scripts/`（可视化伴侣 WebSocket 服务）—— 与 SpecCraft 的 spec 生成目标正交。

## Risks of integration

- **许可**：MIT 宽松，可复制/修改/商用，但需保留版权与许可声明。直接复制其文本到 SpecCraft 需附带原 LICENSE 归属。
- **措辞强绑定**：Superpowers 明确声明 skill 是"塑造代理行为的代码"，大量依赖"Red Flags 表 / 合理化列表 / your human partner 措辞"等精心调校的内容；若只摘抄片段而不理解其 eval 背景，可能丢失行为效果。
- **harness 假设**：SDD 的 ledger/工件机制假定存在 subagent 能力与可写 `.superpowers/` 目录；若 SpecCraft 目标环境无 subagent，这部分不可直接移植。
- **subagent 模型选择**：大量规则依赖"能显式指定 subagent 模型"的 harness 能力，并非所有环境支持。
- **telemetry**：可视化伴侣有默认 logo 遥测（可关闭），集成前需评估。

## Recommendation

SpecCraft 应以 **REFERENCE_ONLY / ADAPT** 为主——复用其方法论与文档结构（尤其 writing-plans 的任务分解、Interfaces 块、No Placeholders、Global Constraints），而非直接复制文本或运行时。若要落地"计划生成"，最有价值的是把 `writing-plans/SKILL.md` 的"计划文档格式 + 自查清单"固化为 SpecCraft 的输出 schema；若要落地"执行验证"，借鉴 `subagent-driven-development` 的 ledger 工件模式与 `verification-before-completion` 的验收门禁。不建议引入其 harness bootstrap 与 git-worktree 机制，除非 SpecCraft 也定位为跨 harness 的运行时插件。
