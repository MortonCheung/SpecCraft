/**
 * Task 领域类型（ADR 0006 §2、§3）。
 *
 * Task ≠ Workflow Stage；Task ≠ Run；Task ≠ Dispatch Attempt；
 * Task Verification ≠ Run Verification。
 */

/** Task 生命周期状态（仅 6 态，不扩展） */
export type TaskStatus =
  | 'pending' // 依赖尚未全部 completed
  | 'ready' // 全部依赖 completed
  | 'in_progress' // 正在 dispatch 或等待 Task Verification
  | 'completed' // Task Verification PASS
  | 'failed' // 最近 dispatch 或 Task Verification FAIL
  | 'blocked'; // 至少一个 dependency 当前 failed

export const TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'ready',
  'in_progress',
  'completed',
  'failed',
  'blocked',
];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

/** Task 的 scope 约束（确定性；v0.5 不并行但已建立 model 供 v0.6 用） */
export interface TaskScope {
  paths: string[];
}

/** Task 的验证配置（来自 Execution Manual 声明，不假设技术栈） */
export interface TaskVerification {
  commands: string[];
  timeoutSeconds: number;
}

/** 声明式 Task Graph 中的单个 Task 定义（source of truth 是 graph.yaml） */
export interface TaskDefinition {
  id: string;
  title: string;
  summary: string;
  dependsOn: string[];
  scope: TaskScope;
  verification: TaskVerification;
}

/** 声明式 Task Graph（来自 execution-manual 的 speccraft-task-graph block） */
export interface TaskGraph {
  version: 1;
  runId: string;
  /** 来源 artifact（execution-manual） */
  source: string;
  createdAt: string;
  tasks: TaskDefinition[];
}

/** 可变 Task Manifest（不复制 TaskDefinition） */
export interface TaskManifest {
  id: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;

  dispatchAttempts: number[];
  verificationAttempts: number[];

  latestSessionId?: string;
  lastError?: string;

  reopenedCount: number;
}
