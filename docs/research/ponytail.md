# Project

- 仓库：`DietrichGebert/ponytail`（本地 clone 于 `references/ponytail`）
- 版本：`4.9.0`（见 `package.json`、`.claude-plugin/plugin.json` 等多处一致）
- 作者：Dietrich Gebert
- 定位：一个「懒惰资深开发者模式」（lazy senior dev mode）的 Agent 行为规则分发项目。核心资产是一段行为规则文本（一段 Prompt），外加一套把它注入到 20+ 个 AI Agent 平台工作过程的机制。
- 一句话本质：把「写代码前先问自己 7 个问题（是否该建 → 代码库是否已有 → 标准库 → 原生平台能力 → 已装依赖 → 能否一行 → 才写最小实现）」这条行为阶梯，作为 always-on 上下文自动植入 Agent，而不是让用户每次手动粘贴 Prompt。

## What it solves

- 解决 Agent（尤其 Claude Code / Codex 等 coding agent）过度工程问题：写过多抽象、引无谓依赖、造 boilerplate、写 50 行替代 1 行。
- 提供一种「行为规则（Prompt）跨平台分发」的通用做法：一套规则文本，通过薄适配层（hook / plugin API / instruction-only 三种层级）投放到不同 Agent 宿主，且保证各宿主读到的是同一份规则。
- 提供「懒 ≠ 随便」的安全护栏：规则明确列出「绝不能简化掉」的事项（信任边界输入校验、防数据丢失的错误处理、安全、可访问性、硬件校准、非平凡逻辑留一个可运行检查），并配 benchmark 验证这些护栏确实生效。
- 附带 self-量化：`benchmarks/` 用真实 Claude Code 会话（FastAPI+React 开源仓库、12 个 feature ticket、n=4）测出相对无技能基线 `LOC -54% / tokens -22% / cost -20% / time -27% / safe 100%`。

## Repository architecture

顶层是一个「单一事实源 + 多宿主薄 adapter」结构：

- `skills/` —— 行为规则的事实源。6 个子目录，每个含一个 `SKILL.md`（带 YAML frontmatter：`name` + `description`，`ponytail` 主技能额外含 `argument-hint`、`license`）：
  - `ponytail/`（主规则，最完整，含 intensity 等级表 + worked examples）
  - `ponytail-review/`（对 diff 做过度工程审查）
  - `ponytail-audit/`（全仓过度工程审计）
  - `ponytail-debt/`（收集 `ponytail:` 注释成债务台账）
  - `ponytail-gain/`（展示 benchmark 记分板）
  - `ponytail-help/`（命令速查）
- `AGENTS.md` —— 与主规则内容等价的「压缩版」always-on 规则（无 intensity 表、无 examples），是 instruction-only 宿主的通用入口。
- `hooks/` —— 运行时机制（Node.js，CommonJS），本仓库真正的「自动注入」核心：
  - `ponytail-activate.js`（SessionStart 激活 + 注入）
  - `ponytail-subagent.js`（SubagentStart 注入子 agent）
  - `ponytail-mode-tracker.js`（UserPromptSubmit 解析 `/ponytail` 命令、切换模式）
  - `ponytail-instructions.js`（共享指令构建器，读 SKILL.md 并按模式过滤）
  - `ponytail-config.js`（模式解析、默认值、停用判定、路径安全校验）
  - `ponytail-runtime.js`（宿主识别 + 状态 flag 读写 + 输出格式适配）
  - `claude-codex-hooks.json` / `copilot-hooks.json` / `qoder-hooks.json`（hook 注册清单）
  - `ponytail-statusline.sh` / `.ps1`（状态栏徽标）
- 各宿主适配文件（散落在根目录与隐藏目录）：
  - `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、`.qoder-plugin/plugin.json`、`.github/plugin/plugin.json`、`.devin-plugin/plugin.json`、`.grok-plugin/marketplace.json`、`plugin.json`（Grok 根 manifest）、`plugin.yaml`（Hermes）、`gemini-extension.json`（Gemini/Antigravity）
  - `.opencode/plugins/ponytail.mjs` + `ponytail-frontmatter.cjs`（OpenCode server plugin）、`.opencode/command/*.md`
  - `pi-extension/index.js`（pi harness 扩展）
  - `ponytail-mcp/`（独立 MCP server 子包）
  - `__init__.py`（Hermes 原生插件，Python）
  - 规则文本副本：`.cursor/rules/ponytail.mdc`、`.windsurf/rules/ponytail.md`、`.clinerules/ponytail.md`、`.agents/rules/ponytail.md`、`.qoder/rules/ponytail.md`、`.github/copilot-instructions.md`、`.kiro/steering/ponytail.md`、`.openclaw/skills/*`（生成物）
- `commands/` —— `*.toml` 斜杠命令（`description` + `prompt`，模板变量 `{{args}}`），6 个命令。
- `scripts/` —— `check-rule-copies.js`（规则一致性护栏）、`build-openclaw-skills.js`、`check-versions.js`、`publish-openclaw-skills.js`、`uninstall.js`。
- `benchmarks/` —— promptfoo 评测配置、arms、grader（`behavior.js`、`correctness.js`、`loc.js`）、结果报告。
- `tests/` —— 大量 `node --test` 单元测试（hook 逻辑、grader、各插件 manifest、命令等）。
- `docs/` —— `agent-portability.md`（多宿主映射表）、`platform-native.md`（平台原生能力对照表）。
- `examples/` —— benchmark 的 before/after 逐字输出示例。
- `assets/`、`benchmarks/results/`、多语言 `README.*.md`。

## Runtime architecture

运行时本质是「无状态小脚本 + 一个 flag 文件」，没有服务、没有数据库：

1. 模式状态用一个 flag 文件持久化：文件名 `.ponytail-active`，内容即模式名（`lite`/`full`/`ultra`/`off`）。位置随宿主变化：Claude `$CLAUDE_CONFIG_DIR/.ponytail-active`（默认 `~/.claude`）；Codex `$PLUGIN_DATA`；Qoder `~/.qoder`；OpenCode 用 XDG config 下 `opencode/.ponytail-active`。
2. 默认模式解析顺序（`ponytail-config.js` 的 `getDefaultMode()`）：环境变量 `PONYTAIL_DEFAULT_MODE` > 配置文件 `~/.config/ponytail/config.json` 的 `defaultMode` > `full`。`review` 被排除在默认值之外（只能是会话级）。
3. 宿主识别靠环境变量：`COPILOT_PLUGIN_DATA` / 含 `.vscode/agent-plugins` 的 `CLAUDE_PLUGIN_ROOT` → Copilot；`PLUGIN_DATA` → Codex；`QODER_SESSION_ID` → Qoder；否则按原生 Claude 处理（`ponytail-runtime.js`）。
4. 输出格式按宿主分叉（`writeHookOutput()`）：Copilot 只在 SessionStart 输出 `{additionalContext}`；Codex 输出 `{systemMessage, hookSpecificOutput}`；Qoder 输出 `{hookSpecificOutput}`；原生 Claude 的 SubagentStart 用 `hookSpecificOutput` JSON，SessionStart 直接 stdout 文本。
5. 所有 hook 都是「best-effort、绝不阻塞会话」：任何异常吞掉、stdin 无 EOF 时用 `setTimeout(...,1000).unref()` 兜底退出（为规避 Windows PowerShell 包装吞 stdin 导致挂死的问题 #443）。

## Important Skills

（全部位于 `skills/<name>/SKILL.md`，带 frontmatter）

- `ponytail`（核心）：完整的懒惰资深开发者规则。定义「阶梯」7 级、强度三档（lite/full/ultra）、输出格式（code first + 最多三行「跳过什么、何时再加」）、「何时不能懒」清单、以及 `ponytail:` 注释约定。是运行时注入的事实源。
- `ponytail-review`：只针对「过度工程」的 diff 审查，五类 tag 体系（见下），输出一行一条 `L<line>: <tag> <what>. <replacement>.`，结尾 `net: -<N> lines possible.`，无可删则 `Lean already. Ship.`。明确把正确性/安全/性能 bug 划出范围。
- `ponytail-audit`：`ponytail-review` 的全仓版本，按「削减最大优先」排序。
- `ponytail-debt`：扫描 `ponytail:` 注释，收集成台账；对「没有命名 upgrade path」的注释打 `no-trigger` 标记（识别会悄悄腐烂的技术债）。
- `ponytail-gain` / `ponytail-help`：记分板与命令速查，一次性展示类。

## Important Commands

- `/ponytail [lite|full|ultra|off]`（无参数报告当前模式；`default <mode>` 持久化到配置，可跨会话）
- `/ponytail-review`、`/ponytail-audit`、`/ponytail-debt`、`/ponytail-gain`、`/ponytail-help`
- 定义文件：`commands/*.toml`（`description` + `prompt`，`{{args}}` 模板）；OpenCode 用 `.opencode/command/*.md`（frontmatter `description` + `$ARGUMENTS` 模板）；Codex 下技能用 `@` 前缀（`@ponytail-review`）。
- 模式切换命令由 `ponytail-mode-tracker.js`（UserPromptSubmit hook）解析：正则 `/^[/@$]ponytail/`，支持 `/ponytail`、`/ponytail:ponytail` 等命名空间变体；`/ponytail-review` 映射为 `review` 模式。
- 停用方式：`/ponytail off`，或整句「stop ponytail」/「normal mode」——判定用 `isDeactivationCommand()`，只匹配「整条消息就是这句命令」（忽略大小写与末尾标点），避免「add a normal mode toggle」这类普通请求误触发。

## Important Hooks

- `claude-codex-hooks.json` 注册三个 lifecycle hook（Claude Code 与 Codex 共用）：
  - `SessionStart`（matcher `startup|resume|clear|compact`）→ `ponytail-activate.js`
  - `SubagentStart` → `ponytail-subagent.js`
  - `UserPromptSubmit` → `ponytail-mode-tracker.js`
- `copilot-hooks.json`（Copilot CLI）：`sessionStart` + `userPromptSubmitted`。
- `qoder-hooks.json`（模板，需手工复制进 `.qoder/settings.json` 并替换 `PONYTAIL_DIR`）：`UserPromptSubmit` + `PreToolUse`（matcher `task|Task` → 注入子 agent）。
- OpenCode 不用 hook 文件，用 plugin API 的 `experimental.chat.system.transform` 直接改 system prompt。
- Hermes 用 `pre_llm_call` + `pre_gateway_dispatch`（见 `plugin.yaml` 的 `provides_hooks`，实现于 `__init__.py`）。
- pi 用 `before_agent_start` 事件改 `systemPrompt`。
- 关键设计：SessionStart 注入的上下文只作用于父线程，不传递给子 agent，所以必须有 `SubagentStart`/`PreToolUse` 单独再注入一次（issue #252）。子 agent 注入可通过 `PONYTAIL_SUBAGENT_MATCHER` 正则按 `agent_type` 选择性开关。

## Important Templates

- `skills/ponytail/SKILL.md` 的 frontmatter 是技能定义的模板范式：`name` / `description`（含触发词清单）/ `argument-hint` / `license`。
- `commands/*.toml` 是斜杠命令模板范式：`description` + `prompt`（`{{args}}`）。
- `hooks/qoder-hooks.json` 是「需要用户手工落地」的 hook 模板范式（`_comment` 说明复制目标与替换占位符）。
- `.codex-plugin/plugin.json` 的 `interface` 字段是 Codex 插件 marketplace 元数据范式（displayName、capabilities、defaultPrompt、brandColor、icon）。
- `examples/*.md` 是 before/after 宣传模板（逐字模型输出对比），非功能必需。

## Important Scripts

- `scripts/check-rule-copies.js`：规则一致性护栏。对 7 份压缩副本做「去掉各自 frontmatter 后与 AGENTS.md 字节级相等」比对；对 `skills/ponytail/SKILL.md` 与 `AGENTS.md` 做「关键规则不变量（INVARIANTS，如 `in this codebase`、`ONE runnable check`、四条安全 carve-out 短语）都必须逐字存在」的 canary 断言。改动规则措辞会触发失败，提醒同步到所有副本。
- `scripts/build-openclaw-skills.js`：从 `skills/` 生成 `.openclaw/skills/`（生成物，测试套件会校验是否过期）。
- `scripts/publish-openclaw-skills.js`、`check-versions.js`、`uninstall.js`：发布/版本核对/清理（清理 plugin 目录外残留的 flag 文件与 statusLine 配置）。

## State / Artifact management

- 运行时状态极简：一个 `.ponytail-active` flag 文件（内容 = 模式名）。无 DB、无内存态（Hermes 的 `_current_mode` 是进程内变量例外）。
- 配置：`~/.config/ponytail/config.json`（`defaultMode`、`quietStartup`、`hideStatus`），可选。
- 状态写入点：`ponytail-activate.js`（会话开始写默认模式）、`ponytail-mode-tracker.js`（命令切换时改写）、`ponytail-runtime.js` 的 `setMode/clearMode`。
- 遗留产物（卸载时由 `scripts/uninstall.js` 清理）：flag 文件、config.json、`~/.claude/settings.json` 里的 statusLine 条目（仅当指向 ponytail 自己的脚本才删）。
- 一致性产物：`check-rule-copies.js` 强制「所有副本与 AGENTS.md 同步」，防止多宿主规则文本漂移。

## Agent integration model

这是本项目的核心价值所在，分三层注入：

1. **Hook 层（真正的自动注入，无需用户动作）**：Claude Code / Codex 通过 lifecycle hook 在 `SessionStart` 把规则写入会话上下文、在 `SubagentStart` 写入子 agent、在 `UserPromptSubmit` 切换模式。注入形式是 `ponytail-activate.js` 把 `getPonytailInstructions(mode)` 的结果作为 stdout 输出（`additionalContext` / `hookSpecificOutput`），由宿主并入上下文。
2. **Plugin API 层**：宿主提供「每轮改写 system prompt」的原生 API 时直接用它——OpenCode 的 `experimental.chat.system.transform`、pi 的 `before_agent_start`、Hermes 的 `pre_llm_call`。
3. **Instruction-only 层（被动，但仍是平台自动加载而非用户粘贴）**：对不支持 hook 的宿主（Cursor/Windsurf/Cline/Copilot/Kiro/Zed/Junie/Amp/Jules 等），把规则文本放到该平台的约定路径（`.cursor/rules/`、`.clinerules/`、`.github/copilot-instructions.md`、`AGENTS.md` 等），由平台自行作为 always-on context 加载。

**注入文本的生成与形式**（`hooks/ponytail-instructions.js`）：
- 单一事实源是 `skills/ponytail/SKILL.md`；`getPonytailInstructions(mode)` 读取它、去掉 frontmatter、按当前模式用 `filterSkillBodyForMode()` 过滤（只保留当前强度对应的 intensity 表行与 worked example 行，其余规则行原样保留），前面拼 `PONYTAIL MODE ACTIVE — level: <mode>` 头。
- 因此同一段规则在 Claude/Codex/pi/OpenCode/MCP 各宿主产出一致的文本；只有 SKILL.md 读不到时才退回内置的 `getFallbackInstructions()` 硬编码文本。
- 关键约束：Hook 输出必须走宿主约定的 JSON 壳（`hookSpecificOutput.additionalContext` 等），否则上下文会被丢弃——`ponytail-runtime.js` 的 `writeHookOutput()` 专门处理这一点。

## Extensibility

- 新增宿主 = 增加一个薄 adapter：宿主支持 skills/hooks → 指向现有 `skills/` 与 `hooks/`；宿主只支持 project instructions → 复制规则文本并与 `AGENTS.md` 对齐（`docs/agent-portability.md` 的「Adapter Rule」明确此原则）。
- 规则内容演进靠 `check-rule-copies.js` 兜底一致性；新增「能力对照」类知识可往 `docs/platform-native.md` 追加（纯静态参考表）。
- MCP 分发是独立子包 `ponytail-mcp/`（`@modelcontextprotocol/sdk` + `zod`），暴露一个 prompt `ponytail` 和一个只读 tool `ponytail_instructions`，供「注入点只有 prompt 菜单」的宿主使用；作者明确说明 MCP 无法做到「每轮自动注入」，故只是干净备选而非主路径。
- 定制点：`PONYTAIL_SUBAGENT_MATCHER`（按 agent_type 选子 agent 注入范围）、`PONYTAIL_DEFAULT_MODE`、`hideStatus`/`quietStartup`、`CLAUDE_CONFIG_DIR`。

## Licensing

- 许可证：**MIT License**（来源文件：`/Users/morton_cheung/Desktop/AI/SpecCraft/references/ponytail/LICENSE`，版权行 `Copyright (c) 2026 DietrichGebert`）。
- 各子包与 manifest 的 `license` 字段（`package.json`、`ponytail-mcp/package.json`、`.codex-plugin/plugin.json`、`.qoder-plugin/plugin.json`、`.github/plugin/plugin.json`、`.devin-plugin/plugin.json`、`skills/ponytail/SKILL.md` frontmatter）均为 `MIT`，与根 LICENSE 一致。
- `ponytail-mcp/` 依赖 `@modelcontextprotocol/sdk`（MIT）与 `zod`（MIT）。
- 未发现 COPYING / LICENSE.md 等其它许可证文件；未发现非 MIT 的许可证声明。

## Components useful to SpecCraft

按对 SpecCraft（构建「人主导的 AI 工作流系统」，未来要自建 Commands / Hooks / Skills / Agent Adapter / 平台集成）的可复用度排序：

1. **共享指令构建器 + 模式过滤**：`hooks/ponytail-instructions.js`（`getPonytailInstructions` / `filterSkillBodyForMode` / `getFallbackInstructions`）。这是「单一事实源（SKILL.md）→ 按模式过滤 → 注入文本」的转换核心，SpecCraft 未来让「施工手册按约束裁剪后注入 Agent」可直接套用同一思路。
2. **lifecycle hook 注入链**：`hooks/claude-codex-hooks.json` + `hooks/ponytail-activate.js` + `hooks/ponytail-subagent.js` + `hooks/ponytail-mode-tracker.js`。这是「把行为规则自动注入 Agent 工作过程（而非用户粘贴）」的现成实现范式，含「父线程上下文不传递 → 必须再注入子 agent」这一关键坑点及其解法。
3. **宿主识别 + 状态 + 输出格式适配**：`hooks/ponytail-runtime.js` + `hooks/ponytail-config.js`（`writeHookOutput` 分宿主 JSON 壳、flag 文件状态、`getDefaultMode` 多级解析、`isDeactivationCommand` 防误触、`isShellSafe` allowlist）。
4. **复杂度护栏 tag 体系与审查技能**：`skills/ponytail-review/SKILL.md` + `skills/ponytail-audit/SKILL.md`（`delete/stdlib/native/yagni/shrink` 五类 tag、一行一条、`net: -N lines` 收尾、明确边界）。这是 SpecCraft「验证/验收」环节可直接借鉴的「过度工程」判据。
5. **债务台账技能**：`skills/ponytail-debt/SKILL.md`（`ponytail:` 注释约定 + 收债 + `no-trigger` 腐化标记）。对应 SpecCraft 的「交接/追踪」环节，可复用「用注释标记 deliberate simplification 并定期回收」的做法。
6. **规则一致性护栏**：`scripts/check-rule-copies.js`（副本字节比对 + INVARIANTS canary）。SpecCraft 未来维护多平台规则副本时的必备工具模式。
7. **行为 gate 验证**：`benchmarks/behavior.yaml` + `benchmarks/behavior.js`（用 3 个 probe 验证「规则真的产生行为」而非只携带文本；grader 本身有单元测试）。这是「验证规则注入是否真生效」的轻量方法。
8. **可移植性映射文档**：`docs/agent-portability.md`（宿主 → 文件映射表 + Adapter Rule）。作为 SpecCraft 设计多平台 adapter 的方法论参考。
9. **现有能力对照表**：`docs/platform-native.md`（「你以为要装包 vs 平台自带」对照表，覆盖 HTML/CSS/JS/Swift/Node/Python/DB）。可作为 SpecCraft 的「existing capability discovery」静态参考数据。

## Components not useful to SpecCraft

- 规则正文本身（`skills/ponytail/SKILL.md` 的「懒惰资深开发者」人设与阶梯）——领域不同（SpecCraft 是需求→施工手册工作流，非「写最少代码」），内容不直接适用，仅结构与写法可借鉴。
- benchmark 数据与报告（`benchmarks/results/*.md`、`assets/*.svg`、`examples/*.md` 的 before/after 宣传）——面向 Ponytail 自身量化与营销，对 SpecCraft 无工程价值。
- 各宿主 marketplace/install 元数据（`.grok-plugin/marketplace.json`、`.devin-plugin/plugin.json`、多语言 README、FUNDING.yml、waitlist banner）——宿主专用清单与推广材料。
- 状态栏徽标脚本（`ponytail-statusline.sh/.ps1`）——纯展示，SpecCraft 无需。
- `ponytail-gain` 技能（记分板展示）——一次性展示类，无复用价值。
- `__init__.py`（Hermes 专用）与 `pi-extension/index.js` 里与宿主 UI（setStatus/notify/主题）耦合的部分——宿主专用。

## Risks of integration

- **MIT 许可风险低**：可直接复用/改造，只需保留版权与许可声明；无 copyleft 传染。
- **版本漂移**：仓库同时存在多份规则副本与多宿主 manifest，依赖 `check-rule-copies.js` 兜底；若 SpecCraft 引入其机制，必须保留同等一致性护栏，否则副本会静默漂移。
- **对宿主 API 的脆弱依赖**：注入依赖非公开/实验性 API（如 OpenCode 的 `experimental.chat.system.transform`、Claude/Codex 的 `hookSpecificOutput` JSON 壳、`CLAUDE_PLUGIN_ROOT` 等环境变量约定），且代码里多处 `try/catch` 静默降级——说明这些契约并不稳定，集成时需逐宿主实测。
- **平台耦合面广**：为 20+ 宿主维护薄 adapter 是持续成本；SpecCraft 若只面向少数目标平台（如 Claude/Codex/Trae），不应复制全部 adapter，只需抽取三层注入模型中的前两层。
- **状态管理极简化的副作用**：flag 文件方案在多会话/并发下无锁、非原子（代码里用 `ponytail:` 注释自认此点），对 SpecCraft 的「状态机」需求而言过于简陋，只适合做参考下限，不适合直接作为状态层。
- **「现有能力发现」是纯 Prompt 驱动**：Ponytail 没有代码化的能力发现（无索引、无工具），全靠规则引导 Agent 在写代码前自行搜索，加上一份静态对照表 `docs/platform-native.md`。SpecCraft 若期望更强的「现有能力发现」，需自行补机制，Ponytail 只能提供「Prompt 引导 + 静态表」这一下限。

## Recommendation

- **结论：REFERENCE / ADAPT 级别采用，不做 DIRECT_USE 的整仓并入。** Ponytail 的核心价值不在规则内容，而在「单一事实源 + 三层注入 + 薄 adapter + 一致性护栏 + 行为 gate 验证」这一套工程架构。
- SpecCraft 最值得 ADAPT 的三个机制（按优先级）：
  1. **注入架构**：`hooks/ponytail-instructions.js` 的「单一事实源 → 模式过滤 → 注入文本」+ `hooks/claude-codex-hooks.json` 的三 hook 注入链（SessionStart / SubagentStart / UserPromptSubmit）+ `hooks/ponytail-runtime.js` 的分宿主输出壳。这是「把行为规则自动注入 Agent 工作过程而非让用户粘贴」的直接答案。
  2. **复杂度护栏**：`ponytail-review`/`ponytail-audit` 的 `delete/stdlib/native/yagni/shrink` tag 体系 + `ponytail-debt` 的 `ponytail:` 注释回收约定，可作为 SpecCraft 验证/验收环节的判据来源。
  3. **一致性护栏 + 行为验证**：`scripts/check-rule-copies.js` 的副本比对 + INVARIANTS canary，以及 `benchmarks/behavior.js` 的 probe 式 grader——保证多平台规则副本不漂移、且规则「真的改变行为」。
- 建议把上述机制抽象为 SpecCraft 自己的「施工手册注入层」，而非复制 Ponytail 的宿主专用适配器；Ponytail 的状态管理（flag 文件）仅作极简参考，SpecCraft 的工作流状态机需另建。
