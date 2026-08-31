/**
 * Executor Plan Store（ADR 0008 §4、§15、§18、§20）。
 *
 * Executor Plan 一旦产生即 frozen：
 *   .speccraft/runs/<run-id>/executors/plan.yaml
 * 后续 dispatch 只读 plan.yaml，不重新读取 project.yaml 决定 Task Executor。
 *
 * hasExecutionEvidence：Graph Recompile Guard 判定（dispatch / verification / workspace attempt 任一存在即拒绝 rebuild）。
 */

import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { runDir } from '../execution/store.js';
import { DISPATCH_DIR } from '../dispatch/types.js';
import { tasksDir } from '../tasks/store.js';
import type { AdapterConfig } from '../execution/adapters/types.js';
import type { AssignmentSource, ExecutorAssignment, ExecutorPlan } from './types.js';

export const EXECUTORS_DIR = 'executors';
export const PLAN_FILE = 'plan.yaml';

/** executors 目录绝对路径 */
export function executorsDir(speccraftDir: string, runId: string): string {
  return path.join(runDir(speccraftDir, runId), EXECUTORS_DIR);
}

/** plan.yaml 绝对路径 */
export function executorPlanPath(speccraftDir: string, runId: string): string {
  return path.join(executorsDir(speccraftDir, runId), PLAN_FILE);
}

// ---------------------------------------------------------------------------
// 序列化 / 解析
// ---------------------------------------------------------------------------

/** 序列化 ExecutorPlan 为 plan.yaml 文本（确定性；max_concurrency 归入 resolved，ADR 0008 §15） */
export function stringifyExecutorPlan(plan: ExecutorPlan): string {
  return yaml.dump(
    {
      version: plan.version,
      run_id: plan.runId,
      created_at: plan.createdAt,
      default_executor: plan.defaultExecutor,
      assignments: plan.assignments.map((a) => ({
        task_id: a.taskId,
        executor: a.executor,
        source: a.source,
        adapter: a.adapter,
        resolved: {
          ...a.resolved,
          ...(a.maxConcurrency !== undefined ? { max_concurrency: a.maxConcurrency } : {}),
        },
      })),
    },
    { indent: 2, lineWidth: -1, noRefs: true },
  );
}

/** 解析 plan.yaml 文本 */
export function parseExecutorPlan(source: string): ExecutorPlan {
  const loaded = yaml.load(source);
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error('executor plan 顶层必须是对象');
  }
  const obj = loaded as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`executor plan version 必须为 1（实际 ${String(obj.version)}）`);
  }
  const runId = typeof obj.run_id === 'string' ? obj.run_id : '';
  if (!runId) throw new Error('executor plan 缺少 run_id');
  const createdAt = typeof obj.created_at === 'string' ? obj.created_at : '';
  const defaultExecutor = typeof obj.default_executor === 'string' ? obj.default_executor : '';

  if (!Array.isArray(obj.assignments)) throw new Error('executor plan 缺少 assignments 数组');

  const assignments: ExecutorAssignment[] = obj.assignments.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) throw new Error(`assignments[${i}] 必须是对象`);
    const m = raw as Record<string, unknown>;
    const taskId = typeof m.task_id === 'string' ? m.task_id : '';
    if (!taskId) throw new Error(`assignments[${i}] 缺少 task_id`);
    const executor = typeof m.executor === 'string' ? m.executor : '';
    const source = m.source as AssignmentSource;
    const adapter = typeof m.adapter === 'string' ? m.adapter : '';

    const resolvedRaw = (m.resolved ?? {}) as Record<string, unknown>;
    const resolved: AdapterConfig = {};
    if (typeof resolvedRaw.command === 'string') resolved.command = resolvedRaw.command;
    if (typeof resolvedRaw.timeout_seconds === 'number') resolved.timeout_seconds = resolvedRaw.timeout_seconds;
    if (Array.isArray(resolvedRaw.extra_args)) {
      resolved.extra_args = resolvedRaw.extra_args.filter((x): x is string => typeof x === 'string');
    }
    if (typeof resolvedRaw.model === 'string') resolved.model = resolvedRaw.model;
    if (typeof resolvedRaw.sandbox === 'string') resolved.sandbox = resolvedRaw.sandbox;
    const maxConcurrency =
      typeof resolvedRaw.max_concurrency === 'number' ? resolvedRaw.max_concurrency : undefined;

    const a: ExecutorAssignment = { taskId, executor, source, adapter, resolved };
    if (maxConcurrency !== undefined) a.maxConcurrency = maxConcurrency;
    return a;
  });

  return { version: 1, runId, createdAt, defaultExecutor, assignments };
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

/** 写入 plan.yaml（覆盖写；调用方负责 Graph Recompile Guard） */
export async function writeExecutorPlan(
  speccraftDir: string,
  runId: string,
  plan: ExecutorPlan,
): Promise<void> {
  await mkdir(executorsDir(speccraftDir, runId), { recursive: true });
  await writeFile(executorPlanPath(speccraftDir, runId), stringifyExecutorPlan(plan), 'utf8');
}

/** 读取 plan.yaml；不存在返回 null */
export async function readExecutorPlanOrNull(
  speccraftDir: string,
  runId: string,
): Promise<ExecutorPlan | null> {
  const file = executorPlanPath(speccraftDir, runId);
  if (!(await pathExists(file))) return null;
  return parseExecutorPlan(await readFile(file, 'utf8'));
}

/** 读取 plan.yaml；不存在抛错 */
export async function readExecutorPlan(speccraftDir: string, runId: string): Promise<ExecutorPlan> {
  const file = executorPlanPath(speccraftDir, runId);
  if (!(await pathExists(file))) {
    throw new Error(`Executor Plan 不存在：${file}（请先 speccraft tasks compile）`);
  }
  return parseExecutorPlan(await readFile(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// Graph Recompile Guard（ADR 0008 §20）
// ---------------------------------------------------------------------------

/**
 * 判定 Run 是否已有真实执行 evidence：
 *   - dispatch attempt（.speccraft/runs/<run>/dispatch/attempt-NNN/）
 *   - task verification attempt（tasks/<task>/verification/attempt-NNN/）
 *   - workspace attempt（tasks/<task>/workspaces/attempt-NNN/）
 * 任一存在 → true（禁止 rebuild Task Graph / Executor Plan）。
 */
export async function hasExecutionEvidence(speccraftDir: string, runId: string): Promise<boolean> {
  const run = runDir(speccraftDir, runId);

  // dispatch evidence（全局，非 per-task）
  if (await dirHasAttempts(path.join(run, DISPATCH_DIR))) return true;

  // task-level evidence（verification / workspaces）
  const tasks = tasksDir(speccraftDir, runId);
  if (await pathExists(tasks)) {
    const entries = await readdir(tasks, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskDirPath = path.join(tasks, entry.name);
      if (await dirHasAttempts(path.join(taskDirPath, 'verification'))) return true;
      if (await dirHasAttempts(path.join(taskDirPath, 'workspaces'))) return true;
    }
  }

  return false;
}

/** 目录存在且包含 attempt-NNN 子目录/文件 */
async function dirHasAttempts(dir: string): Promise<boolean> {
  if (!(await pathExists(dir))) return false;
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.some(
    (e) => e.isDirectory() && /^attempt-\d+$/.test(e.name),
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
