/**
 * Executor 领域类型（ADR 0008 §6、§10）。
 *
 * Task ≠ Executor Profile ≠ Adapter ≠ Provider Session ≠ Workspace ≠ Dispatch Attempt。
 * Executor Profile 是 SpecCraft 定义的施工 Executor 身份；Adapter 才是 Provider CLI 连接。
 */

import type { AdapterConfig } from '../execution/adapters/types.js';

/** Executor Profile 配置（ADR 0008 §6；禁止任何 Secret / API key / token） */
export interface ExecutorProfileConfig {
  /** 该 Executor 使用的 Adapter id */
  adapter: string;
  /** 可选：provider model 选择（仅 Adapter 支持 modelSelection 时合法） */
  model?: string;
  /** 可选：覆盖 Adapter 的超时秒数 */
  timeoutSeconds?: number;
  /** 可选：附加 CLI 参数 */
  extraArgs?: string[];
  /** 可选：sandbox 标识 */
  sandbox?: string;
  /** 可选：该 Executor Profile 的并发上限（缺省不限制，只受 --max-parallel） */
  maxConcurrency?: number;
}

/** project.yaml execution 段的 executor 相关配置（ADR 0008 §7、§9） */
export interface ExecutorsSection {
  /** 项目默认 Executor Profile id（缺省时 legacy-default） */
  defaultExecutor?: string;
  /** 各 Executor Profile */
  executors: Record<string, ExecutorProfileConfig>;
}

/** legacy 兼容：无 executors 配置时建立的逻辑 profile id（adapter = execution.default_adapter） */
export const LEGACY_EXECUTOR_ID = 'legacy-default';

/** Assignment source（ADR 0008 §3） */
export type AssignmentSource = 'task' | 'default' | 'legacy';

/** 单 Task 的 Executor Assignment（frozen once plan.yaml 产生） */
export interface ExecutorAssignment {
  taskId: string;
  executor: string;
  source: AssignmentSource;
  adapter: string;
  /** 合并后的 Adapter 级配置（Executor Profile override → Adapter config → 默认） */
  resolved: AdapterConfig;
  maxConcurrency?: number;
}

/** Executor Plan（ADR 0008 §4：frozen Run evidence） */
export interface ExecutorPlan {
  version: 1;
  runId: string;
  createdAt: string;
  defaultExecutor: string;
  assignments: ExecutorAssignment[];
}

/** 已解析的 Task Executor（orchestrator 消费，ADR 0008 §38） */
export interface ResolvedTaskExecutor {
  executorId: string;
  adapterId: string;
  adapter: import('../execution/adapters/types.js').CliExecutionAdapter;
  adapterConfig: AdapterConfig;
  maxConcurrency?: number;
}
