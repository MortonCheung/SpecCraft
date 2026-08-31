/**
 * Task Verification 类型（ADR 0006 §8）。
 *
 * Task Verification ≠ Run Verification。
 * 执行 Task Definition 的 verification.commands，证据 append-only。
 */

/** 单条命令的验证结果 */
export interface TaskVerificationCommandResult {
  command: string;
  passed: boolean;
  exitCode?: number;
  durationMs: number;
  log: string;
}

/** 一次 Task Verification Attempt 的 manifest */
export interface TaskVerificationAttemptManifest {
  attempt: number;
  task_id: string;
  passed: boolean;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  timeout_seconds: number;
  commands: {
    command: string;
    passed: boolean;
    exit_code?: number;
    duration_ms: number;
  }[];
}

export function taskVerificationAttemptDir(attempt: number): string {
  return `attempt-${String(attempt).padStart(3, '0')}`;
}
