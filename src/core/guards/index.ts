import type { Workflow, State, StageDefinition } from '../types.js';

export interface GateResult {
  stageId: string;
  satisfied: boolean;
  /** 未满足的上游描述 */
  unmet: string[];
}

export interface GuardCheck {
  name: string;
  passed: boolean;
  message: string;
}

/**
 * 评估单个阶段的 gate（见 ADR 0002 §7、§9）。
 * - all_required_completed：requires 全部 status === completed
 * - owner_approval：requires 全部 status === approved（Owner 硬门禁）
 */
export function evaluateGate(stage: StageDefinition, state: State): GateResult {
  const want = stage.gate.type === 'owner_approval' ? 'approved' : 'completed';
  const unmet: string[] = [];
  for (const req of stage.requires) {
    const status = state.stages[req]?.status;
    if (status !== want) {
      unmet.push(`${req}（需要 ${want}，当前 ${status ?? '未记录'}）`);
    }
  }
  return { stageId: stage.id, satisfied: unmet.length === 0, unmet };
}

/** 该阶段是否产出后需要等待 Owner 批准（作为某个 owner_approval 门禁的上游） */
export function needsOwnerApproval(workflow: Workflow, stageId: string): boolean {
  return workflow.stages.some(
    (s) => s.gate.type === 'owner_approval' && s.requires.includes(stageId),
  );
}

/** 阶段是否可进入：gate 满足 且 状态为 pending */
export function canEnterStage(workflow: Workflow, state: State, stageId: string): boolean {
  const stage = workflow.stages.find((s) => s.id === stageId);
  if (!stage) return false;
  if (!evaluateGate(stage, state).satisfied) return false;
  const status = state.stages[stageId]?.status ?? 'pending';
  return status === 'pending';
}

/** 下一个可进入的阶段；没有则返回 null */
export function nextStageId(workflow: Workflow, state: State): string | null {
  for (const stage of workflow.stages) {
    if (canEnterStage(workflow, state, stage.id)) return stage.id;
  }
  return null;
}

/** 当前处于等待 Owner 批准状态的阶段 id 列表 */
export function findWaitingApproval(state: State): string[] {
  return Object.entries(state.stages)
    .filter(([, s]) => s.status === 'waiting_owner_approval')
    .map(([id]) => id);
}

/** 校验状态一致性（不跳阶段），返回违规描述列表 */
export function validateState(workflow: Workflow, state: State): string[] {
  const violations: string[] = [];
  if (state.current_stage && !workflow.stages.some((s) => s.id === state.current_stage)) {
    violations.push(`current_stage 引用了未知阶段: ${state.current_stage}`);
  }
  for (const stage of workflow.stages) {
    const status = state.stages[stage.id]?.status;
    if (status && !['pending', 'locked', 'blocked'].includes(status)) {
      const gate = evaluateGate(stage, state);
      if (!gate.satisfied) {
        violations.push(`阶段 ${stage.id} 处于 ${status}，但上游未满足: ${gate.unmet.join('; ')}`);
      }
    }
  }
  return violations;
}

/** Design Guard：design 未 approved → 禁止 Build Brief（ADR 0002 §14） */
export function designGuard(state: State): GuardCheck {
  const ok = state.stages['design']?.status === 'approved';
  return {
    name: 'design-guard',
    passed: ok,
    message: ok ? '' : 'design 未获 Owner 批准，不能进入 build-brief',
  };
}

/** Survey Guard：site-survey 未 completed → 禁止最终 Execution Manual */
export function surveyGuard(state: State): GuardCheck {
  const ok = state.stages['site-survey']?.status === 'completed';
  return {
    name: 'survey-guard',
    passed: ok,
    message: ok ? '' : 'site-survey 未完成，不能生成最终 execution-manual',
  };
}

/** Execution Guard：execution-manual 未 completed → 禁止 Implementation */
export function executionGuard(state: State): GuardCheck {
  const ok = state.stages['execution-manual']?.status === 'completed';
  return {
    name: 'execution-guard',
    passed: ok,
    message: ok ? '' : 'execution-manual 未完成，不能进入 implementation',
  };
}

/** Completion Guard：verification 未 completed → 禁止宣布完成 */
export function completionGuard(state: State): GuardCheck {
  const ok = state.stages['verification']?.status === 'completed';
  return {
    name: 'completion-guard',
    passed: ok,
    message: ok ? '' : 'verification 未通过，不能宣布完成',
  };
}

/** 运行全部 4 个命名 Guard */
export function runGuards(state: State): GuardCheck[] {
  return [designGuard(state), surveyGuard(state), executionGuard(state), completionGuard(state)];
}
