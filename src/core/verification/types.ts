/**
 * Verification 类型定义（ADR 0003 §6）。
 *
 * Verification Runner 只执行目标项目在 .speccraft/project.yaml 中
 * 声明的 verification.commands，不假设任何特定技术栈。
 */

/** 单条命令的执行结果 */
export interface CommandResult {
  command: string;
  passed: boolean;
  /** exit code（超时 / 无法启动时可能缺失） */
  exitCode?: number;
  /** 终止信号（如超时 SIGTERM 后的 signal） */
  signal?: string | null;
  /** 未通过的补充原因（timeout / spawn 失败） */
  reason?: 'timeout' | 'spawn_error';
  durationMs: number;
  /** 相对 run 目录的 log 文件路径 */
  log: string;
}

/** 一次 verify 的 Attempt 记录（verification/attempt-NNN.yaml） */
export interface VerificationAttempt {
  attempt: number;
  startedAt: string;
  finishedAt: string;
  passed: boolean;
  commands: CommandResult[];
}
