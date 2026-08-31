/**
 * Deterministic Parallel Wave Planner（ADR 0007 §13、ADR 0008 §31-§32）。
 *
 * 流程（§13.2 + §44）：
 *   readyTasks = graph declaration order 中状态为 ready 的 tasks
 *   wave = []
 *   profileUsage = {}
 *   for task in readyTasks:
 *       if wave.length == maxParallel: break
 *       if task.scope 与 wave 内每个 Task 都能证明不冲突: 
 *       if executor.maxConcurrency 存在且 profileUsage[executor] >= maxConcurrency: continue
 *       wave.push(task); profileUsage[executor]++
 *
 * 保守原则（§13.3）：无法证明 A ∩ B = ∅ 时，不能同 Wave。
 * 并发上限（§43）：global maxParallel（硬上限）+ Executor Profile 容量（§46/§47）。
 * 禁止 LLM ranking / random / completion-time scheduling / provider suggestion / adapter rate limiter（§48）。
 */

import { scopesCompatible } from '../tasks/scope.js';
import { LEGACY_EXECUTOR_ID } from '../executors/types.js';
import type { WavePlan, PlanWaveInput } from './types.js';

/**
 * 规划下一个 wave。
 *
 * 确定性保证：
 *   - 遍历顺序 = Task Graph 声明顺序；
 *   - scope 冲突判断 = 纯函数 scopesCompatible（保守）；
 *   - maxParallel 硬上限（即使全部 disjoint 也不得超）；
 *   - Executor Profile 并发容量（缺省不增加额外限制，只受 maxParallel，§31）。
 */
export function planWave(input: PlanWaveInput): WavePlan {
  const { graph, statuses, maxParallel, executorAssignments } = input;

  const ready = graph.tasks.filter((t) => statuses.get(t.id) === 'ready');
  const wave: string[] = [];
  const deferred: string[] = [];
  const profileUsage = new Map<string, number>();

  for (const task of ready) {
    if (wave.length >= maxParallel) {
      deferred.push(task.id);
      continue;
    }
    const compatible = wave.every((id) => {
      const other = graph.tasks.find((t) => t.id === id)!;
      return scopesCompatible(task.scope, other.scope);
    });
    if (!compatible) {
      deferred.push(task.id);
      continue;
    }
    // v0.7 §43/§44/§46：Executor Profile concurrency capacity
    if (executorAssignments) {
      const a = executorAssignments.get(task.id);
      if (a && a.maxConcurrency !== undefined) {
        const used = profileUsage.get(a.executor) ?? 0;
        if (used >= a.maxConcurrency) {
          deferred.push(task.id);
          continue;
        }
      }
    }
    wave.push(task.id);
    if (executorAssignments) {
      const a = executorAssignments.get(task.id);
      if (a) profileUsage.set(a.executor, (profileUsage.get(a.executor) ?? 0) + 1);
    }
  }

  const scopes: Record<string, string[]> = {};
  const executors: Record<string, string> = {};
  for (const id of wave) {
    const t = graph.tasks.find((x) => x.id === id);
    if (t) scopes[id] = [...t.scope.paths];
    // wave evidence：无 assignment 的 legacy task → legacy-default（与 dispatch executor_profile 语义一致）
    executors[id] = executorAssignments?.get(id)?.executor ?? LEGACY_EXECUTOR_ID;
  }

  return {
    wave: 0, // 序号由调用方（store）按已有 waves 递增填充
    tasks: wave,
    scopes,
    executors,
    maxParallel,
    deferred,
  };
}

/**
 * 判断两个 task 是否能安全同 Wave（暴露给 status / next 诊断用）。
 * 无法证明不重叠 → false（保守）。
 */
export function tasksCanShareWave(
  graph: PlanWaveInput['graph'],
  taskIdA: string,
  taskIdB: string,
): boolean {
  const a = graph.tasks.find((t) => t.id === taskIdA);
  const b = graph.tasks.find((t) => t.id === taskIdB);
  if (!a || !b) return false;
  return scopesCompatible(a.scope, b.scope);
}
