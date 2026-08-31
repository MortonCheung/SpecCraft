# SpecCraft

SpecCraft 是一个 **Human-Directed AI Workflow System**（人主导的 AI 工作流系统）。

它把模糊想法逐步加工为：

> 清晰需求 → 调研结果 → 产品方案 → 甲方确认 → Agent 总施工方案 → 真实项目勘察 → 精确施工手册 → Agent 实施 → 验证 → 甲方验收 → 交接

## 核心理念

> **Owner decides what. SpecCraft designs how. Execution Agents build it.**

SpecCraft 不把主要产品思考下放给 Coding Agent。Coding Agent 应尽可能拿到已经设计完整、约束明确、可以直接执行的施工说明。

## 当前开发阶段

**v0.6 — Safe Parallel Execution & Worktree Isolation**

版本演进：

- v0.1 Workflow（16 阶段声明式）
- v0.2 Execution + Verification
- v0.3 Acceptance + Handoff
- v0.4 Agent Adapters + Hooks
- v0.5 Task Graph + Deterministic Orchestration
- v0.6 Safe Parallel Execution + Worktree Isolation

已实现（v0.1 → v0.6 累计）：

- 声明式 16 阶段 Workflow、`.speccraft` 文件优先工作现场（无数据库）；
- Context Compiler、Execution Run、Verification / Owner Acceptance / Handoff Runtime；
- **Adapter Runtime**：`manual` + `codex` / `claude` / `opencode` / `trae`
  CLI Adapter，连接用户本机已安装的 CLI Agent；
- **Dispatch Runtime**：append-only Dispatch Attempt，归一化执行证据；
- **Hook Runtime**：生命周期 before/after hook（blocking / non-rollback）；
- **Task Graph Runtime**：Execution Manual → 确定性 Task Graph，Task-aware
  dispatch / verification / rework / 顺序编排；
- **Safe Parallel Execution**：确定性 Wave 规划器 + Git Worktree 隔离并行
  执行 + Scope Audit + 运行时 Task Commit + 确定性集成（`execute --parallel`）；
- **Workspace Runtime**：Workspace Attempt / Wave Manifest / 工作区诊断
  （`workspaces list/show/clean`）；
- SpecCraft Core 不依赖任何特定 AI 厂商；Provider-specific 能力以可选
  CLI Adapter 存在。

尚未实现（后续版本）：异构多 Executor 路由（v0.7）、SaaS 后端、Web 控制台、
云同步、Provider SDK / API-key 管理。

## CLI

```bash
speccraft init [projectRoot] [--force]     # 初始化工作现场
speccraft status                           # 阶段 / Run / Dispatch / Acceptance / Handoff
speccraft next                             # 下一步引导（含 Task 级路线）
speccraft approve <stage> [--by <who>]     # Owner 批准（硬门禁）
speccraft artifact <stage>                 # 生成阶段 artifact 并推进
speccraft prepare [--adapter <id>]         # 编译 Execution Package + 创建 Run
speccraft implement start [--run <id>]     # 显式开始施工（manual 路线）
speccraft implement finish --report <path> # 显式结束施工（提交报告）
speccraft adapters list                    # 列出全部 adapter
speccraft adapters doctor [id]             # 本机 Provider 能力诊断
speccraft dispatch [--adapter <id>] [--run <id>] [--fresh-session] [--task <id>]
                                           # 调用本地 CLI Agent 自动施工
speccraft tasks compile|list|next|show|verify|reopen
                                           # Task Graph 管理
speccraft execute [--adapter <id>] [--parallel] [--max-parallel <n>]
                                           # 确定性执行整个 Task Graph（顺序或 worktree 并行）
speccraft workspaces list|show|clean      # 工作区诊断（worktree / branch / status）
speccraft verify                           # 运行项目验证命令（PASS/FAIL）
speccraft accept [--note|--file] [--by]    # Owner 验收通过
speccraft reject --reason <text>|--file    # Owner 拒绝（同 Run 返工）
speccraft handoff                          # 生成 Handoff Package
speccraft validate                         # 状态/execution/acceptance/dispatch/task 一致性检查
```

## Task Graph（v0.5）

一份已批准的 Execution Manual 可声明 `speccraft-task-graph` block，编译为
确定性的施工 Task，由 Runtime 做依赖管理、Task-aware dispatch、
Task-level verification、返工与顺序/并行调度。**默认 sequential
（单写者，不并行）**；`--parallel` 显式启用 Git Worktree 隔离并行
（确定性 Wave + 范围审计 + 运行时提交 + 确定性集成）。

详见 [docs/task-graph.md](docs/task-graph.md)、
[docs/task-orchestration.md](docs/task-orchestration.md)、
[docs/parallel-execution.md](docs/parallel-execution.md) 与
[docs/worktree-isolation.md](docs/worktree-isolation.md)。

## 完整生命周期

```
IDEA → ... → READY_TO_IMPLEMENT
      ↓ speccraft prepare（--adapter manual | codex | claude | opencode | trae）
      ↓ manual 路线：implement start / finish --report
      ↓ 自动路线：speccraft dispatch（调用本地 CLI Agent）
      ↓ speccraft verify
VERIFICATION PASS（机器验证通过）
      ↓
OWNER ACCEPTANCE（人类验收）
      ↓ accept / reject
      ↓
HANDOFF（确定性交接）
```

## Agent Adapters

SpecCraft Core 不依赖任何特定 AI 厂商；Provider-specific 能力以可选 CLI
Adapter 存在（只连接本机已安装的 CLI Agent，不管理 API Key / Token）。

```bash
speccraft prepare --adapter codex
speccraft dispatch            # 自动施工 + 归一化证据
```

详见 [docs/agent-adapters.md](docs/agent-adapters.md)。

## Hooks

生命周期 before/after hook（before 失败则主体不执行；after 失败不倒滚）：

```yaml
hooks:
  before_dispatch:
    - id: require-clean-worktree
      command: git diff --quiet
      timeout_seconds: 30
```

详见 [docs/hooks.md](docs/hooks.md)。

## Verification vs Acceptance

- **Verification** answers「does it work?」——机器验证（真实命令 exit code）。
- **Owner Acceptance** answers「is this what I wanted?」——人类决策
  （`accept` / `reject`）。

Verification PASS **不自动** Acceptance。必须显式 `speccraft accept`。

## Owner rejection loop

```bash
speccraft verify                              # PASS
speccraft reject --reason "Owner UX acceptance failed"
# → implementation 重开（同一 Run，不建新 Stage / 新 Run）
# Agent 继续编辑同一 Run
speccraft implement finish --report ./agent-report-2.md
speccraft verify                              # 新 verification attempt
speccraft accept
speccraft handoff
```

## Handoff Package

```bash
speccraft handoff   # 生成 .speccraft/handoffs/handoff-001/
```

包含 `HANDOFF.md` / `context.md` / `decisions.md` / `execution-history.md` /
`task-history.md` / `verification-history.md` / `acceptance-history.md` /
`workspace-history.md`（并行 route）/ `manifest.yaml`。
确定性模板生成（不调用 AI），幂等（重复 handoff 不产生新包）。

## 核心 Workflow

见 [docs/workflow/core-workflow.md](docs/workflow/core-workflow.md)。
架构决策见 [docs/decisions/](docs/decisions/)（ADR 0002/0003/0004/0005/0006/0007/0008）。

## Inspirations / Research Targets

调研对象（位于 `references/`，仅作研究材料，不并入本项目源码）：

- obra/superpowers
- DietrichGebert/ponytail
- github/spec-kit
- Fission-AI/OpenSpec
- bmad-code-org/BMAD-METHOD
- eyaltoledano/claude-task-master

## 状态声明

本仓库当前 **未达到 Production Ready**。

v0.6 已实现 Workflow 声明式状态机、Commands、Skills 注入、Execution Run、
Verification / Owner Acceptance / Handoff Runtime、Adapter Runtime
（manual + codex/claude/opencode/trae CLI Adapter）、Dispatch Runtime、
Hook Runtime、Task Graph + 确定性顺序/并行编排（Git Worktree 隔离 +
Scope Audit + 运行时提交 + 确定性集成）。尚未实现：异构多 Executor
路由（v0.7）、SaaS 后端、Web 控制台、云同步、Provider SDK / API-key 管理。

## License

根项目 License 尚未决定（计划开源，待 Owner 批准）。第三方许可证审计见 [docs/research/licensing-review.md](docs/research/licensing-review.md)。
