/**
 * Task Verification Lifecycle（ADR 0006 §8）。
 *
 * PASS → task completed（解锁 dependents 由 dependency engine 在 refresh 时处理）；
 * FAIL → task failed（传递 blocked 由 dependency engine 处理）。
 * evidence 为 tasks/<task-id>/verification/attempt-NNN/，append-only。
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { taskDir, readTaskManifest, writeTaskManifest } from '../store.js';
import { runTaskVerificationCommands } from './runner.js';
import { taskVerificationAttemptDir } from './types.js';
import type { TaskVerificationAttemptManifest } from './types.js';
import type { TaskVerification } from '../types.js';

export interface VerifyTaskOptions {
  speccraftDir: string;
  projectRoot: string;
  runId: string;
  taskId: string;
  verification: TaskVerification;
  now?: Date;
}

export interface VerifyTaskResult {
  attempt: number;
  passed: boolean;
  commands: { command: string; passed: boolean }[];
  durationMs: number;
}

/** 对单个 Task 执行一次 Task Verification */
export async function verifyTask(options: VerifyTaskOptions): Promise<VerifyTaskResult> {
  const { speccraftDir, runId, taskId } = options;

  const manifest = await readTaskManifest(speccraftDir, runId, taskId);
  if (!manifest) throw new Error(`Task manifest 不存在：${taskId}`);
  if (manifest.status !== 'in_progress') {
    throw new Error(`Task ${taskId} 状态为 ${manifest.status}，只有 in_progress 可 verify`);
  }

  const attempt = await nextTaskVerificationAttempt(speccraftDir, runId, taskId);
  const startedAt = options.now?.toISOString() ?? new Date().toISOString();
  const start = Date.now();

  const runResult = await runTaskVerificationCommands({
    projectRoot: options.projectRoot,
    commands: options.verification.commands,
    timeoutSeconds: options.verification.timeoutSeconds,
  });

  const finishedAt = options.now?.toISOString() ?? new Date().toISOString();
  const durationMs = Date.now() - start;

  // 落盘 attempt evidence（append-only）
  const attemptManifest: TaskVerificationAttemptManifest = {
    attempt,
    task_id: taskId,
    passed: runResult.passed,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    timeout_seconds: options.verification.timeoutSeconds,
    commands: runResult.commands.map((c) => ({
      command: c.command,
      passed: c.passed,
      ...(c.exitCode !== undefined ? { exit_code: c.exitCode } : {}),
      duration_ms: c.durationMs,
    })),
  };

  const attemptDir = path.join(taskDir(speccraftDir, runId, taskId), 'verification', taskVerificationAttemptDir(attempt));
  await mkdir(attemptDir, { recursive: true });
  await writeFile(
    path.join(attemptDir, 'manifest.yaml'),
    yaml.dump(attemptManifest, { indent: 2, lineWidth: -1, noRefs: true }),
    'utf8',
  );
  // stdout / stderr 分开写
  const stdout = runResult.commands.map((c) => `$ ${c.command}\n${c.log}`).join('\n\n');
  const stderr = runResult.commands.filter((c) => !c.passed).map((c) => `$ ${c.command}\n${c.log}`).join('\n\n');
  await writeFile(path.join(attemptDir, 'stdout.log'), stdout, 'utf8');
  await writeFile(path.join(attemptDir, 'stderr.log'), stderr, 'utf8');

  // 更新 task manifest
  manifest.verificationAttempts = [...manifest.verificationAttempts, attempt];
  if (runResult.passed) {
    manifest.status = 'completed';
  } else {
    manifest.status = 'failed';
    manifest.lastError = `Task Verification FAIL（attempt ${attempt}）`;
  }
  await writeTaskManifest(speccraftDir, runId, manifest);

  return {
    attempt,
    passed: runResult.passed,
    commands: runResult.commands.map((c) => ({ command: c.command, passed: c.passed })),
    durationMs,
  };
}

/** 计算下一个 Task Verification attempt 序号 */
export async function nextTaskVerificationAttempt(
  speccraftDir: string,
  runId: string,
  taskId: string,
): Promise<number> {
  const dir = path.join(taskDir(speccraftDir, runId, taskId), 'verification');
  let entries: string[] = [];
  try {
    entries = (await readdir(dir)).filter((d) => /^attempt-\d+$/.test(d));
  } catch {
    entries = [];
  }
  return entries.length + 1;
}

/** 列出某 task 的 verification attempt 序号 */
export async function listTaskVerificationAttempts(
  speccraftDir: string,
  runId: string,
  taskId: string,
): Promise<number[]> {
  const dir = path.join(taskDir(speccraftDir, runId, taskId), 'verification');
  let entries: string[] = [];
  try {
    entries = (await readdir(dir)).filter((d) => /^attempt-\d+$/.test(d));
  } catch {
    return [];
  }
  return entries.map((d) => Number(d.replace('attempt-', ''))).sort((a, b) => a - b);
}
