/**
 * Verification Runner（ADR 0003 §6）。
 *
 * 行为约束：
 * - 只执行项目在 project.yaml 声明的 verification.commands（Owner 本地控制）；
 * - 使用 Node 原生 child_process.spawn()（shell: true、cwd: projectRoot），
 *   不引入 execa 等新依赖；
 * - 默认 run all：不因第一个失败丢弃后续命令的信息；
 * - 每条命令独立 timeout（默认 300 秒），超时终止子进程，不得无限挂住；
 * - 每条命令写独立 log（含 stdout / stderr），大输出不进 verification.md。
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandResult } from './types.js';

/** 执行单条命令：spawn + timeout + log 落盘 */
export async function runVerificationCommand(
  options: {
    command: string;
    cwd: string;
    timeoutMs: number;
    logFile: string;
  },
): Promise<CommandResult> {
  const startedAt = new Date().toISOString();
  const start = Date.now();

  return new Promise<CommandResult>((resolve) => {
    const child = spawn(options.command, {
      shell: true,
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: string | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // SIGTERM 后宽限 5 秒，仍不退出则 SIGKILL
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      spawnError = err.message;
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - start;

      const result: CommandResult = timedOut
        ? {
            command: options.command,
            passed: false,
            signal: signal ?? undefined,
            reason: 'timeout',
            durationMs,
            log: path.basename(options.logFile),
          }
        : spawnError
          ? {
              command: options.command,
              passed: false,
              reason: 'spawn_error',
              durationMs,
              log: path.basename(options.logFile),
            }
          : {
              command: options.command,
              passed: code === 0,
              exitCode: code ?? undefined,
              signal,
              durationMs,
              log: path.basename(options.logFile),
            };

      void writeCommandLog(options.logFile, {
        command: options.command,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: durationMs,
        exit_code: timedOut || spawnError ? null : (code ?? null),
        signal: signal ?? null,
        ...(timedOut ? { reason: 'timeout' } : {}),
        ...(spawnError ? { reason: `spawn_error: ${spawnError}` } : {}),
        stdout,
        stderr,
      }).finally(() => resolve(result));
    });
  });
}

interface CommandLogData {
  command: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  exit_code: number | null;
  signal: string | null;
  reason?: string;
  stdout: string;
  stderr: string;
}

async function writeCommandLog(logFile: string, data: CommandLogData): Promise<void> {
  await mkdir(path.dirname(logFile), { recursive: true });
  const text = [
    `command: ${data.command}`,
    `started_at: ${data.started_at}`,
    `finished_at: ${data.finished_at}`,
    `duration_ms: ${data.duration_ms}`,
    `exit_code: ${data.exit_code}`,
    `signal: ${data.signal}`,
    data.reason ? `reason: ${data.reason}` : '',
    '',
    '--- STDOUT ---',
    data.stdout,
    '',
    '--- STDERR ---',
    data.stderr,
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
  await writeFile(logFile, text, 'utf8');
}
