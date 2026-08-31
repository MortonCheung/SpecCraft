/**
 * Execution Run 类型定义（ADR 0003 §4）。
 *
 * Implementation 不允许通过「代码发生变化」隐式判定完成，
 * 必须挂在一次显式创建的 Run 上。Run 完全采用文件存储
 * （.speccraft/runs/<run-id>/），不引入数据库。
 */

/** Run 的生命周期状态（ADR 0003 §4 + ADR 0004 §4） */
export type ExecutionRunStatus =
  | 'prepared' // prepare 已生成 Execution Package，Agent 尚未开始
  | 'in_progress' // implement start 已执行，Agent 正在施工
  | 'awaiting_verification' // implement finish 已提交报告，等待 verify
  | 'verification_failed' // 最近一次 verification 未通过，可返工
  | 'verified' // 最近一次 verification 通过（v0.3 起转瞬即逝，随后进入 awaiting_owner_acceptance）
  | 'awaiting_owner_acceptance' // verification PASS，等待 Owner ACCEPT/REJECT
  | 'acceptance_rejected' // Owner REJECT，implementation 已重开（同 Run 返工）
  | 'accepted' // Owner ACCEPT，等待 handoff
  | 'handed_off'; // handoff package 已生成，Run 进入终态

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

/** Run 内的 Owner Acceptance 状态摘要（ADR 0004 §4） */
export interface RunAcceptanceState {
  /** 已发生的 acceptance 决策次数 */
  attempt: number;
  /** 最近一次决策 */
  status: 'none' | 'accepted' | 'rejected';
  /** 最近一次 acceptance record（相对 run 目录，如 acceptance/acceptance-002.md） */
  latestRecord?: string;
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

  /** Owner Acceptance 状态（v0.3） */
  acceptance: RunAcceptanceState;

  /** handoff package 目录名（相对 .speccraft/handoffs/，如 handoff-001） */
  handoffId?: string;
  /** handoff 生成时间 ISO 字符串 */
  handoffAt?: string;
}

/** 校验值是否为合法 ExecutionRunStatus */
export function isExecutionRunStatus(value: unknown): value is ExecutionRunStatus {
  return (
    typeof value === 'string' &&
    [
      'prepared',
      'in_progress',
      'awaiting_verification',
      'verification_failed',
      'verified',
      'awaiting_owner_acceptance',
      'acceptance_rejected',
      'accepted',
      'handed_off',
    ].includes(value)
  );
}
