import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import type { State, StageState, StageStatus, Workflow } from '../types.js';
import { STAGE_STATUSES } from '../types.js';

export const STATE_FILE = 'state.yaml';
export const PROJECT_FILE = 'project.yaml';
export const WORKFLOW_FILE = 'workflow.yaml';

export function isStageStatus(value: unknown): value is StageStatus {
  return (
    typeof value === 'string' &&
    (STAGE_STATUSES as readonly string[]).includes(value)
  );
}

/** 解析 state.yaml 文本，校验 status 合法 */
export function parseState(source: string): State {
  const loaded = yaml.load(source);
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error('state.yaml 顶层必须是对象');
  }
  const obj = loaded as Record<string, unknown>;

  const current_stage = typeof obj.current_stage === 'string' ? obj.current_stage : '';

  const stages: Record<string, StageState> = {};
  if (obj.stages && typeof obj.stages === 'object') {
    for (const [id, raw] of Object.entries(obj.stages as Record<string, unknown>)) {
      const s = (raw ?? {}) as Record<string, unknown>;
      if (!isStageStatus(s.status)) {
        throw new Error(`state.yaml 中 stage ${id} 的 status 非法: ${String(s.status)}`);
      }
      stages[id] = {
        status: s.status,
        approvedBy: typeof s.approvedBy === 'string' ? s.approvedBy : undefined,
        approvedAt: typeof s.approvedAt === 'string' ? s.approvedAt : undefined,
        note: typeof s.note === 'string' ? s.note : undefined,
      };
    }
  }

  return { current_stage, stages };
}

/** 将 State 序列化为 state.yaml 文本 */
export function stringifyState(state: State): string {
  return yaml.dump(state, { indent: 2, lineWidth: -1, noRefs: true });
}

/** 读取 .speccraft/state.yaml */
export async function readState(speccraftDir: string): Promise<State> {
  return parseState(await readFile(path.join(speccraftDir, STATE_FILE), 'utf8'));
}

/** 写入 .speccraft/state.yaml */
export async function writeState(speccraftDir: string, state: State): Promise<void> {
  await writeFile(path.join(speccraftDir, STATE_FILE), stringifyState(state), 'utf8');
}

/** 由 Workflow 生成初始 State：所有阶段 pending，current_stage 为第一个阶段 */
export function createInitialState(workflow: Workflow): State {
  const stages: Record<string, StageState> = {};
  for (const stage of workflow.stages) {
    stages[stage.id] = { status: 'pending' };
  }
  return {
    current_stage: workflow.stages[0]?.id ?? '',
    stages,
  };
}

export function getStageStatus(state: State, id: string): StageStatus | undefined {
  return state.stages[id]?.status;
}

export function setStageStatus(
  state: State,
  id: string,
  status: StageStatus,
  extra?: Partial<Omit<StageState, 'status'>>,
): void {
  state.stages[id] = { ...state.stages[id], status, ...extra };
}
