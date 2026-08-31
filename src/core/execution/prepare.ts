/**
 * prepare：编译 Execution Package 并创建 Execution Run（ADR 0003 §5）。
 *
 * 前置门禁：
 *   ready-to-implement == completed
 *   execution-manual == completed
 *
 * prepare 不直接把 implementation 置为 in_progress：
 * 准备好施工包 ≠ Agent 已经开始施工（必须显式 implement start）。
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Workflow, State } from '../types.js';
import { compileContext, renderContext } from '../context/compiler.js';
import { readArtifact, artifactFileName } from '../artifacts/store.js';
import { writeState } from '../state/store.js';
import { loadProject } from '../project.js';
import { loadProjectConfig } from '../project.js';
import { skillsDir } from '../../utils/paths.js';
import { captureGitSnapshot } from './git.js';
import { createRun, writeRun, runDir } from './store.js';
import { manualAdapter } from './adapters/manual.js';
import type { PreparedExecution } from './adapters/types.js';

export interface PrepareOptions {
  projectRoot: string;
  /** 指定 adapter（v0.2 仅 manual） */
  adapterId?: string;
}

export interface PrepareResult {
  runId: string;
  runDir: string;
  files: string[];
}

/** 执行 prepare；违反门禁时抛错 */
export async function prepareExecution(options: PrepareOptions): Promise<PrepareResult> {
  const { speccraftDir, workflow, state } = await loadProject(options.projectRoot);

  assertPrepareGate(workflow, state);

  // 1. 读取 execution-manual artifact（prepare 的核心输入）
  const stage = workflow.stages.find((s) => s.id === 'execution-manual');
  const manualArtifactId = stage?.produces[0] ?? 'execution-manual';
  const manualPath = path.join(speccraftDir, 'artifacts', artifactFileName(manualArtifactId));
  const manualArtifact = await readArtifact(manualPath);

  // 2. Context Compiler 编译 implementation 的上游 context（复用，不重写）
  const compiled = await compileContext(speccraftDir, workflow, 'implementation');
  const compiledContext = renderContext(compiled);

  // 3. 读取 execution-guard skill
  const executionGuard = await readSkill('execution-guard');

  // 4. 项目验证配置
  const config = await loadProjectConfig(speccraftDir);
  const verification = {
    commands: config.verification?.commands ?? [],
    timeoutSeconds: config.verification?.timeoutSeconds ?? 300,
  };

  // 5. Git 快照（只读；非 Git 仓库为 null）
  const gitSnapshot = await captureGitSnapshot(options.projectRoot);

  // 6. 创建 Run
  const manifest = await createRun(speccraftDir, { baseGit: gitSnapshot ?? undefined });

  // 7-9. 通过 adapter 生成 Execution Package 并落盘
  const adapter = options.adapterId === undefined || options.adapterId === 'manual'
    ? manualAdapter
    : unknownAdapter(options.adapterId);

  const prepared: PreparedExecution = await adapter.prepare({
    speccraftDir,
    runId: manifest.id,
    manifest,
    executionManual: manualArtifact.body,
    compiledContext,
    executionGuard,
    verification,
    gitSnapshot,
    readyStages: completedStages(workflow, state),
  });

  const dir = runDir(speccraftDir, manifest.id);
  const files: string[] = [];
  for (const [name, content] of Object.entries(prepared.files)) {
    await writeFile(path.join(dir, name), content, 'utf8');
    files.push(name);
  }

  // 10. 写 manifest + state.active_run（implementation 保持 pending）
  await writeRun(speccraftDir, manifest);
  state.active_run = manifest.id;
  await writeState(speccraftDir, state);

  return { runId: manifest.id, runDir: dir, files };
}

function assertPrepareGate(workflow: Workflow, state: State): void {
  const ready = state.stages['ready-to-implement']?.status;
  if (ready !== 'completed') {
    throw new Error(
      `prepare 要求 ready-to-implement == completed（当前：${ready ?? '未记录'}）。` +
        `请先完成 execution-manual。`,
    );
  }
  const manual = state.stages['execution-manual']?.status;
  if (manual !== 'completed') {
    throw new Error(
      `prepare 要求 execution-manual == completed（当前：${manual ?? '未记录'}）。`,
    );
  }
  // workflow 中必须存在这两个阶段（防御自定义 workflow）
  for (const id of ['execution-manual', 'ready-to-implement', 'implementation']) {
    if (!workflow.stages.some((s) => s.id === id)) {
      throw new Error(`workflow 缺少阶段 ${id}，无法 prepare`);
    }
  }
}

function completedStages(workflow: Workflow, state: State): string[] {
  return workflow.stages
    .filter((s) => {
      const status = state.stages[s.id]?.status;
      return status === 'completed' || status === 'approved';
    })
    .map((s) => s.id);
}

async function readSkill(id: string): Promise<string> {
  const file = path.join(skillsDir, id, 'SKILL.md');
  return readFile(file, 'utf8');
}

function unknownAdapter(id: string): never {
  throw new Error(`未知 execution adapter：${id}（v0.2 仅支持 manual）`);
}
