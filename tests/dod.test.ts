import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import { parseWorkflow } from '../src/core/workflow/loader.js';
import { createInitialState, setStageStatus } from '../src/core/state/store.js';
import { completeStage, approveStage, markStageCompleted } from '../src/core/advance.js';
import { defaultWorkflowPath } from '../src/utils/paths.js';
import type { Workflow } from '../src/core/types.js';

const workflow: Workflow = parseWorkflow(await readFile(defaultWorkflowPath, 'utf8'));

test('M2.7 DoD #25#26：Runtime 无数据库 / 无 AI 厂商 / 无 execa、nanoid', async () => {
  const pkg = JSON.parse(
    await readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  const deps = Object.keys(pkg.dependencies ?? {});
  const devDeps = Object.keys(pkg.devDependencies ?? {});

  // 无数据库 / ORM
  for (const banned of ['sqlite', 'pg', 'mysql', 'mongodb', 'prisma', 'typeorm', 'drizzle']) {
    assert.ok(!deps.includes(banned) && !devDeps.includes(banned), `不应依赖 ${banned}`);
  }
  // 无 execa / nanoid
  assert.ok(!deps.includes('execa'), '不应依赖 execa');
  assert.ok(!deps.includes('nanoid'), '不应依赖 nanoid');
  // 无任何 AI 厂商 SDK
  for (const banned of [
    '@anthropic-ai/sdk',
    'openai',
    '@openai/codex',
    'codex',
    'claude-code',
    '@aws-sdk',
  ]) {
    assert.ok(!deps.includes(banned) && !devDeps.includes(banned), `不应依赖 ${banned}`);
  }
});

test('M2.7 DoD #27：manual adapter 可单独运行（无 CLI / 无 AI / 无 Git）', async () => {
  const prepared = await manualAdapter.prepare({
    speccraftDir: '/nonexistent',
    runId: 'run-dod-standalone',
    manifest: {
      id: 'run-dod-standalone',
      status: 'prepared',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      contextFile: 'context.md',
      promptFile: 'agent-prompt.md',
      reports: [],
      verificationAttempts: 0,
    },
    executionManual: '# 手册\n\n实施它。',
    compiledContext: '# Execution Context\n\n需求。',
    executionGuard: '# Guard\n\nYAGNI。',
    verification: { commands: ['npm test'], timeoutSeconds: 300 },
    gitSnapshot: null,
    readyStages: ['idea', 'design'],
  });

  assert.ok(prepared.files['context.md']);
  assert.ok(prepared.files['agent-prompt.md']);
  // prompt 是自包含施工入口：内嵌 Manual / Context / Guard
  const prompt = prepared.files['agent-prompt.md'];
  assert.ok(prompt.includes('实施它'));
  assert.ok(prompt.includes('需求'));
  assert.ok(prompt.includes('YAGNI'));
});

test('M2.7 DoD：implementation / verification 用 markStageCompleted 显式推进（不依赖 auto_complete）', () => {
  const state = createInitialState(workflow);
  for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
    completeStage(workflow, state, id);
  }
  approveStage(workflow, state, 'design', 'owner');
  for (const id of ['build-brief', 'site-survey', 'execution-manual']) {
    completeStage(workflow, state, id);
  }

  // implementation 不会自动完成（gate 满足）
  assert.equal(state.stages['implementation'].status, 'pending');

  // 显式 start / finish 语义
  setStageStatus(state, 'implementation', 'in_progress');
  markStageCompleted(workflow, state, 'implementation');
  assert.equal(state.stages['implementation'].status, 'completed');
  assert.equal(state.current_stage, 'verification');

  // verification 显式完成（不经过 owner approval）
  markStageCompleted(workflow, state, 'verification');
  assert.equal(state.stages['verification'].status, 'completed');
  assert.equal(state.stages['owner-acceptance'].status, 'pending');
});
