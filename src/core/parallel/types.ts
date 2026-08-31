/**
 * Parallel 领域类型（ADR 0007 §13）。
 *
 * Wave = 一轮 ready Tasks 中可以安全并行的一组 Task。
 * 确定性来源：Task Graph 声明顺序 + maxParallel + scope 保守冲突检测。
 */

import type { TaskGraph, TaskStatus } from '../tasks/types.js';

/** planner 输入（全部确定性，无随机 / LLM / 完成时间调度） */
export interface PlanWaveInput {
  graph: TaskGraph;
  statuses: Map<string, TaskStatus>;
  maxParallel: number;
}

/** 单次规划结果（一组可安全并行的 task id，按声明顺序） */
export interface WavePlan {
  wave: number;
  tasks: string[];
  /** 每 task 的 scope（用于 wave manifest 的 scope summary） */
  scopes: Record<string, string[]>;
  maxParallel: number;
  /** 因 scope 冲突 / maxParallel 被留到后续 wave 的 ready tasks（按声明顺序） */
  deferred: string[];
}

export const DEFAULT_MAX_PARALLEL = 2;

/** 校验 maxParallel 输入（integer >= 1） */
export function isValidMaxParallel(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}
