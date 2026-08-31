/**
 * Execution Run Store（ADR 0003 §4）。
 *
 * 职责边界：只负责 Run 的持久化（.speccraft/runs/<run-id>/）。
 * 不负责 AI 调用、Git 修改、Verification command 执行、状态门禁判断。
 */

import { readFile, writeFile, mkdir, access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import type { ExecutionRunManifest, ExecutionRunStatus, RunReportEntry } from './types.js';
import { isExecutionRunStatus } from './types.js';

/** .speccraft/ 下的 runs 目录名 */
export const RUNS_DIR = 'runs';
/** Run manifest 文件名 */
export const MANIFEST_FILE = 'manifest.yaml';

/** 生成稳定、可读、低碰撞的 Run ID：run-<时间戳>-<uuid 前 8 位> */
export function generateRunId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  return `run-${stamp}-${suffix}`;
}

/** Run 目录绝对路径 */
export function runDir(speccraftDir: string, runId: string): string {
  return path.join(speccraftDir, RUNS_DIR, runId);
}

/** 确保 .speccraft/runs/ 存在（旧项目运行时自动创建，不要求重新 init） */
export async function ensureRunsDir(speccraftDir: string): Promise<string> {
  const dir = path.join(speccraftDir, RUNS_DIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** 解析 manifest.yaml 文本 */
export function parseRunManifest(source: string): ExecutionRunManifest {
  const loaded = yaml.load(source);
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error('run manifest 顶层必须是对象');
  }
  const obj = loaded as Record<string, unknown>;

  const id = typeof obj.id === 'string' ? obj.id : '';
  if (!id) throw new Error('run manifest 缺少 id');
  if (!isExecutionRunStatus(obj.status)) {
    throw new Error(`run ${id} 的 status 非法: ${String(obj.status)}`);
  }

  const manifest: ExecutionRunManifest = {
    id,
    status: obj.status,
    createdAt: readStr(obj.created_at) ?? readStr(obj.createdAt) ?? '',
    updatedAt: readStr(obj.updated_at) ?? readStr(obj.updatedAt) ?? '',
    contextFile: readStr(obj.context_file) ?? readStr(obj.contextFile) ?? 'context.md',
    promptFile: readStr(obj.prompt_file) ?? readStr(obj.promptFile) ?? 'agent-prompt.md',
    reports: parseReports(obj.reports, id),
    verificationAttempts:
      typeof obj.verification_attempts === 'number' && obj.verification_attempts >= 0
        ? obj.verification_attempts
        : typeof obj.verificationAttempts === 'number' && obj.verificationAttempts >= 0
          ? obj.verificationAttempts
          : 0,
  };

  const startedAt = readStr(obj.started_at) ?? readStr(obj.startedAt);
  if (startedAt) manifest.startedAt = startedAt;
  const finishedAt = readStr(obj.finished_at) ?? readStr(obj.finishedAt);
  if (finishedAt) manifest.finishedAt = finishedAt;

  const baseGit = parseGitSnapshot(obj.base_git ?? obj.baseGit);
  if (baseGit) manifest.baseGit = baseGit;
  const finalGit = parseGitSnapshot(obj.final_git ?? obj.finalGit);
  if (finalGit) manifest.finalGit = finalGit;

  return manifest;
}

function readStr(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** 创建一个 prepared 状态的 Run（写入磁盘） */
export async function createRun(
  speccraftDir: string,
  init: {
    id?: string;
    baseGit?: ExecutionRunManifest['baseGit'];
    contextFile?: string;
    promptFile?: string;
    now?: Date;
  } = {},
): Promise<ExecutionRunManifest> {
  const now = init.now ?? new Date();
  const iso = now.toISOString();
  const dir = await ensureRunsDir(speccraftDir);
  const runId = init.id ?? generateRunId(now);

  const manifest: ExecutionRunManifest = {
    id: runId,
    status: 'prepared',
    createdAt: iso,
    updatedAt: iso,
    ...(init.baseGit ? { baseGit: init.baseGit } : {}),
    contextFile: init.contextFile ?? 'context.md',
    promptFile: init.promptFile ?? 'agent-prompt.md',
    reports: [],
    verificationAttempts: 0,
  };

  const targetDir = path.join(dir, runId);
  await mkdir(path.join(targetDir, 'verification'), { recursive: true });
  await mkdir(path.join(targetDir, 'logs'), { recursive: true });
  await writeRun(speccraftDir, manifest);
  return manifest;
}

/** 写入 manifest.yaml（immutable 字段由调用方维护） */
export async function writeRun(
  speccraftDir: string,
  manifest: ExecutionRunManifest,
): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  const file = path.join(runDir(speccraftDir, manifest.id), MANIFEST_FILE);
  await writeFile(file, stringifyRunManifest(manifest), 'utf8');
}

/** 读取一个 Run 的 manifest；不存在时抛出带上下文的错误 */
export async function readRun(speccraftDir: string, runId: string): Promise<ExecutionRunManifest> {
  const file = path.join(runDir(speccraftDir, runId), MANIFEST_FILE);
  if (!(await pathExists(file))) {
    throw new Error(`Run 不存在：${runId}（${file}）`);
  }
  return parseRunManifest(await readFile(file, 'utf8'));
}

/** 读取 active run（state.activeRun 指向的 Run）；未设置时返回 null */
export async function getActiveRun(
  speccraftDir: string,
  activeRunId: string | undefined,
): Promise<ExecutionRunManifest | null> {
  if (!activeRunId) return null;
  const file = path.join(runDir(speccraftDir, activeRunId), MANIFEST_FILE);
  if (!(await pathExists(file))) return null;
  return readRun(speccraftDir, activeRunId);
}

/** 列出全部 Run ID（按目录名排序） */
export async function listRuns(speccraftDir: string): Promise<string[]> {
  const dir = path.join(speccraftDir, RUNS_DIR);
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** 更新 run status 并写盘 */
export async function updateRunStatus(
  speccraftDir: string,
  manifest: ExecutionRunManifest,
  status: ExecutionRunStatus,
): Promise<void> {
  manifest.status = status;
  await writeRun(speccraftDir, manifest);
}

/** 追加一份报告记录（版本化文件名由调用方确定） */
export async function appendRunReport(
  speccraftDir: string,
  manifest: ExecutionRunManifest,
  entry: RunReportEntry,
): Promise<void> {
  manifest.reports.push(entry);
  await writeRun(speccraftDir, manifest);
}

/** 将 manifest 序列化为 YAML（snake_case 键以贴近用户阅读习惯） */
export function stringifyRunManifest(manifest: ExecutionRunManifest): string {
  const dumped = yaml.dump(
    {
      id: manifest.id,
      status: manifest.status,
      created_at: manifest.createdAt,
      updated_at: manifest.updatedAt,
      ...(manifest.startedAt ? { started_at: manifest.startedAt } : {}),
      ...(manifest.finishedAt ? { finished_at: manifest.finishedAt } : {}),
      ...(manifest.baseGit ? { base_git: manifest.baseGit } : {}),
      ...(manifest.finalGit ? { final_git: manifest.finalGit } : {}),
      context_file: manifest.contextFile,
      prompt_file: manifest.promptFile,
      reports: manifest.reports.map((r) => ({ file: r.file, recorded_at: r.recordedAt })),
      verification_attempts: manifest.verificationAttempts,
    },
    { indent: 2, lineWidth: -1, noRefs: true },
  );
  return dumped;
}

function parseReports(value: unknown, runId: string): RunReportEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`run ${runId} 的 reports 必须是数组`);
  return value
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    .map((v) => ({
      file: typeof v.file === 'string' ? v.file : '',
      recordedAt:
        typeof v.recorded_at === 'string'
          ? v.recorded_at
          : typeof v.recordedAt === 'string'
            ? v.recordedAt
            : '',
    }))
    .filter((r) => r.file !== '');
}

function parseGitSnapshot(value: unknown): ExecutionRunManifest['baseGit'] {
  if (typeof value !== 'object' || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  const snapshot: { branch?: string; commit?: string; dirty: boolean } = {
    dirty: obj.dirty === true,
  };
  if (typeof obj.branch === 'string' && obj.branch) snapshot.branch = obj.branch;
  if (typeof obj.commit === 'string' && obj.commit) snapshot.commit = obj.commit;
  return snapshot;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
