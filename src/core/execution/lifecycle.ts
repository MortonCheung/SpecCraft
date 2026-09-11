/**
 * Implementation 生命周期（ADR 0003 §5）。
 *
 * 硬规则：Git 有改动 / commit 存在 / 报告文件存在，都不代表 implementation
 * completed。状态只能由显式命令改变：
 *   speccraft implement start    → in_progress
 *   speccraft implement finish   → completed（必须显式提供 report）
 */

import { access, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Workflow, State } from '../types.js';
import { setStageStatus } from '../state/store.js';
import { captureGitSnapshot } from './git.js';
import {
  getActiveRun,
  readRun,
  updateRunStatus,
  appendRunReport,
  runDir,
  writeRun,
} from './store.js';
import type { ExecutionRunManifest } from './types.js';
import { assertRunMutable } from '../changes/guards.js';

export interface ImplementStartOptions {
  projectRoot: string;
  /** 显式指定 run；缺省使用 state.active_run */
  runId?: string;
  now?: Date;
}

export interface ImplementStartResult {
  runId: string;
}

export interface ImplementFinishOptions {
  projectRoot: string;
  /** 施工报告路径（必须存在且非空） */
  reportPath: string;
  now?: Date;
}

export interface ImplementFinishResult {
  runId: string;
  /** 报告在 run 目录内的文件名 */
  reportFile: string;
}

/** speccraft implement start */
export async function implementStart(options: ImplementStartOptions): Promise<ImplementStartResult> {
  const { workflow, state, speccraftDir } = await loadProjectForExecution(options.projectRoot);

  // 前置门禁
  const ready = state.stages['ready-to-implement']?.status;
  if (ready !== 'completed') {
    throw new Error(`implement start 要求 ready-to-implement == completed（当前：${ready ?? '未记录'}）`);
  }

  const runId = options.runId ?? state.active_run;
  if (!runId) {
    throw new Error('没有活跃的 Execution Run。请先运行 speccraft prepare');
  }

  // v0.9 §13 / §41：Active Change Freeze 与 Superseded Run Guard（fail-before-mutation）
  await assertRunMutable(speccraftDir, runId);
  if (state.active_run && options.runId && options.runId !== state.active_run) {
    // 显式指定了非 active 的 run：只要求它存在，不改变 active_run
  }

  const run = await readRun(speccraftDir, runId);
  if (run.status !== 'prepared') {
    throw new Error(`Run ${runId} 状态为 ${run.status}，只有 prepared 状态才能 start`);
  }

  const implStatus = state.stages['implementation']?.status;
  if (implStatus !== 'pending') {
    throw new Error(`implementation 当前状态为 ${implStatus ?? '未记录'}，不能 start`);
  }

  // 状态转换
  const now = (options.now ?? new Date()).toISOString();
  setStageStatus(state, 'implementation', 'in_progress');
  state.current_stage = 'implementation';
  state.active_run = runId;

  run.startedAt = now;
  await updateRunStatus(speccraftDir, run, 'in_progress');

  const { writeState } = await import('../state/store.js');
  await writeState(speccraftDir, state);

  void workflow;
  return { runId };
}

/** speccraft implement finish --report <path> */
export async function implementFinish(
  options: ImplementFinishOptions,
): Promise<ImplementFinishResult> {
  const { workflow, state, speccraftDir } = await loadProjectForExecution(options.projectRoot);

  const implStatus = state.stages['implementation']?.status;
  if (implStatus !== 'in_progress') {
    throw new Error(
      `implementation 当前状态为 ${implStatus ?? '未记录'}，只有 in_progress 才能 finish`,
    );
  }

  const runId = state.active_run;
  if (!runId) {
    throw new Error('没有活跃的 Execution Run，但 implementation 为 in_progress（状态不一致）');
  }

  // v0.9 §13 / §41：Active Change Freeze 与 Superseded Run Guard（fail-before-mutation）
  await assertRunMutable(speccraftDir, runId);

  const run = await readRun(speccraftDir, runId);

  // 报告必须存在且非空
  const resolved = path.resolve(options.reportPath);
  if (!(await pathExists(resolved))) {
    throw new Error(`报告不存在：${resolved}`);
  }
  const info = await stat(resolved);
  if (info.size === 0) {
    throw new Error(`报告为空文件：${resolved}`);
  }

  // 报告版本化：agent-report-001.md、agent-report-002.md …（不覆盖历史）
  const seq = run.reports.length + 1;
  const reportFile = `agent-report-${String(seq).padStart(3, '0')}.md`;
  await copyFile(resolved, path.join(runDir(speccraftDir, runId), reportFile));

  const now = (options.now ?? new Date()).toISOString();

  // final Git 快照
  run.finalGit = (await captureGitSnapshot(options.projectRoot)) ?? run.finalGit;
  if (!run.finishedAt) run.finishedAt = now;
  await appendRunReport(speccraftDir, run, { file: reportFile, recordedAt: now });
  await updateRunStatus(speccraftDir, run, 'awaiting_verification');

  // 状态转换：implementation completed → verification
  setStageStatus(state, 'implementation', 'completed');
  state.current_stage = 'verification';
  const { writeState } = await import('../state/store.js');
  await writeState(speccraftDir, state);

  void workflow;
  return { runId, reportFile };
}

/**
 * verification 失败后的返工入口：重新打开 implementation（同一 Run）。
 * 由 Verification Runner 调用，不创建新 stage / 新 run。
 */
export async function reopenImplementation(
  speccraftDir: string,
  state: State,
  run: ExecutionRunManifest,
): Promise<void> {
  setStageStatus(state, 'implementation', 'in_progress');
  setStageStatus(state, 'verification', 'blocked');
  state.current_stage = 'implementation';
  state.active_run = run.id;
  await updateRunStatus(speccraftDir, run, 'verification_failed');
  await writeRun(speccraftDir, run);
  const { writeState } = await import('../state/store.js');
  await writeState(speccraftDir, state);
}

async function loadProjectForExecution(projectRoot: string) {
  const { loadProject } = await import('../project.js');
  return loadProject(projectRoot);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export { getActiveRun };
