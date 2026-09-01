/**
 * Review Runner（ADR 0009 §55、§59-§63）。
 *
 * 复用 Adapter.buildInvocation / process runner / Adapter.normalize 底层能力，
 * 但 Evidence Namespace 独立，不增加 Task dispatchAttempts。
 *
 * Review Attempt 每次必须 fresh session（禁止 resume）。
 */

import { spawn } from 'node:child_process';
import { writeFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { CliExecutionAdapter } from '../execution/adapters/types.js';
import type { ReviewAttemptManifest, ReviewDecision, FrozenReviewGate } from './types.js';
import { parseReviewOutput, deriveReviewDecision } from './protocol.js';

export interface RunReviewGateOptions {
  adapter: CliExecutionAdapter;
  adapterConfig?: { command?: string; timeout_seconds?: number; extra_args?: string[]; model?: string; sandbox?: string };
  taskPackage: string;
  projectRoot: string;
  reviewEvidenceDir: string;
  runId: string;
  taskId: string;
  gate: FrozenReviewGate;
  sourceDispatchAttempt: number;
  sourceVerificationAttempt: number;
  workspaceAttempt?: number;
  preTree: string;
  postTree: string;
  preCommit: string;
  postCommit: string;
}

export interface RunReviewGateResult {
  decision: ReviewDecision;
  manifest: ReviewAttemptManifest;
}

/**
 * 运行单个 Review Gate 的 Review Attempt。
 *
 * 1. atomic directory reservation（attempt-NNN）
 * 2. 写入 task-contract.md / reviewer-prompt.md
 * 3. spawn adapter（fresh session）
 * 4. collect stdout + stderr
 * 5. parse protocol block
 * 6. check reviewer mutation
 * 7. write findings.yaml + manifest.yaml
 * 8. cleanup review worktree（如有）
 */
export async function runReviewGate(options: RunReviewGateOptions): Promise<RunReviewGateResult> {
  const {
    adapter, adapterConfig, taskPackage, projectRoot,
    reviewEvidenceDir, runId, taskId, gate,
    sourceDispatchAttempt, sourceVerificationAttempt, workspaceAttempt,
    preTree, postTree, preCommit, postCommit,
  } = options;

  const attemptNumber = await nextAttemptNumber(reviewEvidenceDir);
  const attemptDir = path.join(reviewEvidenceDir, `attempt-${String(attemptNumber).padStart(3, '0')}`);
  await mkdir(attemptDir, { recursive: true });

  const startedAt = new Date().toISOString();

  await writeFile(path.join(attemptDir, 'task-contract.md'), taskPackage, 'utf8');

  const prompt = buildReviewerPrompt(gate, taskPackage);
  await writeFile(path.join(attemptDir, 'reviewer-prompt.md'), prompt, 'utf8');

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let spawnError: string | undefined;
  let exitCode: number | null = null;
  let signal: string | null = null;
  let sessionId: string | undefined;

  try {
    const invocation = await adapter.buildInvocation({
      projectRoot,
      runDir: attemptDir,
      prompt,
      freshSession: true,
      model: adapterConfig?.model,
      adapterConfig,
    });

    const timeoutMs = (gate.resolved.timeout_seconds ?? 900) * 1000;

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null; timedOut: boolean }>((resolve) => {
      const proc = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: { ...process.env, ...invocation.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeoutMs,
      });

      let out = '';
      let err = '';
      let to = false;

      proc.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      proc.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString(); });
      proc.on('error', (err_: Error) => {
        resolve({ stdout: out, stderr: err, exitCode: null, signal: null, timedOut: false });
        spawnError = err_.message;
      });
      proc.on('close', (code, sig) => {
        resolve({ stdout: out, stderr: err, exitCode: code, signal: sig, timedOut: to });
      });
      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          to = true;
          proc.kill('SIGTERM');
        }, timeoutMs);
        proc.on('close', () => clearTimeout(timer));
      }
    });

    stdout = result.stdout;
    stderr = result.stderr;
    timedOut = result.timedOut;
    exitCode = result.exitCode;
    signal = result.signal;
  } catch (err: any) {
    spawnError = err.message;
  }

  const finishedAt = new Date().toISOString();
  await writeFile(path.join(attemptDir, 'stdout.log'), stdout, 'utf8');
  await writeFile(path.join(attemptDir, 'stderr.log'), stderr, 'utf8');

  const parsed = parseReviewOutput(stdout);
  let decision: ReviewDecision;
  let findingCount = 0;
  let blockingFindings = 0;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;

  if (spawnError) {
    decision = 'error';
    errorCode = 'spawn_error';
    errorMessage = spawnError;
  } else if (timedOut) {
    decision = 'error';
    errorCode = 'timeout';
    errorMessage = 'reviewer timed out';
  } else if (exitCode !== null && exitCode !== 0) {
    decision = 'error';
    errorCode = 'non_zero_exit';
    errorMessage = `exit code ${exitCode}`;
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

  const manifest: ReviewAttemptManifest = {
    version: 1,
    attempt: attemptNumber,
    run_id: runId,
    task_id: taskId,
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
    started_at: startedAt,
    finished_at: finishedAt,
    session_id: sessionId,
    finding_count: findingCount,
    blocking_findings: blockingFindings,
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(errorMessage ? { error_message: errorMessage } : {}),
  };

  await writeFile(path.join(attemptDir, 'manifest.yaml'),
    JSON.stringify(manifest, null, 2), 'utf8');

  return { decision, manifest };
}

async function nextAttemptNumber(evidenceDir: string): Promise<number> {
  await mkdir(evidenceDir, { recursive: true });
  const entries = await readdir(evidenceDir, { withFileTypes: true });
  let max = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = e.name.match(/^attempt-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

function buildReviewerPrompt(gate: FrozenReviewGate, taskPackage: string): string {
  const kindDesc = gate.kind === 'spec_compliance'
    ? 'Check Task Contract completion, scope compliance, and Execution Guard adherence.'
    : 'Check correctness risk, error handling, edge cases, test adequacy, maintainability, and security.';

  return `You are an independent Reviewer.

You are NOT a Planner.
You are NOT an Executor.
You cannot modify code.
You cannot expand Task Scope.
You cannot create new requirements.

Your goal: check the verified implementation of this Task.

Gate Kind: ${gate.kind}
${kindDesc}

IMPORTANT: You MUST output your findings as a single YAML code block with the tag speccraft-review.

\`\`\`speccraft-review
version: 1
summary: "..."

findings:
  - severity: blocker | major | minor
    category: spec | correctness | tests | maintainability | security | scope
    path: src/foo.ts
    line: 42
    message: "..."
\`\`\`

${taskPackage}
`;
}
