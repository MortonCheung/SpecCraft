# Component Matrix — 第三方能力矩阵

> Milestone 0 的最终 Artifact。
> 决策依据见 `docs/decisions/0001-third-party-integration-principles.md`，许可证事实见 `docs/research/licensing-review.md`。
>
> `Decision` 取值：`DIRECT_USE`（直接复用）/ `ADAPT`（改造）/ `INTEGRATE`（集成）/ `REFERENCE_ONLY`（只借思想）/ `REJECT`（不采用）。
>
> 所有 Source Path 均为相对各仓库根目录的真实路径（已核验）。Milestone 0 不实现，`SpecCraft Target` 为未来目标位置。

| Component | Source | Source Path | Purpose | SpecCraft Target | Decision | License | Dependencies | Adaptation Needed | Risk | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| writing-plans 计划生成方法论 | superpowers | skills/writing-plans/SKILL.md | 把 spec 转成低判断成本实施计划（Interfaces Consumes/Produces、No Placeholders、Global Constraints 逐字复制、Self-Review、2-5 分钟 TDD 步骤） | docs/workflow/ + 未来 templates/plan | ADAPT | MIT | 无 | 固化方法为计划输出 schema，文本重写 | 低 | 直接回答"如何把设计变成低判断成本计划" |
| brainstorming 需求澄清 | superpowers | skills/brainstorming/SKILL.md | 三路径（Spike/Bounded/Architectural）+ 硬批准门槛 | DISCOVERY/REQUIREMENT 阶段设计 | REFERENCE_ONLY | MIT | 无 | 自行实现 | 低 | 借鉴流程与门槛思想 |
| subagent-driven-development 编排 | superpowers | skills/subagent-driven-development/SKILL.md + scripts/{sdd-workspace,task-brief,review-package} + {implementer,task-reviewer,re-review}-prompt.md | 计划执行 + 两级审查 + ledger 工件管理 | 未来 IMPLEMENTATION 子 agent 编排（adapters/） | INTEGRATE | MIT | 无 | 以文件传递工件方式接入 | 中 | ledger 对抗 compaction 导致重复执行 |
| verification-before-completion | superpowers | skills/verification-before-completion/SKILL.md | "证据先于声称"完成门禁 | VERIFICATION 验收标准 | DIRECT_USE | MIT | 无 | 几乎无需改动（纯行为规则） | 低 | 无 harness 绑定 |
| executing-plans 执行纪律 | superpowers | skills/executing-plans/SKILL.md | 计划执行纪律 | 未来 IMPLEMENTATION 行为规则 | REFERENCE_ONLY | MIT | 无 | 自行实现 | 低 | — |
| systematic-debugging | superpowers | skills/systematic-debugging/SKILL.md | 系统性调试方法 | 未来 Debug 行为规则 | REFERENCE_ONLY | MIT | 无 | 自行实现 | 低 | — |
| test-driven-development | superpowers | skills/test-driven-development/SKILL.md | TDD 纪律 | 未来 VERIFICATION 行为规则 | REFERENCE_ONLY | MIT | 无 | 自行实现 | 低 | — |
| code-review（请求/接收） | superpowers | skills/{requesting-code-review,receiving-code-review}/SKILL.md | 代码审查流程 | 未来 Review 阶段 | REFERENCE_ONLY | MIT | 无 | 自行实现 | 低 | — |
| git-worktrees / 收尾分支 | superpowers | skills/{using-git-worktrees,finishing-a-development-branch}/SKILL.md | 多分支并行 + 分支收尾 | 未来 Git 工作流 | REFERENCE_ONLY | MIT | 无 | 自行实现 | 低 | — |
| dispatching-parallel-agents | superpowers | skills/dispatching-parallel-agents/SKILL.md | 并行 agent 派发 | 未来并行执行 | REFERENCE_ONLY | MIT | 无 | 自行实现 | 中 | SDD 内部明确禁止 subagent 再派发 subagent |
| harness bootstrap hooks | superpowers | hooks/session-start + .opencode/plugins/superpowers.js + .pi/extensions/superpowers.ts | 多 harness 启动注入 | 未来 adapters/ | REFERENCE_ONLY | MIT | 平台绑定 | 自行实现 | 中 | 与具体 Agent 平台强绑定 |
| 共享指令构建器 | ponytail | hooks/ponytail-instructions.js | 单一事实源 + 按强度模式过滤生成注入文本 | 未来 hooks/ 注入机制 | ADAPT | MIT | Node | 替换领域内容，保留机制 | 低 | — |
| 三层 lifecycle hook 注入链 | ponytail | hooks/claude-codex-hooks.json + ponytail-activate.js / ponytail-subagent.js / ponytail-mode-tracker.js | SessionStart/SubagentStart/UserPromptSubmit 注入 | 未来 hooks/ 行为规则自动注入 | ADAPT | MIT | Node + 宿主 hook 系统 | 重写宿主 hook 定义 | 中 | 解决"父上下文不传给子 agent"坑 |
| 宿主识别 + flag 状态 | ponytail | hooks/ponytail-runtime.js + ponytail-config.js | 宿主识别 + 分宿主输出 + 防误触停用 | 未来 adapters/ | ADAPT | MIT | Node | 纯函数部分可 DIRECT_USE | 低 | — |
| 规则副本一致性护栏 | ponytail | scripts/check-rule-copies.js | 多平台规则副本字节比对 | 未来 hooks/ 一致性检查 | ADAPT | MIT | Node | 复用模式 | 低 | — |
| 过度工程 tag 审查 | ponytail | skills/ponytail-review/SKILL.md + ponytail-audit/SKILL.md | 过度工程 tag 体系（delete/stdlib/native/yagni/shrink） | 未来 VERIFICATION/验收判据 | ADAPT | MIT | 无 | 替换 tag 领域 | 低 | 契合 SpecCraft 反过度工程原则 |
| 行为 gate 验证 | ponytail | benchmarks/behavior.yaml + behavior.js | probe 式行为 gate grader | 未来 VERIFICATION | ADAPT | MIT | Node | 复用模式 | 中 | 验证规则"真产生行为" |
| 平台可移植性方法论 | ponytail | docs/agent-portability.md + docs/platform-native.md | 跨平台注入方法论 | docs/ 参考 | REFERENCE_ONLY | MIT | 无 | — | 低 | — |
| 宿主专用适配器（20+） | ponytail | pi-extension/index.js、ponytail-mcp/、__init__.py（Hermes）等 | 各宿主专用适配 | 不纳入 | REJECT | MIT | 平台绑定 | — | 高 | 与 20+ 宿主强绑定，维护成本高 |
| Spec→Plan→Tasks→Implement 工件分层流水线 | spec-kit | templates/commands/{specify,plan,tasks,implement,analyze,checklist,clarify,converge}.md + templates/{spec,plan,tasks}-template.md + scripts/python/{setup_plan,setup_tasks,check_prerequisites,create_new_feature}.py | 工件分层 + 层间契约 | 未来 Workflow 工件模型 | ADAPT | MIT | Python + .specify/ 目录约定 | 用自有命名重写命令模板 | 中 | 状态指针 .specify/feature.json |
| 模板优先级栈解析器 | spec-kit | scripts/python/common.py（resolve_template / resolve_template_content） | override→preset→extension→core 模板解析 | 未来 templates/ 渲染引擎 | DIRECT_USE | MIT | Python | 几乎无需改动 | 低 | 纯函数 |
| 扩展 + Hook 生命周期模型 | spec-kit | extensions/EXTENSION-API-REFERENCE.md + extensions/*/extension.yml | extension manifest + hooks | 未来扩展机制 | REFERENCE_ONLY | MIT | 无 | 自行实现 | 中 | — |
| 差距收敛与一致性检测命令 | spec-kit | templates/commands/{converge,analyze}.md | 跨工件差距收敛 | 未来 DESIGN/VERIFICATION | ADAPT | MIT | 无 | 重写命令 | 低 | converge 为 append-only |
| Agent 集成抽象层 | spec-kit | src/specify_cli/integrations/base.py + manifest.py | manifest SHA-256 追踪 + 多格式命令渲染 | 未来 adapters/ | REFERENCE_ONLY | MIT | Python | 自行实现 | 中 | — |
| 40+ Agent 集成/认证/bundler/workflow engine | spec-kit | src/specify_cli/ 等 | 具体平台集成 | 不纳入 | REJECT | MIT | 大量 | — | 高 | 平台绑定严重 |
| 声明式工件定义 + 依赖图引擎 | openspec | src/core/artifact-graph/ + schemas/spec-driven/schema.yaml | 声明式 schema + DAG 拓扑排序 | 未来 Workflow Engine 工件定义层 | ADAPT | MIT | TypeScript/Node | 重定义工件集 | 中 | 不套其 proposal→specs→design→tasks |
| project context / rules 逐工件注入 | openspec | src/core/project-config.ts + config.yaml + artifact-graph/instruction-loader.ts | context/rules 注入与指令组装 | 未来上下文注入 | ADAPT | MIT | TypeScript | 复用结构 | 中 | 契合 SpecCraft"上下文完整"原则 |
| Markdown 需求解析器 | openspec | src/core/parsers/ | Requirement/Scenario/Delta 解析 | 未来 REQUIREMENT 解析 | REFERENCE_ONLY | MIT | TypeScript | 自行实现 | 中 | 语法与 OpenSpec 强绑定 |
| agent 契约（--json 输出） | openspec | src/commands/workflow/{status,instructions}.ts | 给 agent 的 --json 契约 | 未来 Agent Adapter 接口 | REFERENCE_ONLY | MIT | TypeScript | 自行实现 | 中 | — |
| change 生命周期 + delta 归档合并 | openspec | src/core/archive.ts + specs-apply.ts | fingerprint 防并发 + 归档 | 未来阶段产物落盘 | REFERENCE_ONLY | MIT | TypeScript | 自行实现 | 中 | — |
| OpenSpec 作为 persistence layer 直接采用 | openspec | 全仓 | 持久化层 | 不直接采用 | REJECT | MIT | TypeScript/Node + commander/@inquirer/ora/chalk | — | 高 | 目录硬编码、无审批门禁、AI 主导规划与 Rule 冲突 |
| spec-kernel 方法论 | bmad | src/bmm-skills/plan/bmad-spec/SKILL.md + assets/{spec-template,stories-schema}.md | spec 内核 + 需求/故事 ID 契约 | DESIGN/REQUIREMENT | REFERENCE_ONLY | MIT(+商标) | 无 | 自行实现 | 低 | 去商标化 |
| spine 架构方法论 | bmad | src/bmm-skills/plan/bmad-architecture/SKILL.md + assets/spine-template.md + references/reviewer-gate.md | 极简不变量架构 | DESIGN | REFERENCE_ONLY | MIT(+商标) | 无 | 自行实现 | 低 | 与"完整架构文档"预期有差异 |
| Discovery 方法（PRD） | bmad | src/bmm-skills/plan/bmad-prd/SKILL.md + assets/{prd-template,prd-validation-checklist}.md | PRD + 验证清单 | DISCOVERY/REQUIREMENT | REFERENCE_ONLY | MIT(+商标) | 无 | 自行实现 | 低 | — |
| memlog 追加式记忆日志 | bmad | src/scripts/memlog.py | 追加式记忆日志 | 未来 core/ 状态记录 | ADAPT | MIT(+商标) | Python | 移植去商标 | 低 | 脚本薄，可移植 |
| compile-epic-context 上下文编译交接 | bmad | src/bmm-skills/ship/bmad-build/compile-epic-context.md | 上下文编译交接 | 未来 SITE SURVEY/交接 | INTEGRATE | MIT(+商标) | 无 | 复用模式 | 低 | — |
| module-help.csv 依赖链声明 | bmad | module-help.csv | preceded-by/followed-by/required/phase 依赖链 | 未来 Workflow 阶段依赖声明 | INTEGRATE | MIT(+商标) | 无 | 复用格式 | 低 | 契合"不可静默跳过上游阶段" |
| agents/* persona 层 | bmad | agents/* | persona 皮肤 + 菜单 | 不纳入 | REJECT | MIT(+商标) | 无 | — | 高 | 与"不把产品思考下放给 Agent"哲学冲突 |
| bmad-party-mode | bmad | src/bmm-skills/（可选 core skill） | 多角色自动对话 | 不纳入 | REJECT | MIT(+商标) | 无 | — | 高 | 正是 SpecCraft 要避免的模式 |
| ship 层（build/code-review/walkthrough/qa） | bmad | src/bmm-skills/ship/* | 执行/审查 | 不纳入 | REJECT | MIT(+商标) | 无 | — | 中 | 与 superpowers 相关能力重叠 |
| next-task 选择算法 | taskmaster | scripts/modules/task-manager/find-next-task.js | 任务图 next-task 挑选 | 未来任务引擎 | ADAPT | MIT+Commons Clause | Node | 算法级重写（禁源码复制） | 高 | 受 Commons Clause 约束 |
| 依赖校验/修复 | taskmaster | scripts/modules/dependency-manager.js | 环/自依赖/缺失检测 | 未来任务引擎 | ADAPT | MIT+Commons Clause | Node | 算法级重写 | 高 | — |
| PRD→任务结构化生成范式 | taskmaster | scripts/modules/task-manager/parse-prd/* + src/prompts/parse-prd.json + src/schemas/parse-prd.js | PRD 解析 → 任务 + ID 重映射 | REQUIREMENT→EXECUTION MANUAL | REFERENCE_ONLY | MIT+Commons Clause | Node | 自行实现 | 中 | — |
| 复杂度评分 → 子任务数展开 | taskmaster | scripts/modules/task-manager/analyze-task-complexity.js + src/prompts/analyze-complexity.json | 复杂度评分闭环 | 未来任务拆解 | REFERENCE_ONLY | MIT+Commons Clause | Node | 自行实现 | 中 | — |
| 状态机 + 父子级联 | taskmaster | scripts/modules/task-manager/update-single-task-status.js + src/constants/task-status.js | 任务状态 + 父子级联 | 未来任务状态机 | ADAPT | MIT+Commons Clause | Node | 算法级重写 | 高 | 状态集合存在不一致（blocked） |
| taskmaster 源码整体 | taskmaster | 全仓 | 任务管理 | 不直接复制 | REJECT | MIT+Commons Clause | Node | — | 高 | Commons Clause 禁 Sell；只能借思想 |

---

## 汇总

### DIRECT_USE（2）

- superpowers `verification-before-completion` —— 完成门禁行为规则。
- spec-kit `common.py` 模板优先级栈解析器 —— 纯函数。

### ADAPT（核心候选，15）

superpowers：`writing-plans` 方法论。
ponytail：共享指令构建器、三层 hook 注入链、宿主识别、规则一致性护栏、过度工程审查、行为 gate。
spec-kit：工件分层流水线、差距收敛命令。
openspec：声明式工件定义 + 依赖图、context/rules 注入。
bmad：memlog 记忆日志。
taskmaster：next-task 算法、依赖校验、状态机（均需算法级重写）。

### INTEGRATE（3）

superpowers：subagent-driven-development 编排（文件传递方式）。
bmad：compile-epic-context 交接、module-help.csv 依赖链声明。

### REFERENCE_ONLY（19）

superpowers：brainstorming、executing-plans、systematic-debugging、TDD、code-review、git-worktrees、parallel-agents、harness hooks。
ponytail：平台可移植性方法论。
spec-kit：扩展/Hook 生命周期、Agent 集成抽象。
openspec：Markdown 解析器、agent 契约、change 生命周期。
bmad：spec-kernel、spine、Discovery/PRD。
taskmaster：PRD 解析范式、复杂度评分。

### REJECT（7）

ponytail：20+ 宿主专用适配器。
spec-kit：40+ Agent 集成/认证/bundler/workflow engine。
openspec：作为 persistence layer 直接采用。
bmad：agents/* persona 层、party-mode、ship 层。
taskmaster：源码整体复制。

## 关键冲突识别

1. **OpenSpec 直接作持久化层**与 SpecCraft 三条最高规则正面冲突（无 Owner 审批门禁、AI 主导规划、目录硬编码）。
2. **BMAD 多角色 persona/party-mode** 与 SpecCraft"不把主要产品思考下放给 Agent"的哲学冲突。
3. **taskmaster 的 Commons Clause** 与"直接复用源码"冲突，只能借算法思想重写。
4. **superpowers / spec-kit 的多 harness 适配层** 与"不绑定单一 Agent 平台"存在张力，只借抽象思想，不照搬。
5. **superpowers subagent-driven-development 与 dispatching-parallel-agents** 存在内部约定冲突（SDD 禁止 subagent 再派发），纳入时需明确取舍。
