/**
 * Canonical Artifact Promotion / Close（SpecCraft v0.9 §46–§50，ADR 0010）。
 *
 *   speccraft changes close <change-id>
 *
 * 只有 Successor Run Owner Acceptance = accepted 之后，才允许把 approved resolved
 * snapshot 提升为 canonical artifacts（§46）。
 *
 * 三条硬边界：
 *   §47 Close Preconditions —— status = materialized、Successor 存在且 accepted、
 *       lineage 与 Change 一致，否则失败（fail-before-mutation）；
 *   §48 Canonical Drift Guard —— 覆盖前逐个比对当前 canonical hash：
 *       == baseline → 允许替换；== approved target → 允许（crash/retry 幂等）；
 *       任何第三种 hash → canonical_drift，STOP，禁止覆盖未知用户修改；
 *   §49 可重入 —— 多文件无 filesystem transaction，重跑 close 跳过已等于 target
 *       的文件，只完成剩余文件，不重复破坏已完成的文件。
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { readRun } from '../execution/store.js';
import type { ExecutionRunManifest } from '../execution/types.js';
import { PROJECT_FILE } from '../state/store.js';
import { sha256Bytes } from './digest.js';
import { analysisAttemptDir, analysisBundleDigest, readAnalysisAttemptOrNull } from './analyze.js';
import type { AnalysisAttempt } from './analyze.js';
import { readApprovalOrNull } from './approval.js';
import { checkLineageConsistency, readChangeMaterializationOrNull } from './lineage.js';
import { changeDir, readChangeManifest, updateChangeStatus } from './store.js';
import { ChangeError } from './types.js';
import type { ChangeSetManifest } from './types.js';

/** Change 目录下的 close 证据文件名 */
export const CLOSE_FILE = 'close.yaml';
/** canonical artifacts 目录名（相对 .speccraft） */
export const CANONICAL_ARTIFACTS_DIR = 'artifacts';

/** `.speccraft/changes/<change-id>/close.yaml`（v0.9 §50） */
export interface ChangeClose {
  version: 1;
  change_id: string;
  closed_at: string;
  successor_run: string;
  approved_analysis_attempt: string;
  /** 本次 promotion 覆盖的 canonical 相对路径（升序） */
  promoted_files: string[];
  /** 覆盖前 canonical hash（不存在为 null） */
  before_hashes: Record<string, string | null>;
  /** 覆盖后 canonical hash（= approved target hash） */
  after_hashes: Record<string, string>;
}

export function closePath(speccraftDir: string, changeId: string): string {
  return path.join(changeDir(speccraftDir, changeId), CLOSE_FILE);
}

// ---------------------------------------------------------------------------
// 序列化 / 解析
// ---------------------------------------------------------------------------

export function stringifyChangeClose(close: ChangeClose): string {
  const before: Record<string, string | null> = {};
  const after: Record<string, string> = {};
  for (const rel of close.promoted_files) {
    before[rel] = close.before_hashes[rel] ?? null;
    after[rel] = close.after_hashes[rel] ?? '';
  }
  return yaml.dump(
    {
      version: close.version,
      change_id: close.change_id,
      closed_at: close.closed_at,
      successor_run: close.successor_run,
      approved_analysis_attempt: close.approved_analysis_attempt,
      promoted_files: close.promoted_files,
      before_hashes: before,
      after_hashes: after,
    },
    { indent: 2, lineWidth: -1, noRefs: true },
  );
}

export function parseChangeClose(source: string): ChangeClose {
  const loaded = yaml.load(source);
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error('close.yaml 顶层必须是对象');
  }
  const obj = loaded as Record<string, unknown>;
  const changeId = readStr(obj.change_id ?? obj.changeId);
  if (!changeId) throw new Error('close.yaml 缺少 change_id');
  const successor = readStr(obj.successor_run ?? obj.successorRun);
  if (!successor) throw new Error('close.yaml 缺少 successor_run');
  const promoted = toStringArray(obj.promoted_files ?? obj.promotedFiles);
  return {
    version: 1,
    change_id: changeId,
    closed_at: readStr(obj.closed_at ?? obj.closedAt) ?? '',
    successor_run: successor,
    approved_analysis_attempt:
      readStr(obj.approved_analysis_attempt ?? obj.approvedAnalysisAttempt) ?? '',
    promoted_files: promoted,
    before_hashes: readHashMap(obj.before_hashes ?? obj.beforeHashes),
    after_hashes: readStringMap(obj.after_hashes ?? obj.afterHashes),
  };
}

export async function readChangeCloseOrNull(
  speccraftDir: string,
  changeId: string,
): Promise<ChangeClose | null> {
  const file = closePath(speccraftDir, changeId);
  if (!(await pathExists(file))) return null;
  return parseChangeClose(await readFile(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

export interface CloseChangeOptions {
  speccraftDir: string;
  changeId: string;
  now?: Date;
}

export interface CloseChangeResult {
  changeId: string;
  successorRun: string;
  /** 本次实际写入的 canonical 文件（相对 .speccraft） */
  promotedFiles: string[];
  /** 已等于 approved target、被幂等跳过的文件（相对 .speccraft） */
  skippedFiles: string[];
  close: ChangeClose;
  /** true 表示 Change 此前已经 closed，直接复用现有 close.yaml */
  reused: boolean;
}

/**
 * 把 approved resolved snapshot 提升为 canonical artifacts（§46–§50）。
 *
 * 失败（含 canonical_drift）时不做任何覆盖，Change 保持 materialized，可修复后重试。
 */
export async function closeChange(options: CloseChangeOptions): Promise<CloseChangeResult> {
  const { speccraftDir, changeId } = options;
  const now = options.now ?? new Date();

  const manifest = await readChangeManifest(speccraftDir, changeId);

  // 已完成 close：幂等复用（不重复覆盖）
  if (manifest.status === 'closed') {
    const existing = await readChangeCloseOrNull(speccraftDir, changeId);
    if (!existing) {
      throw new ChangeError(
        'no_close_record',
        `Change ${changeId} 状态为 closed，但缺少 close.yaml（请运行 speccraft validate）。`,
      );
    }
    return {
      changeId,
      successorRun: existing.successor_run,
      promotedFiles: [],
      skippedFiles: [...existing.promoted_files],
      close: existing,
      reused: true,
    };
  }

  // §47 Change status = materialized
  assertCloseAllowed(manifest);

  const materialization = await readChangeMaterializationOrNull(speccraftDir, changeId);
  if (!materialization) {
    throw new ChangeError(
      'no_materialization',
      `Change ${changeId} 没有 materialization.yaml，无法 close。`,
    );
  }
  const successorRun = materialization.successor_run;

  // §47 Successor Run exists
  const run = await readRunOrNull(speccraftDir, successorRun);
  if (!run) {
    throw new ChangeError('successor_run_missing', `Successor Run 不存在：${successorRun}`);
  }

  // §47 Successor Run Owner Acceptance = accepted
  if (run.status !== 'accepted') {
    throw new ChangeError(
      'successor_not_accepted',
      `Successor Run ${successorRun} 尚未 Owner Accepted（当前 ${run.status}），不可 close。`,
    );
  }

  // §47 Successor lineage matches Change
  const lineage = await checkLineageConsistency(speccraftDir, changeId, successorRun);
  if (!lineage.consistent) {
    throw new ChangeError(
      'lineage_inconsistent',
      `Change ${changeId} 与 Successor Run ${successorRun} 的 lineage 不一致：${lineage.reason ?? '未知原因'}`,
    );
  }

  const approval = await readApprovalOrNull(speccraftDir, changeId);
  if (!approval) {
    throw new ChangeError(
      'change_not_approved',
      `Change ${changeId} 没有 approval.yaml，不可 close。`,
    );
  }

  const attempt = await readAnalysisAttemptOrNull(
    speccraftDir,
    changeId,
    approval.analysis_attempt,
  );
  if (!attempt || attempt.result !== 'complete') {
    throw new ChangeError(
      'no_complete_analysis',
      `Change ${changeId} 的 approved Analysis Attempt ${approval.analysis_attempt} 不存在或不是 complete。`,
    );
  }
  const attemptDir = analysisAttemptDir(speccraftDir, changeId, attempt.attempt);

  // §36/§58：approved Evidence 不得被 tamper（bundle digest 与 approval 绑定）
  await assertApprovedEvidenceIntact(attemptDir, approval.analysis_bundle_sha256, changeId);

  // 计算 promotion 计划（baseline ≠ target 的文件）
  const plan = await buildPromotionPlan({ speccraftDir, manifest, attempt, attemptDir });

  // §48 Canonical Drift Guard：先全部校验，再开始任何写入（fail-before-mutation）
  const beforeHashes: Record<string, string | null> = {};
  for (const entry of plan) {
    const current = await sha256FileOrNull(entry.canonicalPath);
    beforeHashes[entry.rel] = current;
    if (current !== entry.baselineHash && current !== entry.targetHash) {
      throw new ChangeError(
        'canonical_drift',
        `Canonical ${entry.rel} 已被未知修改（当前 ${current ?? 'missing'}，` +
          `baseline ${entry.baselineHash ?? 'null'}，approved target ${entry.targetHash}）；` +
          '拒绝覆盖，请人工处理后再 close。',
      );
    }
  }

  // §49 幂等替换：baseline → replace；already target → skip
  const promotedFiles: string[] = [];
  const skippedFiles: string[] = [];
  for (const entry of plan) {
    if (beforeHashes[entry.rel] === entry.targetHash) {
      skippedFiles.push(entry.rel);
      continue;
    }
    await mkdir(path.dirname(entry.canonicalPath), { recursive: true });
    await writeFile(entry.canonicalPath, entry.targetBytes);
    promotedFiles.push(entry.rel);
  }

  // §50 close.yaml
  const afterHashes: Record<string, string> = {};
  for (const entry of plan) afterHashes[entry.rel] = entry.targetHash;
  const sorted = [...plan.map((e) => e.rel)].sort();
  const close: ChangeClose = {
    version: 1,
    change_id: changeId,
    closed_at: now.toISOString(),
    successor_run: successorRun,
    approved_analysis_attempt: attempt.attempt,
    promoted_files: sorted,
    before_hashes: beforeHashes,
    after_hashes: afterHashes,
  };
  await writeChangeClose(speccraftDir, changeId, close);

  // §50 Change 状态：closed
  await updateChangeStatus(speccraftDir, manifest, 'closed');

  return { changeId, successorRun, promotedFiles, skippedFiles, close, reused: false };
}

// ---------------------------------------------------------------------------
// gates / helpers
// ---------------------------------------------------------------------------

/** §47：只有 materialized 可以 close */
function assertCloseAllowed(manifest: ChangeSetManifest): void {
  if (manifest.status === 'materialized') return;
  if (manifest.status === 'rejected') {
    throw new ChangeError('change_rejected', `Change ${manifest.id} 已 rejected，不可 close。`);
  }
  throw new ChangeError(
    'change_not_materialized',
    `Change ${manifest.id} 当前状态为 ${manifest.status}，只有 materialized 的 Change 可以 close。`,
  );
}

/** §36：approved snapshot 内容不得漂移 */
async function assertApprovedEvidenceIntact(
  attemptDir: string,
  approvedBundle: string,
  changeId: string,
): Promise<void> {
  if (!approvedBundle) return;
  const current = await analysisBundleDigest(attemptDir);
  if (current !== approvedBundle) {
    throw new ChangeError(
      'non_deterministic_recompile',
      `Change ${changeId} 的 Approved Analysis Evidence 已被修改：` +
        `当前 bundle ${current ?? 'null'} ≠ approved ${approvedBundle}。`,
    );
  }
}

interface PromotionEntry {
  /** 相对 .speccraft 的规范路径（`/` 分隔） */
  rel: string;
  canonicalPath: string;
  /** 创建 Change 时的 baseline hash；不存在为 null */
  baselineHash: string | null;
  /** approved target 的 hash */
  targetHash: string;
  targetBytes: Buffer;
}

/**
 * 计算需要 promotion 的文件集合（§46/§48）。
 *
 * 只包含 baseline ≠ approved target 的文件；未变化的 artifact（unaffected / retain）
 * 不在集合内，也因此不会被重写。
 */
async function buildPromotionPlan(input: {
  speccraftDir: string;
  manifest: ChangeSetManifest;
  attempt: AnalysisAttempt;
  attemptDir: string;
}): Promise<PromotionEntry[]> {
  const { speccraftDir, manifest, attempt, attemptDir } = input;
  const entries: PromotionEntry[] = [];

  for (const record of attempt.resolved) {
    const bytes = await readFileOrNull(path.join(attemptDir, record.path));
    if (!bytes) {
      throw new ChangeError(
        'close_target_missing',
        `Approved resolved artifact 缺失：${record.path}（Change ${manifest.id}）`,
      );
    }
    const targetHash = sha256Bytes(bytes);
    const baselineHash = manifest.artifacts.find((a) => a.stage === record.stage)?.sha256 ?? null;
    if (baselineHash === targetHash) continue;
    entries.push({
      rel: `${CANONICAL_ARTIFACTS_DIR}/${record.artifact}.md`,
      canonicalPath: path.join(speccraftDir, CANONICAL_ARTIFACTS_DIR, `${record.artifact}.md`),
      baselineHash,
      targetHash,
      targetBytes: bytes,
    });
  }

  if (attempt.project) {
    const bytes = await readFileOrNull(path.join(attemptDir, attempt.project.path));
    if (!bytes) {
      throw new ChangeError(
        'close_target_missing',
        `Approved resolved project.yaml 缺失：${attempt.project.path}（Change ${manifest.id}）`,
      );
    }
    const targetHash = sha256Bytes(bytes);
    if (manifest.projectDigest !== targetHash) {
      entries.push({
        rel: PROJECT_FILE,
        canonicalPath: path.join(speccraftDir, PROJECT_FILE),
        baselineHash: manifest.projectDigest,
        targetHash,
        targetBytes: bytes,
      });
    }
  }

  return entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

async function writeChangeClose(
  speccraftDir: string,
  changeId: string,
  close: ChangeClose,
): Promise<void> {
  await mkdir(changeDir(speccraftDir, changeId), { recursive: true });
  await writeFile(closePath(speccraftDir, changeId), stringifyChangeClose(close), 'utf8');
}

async function readRunOrNull(
  speccraftDir: string,
  runId: string,
): Promise<ExecutionRunManifest | null> {
  try {
    return await readRun(speccraftDir, runId);
  } catch {
    return null;
  }
}

async function readFileOrNull(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

async function sha256FileOrNull(file: string): Promise<string | null> {
  const bytes = await readFileOrNull(file);
  return bytes ? sha256Bytes(bytes) : null;
}

function readStr(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function readHashMap(value: unknown): Record<string, string | null> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = typeof v === 'string' ? v : null;
  }
  return out;
}

function readStringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
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
