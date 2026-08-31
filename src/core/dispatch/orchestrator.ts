/**
 * Dispatch Orchestrator（ADR 0005 §4）。
 *
 * 一次 dispatch attempt 的执行内核：
 *   buildInvocation → runDispatchProcess → 保存 raw evidence →
 *   adapter.normalize → 写 attempt manifest + normalized 证据。
 *
 * 不负责 Workflow 状态机（implementation start/finish / verification 等），
 * 那些由 Runtime lifecycle 层调用本模块之后自行处理。
 */

import path from 'node:path';
import type { CliExecutionAdapter, NormalizedDispatchResult } from '../execution/adapters/types.js';
import { runDispatchProcess } from './runner.js';
import { reserveDispatchAttempt, writeDispatchAttempt } from './store.js';
import { dispatchAttemptDir } from './types.js';
import type { DispatchAttemptManifest } from './types.js';
import { runDir } from '../execution/store.js';

export interface DispatchOnceOptions {
  speccraftDir: string;
  projectRoot: string;
  runId: string;
  adapter: CliExecutionAdapter;
  /** agent-prompt.md 全文 */
  prompt: string;
  /** agent-prompt.md 绝对路径（provider 支持 --file 时用） */
  promptFile?: string;
  sessionId?: string;
  freshSession: boolean;
  model?: string;
  adapterConfig?: { command?: string; timeout_seconds?: number; extra_args?: string[]; model?: string; sandbox?: string };
  /** Task ID（v0.5 Task dispatch 必填；legacy 省略） */
  taskId?: string;
  /** Executor Profile ID（v0.7 Task dispatch；ADR 0008 §21，写入 evidence） */
  executorProfile?: string;
  /** 隔离 worktree 绝对路径（v0.6 parallel route；省略则用 projectRoot） */
  workspaceRoot?: string;
  /** Workspace Attempt 序号（v0.6 parallel route） */
  workspaceAttempt?: number;
}

export interface DispatchOnceResult {
  attempt: number;
  result: NormalizedDispatchResult;
  attemptDir: string;
}

/** 执行一次 dispatch attempt（append-only，不覆盖历史） */
export async function dispatchOnce(options: DispatchOnceOptions): Promise<DispatchOnceResult> {
  // 并发安全抢号（ADR 0007 §11.1）：绝不让两个 parallel dispatch 写同一目录
  const attempt = await reserveDispatchAttempt(options.speccraftDir, options.runId);

  // isolated dispatch（ADR 0007 §11.5）：parallel route 的 agent cwd = workspaceRoot，
  // 中心 evidence 仍写 canonical .speccraft（runDir 不变）。
  const effectiveRoot = options.workspaceRoot ?? options.projectRoot;

  const invocation = await options.adapter.buildInvocation({
    projectRoot: effectiveRoot,
    runDir: runDir(options.speccraftDir, options.runId),
    prompt: options.prompt,
    ...(options.promptFile ? { promptFile: options.promptFile } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    freshSession: options.freshSession,
    ...(options.model ? { model: options.model } : {}),
    ...(options.adapterConfig ? { adapterConfig: options.adapterConfig } : {}),
  });

  const proc = await runDispatchProcess({ invocation });

  const normalized = await options.adapter.normalize({
    projectRoot: effectiveRoot,
    runDir: runDir(options.speccraftDir, options.runId),
    adapterId: options.adapter.id,
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    ...(proc.spawnError ? { spawnError: proc.spawnError } : {}),
    stdout: proc.stdout,
    stderr: proc.stderr,
    startedAt: proc.startedAt,
    finishedAt: proc.finishedAt,
    durationMs: proc.durationMs,
    ...(options.adapter.capabilities.structuredOutput && proc.stdout
      ? { rawJsonl: proc.stdout }
      : {}),
  });

  // 落盘证据（append-only）
  const tag = dispatchAttemptDir(attempt);
  const manifest: DispatchAttemptManifest = {
    attempt,
    adapter: options.adapter.id,
    status: normalized.status,
    started_at: proc.startedAt,
    finished_at: proc.finishedAt,
    duration_ms: proc.durationMs,
    exit_code: proc.exitCode,
    signal: proc.signal,
    timed_out: proc.timedOut,
    ...(normalized.sessionId ? { session_id: normalized.sessionId } : {}),
    ...(options.taskId ? { task_id: options.taskId } : {}),
    ...(options.executorProfile ? { executor_profile: options.executorProfile } : {}),
    ...(options.workspaceAttempt !== undefined ? { workspace_attempt: options.workspaceAttempt } : {}),
    ...(options.workspaceRoot ? { workspace_root: options.workspaceRoot } : {}),
    command: [invocation.command, ...invocation.args],
    stdout_file: 'stdout.log',
    stderr_file: 'stderr.log',
    ...(options.adapter.capabilities.structuredOutput ? { raw_file: 'raw.jsonl' } : {}),
    ...(options.adapter.capabilities.structuredOutput ? { events_file: 'events.jsonl' } : {}),
    ...(normalized.finalMessage ? { final_message_file: 'final-message.md' } : {}),
  };

  await writeDispatchAttempt(options.speccraftDir, options.runId, manifest, {
    stdout: proc.stdout,
    stderr: proc.stderr,
    ...(options.adapter.capabilities.structuredOutput && proc.stdout ? { raw: proc.stdout } : {}),
    ...(normalized.events.length > 0 ? { events: JSON.stringify(normalized.events) } : {}),
    ...(normalized.finalMessage ? { finalMessage: normalized.finalMessage } : {}),
  });

  const attemptDir = path.join(runDir(options.speccraftDir, options.runId), 'dispatch', tag);
  return { attempt, result: normalized, attemptDir };
}
