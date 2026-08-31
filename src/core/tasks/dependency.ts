/**
 * Dependency Engine（ADR 0006 §6）。
 *
 * 拓扑校验、确定性排序、状态刷新、ready 计算、blocked 传播、reopen 传播。
 * 同级 ready Task 顺序使用 Execution Manual 声明顺序（不随机、不 LLM 排序）。
 */

import type { TaskGraph, TaskManifest, TaskStatus } from './types.js';

/** 确定性拓扑排序（Kahn；同级按声明顺序） */
export function topologicalOrder(graph: TaskGraph): string[] {
  const inDegree = new Map<string, number>();
  for (const t of graph.tasks) inDegree.set(t.id, t.dependsOn.length);
  const order: string[] = [];
  const queue: string[] = graph.tasks.filter((t) => (inDegree.get(t.id) ?? 0) === 0).map((t) => t.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const t of graph.tasks) {
      if (t.dependsOn.includes(id)) {
        const d = (inDegree.get(t.id) ?? 0) - 1;
        inDegree.set(t.id, d);
        if (d === 0) queue.push(t.id);
      }
    }
  }
  return order;
}

/** 返回某 task 的传递 dependents（直接 + 间接，按声明顺序） */
export function transitiveDependents(graph: TaskGraph, taskId: string): string[] {
  const dependents = new Set<string>();
  const queue = [taskId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const t of graph.tasks) {
      if (t.dependsOn.includes(id) && !dependents.has(t.id)) {
        dependents.add(t.id);
        queue.push(t.id);
      }
    }
  }
  // 按 graph 声明顺序返回（确定性）
  return graph.tasks.filter((t) => dependents.has(t.id)).map((t) => t.id);
}

/**
 * 刷新全部 task 状态（根据 graph 依赖 + 当前 manifests）。
 * 纯函数：返回新的 status map，不写盘。
 *
 * 规则：
 * - completed 保持 completed；
 * - failed 保持 failed；
 * - 任一 dependency failed → blocked；
 * - 全部 dependency completed → ready；
 * - 否则 pending。
 */
export function refreshStates(
  graph: TaskGraph,
  manifests: Map<string, TaskManifest>,
): Map<string, TaskStatus> {
  const result = new Map<string, TaskStatus>();
  for (const t of graph.tasks) {
    const m = manifests.get(t.id);
    // 终态（completed/failed）与运行时中间态（in_progress）保持
    if (m && (m.status === 'completed' || m.status === 'failed' || m.status === 'in_progress')) {
      result.set(t.id, m.status);
      continue;
    }
    if (t.dependsOn.length === 0) {
      result.set(t.id, 'ready');
      continue;
    }
    let hasBlockedOrFailed = false;
    let allCompleted = true;
    for (const d of t.dependsOn) {
      const depStatus = result.get(d) ?? manifests.get(d)?.status ?? 'pending';
      // failed 或 blocked 传递：依赖链上有失败 → 本 task blocked
      if (depStatus === 'failed' || depStatus === 'blocked') hasBlockedOrFailed = true;
      if (depStatus !== 'completed') allCompleted = false;
    }
    if (hasBlockedOrFailed) result.set(t.id, 'blocked');
    else if (allCompleted) result.set(t.id, 'ready');
    else result.set(t.id, 'pending');
  }
  return result;
}

/** 返回第一个 ready task（按声明顺序）；无则 null */
export function firstReadyTask(graph: TaskGraph, statuses: Map<string, TaskStatus>): string | null {
  for (const t of graph.tasks) {
    if (statuses.get(t.id) === 'ready') return t.id;
  }
  return null;
}

/** 是否存在 failed task */
export function hasFailedTask(statuses: Map<string, TaskStatus>): boolean {
  for (const s of statuses.values()) if (s === 'failed') return true;
  return false;
}

/** 是否全部 completed */
export function allCompleted(graph: TaskGraph, statuses: Map<string, TaskStatus>): boolean {
  return graph.tasks.every((t) => statuses.get(t.id) === 'completed');
}

/** 是否存在 blocked task（及其被哪个 failed dependency 阻塞） */
export function blockedReason(
  graph: TaskGraph,
  statuses: Map<string, TaskStatus>,
): { taskId: string; failedDep: string } | null {
  for (const t of graph.tasks) {
    if (statuses.get(t.id) !== 'blocked') continue;
    for (const d of t.dependsOn) {
      if (statuses.get(d) === 'failed') return { taskId: t.id, failedDep: d };
    }
  }
  return null;
}
