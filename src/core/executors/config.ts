/**
 * Executor 配置解析与合并（ADR 0008 §7、§10）。
 *
 * - parseExecutorsSection：从 project.yaml execution 段解析 default_executor / executors；
 * - resolveAdapterConfig：按覆盖优先级合并：
 *     Executor Profile override → Adapter config → Adapter implementation default。
 *
 * YAML 字段同时接受 snake_case（与现有 adapters 配置一致）与 camelCase。
 */

import type { AdapterConfig } from '../execution/adapters/types.js';
import type { ExecutorProfileConfig, ExecutorsSection } from './types.js';

/** 解析 execution 段的 executor 配置（undefined 表示缺省） */
export function parseExecutorsSection(raw: unknown): ExecutorsSection | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('execution.executors 必须是对象');
  }

  const eo = raw as Record<string, unknown>;

  let defaultExecutor: string | undefined;
  if (eo.default_executor !== undefined) {
    if (typeof eo.default_executor !== 'string' || !eo.default_executor) {
      throw new Error('execution.default_executor 必须是非空字符串');
    }
    defaultExecutor = eo.default_executor;
  }

  const executors: Record<string, ExecutorProfileConfig> = {};
  if (eo.executors !== undefined && eo.executors !== null) {
    if (typeof eo.executors !== 'object' || Array.isArray(eo.executors)) {
      throw new Error('execution.executors 必须是对象');
    }
    for (const [id, rawProfile] of Object.entries(eo.executors as Record<string, unknown>)) {
      if (typeof rawProfile !== 'object' || rawProfile === null) continue;
      const p = rawProfile as Record<string, unknown>;
      const adapter = p.adapter ?? p.adapter_id;
      if (typeof adapter !== 'string' || !adapter) {
        throw new Error(`execution.executors.${id}.adapter 必须是非空字符串`);
      }
      const profile: ExecutorProfileConfig = { adapter };
      if (typeof p.model === 'string' && p.model) profile.model = p.model;
      const timeoutSeconds = pickNumber(p.timeout_seconds, p.timeoutSeconds);
      if (timeoutSeconds !== undefined) profile.timeoutSeconds = timeoutSeconds;
      const extraArgs = pickStringArray(p.extra_args, p.extraArgs);
      if (extraArgs !== undefined) profile.extraArgs = extraArgs;
      if (typeof p.sandbox === 'string' && p.sandbox) profile.sandbox = p.sandbox;
      const maxConcurrency = pickNumber(p.max_concurrency, p.maxConcurrency);
      if (maxConcurrency !== undefined) profile.maxConcurrency = maxConcurrency;
      executors[id] = profile;
    }
  }

  return { defaultExecutor, executors };
}

/** 合并 Executor Profile 与 Adapter 配置：Profile override → Adapter config */
export function mergeAdapterConfig(
  profile: ExecutorProfileConfig | undefined,
  adapterConfig: AdapterConfig | undefined,
): AdapterConfig {
  const out: AdapterConfig = { ...(adapterConfig ?? {}) };
  if (!profile) return out;

  if (profile.model !== undefined) out.model = profile.model;
  if (profile.timeoutSeconds !== undefined) out.timeout_seconds = profile.timeoutSeconds;
  if (profile.extraArgs !== undefined) out.extra_args = [...profile.extraArgs];
  if (profile.sandbox !== undefined) out.sandbox = profile.sandbox;

  return out;
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && v > 0) return v;
  }
  return undefined;
}

function pickStringArray(...values: unknown[]): string[] | undefined {
  for (const v of values) {
    if (Array.isArray(v)) {
      const arr = v.filter((x): x is string => typeof x === 'string');
      if (arr.length > 0) return arr;
    }
  }
  return undefined;
}
