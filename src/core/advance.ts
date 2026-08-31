import type { Workflow, State, StageDefinition, StageStatus } from './types.js';
import { evaluateGate, needsOwnerApproval, canEnterStage } from './guards/index.js';
import { setStageStatus } from './state/store.js';

/** 阶段产出的 artifact 依赖：上游阶段 produce 的 artifact id 列表 */
export function artifactDependencies(workflow: Workflow, stage: StageDefinition): string[] {
  const deps: string[] = [];
  for (const req of stage.requires) {
    const upstream = workflow.stages.find((s) => s.id === req);
    const artifactId = upstream?.produces[0] ?? req;
    if (artifactId) deps.push(artifactId);
  }
  return deps;
}

/**
 * 生成 artifact 后推进阶段：pending → completed（或 waiting_owner_approval），
 * 并级联完成声明为 autoComplete 的过渡阶段。
 */
export function completeStage(workflow: Workflow, state: State, stageId: string): StageStatus {
  const target: StageStatus = needsOwnerApproval(workflow, stageId)
    ? 'waiting_owner_approval'
    : 'completed';
  setStageStatus(state, stageId, target);
  cascadeTransitions(workflow, state);
  state.current_stage = resolveCurrentStage(workflow, state);
  return target;
}

/**
 * 由 Runtime 命令显式把阶段标记为 completed（不经过 Owner 批准判定），
 * 并级联过渡阶段、重算 current_stage。
 *
 * 用于 implementation / verification 这类由 Runtime 而非 Artifact 驱动的阶段
 * （`speccraft implement finish`、`speccraft verify`，见 ADR 0003 §5）。
 * completeStage 会把阶段推进到 waiting_owner_approval，不符合这些阶段的语义。
 */
export function markStageCompleted(workflow: Workflow, state: State, stageId: string): void {
  setStageStatus(state, stageId, 'completed');
  cascadeTransitions(workflow, state);
  state.current_stage = resolveCurrentStage(workflow, state);
}

/** 批准阶段：waiting_owner_approval → approved，并级联过渡阶段 */
export function approveStage(workflow: Workflow, state: State, stageId: string, by: string): void {
  const status = state.stages[stageId]?.status;
  if (status !== 'waiting_owner_approval' && status !== 'in_progress') {
    throw new Error(`阶段 ${stageId} 当前状态 ${status ?? '未记录'}，无需批准`);
  }
  setStageStatus(state, stageId, 'approved', {
    approvedBy: by,
    approvedAt: new Date().toISOString(),
  });
  cascadeTransitions(workflow, state);
  state.current_stage = resolveCurrentStage(workflow, state);
}

/**
 * 级联完成声明式标记为 autoComplete 的过渡阶段（ADR 0003 §3）。
 *
 * 条件全部满足才自动完成：
 *   stage.autoComplete === true
 *   AND status === pending
 *   AND gate satisfied
 *
 * 这里不再依据 stage id、版本号常量或 produces 是否为空来猜测行为：
 * 一切由 Workflow 声明决定。因此 implementation 即使 gate 已满足，
 * 也会保持 pending，直到显式执行 `speccraft implement start`。
 */
function cascadeTransitions(workflow: Workflow, state: State): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of workflow.stages) {
      if (stage.autoComplete !== true) continue;
      if ((state.stages[stage.id]?.status ?? 'pending') !== 'pending') continue;
      if (!evaluateGate(stage, state).satisfied) continue;
      setStageStatus(state, stage.id, 'completed');
      changed = true;
    }
  }
}

/**
 * 解析 current_stage（不再有版本截止，见 ADR 0003 §3）：
 * 1. 优先返回等待 Owner 批准的阶段；
 * 2. 否则返回第一个可进入的阶段；
 * 3. 否则返回推进最远的阶段（最后一个非 pending / locked 的阶段）；
 * 4. 都没有则返回第一个阶段。
 */
function resolveCurrentStage(workflow: Workflow, state: State): string {
  for (const stage of workflow.stages) {
    if (state.stages[stage.id]?.status === 'waiting_owner_approval') return stage.id;
  }
  for (const stage of workflow.stages) {
    if (canEnterStage(workflow, state, stage.id)) return stage.id;
  }
  for (let i = workflow.stages.length - 1; i >= 0; i--) {
    const id = workflow.stages[i].id;
    const status = state.stages[id]?.status ?? 'pending';
    if (status !== 'pending' && status !== 'locked') return id;
  }
  return workflow.stages[0]?.id ?? '';
}
