/**
 * Review Runner（ADR 0009 §55、§59-§63）。
 *
 * 复用 Adapter.buildInvocation / process runner / Adapter.normalize 底层能力，
 * 但 Evidence Namespace 独立，不增加 Task dispatchAttempts。
 *
 * Review Attempt 每次必须 fresh session（禁止 resume）。
 *
 * v0.8（§13）：before_review 是 blocking hook —— review package 已备好、invocation
 * 未执行时触发；失败 → Review 不执行（无 Reviewer Provider 调用）、decision=error、
 * error_code=before_review_hook_failed。after_review 是 non-rollback hook ——
 * final decision 与 Evidence 落盘后触发；失败只 warning，不改写历史 decision。
 *
 * v0.8（§14）：错误必须结构化 error_code + error_message（禁止只把 code 埋进字符串）；
 * parallel Review Attempt 必须写 workspace_attempt。
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { TaskDefinition } from '../tasks/types.js';
import type { HookConfig, HookEnvironment } from '../hooks/types.js';
import { runBeforeHooks, runAfterHooks } from '../hooks/lifecycle.js';
import type { ReviewDecision, FrozenReviewGate, ReviewAttemptManifest } from './types.js';
import { parseReviewOutput, deriveReviewDecision } from './protocol.js';
import { getAdapter } from '../execution/adapters/registry.js';
import type { CliExecutionAdapter } from '../execution/adapters/types.js';
import { runDispatchProcess, type DispatchProcessResult } from '../dispatch/runner.js';
import { checkReviewerMutation } from './snapshot.js';

export interface RunReviewGateOptions {
  projectRoot: string;
  speccraftDir: string;
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
  /** §13：review hooks（before_review blocking / after_review non-rollback） */
  hooks?: HookConfig;
  /** §13.3：parallel 附加 env（SPECCRAFT_WORKSPACE_ROOT / WORKSPACE_ATTEMPT / WAVE 等） */
  hookEnv?: Record<string, string>;
  /** §14：parallel Review Attempt manifest 必须写 workspace_attempt（sequential 可 absent） */
  workspaceAttempt?: number;
}

export interface RunReviewGateResult {
  decision: ReviewDecision;
  attemptNumber: number;
  error?: string;
}

/**
 * 运行单个 Review Gate 的 Review Attempt。
 *
 * 1. before_review hook（blocking；package prepared → invocation 之前）
 * 2. buildInvocation（fresh session，禁止 resume）
 * 3. runDispatchProcess（进程执行 + timeout → SIGTERM → SIGKILL）
 * 4. raw evidence 先落盘（stdout/stderr/raw-output）
 * 5. adapter.normalize（§9：复用 Adapter common denominator 提取 provider sessionId）
 * 6. parse protocol block + derive decision
 * 7. reviewer mutation guard（dirty / HEAD drift）→ decision=error + error_code=reviewer_mutation
 * 8. write final manifest ONCE（含 normalized session_id；manifest.decision 是最终 Runtime decision）
 * 9. after_review hook（non-rollback，失败只 warning）
 */
export async function runReviewGate(options: RunReviewGateOptions): Promise<RunReviewGateResult> {
  const {
    projectRoot,
    speccraftDir,
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
    hooks,
    hookEnv,
    workspaceAttempt,
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

  /** §13.3：review hook env（SPECCRAFT_REVIEW_GATE / ATTEMPT / REVIEWER_PROFILE 等） */
  const hookCtx = (event: string, extra?: Record<string, string>) => ({
    projectRoot,
    speccraftDir,
    runId,
    env: {
      SPECCRAFT_EVENT: event,
      SPECCRAFT_PROJECT_ROOT: projectRoot,
      SPECCRAFT_DIR: speccraftDir,
      SPECCRAFT_STAGE: 'implementation',
      SPECCRAFT_ADAPTER: gate.adapter,
      SPECCRAFT_TASK_ID: task.id,
      SPECCRAFT_REVIEW_GATE: gate.id,
      SPECCRAFT_REVIEW_ATTEMPT: String(attemptNumber),
      SPECCRAFT_REVIEWER_PROFILE: gate.reviewer,
      ...(hookEnv ?? {}),
      ...(extra ?? {}),
    } as HookEnvironment,
  });

  // §13.1：before_review blocking hook —— 失败则 Review 不执行（不调用 Reviewer Provider），
  // decision=error + error_code=before_review_hook_failed（结构化，不埋进字符串）。
  if (hooks) {
    const before = await runBeforeHooks(hookCtx('before_review'), hooks, 'before_review');
    if (before.blocked) {
      const errorMessage = `before_review hook failed（见 .speccraft/.../hooks/before_review-*.log）`;
      const manifest: ReviewAttemptManifest = buildManifest({
        runId,
        task,
        gate,
        attemptNumber,
        sourceDispatchAttempt,
        sourceVerificationAttempt,
        preTree,
        postTree,
        preCommit,
        postCommit,
        workspaceAttempt,
        decision: 'error',
        findingCount: 0,
        blockingFindings: 0,
        errorCode: 'before_review_hook_failed',
        errorMessage,
      });
      await writeFile(path.join(attemptDir, 'manifest.yaml'), JSON.stringify(manifest, null, 2), 'utf8');
      return { decision: 'error', attemptNumber, error: errorMessage };
    }
  }

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
  let errorCode: string | undefined;
  let errorMessage: string | undefined;

  // §14：错误必须结构化 —— error_code 单独成字段，error_message 只放细节，不把 code 埋进字符串。
  if (buildError) {
    decision = 'error';
    errorCode = 'build_invocation_error';
    errorMessage = `buildInvocation failed: ${buildError}`;
  } else if (proc?.spawnError) {
    decision = 'error';
    errorCode = 'spawn_error';
    errorMessage = proc.spawnError;
  } else if (proc?.timedOut) {
    decision = 'error';
    errorCode = 'timeout';
    errorMessage = 'reviewer timed out';
  } else if (proc?.exitCode !== undefined && proc.exitCode !== null && proc.exitCode !== 0) {
    decision = 'error';
    errorCode = 'non_zero_exit';
    errorMessage = `reviewer exited with code ${proc.exitCode}`;
  } else if (!parsed) {
    decision = 'error';
    errorCode = 'protocol_invalid';
    errorMessage = 'no valid speccraft-review block found';
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
    errorCode = 'normalize_failed';
    errorMessage = normalizeError;
  }

  const manifest: ReviewAttemptManifest = buildManifest({
    runId,
    task,
    gate,
    attemptNumber,
    sourceDispatchAttempt,
    sourceVerificationAttempt,
    preTree,
    postTree,
    preCommit,
    postCommit,
    workspaceAttempt,
    decision,
    findingCount,
    blockingFindings,
    sessionId: normalizedSessionId,
    errorCode,
    errorMessage,
    startedAt,
    finishedAt,
  });
  await writeFile(path.join(attemptDir, 'manifest.yaml'), JSON.stringify(manifest, null, 2), 'utf8');

  // §13.2：after_review non-rollback hook —— final decision + Evidence 已落盘之后。
  // 失败只 warning：不能 PASS → ERROR，也不能改写历史 decision。
  if (hooks) {
    const after = await runAfterHooks(
      hookCtx('after_review', { SPECCRAFT_REVIEW_DECISION: decision }),
      hooks,
      'after_review',
    );
    if (after?.anyFailed) {
      console.warn(`[review] after_review hook warning（task ${task.id}, gate ${gate.id}, attempt ${attemptNumber}）：见 .speccraft/.../hooks/after_review-*.log`);
    }
  }

  return { decision, attemptNumber, error: errorMessage };
}

/** 构造 Review Attempt Manifest（single source of truth；§14 结构化 error_code/error_message） */
function buildManifest(input: {
  runId: string;
  task: TaskDefinition;
  gate: FrozenReviewGate;
  attemptNumber: number;
  sourceDispatchAttempt: number;
  sourceVerificationAttempt: number;
  preTree: string;
  postTree: string;
  preCommit: string;
  postCommit: string;
  workspaceAttempt?: number;
  decision: ReviewDecision;
  findingCount: number;
  blockingFindings: number;
  sessionId?: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
}): ReviewAttemptManifest {
  const {
    runId,
    task,
    gate,
    attemptNumber,
    sourceDispatchAttempt,
    sourceVerificationAttempt,
    preTree,
    postTree,
    preCommit,
    postCommit,
    workspaceAttempt,
    decision,
    findingCount,
    blockingFindings,
    sessionId,
    errorCode,
    errorMessage,
    startedAt,
    finishedAt,
  } = input;
  const now = new Date().toISOString();
  return {
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
    ...(workspaceAttempt !== undefined ? { workspace_attempt: workspaceAttempt } : {}),
    pre_tree: preTree,
    post_tree: postTree,
    pre_commit: preCommit,
    post_commit: postCommit,
    started_at: startedAt ?? now,
    finished_at: finishedAt ?? now,
    ...(sessionId ? { session_id: sessionId } : {}),
    finding_count: findingCount,
    blocking_findings: blockingFindings,
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(errorMessage ? { error_message: errorMessage } : {}),
  };
}
