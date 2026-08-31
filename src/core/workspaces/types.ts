/**
 * Workspace 领域类型（ADR 0007 §3、§7.3）。
 *
 * Workspace Attempt 是 Task 在并行 route 下的隔离施工现场。
 * WorkspaceStatus 是独立状态模型，不是 TaskStatus。
 *
 *   Run
 *   └── Task
 *       └── Workspace Attempt
 *           ├── Branch
 *           ├── Worktree
 *           ├── Dispatch Attempts
 *           ├── Verification Attempts
 *           ├── Scope Audit
 *           ├── Task Commit
 *           └── Integration
 */

/** Workspace 生命周期状态（与 TaskStatus 完全独立） */
export type WorkspaceStatus =
  | 'created' // worktree 已建（或复用），尚未 dispatch
  | 'active' // Agent 正在该 worktree 施工
  | 'verified' // Task Verification PASS，但尚未 commit
  | 'committed' // Runtime 已 task commit，等待 integration
  | 'integrated' // 已 cherry-pick 进 canonical
  | 'failed' // 施工/验证/scope 失败，尚未 integration
  | 'integration_conflict' // cherry-pick 冲突，已 abort（禁止自动解决）
  | 'cleaned'; // 已成功 integration 且 worktree 被清理

export const WORKSPACE_STATUSES: readonly WorkspaceStatus[] = [
  'created',
  'active',
  'verified',
  'committed',
  'integrated',
  'failed',
  'integration_conflict',
  'cleaned',
];

export function isWorkspaceStatus(value: unknown): value is WorkspaceStatus {
  return typeof value === 'string' && (WORKSPACE_STATUSES as readonly string[]).includes(value);
}

/** Scope Audit 结果（actualChangedPaths ⊆ declaredScope 才算通过） */
export interface ScopeAuditRecord {
  declared: string[];
  actual: string[];
  passed: boolean;
  violations: string[];
}

/** Workspace Attempt 的可变 manifest（file-first，.speccraft 只存 metadata） */
export interface WorkspaceManifest {
  version: 1;
  runId: string;
  taskId: string;
  attempt: number;
  status: WorkspaceStatus;
  /** 真正 worktree 的绝对路径（仓库外） */
  workspaceRoot: string;
  /** 确定性生成的 task branch 名 */
  branch: string;
  /** worktree 基于的 base commit（= wave base commit） */
  baseCommit: string;
  createdAt: string;
  updatedAt: string;
  dispatchAttempts: number[];
  verificationAttempts: number[];
  changedPaths: string[];
  scopeAudit: ScopeAuditRecord;
  /** Executor Profile ID（v0.7 Workspace 创建时的 Assignment snapshot；ADR 0008 §21） */
  executorProfile?: string;
  /** Adapter ID（v0.7 Assignment snapshot，与 executorProfile 对应） */
  adapter?: string;
  /** Runtime 生成的 task commit SHA */
  taskCommit?: string;
  /** canonical 上 cherry-pick 后的 integration commit SHA */
  integrationCommit?: string;
  /** 失败发生的阶段（dispatch/verify/scope/integration） */
  failurePhase?: string;
  /** integration_conflict 时记录的冲突路径（ADR 0007 §12.6） */
  conflictingPaths?: string[];
  lastError?: string;
}

/** Wave 内单个 Task 的确定结果（不复制整个 Workspace Manifest） */
export type WaveTaskResult = 'verified' | 'failed' | 'integrated' | 'conflict';

export interface WaveTaskOutcome {
  taskId: string;
  result: WaveTaskResult;
}

/** Parallel Wave 的 append-only evidence（§8.5、§13.6） */
export interface WaveManifest {
  wave: number;
  /** wave 开始时的 canonical base commit */
  baseCommit: string;
  maxParallel: number;
  /** 本 wave 选中 Task（graph 声明顺序） */
  tasks: string[];
  startedAt?: string;
  finishedAt?: string;
  /** 确定性 integration 顺序（graph 声明顺序） */
  integrationOrder: string[];
  results: WaveTaskOutcome[];
}

/** workspace / wave 目录内 manifest 文件名 */
export const WORKSPACE_MANIFEST_FILE = 'manifest.yaml';