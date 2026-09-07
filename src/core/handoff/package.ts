/**
 * Handoff Package 组装与落盘（ADR 0004 §6）。
 *
 * 把 compiler 的各部分确定性组合为 .speccraft/handoffs/<handoff-id>/ 目录。
 * 不调用 AI、不修改源 Artifact、不复制无关文件。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionRunManifest } from '../execution/types.js';
import type { Workflow } from '../types.js';
import {
  compileHandoffContext,
  compileDecisions,
  compileExecutionHistory,
  compileVerificationHistory,
  compileAcceptanceHistory,
  compileExecutorHistory,
  compileReviewHistory,
  compileGitSnapshot,
  renderHandoffDoc,
  renderDecisionsDoc,
  renderManifestYaml,
  makeSourceLists,
} from './compiler.js';
import type { HandoffCompileInput } from './types.js';

export interface CompileHandoffPackageOptions {
  speccraftDir: string;
  projectRoot: string;
  projectName: string;
  workflow: Workflow;
  run: ExecutionRunManifest;
  handoffId: string;
  createdAt: string;
}

/** handoff 目录绝对路径 */
export function handoffDir(speccraftDir: string, handoffId: string): string {
  return path.join(speccraftDir, 'handoffs', handoffId);
}

/** 编译并落盘 Handoff Package，返回已写入的文件名列表 */
export async function compileHandoffPackage(
  options: CompileHandoffPackageOptions,
): Promise<string[]> {
  const { speccraftDir, projectRoot, workflow, run, handoffId, createdAt, projectName } = options;

  const { markdown: contextMarkdown, missing: missingArtifacts } = await compileHandoffContext(
    speccraftDir,
    workflow,
  );
  const decisions = await compileDecisions(speccraftDir);
  const executionHistory = await compileExecutionHistory(speccraftDir, run.id);
  const verificationHistory = await compileVerificationHistory(speccraftDir, run.id);
  const acceptanceHistory = await compileAcceptanceHistory(speccraftDir, run.id);
  const executorHistory = await compileExecutorHistory(speccraftDir, run.id);
  const reviewHistory = await compileReviewHistory(speccraftDir, run.id);
  const git = await compileGitSnapshot(projectRoot);
  const sourceLists = await makeSourceLists(speccraftDir, run.id);

  const input: HandoffCompileInput = {
    handoffId,
    runId: run.id,
    createdAt,
    projectName,
    projectRoot,
    contextMarkdown,
    decisions,
    executionHistory,
    verificationHistory,
    acceptanceHistory,
    executorHistory,
    reviewHistory,
    missingArtifacts,
    git,
    verification: {
      latest_attempt: run.verificationAttempts,
      status: 'pass',
    },
    acceptance: {
      latest_attempt: run.acceptance.attempt,
      decision: run.acceptance.status,
      ...(run.acceptance.latestRecord ? { record: run.acceptance.latestRecord } : {}),
    },
    sourceLists: sourceLists,
  };

  const manifestYaml = renderManifestYaml(input);

  const files: Record<string, string> = {
    'HANDOFF.md': renderHandoffDoc(input),
    'context.md': contextMarkdown,
    'decisions.md': renderDecisionsDoc(decisions),
    'execution-history.md': `# Execution History\n\n${executionHistory.join('\n')}\n`,
    'verification-history.md': `# Verification History\n\n${verificationHistory.join('\n')}\n`,
    'acceptance-history.md': `# Acceptance History\n\n${acceptanceHistory.join('\n')}\n`,
    'executor-history.md': `# Executor History\n\n${executorHistory.join('\n')}\n`,
    'manifest.yaml': manifestYaml,
  };

  // Review History（v0.8 §17：有 Review evidence 时确定性生成，不调 AI）
  if (reviewHistory.length > 0) {
    files['review-history.md'] = reviewHistory.join('\n') + '\n';
  }

  // Task History（v0.5：有 Task Graph 时确定性生成，不调 AI）
  const taskHistory = await compileTaskHistory(speccraftDir, run.id);
  if (taskHistory) {
    files['task-history.md'] = taskHistory;
  }

  // Workspace History（v0.6 §21：parallel route 时确定性生成，不调 AI）
  const workspaceHistory = await compileWorkspaceHistory(speccraftDir, run.id);
  if (workspaceHistory) {
    files['workspace-history.md'] = workspaceHistory;
  }

  const dir = handoffDir(speccraftDir, handoffId);
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, 'utf8');
    written.push(name);
  }
  return written;
}

export type { HandoffCompileInput };

/** 确定性生成 Workspace History（parallel route 有 waves/workspace 时）；否则返回 null */
async function compileWorkspaceHistory(speccraftDir: string, runId: string): Promise<string | null> {
  const { readTaskGraphOrNull } = await import('../tasks/store.js');
  const graph = await readTaskGraphOrNull(speccraftDir, runId);
  if (!graph) return null;

  const { listWaves, readWaveManifest } = await import('../workspaces/store.js');
  const waves = await listWaves(speccraftDir, runId);
  const { readWorkspaceDetail } = await import('../workspaces/diagnostics.js');

  // 无任何 wave / workspace evidence → sequential route，不生成
  let hasWorkspace = false;
  for (const t of graph.tasks) {
    if ((await readWorkspaceDetail(speccraftDir, runId, t.id)).length > 0) {
      hasWorkspace = true;
      break;
    }
  }
  if (waves.length === 0 && !hasWorkspace) return null;

  const lines: string[] = [
    '# Workspace History',
    '',
    `Run: ${runId}`,
    `Execution Mode: parallel`,
    '',
    '## Waves',
    '',
  ];
  for (const wave of waves) {
    const wm = await readWaveManifest(speccraftDir, runId, wave);
    if (!wm) continue;
    lines.push(
      `- wave-${String(wm.wave).padStart(3, '0')}：tasks [${wm.tasks.join(', ')}]，max parallel ${wm.maxParallel}，base ${wm.baseCommit.slice(0, 10)}`,
    );
    for (const r of wm.results) lines.push(`  - ${r.taskId}: ${r.result}`);
  }
  if (waves.length === 0) lines.push('- （无）');

  lines.push('');
  lines.push('## Task Workspaces');
  lines.push('');
  for (const t of graph.tasks) {
    const details = await readWorkspaceDetail(speccraftDir, runId, t.id);
    if (details.length === 0) continue;
    lines.push(`- ${t.id}:`);
    for (const m of details) {
      lines.push(`  - attempt ${m.attempt}（${m.status}）`);
      lines.push(`    - branch: ${m.branch}`);
      lines.push(`    - base commit: ${m.baseCommit}`);
      lines.push(`    - task commit: ${m.taskCommit ?? '（无）'}`);
      lines.push(`    - integration commit: ${m.integrationCommit ?? '（无）'}`);
      lines.push(`    - scope audit: ${m.scopeAudit.passed ? 'PASS' : 'FAIL'}${m.scopeAudit.violations.length > 0 ? `（violations: ${m.scopeAudit.violations.join(', ')}）` : ''}`);
      lines.push(`    - dispatch attempts: [${m.dispatchAttempts.join(', ') || '无'}]`);
      lines.push(`    - verification attempts: [${m.verificationAttempts.join(', ') || '无'}]`);
      if (m.failurePhase) lines.push(`    - failure phase: ${m.failurePhase}`);
      if (m.conflictingPaths?.length) lines.push(`    - conflicting paths: ${m.conflictingPaths.join(', ')}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** 确定性生成 Task History（有 Task Graph 时）；无则返回 null */
async function compileTaskHistory(speccraftDir: string, runId: string): Promise<string | null> {
  const { readTaskGraphOrNull, readAllTaskManifests } = await import('../tasks/store.js');
  const graph = await readTaskGraphOrNull(speccraftDir, runId);
  if (!graph) return null;

  const manifests = await readAllTaskManifests(speccraftDir, runId);
  const { listDispatchAttemptsForTask } = await import('../dispatch/store.js');
  const { listTaskVerificationAttempts } = await import('../tasks/verification/lifecycle.js');

  const lines: string[] = [
    '# Task History',
    '',
    `Run: ${runId}`,
    `Task Graph 任务数：${graph.tasks.length}`,
    '',
    '## Task 最终状态',
    '',
  ];
  for (const t of graph.tasks) {
    const m = manifests.get(t.id);
    const dA = await listDispatchAttemptsForTask(speccraftDir, runId, t.id);
    const vA = await listTaskVerificationAttempts(speccraftDir, runId, t.id);
    lines.push(`- ${t.id}: ${m?.status ?? '?'}`);
    lines.push(`  - dependencies: ${t.dependsOn.length > 0 ? t.dependsOn.join(', ') : '（无）'}`);
    lines.push(`  - dispatch attempts: [${dA.join(', ') || '无'}]`);
    lines.push(`  - verification attempts: [${vA.join(', ') || '无'}]`);
    lines.push(`  - reopened count: ${m?.reopenedCount ?? 0}`);
    if (m?.latestSessionId) lines.push(`  - provider session: ${m.latestSessionId}`);
  }
  lines.push('');
  return lines.join('\n');
}
