/**
 * Handoff 领域类型（ADR 0004 §6）。
 *
 * Handoff Package 是确定性编译器产物，可被任何下一任 Human / AI 接手。
 * 不调用 AI、不修改源 Artifact。
 */

/** Handoff Package 的 manifest（机器读取入口） */
export interface HandoffManifest {
  handoff_id: string;
  run_id: string;
  created_at: string;

  workflow_stage: 'handoff';

  verification: {
    latest_attempt: number;
    status: string;
  };

  acceptance: {
    latest_attempt: number;
    decision: string;
    record?: string;
  };

  git: {
    available: boolean;
    branch?: string;
    commit?: string;
    dirty?: boolean;
  };

  sources: {
    artifacts: string[];
    decisions: string[];
    execution_reports: string[];
    verification_attempts: string[];
    acceptance_records: string[];
  };

  files: string[];
}

/** 单个 Decision 的来源信息 */
export interface DecisionSource {
  filename: string;
  title: string;
  body: string;
}

/** 编译 Handoff 所需的输入（由 handoff lifecycle 组装） */
export interface HandoffCompileInput {
  handoffId: string;
  runId: string;
  createdAt: string;
  projectName: string;
  projectRoot: string;

  /** Context Compiler 编译的上游 context（Markdown） */
  contextMarkdown: string;
  /** decisions 列表（稳定排序） */
  decisions: DecisionSource[];
  /** execution history 摘要行 */
  executionHistory: string[];
  /** verification history 摘要行 */
  verificationHistory: string[];
  /** acceptance history 摘要行 */
  acceptanceHistory: string[];

  /** 缺失的 artifact id 列表（manifest 必须显式记录） */
  missingArtifacts: string[];

  git: HandoffManifest['git'];

  verification: HandoffManifest['verification'];
  acceptance: HandoffManifest['acceptance'];

  /** run 内的源文件清单（execution reports / verification attempts / acceptance records） */
  sourceLists: {
    execution_reports: string[];
    verification_attempts: string[];
    acceptance_records: string[];
  };
}
