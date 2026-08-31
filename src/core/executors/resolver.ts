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
import type { AdapterConfig } from '../execution/adapters/types.js';
import type { ExecutorProfileConfig } from './types.js';
import { LEGACY_EXECUTOR_ID } from './types.js';
import { mergeAdapterConfig } from './config.js';

/** 项目级 Executor 上下文（从 ProjectConfig 派生，确定性） */
export interface ExecutorsContext {
  /** 默认 Executor Profile id（缺省时 legacy-default） */
  defaultExecutor: string;
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
  const defaultExecutor = config.execution?.defaultExecutor ?? LEGACY_EXECUTOR_ID;

  return { defaultExecutor, executors, legacyAdapter: defaultAdapter };
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
