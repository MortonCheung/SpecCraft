/**
 * Run Lineage / Materialization / Supersession Evidence（SpecCraft v0.9 §38–§39，ADR 0010）。
 *
 *   runs/<successor>/lineage.yaml          ← predecessor_run / change_id /
 *                                            approved_analysis_attempt / created_at
 *   changes/<change-id>/materialization.yaml ← successor_run（反向记录）
 *   runs/<predecessor>/superseded.yaml     ← change_id / successor_run / superseded_at
 *
 * lineage 与 materialization 必须互相一致（§38）；三者都是 append-only evidence。
 * 本模块只做读写、解析与一致性判定，不判断 Change 状态机。
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { runDir } from '../execution/store.js';
import { changeDir } from './store.js';

/** successor Run 下的血缘文件名 */
export const LINEAGE_FILE = 'lineage.yaml';
/** Change 下的 materialization 文件名 */
export const MATERIALIZATION_FILE = 'materialization.yaml';
/** predecessor Run 下的 supersession 文件名 */
export const SUPERSEDED_FILE = 'superseded.yaml';

/** `.speccraft/runs/<successor>/lineage.yaml`（v0.9 §38） */
export interface RunLineage {
  predecessor_run: string;
  change_id: string;
  /**
   * 被批准的 Analysis Attempt id（如 `attempt-002`）。
   * §38 示例写作数字 `2`；运行时以 Attempt id 字符串为准（目录名 / analysis.yaml / approval.yaml 一致）。
   */
  approved_analysis_attempt: string;
  created_at: string;
}

/** `.speccraft/changes/<change-id>/materialization.yaml`（v0.9 §38 反向记录） */
export interface ChangeMaterialization {
  change_id: string;
  successor_run: string;
  approved_analysis_attempt: string;
  created_at: string;
}

/** `.speccraft/runs/<predecessor>/superseded.yaml`（v0.9 §39） */
export interface RunSupersession {
  change_id: string;
  successor_run: string;
  superseded_at: string;
}

export function lineagePath(speccraftDir: string, runId: string): string {
  return path.join(runDir(speccraftDir, runId), LINEAGE_FILE);
}

export function materializationPath(speccraftDir: string, changeId: string): string {
  return path.join(changeDir(speccraftDir, changeId), MATERIALIZATION_FILE);
}

export function supersededPath(speccraftDir: string, runId: string): string {
  return path.join(runDir(speccraftDir, runId), SUPERSEDED_FILE);
}

// ---------------------------------------------------------------------------
// Attempt id 归一化（§38）
// ---------------------------------------------------------------------------

/**
 * 归一化 `approved_analysis_attempt`：
 * 字符串原样保留（`attempt-002`）；数字（§38 示例写法）补齐为 Attempt id。
 */
export function normalizeAttemptId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return `attempt-${String(value).padStart(3, '0')}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Run Lineage
// ---------------------------------------------------------------------------

export function stringifyRunLineage(lineage: RunLineage): string {
  return yaml.dump(
    {
      predecessor_run: lineage.predecessor_run,
      change_id: lineage.change_id,
      approved_analysis_attempt: lineage.approved_analysis_attempt,
      created_at: lineage.created_at,
    },
    { indent: 2, lineWidth: -1, noRefs: true },
  );
}

export function parseRunLineage(source: string): RunLineage {
  const obj = loadObject(source, 'lineage.yaml');
  const predecessor = readStr(obj.predecessor_run ?? obj.predecessorRun);
  if (!predecessor) throw new Error('lineage.yaml 缺少 predecessor_run');
  const changeId = readStr(obj.change_id ?? obj.changeId);
  if (!changeId) throw new Error('lineage.yaml 缺少 change_id');
  const attempt = normalizeAttemptId(obj.approved_analysis_attempt ?? obj.approvedAnalysisAttempt);
  if (!attempt) throw new Error('lineage.yaml 缺少 approved_analysis_attempt');
  return {
    predecessor_run: predecessor,
    change_id: changeId,
    approved_analysis_attempt: attempt,
    created_at: readStr(obj.created_at ?? obj.createdAt) ?? '',
  };
}

export async function readRunLineageOrNull(
  speccraftDir: string,
  runId: string,
): Promise<RunLineage | null> {
  const file = lineagePath(speccraftDir, runId);
  if (!(await pathExists(file))) return null;
  return parseRunLineage(await readFile(file, 'utf8'));
}

export async function writeRunLineage(
  speccraftDir: string,
  runId: string,
  lineage: RunLineage,
): Promise<void> {
  await mkdir(runDir(speccraftDir, runId), { recursive: true });
  await writeFile(lineagePath(speccraftDir, runId), stringifyRunLineage(lineage), 'utf8');
}

// ---------------------------------------------------------------------------
// Change Materialization
// ---------------------------------------------------------------------------

export function stringifyChangeMaterialization(materialization: ChangeMaterialization): string {
  return yaml.dump(
    {
      change_id: materialization.change_id,
      successor_run: materialization.successor_run,
      approved_analysis_attempt: materialization.approved_analysis_attempt,
      created_at: materialization.created_at,
    },
    { indent: 2, lineWidth: -1, noRefs: true },
  );
}

export function parseChangeMaterialization(source: string): ChangeMaterialization {
  const obj = loadObject(source, 'materialization.yaml');
  const changeId = readStr(obj.change_id ?? obj.changeId);
  if (!changeId) throw new Error('materialization.yaml 缺少 change_id');
  const successor = readStr(obj.successor_run ?? obj.successorRun);
  if (!successor) throw new Error('materialization.yaml 缺少 successor_run');
  const attempt = normalizeAttemptId(obj.approved_analysis_attempt ?? obj.approvedAnalysisAttempt);
  if (!attempt) throw new Error('materialization.yaml 缺少 approved_analysis_attempt');
  return {
    change_id: changeId,
    successor_run: successor,
    approved_analysis_attempt: attempt,
    created_at: readStr(obj.created_at ?? obj.createdAt) ?? '',
  };
}

export async function readChangeMaterializationOrNull(
  speccraftDir: string,
  changeId: string,
): Promise<ChangeMaterialization | null> {
  const file = materializationPath(speccraftDir, changeId);
  if (!(await pathExists(file))) return null;
  return parseChangeMaterialization(await readFile(file, 'utf8'));
}

export async function writeChangeMaterialization(
  speccraftDir: string,
  changeId: string,
  materialization: ChangeMaterialization,
): Promise<void> {
  await mkdir(changeDir(speccraftDir, changeId), { recursive: true });
  await writeFile(
    materializationPath(speccraftDir, changeId),
    stringifyChangeMaterialization(materialization),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Run Supersession
// ---------------------------------------------------------------------------

export function stringifyRunSupersession(supersession: RunSupersession): string {
  return yaml.dump(
    {
      change_id: supersession.change_id,
      successor_run: supersession.successor_run,
      superseded_at: supersession.superseded_at,
    },
    { indent: 2, lineWidth: -1, noRefs: true },
  );
}

export function parseRunSupersession(source: string): RunSupersession {
  const obj = loadObject(source, 'superseded.yaml');
  const changeId = readStr(obj.change_id ?? obj.changeId);
  if (!changeId) throw new Error('superseded.yaml 缺少 change_id');
  const successor = readStr(obj.successor_run ?? obj.successorRun);
  if (!successor) throw new Error('superseded.yaml 缺少 successor_run');
  return {
    change_id: changeId,
    successor_run: successor,
    superseded_at: readStr(obj.superseded_at ?? obj.supersededAt) ?? '',
  };
}

export async function readRunSupersessionOrNull(
  speccraftDir: string,
  runId: string,
): Promise<RunSupersession | null> {
  const file = supersededPath(speccraftDir, runId);
  if (!(await pathExists(file))) return null;
  return parseRunSupersession(await readFile(file, 'utf8'));
}

export async function writeRunSupersession(
  speccraftDir: string,
  runId: string,
  supersession: RunSupersession,
): Promise<void> {
  await mkdir(runDir(speccraftDir, runId), { recursive: true });
  await writeFile(
    supersededPath(speccraftDir, runId),
    stringifyRunSupersession(supersession),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// §38 双向一致性
// ---------------------------------------------------------------------------

/**
 * §38：`successor/lineage.yaml` 与 `change/materialization.yaml` 必须一致。
 * 返回 null 表示两者都不存在；只有一侧存在 → 不一致（返回 `consistent: false`）。
 */
export async function checkLineageConsistency(
  speccraftDir: string,
  changeId: string,
  successorRunId: string,
): Promise<{ consistent: boolean; reason?: string }> {
  const lineage = await readRunLineageOrNull(speccraftDir, successorRunId);
  const materialization = await readChangeMaterializationOrNull(speccraftDir, changeId);

  if (!lineage && !materialization) return { consistent: true };
  if (!lineage) return { consistent: false, reason: `runs/${successorRunId}/lineage.yaml 缺失` };
  if (!materialization) {
    return { consistent: false, reason: `changes/${changeId}/materialization.yaml 缺失` };
  }
  if (lineage.change_id !== changeId) {
    return { consistent: false, reason: `lineage change_id=${lineage.change_id} ≠ ${changeId}` };
  }
  if (materialization.change_id !== changeId) {
    return {
      consistent: false,
      reason: `materialization change_id=${materialization.change_id} ≠ ${changeId}`,
    };
  }
  if (materialization.successor_run !== successorRunId) {
    return {
      consistent: false,
      reason: `materialization successor_run=${materialization.successor_run} ≠ ${successorRunId}`,
    };
  }
  if (lineage.predecessor_run === successorRunId) {
    return {
      consistent: false,
      reason: `lineage predecessor_run=${lineage.predecessor_run} 不能等于 successor run 自身`,
    };
  }
  if (lineage.approved_analysis_attempt !== materialization.approved_analysis_attempt) {
    return {
      consistent: false,
      reason: `approved_analysis_attempt 不一致：lineage=${lineage.approved_analysis_attempt} materialization=${materialization.approved_analysis_attempt}`,
    };
  }
  return { consistent: true };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function loadObject(source: string, name: string): Record<string, unknown> {
  const loaded = yaml.load(source);
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error(`${name} 顶层必须是对象`);
  }
  return loaded as Record<string, unknown>;
}

function readStr(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
