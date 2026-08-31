/**
 * Execution Manual → Task Graph Compiler（ADR 0006 §5）。
 *
 * Runtime 不调用 LLM 拆 Task。Compiler 只做：
 *   extract block → YAML parse → schema validation → graph validation → persist。
 *
 * legacy（无 speccraft-task-graph block）由调用方给出清晰诊断，不静默生成默认 Task。
 */

import path from 'node:path';
import yaml from 'js-yaml';
import type { TaskGraph } from './types.js';
import { parseTaskDefinitions, writeTaskGraph, createTaskManifest } from './store.js';
import type { TaskManifest } from './types.js';

export interface CompileResult {
  graph: TaskGraph;
  /** 每个 task 的初始状态 */
  initial: Record<string, TaskManifest['status']>;
}

/** 从 Execution Manual body 提取唯一 speccraft-task-graph block（YAML 文本） */
export function extractTaskGraphBlock(body: string): string | null {
  const re = /```speccraft-task-graph\s*\n([\s\S]*?)```/;
  const match = body.match(re);
  if (!match) return null;
  // 校验唯一：不允许出现第二个 block
  const rest = body.slice(match.index! + match[0].length);
  if (re.test(rest)) {
    throw new Error('Execution Manual 包含多个 speccraft-task-graph block，只允许一个');
  }
  return match[1].trim();
}

/** 校验并归一化 scope path（拒绝绝对路径 / .. 越界） */
export function validateScopePaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    const p = raw.trim();
    if (!p) throw new Error(`scope.paths 包含空路径`);
    if (path.isAbsolute(p)) throw new Error(`scope.paths 不允许绝对路径：${p}`);
    const parts = p.split(/[\\/]/).filter((s) => s.length > 0 && s !== '.');
    if (parts.includes('..')) throw new Error(`scope.paths 不允许 .. 越出 repo：${p}`);
    out.push(parts.join('/'));
  }
  return out;
}

/** 校验 graph 的 DAG 约束（unique id / self dep / missing dep / cycle） */
export function validateGraphConstraints(graph: TaskGraph): void {
  const ids = new Set<string>();
  for (const t of graph.tasks) {
    if (ids.has(t.id)) throw new Error(`task id 重复：${t.id}`);
    ids.add(t.id);
  }
  for (const t of graph.tasks) {
    if (t.dependsOn.includes(t.id)) throw new Error(`task ${t.id} 不允许 self dependency`);
    for (const d of t.dependsOn) {
      if (!ids.has(d)) throw new Error(`task ${t.id} 的依赖不存在：${d}`);
    }
  }
  // cycle 检测（DFS 三色）
  const color = new Map<string, 0 | 1 | 2>(); // 0 white 1 gray 2 black
  const visit = (id: string): void => {
    const c = color.get(id) ?? 0;
    if (c === 2) return;
    if (c === 1) throw new Error(`task graph 存在 cycle（涉及 ${id}）`);
    color.set(id, 1);
    const task = graph.tasks.find((t) => t.id === id)!;
    for (const d of task.dependsOn) visit(d);
    color.set(id, 2);
  };
  for (const t of graph.tasks) visit(t.id);
}

/** 计算初始状态：无依赖 → ready，有依赖 → pending */
export function initialTaskStates(graph: TaskGraph): Record<string, TaskManifest['status']> {
  const states: Record<string, TaskManifest['status']> = {};
  for (const t of graph.tasks) {
    states[t.id] = t.dependsOn.length === 0 ? 'ready' : 'pending';
  }
  return states;
}

/**
 * 编译 Task Graph：从 Execution Manual body 提取、解析、校验并落盘，
 * 为每个 task 创建初始 manifest。
 */
export async function compileTaskGraph(options: {
  speccraftDir: string;
  runId: string;
  manualBody: string;
  source: string;
  now?: Date;
}): Promise<CompileResult> {
  const block = extractTaskGraphBlock(options.manualBody);
  if (block === null) {
    throw new Error(
      'Execution Manual 未包含 speccraft-task-graph block。\n' +
        'legacy 项目可继续使用 speccraft prepare / dispatch；\n' +
        '如需 Task Graph 请在 Execution Manual 补充「Execution Task Graph」段。',
    );
  }

  // block 内是完整的 version + tasks YAML
  const loaded = yaml.load(block);
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error('speccraft-task-graph block 必须是对象');
  }
  const obj = loaded as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`task graph version 必须为 1（实际 ${String(obj.version)}）`);
  }

  const tasks = parseTaskDefinitions(obj.tasks);
  const graph: TaskGraph = {
    version: 1,
    runId: options.runId,
    source: options.source,
    createdAt: options.now?.toISOString() ?? new Date().toISOString(),
    tasks,
  };

  // scope + DAG 校验
  for (const t of graph.tasks) {
    validateScopePaths(t.scope.paths);
  }
  validateGraphConstraints(graph);

  // 落盘
  await writeTaskGraph(options.speccraftDir, options.runId, graph);

  // 初始 manifest
  const initial = initialTaskStates(graph);
  for (const t of graph.tasks) {
    await createTaskManifest(options.speccraftDir, options.runId, t.id, initial[t.id], options.now);
  }

  return { graph, initial };
}

/** 读取 execution-manual artifact body（供 compile 前读取） */
export async function readExecutionManualBody(speccraftDir: string): Promise<string> {
  const { readArtifact, artifactFileName } = await import('../artifacts/store.js');
  const file = path.join(speccraftDir, 'artifacts', artifactFileName('execution-manual'));
  const artifact = await readArtifact(file);
  return artifact.body;
}
