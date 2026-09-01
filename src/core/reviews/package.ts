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
import type { Task } from '../tasks/types.js';
import type { FrozenReviewGate } from './types.js';

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
  
  projectRules: string;
  
  reviewWorktreePath: string;
}

export interface PrepareReviewPackageOptions {
  task: Task;
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
  projectRoot: string;
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
    projectRoot,
  } = options;

  // 1. Load verification evidence
  const verificationDir = path.join(runDir, 'tasks', task.id, 'verification', `attempt-${String(sourceVerificationAttempt).padStart(3, '0')}`);
  const verificationManifestPath = path.join(verificationDir, 'manifest.yaml');
  let verificationEvidence = '';
  try {
    verificationEvidence = await readFile(verificationManifestPath, 'utf-8');
  } catch {
    verificationEvidence = '(verification evidence not found)';
  }

  // 2. Load project rules（Execution Guard relevant）
  const projectRulesPath = path.join(projectRoot, '.speccraft', 'project.md');
  let projectRules = '';
  try {
    projectRules = await readFile(projectRulesPath, 'utf-8');
  } catch {
    projectRules = '(no project rules)';
  }

  // 3. Build package
  const pkg: ReviewPackage = {
    taskId: task.id,
    taskTitle: task.title,
    taskSummary: task.summary || '',
    taskScope: task.scope || [],
    taskDependencies: task.dependencies || [],
    
    gateId: gate.id,
    gateKind: gate.kind,
    
    sourceDispatchAttempt,
    sourceVerificationAttempt,
    
    preTree,
    postTree,
    preCommit,
    postCommit,
    
    diffPatch,
    
    verificationCommands: [], // TODO: extract from task config
    verificationEvidence,
    
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
  lines.push('Check the current Task\'s verified implementation.');
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
  lines.push('The implementation has passed verification:');
  lines.push('```yaml');
  lines.push(pkg.verificationEvidence);
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
