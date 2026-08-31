/**
 * Workspace Store（ADR 0007 §8）。
 *
 * 只负责 Workspace Manifest / Wave Manifest 的 file-first 持久化。
 * Attempt 编号用 max(existing attempt) + 1（不是 entries.length + 1），
 * 避免删除/缺号后重号。
 */

import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { isWorkspaceStatus } from './types.js';
import type { ScopeAuditRecord, WaveManifest, WorkspaceManifest, WaveTaskResult } from './types.js';
import {
  attemptDir,
  waveDirName,
  wavesDir,
  workspaceEvidenceDir,
  workspaceManifestPath,
} from './paths.js';

// ---------------------------------------------------------------------------
// Workspace Manifest 序列化 / 解析
// ---------------------------------------------------------------------------

/** 序列化 WorkspaceManifest 为 manifest.yaml 文本（snake_case） */
export function stringifyWorkspaceManifest(manifest: WorkspaceManifest): string {
  const scopeAudit = manifest.scopeAudit ?? { declared: [], actual: [], passed: false, violations: [] };
  return yaml.dump(
    {
      version: manifest.version,
      run_id: manifest.runId,
      task_id: manifest.taskId,
      attempt: manifest.attempt,
      status: manifest.status,
      workspace_root: manifest.workspaceRoot,
      branch: manifest.branch,
      base_commit: manifest.baseCommit,
      created_at: manifest.createdAt,
      updated_at: manifest.updatedAt,
      dispatch_attempts: manifest.dispatchAttempts,
      verification_attempts: manifest.verificationAttempts,
      changed_paths: manifest.changedPaths,
      scope_audit: {
        declared: scopeAudit.declared,
        actual: scopeAudit.actual,
        passed: scopeAudit.passed,
        violations: scopeAudit.violations,
      },
      ...(manifest.taskCommit ? { task_commit: manifest.taskCommit } : {}),
      ...(manifest.integrationCommit ? { integration_commit: manifest.integrationCommit } : {}),
      ...(manifest.executorProfile ? { executor_profile: manifest.executorProfile } : {}),
      ...(manifest.adapter ? { adapter: manifest.adapter } : {}),
      ...(manifest.failurePhase ? { failure_phase: manifest.failurePhase } : {}),
      ...(manifest.conflictingPaths?.length ? { conflicting_paths: manifest.conflictingPaths } : {}),
      ...(manifest.lastError ? { last_error: manifest.lastError } : {}),
    },
    { indent: 2, lineWidth: -1, noRefs: true },
  );
}

/** 解析 manifest.yaml 文本 */
export function parseWorkspaceManifest(source: string): WorkspaceManifest {
  const loaded = yaml.load(source);
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error('workspace manifest 顶层必须是对象');
  }
  const obj = loaded as Record<string, unknown>;

  const version = obj.version;
  if (version !== 1) throw new Error(`workspace manifest version 必须为 1（实际 ${String(version)}）`);
  const runId = typeof obj.run_id === 'string' ? obj.run_id : '';
  if (!runId) throw new Error('workspace manifest 缺少 run_id');
  const taskId = typeof obj.task_id === 'string' ? obj.task_id : '';
  if (!taskId) throw new Error('workspace manifest 缺少 task_id');
  const attempt = typeof obj.attempt === 'number' && obj.attempt > 0 ? obj.attempt : 0;
  if (attempt === 0) throw new Error('workspace manifest 缺少合法 attempt');
  if (!isWorkspaceStatus(obj.status)) {
    throw new Error(`workspace ${attempt} 的 status 非法: ${String(obj.status)}`);
  }

  const scopeRaw = (obj.scope_audit ?? {}) as Record<string, unknown>;
  const scopeAudit: ScopeAuditRecord = {
    declared: toStrArray(scopeRaw.declared),
    actual: toStrArray(scopeRaw.actual),
    passed: scopeRaw.passed === true,
    violations: toStrArray(scopeRaw.violations),
  };

  return {
    version: 1,
    runId,
    taskId,
    attempt,
    status: obj.status,
    workspaceRoot: typeof obj.workspace_root === 'string' ? obj.workspace_root : '',
    branch: typeof obj.branch === 'string' ? obj.branch : '',
    baseCommit: typeof obj.base_commit === 'string' ? obj.base_commit : '',
    createdAt: typeof obj.created_at === 'string' ? obj.created_at : '',
    updatedAt: typeof obj.updated_at === 'string' ? obj.updated_at : '',
    dispatchAttempts: toNumArray(obj.dispatch_attempts),
    verificationAttempts: toNumArray(obj.verification_attempts),
    changedPaths: toStrArray(obj.changed_paths),
    scopeAudit,
    ...(typeof obj.task_commit === 'string' && obj.task_commit ? { taskCommit: obj.task_commit } : {}),
    ...(typeof obj.integration_commit === 'string' && obj.integration_commit
      ? { integrationCommit: obj.integration_commit }
      : {}),
    ...(typeof obj.executor_profile === 'string' && obj.executor_profile
      ? { executorProfile: obj.executor_profile }
      : {}),
    ...(typeof obj.adapter === 'string' && obj.adapter ? { adapter: obj.adapter } : {}),
    ...(typeof obj.failure_phase === 'string' && obj.failure_phase
      ? { failurePhase: obj.failure_phase }
      : {}),
    ...(Array.isArray(obj.conflicting_paths)
      ? { conflictingPaths: obj.conflicting_paths.filter((v): v is string => typeof v === 'string') }
      : {}),
    ...(typeof obj.last_error === 'string' && obj.last_error ? { lastError: obj.last_error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Workspace Store 能力（§8.4）
// ---------------------------------------------------------------------------

/** workspace evidence 目录（别名，路径规则见 paths.ts） */
export function workspaceDir(speccraftDir: string, runId: string, taskId: string): string {
  return workspaceEvidenceDir(speccraftDir, runId, taskId);
}

/** 计算下一个 Workspace Attempt 序号：max(existing) + 1 */
export async function nextWorkspaceAttempt(
  speccraftDir: string,
  runId: string,
  taskId: string,
): Promise<number> {
  const attempts = await listWorkspaceAttempts(speccraftDir, runId, taskId);
  return attempts.length === 0 ? 1 : attempts[attempts.length - 1] + 1;
}

/** 读取某个 attempt 的 Workspace Manifest；不存在返回 null */
export async function readWorkspace(
  speccraftDir: string,
  runId: string,
  taskId: string,
  attempt: number,
): Promise<WorkspaceManifest | null> {
  const file = workspaceManifestPath(speccraftDir, runId, taskId, attempt);
  if (!(await pathExists(file))) return null;
  return parseWorkspaceManifest(await readFile(file, 'utf8'));
}

/** 写入 Workspace Manifest（mkdir -p + 覆盖写 manifest.yaml） */
export async function writeWorkspace(
  speccraftDir: string,
  runId: string,
  taskId: string,
  manifest: WorkspaceManifest,
): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  const file = workspaceManifestPath(speccraftDir, runId, taskId, manifest.attempt);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringifyWorkspaceManifest(manifest), 'utf8');
}

/** 列出某 Task 的全部 Workspace Attempt 序号（递增） */
export async function listWorkspaceAttempts(
  speccraftDir: string,
  runId: string,
  taskId: string,
): Promise<number[]> {
  const dir = workspaceEvidenceDir(speccraftDir, runId, taskId);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((d) => /^attempt-\d+$/.test(d))
    .map((d) => Number(d.replace('attempt-', '')))
    .sort((a, b) => a - b);
}

/** 读取某 Task 最新的 Workspace Manifest；无则 null */
export async function readLatestWorkspace(
  speccraftDir: string,
  runId: string,
  taskId: string,
): Promise<WorkspaceManifest | null> {
  const attempts = await listWorkspaceAttempts(speccraftDir, runId, taskId);
  if (attempts.length === 0) return null;
  return readWorkspace(speccraftDir, runId, taskId, attempts[attempts.length - 1]);
}

/**
 * 判断是否有可复用的 Workspace Attempt（ADR 0007 §7.4、§16）。
 *
 * 可复用：latest 存在且尚未成功 integration 且非 conflict（created/active/
 * verified/committed/failed）→ 复用，避免无意义新建 worktree。
 * 不可复用（返回 null）：无 prior、或已 integrated/cleaned、或 integration_conflict
 * （baseline 可能已变化 → 必须新建 attempt）。
 */
export async function findReusableWorkspace(
  speccraftDir: string,
  runId: string,
  taskId: string,
): Promise<WorkspaceManifest | null> {
  const latest = await readLatestWorkspace(speccraftDir, runId, taskId);
  if (!latest) return null;
  if (latest.status === 'integrated' || latest.status === 'cleaned' || latest.status === 'integration_conflict') {
    return null;
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Wave Manifest（§8.5）
// ---------------------------------------------------------------------------

/** 序列化 WaveManifest 为 manifest.yaml 文本 */
export function stringifyWaveManifest(manifest: WaveManifest): string {
  return yaml.dump(
    {
      wave: manifest.wave,
      base_commit: manifest.baseCommit,
      max_parallel: manifest.maxParallel,
      tasks: manifest.tasks,
      ...(manifest.startedAt ? { started_at: manifest.startedAt } : {}),
      ...(manifest.finishedAt ? { finished_at: manifest.finishedAt } : {}),
      integration_order: manifest.integrationOrder,
      results: manifest.results.map((r) => ({ task_id: r.taskId, result: r.result })),
    },
    { indent: 2, lineWidth: -1, noRefs: true },
  );
}

/** 解析 WaveManifest 文本 */
export function parseWaveManifest(source: string): WaveManifest {
  const loaded = yaml.load(source);
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error('wave manifest 顶层必须是对象');
  }
  const obj = loaded as Record<string, unknown>;
  const wave = typeof obj.wave === 'number' && obj.wave > 0 ? obj.wave : 0;
  if (wave === 0) throw new Error('wave manifest 缺少合法 wave');

  const results = Array.isArray(obj.results)
    ? obj.results
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        .map((r) => ({
          taskId: typeof r.task_id === 'string' ? r.task_id : '',
          result: (typeof r.result === 'string' ? r.result : 'failed') as WaveTaskResult,
        }))
        .filter((r) => r.taskId !== '')
    : [];

  return {
    wave,
    baseCommit: typeof obj.base_commit === 'string' ? obj.base_commit : '',
    maxParallel: typeof obj.max_parallel === 'number' && obj.max_parallel > 0 ? obj.max_parallel : 1,
    tasks: toStrArray(obj.tasks),
    ...(typeof obj.started_at === 'string' ? { startedAt: obj.started_at } : {}),
    ...(typeof obj.finished_at === 'string' ? { finishedAt: obj.finished_at } : {}),
    integrationOrder: toStrArray(obj.integration_order),
    results,
  };
}

/** 读取某个 wave 的 manifest；不存在返回 null */
export async function readWaveManifest(
  speccraftDir: string,
  runId: string,
  wave: number,
): Promise<WaveManifest | null> {
  const file = path.join(wavesDir(speccraftDir, runId), waveDirName(wave), 'manifest.yaml');
  if (!(await pathExists(file))) return null;
  return parseWaveManifest(await readFile(file, 'utf8'));
}

/** 写入 wave manifest（mkdir -p + 覆盖写 manifest.yaml） */
export async function writeWaveManifest(
  speccraftDir: string,
  runId: string,
  manifest: WaveManifest,
): Promise<void> {
  const file = path.join(wavesDir(speccraftDir, runId), waveDirName(manifest.wave), 'manifest.yaml');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringifyWaveManifest(manifest), 'utf8');
}

/** 列出全部 wave 序号（递增） */
export async function listWaves(speccraftDir: string, runId: string): Promise<number[]> {
  const dir = wavesDir(speccraftDir, runId);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((d) => /^wave-\d+$/.test(d))
    .map((d) => Number(d.replace('wave-', '')))
    .sort((a, b) => a - b);
}

/** 下一个 wave 序号 */
export async function nextWave(speccraftDir: string, runId: string): Promise<number> {
  const waves = await listWaves(speccraftDir, runId);
  return waves.length === 0 ? 1 : waves[waves.length - 1] + 1;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toStrArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function toNumArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const v of value) if (typeof v === 'number') out.push(v);
  return out;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export { attemptDir };