/**
 * Review Runner（ADR 0009 §55、§59-§63）。
 *
 * 复用 Adapter.buildInvocation / process runner / Adapter.normalize 底层能力，
 * 但 Evidence Namespace 独立，不增加 Task dispatchAttempts。
 *
 * Review Attempt 每次必须 fresh session（禁止 resume）。
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { TaskDefinition } from '../tasks/types.js';
import type { ReviewDecision, FrozenReviewGate, ReviewAttemptManifest } from './types.js';
import { parseReviewOutput, deriveReviewDecision } from './protocol.js';
import { getAdapter } from '../execution/adapters/registry.js';
import type { CliExecutionAdapter } from '../execution/adapters/types.js';
import { runDispatchProcess, type DispatchProcessResult } from '../dispatch/runner.js';
import { checkReviewerMutation } from './snapshot.js';

export interface RunReviewGateOptions {
  projectRoot: string;
  runId: string;
  runDir: string;
  task: TaskDefinition;
  gate: FrozenReviewGate;
  attemptNumber: number;
  prompt: string;
  reviewWorktreePath: string;
  /** §57：Review Attempt 绑定来源 Dispatch / Verification attempt（旧 PASS 不能满足新证据） */
  sourceDispatchAttempt: number;
  sourceVerificationAttempt: number;
  preTree: string;
  postTree: string;
  preCommit: string;
  postCommit: string;
}

export interface RunReviewGateResult {
  decision: ReviewDecision;
  attemptNumber: number;
  error?: string;
}

/**
 * 运行单个 Review Gate 的 Review Attempt。
 *
 * 1. buildInvocation（fresh session，禁止 resume）
 * 2. runDispatchProcess（进程执行 + timeout → SIGTERM → SIGKILL）
 * 3. raw evidence 先落盘（stdout/stderr/raw-output）
 * 4. adapter.normalize（§9：复用 Adapter common denominator 提取 provider sessionId）
 * 5. parse protocol block + derive decision
 * 6. reviewer mutation guard（dirty / HEAD drift）→ decision=error + error_code=reviewer_mutation
 * 7. write final manifest ONCE（含 normalized session_id；manifest.decision 是最终 Runtime decision）
 */
export async function runReviewGate(options: RunReviewGateOptions): Promise<RunReviewGateResult> {
  const {
    projectRoot,
    runId,
    runDir,
    task,
    gate,
    attemptNumber,
    prompt,
    reviewWorktreePath,
    sourceDispatchAttempt,
    sourceVerificationAttempt,
    preTree,
    postTree,
    preCommit,
    postCommit,
  } = options;

  const evidenceDir = path.join(runDir, 'tasks', task.id, 'reviews', gate.id);
  const attemptDir = path.join(evidenceDir, `attempt-${String(attemptNumber).padStart(3, '0')}`);
  await mkdir(attemptDir, { recursive: true });

  const adapter = getAdapter(gate.adapter);
  if (!adapter || adapter.kind !== 'cli') {
    return {
      decision: 'error',
      attemptNumber,
      error: adapter ? `adapter ${gate.adapter} is not a CLI adapter` : `adapter not found: ${gate.adapter}`,
    };
  }
  const cliAdapter = adapter as CliExecutionAdapter;

  let proc: DispatchProcessResult | undefined;
  let buildError: string | undefined;
  try {
    const invocation = await cliAdapter.buildInvocation({
      projectRoot: reviewWorktreePath,
      runDir: attemptDir,
      prompt,
      freshSession: true,
      model: gate.resolved.model,
      adapterConfig: gate.resolved,
    });
    proc = await runDispatchProcess({ invocation });
  } catch (err: any) {
    buildError = err.message;
  }

  const stdout = proc?.stdout ?? '';
  const stderr = proc?.stderr ?? '';
  const startedAt = proc?.startedAt ?? new Date().toISOString();
  const finishedAt = proc?.finishedAt ?? new Date().toISOString();

  // raw evidence 先落盘以便保留（append-only，不覆盖历史）
  await writeFile(path.join(attemptDir, 'stdout.log'), stdout, 'utf8');
  await writeFile(path.join(attemptDir, 'stderr.log'), stderr, 'utf8');
  await writeFile(path.join(attemptDir, 'raw-output.txt'), stdout, 'utf8');

  // §9：Reviewer Provider Session 必须进入 Evidence —— 真正调用 adapter.normalize，
  // 从 normalized result 提取 sessionId 写入 manifest.session_id（复用 Dispatch 范式）。
  // normalize 失败视为 attempt 级 error（Evidence Integrity，不允许静默缺失 session）。
  let normalizedSessionId: string | undefined;
  let normalizeError: string | undefined;
  if (proc) {
    try {
      const normalized = await cliAdapter.normalize({
        projectRoot: reviewWorktreePath,
        runDir: attemptDir,
        adapterId: adapter.id,
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: proc.timedOut,
        ...(proc.spawnError ? { spawnError: proc.spawnError } : {}),
        stdout: proc.stdout,
        stderr: proc.stderr,
        startedAt: proc.startedAt,
        finishedAt: proc.finishedAt,
        durationMs: proc.durationMs,
        ...(cliAdapter.capabilities.structuredOutput && proc.stdout
          ? { rawJsonl: proc.stdout }
          : {}),
      });
      normalizedSessionId = normalized.sessionId;
    } catch (err: any) {
      normalizeError = err.message;
    }
  }

  const parsed = parseReviewOutput(stdout);
  let decision: ReviewDecision;
  let findingCount = 0;
  let blockingFindings = 0;
  let errorMessage: string | undefined;
  let errorCode: string | undefined;

  if (buildError) {
    decision = 'error';
    errorMessage = `build_invocation_error: ${buildError}`;
  } else if (proc?.spawnError) {
    decision = 'error';
    errorMessage = `spawn_error: ${proc.spawnError}`;
  } else if (proc?.timedOut) {
    decision = 'error';
    errorMessage = 'timeout: reviewer timed out';
  } else if (proc?.exitCode !== undefined && proc.exitCode !== null && proc.exitCode !== 0) {
    decision = 'error';
    errorMessage = `non_zero_exit: exit code ${proc.exitCode}`;
  } else if (!parsed) {
    decision = 'error';
    errorMessage = 'protocol_invalid: no valid speccraft-review block found';
  } else {
    if (parsed.findings.length > 0) {
      await writeFile(path.join(attemptDir, 'findings.yaml'),
        JSON.stringify(parsed.findings, null, 2), 'utf8');
    }
    findingCount = parsed.findings.length;
    blockingFindings = parsed.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major').length;
    decision = deriveReviewDecision(parsed.findings);
  }

  // §6/§7：Reviewer Mutation Guard —— 必须在写最终 manifest 之前执行。
  // 只检查 dirty（status --porcelain 非空）不够：reviewer 可 commit 后 status 变干净，
  // 因此同时核对 HEAD == postCommit（review worktree checkout 的 commit）。
  // 任何 mutation（dirty 或 HEAD drift）→ decision=error + error_code=reviewer_mutation，
  // 禁止出现“磁盘 manifest PASS + 运行时 ERROR”不一致。
  const mutationCheck = await checkReviewerMutation(reviewWorktreePath, postCommit);
  if (!mutationCheck.clean) {
    decision = 'error';
    errorCode = 'reviewer_mutation';
    errorMessage = mutationCheck.output;
  } else if (normalizeError) {
    // §9：normalize 是 Review Attempt 契约的一部分 —— 失败不得产出缺 session 的 PASS。
    decision = 'error';
    errorMessage = `normalize_failed: ${normalizeError}`;
  }

  const manifest: ReviewAttemptManifest = {
    version: 1,
    attempt: attemptNumber,
    run_id: runId,
    task_id: task.id,
    gate_id: gate.id,
    gate_kind: gate.kind,
    reviewer_profile: gate.reviewer,
    adapter: gate.adapter,
    decision,
    source_dispatch_attempt: sourceDispatchAttempt,
    source_verification_attempt: sourceVerificationAttempt,
    pre_tree: preTree,
    post_tree: postTree,
    pre_commit: preCommit,
    post_commit: postCommit,
    started_at: startedAt,
    finished_at: finishedAt,
    ...(normalizedSessionId ? { session_id: normalizedSessionId } : {}),
    finding_count: findingCount,
    blocking_findings: blockingFindings,
    ...(errorMessage ? { error_message: errorMessage } : {}),
    ...(errorCode ? { error_code: errorCode } : {}),
  };

  await writeFile(path.join(attemptDir, 'manifest.yaml'),
    JSON.stringify(manifest, null, 2), 'utf8');

  return { decision, attemptNumber, error: errorMessage };
}

