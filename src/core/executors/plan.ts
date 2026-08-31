/**
 * Executor Assignment Plan（ADR 0008 §3、§16）。
 *
 * buildExecutorPlan：按 Task Graph declaration order 确定性分配 Task → Executor。
 * 来源只能是 task 显式声明 / project default_executor / legacy-default，禁止任何 auto-selector。
 *
 * Plan 一旦产生即 frozen（store.ts 持久化；M7.2 后 dispatch 只读 plan.yaml）。
 */

import type { AdapterConfig } from '../execution/adapters/types.js';
import type { TaskGraph } from '../tasks/types.js';
import type { AssignmentSource, ExecutorAssignment, ExecutorPlan } from './types.js';
import { LEGACY_EXECUTOR_ID } from './types.js';
import { mergeAdapterConfig } from './config.js';
import { resolveProfile, isValidExecutorId } from './resolver.js';
import type { ExecutorsContext } from './resolver.js';

/** 从 ProjectConfig 派生上下文 + Adapter 配置构建 Executor Plan（deterministic） */
export function buildExecutorPlan(
  ctx: ExecutorsContext,
  adapters: Record<string, AdapterConfig>,
  graph: TaskGraph,
  now: Date = new Date(),
): ExecutorPlan {
  const assignments: ExecutorAssignment[] = [];

  // available Executor IDs（确定性排序；不依赖对象插入序）
  const available =
    Object.keys(ctx.executors).length > 0
      ? [...Object.keys(ctx.executors).sort(), LEGACY_EXECUTOR_ID].join(', ')
      : LEGACY_EXECUTOR_ID;

  for (const task of graph.tasks) {
    // ADR 0008 §16：来源优先级 task → default → legacy
    let executorId: string;
    let source: AssignmentSource;
    if (task.executor) {
      executorId = task.executor;
      source = 'task';
    } else if (ctx.hasDefaultExecutor) {
      executorId = ctx.defaultExecutor;
      source = 'default';
    } else {
      executorId = LEGACY_EXECUTOR_ID;
      source = 'legacy';
    }

    if (executorId === 'auto') {
      throw new Error(`task ${task.id} 禁止 executor: auto（v0.7 只允许显式 profile id 或缺省）`);
    }
    if (!isValidExecutorId(executorId)) {
      throw new Error(`task ${task.id} 的 executor id 非法：${executorId}`);
    }

    // ADR 0008 §17：未知 profile → FAIL（错误包含 Task ID + unknown ID + available IDs）
    const profile = resolveProfile(ctx, executorId);
    if (!profile) {
      throw new Error(
        `task ${task.id} 引用的 executor 不存在：${executorId}（available: ${available}）`,
      );
    }

    const adapterId = profile.adapter;
    const adapterConfig = adapters[adapterId];
    const resolved = mergeAdapterConfig(profile, adapterConfig);

    const assignment: ExecutorAssignment = {
      taskId: task.id,
      executor: executorId,
      source,
      adapter: adapterId,
      resolved,
    };
    if (profile.maxConcurrency !== undefined) assignment.maxConcurrency = profile.maxConcurrency;
    assignments.push(assignment);
  }

  return {
    version: 1,
    runId: graph.runId,
    createdAt: now.toISOString(),
    defaultExecutor: ctx.defaultExecutor,
    assignments,
  };
}
