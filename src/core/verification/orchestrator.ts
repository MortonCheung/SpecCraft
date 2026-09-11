/**
 * Verification 编排（ADR 0003 §6）。
 *
 * speccraft verify 的核心流程：
 *   前置门禁（active_run 存在、implementation completed、commands 非空）
 *   → verification = in_progress
 *   → 按声明顺序执行全部命令（默认 run all）
 *   → 写 attempt manifest 与独立 logs
 *   → PASS：verification completed / run verified / 生成 verification.md
 *   → FAIL：verification blocked / run verification_failed /
 *           立即重开 implementation = in_progress（同一 Run 返工）
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { loadProject } from '../project.js';
import { loadProjectConfig } from '../project.js';
import { setStageStatus, writeState } from '../state/store.js';
import { readRun, updateRunStatus, runDir } from '../execution/store.js';
import { reopenImplementation } from '../execution/lifecycle.js';
import { runVerificationCommand } from './runner.js';
import { renderVerificationArtifact } from './report.js';
import { writeArtifact, readArtifact, createArtifact } from '../artifacts/store.js';
import type { CommandResult, VerificationAttempt } from './types.js';
import { assertRunMutable } from '../changes/guards.js';

export interface VerifyOptions {
  projectRoot: string;
  now?: Date;
}

export interface VerifyResult {
  runId: string;
  attempt: number;
  passed: boolean;
  commands: CommandResult[];
}

const ATTEMPT_WIDTH = 3;

/** 执行一次完整 verification attempt */
export async function verifyExecution(options: VerifyOptions): Promise<VerifyResult> {
  const { speccraftDir, workflow, state } = await loadProject(options.projectRoot);

  // ---- 前置门禁 ----
  const implStatus = state.stages['implementation']?.status;
  if (implStatus !== 'completed') {
    throw new Error(`verify 要求 implementation == completed（当前：${implStatus ?? '未记录'}）`);
  }
  const runId = state.active_run;
  if (!runId) {
    throw new Error('没有活跃的 Execution Run，但 implementation 为 completed（状态不一致）');
  }

  // v0.9 §13 / §41：Active Change Freeze 与 Superseded Run Guard（fail-before-mutation）
  await assertRunMutable(speccraftDir, runId);

  const run = await readRun(speccraftDir, runId);
  if (run.status !== 'awaiting_verification' && run.status !== 'verification_failed') {
    throw new Error(`Run ${runId} 状态为 ${run.status}，不能 verify`);
  }

  const config = await loadProjectConfig(speccraftDir);
  const commands = config.verification?.commands ?? [];
  if (commands.length === 0) {
    // 硬规则：没有验证命令时禁止假装成功
    throw new Error(
      '当前项目未配置 verification.commands。\n' +
        '请根据 Site Survey 中确认的真实验证方式配置 project.yaml。',
    );
  }
  const timeoutSeconds = config.verification?.timeoutSeconds ?? 300;

  // ---- verification = in_progress ----
  setStageStatus(state, 'verification', 'in_progress');
  state.current_stage = 'verification';
  await writeState(speccraftDir, state);

  // ---- 按声明顺序执行全部命令（run all）----
  const attemptNo = run.verificationAttempts + 1;
  const attemptTag = String(attemptNo).padStart(ATTEMPT_WIDTH, '0');
  const logsDir = path.join(runDir(speccraftDir, runId), 'logs');
  await mkdir(logsDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const results: CommandResult[] = [];
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    const logFile = path.join(logsDir, `verify-${attemptTag}-${String(i + 1).padStart(2, '0')}.log`);
    results.push(
      await runVerificationCommand({
        command,
        cwd: path.resolve(options.projectRoot),
        timeoutMs: timeoutSeconds * 1000,
        logFile,
      }),
    );
  }
  const finishedAt = new Date().toISOString();
  const passed = results.every((r) => r.passed);

  // ---- attempt manifest ----
  const attempt: VerificationAttempt = {
    attempt: attemptNo,
    startedAt,
    finishedAt,
    passed,
    commands: results,
  };
  const attemptDir = path.join(runDir(speccraftDir, runId), 'verification');
  await mkdir(attemptDir, { recursive: true });
  await writeFile(
    path.join(attemptDir, `attempt-${attemptTag}.yaml`),
    yaml.dump(
      {
        attempt: attempt.attempt,
        started_at: attempt.startedAt,
        finished_at: attempt.finishedAt,
        passed: attempt.passed,
        commands: attempt.commands.map((c) => ({
          command: c.command,
          passed: c.passed,
          ...(c.exitCode !== undefined ? { exit_code: c.exitCode } : {}),
          ...(c.signal !== undefined && c.signal !== null ? { signal: c.signal } : {}),
          ...(c.reason ? { reason: c.reason } : {}),
          duration_ms: c.durationMs,
          log: c.log,
        })),
      },
      { indent: 2, lineWidth: -1, noRefs: true },
    ),
    'utf8',
  );

  // ---- run manifest 同步 ----
  run.verificationAttempts = attemptNo;

  if (passed) {
    // ADR 0004：机器验证通过 ≠ Owner 验收。
    // verification completed 后进入 owner-acceptance = waiting_owner_approval，
    // run.status = awaiting_owner_acceptance，等待显式 ACCEPT/REJECT。
    setStageStatus(state, 'verification', 'completed');
    setStageStatus(state, 'owner-acceptance', 'waiting_owner_approval');
    state.current_stage = 'owner-acceptance';
    await updateRunStatus(speccraftDir, run, 'awaiting_owner_acceptance');
    await writeState(speccraftDir, state);

    await writeVerificationArtifact(speccraftDir, workflow.version, runId, attempt);
  } else {
    // FAIL：立即重开 implementation（同一 Run 返工，不建新 stage）
    await reopenImplementation(speccraftDir, state, run);
  }

  return { runId, attempt: attemptNo, passed, commands: results };
}

async function writeVerificationArtifact(
  speccraftDir: string,
  workflowVersion: string,
  runId: string,
  attempt: VerificationAttempt,
): Promise<void> {
  const artifactsDir = path.join(speccraftDir, 'artifacts');
  const filePath = path.join(artifactsDir, 'verification.md');

  let version = 1;
  try {
    const existing = await readArtifact(filePath);
    version = existing.frontmatter.version + 1;
  } catch {
    // 不存在 → version 1
  }

  // 历史来自 run 目录中全部 attempt 记录（不含当前这次）
  const history = await readAttemptSummaries(
    path.join(runDir(speccraftDir, runId), 'verification'),
    attempt.attempt,
  );

  const body = renderVerificationArtifact(runId, attempt, history);
  const artifact = createArtifact(
    {
      artifact: 'verification',
      stage: 'verification',
      status: 'completed',
      version,
    },
    body,
  );
  await writeArtifact(filePath, artifact);
  void workflowVersion;
}

/** 读取 run 的全部 attempt yaml，输出历史摘要（排除当前 attempt） */
async function readAttemptSummaries(
  attemptDir: string,
  excludeAttempt: number,
): Promise<{ attempt: number; passed: boolean; finishedAt: string }[]> {
  const yamlTexts: string[] = [];
  try {
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(attemptDir)).filter((f) => /^attempt-\d+\.yaml$/.test(f));
    for (const f of files) {
      yamlTexts.push(await readFileForHistory(path.join(attemptDir, f)));
    }
  } catch {
    return [];
  }

  const summaries: { attempt: number; passed: boolean; finishedAt: string }[] = [];
  for (const text of yamlTexts) {
    const parsed = yaml.load(text) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') continue;
    const no = typeof parsed.attempt === 'number' ? parsed.attempt : 0;
    if (no === 0 || no === excludeAttempt) continue;
    summaries.push({
      attempt: no,
      passed: parsed.passed === true,
      finishedAt: typeof parsed.finished_at === 'string' ? parsed.finished_at : '',
    });
  }
  return summaries.sort((a, b) => a.attempt - b.attempt);
}

async function readFileForHistory(file: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(file, 'utf8');
}
