/**
 * Execution Run 类型定义（ADR 0003 §4）。
 *
 * Implementation 不允许通过「代码发生变化」隐式判定完成，
 * 必须挂在一次显式创建的 Run 上。Run 完全采用文件存储
 * （.speccraft/runs/<run-id>/），不引入数据库。
 */

/** Run 的生命周期状态 */
export type ExecutionRunStatus =
  | 'prepared' // prepare 已生成 Execution Package，Agent 尚未开始
  | 'in_progress' // implement start 已执行，Agent 正在施工
  | 'awaiting_verification' // implement finish 已提交报告，等待 verify
  | 'verification_failed' // 最近一次 verification 未通过，可返工
  | 'verified'; // 最近一次 verification 通过

/** 只读 Git 快照（见 git.ts；本模块仅承载数据） */
export interface GitSnapshot {
  branch?: string;
  commit?: string;
  dirty: boolean;
}

/** Run 内的施工报告记录（同一 Run 允许多轮返工，报告版本化） */
export interface RunReportEntry {
  /** 相对 run 目录的文件名，如 agent-report-001.md */
  file: string;
  /** 收录时间 ISO 字符串 */
  recordedAt: string;
}

/** .speccraft/runs/<run-id>/manifest.yaml 的结构 */
export interface ExecutionRunManifest {
  id: string;
  status: ExecutionRunStatus;

  createdAt: string;
  updatedAt: string;

  /** implement start 时间（缺省表示尚未开始） */
  startedAt?: string;
  /** implement finish 首次提交报告时间 */
  finishedAt?: string;

  baseGit?: GitSnapshot;
  finalGit?: GitSnapshot;

  /** 相对 run 目录的 Execution Package 文件 */
  contextFile: string;
  promptFile: string;

  /** 已收录的施工报告（版本化，不覆盖） */
  reports: RunReportEntry[];

  /** verification 尝试次数（每次 verify +1） */
  verificationAttempts: number;
}

/** 校验值是否为合法 ExecutionRunStatus */
export function isExecutionRunStatus(value: unknown): value is ExecutionRunStatus {
  return (
    typeof value === 'string' &&
    ['prepared', 'in_progress', 'awaiting_verification', 'verification_failed', 'verified'].includes(
      value,
    )
  );
}
