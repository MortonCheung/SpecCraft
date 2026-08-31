/**
 * Dispatch Store（ADR 0005 §4）。
 *
 * 负责 Dispatch Attempt 的 append-only 持久化：
 *   .speccraft/runs/<run-id>/dispatch/attempt-NNN/
 * 不负责 Provider 调用、状态门禁（那是 orchestrator / lifecycle 的事）。
 */

import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { runDir } from '../execution/store.js';
import { DISPATCH_DIR, dispatchAttemptDir, dispatchManifestFileName } from './types.js';
import type { DispatchAttemptManifest } from './types.js';

/** dispatch 目录绝对路径 */
export function dispatchDir(speccraftDir: string, runId: string): string {
  return path.join(runDir(speccraftDir, runId), DISPATCH_DIR);
}

/** 读取当前最大 dispatch attempt 序号（无则 0） */
async function maxDispatchAttempt(speccraftDir: string, runId: string): Promise<number> {
  const existing = await listDispatchAttempts(speccraftDir, runId);
  return existing.length === 0 ? 0 : existing[existing.length - 1];
}

/** 计算下一个 dispatch attempt 序号（只读估算，max+1；不用于并发写） */
export async function nextDispatchAttempt(speccraftDir: string, runId: string): Promise<number> {
  return (await maxDispatchAttempt(speccraftDir, runId)) + 1;
}

/**
 * 并发安全地预约一个 Dispatch Attempt 序号（ADR 0007 §11.1）。
 *
 * 用文件系统原子 `mkdir(candidate, { recursive: false })` 抢占目录：
 *   candidate = max(existing) + 1
 *   loop: mkdir(attempt-NNN) 成功 → reserved
 *         EEXIST → candidate++ retry
 *
 * 两个 parallel dispatch 绝不会拿到同一序号 / 写同一目录。
 */
export async function reserveDispatchAttempt(speccraftDir: string, runId: string): Promise<number> {
  const dir = dispatchDir(speccraftDir, runId);
  await mkdir(dir, { recursive: true });
  let candidate = (await maxDispatchAttempt(speccraftDir, runId)) + 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await mkdir(path.join(dir, dispatchAttemptDir(candidate)), { recursive: false });
      return candidate;
    } catch (err) {
      if (isEexist(err)) {
        candidate += 1;
        continue;
      }
      throw err;
    }
  }
}

function isEexist(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'EEXIST';
}

/** 写入一次 Dispatch Attempt 的全部证据文件 */
export async function writeDispatchAttempt(
  speccraftDir: string,
  runId: string,
  manifest: DispatchAttemptManifest,
  files: {
    stdout: string;
    stderr: string;
    raw?: string;
    events?: string;
    finalMessage?: string;
  },
): Promise<string> {
  const attemptDir = path.join(dispatchDir(speccraftDir, runId), dispatchAttemptDir(manifest.attempt));
  await mkdir(attemptDir, { recursive: true });

  await writeFile(path.join(attemptDir, manifest.stdout_file), files.stdout, 'utf8');
  await writeFile(path.join(attemptDir, manifest.stderr_file), files.stderr, 'utf8');
  if (files.raw !== undefined && manifest.raw_file) {
    await writeFile(path.join(attemptDir, manifest.raw_file), files.raw, 'utf8');
  }
  if (files.events !== undefined && manifest.events_file) {
    await writeFile(path.join(attemptDir, manifest.events_file), files.events, 'utf8');
  }
  if (files.finalMessage !== undefined && manifest.final_message_file) {
    await writeFile(path.join(attemptDir, manifest.final_message_file), files.finalMessage, 'utf8');
  }

  await writeFile(
    path.join(attemptDir, dispatchManifestFileName(manifest.attempt)),
    yaml.dump(manifest, { indent: 2, lineWidth: -1, noRefs: true }),
    'utf8',
  );
  return attemptDir;
}

/** 读取一次 Dispatch Attempt 的 manifest */
export async function readDispatchAttempt(
  speccraftDir: string,
  runId: string,
  attempt: number,
): Promise<DispatchAttemptManifest | null> {
  const file = path.join(
    dispatchDir(speccraftDir, runId),
    dispatchAttemptDir(attempt),
    dispatchManifestFileName(attempt),
  );
  if (!(await pathExists(file))) return null;
  const parsed = yaml.load(await readFile(file, 'utf8')) as Record<string, unknown>;
  return {
    attempt: typeof parsed.attempt === 'number' ? parsed.attempt : attempt,
    adapter: typeof parsed.adapter === 'string' ? parsed.adapter : '',
    status: typeof parsed.status === 'string' ? (parsed.status as DispatchAttemptManifest['status']) : 'failed',
    started_at: typeof parsed.started_at === 'string' ? parsed.started_at : '',
    ...(typeof parsed.finished_at === 'string' ? { finished_at: parsed.finished_at } : {}),
    duration_ms: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : 0,
    ...(typeof parsed.exit_code === 'number' ? { exit_code: parsed.exit_code } : {}),
    ...(typeof parsed.signal === 'string' ? { signal: parsed.signal } : {}),
    timed_out: parsed.timed_out === true,
    ...(typeof parsed.session_id === 'string' ? { session_id: parsed.session_id } : {}),
    ...(typeof parsed.task_id === 'string' ? { task_id: parsed.task_id } : {}),
    ...(typeof parsed.workspace_attempt === 'number' ? { workspace_attempt: parsed.workspace_attempt } : {}),
    ...(typeof parsed.workspace_root === 'string' ? { workspace_root: parsed.workspace_root } : {}),
    ...(Array.isArray(parsed.command) ? { command: parsed.command.map(String) } : {}),
    stdout_file: typeof parsed.stdout_file === 'string' ? parsed.stdout_file : 'stdout.log',
    stderr_file: typeof parsed.stderr_file === 'string' ? parsed.stderr_file : 'stderr.log',
    ...(typeof parsed.raw_file === 'string' ? { raw_file: parsed.raw_file } : {}),
    ...(typeof parsed.events_file === 'string' ? { events_file: parsed.events_file } : {}),
    ...(typeof parsed.final_message_file === 'string' ? { final_message_file: parsed.final_message_file } : {}),
  };
}

/** 读取最新一次 dispatch attempt 的 manifest（无则 null） */
export async function readLatestDispatchAttempt(
  speccraftDir: string,
  runId: string,
): Promise<DispatchAttemptManifest | null> {
  const attempts = await listDispatchAttempts(speccraftDir, runId);
  if (attempts.length === 0) return null;
  return readDispatchAttempt(speccraftDir, runId, attempts[attempts.length - 1]);
}

/**
 * 读取某 task + adapter 的最新 dispatch attempt 的 session id（用于 Task resume）。
 * 只按 run + task + adapter 过滤，避免 Task B resume 到 Task A 的 session。
 *
 * v0.6 parallel route：可额外按 workspaceAttempt 过滤（ADR 0007 §7.5、§11.4）。
 *   - 提供 workspaceAttempt：只匹配同一 Workspace Attempt 的 session；
 *   - 未提供（sequential/legacy）：兼容旧 evidence（无 workspace_attempt 字段）。
 */
export async function findLatestSessionForTask(
  speccraftDir: string,
  runId: string,
  taskId: string,
  adapterId: string,
  workspaceAttempt?: number,
): Promise<string | null> {
  const attempts = await listDispatchAttempts(speccraftDir, runId);
  for (let i = attempts.length - 1; i >= 0; i--) {
    const m = await readDispatchAttempt(speccraftDir, runId, attempts[i]);
    if (!m || m.task_id !== taskId || m.adapter !== adapterId || !m.session_id) continue;
    if (workspaceAttempt !== undefined) {
      if (m.workspace_attempt !== workspaceAttempt) continue;
    }
    return m.session_id;
  }
  return null;
}

/** 列出某 task 的全部 dispatch attempt 序号（按 task_id 过滤） */
export async function listDispatchAttemptsForTask(
  speccraftDir: string,
  runId: string,
  taskId: string,
): Promise<number[]> {
  const attempts = await listDispatchAttempts(speccraftDir, runId);
  const out: number[] = [];
  for (const a of attempts) {
    const m = await readDispatchAttempt(speccraftDir, runId, a);
    if (m && m.task_id === taskId) out.push(a);
  }
  return out;
}

/** 列出全部 dispatch attempt 序号（递增） */
export async function listDispatchAttempts(speccraftDir: string, runId: string): Promise<number[]> {
  const dir = dispatchDir(speccraftDir, runId);
  let entries: string[] = [];
  try {
    entries = (await readdir(dir)).filter((d) => /^attempt-\d+$/.test(d));
  } catch {
    return [];
  }
  return entries.map((d) => Number(d.replace('attempt-', ''))).sort((a, b) => a - b);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
