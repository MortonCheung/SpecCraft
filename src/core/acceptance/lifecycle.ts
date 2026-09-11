/**
 * Owner Acceptance 生命周期（ADR 0004 §5）。
 *
 * Verification ≠ Acceptance：机器验证通过只证明「能跑」，
 * Owner ACCEPT/REJECT 才是「是否满足我」的最终人类决策。
 *
 * 状态转换（全部显式，不隐式修复）：
 *   verify PASS  → owner-acceptance waiting_owner_approval, run awaiting_owner_acceptance
 *   accept       → owner-acceptance completed, run accepted
 *   reject       → owner-acceptance blocked, implementation reopened,
 *                  verification pending, run acceptance_rejected（同一 Run）
 */

import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import type { State, Workflow } from '../types.js';
import { setStageStatus, writeState } from '../state/store.js';
import { runDir, updateRunStatus, writeRun } from '../execution/store.js';
import type { ExecutionRunManifest } from '../execution/types.js';
import { captureGitSnapshot } from '../execution/git.js';
import {
  nextAcceptanceAttempt,
  writeAcceptanceRecord,
} from './store.js';
import { stringifyAcceptanceRecord, renderAcceptanceBody } from './report.js';
import type { AcceptanceFrontmatter } from './types.js';
import { assertRunMutable } from '../changes/guards.js';

export interface AcceptInput {
  by?: string;
  feedback?: string;
  now?: Date;
}

export interface RejectInput {
  feedback: string;
  now?: Date;
}

/** accept 的硬前置条件是否满足（ADR 0004 §5） */
export async function canAccept(
  speccraftDir: string,
  state: State,
  run: ExecutionRunManifest | null,
): Promise<{ ok: boolean; reason?: string }> {
  if (!run) return { ok: false, reason: '没有活跃的 Execution Run' };
  if (state.stages['verification']?.status !== 'completed') {
    return { ok: false, reason: 'verification 尚未 completed' };
  }
  if (state.stages['owner-acceptance']?.status !== 'waiting_owner_approval') {
    return {
      ok: false,
      reason: `owner-acceptance 当前状态为 ${state.stages['owner-acceptance']?.status ?? '未记录'}，不是 waiting_owner_approval`,
    };
  }
  if (!(await latestVerificationPassed(speccraftDir, run.id))) {
    return { ok: false, reason: '最新 verification attempt 不是 PASS' };
  }
  return { ok: true };
}

/** reject 的硬前置条件（与 accept 相同，但 feedback 由 CLI 层强制） */
export function canReject(state: State, run: ExecutionRunManifest | null): {
  ok: boolean;
  reason?: string;
} {
  if (!run) return { ok: false, reason: '没有活跃的 Execution Run' };
  if (state.stages['verification']?.status !== 'completed') {
    return { ok: false, reason: 'verification 尚未 completed' };
  }
  if (state.stages['owner-acceptance']?.status !== 'waiting_owner_approval') {
    return {
      ok: false,
      reason: `owner-acceptance 当前状态为 ${state.stages['owner-acceptance']?.status ?? '未记录'}，不是 waiting_owner_approval`,
    };
  }
  return { ok: true };
}

/** speccraft accept：Owner 通过验收 */
export async function accept(
  speccraftDir: string,
  projectRoot: string,
  workflow: Workflow,
  state: State,
  run: ExecutionRunManifest,
  input: AcceptInput,
): Promise<{ attempt: number }> {
  // v0.9 §13 / §41：Active Change Freeze 与 Superseded Run Guard（fail-before-mutation）
  await assertRunMutable(speccraftDir, run.id);

  const gate = await canAccept(speccraftDir, state, run);
  if (!gate.ok) throw new Error(`accept 被拒绝：${gate.reason}`);

  const attempt = await nextAcceptanceAttempt(speccraftDir, run.id);
  const owner = input.by ?? 'owner';
  const feedback = input.feedback ?? 'Owner acceptance passed.';
  const now = (input.now ?? new Date()).toISOString();
  const git = await captureGitSnapshot(projectRoot);

  const fm: AcceptanceFrontmatter = {
    kind: 'owner-acceptance',
    run_id: run.id,
    attempt,
    decision: 'accepted',
    owner,
    created_at: now,
    verification_attempt: run.verificationAttempts,
    verification_status: 'pass',
    ...(git?.commit ? { git_commit: git.commit } : {}),
  };
  const filename = await writeAcceptanceRecord(
    speccraftDir,
    run.id,
    attempt,
    stringifyAcceptanceRecord(fm, renderAcceptanceBody('accepted', feedback)),
  );

  // 状态转换
  setStageStatus(state, 'owner-acceptance', 'completed');
  state.current_stage = 'handoff';
  run.status = 'accepted';
  run.acceptance = { attempt, status: 'accepted', latestRecord: filename };

  await writeRun(speccraftDir, run);
  await writeState(speccraftDir, state);
  void workflow;
  return { attempt };
}

/** speccraft reject：Owner 拒绝，重开 implementation（同一 Run，不建 Stage/Run） */
export async function reject(
  speccraftDir: string,
  projectRoot: string,
  workflow: Workflow,
  state: State,
  run: ExecutionRunManifest,
  input: RejectInput,
): Promise<{ attempt: number }> {
  // v0.9 §13 / §41：Active Change Freeze 与 Superseded Run Guard（fail-before-mutation）
  await assertRunMutable(speccraftDir, run.id);

  const gate = canReject(state, run);
  if (!gate.ok) throw new Error(`reject 被拒绝：${gate.reason}`);

  const feedback = input.feedback?.trim();
  if (!feedback) throw new Error('reject 必须提供反馈（--reason 或 --file）');

  const attempt = await nextAcceptanceAttempt(speccraftDir, run.id);
  const now = (input.now ?? new Date()).toISOString();
  const git = await captureGitSnapshot(projectRoot);

  const fm: AcceptanceFrontmatter = {
    kind: 'owner-acceptance',
    run_id: run.id,
    attempt,
    decision: 'rejected',
    owner: 'owner',
    created_at: now,
    verification_attempt: run.verificationAttempts,
    verification_status: 'pass',
    ...(git?.commit ? { git_commit: git.commit } : {}),
  };
  const filename = await writeAcceptanceRecord(
    speccraftDir,
    run.id,
    attempt,
    stringifyAcceptanceRecord(fm, renderAcceptanceBody('rejected', feedback)),
  );

  // 状态转换：reject 重开 implementation（历史 verification 不删除）
  setStageStatus(state, 'owner-acceptance', 'blocked');
  setStageStatus(state, 'implementation', 'in_progress');
  setStageStatus(state, 'verification', 'pending');
  state.current_stage = 'implementation';
  run.status = 'acceptance_rejected';
  run.acceptance = { attempt, status: 'rejected', latestRecord: filename };

  await writeRun(speccraftDir, run);
  await writeState(speccraftDir, state);
  void workflow;
  return { attempt };
}

/** 读取最新 verification attempt 是否 PASS */
async function latestVerificationPassed(speccraftDir: string, runId: string): Promise<boolean> {
  const attemptDir = path.join(runDir(speccraftDir, runId), 'verification');
  // 找到最大 attempt 序号
  let files: string[];
  try {
    const { readdir } = await import('node:fs/promises');
    files = (await readdir(attemptDir)).filter((f) => /^attempt-\d+\.yaml$/.test(f));
  } catch {
    return false;
  }
  if (files.length === 0) return false;
  const latest = files.sort().at(-1)!;
  try {
    const parsed = yaml.load(await readFile(path.join(attemptDir, latest), 'utf8')) as {
      passed?: unknown;
    } | null;
    return parsed?.passed === true;
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
void fileExists;
