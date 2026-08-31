# SpecCraft

SpecCraft 是一个 **Human-Directed AI Workflow System**（人主导的 AI 工作流系统）。

它把模糊想法逐步加工为：

> 清晰需求 → 调研结果 → 产品方案 → 甲方确认 → Agent 总施工方案 → 真实项目勘察 → 精确施工手册 → Agent 实施 → 验证 → 甲方验收 → 交接

## 核心理念

> **Owner decides what. SpecCraft designs how. Execution Agents build it.**

SpecCraft 不把主要产品思考下放给 Coding Agent。Coding Agent 应尽可能拿到已经设计完整、约束明确、可以直接执行的施工说明。

## 当前开发阶段

**v0.2 — Execution & Verification Runtime**

已实现（v0.1 → v0.2 累计）：

- 声明式 16 阶段 Workflow（`schemas/default-workflow.yaml`），
  阶段推进、门禁（gate）、`auto_complete` 全部由声明决定；
- `.speccraft` 文件优先工作现场：workflow / state / artifacts / runs，
  无数据库；
- Context Compiler：按 workflow dependency graph 编译上游上下文；
- Execution Run：`speccraft prepare` 把已批准的 Execution Manual 编译成
  可直接交给任意施工 Agent 的 Execution Package；
- Verification Runtime：`speccraft verify` 执行目标项目声明的验证命令，
  失败在同一 Run 内返工，直到 `verification = completed`；
- 不依赖任何特定 AI 厂商（Claude / Codex / Trae / OpenCode）。

尚未实现（后续版本）：Owner Acceptance 完整机制、Handoff 完整机制、
多 Agent 编排、SaaS 后端、Web 控制台、云同步等。

## CLI

```bash
speccraft init [projectRoot] [--force]     # 初始化工作现场
speccraft status                           # 阶段状态 + Active Run
speccraft next                             # 下一步引导（含 Execution 生命周期）
speccraft approve <stage> [--by <who>]     # Owner 批准（硬门禁）
speccraft artifact <stage>                 # 生成阶段 artifact 并推进
speccraft prepare [--adapter manual]       # 编译 Execution Package + 创建 Run
speccraft implement start [--run <id>]     # 显式开始施工
speccraft implement finish --report <path> # 显式结束施工（提交报告）
speccraft verify                           # 运行项目验证命令（PASS/FAIL）
speccraft validate                         # 状态/execution 一致性检查
```

## Execution 生命周期

```
READY_TO_IMPLEMENT
      ↓ speccraft prepare            （生成 context.md + agent-prompt.md）
PREPARED（run 创建，active_run 写入）
      ↓ speccraft implement start
IMPLEMENTATION = in_progress
      ↓ speccraft implement finish --report <path>
IMPLEMENTATION = completed → awaiting_verification
      ↓ speccraft verify
PASS → verification = completed      FAIL → 重开 implementation（同一 Run 返工）
```

关键原则：Git 有改动 / commit 存在 / 报告文件存在，都不代表施工完成。
只有显式命令能改变 Runtime State；验证用真实命令的 exit code 判断，
「修 bug 不产生新的 workflow stage」。

## 核心 Workflow

见 [docs/workflow/core-workflow.md](docs/workflow/core-workflow.md)。
架构决策见 [docs/decisions/](docs/decisions/)（含 ADR 0003 v0.2）。

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

v0.2 已实现 Workflow 声明式状态机、Commands、Skills 注入、Execution Run、
Verification Runtime 与一个 `manual` Adapter。尚未实现：Owner Acceptance、
Handoff、具体 Agent 平台（Claude / Codex / Trae 等）的 API 集成。

## License

根项目 License 尚未决定（计划开源，待 Owner 批准）。第三方许可证审计见 [docs/research/licensing-review.md](docs/research/licensing-review.md)。
