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
    /** §17.1：review attempt evidence（相对 run 的 manifest.yaml 路径） */
    review_attempts: string[];
  };

  files: string[];

  /**
   * v0.9 §52：Handoff Package 内文件的 SHA-256（键为文件名）。
   * 不含 `manifest.yaml` 自身（避免自引用）。
   */
  file_hashes: Record<string, string>;
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
  /** executor history 摘要行（v0.7 §56） */
  executorHistory: string[];
  /** review history 摘要行（v0.8 §17）；无 review evidence 时为 [] */
  reviewHistory: string[];

  /** v0.9 §52：Change History 正文；非 Change 产生的 Run 为 null */
  changeHistory: string | null;

  /** 缺失的 artifact id 列表（manifest 必须显式记录） */
  missingArtifacts: string[];

  git: HandoffManifest['git'];

  verification: HandoffManifest['verification'];
  acceptance: HandoffManifest['acceptance'];

  /** run 内的源文件清单（execution reports / verification attempts / acceptance records / review attempts） */
  sourceLists: {
    execution_reports: string[];
    verification_attempts: string[];
    acceptance_records: string[];
    review_attempts: string[];
  };
}
