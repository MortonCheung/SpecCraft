/**
 * Task Rework（ADR 0006 §9）。
 *
 * reopen 是显式人类/Planner 行为（不自动从 reject reason 推断）。
 * - target 重新 ready/pending，reopenedCount+1；
 * - 保留历史 evidence（不删 dispatch / verification）；
 * - --cascade：transitive dependents 重新 pending。
 */

import type { TaskGraph, TaskManifest } from './types.js';
import { readTaskGraph, readAllTaskManifests, writeTaskManifest } from './store.js';
import { transitiveDependents } from './dependency.js';

export interface ReopenTaskOptions {
  speccraftDir: string;
  runId: string;
  taskId: string;
  /** 是否级联重开下游 dependents */
  cascade: boolean;
}

export interface ReopenTaskResult {
  reopened: string[];
}

/** 重开一个 Task（及可选 cascade 下游） */
export async function reopenTask(options: ReopenTaskOptions): Promise<ReopenTaskResult> {
  const { speccraftDir, runId, taskId, cascade } = options;

  const graph = await readTaskGraph(speccraftDir, runId);
  if (!graph.tasks.some((t) => t.id === taskId)) {
    throw new Error(`Task 不存在：${taskId}`);
  }

  const manifests = await readAllTaskManifests(speccraftDir, runId);

  const affected = cascade
    ? new Set<string>([taskId, ...transitiveDependents(graph, taskId)])
    : new Set<string>([taskId]);

  const reopened: string[] = [];
  for (const id of affected) {
    const m = manifests.get(id);
    if (!m) continue;
    m.reopenedCount += 1;
    m.lastError = undefined;
    m.status = computeReopenedStatus(graph, id, manifests, affected);
    await writeTaskManifest(speccraftDir, runId, m);
    reopened.push(id);
  }

  // 保证确定性顺序（按声明顺序）
  reopened.sort((a, b) => {
    const ia = graph.tasks.findIndex((t) => t.id === a);
    const ib = graph.tasks.findIndex((t) => t.id === b);
    return ia - ib;
  });

  return { reopened };
}

/** 重算 reopen 后的状态：依赖全部 completed（且未被本次 reset）→ ready，否则 pending */
function computeReopenedStatus(
  graph: TaskGraph,
  taskId: string,
  manifests: Map<string, TaskManifest>,
  affected: Set<string>,
): TaskManifest['status'] {
  const task = graph.tasks.find((t) => t.id === taskId)!;
  if (task.dependsOn.length === 0) return 'ready';
  const allDepsCompleted = task.dependsOn.every((d) => {
    if (affected.has(d)) return false; // 依赖也在本次 reset 集合 → 视为未完成
    return manifests.get(d)?.status === 'completed';
  });
  return allDepsCompleted ? 'ready' : 'pending';
}
