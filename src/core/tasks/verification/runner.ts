/**
 * Task Verification Runner（ADR 0006 §8）。
 *
 * 执行 Task Definition 的 verification.commands（Node 原生 spawn）。
 * 禁止 execa / AI verification / Provider SDK。
 */

import { spawn } from 'node:child_process';
import type { TaskVerificationCommandResult } from './types.js';

export interface RunTaskVerificationCommandsOptions {
  projectRoot: string;
  commands: string[];
  timeoutSeconds: number;
}

export interface RunTaskVerificationCommandsResult {
  commands: TaskVerificationCommandResult[];
  passed: boolean;
  durationMs: number;
}

/** 顺序执行全部命令；任一失败即 passed=false */
export async function runTaskVerificationCommands(
  options: RunTaskVerificationCommandsOptions,
): Promise<RunTaskVerificationCommandsResult> {
  const start = Date.now();
  const results: TaskVerificationCommandResult[] = [];
  let passed = true;

  for (const command of options.commands) {
    const r = await runOneCommand(options.projectRoot, command, options.timeoutSeconds);
    results.push(r);
    if (!r.passed) passed = false;
  }

  return { commands: results, passed, durationMs: Date.now() - start };
}

async function runOneCommand(
  projectRoot: string,
  command: string,
  timeoutSeconds: number,
): Promise<TaskVerificationCommandResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: projectRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, timeoutSeconds * 1000);

    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const passed = !timedOut && code === 0;
      resolve({
        command,
        passed,
        ...(code !== null ? { exitCode: code } : {}),
        durationMs,
        log: [stdout, stderr].filter(Boolean).join('\n').trim(),
      });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({
        command,
        passed: false,
        durationMs: Date.now() - start,
        log: stderr,
      });
    });
  });
}
