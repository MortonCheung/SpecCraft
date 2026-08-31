/**
 * Acceptance Store（ADR 0004 §5）。
 *
 * 职责边界：只负责 Acceptance Record 的持久化与读取。
 * 不负责状态机业务（那是 lifecycle.ts 的事）、不负责 Markdown 渲染（report.ts）。
 */

import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acceptanceFileName, isAcceptanceDecision } from './types.js';
import type { AcceptanceRecord } from './types.js';
import { parseAcceptanceRecord } from './report.js';
import { runDir } from '../execution/store.js';

/** run 内 acceptance 目录相对路径 */
export const ACCEPTANCE_DIR = 'acceptance';

/** acceptance 目录绝对路径 */
export function acceptanceDir(speccraftDir: string, runId: string): string {
  return path.join(runDir(speccraftDir, runId), ACCEPTANCE_DIR);
}

/** 确保 acceptance 目录存在 */
async function ensureAcceptanceDir(speccraftDir: string, runId: string): Promise<string> {
  const dir = acceptanceDir(speccraftDir, runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** 读取一个 Acceptance Record；不存在时抛错 */
export async function readAcceptanceRecord(
  speccraftDir: string,
  runId: string,
  filename: string,
): Promise<AcceptanceRecord> {
  const file = path.join(acceptanceDir(speccraftDir, runId), filename);
  if (!(await pathExists(file))) {
    throw new Error(`acceptance record 不存在：${filename}`);
  }
  const parsed = parseAcceptanceRecord(await readFile(file, 'utf8'));
  parsed.filename = path.join(ACCEPTANCE_DIR, filename);
  return parsed;
}

/** 列出全部 acceptance record（按文件名稳定排序） */
export async function listAcceptanceRecords(
  speccraftDir: string,
  runId: string,
): Promise<AcceptanceRecord[]> {
  const dir = acceptanceDir(speccraftDir, runId);
  if (!(await pathExists(dir))) return [];
  const files = (await readdir(dir))
    .filter((f) => /^acceptance-\d+\.md$/.test(f))
    .sort();
  const records: AcceptanceRecord[] = [];
  for (const f of files) {
    try {
      records.push(await readAcceptanceRecord(speccraftDir, runId, f));
    } catch {
      // 跳过损坏 record，不阻塞整体历史读取
    }
  }
  return records;
}

/** 读取最近一次 acceptance record；没有则返回 null */
export async function readLatestAcceptance(
  speccraftDir: string,
  runId: string,
): Promise<AcceptanceRecord | null> {
  const records = await listAcceptanceRecords(speccraftDir, runId);
  if (records.length === 0) return null;
  return records[records.length - 1];
}

/** 计算下一个 attempt 序号（已有 records 数 + 1） */
export async function nextAcceptanceAttempt(speccraftDir: string, runId: string): Promise<number> {
  const records = await listAcceptanceRecords(speccraftDir, runId);
  return records.length + 1;
}

/** 写入一条 Acceptance Record；返回相对 run 目录的文件名 */
export async function writeAcceptanceRecord(
  speccraftDir: string,
  runId: string,
  attempt: number,
  source: string,
): Promise<string> {
  await ensureAcceptanceDir(speccraftDir, runId);
  const filename = acceptanceFileName(attempt);
  const file = path.join(acceptanceDir(speccraftDir, runId), filename);
  if (await pathExists(file)) {
    throw new Error(`acceptance record 已存在，禁止覆盖：${filename}`);
  }
  await writeFile(file, source, 'utf8');
  return path.join(ACCEPTANCE_DIR, filename);
}

/** 判定两条 decision 是否代表「已 accepted」 */
export function isAcceptedDecision(decision: string): boolean {
  return isAcceptanceDecision(decision) && decision === 'accepted';
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
