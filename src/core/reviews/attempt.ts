/**
 * Review Attempt Store（ADR 0009 §57-§59）。
 *
 * 读取 Review Attempt Manifest（append-only，attempt-NNN/manifest.yaml）。
 * manifestPath 可以是 manifest.yaml 文件路径，也可以是 attempt-NNN 目录路径。
 *
 * v0.8（§15）：读取必须真正校验 manifest 结构 —— 不能只粗查 version/gate_id/decision
 * 后直接 `as ReviewAttemptManifest`。所有必填字段缺失/类型错误 → 视为无效（null），
 * 不引入重型 schema library，用现有 TypeScript + helper。
 */

import { readFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  type ReviewAttemptManifest,
  type ReviewDecision,
  type ReviewGateKind,
  REVIEW_GATE_KINDS,
} from './types.js';
import { tasksDir } from '../tasks/store.js';

/** Review Decision 合法值（与类型定义保持一致） */
const REVIEW_DECISIONS: readonly ReviewDecision[] = ['pass', 'changes_required', 'error'];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** 必须为 >= min 的整数 */
function isIntAtLeast(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min;
}

export async function readReviewManifestOrNull(manifestPath: string): Promise<ReviewAttemptManifest | null> {
  let filePath = manifestPath;
  try {
    const s = await stat(manifestPath);
    if (s.isDirectory()) {
      filePath = path.join(manifestPath, 'manifest.yaml');
    }
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const m = parsed as Record<string, unknown>;

  // ---- 必填：基础结构（§15） ----
  if (m.version !== 1) return null;
  if (!isIntAtLeast(m.attempt, 1)) return null;
  if (!isNonEmptyString(m.run_id)) return null;
  if (!isNonEmptyString(m.task_id)) return null;
  if (!isNonEmptyString(m.gate_id)) return null;
  if (!isNonEmptyString(m.reviewer_profile)) return null;
  if (!isNonEmptyString(m.adapter)) return null;

  // gate_kind 必须是合法枚举
  const gateKind = m.gate_kind;
  if (!isNonEmptyString(gateKind) || !(REVIEW_GATE_KINDS as readonly string[]).includes(gateKind)) return null;

  // decision 必须是合法枚举（pass / changes_required / error）
  const decision = m.decision;
  if (!isNonEmptyString(decision) || !(REVIEW_DECISIONS as readonly string[]).includes(decision)) return null;

  // Evidence Binding：来源 attempt 必须是 >= 1 的整数
  if (!isIntAtLeast(m.source_dispatch_attempt, 1)) return null;
  if (!isIntAtLeast(m.source_verification_attempt, 1)) return null;

  // Snapshot 引用必须完整（Review 必须绑定 exact pre/post tree + commit）
  if (!isNonEmptyString(m.pre_tree)) return null;
  if (!isNonEmptyString(m.post_tree)) return null;
  if (!isNonEmptyString(m.pre_commit)) return null;
  if (!isNonEmptyString(m.post_commit)) return null;

  // 时间戳必须为非空字符串
  if (!isNonEmptyString(m.started_at)) return null;
  if (!isNonEmptyString(m.finished_at)) return null;

  // finding 计数必须为 >= 0 的整数
  if (!isIntAtLeast(m.finding_count, 0)) return null;
  if (!isIntAtLeast(m.blocking_findings, 0)) return null;

  // ---- 可选字段（存在时必须类型正确；§15） ----
  if (m.workspace_attempt !== undefined && !isIntAtLeast(m.workspace_attempt, 1)) return null;
  if (m.session_id !== undefined && !isNonEmptyString(m.session_id)) return null;
  if (m.error_code !== undefined && !isNonEmptyString(m.error_code)) return null;
  if (m.error_message !== undefined && !isNonEmptyString(m.error_message)) return null;

  return parsed as ReviewAttemptManifest;
}

/** 供校验复用：gate kind 是否合法（导出便于 validate 侧引用同一枚举） */
export function isValidReviewGateKind(value: unknown): value is ReviewGateKind {
  return isNonEmptyString(value) && (REVIEW_GATE_KINDS as readonly string[]).includes(value);
}

/**
 * 列出某 task 在指定 gate 下的全部 Review Attempt manifest（attempt 递增）。
 *
 * 只返回通过强校验（§15）的 manifest；损坏/无效 manifest 跳过
 * （顶层调用方可用 completion invariants 兜底：completed task 缺有效 PASS → 违规）。
 */
export async function listReviewAttempts(
  speccraftDir: string,
  runId: string,
  taskId: string,
  gateId: string,
): Promise<ReviewAttemptManifest[]> {
  const evidenceDir = path.join(tasksDir(speccraftDir, runId), taskId, 'reviews', gateId);
  let entries: string[] = [];
  try {
    entries = (await readdir(evidenceDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^attempt-\d+$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: ReviewAttemptManifest[] = [];
  for (const dir of entries) {
    const manifest = await readReviewManifestOrNull(path.join(evidenceDir, dir));
    if (manifest) out.push(manifest);
  }
  return out;
}

/** 列出某 task 下全部 gate 的 Review Attempt manifest（task → gate → attempt，gate 字典序） */
export async function listTaskReviewEvidence(
  speccraftDir: string,
  runId: string,
  taskId: string,
): Promise<Array<{ gateId: string; attempts: ReviewAttemptManifest[] }>> {
  const reviewsDir = path.join(tasksDir(speccraftDir, runId), taskId, 'reviews');
  let gateEntries: string[] = [];
  try {
    gateEntries = (await readdir(reviewsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: Array<{ gateId: string; attempts: ReviewAttemptManifest[] }> = [];
  for (const gateId of gateEntries) {
    out.push({ gateId, attempts: await listReviewAttempts(speccraftDir, runId, taskId, gateId) });
  }
  return out;
}
