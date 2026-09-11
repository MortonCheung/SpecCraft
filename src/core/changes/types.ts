/**
 * Change Set 领域类型（SpecCraft v0.9 §6–§12、§61，ADR 0010）。
 *
 * 职责边界：只承载 Change Set 的类型契约与状态机规则；
 * 不读写磁盘、不调用 AI、不做 Git 操作。
 *
 * 核心原则：Plans may change. History must not.
 */

/** Change Set 生命周期状态（v0.9 §7） */
export type ChangeSetStatus =
  | 'draft' // 已创建，尚未完成 Impact Analysis
  | 'analyzed' // 存在 latest complete Analysis Attempt
  | 'approved' // Owner 已批准，绑定 approved Analysis
  | 'materialized' // Successor Run 已创建，frozen plans digest 与 approval 一致
  | 'closed' // canonical artifacts 已提升
  | 'rejected'; // 终止（draft / analyzed 旁路），base Run 恢复可执行

export const CHANGE_SET_STATUSES = [
  'draft',
  'analyzed',
  'approved',
  'materialized',
  'closed',
  'rejected',
] as const;

export function isChangeSetStatus(value: unknown): value is ChangeSetStatus {
  return typeof value === 'string' && (CHANGE_SET_STATUSES as readonly string[]).includes(value);
}

/**
 * 仍然冻结 base Run 的状态（v0.9 §13 / §61）。
 * rejected / closed 之后 base Run 恢复可执行。
 */
export const ACTIVE_CHANGE_STATUSES = [
  'draft',
  'analyzed',
  'approved',
  'materialized',
] as const;

export function isActiveChangeStatus(status: ChangeSetStatus): boolean {
  return (ACTIVE_CHANGE_STATUSES as readonly string[]).includes(status);
}

/**
 * 合法状态迁移（v0.9 §7 / §21–§40）。
 * - draft → analyzed：Analysis Attempt complete
 * - draft / analyzed → rejected：Owner 拒绝，计划未被改变
 * - analyzed → approved：Owner 批准
 * - approved → materialized：replan 成功创建 Successor Run
 * - materialized → closed：canonical promotion 完成
 * - materialization failure 时保持不变（仍为 approved，可重试 replan）
 */
const CHANGE_TRANSITIONS: Record<ChangeSetStatus, readonly ChangeSetStatus[]> = {
  draft: ['analyzed', 'rejected'],
  analyzed: ['approved', 'rejected'],
  approved: ['materialized'],
  materialized: ['closed'],
  closed: [],
  rejected: [],
};

export function canTransitionChange(from: ChangeSetStatus, to: ChangeSetStatus): boolean {
  return CHANGE_TRANSITIONS[from].includes(to);
}

/** Change 来源（v0.9 §10；缺省 owner） */
export type ChangeSource = 'owner' | 'review' | 'verification' | 'site-survey' | 'external';

export const CHANGE_SOURCES = [
  'owner',
  'review',
  'verification',
  'site-survey',
  'external',
] as const;

export function isChangeSource(value: unknown): value is ChangeSource {
  return typeof value === 'string' && (CHANGE_SOURCES as readonly string[]).includes(value);
}

/**
 * Change Runtime 的结构化错误。
 *
 * code 使用 v0.9 施工手册规定的稳定标识（run_change_pending、change_already_approved、
 * non_deterministic_recompile、proposal_changed_since_analysis、canonical_drift 等），
 * 便于测试与上层判断，不依赖 message 文案。
 */
export class ChangeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ChangeError';
    this.code = code;
  }
}

/** baseline 快照中的单个 artifact（v0.9 §11） */
export interface ChangeBaselineArtifact {
  /** workflow stage id（Change Evidence 以 stage 作为 artifact 键，见 §9/§11/§18） */
  stage: string;
  /** 该 stage 在 workflow 中声明的 canonical artifact id */
  artifact: string;
  /** 相对 change 目录的快照路径，如 baseline/artifacts/requirement.md */
  path: string;
  /** 快照文件的原始字节 SHA-256（不 trim / 不 normalize） */
  sha256: string;
}

/** Workflow 身份与 digest（v0.9 §10） */
export interface ChangeWorkflowIdentity {
  name: string;
  version: string;
  /** workflow.yaml 原始字节 SHA-256；文件缺失时为 null */
  digest: string | null;
}

/**
 * `.speccraft/changes/<change-id>/manifest.yaml`（v0.9 §9–§12）。
 *
 * 创建时捕获的事实不可被后续阶段改写（除 status 迁移）。
 * 不存在的事实记为 null，不伪造（§10）。
 */
export interface ChangeSetManifest {
  id: string;
  status: ChangeSetStatus;
  baseRunId: string;
  source: ChangeSource;
  /** 可选来源引用（evidence 路径或 id） */
  sourceRef?: string;
  /** Change 请求正文（来自 --reason 或 --file） */
  reason: string;
  createdAt: string;
  /** 创建时的 Git HEAD；目标项目不是 Git 仓库时为 null */
  gitHead: string | null;
  workflow: ChangeWorkflowIdentity;
  /** project.yaml 原始字节 SHA-256；文件缺失时为 null */
  projectDigest: string | null;
  /** canonical artifact baseline 快照（按 workflow 阶段顺序） */
  artifacts: ChangeBaselineArtifact[];
  /** base Run 的 frozen plan digest；不存在时为 null（不伪造） */
  baseTaskGraphDigest: string | null;
  baseExecutorPlanDigest: string | null;
  baseReviewPlanDigest: string | null;
}
