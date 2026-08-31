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

/** 计算下一个 dispatch attempt 序号 */
export async function nextDispatchAttempt(speccraftDir: string, runId: string): Promise<number> {
  const dir = dispatchDir(speccraftDir, runId);
  let entries: string[] = [];
  try {
    entries = (await readdir(dir)).filter((d) => /^attempt-\d+$/.test(d));
  } catch {
    entries = [];
  }
  return entries.length + 1;
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
  const next = await nextDispatchAttempt(speccraftDir, runId);
  if (next <= 1) return null;
  return readDispatchAttempt(speccraftDir, runId, next - 1);
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
