/**
 * Dispatch Process Runner（ADR 0005 §3、§4）。
 *
 * provider-neutral 进程执行器：用 child_process.spawn() 调用本地 CLI Agent。
 * - cwd = 真实项目根目录；
 * - 只继承 process.env；
 * - 支持 stdin（prompt）、stdout/stderr 流式捕获；
 * - timeout → SIGTERM → grace period → SIGKILL；
 * - 记录 spawn error / exit code / signal；
 * - 不用 exec()，避免巨大 stdout buffer。
 */

import { spawn } from 'node:child_process';
import type { AdapterInvocation } from '../execution/adapters/types.js';

export interface DispatchProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError?: string;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface DispatchProcessOptions {
  invocation: AdapterInvocation;
  /** SIGTERM 后等待的宽限毫秒（默认 5000） */
  graceMs?: number;
}

/** 执行一次 Provider CLI 调用 */
export async function runDispatchProcess(
  options: DispatchProcessOptions,
): Promise<DispatchProcessResult> {
  const { invocation } = options;
  const graceMs = options.graceMs ?? 5000;
  const startedAt = new Date().toISOString();
  const start = Date.now();

  return new Promise<DispatchProcessResult>((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: { ...process.env, ...(invocation.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: string | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, graceMs);
      killTimer.unref();
    }, invocation.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      spawnError = err.message;
    });

    // stdin 写入 prompt
    if (invocation.stdin !== undefined) {
      child.stdin?.write(invocation.stdin);
    }
    child.stdin?.end();

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const finishedAt = new Date().toISOString();
      resolve({
        exitCode: code,
        signal,
        timedOut,
        ...(spawnError ? { spawnError } : {}),
        stdout,
        stderr,
        startedAt,
        finishedAt,
        durationMs: Date.now() - start,
      });
    });
  });
}
