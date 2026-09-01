/**
 * Review Plan Store（ADR 0009 §18-§19）。
 *
 * Review Plan 一旦产生即 frozen：
 *   .speccraft/runs/<run-id>/reviews/plan.yaml
 * 后续 review 只读 plan.yaml，不重新读取 project.yaml。
 *
 * hasExecutionEvidence：复用 executor store 的 Graph Recompile Guard，
 * 增加 review evidence 判定。
 */

import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { runDir } from '../execution/store.js';
import { tasksDir } from '../tasks/store.js';
import type { ReviewPlan, FrozenReviewGate } from './types.js';

export const REVIEWS_DIR = 'reviews';
export const REVIEW_PLAN_FILE = 'plan.yaml';

/** reviews 目录绝对路径 */
export function reviewsDir(speccraftDir: string, runId: string): string {
  return path.join(runDir(speccraftDir, runId), REVIEWS_DIR);
}

/** plan.yaml 绝对路径 */
export function reviewPlanPath(speccraftDir: string, runId: string): string {
  return path.join(reviewsDir(speccraftDir, runId), REVIEW_PLAN_FILE);
}

/** 序列化 ReviewPlan 为 plan.yaml 文本 */
export function stringifyReviewPlan(plan: ReviewPlan): string {
  return yaml.dump(
    {
      version: plan.version,
      run_id: plan.run_id,
      enabled: plan.enabled,
      created_at: plan.created_at,
      gates: plan.gates.map((g) => ({
        id: g.id,
        kind: g.kind,
        reviewer: g.reviewer,
        adapter: g.adapter,
        resolved: g.resolved,
      })),
    },
    { indent: 2, lineWidth: -1, noRefs: true },
  );
}

/** 解析 plan.yaml 文本 */
export function parseReviewPlan(source: string): ReviewPlan {
  const loaded = yaml.load(source);
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error('review plan 顶层必须是对象');
  }
  const obj = loaded as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`review plan version 必须为 1（实际 ${String(obj.version)}）`);
  }
  const runId = typeof obj.run_id === 'string' ? obj.run_id : '';
  if (!runId) throw new Error('review plan 缺少 run_id');
  const enabled = obj.enabled === true;
  const createdAt = typeof obj.created_at === 'string' ? obj.created_at : '';

  const gates: FrozenReviewGate[] = [];
  if (Array.isArray(obj.gates)) {
    for (const [i, raw] of obj.gates.entries()) {
      if (typeof raw !== 'object' || raw === null) throw new Error(`gates[${i}] 必须是对象`);
      const g = raw as Record<string, unknown>;
      const id = typeof g.id === 'string' ? g.id : '';
      if (!id) throw new Error(`gates[${i}] 缺少 id`);
      const kind = g.kind as 'spec_compliance' | 'code_quality';
      const reviewer = typeof g.reviewer === 'string' ? g.reviewer : '';
      const adapter = typeof g.adapter === 'string' ? g.adapter : '';
      const resolvedRaw = (g.resolved ?? {}) as Record<string, unknown>;
      const resolved: FrozenReviewGate['resolved'] = {
        timeout_seconds: typeof resolvedRaw.timeout_seconds === 'number' ? resolvedRaw.timeout_seconds : 900,
      };
      if (typeof resolvedRaw.model === 'string') resolved.model = resolvedRaw.model;
      if (Array.isArray(resolvedRaw.extra_args)) {
        resolved.extra_args = resolvedRaw.extra_args.filter((x): x is string => typeof x === 'string');
      }
      if (typeof resolvedRaw.sandbox === 'string') resolved.sandbox = resolvedRaw.sandbox;
      gates.push({ id, kind, reviewer, adapter, resolved });
    }
  }

  return { version: 1, run_id: runId, enabled, created_at: createdAt, gates };
}

/** 写入 plan.yaml（覆盖写；调用方负责 Recompile Guard） */
export async function writeReviewPlan(speccraftDir: string, runId: string, plan: ReviewPlan): Promise<void> {
  await mkdir(reviewsDir(speccraftDir, runId), { recursive: true });
  await writeFile(reviewPlanPath(speccraftDir, runId), stringifyReviewPlan(plan), 'utf8');
}

/** 读取 plan.yaml；不存在返回 null */
export async function readReviewPlanOrNull(speccraftDir: string, runId: string): Promise<ReviewPlan | null> {
  const file = reviewPlanPath(speccraftDir, runId);
  if (!(await pathExists(file))) return null;
  return parseReviewPlan(await readFile(file, 'utf8'));
}

/** 读取 plan.yaml；不存在抛错 */
export async function readReviewPlan(speccraftDir: string, runId: string): Promise<ReviewPlan> {
  const file = reviewPlanPath(speccraftDir, runId);
  if (!(await pathExists(file))) {
    throw new Error(`Review Plan 不存在：${file}（请先 speccraft tasks compile）`);
  }
  return parseReviewPlan(await readFile(file, 'utf8'));
}

/**
 * 判定 Run 是否已有 review evidence：
 *   tasks/<task>/reviews/<gate>/attempt-NNN/
 * 存在 → true（禁止 rebuild Review Plan）。
 */
export async function hasReviewEvidence(speccraftDir: string, runId: string): Promise<boolean> {
  const tasks = tasksDir(speccraftDir, runId);
  if (!(await pathExists(tasks))) return false;

  const entries = await readdir(tasks, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const taskReviewsDir = path.join(tasks, entry.name, REVIEWS_DIR);
    if (!(await pathExists(taskReviewsDir))) continue;
    const gates = await readdir(taskReviewsDir, { withFileTypes: true });
    for (const gate of gates) {
      if (!gate.isDirectory()) continue;
      if (await dirHasAttempts(path.join(taskReviewsDir, gate.name))) return true;
    }
  }
  return false;
}

/** 目录存在且包含 attempt-NNN 子目录 */
async function dirHasAttempts(dir: string): Promise<boolean> {
  if (!(await pathExists(dir))) return false;
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.some((e) => e.isDirectory() && /^attempt-\d+$/.test(e.name));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
