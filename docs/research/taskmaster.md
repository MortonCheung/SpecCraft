# Project

仓库根：`/Users/morton_cheung/Desktop/AI/SpecCraft/references/taskmaster`（GitHub 开源项目 `eyaltoledano/claude-task-master`，npm 包名 `task-master-ai`，当前版本 0.43.1）。以下结论均基于对真实源码、提示模板、schema、清单与 License 文件的直接阅读，未依赖 README 转述。

## What it solves

Task Master 是一套"面向 AI 编码 Agent 的任务管理 + PRD 拆解系统"。它解决的核心问题是：把一个自然语言 PRD 自动拆成结构化的、带依赖关系的开发任务清单（tasks.json），并围绕这份清单提供"复杂度分析 → 子任务展开 → 按依赖挑下一个任务 → 状态流转 → 持久化"的完整闭环，让 Claude/Cursor/Codex/Trae 等 Agent 在开发时始终知道"下一个该做什么、依赖什么、做到什么程度算完成"。

它不生成应用代码，只生成并管理"任务"这一层工件；AI 的参与方式是通过可插拔的 LLM provider 调用，把 PRD/任务文本转成结构化 JSON（用 Zod schema 校验）。

## Repository architecture

这是一个 pnpm monorepo（`.manypkg.json` 存在，多 `package.json`），内部有明确的分层，且存在"旧 JS 实现"与"新 TS 实现"两套并存：

- `scripts/modules/` —— **核心业务逻辑（最重要）**：`task-manager.js`（聚合再导出）、`task-manager/`（parse-prd、expand-task、analyze-task-complexity、find-next-task、set-task-status、update-single-task-status 等子模块）、`dependency-manager.js`、`config-manager.js`、`utils.js`（readJSON/writeJSON/依赖遍历等）、`ai-services-unified.js`、`prompt-manager.js`、`ui.js`。
- `src/` —— **共享层**：`ai-providers/`（20 个 LLM provider 类）、`schemas/`（Zod schema + `registry.js`）、`prompts/`（Handlebars 提示模板 JSON）、`constants/`（paths / task-status / task-priority / commands）、`profiles/`（各 Agent 的规则转换 profile，含 `trae.js`）、`utils/`、`progress/`、`telemetry/`。
- `mcp-server/` —— **旧版 MCP server（纯 JS）**：`src/tools/`（MCP 工具包装 + `tool-registry.js`）、`src/core/direct-functions/`（每个 direct function 是对 `scripts/modules` 核心函数的薄封装）、`src/custom-sdk/`（自建 MCP SDK 子集）。
- `apps/cli/` —— **新版 CLI（TypeScript + Commander）**：`src/commands/`（init/parse-prd/list/show/next/set-status/expand/...）、`src/export/`（任务导出/映射/选择器）。
- `apps/mcp/` —— **新版 MCP 工具（TypeScript）**：`src/tools/`（tasks/generate、get-task、get-tasks、autopilot 系列）。
- `apps/extension/` —— VS Code 扩展（webview + services，带独立 `LICENSE`）。
- `apps/docs/` —— 文档站点源（MDX）。
- `assets/`、`.cursor/rules/`、`.claude/commands/`、`.kiro/`、`.github/` —— 面向不同 Agent 的规则/命令/钩子/CI 资产。
- `.taskmaster/` —— 本项目自用的任务数据（`tasks/tasks.json` 1.5MB，含真实历史任务与子任务，是理解数据模型的样本）。

注：`config-manager.js` 等文件 `import ... from '@tm/core'`，`@tm/core` 是包内别名，指向编译后的内部包；核心算法源码仍在 `scripts/modules/` 与 `src/` 内可读。

## Runtime architecture

运行时无常驻服务，两种运行形态共享同一套 `scripts/modules` 核心：

1. **CLI**：`task-master <command>`，读 `.taskmaster/tasks/tasks.json` + `.taskmaster/config.json`，直接调用核心函数，输出彩色终端 UI。
2. **MCP server**：`npx task-master-ai`，FastMCP 注册工具 → 工具包装 → `direct-functions` → 核心函数；MCP 模式下所有日志走 silent mode / logger，返回结构化 `{ success, data | error }`。

核心数据文件（`src/constants/paths.js` 定义）：
- `.taskmaster/tasks/tasks.json` —— 唯一任务事实源（**tag 化结构**：`{ "<tag>": { "tasks": [...], "metadata": {...} } }`，默认 tag `master`）。
- `.taskmaster/config.json` —— 模型/角色配置（main/research/fallback + global 参数）。
- `.taskmaster/docs/prd.txt|md` —— PRD 输入。
- `.taskmaster/reports/task-complexity-report.json` —— 复杂度报告。
- `.taskmaster/templates/example_prd.*` —— PRD 示例模板。
- `tasks/`（或 `.taskmaster/tasks/task_001.txt`）—— 由 `generate` 从 tasks.json 派生的单任务文件。

**任务数据模型**（从 `tasks.json` 样本与 schema 确认）：顶层任务字段为 `id`(number)、`title`、`description`、`status`、`dependencies`(id 数组)、`priority`、`details`、`testStrategy`、`subtasks`(数组)；子任务用点号 ID `parentId.subId`（如 `1.2`），子任务之间可再有依赖（相对引用：同父下可用裸数字，<100 视为兄弟子任务）。状态机（`src/constants/task-status.js`）：`pending / done / in-progress / review / deferred / cancelled`；优先级（`src/constants/task-priority.js`）：`high / medium / low`。

## Important Skills

本项目本身不定义"skill"（那是 Spec Kit 的概念），它以 **MCP 工具 + 规则文件 + profile** 三种方式把能力暴露给 Agent：

- **MCP 工具分层**（`mcp-server/src/tools/tool-registry.js`）：`core`（7 个：get_tasks、next_task、get_task、set_task_status、update_subtask、parse_prd、expand_task）、`standard`（14 个）、`all`（44+），通过环境变量 `TASK_MASTER_TOOLS` 选择。
- **规则文件**：`.cursor/rules/`（dev_workflow、taskmaster、dependencies、tasks、test_workflow 等 20+ 条 `.mdc`）、`assets/AGENTS.md`（Claude Code 集成指南，实为 CLAUDE.md 同源）、`assets/rules/*.mdc`、`.kiro/steering/`（kiro 规则）。
- **Agent profile 转换**：`src/profiles/*.js`（claude/cursor/codex/gemini/trae/windsurf/zed/roo 等 17 个），用 `base-profile.js` 的 `createProfile` + `rule-transformer.js` 把通用规则转成各 Agent 格式。

## Important Commands

CLI 命令（`apps/cli/src/commands/` 与 README/AGENTS.md 交叉确认）：

- `task-master init` —— 初始化项目（生成 `.taskmaster/` 结构）。
- `task-master parse-prd <prd>` —— PRD → 任务（核心入口，支持 `--num-tasks`、`--force`、`--append`、`--research`）。
- `task-master list [--status=] [--with-subtasks]` —— 列出任务。
- `task-master show <id|1.2>` —— 查看任务/子任务详情。
- `task-master next` —— 找下一个可做任务。
- `task-master set-status --id=<id> --status=<status>` —— 改状态（多 ID 逗号分隔，支持子任务点号 ID）。
- `task-master expand --id=<id> [--num=N] [--research] [--force]` / `expand --all` —— 任务展开为子任务。
- `task-master clear-subtasks --id=<id>|--all` —— 清空子任务。
- `task-master analyze-complexity [--threshold=N] [--research] [--id=] [--from=] [--to=]` —— 复杂度分析。
- `task-master complexity-report` —— 查看复杂度报告。
- `task-master add-dependency --id= --depends-on=` / `remove-dependency` / `validate-dependencies` / `fix-dependencies` —— 依赖管理。
- `task-master add-task --prompt=` / `update --from=` / `update-task --id=` / `update-subtask --id=` —— 增改任务/子任务。
- `task-master generate` —— 从 tasks.json 派生单任务文件。
- `task-master models` / `add-tag` / `use-tag` / `scope-up` / `scope-down` / `research` / `move` 等。

## Important Hooks

- **Kiro 文件监听钩子**（`.kiro/hooks/`，JSON 描述）：`tm-complexity-analyzer.kiro.hook`（监听 `tasks.json` 被编辑后，触发 Agent 对新任务跑 `analyze-complexity`，>7 分自动 `expand --num=5`）、`tm-git-commit-task-linker.kiro.hook`、`tm-pr-readiness-checker.kiro.hook`。这些是"文件变化 → 触发 Agent 动作"的事件钩子，默认 `enabled: false`。
- 相关规则文档：`assets/rules/taskmaster_hooks_workflow.mdc`、`.kiro/steering/taskmaster_hooks_workflow.md`。
- 仓库内 `.github/` 无 git 钩子；CI 用 GitHub Actions workflows。

## Important Templates

- **PRD 示例模板**：`.taskmaster/templates/example_prd.md`、`example_prd.txt`、`example_prd_rpg.md/txt`（RPG 方法变体）。
- **提示模板**（`src/prompts/*.json`，Handlebars，带 `metadata/parameters/prompts` 结构，支持 variant）：`parse-prd.json`、`analyze-complexity.json`、`expand-task.json`、`add-task.json`、`update-task.json`、`update-subtask.json`、`update-tasks.json`、`research.json`。模板含 `{{#if research}}`、`{{#if hasCodebaseAnalysis}}` 等条件块与 `{{{json tasks}}}` 注入。
- **单任务文件模板**：由 `generate` 命令派生（`task_001.txt` 命名，`src/constants/paths.js` 定义 `TASK_FILE_PREFIX`）。

## Important Scripts

- `scripts/modules/task-manager.js` —— 核心聚合入口，re-export 全部任务管理函数。
- `scripts/modules/task-manager/find-next-task.js` —— **纯函数**，无 I/O，next-task 选择算法（见下）。
- `scripts/modules/dependency-manager.js` —— 依赖增删/校验/修复（含 `isCircularDependency`、`findCycles` 逻辑）。
- `scripts/modules/task-manager/parse-prd/parse-prd.js` + `parse-prd-helpers.js` + `parse-prd-streaming.js` / `parse-prd-non-streaming.js` —— PRD 解析主流程（流式 + 非流式降级）。
- `scripts/modules/task-manager/analyze-task-complexity.js` —— 复杂度分析主流程。
- `scripts/modules/task-manager/expand-task.js` —— 子任务展开主流程。
- `scripts/modules/task-manager/set-task-status.js` + `update-single-task-status.js` —— 状态流转（含父子级联）。
- `scripts/modules/utils.js` —— `readJSON`/`writeJSON`（tag 解析、legacy 迁移、文件锁）、`traverseDependencies`、`findCycles`、`addComplexityToTask`、`flattenTasksWithSubtasks`。
- `scripts/modules/ai-services-unified.js` —— 统一 AI 调用（`generateObjectService`，走 schema 化对象生成）。
- `scripts/modules/prompt-manager.js` —— 加载/渲染 Handlebars 提示模板。
- `mcp-server/src/core/direct-functions/*.js` —— 每个 MCP 能力一个薄封装（含错误码、silent mode、缓存）。

## State / Artifact management

- **单一事实源**：`.taskmaster/tasks/tasks.json`，按 tag 分桶，每个 tag 存 `{ tasks, metadata }`。所有命令读改写它，再可选地 `generate` 派生单任务文件（派生文件是"下游产物"，`generate` 会清孤儿文件）。
- **读写原子性**：`utils.js` 的 `writeJSON` 使用文件锁 `withFileLockSync` 保证"读-改-写"原子，并在多 tag 结构下用 `_rawTaggedData`/重读当前文件的方式避免覆盖其它 tag 的并发更新。
- **legacy 迁移**：`readJSON` 检测到根级 `tasks` 数组（非 tag 结构）时自动迁移为 `{ master: { tasks } }` 并回写。
- **ID 连续性**：`parse-prd-helpers.js` 的 `processTasks` 强制 PRD 生成的任务 ID 从 1 连续递增（`validateSequentialTaskIds`），再重映射到 `nextId` 起的连续 ID，并把依赖 ID 同步重映射、只保留指向更低 ID / 已存在任务的依赖（隐式保证有向无环 + 拓扑偏序）。
- **状态持久化**：`set-task-status.js` 读原始 tag 结构 → 逐 ID 调 `update-single-task-status.js` → 回写 → 重验依赖。子任务置 done 时会检查"父任务是否所有子任务都完成"并提示；父任务置 done 时级联把其所有子任务置 done。样本数据中任务还带 `previousStatus` 字段记录旧状态。
- **复杂度报告**：`.taskmaster/reports/task-complexity-report.json`（或 tag 特定路径），`{ meta, complexityAnalysis: [{ taskId, taskTitle, complexityScore, recommendedSubtasks, expansionPrompt, reasoning }] }`，支持增量合并（保留未重分析的条目）。
- **配置**：`.taskmaster/config.json`（models 三角色 + global），`.taskmaster/state.json` 亦有定义。

## Agent integration model

- **双通道**：CLI（`task-master` 二进制，Commander）与 MCP（FastMCP，工具名 `parse_prd`/`next_task` 等）。两者共享 `scripts/modules` 核心，MCP 侧通过 `direct-functions` 薄封装做入参校验与 JSON 结果归一。
- **工具分 tier 暴露**：`TASK_MASTER_TOOLS=core|standard|all` 控制 MCP 注册哪些工具，避免工具过多污染 Agent 上下文。
- **多 Agent 规则下发**：`.cursor/rules/`、`assets/AGENTS.md`、`assets/rules/`、`.kiro/steering/`、`src/profiles/`（含 `trae.js`，说明已考虑 Trae 集成）—— 用 `rule-transformer.js` 把一套规则转成不同 Agent 的本地格式。
- **AI provider 抽象**：`src/ai-providers/`（20 个 provider：anthropic/openai/perplexity/google/ollama/bedrock/azure/vertex/openrouter/xai/groq/groq/zai/lmstudio/claude-code/codex-cli/gemini-cli/grok-cli 等），角色分 `main`（生成任务）/`research`（Perplexity 调研）/`fallback`。`isApiKeySet`/`hasCodebaseAnalysis` 决定是否走 codebase 分析 provider。
- **Agent 工作流约定**（`assets/AGENTS.md`）：`next → show → 实现 → update-subtask 记日志 → set-status`，强调"不要手改 tasks.json，用命令操作"。

## Extensibility

- **Provider 可插拔**：新增 LLM 只需加 `src/ai-providers/` 一个类 + `supported-models.json` 条目。
- **提示模板可定制**：`src/prompts/*.json` 支持 variant（`parse-prd` 有 research/默认变体；`expand-task` 有 default/research/complexity-report 变体），`prompt-manager.js` 统一渲染。
- **Schema 驱动**：`src/schemas/registry.js` 的 `COMMAND_SCHEMAS` 把"AI 返回结构"与"Zod 校验"解耦，AI 响应统一走 `generateObjectService` 校验。
- **tag 多上下文**：一个 tasks.json 支持多个 tag（多上下文任务清单），有 add-tag/use-tag/copy-tag/rename-tag/move-task（含跨 tag 依赖校验）。
- **profile/规则转换**：新增 Agent 集成加 `src/profiles/*.js` 即可。
- **远程/团队存储（bridge）**：`expand-task.js` 等见 `tryExpandViaRemote` / `@tm/bridge` 导入，存在 API 存储模式（solo/team 双模式，`getOperatingMode`），本地文件之外还有远程存储路径（未在核心目录展开验证）。

## Licensing

**许可证：MIT License + "Commons Clause" License Condition v1.0**（非纯 MIT，实际是 source-available，非 OSI 认可的开源）。来源文件：`/Users/morton_cheung/Desktop/AI/SpecCraft/references/taskmaster/LICENSE`（已逐字阅读）。版权方：`Copyright (c) 2025 — Eyal Toledano, Ralph Khreish`。该文件定义 `License: MIT`，`Software: 仓库 claude-task-master 与 npm 包 task-master-ai 的全部文件`，`Licensor: Eyal Toledano, Ralph Khreish`。

**Commons Clause 附加限制**：不得"出售（Sell）本软件"，其中 Sell 定义为"把授予你的权利用于向第三方提供本软件（以收费或其它对价），作为某个产品或服务的一部分，且该产品或服务的价值全部或实质上来源于本软件的功能"。

仓库内还有 `docs/licensing.md` 与 `apps/docs/licensing.md`，明确列出：✅ 允许——任意用途使用（含商用）、修改、分发、**销售"基于 Task Master 构建的产品"**；❌ 禁止——**销售 Task Master 本身**、**将 Task Master 作为托管服务提供**、**基于 Task Master 制造竞争产品**。`apps/extension/LICENSE` 另有一份（VS Code 扩展，未逐字核验是否同文本）。

**对 SpecCraft 的直接结论：不适合直接复制源码。** MIT 部分允许修改/分发，但 Commons Clause 禁止把该软件本身或其功能作为商业产品/服务的价值核心出售——SpecCraft 若把 taskmaster 的任务管理源码直接搬进自有产品并对外销售，会直接踩线。**只能做算法级/设计级参考（重新实现），不能做源码级复制。**

## Components useful to SpecCraft

按"可复用设计价值"排序，均给出精确源路径：

1. **next-task 选择算法** —— `scripts/modules/task-manager/find-next-task.js`：**纯函数、零 I/O**。先选"in-progress 父任务的满足依赖的子任务"，否则选"依赖已满足的顶层任务"；排序键 = 优先级(high3/med2/low1) 降序 → 依赖数升序 → ID 升序；完成集同时含任务与子任务。这是"任务图 + 拓扑就绪判定 + 贪心选择"的最干净实现，可直接移植。
2. **依赖校验/修复逻辑** —— `scripts/modules/dependency-manager.js`：自依赖/缺失依赖/环依赖（`isCircularDependency` 递归 DFS、`findCycles` 递归栈判环）、修复三阶段（去重 → 去非法 → 断环 + 保证每任务至少一个无依赖子任务）。算法价值高，但文件耦合 `chalk/boxen/process.exit`，需抽纯函数。
3. **PRD 解析流水线设计** —— `scripts/modules/task-manager/parse-prd/parse-prd.js` + `parse-prd-helpers.js` + `src/prompts/parse-prd.json` + `src/schemas/parse-prd.js`：提示工程（Handlebars 模板）+ 严格 Zod schema + ID 重映射与"依赖只能指向更低 ID"的拓扑约束。是"LLM 输出结构化任务"的完整范式。
4. **复杂度评分设计** —— `scripts/modules/task-manager/analyze-task-complexity.js` + `src/prompts/analyze-complexity.json`：1–10 分 + `recommendedSubtasks` + `expansionPrompt` + `reasoning`，报告增量合并，阈值 5，高低分桶（高≥8）。可复用的是"复杂度→子任务数→展开提示"的闭环设计，而非其 AI 调用细节。
5. **状态机与父子级联** —— `scripts/modules/task-manager/update-single-task-status.js` + `src/constants/task-status.js`：状态枚举 + "父任务置 done 级联子任务 / 子任务全 done 提示父任务"的双向一致性逻辑。
6. **tag 化持久化 + 文件锁** —— `scripts/modules/utils.js` 的 `readJSON`/`writeJSON`：多上下文共存、legacy 自动迁移、`withFileLockSync` 原子写、`_rawTaggedData` 防多 tag 覆盖。设计可借鉴（实现较复杂，价值主要在"防并发丢失更新"）。

## Components not useful to SpecCraft

- `apps/extension/`（VS Code 扩展 webview/services）—— 与 SpecCraft 目标无关的 UI 工程。
- `apps/docs/`（MDX 文档站点）、`images/`、`assets/` 品牌物料 —— 运营资产。
- `.github/workflows/`（release/CI/metrics 等 15+ 工作流）与 `.github/scripts/` —— 项目自身发布流程。
- `mcp-server/src/custom-sdk/`（自建 MCP SDK 子集）—— 若用官方 `@modelcontextprotocol/sdk` 则不需要。
- `context/`（fastmcp/mcp-protocol 等抓取的参考文档）、`src/telemetry/sentry.js` —— 与功能无关或需剔除。
- `.taskmaster/tasks/tasks.json`（1.5MB 本项目自用历史任务）—— 仅作数据模型样本，无复用价值。
- 新旧两套并存（`mcp-server/` 旧 JS 与 `apps/cli`+`apps/mcp` 新 TS）造成的重复实现 —— 引入时应只取一套思路。

## Risks of integration

- **许可证硬约束（最高风险）**：MIT + Commons Clause 明确禁止把该软件作为产品价值核心出售/托管。SpecCraft 只能"重写算法"，**不得直接复制任何源码文件**；即便重写，也要避免照搬其提示模板原文与 `task-master`/`Task Master` 品牌命名。
- **核心逻辑与 CLI 强耦合**：`dependency-manager.js` 等大量使用 `process.exit(1)`、`console.log`、`boxen/chalk`，抽取为库需剥离这些副作用；否则只能整块搬（又受许可证限制）。
- **AI 调用深度绑定**：parse-prd / expand / analyze 的正确性依赖特定 provider 与提示模板文本；换 provider 或改提示会破坏"ID 连续、依赖只指向低 ID"等隐含契约（这些契约由提示而非代码强制，脆弱）。
- **隐式状态散落**：`previousStatus`、tag 解析、`_rawTaggedData`、legacy 迁移、git tag 自动切换（`checkAndAutoSwitchGitTagSync`）等隐性行为交织在 `utils.js`，复制局部逻辑易漏。
- **状态机不一致**：`src/constants/task-status.js` 只列 6 态（无 `blocked`），但 `analyze-task-complexity.js` 的 active 状态过滤包含 `'blocked'`，文档（AGENTS.md）也列出 `blocked`——状态集合在多处不一致。
- **过度工程部分**：tag 系统、team/API 远程存储（bridge）、17 个 Agent profile、44+ MCP 工具分层，对 SpecCraft 单项目场景多数是噪音。

## Recommendation

**整体路线：REFERENCE_ONLY，且不可源码复制（Commons Clause 禁止）。**

具体分项建议：

1. **直接重写并采用算法**（ADAPT，重新实现、不改许可证风险）：`find-next-task.js` 的"依赖就绪 + 优先级/依赖数/ID 排序"选择算法；`dependency-manager.js` 的环检测/自依赖/缺失依赖校验纯逻辑；`update-single-task-status.js` 的父子状态级联规则。这三者体量小、无 I/O 或 I/O 可剥离，重写成本低，是 SpecCraft 任务图/依赖引擎最该借鉴的部分。
2. **设计级参考**（REFERENCE_ONLY）：PRD→任务的结构化生成范式（Handlebars 提示 + 严格 Zod schema + ID 重映射与"依赖只指向低 ID"的拓扑约束）、复杂度评分→子任务数→展开提示的闭环、tag 化持久化与文件锁防并发丢失。作为 SpecCraft 自身"规格→任务"与"任务状态机"的设计蓝本，不照搬文本。
3. **不纳入**（REJECT）：VS Code 扩展、文档站点、自建 MCP SDK、团队/远程存储 bridge、17 个 Agent profile、多 tag 系统。
4. **命名与文案**：任何落地实现必须用 SpecCraft 自有命名与自有提示文本，避免与 `task-master`/`Task Master` 商标/品牌及 Commons Clause 约束冲突。

一句话：**取其"任务图 + 依赖拓扑 + 复杂度驱动拆解"的工程思想，用自有代码重写，不复制其源码与品牌。**
