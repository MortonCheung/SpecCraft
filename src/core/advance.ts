import type { Workflow, State, StageDefinition, StageStatus } from './types.js';
import { evaluateGate, needsOwnerApproval, canEnterStage } from './guards/index.js';
import { setStageStatus } from './state/store.js';

/** v0.1 终端阶段（ADR 0002 §20：到此停止，不再自动推进） */
export const V01_TERMINAL_STAGE = 'ready-to-implement';

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
 * 并级联完成 v0.1 范围内的过渡阶段。
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
 * 级联完成 v0.1 范围内的过渡阶段（produces 为空且 gate 已满足）。
 * 只推进到 V01_TERMINAL_STAGE（含），不触碰 implementation 及其后的 v0.2 阶段。
 */
function cascadeTransitions(workflow: Workflow, state: State): void {
  const terminalIndex = workflow.stages.findIndex((s) => s.id === V01_TERMINAL_STAGE);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < workflow.stages.length; i++) {
      if (terminalIndex >= 0 && i > terminalIndex) break;
      const stage = workflow.stages[i];
      if (stage.produces.length > 0) continue;
      if (state.stages[stage.id]?.status !== 'pending') continue;
      if (evaluateGate(stage, state).satisfied) {
        setStageStatus(state, stage.id, 'completed');
        changed = true;
      }
    }
  }
}

/**
 * 解析 current_stage，限定在 v0.1 范围内（不超过 ready-to-implement）：
 * 1. 优先返回等待 Owner 批准的阶段；
 * 2. 否则返回下一个可进入阶段；
 * 3. 都无则返回 v0.1 终点 ready-to-implement。
 */
function resolveCurrentStage(workflow: Workflow, state: State): string {
  const terminalIndex = workflow.stages.findIndex((s) => s.id === V01_TERMINAL_STAGE);
  for (let i = 0; i <= terminalIndex; i++) {
    if (state.stages[workflow.stages[i].id]?.status === 'waiting_owner_approval') {
      return workflow.stages[i].id;
    }
  }
  for (let i = 0; i <= terminalIndex; i++) {
    if (canEnterStage(workflow, state, workflow.stages[i].id)) return workflow.stages[i].id;
  }
  return V01_TERMINAL_STAGE;
}
