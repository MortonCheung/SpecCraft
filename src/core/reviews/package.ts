/**
 * Review Package（ADR 0009 §49-§51）。
 *
 * Reviewer 获得：
 *   - Task Contract（ID / title / summary / scope / dependencies）
 *   - Execution Guard relevant rules
 *   - Gate kind
 *   - source Dispatch Attempt / Verification Attempt
 *   - Verification commands + PASS evidence
 *   - preTree / postTree
 *   - review snapshot workspace
 *
 * Reviewer 不获得：
 *   - 整个 Planner 会话
 *   - Owner 私人聊天
 *   - Executor 隐藏 chain-of-thought
 *   - 其它不相关 Task 历史
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import type { TaskDefinition } from '../tasks/types.js';
import type { FrozenReviewGate } from './types.js';

/** §11.1：verification.md 中逐命令状态（从真实 Verification attempt manifest 解析） */
export interface VerificationCommandStatus {
  command: string;
  passed: boolean;
  exit_code?: number;
}

export interface ReviewPackage {
  taskId: string;
  taskTitle: string;
  taskSummary: string;
  taskScope: string[];
  taskDependencies: string[];
  
  gateId: string;
  gateKind: string;
  
  sourceDispatchAttempt: number;
  sourceVerificationAttempt: number;
  
  preTree: string;
  postTree: string;
  preCommit: string;
  postCommit: string;
  
  diffPatch: string;
  
  verificationCommands: string[];
  verificationEvidence: string;
  /** 逐命令 status（真实 Verification manifest 解析，非 AI） */
  verificationEvidenceStatus: VerificationCommandStatus[];
  verificationEvidenceDir: string;
  
  projectRules: string;
  
  reviewWorktreePath: string;
}

export interface PrepareReviewPackageOptions {
  task: TaskDefinition;
  gate: FrozenReviewGate;
  sourceDispatchAttempt: number;
  sourceVerificationAttempt: number;
  preTree: string;
  postTree: string;
  preCommit: string;
  postCommit: string;
  diffPatch: string;
  reviewWorktreePath: string;
  runDir: string;
  /** §11.2：真实 Execution Guard 文本（orchestrator 已加载的同一份，不再读不存在的 project.md） */
  executionGuard?: string;
}

/**
 * Prepare Review Package（§49）。
 */
export async function prepareReviewPackage(
  options: PrepareReviewPackageOptions,
): Promise<{ ok: boolean; package?: ReviewPackage; error?: string }> {
  const {
    task,
    gate,
    sourceDispatchAttempt,
    sourceVerificationAttempt,
    preTree,
    postTree,
    preCommit,
    postCommit,
    diffPatch,
    reviewWorktreePath,
    runDir,
    executionGuard,
  } = options;

  // 1. Load verification evidence（真实路径：runs/<runId>/tasks/<task>/verification/attempt-NNN/）
  const verificationAttemptDir = path.join(
    runDir,
    'tasks', task.id,
    'verification',
    `attempt-${String(sourceVerificationAttempt).padStart(3, '0')}`,
  );
  const verificationManifestPath = path.join(verificationAttemptDir, 'manifest.yaml');
  let verificationEvidence = '';
  try {
    verificationEvidence = await readFile(verificationManifestPath, 'utf-8');
  } catch {
    verificationEvidence = '';
  }

  // §11.1：确定性解析逐命令状态（不调用 AI）
  let verificationEvidenceStatus: VerificationCommandStatus[] = [];
  if (verificationEvidence) {
    try {
      const doc = yaml.load(verificationEvidence) as { commands?: VerificationCommandStatus[] };
      if (Array.isArray(doc?.commands)) {
        verificationEvidenceStatus = doc.commands.map((c) => ({
          command: String(c.command ?? ''),
          passed: c.passed === true,
          ...(typeof c.exit_code === 'number' ? { exit_code: c.exit_code } : {}),
        }));
      }
    } catch {
      verificationEvidenceStatus = [];
    }
  }

  // §11 / §11.2：Execution Guard relevant rules —— 复用 orchestrator 已加载的同一份真实文本。
  // 不再读取 <projectRoot>/.speccraft/project.md（init 并不创建该文件）。
  const guard = executionGuard?.trim();
  const projectRules = guard ? guard : '(no execution guard)';

  // 3. Build package
  const pkg: ReviewPackage = {
    taskId: task.id,
    taskTitle: task.title,
    taskSummary: task.summary || '',
    taskScope: task.scope?.paths || [],
    taskDependencies: task.dependsOn || [],
    gateId: gate.id,
    gateKind: gate.kind,
    
    sourceDispatchAttempt,
    sourceVerificationAttempt,
    
    preTree,
    postTree,
    preCommit,
    postCommit,
    
    diffPatch,
    
    verificationCommands: task.verification?.commands ?? [],
    verificationEvidence,
    verificationEvidenceStatus,
    verificationEvidenceDir: verificationAttemptDir,
    
    projectRules,
    
    reviewWorktreePath,
  };

  return { ok: true, package: pkg };
}

/**
 * Build Reviewer Prompt（§50-§51）。
 */
export function buildReviewerPrompt(pkg: ReviewPackage, gate: FrozenReviewGate): string {
  const lines: string[] = [];

  lines.push('# Independent Code Review');
  lines.push('');
  lines.push('You are an independent Reviewer.');
  lines.push('');
  lines.push('You are NOT:');
  lines.push('- The Planner');
  lines.push('- The Executor');
  lines.push('- Allowed to modify code');
  lines.push('- Allowed to expand Task Scope');
  lines.push('- Allowed to create new requirements');
  lines.push('');
  lines.push('Your goal:');
  lines.push("Check the current Task's verified implementation.");
  lines.push('');

  lines.push('## Task Contract');
  lines.push('');
  lines.push(`**Task ID**: ${pkg.taskId}`);
  lines.push(`**Title**: ${pkg.taskTitle}`);
  lines.push(`**Summary**: ${pkg.taskSummary}`);
  lines.push(`**Scope**: ${pkg.taskScope.join(', ') || '(no explicit scope)'}`);
  lines.push(`**Dependencies**: ${pkg.taskDependencies.join(', ') || '(none)'}`);
  lines.push('');

  lines.push('## Review Gate');
  lines.push('');
  lines.push(`**Gate ID**: ${pkg.gateId}`);
  lines.push(`**Kind**: ${pkg.gateKind}`);
  lines.push('');

  lines.push('## Review Workspace');
  lines.push('');
  lines.push(`Workspace path: \`${pkg.reviewWorktreePath}\``);
  lines.push('');
  lines.push('You can inspect the code:');
  lines.push('```bash');
  lines.push('cd ' + pkg.reviewWorktreePath);
  lines.push('git status');
  lines.push('git diff HEAD^ HEAD  # exact task delta');
  lines.push('git show HEAD');
  lines.push('```');
  lines.push('');

  lines.push('## Verification Evidence');
  lines.push('');
  lines.push('The implementation passed Task Verification (source attempt ' + pkg.sourceVerificationAttempt + ').');
  lines.push('Detailed evidence is archived as `verification.md` in this Review Attempt evidence dir:');
  lines.push('');
  lines.push(`\`\`\`text`);
  lines.push(`runs/<runId>/tasks/${pkg.taskId}/reviews/${pkg.gateId}/attempt-*/verification.md`);
  lines.push(`\`\`\``);
  lines.push('');
  lines.push('Verification commands:');
  lines.push('');
  for (const c of pkg.verificationCommands) {
    lines.push(`- \`${c}\``);
  }
  lines.push('');
  lines.push('Each command status (from the real Verification manifest):');
  lines.push('');
  lines.push('```text');
  if (pkg.verificationEvidenceStatus.length > 0) {
    for (const c of pkg.verificationEvidenceStatus) {
      const exit = c.exit_code !== undefined ? ` (exit ${c.exit_code})` : '';
      lines.push(`- [${c.passed ? 'PASS' : 'FAIL'}] \`${c.command}\`${exit}`);
    }
  } else {
    lines.push('(verification evidence not found)');
  }
  lines.push('```');
  lines.push('');
  lines.push('Raw verification manifest:');
  lines.push('```yaml');
  lines.push(pkg.verificationEvidence || '(verification evidence not found)');
  lines.push('```');
  lines.push('');

  lines.push('## Project Rules');
  lines.push('');
  lines.push(pkg.projectRules);
  lines.push('');

  lines.push('## Required Output Format');
  lines.push('');
  lines.push('You MUST output a structured review block:');
  lines.push('');
  lines.push('````markdown');
  lines.push('```speccraft-review');
  lines.push('version: 1');
  lines.push('summary: "Your overall assessment"');
  lines.push('');
  lines.push('findings:');
  lines.push('  - severity: blocker|major|minor');
  lines.push('    category: spec|correctness|tests|maintainability|security|scope');
  lines.push('    path: relative/path/to/file.ts');
  lines.push('    line: 42  # optional');
  lines.push('    message: "Description of the issue"');
  lines.push('```');
  lines.push('````');
  lines.push('');
  lines.push('**Severity rules**:');
  lines.push('- `blocker`: Implementation violates task contract or creates critical correctness issues');
  lines.push('- `major`: Significant quality/maintainability concerns that should be addressed');
  lines.push('- `minor`: Suggestions for improvement, not blocking');
  lines.push('');
  lines.push('**Decision derivation** (automated by runtime):');
  lines.push('- Any `blocker` or `major` finding → CHANGES_REQUIRED');
  lines.push('- Only `minor` findings or no findings → PASS');
  lines.push('');

  if (gate.kind === 'spec_compliance') {
    lines.push('## Spec Compliance Rubric');
    lines.push('');
    lines.push('Check:');
    lines.push('1. Does the implementation fulfill the task summary?');
    lines.push('2. Are all declared scope files appropriately modified?');
    lines.push('3. Does the implementation violate any declared dependencies?');
    lines.push('4. Are there any out-of-scope changes?');
    lines.push('5. Does the code match the task contract intent?');
    lines.push('');
  } else if (gate.kind === 'code_quality') {
    lines.push('## Code Quality Rubric');
    lines.push('');
    lines.push('Check:');
    lines.push('1. Code readability and maintainability');
    lines.push('2. Proper error handling');
    lines.push('3. Test coverage (if applicable)');
    lines.push('4. Security best practices');
    lines.push('5. Code duplication and modularity');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Begin your review now. Remember to output the structured `speccraft-review` block.');

  return lines.join('\n');
}
