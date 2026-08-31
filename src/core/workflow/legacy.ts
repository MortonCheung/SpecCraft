/**
 * Legacy v0.1 compatibility
 *
 * ---------------------------------------------------------------------------
 * 本文件是 v0.1 遗留语义的**唯一**兼容点。禁止在 CLI / State / Guard /
 * advance / verification 等其他模块里再写任何与 v0.1 相关的判断。
 *
 * 背景（ADR 0003 §3）：
 * v0.1 用「produces 为空 → 自动级联完成」加上「推进到 ready-to-implement 为止」
 * 两条硬编码规则来模拟无 Artifact 过渡阶段。这两条规则既依赖 stage 结构
 * （produces），又依赖版本号常量（V01_TERMINAL_STAGE），无法表达 v0.2 的
 * 「implementation 必须显式 start」语义。
 *
 * v0.2 改为声明式：StageDefinition.autoComplete（YAML: auto_complete）。
 * 本模块负责把「没有声明 auto_complete 的旧 Workflow」一次性归一化为显式
 * autoComplete，使 Runtime 只需读取该字段，永远不需要知道 v0.1 的存在。
 * ---------------------------------------------------------------------------
 */

import type { Workflow, StageDefinition } from '../types.js';

/** v0.1 的推进边界：cascade 与 current_stage 到此为止（ADR 0002 §20） */
export const LEGACY_V01_BOUNDARY_STAGE = 'ready-to-implement';

/** 判断是否为 v0.1 遗留 Workflow：所有阶段都没有声明 auto_complete */
export function isLegacyWorkflow(workflow: Workflow): boolean {
  return workflow.stages.every((s) => s.autoComplete === undefined);
}

/**
 * 把 v0.1 遗留语义归一化为显式 autoComplete（纯函数，不修改入参）。
 *
 * v0.1 语义：
 *   produces 为空 且 位于推进边界（LEGACY_V01_BOUNDARY_STAGE，含）之前
 *   → 自动完成。
 *
 * 对默认 16 阶段 Workflow，这条规则恰好等价于：
 *   owner-approval       → true
 *   ready-to-implement   → true
 *   implementation       → false（位于边界之后，v0.2 要求显式 start）
 *   owner-acceptance     → false
 *
 * 新 Workflow（任一阶段显式声明了 auto_complete）不做任何处理，
 * 未声明的字段按缺省 false 处理。
 *
 * 若 Workflow 中不存在推进边界阶段（非默认 Workflow），无法可靠推断 v0.1
 * 语义，此时一律取保守值 false：不自动完成任何阶段。
 */
export function applyLegacyAutoComplete(workflow: Workflow): Workflow {
  if (!isLegacyWorkflow(workflow)) return workflow;

  const boundary = workflow.stages.findIndex((s) => s.id === LEGACY_V01_BOUNDARY_STAGE);

  const stages: StageDefinition[] = workflow.stages.map((stage, index) => ({
    ...stage,
    autoComplete:
      stage.autoComplete ??
      (boundary >= 0 && stage.produces.length === 0 && index <= boundary),
  }));

  return { ...workflow, stages };
}
