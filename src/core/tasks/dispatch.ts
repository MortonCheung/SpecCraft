/**
 * Task-aware Dispatch（ADR 0006 §7）。
 *
 * 与 legacy dispatch 的关键区别：
 *   - dispatchOnce 带 task_id；
 *   - session isolation 按 run + task + adapter；
 *   - SUCCESS 只让 task 保持 in_progress（等待 Task Verification），
 *     绝不调用 implementFinish()。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CliExecutionAdapter } from '../execution/adapters/types.js';
import { dispatchOnce } from '../dispatch/orchestrator.js';
import { findLatestSessionForTask, listDispatchAttemptsForTask } from '../dispatch/store.js';
import { readTaskGraph } from './store.js';
import { readTaskManifest, writeTaskManifest, taskDir } from './store.js';
import { generateTaskPackage } from './package.js';
import { runDir } from '../execution/store.js';

export interface DispatchTaskOptions {
  speccraftDir: string;
  projectRoot: string;
  runId: string;
  taskId: string;
  adapter: CliExecutionAdapter;
  /** run 级 Compiled Context（context.md 内容） */
  runContext: string;
  /** execution-guard skill 正文 */
  executionGuard: string;
  freshSession: boolean;
  adapterConfig?: { command?: string; timeout_seconds?: number; extra_args?: string[]; model?: string; sandbox?: string };
  /** 隔离 worktree 根目录（v0.6 parallel route）；省略则用 projectRoot */
  workspaceRoot?: string;
  /** Workspace Attempt 序号（v0.6 parallel route）；用于 session isolation 与 evidence */
  workspaceAttempt?: number;
}

export interface DispatchTaskResult {
  success: boolean;
  attempt: number;
  sessionId?: string;
}

/** 对单个 Task 执行一次 dispatch */
export async function dispatchTask(options: DispatchTaskOptions): Promise<DispatchTaskResult> {
  const { speccraftDir, runId, taskId } = options;

  const graph = await readTaskGraph(speccraftDir, runId);
  const task = graph.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task 不存在：${taskId}`);

  let manifest = await readTaskManifest(speccraftDir, runId, taskId);
  if (!manifest) throw new Error(`Task manifest 不存在：${taskId}`);
  if (manifest.status !== 'ready' && manifest.status !== 'failed') {
    throw new Error(`Task ${taskId} 状态为 ${manifest.status}，只有 ready/failed 可 dispatch`);
  }

  // 生成 Task Package（context.md + prompt.md；parallel route 注入 isolation guard）
  await generateTaskPackage({
    speccraftDir,
    runId,
    graph,
    task,
    runContext: options.runContext,
    executionGuard: options.executionGuard,
    isolatedWorkspace: !!options.workspaceRoot,
  });

  const promptFile = path.join(taskDir(speccraftDir, runId, taskId), 'prompt.md');
  const prompt = await readFile(promptFile, 'utf8');

  // session isolation：run + task + adapter（v0.6 parallel：+ workspaceAttempt）
  let sessionId: string | undefined;
  if (!options.freshSession) {
    sessionId =
      (await findLatestSessionForTask(
        speccraftDir,
        runId,
        taskId,
        options.adapter.id,
        options.workspaceAttempt,
      )) ?? undefined;
  }

  // task → in_progress
  manifest.status = 'in_progress';
  await writeTaskManifest(speccraftDir, runId, manifest);

  const result = await dispatchOnce({
    speccraftDir,
    projectRoot: options.projectRoot,
    runId,
    adapter: options.adapter,
    prompt,
    promptFile,
    ...(sessionId ? { sessionId } : {}),
    freshSession: options.freshSession,
    ...(options.adapterConfig?.model ? { model: options.adapterConfig.model } : {}),
    ...(options.adapterConfig ? { adapterConfig: options.adapterConfig } : {}),
    taskId,
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.workspaceAttempt !== undefined ? { workspaceAttempt: options.workspaceAttempt } : {}),
  });

  // 刷新 manifest
  manifest = await readTaskManifest(speccraftDir, runId, taskId);
  if (!manifest) throw new Error(`Task manifest 丢失：${taskId}`);

  const taskAttempts = await listDispatchAttemptsForTask(speccraftDir, runId, taskId);
  manifest.dispatchAttempts = taskAttempts;
  if (result.result.sessionId) manifest.latestSessionId = result.result.sessionId;

  if (result.result.status !== 'succeeded') {
    manifest.status = 'failed';
    manifest.lastError = result.result.stderr?.slice(0, 500) || `dispatch ${result.result.status}`;
    await writeTaskManifest(speccraftDir, runId, manifest);
    return {
      success: false,
      attempt: result.attempt,
      ...(result.result.sessionId ? { sessionId: result.result.sessionId } : {}),
    };
  }

  // SUCCESS：task 保持 in_progress，等待 Task Verification（不调 implementFinish）
  await writeTaskManifest(speccraftDir, runId, manifest);
  return {
    success: true,
    attempt: result.attempt,
    ...(result.result.sessionId ? { sessionId: result.result.sessionId } : {}),
  };
}

export { runDir };
