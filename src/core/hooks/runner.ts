/**
 * Hook Runner（ADR 0005 §10）。
 *
 * 执行项目级声明的 hook 命令：
 * - 用 child_process.spawn（shell: true，命令来自本地 project.yaml，Owner 控制）；
 * - env contract：只传最小 SPECCRAFT_* 变量，不传 Secret；
 * - 每条 hook 独立 timeout（默认 30 秒），超时 SIGTERM→SIGKILL；
 * - 写独立 log（.speccraft/runs/<run-id>/hooks/ 或 .speccraft/logs/hooks/）。
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HookDefinition, HookEnvironment, HookEvent, HookResult } from './types.js';

export interface RunHooksOptions {
  projectRoot: string;
  speccraftDir: string;
  /** run id（可空：before_prepare 等无 Run 场景） */
  runId?: string;
  event: HookEvent;
  hooks: HookDefinition[];
  /** 额外 env 变量 */
  env: HookEnvironment;
  /** 命令执行 cwd（v0.6 parallel route：isolated workspaceRoot；省略用 projectRoot） */
  workspaceRoot?: string;
  defaultTimeoutSeconds?: number;
}

export interface RunHooksOutcome {
  results: HookResult[];
  /** 是否存在失败（exit != 0 或 timeout） */
  anyFailed: boolean;
}

/** 执行一组 hook（按声明顺序）；before/after 语义由调用方决定如何处理 anyFailed */
export async function runHooks(options: RunHooksOptions): Promise<RunHooksOutcome> {
  const defaultTimeout = options.defaultTimeoutSeconds ?? 30;
  const results: HookResult[] = [];
  let anyFailed = false;

  // 自动注入 run id 到 env（调用方无需手动填 SPECCRAFT_RUN_ID / ACTIVE_RUN）
  const env: HookEnvironment = {
    ...options.env,
    ...(options.runId
      ? { SPECCRAFT_RUN_ID: options.runId, SPECCRAFT_ACTIVE_RUN: options.runId }
      : {}),
  };

  for (const hook of options.hooks) {
    const result = await runSingleHook({
      projectRoot: options.projectRoot,
      speccraftDir: options.speccraftDir,
      runId: options.runId,
      event: options.event,
      hook,
      env,
      timeoutSeconds: hook.timeout_seconds ?? defaultTimeout,
      index: results.length + 1,
      ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    });
    results.push(result);
    if (!result.passed) anyFailed = true;
  }

  return { results, anyFailed };
}

interface RunSingleOptions {
  projectRoot: string;
  speccraftDir: string;
  runId?: string;
  event: HookEvent;
  hook: HookDefinition;
  env: HookEnvironment;
  timeoutSeconds: number;
  index: number;
  /** 隔离 worktree 根目录（v0.6 parallel route）；省略用 projectRoot */
  workspaceRoot?: string;
}

async function runSingleHook(options: RunSingleOptions): Promise<HookResult> {
  const start = Date.now();
  const startedAt = new Date().toISOString();

  const logFile = await resolveHookLogPath(options);

  const proc = await new Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(options.hook.command, {
        shell: true,
        cwd: options.workspaceRoot ?? options.projectRoot,
        env: { ...process.env, ...toEnv(options.env) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, options.timeoutSeconds * 1000);

      child.stdout?.on('data', (c: Buffer) => {
        stdout += c.toString('utf8');
      });
      child.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, timedOut, stdout, stderr });
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ exitCode: null, timedOut: false, stdout, stderr });
      });
    },
  );

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - start;
  const passed = !proc.timedOut && proc.exitCode === 0;

  await mkdir(path.dirname(logFile), { recursive: true });
  await writeFile(
    logFile,
    [
      `id: ${options.hook.id}`,
      `event: ${options.event}`,
      `command: ${options.hook.command}`,
      `started_at: ${startedAt}`,
      `finished_at: ${finishedAt}`,
      `duration_ms: ${durationMs}`,
      `exit_code: ${proc.exitCode}`,
      `timed_out: ${proc.timedOut}`,
      '',
      '--- STDOUT ---',
      proc.stdout,
      '',
      '--- STDERR ---',
      proc.stderr,
      '',
    ].join('\n'),
    'utf8',
  );

  return {
    id: options.hook.id,
    event: options.event,
    passed,
    ...(proc.exitCode !== null ? { exitCode: proc.exitCode } : {}),
    timedOut: proc.timedOut,
    durationMs,
    log: path.relative(options.speccraftDir, logFile),
  };
}

async function resolveHookLogPath(options: RunSingleOptions): Promise<string> {
  if (options.runId) {
    return path.join(options.speccraftDir, 'runs', options.runId, 'hooks', `${options.event}-${String(options.index).padStart(3, '0')}.log`);
  }
  return path.join(options.speccraftDir, 'logs', 'hooks', `${options.event}-${String(options.index).padStart(3, '0')}.log`);
}

function toEnv(env: HookEnvironment): Record<string, string> {
  const out: Record<string, string> = {
    SPECCRAFT_EVENT: env.SPECCRAFT_EVENT,
    SPECCRAFT_PROJECT_ROOT: env.SPECCRAFT_PROJECT_ROOT,
    SPECCRAFT_DIR: env.SPECCRAFT_DIR,
    SPECCRAFT_STAGE: env.SPECCRAFT_STAGE,
  };
  for (const key of [
    'SPECCRAFT_ACTIVE_RUN',
    'SPECCRAFT_RUN_ID',
    'SPECCRAFT_DISPATCH_ATTEMPT',
    'SPECCRAFT_VERIFICATION_ATTEMPT',
    'SPECCRAFT_ACCEPTANCE_ATTEMPT',
    'SPECCRAFT_ADAPTER',
    'SPECCRAFT_TASK_ID',
    'SPECCRAFT_WORKSPACE_ROOT',
    'SPECCRAFT_WORKSPACE_ATTEMPT',
    'SPECCRAFT_WAVE',
  ] as const) {
    const v = env[key];
    if (v) out[key] = v;
  }
  return out;
}
