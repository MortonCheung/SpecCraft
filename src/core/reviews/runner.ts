/**
 * Review Runner（ADR 0009 §55、§59-§63）。
 *
 * 复用 Adapter.buildInvocation / process runner / Adapter.normalize 底层能力，
 * 但 Evidence Namespace 独立，不增加 Task dispatchAttempts。
 *
 * Review Attempt 每次必须 fresh session（禁止 resume）。
 */

import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { TaskDefinition } from '../tasks/types.js';
import type { ReviewDecision, FrozenReviewGate } from './types.js';
import { parseReviewOutput, deriveReviewDecision } from './protocol.js';
import { getAdapter } from '../execution/adapters/registry.js';
import type { CliExecutionAdapter } from '../execution/adapters/types.js';

export interface RunReviewGateOptions {
  projectRoot: string;
  runDir: string;
  task: TaskDefinition;
  gate: FrozenReviewGate;
  attemptNumber: number;
  prompt: string;
  reviewWorktreePath: string;
}

export interface RunReviewGateResult {
  decision: ReviewDecision;
  attemptNumber: number;
  error?: string;
}

/**
 * 运行单个 Review Gate 的 Review Attempt。
 *
 * 1. spawn adapter（fresh session）
 * 2. collect stdout + stderr
 * 3. parse protocol block
 * 4. write findings.yaml + manifest.yaml
 */
export async function runReviewGate(options: RunReviewGateOptions): Promise<RunReviewGateResult> {
  const {
    projectRoot,
    runDir,
    task,
    gate,
    attemptNumber,
    prompt,
    reviewWorktreePath,
  } = options;

  const evidenceDir = path.join(runDir, 'tasks', task.id, 'reviews', gate.id);
  const attemptDir = path.join(evidenceDir, `attempt-${String(attemptNumber).padStart(3, '0')}`);
  await mkdir(attemptDir, { recursive: true });

  const startedAt = new Date().toISOString();

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let spawnError: string | undefined;
  let exitCode: number | null = null;

  try {
    const adapter = getAdapter(gate.adapter);
    if (!adapter || adapter.kind !== 'cli') {
      return {
        decision: 'error',
        attemptNumber,
        error: adapter ? `adapter ${gate.adapter} is not a CLI adapter` : `adapter not found: ${gate.adapter}`,
      };
    }

    const cliAdapter = adapter as CliExecutionAdapter;
    const invocation = await cliAdapter.buildInvocation({
      projectRoot: reviewWorktreePath,
      runDir: attemptDir,
      prompt,
      freshSession: true,
      model: gate.resolved.model,
      adapterConfig: gate.resolved,
    });

    const timeoutMs = (gate.resolved.timeout_seconds ?? 900) * 1000;

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>((resolve) => {
      const proc = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: { ...process.env, ...invocation.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let out = '';
      let err = '';
      let to = false;

      const timer = timeoutMs > 0 ? setTimeout(() => {
        to = true;
        proc.kill('SIGTERM');
      }, timeoutMs) : null;

      proc.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      proc.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString(); });
      proc.on('error', (err_: Error) => {
        if (timer) clearTimeout(timer);
        spawnError = err_.message;
        resolve({ stdout: out, stderr: err, exitCode: null, timedOut: false });
      });
      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout: out, stderr: err, exitCode: code, timedOut: to });
      });
    });

    stdout = result.stdout;
    stderr = result.stderr;
    timedOut = result.timedOut;
    exitCode = result.exitCode;
  } catch (err: any) {
    spawnError = err.message;
  }

  const finishedAt = new Date().toISOString();
  await writeFile(path.join(attemptDir, 'stdout.log'), stdout, 'utf8');
  await writeFile(path.join(attemptDir, 'stderr.log'), stderr, 'utf8');
  await writeFile(path.join(attemptDir, 'raw-output.txt'), stdout, 'utf8');

  const parsed = parseReviewOutput(stdout);
  let decision: ReviewDecision;
  let findingCount = 0;
  let blockingFindings = 0;
  let errorMessage: string | undefined;

  if (spawnError) {
    decision = 'error';
    errorMessage = `spawn_error: ${spawnError}`;
  } else if (timedOut) {
    decision = 'error';
    errorMessage = 'timeout: reviewer timed out';
  } else if (exitCode !== null && exitCode !== 0) {
    decision = 'error';
    errorMessage = `non_zero_exit: exit code ${exitCode}`;
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

  const manifest = {
    version: 1,
    attempt: attemptNumber,
    gate_id: gate.id,
    gate_kind: gate.kind,
    reviewer_profile: gate.reviewer,
    adapter: gate.adapter,
    decision,
    started_at: startedAt,
    finished_at: finishedAt,
    finding_count: findingCount,
    blocking_findings: blockingFindings,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  };

  await writeFile(path.join(attemptDir, 'manifest.yaml'),
    JSON.stringify(manifest, null, 2), 'utf8');

  return { decision, attemptNumber, error: errorMessage };
}

