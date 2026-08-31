/**
 * Dispatch Lifecycle（ADR 0005 §4、§7）。
 *
 * 完整自动施工流程（复用既有 lifecycle，不复制）：
 *   before_dispatch hook → implement start → dispatch attempt → provider CLI
 *   → SUCCESS: 生成 agent-report + 复用 implementFinish（→ awaiting_verification）
 *   → FAIL:    implementation 保持 in_progress，verification 不开始
 *
 * 不自动 verify：Execution 与 Verification 是两个独立证据阶段。
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { State, Workflow } from '../types.js';
import type { CliExecutionAdapter } from '../execution/adapters/types.js';
import type { ExecutionRunManifest } from '../execution/types.js';
import { dispatchOnce } from './orchestrator.js';
import type { DispatchOnceResult } from './orchestrator.js';
import { readLatestDispatchAttempt } from './store.js';
import { runDir, readRun } from '../execution/store.js';
import { implementStart, implementFinish } from '../execution/lifecycle.js';

export interface DispatchExecutionOptions {
  projectRoot: string;
  speccraftDir: string;
  workflow: Workflow;
  state: State;
  run: ExecutionRunManifest;
  adapter: CliExecutionAdapter;
  /** agent-prompt.md 绝对路径 */
  promptFile: string;
  /** resume 用：上一 attempt 的 session id（未提供则查最新 attempt） */
  sessionId?: string;
  freshSession: boolean;
  adapterConfig?: { command?: string; timeout_seconds?: number; extra_args?: string[]; model?: string; sandbox?: string };
}

export interface DispatchExecutionResult {
  success: boolean;
  attempt: number;
  sessionId?: string;
  /** success 时生成的 report 文件名（相对 run 目录） */
  reportFile?: string;
}

/** 执行一次完整 dispatch（成功则复用 implementFinish 推进到 awaiting_verification） */
export async function dispatchExecution(
  options: DispatchExecutionOptions,
): Promise<DispatchExecutionResult> {
  const { speccraftDir, adapter } = options;

  // prepared → 显式开始施工（复用既有 implementStart lifecycle）
  if (options.run.status === 'prepared') {
    await implementStart({ projectRoot: options.projectRoot });
  }
  // 重新读 run：implementStart 可能已把状态改为 in_progress
  const run = await readRun(speccraftDir, options.run.id);

  const prompt = await readFile(options.promptFile, 'utf8');

  // resume：显式传入优先，否则查最新 attempt 的同 adapter session
  let sessionId = options.sessionId;
  if (!sessionId && !options.freshSession) {
    const latest = await readLatestDispatchAttempt(speccraftDir, run.id);
    if (latest && latest.adapter === adapter.id && latest.session_id) {
      sessionId = latest.session_id;
    }
  }

  const result: DispatchOnceResult = await dispatchOnce({
    speccraftDir,
    projectRoot: options.projectRoot,
    runId: run.id,
    adapter,
    prompt,
    promptFile: options.promptFile,
    ...(sessionId ? { sessionId } : {}),
    freshSession: options.freshSession,
    ...(options.adapterConfig?.model ? { model: options.adapterConfig.model } : {}),
    ...(options.adapterConfig ? { adapterConfig: options.adapterConfig } : {}),
  });

  if (result.result.status !== 'succeeded') {
    // FAIL：implementation 保持 in_progress，verification 不开始
    return {
      success: false,
      attempt: result.attempt,
      ...(result.result.sessionId ? { sessionId: result.result.sessionId } : {}),
    };
  }

  // SUCCESS：生成确定性 agent-report，复用 implementFinish
  const reportFile = `agent-report-${String(run.reports.length + 1).padStart(3, '0')}.md`;
  const reportPath = path.join(runDir(speccraftDir, run.id), reportFile);
  await writeFile(reportPath, renderDispatchReport(result), 'utf8');

  await implementFinish({
    projectRoot: options.projectRoot,
    reportPath,
  });

  return {
    success: true,
    attempt: result.attempt,
    ...(result.result.sessionId ? { sessionId: result.result.sessionId } : {}),
    reportFile,
  };
}

/** 从 Dispatch 归一化结果确定性渲染 agent report（不调用 AI） */
function renderDispatchReport(result: DispatchOnceResult): string {
  const r = result.result;
  const lines: string[] = [
    '# Execution Report',
    '',
    '## 实际修改',
    '',
    r.finalMessage?.trim() || '（Provider 未提供最终消息；见 dispatch attempt 原始输出）',
    '',
    '## 验证',
    '',
    `- Dispatch: ${r.status}`,
    `- Adapter: ${r.adapter}`,
    ...(r.sessionId ? [`- Provider Session: ${r.sessionId}`] : []),
    ...(r.exitCode !== undefined ? [`- Exit Code: ${r.exitCode}`] : []),
    '',
    '## 已知问题',
    '',
    '（见 dispatch attempt 的 stderr / events 原始证据）',
    '',
  ];
  return lines.join('\n');
}
