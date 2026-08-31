/**
 * Hook Runtime 类型（ADR 0005 §10）。
 *
 * before hook：blocking（失败则主体不执行、状态不推进）；
 * after hook：non-rollback（失败只记 warning，不倒滚已完成主体）。
 */

/** Hook 生命周期事件（Runtime 事件，不是 Workflow Stage） */
export const HOOK_EVENTS = [
  'before_prepare',
  'after_prepare',
  'before_implementation_start',
  'after_implementation_start',
  'before_implementation_finish',
  'after_implementation_finish',
  'before_dispatch',
  'after_dispatch',
  'before_verify',
  'after_verify',
  'before_accept',
  'after_accept',
  'before_reject',
  'after_reject',
  'before_handoff',
  'after_handoff',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value);
}

/** 单个 hook 定义（只支持 id / command / timeout_seconds） */
export interface HookDefinition {
  id: string;
  command: string;
  timeout_seconds?: number;
}

/** project.yaml 中 hooks 配置（event → 顺序执行的 hooks） */
export type HookConfig = Partial<Record<HookEvent, HookDefinition[]>>;

/** 传递给 hook 的环境变量（最小 env contract，不含 Secret） */
export interface HookEnvironment {
  SPECCRAFT_EVENT: string;
  SPECCRAFT_PROJECT_ROOT: string;
  SPECCRAFT_DIR: string;
  SPECCRAFT_STAGE: string;
  SPECCRAFT_ACTIVE_RUN?: string;
  SPECCRAFT_RUN_ID?: string;
  SPECCRAFT_DISPATCH_ATTEMPT?: string;
  SPECCRAFT_VERIFICATION_ATTEMPT?: string;
  SPECCRAFT_ACCEPTANCE_ATTEMPT?: string;
  SPECCRAFT_ADAPTER?: string;
}

/** 单个 hook 的执行结果 */
export interface HookResult {
  id: string;
  event: HookEvent;
  passed: boolean;
  exitCode?: number;
  timedOut: boolean;
  durationMs: number;
  log: string;
}
