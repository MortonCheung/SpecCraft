/**
 * Review Status / Next Guidance & Owner Reject Rework E2E（spec v0.8 §19 / §21）。
 *
 * 真实链路（executeTaskGraph → review gates → task completed/failed）：
 *   §19 S1：review changes_required 后 —— `speccraft status` Review 区显示
 *           enabled / gates / failed tasks: N；`speccraft next` 引导
 *           `speccraft reviews show <task>` / `speccraft tasks reopen <task>`；
 *           `speccraft tasks next` 同样给 review rework 引导。
 *   §19 S2：review ERROR（reviewer 进程失败，decision=error 且无 blocker findings）
 *           —— next 必须明确引导 review ERROR，不得退化成普通 unknown failure。
 *   §21 S3：review PASS → completed → owner reject → tasks reopen --cascade →
 *           新施工必须 new Dispatch/Verification/Review Attempts + fresh Reviewer
 *           sessions；旧 Review History 保留但不得自动满足新施工（attempt-002
 *           真实存在且绑定 dispatch=2/verify=2，不是复用 attempt-001）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { initProject } from '../src/core/init.js';
import { loadProject, loadProjectConfig } from '../src/core/project.js';
import { completeStage, approveStage } from '../src/core/advance.js';
import { writeArtifact, createArtifact, artifactFileName } from '../src/core/artifacts/store.js';
import { resolveTemplateContent } from '../src/core/templates/resolver.js';
import { prepareExecution } from '../src/core/execution/prepare.js';
import { registerAdapter } from '../src/core/execution/adapters/registry.js';
import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import { compileTaskGraph, readExecutionManualBody } from '../src/core/tasks/compiler.js';
import { readTaskGraph, readTaskManifest } from '../src/core/tasks/store.js';
import { executeTaskGraph } from '../src/core/tasks/orchestrator.js';
import { readReviewPlanOrNull } from '../src/core/reviews/store.js';
import { readReviewManifestOrNull } from '../src/core/reviews/attempt.js';
import { verifyExecution } from '../src/core/verification/orchestrator.js';
import { readRun, getActiveRun } from '../src/core/execution/store.js';
import { reject } from '../src/core/acceptance/lifecycle.js';
import { reopenTask } from '../src/core/tasks/rework.js';
import { cmdStatus, cmdNext, cmdTasksNext } from '../src/cli/commands.js';
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

/**
 * review-enabled + run-level verification（§21 需要 owner reject 前置：
 * verification completed → owner-acceptance waiting_owner_approval）。
 * default_adapter = fake-executor 保证 executor plan assignment 与实际 dispatch 一致。
 */
const REVIEW_VERIFY_YAML = [
  'version: 1',
  'verification: { commands: ["true"], timeout_seconds: 30 }',
  'execution: { mode: sequential, default_adapter: fake-executor }',
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

async function makeReadyProject(projectYaml: string): Promise<{ root: string; speccraftDir: string; runId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-review-rework-'));
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

function makeValueWritePlan(taskId: string, content: string): Record<string, unknown> {
  return { [taskId]: { write: { 'src/a/value.txt': content } } };
}

function makeFakeExecutor(mode: string, opts?: { plan?: Record<string, unknown> }): CliExecutionAdapter {
  return {
    id: 'fake-executor',
    kind: 'cli',
    capabilities: {
      invoke: true, resume: true, structuredOutput: true,
      finalMessageFile: true, sessionId: true, modelSelection: false,
    },
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

/** 从 review attempt dir 派生确定性 provider session（attempt-NNN → review-session-N） */
function reviewSessionFromRunDir(runDir: string): string {
  const m = runDir.match(/attempt-(\d+)/);
  return m ? `review-session-${Number(m[1])}` : `review-session-${Date.now()}`;
}

function makeFakeReviewer(mode: string): CliExecutionAdapter {
  return {
    id: 'fake-reviewer',
    kind: 'cli',
    capabilities: {
      invoke: true, resume: false, structuredOutput: false,
      finalMessageFile: false, sessionId: true, modelSelection: false,
    },
    prepare: manualAdapter.prepare,
    probe: async () => ({ id: 'fake-reviewer', installed: true }),
    buildInvocation: async (input) => ({
      command: 'node',
      args: [fakeAgentPath],
      cwd: input.projectRoot,
      stdin: input.prompt,
      env: { FAKE_AGENT_MODE: mode, FAKE_AGENT_SESSION: reviewSessionFromRunDir(input.runDir) },
      timeoutMs: 10000,
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
        adapter: 'fake-reviewer',
        status: input.exitCode === 0 ? 'succeeded' : 'failed',
        exitCode: input.exitCode ?? undefined, timedOut: input.timedOut,
        startedAt: input.startedAt, finishedAt: input.finishedAt, durationMs: input.durationMs,
        ...(sessionId ? { sessionId } : {}), events: [],
      };
    },
  };
}

async function compileTaskGraphForRun(speccraftDir: string, runId: string): Promise<void> {
  registerAdapter({ ...manualAdapter, id: 'fake-reviewer' } as any);
  const manualBody = await readExecutionManualBody(speccraftDir);
  const projectConfig = await loadProjectConfig(speccraftDir);
  await compileTaskGraph({ speccraftDir, runId, manualBody, source: 'execution-manual', projectConfig });
}

async function readAttemptManifest(
  speccraftDir: string,
  runId: string,
  taskId: string,
  attempt: number,
): Promise<NonNullable<Awaited<ReturnType<typeof readReviewManifestOrNull>>>> {
  const p = path.join(
    speccraftDir, 'runs', runId, 'tasks', taskId, 'reviews', 'spec_compliance', `attempt-${String(attempt).padStart(3, '0')}`,
  );
  const m = await readReviewManifestOrNull(p);
  assert.ok(m, `review attempt-${attempt} must exist at ${p}`);
  return m!;
}

/** 运行 executeTaskGraph；workPlan 决定 executor 写入；reviewerMode 决定 review decision */
async function runExecute(
  root: string,
  speccraftDir: string,
  runId: string,
  opts: { content: string; reviewerMode: string },
): Promise<{ taskId: string; result: Awaited<ReturnType<typeof executeTaskGraph>> }> {
  const graph = await readTaskGraph(speccraftDir, runId);
  const taskId = graph.tasks[0].id;

  await mkdir(path.join(root, 'src', 'a'), { recursive: true });
  const workPlan = makeValueWritePlan(taskId, opts.content);
  registerAdapter(makeFakeExecutor('work', { plan: workPlan }));
  registerAdapter(makeFakeReviewer(opts.reviewerMode));

  const reviewPlan = await readReviewPlanOrNull(speccraftDir, runId);
  assert.ok(reviewPlan, 'Frozen review plan must exist');

  const result = await executeTaskGraph({
    speccraftDir, projectRoot: root, runId,
    adapter: makeFakeExecutor('work', { plan: workPlan }),
    runContext: 'test', executionGuard: 'test',
    reviewPlan: reviewPlan!,
  });
  return { taskId, result };
}

/** 捕获 cmdXxx 的 console 输出 */
async function captureCommand(fn: () => Promise<unknown>): Promise<string[]> {
  const output: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => output.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => output.push('ERR:' + a.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return output;
}

// ---------------------------------------------------------------------------
// §19 S1：changes_required 后 status / next / tasks next 的 review 引导
// ---------------------------------------------------------------------------

test('§19 S1 — review changes_required：status 显示 Review failed tasks，next 引导 rework', async () => {
  const { root, speccraftDir, runId } = await makeReadyProject(REVIEW_VERIFY_YAML);
  try {
    await compileTaskGraphForRun(speccraftDir, runId);
    const { taskId, result } = await runExecute(root, speccraftDir, runId, {
      content: 'v2',
      reviewerMode: 'review-major',
    });
    assert.equal(result.complete, false, 'major finding must fail review');
    assert.equal(result.reason, 'review_failed');
    const tm = await readTaskManifest(speccraftDir, runId, taskId);
    assert.equal(tm?.status, 'failed');
    const a1 = await readAttemptManifest(speccraftDir, runId, taskId, 1);
    assert.equal(a1.decision, 'changes_required');

    // status：Review 区显示 enabled / gates / failed tasks: 1
    const statusOut = await captureCommand(() => cmdStatus(root));
    assert.ok(statusOut.some((l) => /^Review:$/.test(l)), 'status must show Review section');
    assert.ok(statusOut.some((l) => /gates: spec_compliance/.test(l)), 'status must list gates');
    assert.ok(statusOut.some((l) => /failed tasks: 1/.test(l)), 'status must count review-failed tasks');

    // next：引导 reviews show / tasks reopen
    const nextOut = await captureCommand(() => cmdNext(root));
    assert.ok(nextOut.some((l) => /requires review rework/.test(l)), `next must guide rework: ${nextOut.join('|')}`);
    assert.ok(nextOut.some((l) => /speccraft reviews show/.test(l)), 'next must point to reviews show');
    assert.ok(nextOut.some((l) => /speccraft tasks reopen/.test(l)), 'next must point to tasks reopen');

    // tasks next：同样 review 引导（不落成普通 unknown failure）
    const tasksNextOut = await captureCommand(() => cmdTasksNext(root));
    assert.ok(
      tasksNextOut.some((l) => /review rework required/.test(l)),
      `tasks next must guide review rework: ${tasksNextOut.join('|')}`,
    );
    assert.ok(tasksNextOut.some((l) => /speccraft reviews show/.test(l)), 'tasks next must point to reviews show');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §19 S2：review ERROR（无 blocker findings）不得退化成普通 unknown failure
// ---------------------------------------------------------------------------

test('§19 S2 — review ERROR：next 明确引导 review ERROR（不落成 unknown failure）', async () => {
  const { root, speccraftDir, runId } = await makeReadyProject(REVIEW_VERIFY_YAML);
  try {
    await compileTaskGraphForRun(speccraftDir, runId);
    // fake reviewer 'fail'：reviewer 进程失败（exit 1）→ decision=error（无 findings）
    const { taskId, result } = await runExecute(root, speccraftDir, runId, {
      content: 'v2',
      reviewerMode: 'fail',
    });
    assert.equal(result.complete, false, 'reviewer crash must fail review');
    assert.equal(result.reason, 'review_failed');
    const tm = await readTaskManifest(speccraftDir, runId, taskId);
    assert.equal(tm?.status, 'failed');
    const a1 = await readAttemptManifest(speccraftDir, runId, taskId, 1);
    assert.equal(a1.decision, 'error', 'reviewer process failure must produce decision=error');

    // next：review ERROR 引导（即使无 blocker findings）
    const nextOut = await captureCommand(() => cmdNext(root));
    assert.ok(
      nextOut.some((l) => /review ERROR/.test(l)),
      `next must surface review ERROR: ${nextOut.join('|')}`,
    );
    assert.ok(nextOut.some((l) => /speccraft reviews show/.test(l)), 'next must point to reviews show');
    assert.ok(nextOut.some((l) => /speccraft tasks reopen/.test(l)), 'next must point to tasks reopen');
    // 不得输出普通 unknown failure 兜底文本
    assert.ok(!nextOut.some((l) => /有 failed Task/.test(l)), 'next must not degrade to generic failure');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §21 S3：Owner reject → tasks reopen → 新施工 = 新 attempts + fresh sessions
// ---------------------------------------------------------------------------

test('§21 S3 — Owner reject 后新施工：new dispatch/verify/review attempts + fresh sessions', async () => {
  const { root, speccraftDir, runId } = await makeReadyProject(REVIEW_VERIFY_YAML);
  try {
    await compileTaskGraphForRun(speccraftDir, runId);

    // 第一轮施工：review PASS → task completed
    const first = await runExecute(root, speccraftDir, runId, { content: 'v2', reviewerMode: 'review-pass' });
    const taskId = first.taskId;
    assert.equal(first.result.complete, true, 'first round must complete');
    let tm = await readTaskManifest(speccraftDir, runId, taskId);
    assert.equal(tm?.status, 'completed');
    const a1 = await readAttemptManifest(speccraftDir, runId, taskId, 1);
    assert.equal(a1.decision, 'pass');
    assert.equal(a1.source_dispatch_attempt, 1);
    assert.equal(a1.source_verification_attempt, 1);
    assert.equal(a1.session_id, 'review-session-1');

    // run-level verification PASS → waiting owner acceptance
    const vr = await verifyExecution({ projectRoot: root });
    assert.equal(vr.passed, true, 'run verification must pass');
    const { workflow, state } = await loadProject(root);
    assert.equal(state.stages['owner-acceptance']?.status, 'waiting_owner_approval');

    // Owner reject（review 之后的 acceptance；review ≠ acceptance）
    const run = await getActiveRun(speccraftDir, runId);
    assert.ok(run);
    await reject(speccraftDir, root, workflow, state, run!, { feedback: 'Owner 不接受当前实现。' });
    const runAfterReject = await readRun(speccraftDir, runId);
    assert.equal(runAfterReject.status, 'acceptance_rejected', 'reject must reopen implementation in same run');
    assert.equal(state.stages['implementation']?.status, 'in_progress');

    // tasks reopen --cascade → 任务回到 ready，准备新施工
    await reopenTask({ speccraftDir, runId, taskId, cascade: true });
    tm = await readTaskManifest(speccraftDir, runId, taskId);
    assert.equal(tm?.status, 'ready');

    // 第二轮施工：new dispatch/verification/review attempts + fresh reviewer session
    const second = await runExecute(root, speccraftDir, runId, { content: 'v3', reviewerMode: 'review-pass' });
    assert.equal(second.result.complete, true, 'second round must complete after owner-reject rework');
    const tm2 = await readTaskManifest(speccraftDir, runId, taskId);
    assert.equal(tm2?.status, 'completed');

    const a2 = await readAttemptManifest(speccraftDir, runId, taskId, 2);
    assert.equal(a2.decision, 'pass');
    assert.equal(a2.source_dispatch_attempt, 2, 'rework must bind new dispatch attempt');
    assert.equal(a2.source_verification_attempt, 2, 'rework must bind new verification attempt');
    assert.notEqual(a2.session_id, a1.session_id, 'rework review must use a fresh reviewer session');
    assert.equal(a2.session_id, 'review-session-2');

    // 旧 Review History 保留
    const a1Still = await readAttemptManifest(speccraftDir, runId, taskId, 1);
    assert.equal(a1Still.decision, 'pass');
    assert.equal(a1Still.source_dispatch_attempt, 1, 'old attempt must keep original bindings');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
