/**
 * Executor Profile 解析（ADR 0008 §9、§16）。
 *
 * 从 project.yaml（ProjectConfig）解析 Executor Profile：
 *   - default_executor → default；
 *   - 无 executors 配置 → 逻辑 legacy-default（adapter = default_adapter）。
 *
 * 解析结果只用于构建 Executor Plan；Plan 一旦产生即 frozen（M7.2 store.ts）。
 */

import type { ProjectConfig } from '../project.js';
import type { AdapterConfig, ExecutionAdapter } from '../execution/adapters/types.js';
import { getAdapter } from '../execution/adapters/registry.js';
import type { ExecutorPlan, ExecutorProfileConfig, ResolvedTaskExecutor } from './types.js';
import type { ExecutorAssignment } from './types.js';
import { LEGACY_EXECUTOR_ID } from './types.js';
import { mergeAdapterConfig } from './config.js';

/** 项目级 Executor 上下文（从 ProjectConfig 派生，确定性） */
export interface ExecutorsContext {
  /** 默认 Executor Profile id（缺省时 legacy-default） */
  defaultExecutor: string;
  /** 是否显式配置了 default_executor（区分 source: default 与 source: legacy） */
  hasDefaultExecutor: boolean;
  /** 各 Executor Profile（可能为空） */
  executors: Record<string, ExecutorProfileConfig>;
  /** legacy adapter（execution.default_adapter，缺省 manual） */
  legacyAdapter: string;
}

/** 从 ProjectConfig 构建 Executor 上下文（ADR 0008 §9 legacy 兼容） */
export function buildExecutorsContext(config: ProjectConfig): ExecutorsContext {
  const defaultAdapter = config.execution?.defaultAdapter ?? 'manual';
  const executors = config.execution?.executors ?? {};

  // 无 default_executor 时 → legacy-default（adapter = default_adapter）
  const hasDefaultExecutor = config.execution?.defaultExecutor !== undefined;
  const defaultExecutor = hasDefaultExecutor
    ? (config.execution?.defaultExecutor as string)
    : LEGACY_EXECUTOR_ID;

  return { defaultExecutor, hasDefaultExecutor, executors, legacyAdapter: defaultAdapter };
}

/** 解析 Executor Profile；未知 id 返回 null（调用方决定报错策略） */
export function resolveProfile(
  ctx: ExecutorsContext,
  executorId: string,
): ExecutorProfileConfig | null {
  if (executorId === LEGACY_EXECUTOR_ID) {
    return { adapter: ctx.legacyAdapter };
  }
  const profile = ctx.executors[executorId];
  return profile ?? null;
}

/** 合并 Executor Profile 与 Adapter 配置（Profile override → Adapter config） */
export function resolveMergedAdapterConfig(
  profile: ExecutorProfileConfig | null,
  adapterConfig: AdapterConfig | undefined,
): AdapterConfig {
  return mergeAdapterConfig(profile ?? undefined, adapterConfig);
}

/** 校验 executorId 合法（不允许 auto / capabilities 等 auto-selector） */
export function isValidExecutorId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

// ---------------------------------------------------------------------------
// ExecutorResolver（ADR 0008 §38：Core Orchestrator → generic CliExecutionAdapter）
// ---------------------------------------------------------------------------

/** Task → 已解析 Executor 的解析器（只读 frozen plan.yaml，绝不重新读取 project.yaml） */
export interface ExecutorResolver {
  resolve(taskId: string): ResolvedTaskExecutor;
}

/**
 * 从 frozen Executor Plan 构建 ExecutorResolver。
 *
 * 核心 Orchestrator 不接触 Provider-specific 代码：
 *   taskId → ExecutorResolver → generic CliExecutionAdapter
 *
 * @param options.plan           frozen plan.yaml（ADR 0008 §18：dispatch 只读 plan）
 * @param options.resolveAdapter adapter 解析器（测试可注入 mock；缺省用 registry）
 */
export function buildExecutorResolver(options: {
  plan: ExecutorPlan;
  resolveAdapter?: (adapterId: string) => ExecutionAdapter | undefined;
}): ExecutorResolver {
  const resolveAdapter = options.resolveAdapter ?? getAdapter;
  const byTask = new Map<string, ExecutorAssignment>();
  for (const a of options.plan.assignments) byTask.set(a.taskId, a);

  return {
    resolve(taskId: string): ResolvedTaskExecutor {
      const assignment = byTask.get(taskId);
      if (!assignment) {
        throw new Error(`task ${taskId} 没有 Executor Assignment（Executor Plan 缺失该 Task）`);
      }
      const adapter = resolveAdapter(assignment.adapter);
      if (!adapter || adapter.kind !== 'cli') {
        throw new Error(
          `executor ${assignment.executor} 的 adapter ${assignment.adapter} 不可用（task ${taskId}；preflight 应先阻止）`,
        );
      }
      return {
        executorId: assignment.executor,
        adapterId: assignment.adapter,
        adapter,
        adapterConfig: assignment.resolved,
        ...(assignment.maxConcurrency !== undefined ? { maxConcurrency: assignment.maxConcurrency } : {}),
      };
    },
  };
}
