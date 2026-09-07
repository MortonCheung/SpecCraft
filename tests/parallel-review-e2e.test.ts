/**
 * Parallel Review E2E（v0.8 §14 / E2E I-J 基座）。
 *
 * 通过 executeParallelTaskGraph() 真实链路验证 parallel Review Attempt 证据：
 *   P1a: review PASS → task 集成并 completed；attempt manifest 必须写
 *         workspace_attempt == 对应 workspace attempt（1），decision == pass，
 *         session_id 由 adapter.normalize 提取（fresh session）。
 *   P1b: Reviewer mutation（review-dirty）→ attempt decision=error +
 *         error_code=reviewer_mutation（结构化，不埋进字符串）；
 *         workspace failed / failure_phase == review / task failed。
 *
 * 说明：权威 E2E I/J（多 task 并行 wave）由后续 commit 补全；本文件聚焦
 * §14 workspace_attempt / error_code Evidence，覆盖 parallel route 的 review 接线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initProject } from '../src/core/init.js';
import { loadProject, loadProjectConfig } from '../src/core/project.js';
import { completeStage, approveStage } from '../src/core/advance.js';
import { writeArtifact, readArtifact, createArtifact, artifactFileName } from '../src/core/artifacts/store.js';
import { resolveTemplateContent } from '../src/core/templates/resolver.js';
import { prepareExecution } from '../src/core/execution/prepare.js';
import { registerAdapter } from '../src/core/execution/adapters/registry.js';
import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import { compileTaskGraph } from '../src/core/tasks/compiler.js';
import { executeParallelTaskGraph } from '../src/core/parallel/orchestrator.js';
import { readTaskManifest } from '../src/core/tasks/store.js';
import { readReviewManifestOrNull } from '../src/core/reviews/attempt.js';
import { readReviewPlanOrNull } from '../src/core/reviews/store.js';
import { readWorkspace } from '../src/core/workspaces/store.js';
import { readCanonicalHead, isCanonicalClean } from '../src/core/workspaces/integration.js';
import { runGit } from '../src/core/workspaces/git.js';
import type { CliExecutionAdapter, NormalizedDispatchResult } from '../src/core/execution/adapters/types.js';
import type { Workflow, State } from '../src/core/types.js';

const fakeAgentPath = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// Fake Work Adapter（isolated worktree 内真实施工，id = fake）
// ---------------------------------------------------------------------------

interface WorkSpec {
  write?: Record<string, string>;
  sleepMs?: number;
}

function makeWorkAdapter(plan: Record<string, WorkSpec>): CliExecutionAdapter {
  return {
    id: 'fake',
    kind: 'cli',
    capabilities: {
      invoke: true, resume: true, structuredOutput: true,
      finalMessageFile: true, sessionId: true, modelSelection: false,
    },
    prepare: manualAdapter.prepare,
    probe: async () => ({ id: 'fake', installed: true }),
    buildInvocation: async (input) => ({
      command: 'node',
      args: [fakeAgentPath],
      cwd: input.projectRoot,
      stdin: input.prompt,
      env: {
        FAKE_AGENT_MODE: 'work',
        FAKE_AGENT_PLAN: JSON.stringify(plan),
        FAKE_AGENT_SESSION: `exec-${Math.random().toString(16).slice(2, 6)}`,
      },
      timeoutMs: 60000,
    }),
    normalize: async (input): Promise<NormalizedDispatchResult> => {
      let sessionId: string | undefined;
      for (const line of input.stdout.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.session_id) sessionId = obj.session_id;
        } catch { /* ignore */ }
      }
      return {
        adapter: 'fake',
        status: input.timedOut ? 'timed_out' : input.spawnError ? 'spawn_error' : input.exitCode === 0 ? 'succeeded' : 'failed',
        exitCode: input.exitCode ?? undefined,
        timedOut: input.timedOut,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        durationMs: input.durationMs,
        ...(sessionId ? { sessionId } : {}),
        events: [],
      };
    },
  };
}

/** 从 review attempt dir（.../reviews/<gate>/attempt-NNN）派生确定性 provider session */
function reviewSessionFromRunDir(runDir: string): string {
  const m = runDir.match(/attempt-(\d+)/);
  return m ? `review-session-${Number(m[1])}` : `review-session-${Date.now()}`;
}

/** Fake Reviewer Adapter（id = fake-reviewer；review-pass / review-dirty 等模式） */
function makeReviewerAdapter(mode: string): CliExecutionAdapter {
  return {
    id: 'fake-reviewer',
    kind: 'cli',
    capabilities: { invoke: true, resume: false, structuredOutput: false, finalMessageFile: false, sessionId: true, modelSelection: false },
    prepare: manualAdapter.prepare,
    probe: async () => ({ id: 'fake-reviewer', installed: true }),
    buildInvocation: async (input) => ({
      command: 'node',
      args: [fakeAgentPath],
      cwd: input.projectRoot,
      stdin: input.prompt,
      env: {
        FAKE_AGENT_MODE: mode,
        FAKE_AGENT_SESSION: reviewSessionFromRunDir(input.runDir),
      },
      timeoutMs: 10000,
    }),
    normalize: async (input): Promise<NormalizedDispatchResult> => {
      let sessionId: string | undefined;
      for (const line of input.stdout.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const obj = JSON.parse(t) as { session_id?: string };
          if (obj.session_id) sessionId = obj.session_id;
        } catch { /* ignore */ }
      }
      return {
        adapter: 'fake-reviewer',
        status: input.exitCode === 0 ? 'succeeded' : 'failed',
        exitCode: input.exitCode ?? undefined,
        timedOut: input.timedOut,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        durationMs: input.durationMs,
        ...(sessionId ? { sessionId } : {}),
        events: [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 最小 review-enabled parallel 项目
// ---------------------------------------------------------------------------

async function makeArtifact(speccraftDir: string, workflow: Workflow, state: State, stageId: string): Promise<void> {
  const stage = workflow.stages.find((s) => s.id === stageId)!;
  const target = completeStage(workflow, state, stageId);
  const body = await resolveTemplateContent(stage.template ?? stage.id);
  const artifact = createArtifact({ artifact: stage.produces[0], stage: stageId, status: target, version: 1 }, body);
  await writeArtifact(path.join(speccraftDir, 'artifacts', artifactFileName(stage.produces[0])), artifact);
}

function taskBlock(tasks: string[]): string {
  return [
    '## Execution Task Graph',
    '',
    '```speccraft-task-graph',
    'version: 1',
    '',
    'tasks:',
    ...tasks,
    '```',
  ].join('\n');
}

const VERIF_OK = "verification: { commands: [echo ok], timeout_seconds: 30 }";

const SINGLE_BLOCK = taskBlock([
  `  - id: a
    title: A
    summary: Do A
    depends_on: []
    scope: { paths: [src/a/**] }
    ${VERIF_OK}`,
]);

const LINEAR_BLOCK = taskBlock([
  `  - id: a
    title: A
    summary: Do A
    depends_on: []
    scope: { paths: [src/a/**] }
    ${VERIF_OK}`,
  `  - id: b
    title: B
    summary: Do B
    depends_on: [a]
    scope: { paths: [src/b/**] }
    ${VERIF_OK}`,
]);

function reviewEnabledYaml(): string {
  return [
    'name: par-review-e2e',
    'execution:',
    '  default_adapter: fake',
    'verification:',
    '  timeout_seconds: 60',
    '  commands:',
    '    - "true"',
    'review:',
    '  enabled: true',
    '  default_reviewer: fake-reviewer',
    '  reviewers:',
    '    fake-reviewer: { adapter: fake-reviewer }',
    '  gates:',
    '    - id: spec_compliance',
    '      kind: spec_compliance',
    '      reviewer: fake-reviewer',
  ].join('\n');
}

async function makeReviewParallelProject(
  block: string,
): Promise<{ root: string; speccraftDir: string; runId: string; baseCommit: string; outer: string }> {
  const outer = await mkdtemp(path.join(os.tmpdir(), 'speccraft-par-review-'));
  const root = path.join(outer, 'proj');
  await mkdir(root, { recursive: true });
  await runGit(root, ['init', '-q']);
  await runGit(root, ['config', 'user.email', 'test@example.com']);
  await runGit(root, ['config', 'user.name', 'Test']);
  await writeFile(path.join(root, '.gitignore'), '.speccraft/\n', 'utf8');
  await writeFile(path.join(root, 'README.md'), 'init\n', 'utf8');
  await runGit(root, ['add', '.']);
  await runGit(root, ['commit', '-q', '-m', 'init']);
  const baseCommit = (await readCanonicalHead(root))!;

  const { speccraftDir } = await initProject({ projectRoot: root });
  const { workflow, state } = await loadProject(root);
  for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
    await makeArtifact(speccraftDir, workflow, state, id);
  }
  approveStage(workflow, state, 'design', 'owner');
  for (const id of ['build-brief', 'site-survey', 'execution-manual']) {
    await makeArtifact(speccraftDir, workflow, state, id);
  }
  const manualPath = path.join(speccraftDir, 'artifacts', 'execution-manual.md');
  const manual = await readArtifact(manualPath);
  manual.body = block;
  await writeArtifact(manualPath, manual);

  const { writeState } = await import('../src/core/state/store.js');
  await writeState(speccraftDir, state);

  await writeFile(path.join(speccraftDir, 'project.yaml'), reviewEnabledYaml(), 'utf8');

  // plan 冻结需要 registry 已知 gate adapter（后续用同 id cli adapter 覆盖）
  registerAdapter({ ...manualAdapter, id: 'fake-reviewer' } as any);
  registerAdapter(makeWorkAdapter({}));

  const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake' });
  const { readExecutionManualBody } = await import('../src/core/tasks/compiler.js');
  const projectConfig = await loadProjectConfig(speccraftDir);
  await compileTaskGraph({ speccraftDir, runId, manualBody: block, source: 'execution-manual', projectConfig });
  return { root, speccraftDir, runId, baseCommit, outer };
}

/** 删除整个测试外层目录（含 repo 与 worktrees） */
function projectCleanup(root: string): Promise<void> {
  return rm(path.dirname(root), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('P1a — parallel review PASS：manifest 写 workspace_attempt=1 + session_id，task completed', async () => {
  const plan: Record<string, WorkSpec> = {
    a: { write: { 'src/a/base.txt': 'A' } },
    b: { write: { 'src/b/impl.ts': 'B' } },
  };
  const workAdapter = makeWorkAdapter(plan);
  const reviewer = makeReviewerAdapter('review-pass');
  const p = await makeReviewParallelProject(LINEAR_BLOCK);
  try {
    registerAdapter(workAdapter);
    registerAdapter(reviewer);

    const reviewPlan = await readReviewPlanOrNull(p.speccraftDir, p.runId);
    assert.ok(reviewPlan, 'Frozen review plan must exist');
    assert.ok(reviewPlan!.enabled, 'Review plan must be enabled');

    const result = await executeParallelTaskGraph({
      speccraftDir: p.speccraftDir,
      projectRoot: p.root,
      runId: p.runId,
      adapter: workAdapter,
      runContext: '# ctx',
      executionGuard: '# guard',
      maxParallel: 2,
      reviewPlan: reviewPlan!,
    });

    assert.equal(result.complete, true, `execution should complete（reason=${result.reason ?? 'n/a'}）`);
    for (const id of ['a', 'b']) {
      assert.equal((await readTaskManifest(p.speccraftDir, p.runId, id))?.status, 'completed', `task ${id}`);
      // §14：parallel Review Attempt manifest 必须写 workspace_attempt
      const attemptDir = path.join(p.speccraftDir, 'runs', p.runId, 'tasks', id, 'reviews', 'spec_compliance', 'attempt-001');
      const manifest = await readReviewManifestOrNull(attemptDir);
      assert.ok(manifest, `review attempt manifest for ${id} must exist`);
      assert.equal(manifest!.decision, 'pass', `task ${id} review must pass`);
      assert.equal(manifest!.workspace_attempt, 1, `task ${id} workspace_attempt must be 1`);
      assert.ok(manifest!.session_id, `task ${id} must carry normalized reviewer session_id`);
    }
    assert.equal(await isCanonicalClean(p.root), true);
    assert.notEqual(await readCanonicalHead(p.root), p.baseCommit, 'integration commits must exist');
  } finally {
    await projectCleanup(p.root);
  }
});

test('P1b — parallel review mutation（review-dirty）→ decision=error + error_code=reviewer_mutation，workspace failed(review)', async () => {
  const plan: Record<string, WorkSpec> = {
    a: { write: { 'src/a/base.txt': 'A' } },
  };
  const workAdapter = makeWorkAdapter(plan);
  const reviewer = makeReviewerAdapter('review-dirty'); // reviewer 在 review worktree 真实改文件
  const p = await makeReviewParallelProject(SINGLE_BLOCK);
  try {
    registerAdapter(workAdapter);
    registerAdapter(reviewer);

    const reviewPlan = await readReviewPlanOrNull(p.speccraftDir, p.runId);
    assert.ok(reviewPlan);

    const result = await executeParallelTaskGraph({
      speccraftDir: p.speccraftDir,
      projectRoot: p.root,
      runId: p.runId,
      adapter: workAdapter,
      runContext: '# ctx',
      executionGuard: '# guard',
      maxParallel: 1,
      reviewPlan: reviewPlan!,
    });

    assert.equal(result.complete, false);

    // §14：attempt manifest 必须结构化 error_code（不埋进 error_message）
    const attemptDir = path.join(p.speccraftDir, 'runs', p.runId, 'tasks', 'a', 'reviews', 'spec_compliance', 'attempt-001');
    const manifest = await readReviewManifestOrNull(attemptDir);
    assert.ok(manifest, 'review attempt manifest must exist');
    assert.equal(manifest!.decision, 'error');
    assert.equal(manifest!.error_code, 'reviewer_mutation');
    assert.ok(manifest!.error_message && manifest!.error_message.length > 0);
    assert.equal(manifest!.workspace_attempt, 1);

    // workspace failed / failure_phase == review / task failed / canonical 不变
    const ws = await readWorkspace(p.speccraftDir, p.runId, 'a', 1);
    assert.ok(ws, 'workspace manifest must exist');
    assert.equal(ws!.status, 'failed');
    assert.equal(ws!.failurePhase, 'review');
    assert.equal((await readTaskManifest(p.speccraftDir, p.runId, 'a'))?.status, 'failed');
    assert.equal(await readCanonicalHead(p.root), p.baseCommit, 'canonical must stay unchanged');
  } finally {
    await projectCleanup(p.root);
  }
});
