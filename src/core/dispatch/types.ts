/**
 * Dispatch Runtime 类型（ADR 0005 §4）。
 *
 * Dispatch Attempt 是 append-only 的执行证据，不是 Workflow Stage。
 * 归一化事件 / 结果复用 adapters/types.ts 的契约。
 */

import type { AgentEvent, DispatchStatus, NormalizedDispatchResult } from '../adapters/types.js';

/** .speccraft/runs/<run-id>/dispatch/attempt-NNN/manifest.yaml 的结构 */
export interface DispatchAttemptManifest {
  attempt: number;
  adapter: string;
  status: DispatchStatus;
  started_at: string;
  finished_at?: string;
  duration_ms: number;
  exit_code?: number | null;
  signal?: string | null;
  timed_out: boolean;
  /** provider session id（与 SpecCraft Run ID 分离） */
  session_id?: string;
  /** 实际执行的 command + args（不含 Secret；如需 redact 由 adapter 处理） */
  command?: string[];
  /** 相对 attempt 目录的文件名 */
  stdout_file: string;
  stderr_file: string;
  raw_file?: string;
  events_file?: string;
  final_message_file?: string;
}

/** dispatch 目录相对 run 的路径片段 */
export const DISPATCH_DIR = 'dispatch';

/** 由 attempt 序号 → 目录名 */
export function dispatchAttemptDir(attempt: number): string {
  return `attempt-${String(attempt).padStart(3, '0')}`;
}

/** 由 attempt 序号 → manifest 文件名 */
export function dispatchManifestFileName(attempt: number): string {
  return `manifest-${String(attempt).padStart(3, '0')}.yaml`;
}

export type { AgentEvent, DispatchStatus, NormalizedDispatchResult };
