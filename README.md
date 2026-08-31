# SpecCraft

SpecCraft 是一个 **Human-Directed AI Workflow System**（人主导的 AI 工作流系统）。

它把模糊想法逐步加工为：

> 清晰需求 → 调研结果 → 产品方案 → 甲方确认 → Agent 总施工方案 → 真实项目勘察 → 精确施工手册 → Agent 实施 → 验证 → 甲方验收 → 交接

## 核心理念

> **Owner decides what. SpecCraft designs how. Execution Agents build it.**

SpecCraft 不把主要产品思考下放给 Coding Agent。Coding Agent 应尽可能拿到已经设计完整、约束明确、可以直接执行的施工说明。

## 当前开发阶段

**v0.3 — Acceptance & Handoff Runtime**

已实现（v0.1 → v0.3 累计）：

- 声明式 16 阶段 Workflow（`schemas/default-workflow.yaml`），
  阶段推进、门禁（gate）、`auto_complete` 全部由声明决定；
- `.speccraft` 文件优先工作现场：workflow / state / artifacts / runs /
  handoffs，无数据库；
- Context Compiler：按 workflow dependency graph 编译上游上下文；
- Execution Run：`speccraft prepare` 把已批准的 Execution Manual 编译成
  可直接交给任意施工 Agent 的 Execution Package；
- Verification Runtime：`speccraft verify` 执行目标项目声明的验证命令；
- Owner Acceptance：`speccraft accept` / `speccraft reject`（人类验收权威，
  与机器验证严格区分）；
- Handoff Runtime：`speccraft handoff` 确定性编译可交接的 Handoff Package；
- 不依赖任何特定 AI 厂商（Claude / Codex / Trae / OpenCode）。

尚未实现（后续版本）：多 Agent 编排、SaaS 后端、Web 控制台、云同步、
具体 Agent 平台 API 集成等。

## CLI

```bash
speccraft init [projectRoot] [--force]     # 初始化工作现场
speccraft status                           # 阶段 / Run / Acceptance / Handoff
speccraft next                             # 下一步引导（含 Acceptance 生命周期）
speccraft approve <stage> [--by <who>]     # Owner 批准（硬门禁）
speccraft artifact <stage>                 # 生成阶段 artifact 并推进
speccraft prepare [--adapter manual]       # 编译 Execution Package + 创建 Run
speccraft implement start [--run <id>]     # 显式开始施工
speccraft implement finish --report <path> # 显式结束施工（提交报告）
speccraft verify                           # 运行项目验证命令（PASS/FAIL）
speccraft accept [--note|--file] [--by]    # Owner 验收通过
speccraft reject --reason <text>|--file    # Owner 拒绝（同 Run 返工）
speccraft handoff                          # 生成 Handoff Package
speccraft validate                         # 状态/execution/acceptance 一致性检查
```

## 完整生命周期

```
IDEA → ... → READY_TO_IMPLEMENT
      ↓ speccraft prepare
      ↓ speccraft implement start / finish --report
      ↓ speccraft verify
VERIFICATION PASS（机器验证通过）
      ↓
OWNER ACCEPTANCE（人类验收）
      ↓ accept / reject
      ↓
HANDOFF（确定性交接）
```

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
`verification-history.md` / `acceptance-history.md` / `manifest.yaml`。
确定性模板生成（不调用 AI），幂等（重复 handoff 不产生新包）。

## 核心 Workflow

见 [docs/workflow/core-workflow.md](docs/workflow/core-workflow.md)。
架构决策见 [docs/decisions/](docs/decisions/)（ADR 0002/0003/0004）。

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

v0.3 已实现 Workflow 声明式状态机、Commands、Skills 注入、Execution Run、
Verification Runtime、Owner Acceptance、Handoff Runtime 与一个 `manual`
Adapter。尚未实现：多 Agent 编排、具体 Agent 平台（Claude / Codex / Trae
等）的 API 集成、SaaS 后端、Web 控制台、云同步。

## License

根项目 License 尚未决定（计划开源，待 Owner 批准）。第三方许可证审计见 [docs/research/licensing-review.md](docs/research/licensing-review.md)。
