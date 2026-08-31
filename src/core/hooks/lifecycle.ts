/**
 * Hook Lifecycle（ADR 0005 §10）。
 *
 * before hook：blocking——任一失败则主体操作不执行、状态不推进；
 * after hook：non-rollback——失败只记 warning，主体已完成、不倒滚状态。
 *
 * 本模块只负责执行语义封装，主体操作的推进由各 Runtime 命令自行负责。
 */

import type { HookConfig, HookEnvironment, HookEvent } from './types.js';
import { runHooks } from './runner.js';
import type { RunHooksOutcome } from './runner.js';

export interface HookContext {
  projectRoot: string;
  speccraftDir: string;
  runId?: string;
  env: HookEnvironment;
  /** hook 命令执行 cwd（v0.6 parallel route = isolated workspaceRoot；省略用 projectRoot） */
  workspaceRoot?: string;
}

/** 执行 before hook；返回 blocked=true 表示应中止主体操作 */
export async function runBeforeHooks(
  ctx: HookContext,
  config: HookConfig | undefined,
  event: HookEvent,
): Promise<{ blocked: boolean; outcome?: RunHooksOutcome }> {
  const hooks = config?.[event];
  if (!hooks || hooks.length === 0) return { blocked: false };
  const outcome = await runHooks({ ...ctx, event, hooks, ...(ctx.workspaceRoot ? { workspaceRoot: ctx.workspaceRoot } : {}) });
  return { blocked: outcome.anyFailed, outcome };
}

/** 执行 after hook；失败只返回结果（由调用方决定是否打印 warning），不倒滚 */
export async function runAfterHooks(
  ctx: HookContext,
  config: HookConfig | undefined,
  event: HookEvent,
): Promise<RunHooksOutcome | null> {
  const hooks = config?.[event];
  if (!hooks || hooks.length === 0) return null;
  return runHooks({ ...ctx, event, hooks, ...(ctx.workspaceRoot ? { workspaceRoot: ctx.workspaceRoot } : {}) });
}
