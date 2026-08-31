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
    'manifest.yaml': manifestYaml,
  };

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
