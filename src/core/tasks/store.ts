/**
 * Task Store（ADR 0006 §3）。
 *
 * 只负责 Task Graph / Task Manifest 的持久化（file-first，无数据库）。
 * 目录结构：
 *   .speccraft/runs/<run-id>/tasks/
 *     ├── graph.yaml
 *     └── <task-id>/
 *         ├── manifest.yaml
 *         ├── context.md
 *         ├── prompt.md
 *         └── verification/
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { runDir } from '../execution/store.js';
import { isTaskStatus } from './types.js';
import { isValidExecutorId } from '../executors/resolver.js';
import type { TaskDefinition, TaskGraph, TaskManifest, TaskStatus } from './types.js';

export const TASKS_DIR = 'tasks';
export const GRAPH_FILE = 'graph.yaml';
export const MANIFEST_FILE = 'manifest.yaml';

/** tasks 目录绝对路径 */
export function tasksDir(speccraftDir: string, runId: string): string {
  return path.join(runDir(speccraftDir, runId), TASKS_DIR);
}

/** 单个 task 目录绝对路径 */
export function taskDir(speccraftDir: string, runId: string, taskId: string): string {
  return path.join(tasksDir(speccraftDir, runId), taskId);
}

// ---------------------------------------------------------------------------
// Task Graph
// ---------------------------------------------------------------------------

/** 序列化 TaskGraph 为 graph.yaml 文本（确定性） */
export function stringifyTaskGraph(graph: TaskGraph): string {
  return yaml.dump(
    {
      version: graph.version,
      run_id: graph.runId,
      source: graph.source,
      created_at: graph.createdAt,
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
    },
    { indent: 2, lineWidth: -1, noRefs: true },
  );
}

/** 解析 graph.yaml 文本 */
export function parseTaskGraph(source: string): TaskGraph {
  const loaded = yaml.load(source);
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error('task graph 顶层必须是对象');
  }
  const obj = loaded as Record<string, unknown>;

  const version = obj.version;
  if (version !== 1) throw new Error(`task graph version 必须为 1（实际 ${String(version)}）`);
  const runId = typeof obj.run_id === 'string' ? obj.run_id : '';
  if (!runId) throw new Error('task graph 缺少 run_id');
  const sourceArtifact = typeof obj.source === 'string' ? obj.source : '';
  const createdAt = typeof obj.created_at === 'string' ? obj.created_at : '';

  if (!Array.isArray(obj.tasks)) throw new Error('task graph 缺少 tasks 数组');

  const tasks = parseTaskDefinitions(obj.tasks);

  return { version: 1, runId, source: sourceArtifact, createdAt, tasks };
}

/** 从 YAML 数组解析 TaskDefinition[]（供 graph.yaml 与 compiler block 复用） */
export function parseTaskDefinitions(rawTasks: unknown): TaskDefinition[] {
  if (!Array.isArray(rawTasks)) throw new Error('tasks 必须是数组');
  return rawTasks.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) throw new Error(`tasks[${i}] 必须是对象`);
    const t = raw as Record<string, unknown>;
    const id = typeof t.id === 'string' ? t.id.trim() : '';
    if (!id) throw new Error(`tasks[${i}] 缺少 id`);
    const title = typeof t.title === 'string' ? t.title.trim() : '';
    if (!title) throw new Error(`task ${id} 缺少 title`);
    const summary = typeof t.summary === 'string' ? t.summary.trim() : '';
    if (!summary) throw new Error(`task ${id} 缺少 summary`);

    // ADR 0008 §2、§14：executor 只允许显式 profile id（或缺省）；禁止 auto / capabilities / preferred_models
    let executor: string | undefined;
    const ex = t.executor ?? t.executor_id;
    if (ex !== undefined && ex !== null) {
      if (typeof ex !== 'string' || !ex.trim()) {
        throw new Error(`task ${id} 的 executor 必须是非空字符串（不允许 capabilities 等 auto-selector）`);
      }
      const execId = ex.trim();
      if (execId === 'auto') throw new Error(`task ${id} 禁止 executor: auto（v0.7 只允许显式 profile id 或缺省）`);
      if (!isValidExecutorId(execId)) throw new Error(`task ${id} 的 executor id 非法：${execId}`);
      executor = execId;
    }

    const dependsOn = toStrArray(t.depends_on ?? t.dependsOn, `task ${id} 的 depends_on`);
    const scopeRaw = (t.scope ?? {}) as Record<string, unknown>;
    const paths = toStrArray(scopeRaw.paths, `task ${id} 的 scope.paths`);
    if (paths.length === 0) throw new Error(`task ${id} 的 scope.paths 不能为空`);

    const vRaw = (t.verification ?? {}) as Record<string, unknown>;
    const commands = toStrArray(vRaw.commands, `task ${id} 的 verification.commands`);
    if (commands.length === 0) throw new Error(`task ${id} 的 verification.commands 不能为空`);
    let timeoutSeconds = 300;
    const ts = vRaw.timeout_seconds ?? vRaw.timeoutSeconds;
    if (typeof ts === 'number' && ts > 0) timeoutSeconds = ts;

    return {
      id,
      title,
      summary,
      ...(executor ? { executor } : {}),
      dependsOn,
      scope: { paths },
      verification: { commands, timeoutSeconds },
    };
  });
}

/** 写入 graph.yaml */
export async function writeTaskGraph(
  speccraftDir: string,
  runId: string,
  graph: TaskGraph,
): Promise<void> {
  const dir = tasksDir(speccraftDir, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, GRAPH_FILE), stringifyTaskGraph(graph), 'utf8');
}

/** 读取 graph.yaml；不存在时抛错 */
export async function readTaskGraph(speccraftDir: string, runId: string): Promise<TaskGraph> {
  const file = path.join(tasksDir(speccraftDir, runId), GRAPH_FILE);
  if (!(await pathExists(file))) {
    throw new Error(`Task Graph 不存在：${file}`);
  }
  return parseTaskGraph(await readFile(file, 'utf8'));
}

/** 读取 graph.yaml；不存在时返回 null */
export async function readTaskGraphOrNull(
  speccraftDir: string,
  runId: string,
): Promise<TaskGraph | null> {
  const file = path.join(tasksDir(speccraftDir, runId), GRAPH_FILE);
  if (!(await pathExists(file))) return null;
  return parseTaskGraph(await readFile(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// Task Manifest
// ---------------------------------------------------------------------------

/** 序列化 TaskManifest 为 manifest.yaml 文本 */
export function stringifyTaskManifest(manifest: TaskManifest): string {
  return yaml.dump(
    {
      id: manifest.id,
      status: manifest.status,
      created_at: manifest.createdAt,
      updated_at: manifest.updatedAt,
      dispatch_attempts: manifest.dispatchAttempts,
      verification_attempts: manifest.verificationAttempts,
      ...(manifest.latestSessionId ? { latest_session_id: manifest.latestSessionId } : {}),
      ...(manifest.lastError ? { last_error: manifest.lastError } : {}),
      reopened_count: manifest.reopenedCount,
    },
    { indent: 2, lineWidth: -1, noRefs: true },
  );
}

/** 解析 manifest.yaml 文本 */
export function parseTaskManifest(source: string): TaskManifest {
  const loaded = yaml.load(source);
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error('task manifest 顶层必须是对象');
  }
  const obj = loaded as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id : '';
  if (!id) throw new Error('task manifest 缺少 id');
  if (!isTaskStatus(obj.status)) {
    throw new Error(`task ${id} 的 status 非法: ${String(obj.status)}`);
  }
  return {
    id,
    status: obj.status,
    createdAt: typeof obj.created_at === 'string' ? obj.created_at : '',
    updatedAt: typeof obj.updated_at === 'string' ? obj.updated_at : '',
    dispatchAttempts: toNumArray(obj.dispatch_attempts),
    verificationAttempts: toNumArray(obj.verification_attempts),
    ...(typeof obj.latest_session_id === 'string' && obj.latest_session_id
      ? { latestSessionId: obj.latest_session_id }
      : {}),
    ...(typeof obj.last_error === 'string' && obj.last_error
      ? { lastError: obj.last_error }
      : {}),
    reopenedCount: typeof obj.reopened_count === 'number' ? obj.reopened_count : 0,
  };
}

/** 创建 task 目录 + 初始 manifest */
export async function createTaskManifest(
  speccraftDir: string,
  runId: string,
  taskId: string,
  status: TaskStatus,
  now: Date = new Date(),
): Promise<TaskManifest> {
  const dir = taskDir(speccraftDir, runId, taskId);
  await mkdir(path.join(dir, 'verification'), { recursive: true });
  const iso = now.toISOString();
  const manifest: TaskManifest = {
    id: taskId,
    status,
    createdAt: iso,
    updatedAt: iso,
    dispatchAttempts: [],
    verificationAttempts: [],
    reopenedCount: 0,
  };
  await writeTaskManifest(speccraftDir, runId, manifest);
  return manifest;
}

/** 写入 manifest.yaml */
export async function writeTaskManifest(
  speccraftDir: string,
  runId: string,
  manifest: TaskManifest,
): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  const dir = taskDir(speccraftDir, runId, manifest.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, MANIFEST_FILE), stringifyTaskManifest(manifest), 'utf8');
}

/** 读取单个 task 的 manifest */
export async function readTaskManifest(
  speccraftDir: string,
  runId: string,
  taskId: string,
): Promise<TaskManifest | null> {
  const file = path.join(taskDir(speccraftDir, runId, taskId), MANIFEST_FILE);
  if (!(await pathExists(file))) return null;
  return parseTaskManifest(await readFile(file, 'utf8'));
}

/** 读取全部 task manifest（返回 Map<taskId, TaskManifest>） */
export async function readAllTaskManifests(
  speccraftDir: string,
  runId: string,
): Promise<Map<string, TaskManifest>> {
  const graph = await readTaskGraphOrNull(speccraftDir, runId);
  const result = new Map<string, TaskManifest>();
  if (!graph) return result;
  for (const t of graph.tasks) {
    const m = await readTaskManifest(speccraftDir, runId, t.id);
    if (m) result.set(t.id, m);
  }
  return result;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toStrArray(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
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
