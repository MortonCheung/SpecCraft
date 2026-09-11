/**
 * Evidence Digest（SpecCraft v0.9 §11–§12，ADR 0010）。
 *
 * 两条硬规则：
 * 1. 一切 digest 基于 raw file bytes —— 不 trim、不 normalize markdown、
 *    不 normalize line endings、不重新 serialize；
 * 2. bundle digest 不使用 YAML stringify 结果，避免受 key 顺序影响。
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { TaskGraph } from '../tasks/types.js';
import type { ExecutorPlan } from '../executors/types.js';
import type { ReviewPlan } from '../reviews/types.js';

/** 对原始字节计算 SHA-256（hex） */
export function sha256Bytes(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 读取文件原始字节并计算 SHA-256 */
export async function sha256File(filePath: string): Promise<string> {
  return sha256Bytes(await readFile(filePath));
}

/** bundle 中的一个文件条目：相对路径 + 该文件 SHA-256 */
export interface BundleEntry {
  /** bundle 内的相对路径（使用 `/` 分隔） */
  path: string;
  /** 该文件原始字节的 SHA-256 */
  sha256: string;
}

/**
 * Bundle Digest 稳定算法（v0.9 §12）：
 * 1. 每个文件已由调用方计算 SHA-256；
 * 2. 相对路径升序排序；
 * 3. 构造 `<path>\0<sha256>\n`；
 * 4. 对整体字符串 SHA-256。
 *
 * 例：
 *   artifacts/design.md\0abc...\n
 *   artifacts/requirement.md\0def...\n
 *   project.yaml\0ghi...\n
 */
export function bundleDigest(entries: readonly BundleEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const payload = sorted.map((e) => `${e.path}\0${e.sha256}\n`).join('');
  return sha256Bytes(payload);
}

/**
 * 稳定 JSON 序列化（对象键递归升序）。
 *
 * 用于 frozen plan digest：YAML stringify 会受键顺序影响，
 * 而 plan 一旦 frozen 必须可精确复现（v0.9 §12、§36）。
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (obj[key] === undefined) continue;
      out[key] = canonicalize(obj[key]);
    }
    return out;
  }
  return value;
}

/** 对稳定序列化的结构化值计算 SHA-256 */
export function stableDigest(value: unknown): string {
  return sha256Bytes(stableJson(value));
}

// ---------------------------------------------------------------------------
// Frozen Plan digests（v0.9 §36：Analysis Candidate 必须等于 Materialized Successor Plan）
//
// 排除 runId / createdAt（successor Run 尚不存在、时间天然不同），
// 只对决定执行语义的内容取 digest。
// ---------------------------------------------------------------------------

/** Task Graph 的语义内容（排除 run_id / created_at） */
export function canonicalTaskGraph(graph: TaskGraph): unknown {
  return {
    version: graph.version,
    source: graph.source,
    tasks: graph.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      summary: t.summary,
      ...(t.executor ? { executor: t.executor } : {}),
      depends_on: t.dependsOn,
      scope: { paths: t.scope.paths },
      verification: {
        commands: t.verification.commands,
        timeout_seconds: t.verification.timeoutSeconds,
      },
    })),
  };
}

export function taskGraphDigest(graph: TaskGraph): string {
  return stableDigest(canonicalTaskGraph(graph));
}

/** Executor Plan 的语义内容（排除 run_id / created_at） */
export function executorPlanDigest(plan: ExecutorPlan): string {
  return stableDigest({
    version: plan.version,
    default_executor: plan.defaultExecutor,
    assignments: plan.assignments.map((a) => ({
      task_id: a.taskId,
      executor: a.executor,
      source: a.source,
      adapter: a.adapter,
      resolved: a.resolved,
      ...(a.maxConcurrency !== undefined ? { max_concurrency: a.maxConcurrency } : {}),
    })),
  });
}

/** Review Plan 的语义内容（排除 run_id / created_at） */
export function reviewPlanDigest(plan: ReviewPlan): string {
  return stableDigest({
    version: plan.version,
    enabled: plan.enabled,
    gates: plan.gates.map((g) => ({
      id: g.id,
      kind: g.kind,
      reviewer: g.reviewer,
      adapter: g.adapter,
      resolved: g.resolved,
    })),
  });
}
