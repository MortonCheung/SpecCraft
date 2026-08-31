# SpecCraft

SpecCraft 是一个 **Human-Directed AI Workflow System**（人主导的 AI 工作流系统）。

它把模糊想法逐步加工为：

> 清晰需求 → 调研结果 → 产品方案 → 甲方确认 → Agent 总施工方案 → 真实项目勘察 → 精确施工手册 → Agent 实施 → 验证 → 甲方验收 → 交接

## 核心理念

> **Owner decides what. SpecCraft designs how. Execution Agents build it.**

SpecCraft 不把主要产品思考下放给 Coding Agent。Coding Agent 应尽可能拿到已经设计完整、约束明确、可以直接执行的施工说明。

## 当前开发阶段

**Milestone 0 — Foundation & Research**（基础与开源组件调研）

当前阶段工作：

- 建立基础仓库结构；
- 固化核心 Workflow；
- 对六个目标开源项目进行结构级工程勘察；
- 建立 Component Matrix，决定未来哪些能力复用 / 改造 / 集成 / 只借思想 / 放弃。

## 核心 Workflow

见 [docs/workflow/core-workflow.md](docs/workflow/core-workflow.md)。

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

当前并未实现：Workflow Engine、状态机、Commands、Hooks、Skills、Agent Adapter，以及任何对具体 Agent 平台（Claude / Codex / Trae 等）的集成。

## License

根项目 License 尚未决定（计划开源，待 Owner 批准）。第三方许可证审计见 [docs/research/licensing-review.md](docs/research/licensing-review.md)。
