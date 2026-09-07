/**
 * Review Validate & Recompile Guard E2E（spec v0.8 §16 / §20 / E2E O）。
 *
 * 真实链路（executeTaskGraph → review PASS → completed）：
 *   §16 baseline：自然 PASS run `speccraft validate` == 0（Review invariants 全部满足）
 *   E2E O：正常 PASS 后手工篡改 reviewer_profile / adapter / source_verification_attempt /
 *          decision，分别断言 validate FAIL 且报出对应 Review invariant 违规；还原后 validate 恢复 0
 *   §20：compile → dispatch+review evidence 后修改 project.yaml review 配置 → compile 拒绝
 *        且 frozen Executor / Review Plan 不被重建；review evidence 分支先于 executor plan
 *        写入触发；workspace evidence 分支同样拒绝 rebuild
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
import { readExecutorPlan } from '../src/core/executors/store.js';
import { cmdValidate } from '../src/cli/commands.js';
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
 * review-enabled 项目。default_adapter = fake-executor：
 * executor plan assignment 与真实 dispatch adapter 一致，
 * 保证自然 PASS run 上 `cmdValidate` 基线为 0（§16 completion invariants 全部满足）。
 */
const REVIEW_VALIDATE_YAML = [
  'version: 1',
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

/** 用户后续把 reviewer 从 fake-reviewer 改成 other-reviewer（§20：不得影响 frozen plan） */
const REVIEW_OTHER_REVIEWER_YAML = [
  'version: 1',
  'execution: { mode: sequential, default_adapter: fake-executor }',
  'review:',
  '  enabled: true',
  '  default_reviewer: other-reviewer',
  '  reviewers:',
  '    other-reviewer: { adapter: other-reviewer }',
  '  gates:',
  '    - id: spec_compliance',
  '      kind: spec_compliance',
  '      reviewer: other-reviewer',
].join('\n');

async function makeReadyProject(projectYaml: string): Promise<{ root: string; speccraftDir: string; runId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-review-validate-'));
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

/** 运行一次自然 review PASS 的 executeTaskGraph（dispatch=1 / verify=1 / review=1） */
async function runReviewPass(root: string, speccraftDir: string, runId: string): Promise<string> {
  const graph = await readTaskGraph(speccraftDir, runId);
  const taskId = graph.tasks[0].id;

  await mkdir(path.join(root, 'src', 'a'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a', 'value.txt'), 'v1', 'utf8');

  const workPlan = makeValueWritePlan(taskId, 'v2');
  registerAdapter(makeFakeExecutor('work', { plan: workPlan }));
  registerAdapter(makeFakeReviewer('review-pass'));

  const reviewPlan = await readReviewPlanOrNull(speccraftDir, runId);
  assert.ok(reviewPlan, 'Frozen review plan must exist');

  const result = await executeTaskGraph({
    speccraftDir, projectRoot: root, runId,
    adapter: makeFakeExecutor('work', { plan: workPlan }),
    runContext: 'test', executionGuard: 'test',
    reviewPlan: reviewPlan!,
  });
  assert.equal(result.complete, true, 'Review PASS must complete the task');
  const tm = await readTaskManifest(speccraftDir, runId, taskId);
  assert.equal(tm?.status, 'completed', 'Task must be completed after review PASS');
  return taskId;
}

/** 运行 cmdValidate 并捕获 console 输出 */
async function runValidateCaptured(root: string): Promise<{ code: number; output: string[] }> {
  const output: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => output.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => output.push('ERR:' + a.map(String).join(' '));
  let code: number;
  try {
    code = await cmdValidate(root);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { code, output };
}

/**
 * E2E O — Validate Tampered Evidence（spec v0.8 §16 / E2E O）。
 *
 * 正常 PASS run（dispatch=1 / verify=1 / review PASS → completed）后：
 *   - baseline `cmdValidate` == 0（Review invariants 全部满足）
 *   - 分别手工篡改 reviewer_profile / adapter / source_verification_attempt / decision
 *     → validate FAIL 且报出对应 Review invariant 违规
 *   - 还原后 validate 恢复 0
 */
test('E2E O — 正常 PASS 后篡改 review evidence → speccraft validate FAIL（§16）', async () => {
  const { root, speccraftDir, runId } = await makeReadyProject(REVIEW_VALIDATE_YAML);
  try {
    await compileTaskGraphForRun(speccraftDir, runId);
    const taskId = await runReviewPass(root, speccraftDir, runId);

    // baseline：自然 PASS run 必须 validate clean（§16 completion invariants）
    const baseline = await runValidateCaptured(root);
    assert.equal(baseline.code, 0, `natural PASS run must validate clean, got: ${baseline.output.join('\n')}`);

    const attemptFile = path.join(
      speccraftDir, 'runs', runId, 'tasks', taskId, 'reviews', 'spec_compliance', 'attempt-001', 'manifest.yaml',
    );
    const original = await readFile(attemptFile, 'utf8');
    assert.ok(JSON.parse(original), 'attempt manifest must be readable JSON');

    const tamperCases: Array<{ label: string; mutate: (m: Record<string, unknown>) => void; expect: RegExp }> = [
      {
        label: 'reviewer_profile',
        mutate: (m) => { m.reviewer_profile = 'tampered-reviewer'; },
        expect: /reviewer_profile（tampered-reviewer）≠ frozen gate\.reviewer（fake-reviewer）/,
      },
      {
        label: 'adapter',
        mutate: (m) => { m.adapter = 'tampered-adapter'; },
        expect: /adapter（tampered-adapter）≠ frozen gate\.adapter（fake-reviewer）/,
      },
      {
        label: 'source_verification_attempt',
        mutate: (m) => { m.source_verification_attempt = 2; },
        expect: /引用不存在的 source verification attempt 2/,
      },
      {
        label: 'decision',
        mutate: (m) => { m.decision = 'changes_required'; },
        expect: /decision is changes_required/,
      },
    ];

    for (const c of tamperCases) {
      // 篡改
      const m = JSON.parse(original) as Record<string, unknown>;
      c.mutate(m);
      await writeFile(attemptFile, JSON.stringify(m, null, 2), 'utf8');

      const res = await runValidateCaptured(root);
      assert.equal(res.code, 1, `tamper ${c.label} must fail validate`);
      assert.ok(
        res.output.some((l) => c.expect.test(l)),
        `tamper ${c.label} must report its invariant violation, got: ${res.output.join('\n')}`,
      );

      // 还原
      await writeFile(attemptFile, original, 'utf8');
      const restored = await runValidateCaptured(root);
      assert.equal(restored.code, 0, `restore ${c.label} must be validate clean again`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * v0.8 §20 — Review Plan Recompile Guard（自然链路）。
 *
 * compile → executeTaskGraph PASS（dispatch/verification/review evidence 全部真实产生）
 * → 修改 project.yaml review 配置（reviewer 换成 other-reviewer）→ 再次 compile：
 * 必须拒绝且 frozen Executor / Review Plan 保持原样（不得 silently rebuild）。
 */
test('v0.8 §20 — evidence 后修改 project.yaml review 配置 → compile 拒绝且 frozen plan 不变', async () => {
  const { root, speccraftDir, runId } = await makeReadyProject(REVIEW_VALIDATE_YAML);
  try {
    await compileTaskGraphForRun(speccraftDir, runId);
    await runReviewPass(root, speccraftDir, runId);

    const planBefore = await readReviewPlanOrNull(speccraftDir, runId);
    assert.ok(planBefore);
    assert.equal(planBefore!.gates[0].reviewer, 'fake-reviewer');
    const executorBefore = await readExecutorPlan(speccraftDir, runId);

    // 用户修改 project.yaml review 配置
    await writeFile(path.join(speccraftDir, 'project.yaml'), REVIEW_OTHER_REVIEWER_YAML, 'utf8');
    const newConfig = await loadProjectConfig(speccraftDir);
    const manualBody = await readExecutionManualBody(speccraftDir);

    await assert.rejects(
      () => compileTaskGraph({ speccraftDir, runId, manualBody, source: 'execution-manual', projectConfig: newConfig }),
      /cannot rebuild/,
      'compile must reject after real execution evidence exists',
    );

    // frozen plan 不被静默重建
    const planAfter = await readReviewPlanOrNull(speccraftDir, runId);
    assert.ok(planAfter);
    assert.deepEqual(
      planAfter!.gates.map((g) => ({ id: g.id, reviewer: g.reviewer, adapter: g.adapter })),
      planBefore!.gates.map((g) => ({ id: g.id, reviewer: g.reviewer, adapter: g.adapter })),
      'Review Plan must stay frozen（reviewer 不被改成 other-reviewer）',
    );
    const executorAfter = await readExecutorPlan(speccraftDir, runId);
    assert.deepEqual(executorAfter.assignments, executorBefore.assignments, 'Executor Plan must stay frozen');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * v0.8 §20 — review evidence guard 必须先于 Executor Plan 写入触发。
 *
 * 只伪造 review evidence（无 dispatch/verification evidence）→ compile 必须报
 * 'cannot rebuild review plan'，且 Executor Plan / Review Plan 磁盘内容完全不变
 * （防止先静默重建 Executor Plan 再抛错的部分写入）。
 */
test('v0.8 §20 — review evidence 存在 → 拒绝且 executor plan 不被部分重写', async () => {
  const { root, speccraftDir, runId } = await makeReadyProject(REVIEW_VALIDATE_YAML);
  try {
    await compileTaskGraphForRun(speccraftDir, runId);
    const graph = await readTaskGraph(speccraftDir, runId);
    const taskId = graph.tasks[0].id;

    const executorPlanFile = path.join(speccraftDir, 'runs', runId, 'executors', 'plan.yaml');
    const reviewPlanFile = path.join(speccraftDir, 'runs', runId, 'reviews', 'plan.yaml');
    const executorBefore = await readFile(executorPlanFile, 'utf8');
    const reviewBefore = await readFile(reviewPlanFile, 'utf8');

    // 伪造 review evidence（仅此一种 evidence）
    const attemptDir = path.join(speccraftDir, 'runs', runId, 'tasks', taskId, 'reviews', 'spec_compliance', 'attempt-001');
    await mkdir(attemptDir, { recursive: true });
    await writeFile(path.join(attemptDir, 'manifest.yaml'), '{}', 'utf8');

    const projectConfig = await loadProjectConfig(speccraftDir);
    const manualBody = await readExecutionManualBody(speccraftDir);
    await assert.rejects(
      () => compileTaskGraph({ speccraftDir, runId, manualBody, source: 'execution-manual', projectConfig }),
      /cannot rebuild review plan after review evidence exists/,
    );

    // guard 在任何 plan 写入之前触发：Executor / Review Plan 均未被重写
    const executorAfter = await readFile(executorPlanFile, 'utf8');
    const reviewAfter = await readFile(reviewPlanFile, 'utf8');
    assert.equal(executorAfter, executorBefore, 'Executor Plan must not be rewritten before the guard throws');
    assert.equal(reviewAfter, reviewBefore, 'Review Plan must not be rewritten');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * v0.8 §20 — workspace evidence 存在 → compile 拒绝 rebuild（hasExecutionEvidence 的 workspace 分支）。
 */
test('v0.8 §20 — workspace evidence 存在 → compile 拒绝 rebuild', async () => {
  const { root, speccraftDir, runId } = await makeReadyProject(REVIEW_VALIDATE_YAML);
  try {
    await compileTaskGraphForRun(speccraftDir, runId);
    const graph = await readTaskGraph(speccraftDir, runId);
    const taskId = graph.tasks[0].id;

    // 伪造 workspace evidence（tasks/<id>/workspaces/attempt-001/）
    const workspaceAttempt = path.join(speccraftDir, 'runs', runId, 'tasks', taskId, 'workspaces', 'attempt-001');
    await mkdir(workspaceAttempt, { recursive: true });
    await writeFile(path.join(workspaceAttempt, 'manifest.yaml'), '{}', 'utf8');

    const projectConfig = await loadProjectConfig(speccraftDir);
    const manualBody = await readExecutionManualBody(speccraftDir);
    await assert.rejects(
      () => compileTaskGraph({ speccraftDir, runId, manualBody, source: 'execution-manual', projectConfig }),
      /cannot rebuild task\/executor plan after execution evidence exists/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
