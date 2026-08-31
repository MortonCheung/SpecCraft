/**
 * Parallel Execute Run Lock（ADR 0007 §14.2）。
 *
 * 禁止两个 `execute --parallel` 同时控制同一个 Run。
 * 使用文件系统原子 `open(..., 'wx')` 创建：
 *   .speccraft/runs/<run>/locks/execute.lock
 *
 * - 正常退出：finally remove lock；
 * - 已有 lock：fail clearly（不静默抢占）；
 * - stale 检测：same host + pid 不存在 → 报告 stale，供人工清理
 *   （不自动删除一个仍活跃进程的 lock）。
 */

import { open, readFile, rm, access, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface AcquireRunLockOptions {
  speccraftDir: string;
  runId: string;
  mode?: string;
}

export interface RunLockHandle {
  lockPath: string;
  release: () => Promise<void>;
}

/** 获取 run lock；已存在时抛出明确错误（含 stale 判断信息） */
export async function acquireRunLock(options: AcquireRunLockOptions): Promise<RunLockHandle> {
  const dir = path.join(options.speccraftDir, 'runs', options.runId, 'locks');
  const lockPath = path.join(dir, 'execute.lock');

  // run 目录可能尚无 locks/（首次 execute）——先确保目录存在（recursive 幂等）
  await mkdir(dir, { recursive: true });

  try {
    const handle = await open(lockPath, 'wx');
    const pid = process.pid;
    const hostname = os.hostname();
    const startedAt = new Date().toISOString();
    const mode = options.mode ?? 'parallel';
    await handle.writeFile(
      [
        `pid: ${pid}`,
        `hostname: ${hostname}`,
        `mode: ${mode}`,
        `started_at: ${startedAt}`,
        '',
      ].join('\n'),
      'utf8',
    );
    await handle.close();

    return {
      lockPath,
      release: async () => {
        await rm(lockPath, { force: true });
      },
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const info = await readLockInfo(lockPath);
      const stale = info ? await isStaleLock(info) : false;
      if (stale) {
        throw new Error(
          `Run ${options.runId} 已有 execute.lock（STALE：pid ${info!.pid}@${info!.hostname} 已不存在）。` +
            `请人工确认后删除 ${lockPath} 再重试`,
        );
      }
      throw new Error(
        `Run ${options.runId} 已有 execute.lock（${info ? `pid ${info.pid}@${info.hostname}` : '未知持有者'}，` +
          `mode ${info?.mode ?? '?'}，started ${info?.startedAt ?? '?'}）。禁止并行控制同一 Run`,
      );
    }
    throw err;
  }
}

interface LockInfo {
  pid: number;
  hostname: string;
  mode: string;
  startedAt: string;
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
  try {
    const source = await readFile(lockPath, 'utf8');
    const map = new Map<string, string>();
    for (const line of source.split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) map.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
    }
    const pid = Number(map.get('pid'));
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      hostname: map.get('hostname') ?? '',
      mode: map.get('mode') ?? '',
      startedAt: map.get('started_at') ?? '',
    };
  } catch {
    return null;
  }
}

/** same host 且 pid 不再存在 → stale（绝不误删活跃进程的 lock，仅报告） */
async function isStaleLock(info: LockInfo): Promise<boolean> {
  if (info.hostname !== os.hostname()) return false;
  try {
    // signal 0 只做存在性探测
    process.kill(info.pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** lock 是否存在（诊断用） */
export async function runLockExists(speccraftDir: string, runId: string): Promise<boolean> {
  const lockPath = path.join(speccraftDir, 'runs', runId, 'locks', 'execute.lock');
  try {
    await access(lockPath);
    return true;
  } catch {
    return false;
  }
}
