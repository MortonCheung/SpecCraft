/**
 * Review Orchestrator E2E Tests — Sequential Completion Gate & Evidence Binding
 *
 * 通过 executeTaskGraph() 真实链路验证：
 *   Test A: Reviewer 执行时 Task 必须 in_progress（不是 completed）
 *   Test B: Review FAIL 从 in_progress → failed
 *   Test C: 首轮 Evidence Binding（dispatch=1, verify=1）
 *   Test D: Retry Evidence Binding（dispatch=2, verify=2）
 *   Test E: Review-disabled Legacy Regression
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm, mkdir, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { initProject } from '../src/core/init.js';
import { loadProject } from '../src/core/project.js';
import { completeStage, approveStage } from '../src/core/advance.js';
import { writeArtifact, createArtifact, artifactFileName } from '../src/core/artifacts/store.js';
import { resolveTemplateContent } from '../src/core/templates/resolver.js';
import { prepareExecution } from '../src/core/execution/prepare.js';
import { registerAdapter } from '../src/core/execution/adapters/registry.js';
import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import { compileTaskGraph, readExecutionManualBody } from '../src/core/tasks/compiler.js';
import { readTaskGraph } from '../src/core/tasks/store.js';
import { executeTaskGraph } from '../src/core/tasks/orchestrator.js';
import { readTaskManifest } from '../src/core/tasks/store.js';
import { readReviewManifestOrNull } from '../src/core/reviews/attempt.js';
import { readReviewPlanOrNull } from '../src/core/reviews/store.js';
import { reviewWorktreePath } from '../src/core/reviews/paths.js';
import { loadProjectConfig } from '../src/core/project.js';
import type { CliExecutionAdapter, NormalizedDispatchResult } from '../src/core/execution/adapters/types.js';
import type { Workflow, State } from '../src/core/types.js';

const fakeAgentPath = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

function runGit(cwd: string, args: string[]): void {
  spawnSync('git', args, { cwd, stdio: 'ignore' });
}

async function makeArtifact(speccraftDir: string, workflow: Workflow, state: State, stageId: string): Promise<void> {
  const stage = workflow.stages.find((s) => s.id === stageId)!;
  const target = completeStage(workflow, state, stageId);
  const body = await resolveTemplateContent(stage.template ?? stage.id);
  const artifact = createArtifact({ artifact: stage.produces[0], stage: stageId, status: target, version: 1 }, body);
  await writeArtifact(path.join(speccraftDir, 'artifacts', artifactFileName(stage.produces[0])), artifact);
}

const TASK_BLOCK = [
  '# Execution Manual',
  '',
  '## Execution Task Graph',
  '',
  '```speccraft-task-graph',
  'version: 1',
  '',
  'tasks:',
  '  - id: task-a',
  '    title: Task A',
  '    summary: Do A',
  '    depends_on: []',
  '    scope: { paths: [src/a/**] }',
  '    verification: { commands: [echo ok], timeout_seconds: 30 }',
  '```',
].join('\n');

async function makeReadyProject(projectYaml: string): Promise<{ root: string; speccraftDir: string; runId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-review-e2e-'));
  const { speccraftDir } = await initProject({ projectRoot: root });
  runGit(root, ['init']);
  runGit(root, ['config', 'user.name', 'Test']);
  runGit(root, ['config', 'user.email', 'test@test.com']);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', 'init']);

  const { workflow, state } = await loadProject(root);
  for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
    await makeArtifact(speccraftDir, workflow, state, id);
  }
  approveStage(workflow, state, 'design', 'owner');
  for (const id of ['build-brief', 'site-survey', 'execution-manual']) {
    await makeArtifact(speccraftDir, workflow, state, id);
  }

  const { readArtifact } = await import('../src/core/artifacts/store.js');
  const manualPath = path.join(speccraftDir, 'artifacts', 'execution-manual.md');
  const manual = await readArtifact(manualPath);
  manual.body = TASK_BLOCK;
  await writeArtifact(manualPath, manual);

  const { writeState } = await import('../src/core/state/store.js');
  await writeState(speccraftDir, state);
  await writeFile(path.join(speccraftDir, 'project.yaml'), projectYaml, 'utf8');

  await mkdir(path.join(root, 'src', 'a'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a', 'value.txt'), '', 'utf8');
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', 'scaffold']);

  const { runId } = await prepareExecution({ projectRoot: root, adapter: 'fake-executor', runContext: 'test' });
  return { root, speccraftDir, runId };
}

function makeFakeExecutor(mode: string, opts?: { plan?: Record<string, unknown> }): CliExecutionAdapter {
  return {
    id: 'fake-executor',
    kind: 'cli',
    capabilities: { invoke: true, resume: true, structuredOutput: true, finalMessageFile: true, sessionId: true, modelSelection: false },
    prepare: manualAdapter.prepare,
    probe: async () => ({ id: 'fake-executor', installed: true }),
    buildInvocation: async (input) => ({
      command: 'node',
      args: [fakeAgentPath],
      cwd: input.projectRoot,
      stdin: input.prompt,
      env: {
        FAKE_AGENT_MODE: mode,
        FAKE_AGENT_SESSION: `exec-${Math.random().toString(16).slice(2, 6)}`,
        // v0.8：exact delta 不含 .speccraft/**，executor 必须真实写入工作区文件
        // 才能让 pre/post tree 产生非空 diff（否则 review 命中 no_changes → review_failed）
        ...(opts?.plan ? { FAKE_AGENT_PLAN: JSON.stringify(opts.plan) } : {}),
      },
      timeoutMs: 10000,
    }),
    normalize: async (input): Promise<NormalizedDispatchResult> => {
      let sessionId: string | undefined;
      let finalMessage: string | undefined;
      for (const line of input.stdout.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.session_id) sessionId = obj.session_id;
          if (obj.type === 'final_message') finalMessage = obj.text;
        } catch { /* ignore */ }
      }
      return {
        adapter: 'fake-executor',
        status: input.timedOut ? 'timed_out' : input.spawnError ? 'spawn_error' : input.exitCode === 0 ? 'succeeded' : 'failed',
        exitCode: input.exitCode ?? undefined, timedOut: input.timedOut,
        startedAt: input.startedAt, finishedAt: input.finishedAt, durationMs: input.durationMs,
        ...(sessionId ? { sessionId } : {}), ...(finalMessage ? { finalMessage } : {}), events: [],
      };
    },
  };
}

function makeFakeReviewer(mode: string, opts?: { observeManifest?: string; observeOutput?: string; reviewDecision?: string; reviewFile?: string }): CliExecutionAdapter {
  return {
    id: 'fake-reviewer',
    kind: 'cli',
    capabilities: { invoke: true, resume: false, structuredOutput: false, finalMessageFile: false, sessionId: false, modelSelection: false },
    prepare: manualAdapter.prepare,
    probe: async () => ({ id: 'fake-reviewer', installed: true }),
    buildInvocation: async (input) => ({
      command: 'node',
      args: [fakeAgentPath],
      cwd: input.projectRoot,
      stdin: input.prompt,
      env: {
        FAKE_AGENT_MODE: mode,
        ...(opts?.observeManifest ? { FAKE_AGENT_OBSERVE_MANIFEST: opts.observeManifest } : {}),
        ...(opts?.observeOutput ? { FAKE_AGENT_OBSERVATION_OUTPUT: opts.observeOutput } : {}),
        ...(opts?.reviewDecision ? { FAKE_AGENT_REVIEW_DECISION: opts.reviewDecision } : {}),
        ...(opts?.reviewFile ? { FAKE_AGENT_REVIEW_FILE: opts.reviewFile } : {}),
      },
      timeoutMs: 10000,
    }),
    normalize: async (input): Promise<NormalizedDispatchResult> => ({
      adapter: 'fake-reviewer',
      status: input.exitCode === 0 ? 'succeeded' : 'failed',
      exitCode: input.exitCode ?? undefined, timedOut: input.timedOut,
      startedAt: input.startedAt, finishedAt: input.finishedAt, durationMs: input.durationMs, events: [],
    }),
  };
}

const REVIEW_ENABLED_YAML = [
  'version: 1',
  'execution: { mode: sequential }',
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

const REVIEW_DISABLED_YAML = 'version: 1\nexecution: { mode: sequential }\n';

/** 构造 fake-agent work plan：真实改写工作区文件，令 exact delta（pre/post tree）非空 */
function makeValueWritePlan(taskId: string, content: string): Record<string, unknown> {
  return { [taskId]: { write: { 'src/a/value.txt': content } } };
}

async function compileTaskGraphForRun(speccraftDir: string, runId: string): Promise<void> {
  const { registerAdapter } = await import('../src/core/execution/adapters/registry.js');
  const { manualAdapter } = await import('../src/core/execution/adapters/manual.js');
  registerAdapter({ ...manualAdapter, id: 'fake-reviewer' } as any);

  const manualBody = await readExecutionManualBody(speccraftDir);
  const projectConfig = await loadProjectConfig(speccraftDir);
  await compileTaskGraph({ speccraftDir, runId, manualBody, source: 'execution-manual', projectConfig });
}

test('Test A — Reviewer observes Task status = in_progress during review', async () => {
  const observationFile = path.join(os.tmpdir(), `review-obs-${Date.now()}.txt`);
  const { root, speccraftDir, runId } = await makeReadyProject(REVIEW_ENABLED_YAML);
  try {
    await compileTaskGraphForRun(speccraftDir, runId);

    const graph = await readTaskGraph(speccraftDir, runId);
    const taskId = graph.tasks[0].id;
    const taskManifestPath = path.join(speccraftDir, 'runs', runId, 'tasks', taskId, 'manifest.yaml');

    const workPlan = makeValueWritePlan(taskId, 'v2');
    registerAdapter(makeFakeExecutor('work', { plan: workPlan }));
    registerAdapter(makeFakeReviewer('review-observe', { observeManifest: taskManifestPath, observeOutput: observationFile }));

    await mkdir(path.join(root, 'src', 'a'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a', 'value.txt'), 'v1', 'utf8');

    const reviewPlan = await readReviewPlanOrNull(speccraftDir, runId);
    assert.ok(reviewPlan, 'Frozen review plan must exist');
    assert.ok(reviewPlan!.enabled, 'Review plan must be enabled');

    const result = await executeTaskGraph({
      speccraftDir, projectRoot: root, runId,
      adapter: makeFakeExecutor('work', { plan: workPlan }),
      runContext: 'test', executionGuard: 'test',
      reviewPlan: reviewPlan!,
    });

    const observed = await readFile(observationFile, 'utf8');
    assert.equal(observed.trim(), 'in_progress', 'Reviewer must observe in_progress (not completed)');
    assert.equal(result.complete, true);

    const finalManifest = await readTaskManifest(speccraftDir, runId, taskId);
    assert.equal(finalManifest?.status, 'completed', 'Task must be completed after review PASS');
  } finally {
    await rm(root, { recursive: true, force: true });
    try { await rm(observationFile); } catch { /* */ }
  }
});

test('Test B — Review FAIL transitions from in_progress to failed', async () => {
  const observationFile = path.join(os.tmpdir(), `review-obs-${Date.now()}.txt`);
  const { root, speccraftDir, runId } = await makeReadyProject(REVIEW_ENABLED_YAML);
  try {
    await compileTaskGraphForRun(speccraftDir, runId);

    const graph = await readTaskGraph(speccraftDir, runId);
    const taskId = graph.tasks[0].id;
    const taskManifestPath = path.join(speccraftDir, 'runs', runId, 'tasks', taskId, 'manifest.yaml');

    const workPlan = makeValueWritePlan(taskId, 'v2');
    registerAdapter(makeFakeExecutor('work', { plan: workPlan }));
    registerAdapter(makeFakeReviewer('review-observe', { observeManifest: taskManifestPath, observeOutput: observationFile, reviewDecision: 'major' }));

    await mkdir(path.join(root, 'src', 'a'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a', 'value.txt'), 'v1', 'utf8');

    const reviewPlan = await readReviewPlanOrNull(speccraftDir, runId);
    assert.ok(reviewPlan);

    const result = await executeTaskGraph({
      speccraftDir, projectRoot: root, runId,
      adapter: makeFakeExecutor('work', { plan: workPlan }),
      runContext: 'test', executionGuard: 'test',
      reviewPlan: reviewPlan!,
    });

    const observed = await readFile(observationFile, 'utf8');
    assert.equal(observed.trim(), 'in_progress', 'Reviewer must observe in_progress before FAIL');
    assert.equal(result.complete, false);
    assert.equal(result.reason, 'review_failed');

    const finalManifest = await readTaskManifest(speccraftDir, runId, taskId);
    assert.equal(finalManifest?.status, 'failed', 'Task must be failed after review major');
  } finally {
    await rm(root, { recursive: true, force: true });
    try { await rm(observationFile); } catch { /* */ }
  }
});

test('Test C — first round evidence binding (dispatch=1, verify=1)', async () => {
  const { root, speccraftDir, runId } = await makeReadyProject(REVIEW_ENABLED_YAML);
  try {
    await compileTaskGraphForRun(speccraftDir, runId);

    const graph = await readTaskGraph(speccraftDir, runId);
    const taskId = graph.tasks[0].id;

    const workPlan = makeValueWritePlan(taskId, 'v2');
    registerAdapter(makeFakeExecutor('work', { plan: workPlan }));
    registerAdapter(makeFakeReviewer('review-pass'));

    await mkdir(path.join(root, 'src', 'a'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a', 'value.txt'), 'v1', 'utf8');

    const reviewPlan = await readReviewPlanOrNull(speccraftDir, runId);
    assert.ok(reviewPlan);

    await executeTaskGraph({
      speccraftDir, projectRoot: root, runId,
      adapter: makeFakeExecutor('work', { plan: workPlan }),
      runContext: 'test', executionGuard: 'test',
      reviewPlan: reviewPlan!,
    });

    const reviewManifestPath = path.join(speccraftDir, 'runs', runId, 'tasks', taskId, 'reviews', 'spec_compliance', 'attempt-001');
    const manifest = await readReviewManifestOrNull(reviewManifestPath);
    assert.ok(manifest, 'Review attempt-001 must exist');
    assert.equal(manifest!.source_dispatch_attempt, 1, 'First round must bind dispatch=1');
    assert.equal(manifest!.source_verification_attempt, 1, 'First round must bind verify=1');

    const taskManifest = await readTaskManifest(speccraftDir, runId, taskId);
    assert.ok(taskManifest!.dispatchAttempts.includes(1), 'dispatchAttempts must include 1');
    assert.ok(taskManifest!.verificationAttempts.includes(1), 'verificationAttempts must include 1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Test D — retry evidence binding (dispatch=2, verify=2)', async () => {
  const { root, speccraftDir, runId } = await makeReadyProject(REVIEW_ENABLED_YAML);
  try {
    await compileTaskGraphForRun(speccraftDir, runId);

    const graph = await readTaskGraph(speccraftDir, runId);
    const taskId = graph.tasks[0].id;

    const firstWorkPlan = makeValueWritePlan(taskId, 'v2');
    registerAdapter(makeFakeExecutor('work', { plan: firstWorkPlan }));
    registerAdapter(makeFakeReviewer('review-major'));

    await mkdir(path.join(root, 'src', 'a'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a', 'value.txt'), 'v1', 'utf8');

    const reviewPlan = await readReviewPlanOrNull(speccraftDir, runId);
    assert.ok(reviewPlan);

    const result1 = await executeTaskGraph({
      speccraftDir, projectRoot: root, runId,
      adapter: makeFakeExecutor('work', { plan: firstWorkPlan }),
      runContext: 'test', executionGuard: 'test',
      reviewPlan: reviewPlan!,
    });

    assert.equal(result1.complete, false, 'First round must fail (major)');
    const reviewAttempt1 = await readReviewManifestOrNull(
      path.join(speccraftDir, 'runs', runId, 'tasks', taskId, 'reviews', 'spec_compliance', 'attempt-001'),
    );
    assert.ok(reviewAttempt1);
    assert.equal(reviewAttempt1!.decision, 'changes_required');
    assert.equal(reviewAttempt1!.source_dispatch_attempt, 1);
    assert.equal(reviewAttempt1!.source_verification_attempt, 1);

    const manifest1 = await readTaskManifest(speccraftDir, runId, taskId);
    assert.equal(manifest1!.status, 'failed');

    registerAdapter(makeFakeReviewer('review-pass'));
    const { reopenTask } = await import('../src/core/tasks/rework.js');
    await reopenTask({ speccraftDir, runId, taskId, cascade: false });

    await writeFile(path.join(root, 'src', 'a', 'value.txt'), 'v2', 'utf8');

    // 同一 Run 内重试（executeTaskGraph 对非 prepared run 跳过 implementStart）
    const secondWorkPlan = makeValueWritePlan(taskId, 'v3');
    const result2 = await executeTaskGraph({
      speccraftDir, projectRoot: root, runId,
      adapter: makeFakeExecutor('work', { plan: secondWorkPlan }),
      runContext: 'test', executionGuard: 'test',
      reviewPlan: reviewPlan!,
    });

    assert.equal(result2.complete, true, 'Second round must pass');
    const reviewAttempt2 = await readReviewManifestOrNull(
      path.join(speccraftDir, 'runs', runId, 'tasks', taskId, 'reviews', 'spec_compliance', 'attempt-002'),
    );
    assert.ok(reviewAttempt2);
    assert.equal(reviewAttempt2!.source_dispatch_attempt, 2, 'Second round must bind dispatch=2');
    assert.equal(reviewAttempt2!.source_verification_attempt, 2, 'Second round must bind verify=2');

    const reviewAttempt1Still = await readReviewManifestOrNull(
      path.join(speccraftDir, 'runs', runId, 'tasks', taskId, 'reviews', 'spec_compliance', 'attempt-001'),
    );
    assert.ok(reviewAttempt1Still, 'First attempt evidence must be preserved');

    const finalManifest = await readTaskManifest(speccraftDir, runId, taskId);
    assert.equal(finalManifest?.status, 'completed', 'Task must be completed after retry review PASS');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Test E — review-disabled legacy regression (verify PASS → completed directly)', async () => {
  const { root, speccraftDir, runId } = await makeReadyProject(REVIEW_DISABLED_YAML);
  try {
    const manualBody = await readExecutionManualBody(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody, source: 'execution-manual' });

    const graphData = await (await import('../src/core/tasks/store.js')).readTaskGraph(speccraftDir, runId);
    const taskId = graphData.tasks[0].id;

    registerAdapter(makeFakeExecutor('work'));

    await mkdir(path.join(root, 'src', 'a'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a', 'value.txt'), 'v1', 'utf8');

    const result = await executeTaskGraph({
      speccraftDir, projectRoot: root, runId,
      adapter: makeFakeExecutor('work'),
      runContext: 'test', executionGuard: 'test',
      reviewPlan: null,
    });

    assert.equal(result.complete, true, 'Review-disabled must complete normally');
    const finalManifest = await readTaskManifest(speccraftDir, runId, taskId);
    assert.equal(finalManifest?.status, 'completed', 'Task must be completed (legacy behavior)');

    let reviewDirExists = true;
    try {
      await access(path.join(speccraftDir, 'runs', runId, 'tasks', taskId, 'reviews'));
    } catch {
      reviewDirExists = false;
    }
    assert.equal(reviewDirExists, false, 'Review evidence dir must not exist when review disabled');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * E2E D/E — Reviewer Mutation（spec v0.8 §6.2/§7）。
 *
 * Reviewer 修改 review worktree（dirty 或 commit）即使输出 PASS，最终也必须：
 *   - executeTaskGraph → review_failed（Task failed）
 *   - attempt manifest decision == error + error_code == reviewer_mutation
 *   - raw evidence（stdout/stderr/raw-output）保留
 *   - review worktree 被清理
 */
async function assertReviewerMutationBlocked(
  mode: 'review-dirty' | 'review-commit',
  reviewFile?: string,
): Promise<void> {
  const { root, speccraftDir, runId } = await makeReadyProject(REVIEW_ENABLED_YAML);
  try {
    await compileTaskGraphForRun(speccraftDir, runId);

    const graph = await readTaskGraph(speccraftDir, runId);
    const taskId = graph.tasks[0].id;

    const workPlan = makeValueWritePlan(taskId, 'v2');
    registerAdapter(makeFakeExecutor('work', { plan: workPlan }));
    registerAdapter(makeFakeReviewer(mode, reviewFile ? { reviewFile } : undefined));

    await mkdir(path.join(root, 'src', 'a'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a', 'value.txt'), 'v1', 'utf8');

    const reviewPlan = await readReviewPlanOrNull(speccraftDir, runId);
    assert.ok(reviewPlan, 'Frozen review plan must exist');

    const result = await executeTaskGraph({
      speccraftDir, projectRoot: root, runId,
      adapter: makeFakeExecutor('work', { plan: workPlan }),
      runContext: 'test', executionGuard: 'test',
      reviewPlan: reviewPlan!,
    });

    // Runtime 必须把 mutation 视为 ERROR（不因 Reviewer 输出 PASS 而放行）
    assert.equal(result.complete, false, 'Task must not complete after reviewer mutation');
    assert.equal(result.reason, 'review_failed', 'Reviewer mutation must fail the review');

    const taskManifest = await readTaskManifest(speccraftDir, runId, taskId);
    assert.equal(taskManifest?.status, 'failed', 'Task must be failed after reviewer mutation');

    const attemptDir = path.join(speccraftDir, 'runs', runId, 'tasks', taskId, 'reviews', 'spec_compliance', 'attempt-001');
    const manifest = await readReviewManifestOrNull(attemptDir);
    assert.ok(manifest, 'Review attempt-001 manifest must exist');
    assert.equal(manifest!.decision, 'error', 'manifest decision must be error（覆盖 reviewer PASS）');
    assert.equal(manifest!.error_code, 'reviewer_mutation', 'manifest must carry structured error_code');
    assert.ok(manifest!.error_message && manifest!.error_message.length > 0, 'manifest must carry error detail');

    // §6.2：raw evidence 必须保留（stdout / stderr / raw-output / prompt / diff）
    const rawOutput = await readFile(path.join(attemptDir, 'raw-output.txt'), 'utf8');
    assert.ok(rawOutput.includes('speccraft-review'), 'raw reviewer output must be preserved');

    // review workspace removed（cleanup 必须执行）
    const wtPath = reviewWorktreePath(root, runId, taskId, 'spec_compliance', 1);
    await assert.rejects(access(wtPath), 'Review worktree must be removed after the attempt');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('E2E D — Reviewer Dirty Mutation → reviewer_mutation ERROR（Reviewer 输出 PASS 也无效）', async () => {
  await assertReviewerMutationBlocked('review-dirty');
});

test('E2E E — Reviewer Commit Mutation → reviewer_mutation ERROR（HEAD drift guard）', async () => {
  await assertReviewerMutationBlocked('review-commit');
});
