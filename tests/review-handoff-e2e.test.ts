/**
 * Review → Owner Accept → Handoff 权威 E2E（spec v0.8 §17 / §17.1 / §18，E2E P）。
 *
 * 真实链路：prepare → compile graph（frozen review plan）→ executeTaskGraph
 * （dispatch → verify → spec PASS → quality PASS → completed）→ run verify →
 * owner accept → handoff。
 *
 * 断言：
 *   §18    Aggregate Execution Report 只引用 review evidence
 *          （runs/<run>/tasks/<task>/reviews/），不含 AI 二次总结。
 *   §17    review-history.md 存在，内容包含真实 Review Attempt（decision /
 *          source dispatch/verification attempt / reviewer profile / adapter /
 *          session），且按 Task Graph order → gate order → attempt ascending 稳定排序。
 *   §17.1  manifest.yaml files 列出 review-history.md，sources.review_attempts
 *          列出每个 attempt 的真实 manifest 路径；HANDOFF.md 含 Review history 摘要。
 *
 * 不 stub、不 mock：Reviewer 走真实 fake-agent CLI + adapter.normalize 会话，
 * Handoff 走真实 handoff() lifecycle（guard：verify completed + accepted + run accepted）。
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
import { writeArtifact, createArtifact, artifactFileName, readArtifact } from '../src/core/artifacts/store.js';
import { resolveTemplateContent } from '../src/core/templates/resolver.js';
import { prepareExecution } from '../src/core/execution/prepare.js';
import { registerAdapter } from '../src/core/execution/adapters/registry.js';
import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import { compileTaskGraph, readExecutionManualBody } from '../src/core/tasks/compiler.js';
import { readTaskGraph } from '../src/core/tasks/store.js';
import { executeTaskGraph } from '../src/core/tasks/orchestrator.js';
import { readReviewPlanOrNull } from '../src/core/reviews/store.js';
import { readReviewManifestOrNull } from '../src/core/reviews/attempt.js';
import { verifyExecution } from '../src/core/verification/orchestrator.js';
import { readRun } from '../src/core/execution/store.js';
import { accept } from '../src/core/acceptance/lifecycle.js';
import { handoff } from '../src/core/handoff/lifecycle.js';
import { writeState } from '../src/core/state/store.js';
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

/** review-enabled：spec + quality 两个 gate（验证 handoff 稳定顺序），run-level verify + acceptance */
const TWO_GATE_REVIEW_YAML = [
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
  '    - id: code_quality',
  '      kind: code_quality',
  '      reviewer: fake-reviewer',
].join('\n');

async function makeReadyProject(projectYaml: string): Promise<{ root: string; speccraftDir: string; runId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-review-handoff-'));
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

  const manualPath = path.join(speccraftDir, 'artifacts', 'execution-manual.md');
  const manual = await readArtifact(manualPath);
  manual.body = TASK_BLOCK;
  await writeArtifact(manualPath, manual);

  await writeState(speccraftDir, state);
  await writeFile(path.join(speccraftDir, 'project.yaml'), projectYaml, 'utf8');

  await mkdir(path.join(root, 'src', 'a'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a', 'value.txt'), '', 'utf8');
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', 'scaffold']);

  const { runId } = await prepareExecution({ projectRoot: root, adapter: 'fake-executor', runContext: 'test' });
  return { root, speccraftDir, runId };
}

function makeFakeExecutor(taskId: string, content: string): CliExecutionAdapter {
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
        FAKE_AGENT_MODE: 'work',
        FAKE_AGENT_SESSION: `exec-${Math.random().toString(16).slice(2, 6)}`,
        FAKE_AGENT_PLAN: JSON.stringify({ [taskId]: { write: { 'src/a/value.txt': content } } }),
      },
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
        adapter: 'fake-executor',
        status: input.timedOut ? 'timed_out' : input.spawnError ? 'spawn_error' : input.exitCode === 0 ? 'succeeded' : 'failed',
        exitCode: input.exitCode ?? undefined, timedOut: input.timedOut,
        startedAt: input.startedAt, finishedAt: input.finishedAt, durationMs: input.durationMs,
        ...(sessionId ? { sessionId } : {}), events: [],
      };
    },
  };
}

/** 从 review attempt dir 派生确定性 provider session（attempt-NNN → review-session-N） */
function reviewSessionFromRunDir(runDir: string): string {
  const m = runDir.match(/attempt-(\d+)/);
  return m ? `review-session-${Number(m[1])}` : `review-session-${Date.now()}`;
}

function makeFakeReviewer(): CliExecutionAdapter {
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
      env: { FAKE_AGENT_MODE: 'review-pass', FAKE_AGENT_SESSION: reviewSessionFromRunDir(input.runDir) },
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

test('E2E P — review history 进入 Handoff（§17/§17.1/§18）：真实 review attempts → review-history.md + manifest + aggregate report 引用', async () => {
  const { root, speccraftDir, runId } = await makeReadyProject(TWO_GATE_REVIEW_YAML);
  try {
    // frozen review plan（compile graph 阶段固化）
    registerAdapter({ ...manualAdapter, id: 'fake-reviewer' } as any);
    const manualBody = await readExecutionManualBody(speccraftDir);
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({ speccraftDir, runId, manualBody, source: 'execution-manual', projectConfig });
    const reviewPlan = await readReviewPlanOrNull(speccraftDir, runId);
    assert.ok(reviewPlan, 'Frozen review plan must exist');
    assert.equal(reviewPlan.gates.length, 2);

    // 真实执行：dispatch → verify PASS → spec PASS → quality PASS → completed
    const graph = await readTaskGraph(speccraftDir, runId);
    const taskId = graph.tasks[0].id;
    const executor = makeFakeExecutor(taskId, 'v2');
    registerAdapter(executor);
    registerAdapter(makeFakeReviewer());
    const result = await executeTaskGraph({
      speccraftDir, projectRoot: root, runId,
      adapter: executor,
      runContext: 'test', executionGuard: 'test',
      reviewPlan: reviewPlan!,
    });
    assert.equal(result.complete, true, `both gates PASS must complete the task: ${JSON.stringify(result)}`);

    // 真实 review attempt evidence 已落盘（两个 gate 各 1 个 PASS attempt）
    for (const gateId of ['spec_compliance', 'code_quality']) {
      const p = path.join(speccraftDir, 'runs', runId, 'tasks', taskId, 'reviews', gateId, 'attempt-001');
      const m = await readReviewManifestOrNull(p);
      assert.ok(m, `review manifest must exist for ${gateId}`);
      assert.equal(m!.decision, 'pass');
      assert.equal(m!.source_dispatch_attempt, 1);
      assert.equal(m!.source_verification_attempt, 1);
      assert.equal(m!.session_id, 'review-session-1');
    }

    // §18：Aggregate Execution Report 引用 review evidence（不二次总结）
    const { readdir } = await import('node:fs/promises');
    const runReports = (await readdir(path.join(speccraftDir, 'runs', runId)))
      .filter((f) => /^agent-report-\d+\.md$/.test(f)).sort();
    assert.ok(runReports.length >= 1, 'aggregate execution report must exist');
    const report = await readFile(path.join(speccraftDir, 'runs', runId, runReports[0]), 'utf8');
    assert.match(report, new RegExp(`runs/${runId}/tasks/${taskId}/reviews/`), 'report must reference review evidence');
    assert.match(report, /review \[spec_compliance PASS，code_quality PASS\]/, 'report must reference gate decisions from evidence');

    // run-level verify + owner accept
    const vr = await verifyExecution({ projectRoot: root });
    assert.equal(vr.passed, true, 'run verification must pass');
    const { workflow, state } = await loadProject(root);
    assert.equal(state.stages['owner-acceptance']?.status, 'waiting_owner_approval');
    const run = await readRun(speccraftDir, runId);
    await accept(speccraftDir, root, workflow, state, run, { by: 'owner', feedback: 'ok' });

    // 真实 handoff lifecycle（guard：verify completed + owner-acceptance completed + run accepted）
    const { handoffId } = await handoff(speccraftDir, root, 'e2e-p', workflow, state, run);
    const dir = path.join(speccraftDir, 'handoffs', handoffId);

    // §17：review-history.md 存在且包含真实 attempts（gate 顺序 + attempt 递增）
    const written = await readFile(path.join(dir, 'review-history.md'), 'utf8');
    assert.match(written, /# Review History/);
    assert.match(written, /Run: /);
    const specIdx = written.indexOf(`### ${taskId} / spec_compliance`);
    const qualityIdx = written.indexOf(`### ${taskId} / code_quality`);
    assert.ok(specIdx >= 0, 'review-history must list spec_compliance gate');
    assert.ok(qualityIdx > specIdx, 'gate order must be stable (spec before quality)');
    for (const gateId of ['spec_compliance', 'code_quality']) {
      assert.ok(written.indexOf(`### ${taskId} / ${gateId}`) >= 0);
    }
    // attempt 字段真实来自 manifest
    assert.match(written, /#### Attempt 1/);
    assert.match(written, /- kind: spec_compliance/);
    assert.match(written, /- decision: pass/);
    assert.match(written, /- source dispatch attempt: 1/);
    assert.match(written, /- source verification attempt: 1/);
    assert.match(written, /- reviewer profile: fake-reviewer/);
    assert.match(written, /- adapter: fake-reviewer/);
    assert.match(written, /- review session: review-session-1/);
    assert.match(written, /- blocking findings: 0/);

    // §17.1：manifest.yaml files 列出 review-history.md；sources.review_attempts 列出真实路径
    const manifestYaml = await readFile(path.join(dir, 'manifest.yaml'), 'utf8');
    assert.match(manifestYaml, /review-history\.md/);
    assert.match(
      manifestYaml,
      new RegExp(`tasks/${taskId}/reviews/spec_compliance/attempt-001/manifest.yaml`),
      'manifest sources must list real review attempt evidence',
    );
    assert.match(
      manifestYaml,
      new RegExp(`tasks/${taskId}/reviews/code_quality/attempt-001/manifest.yaml`),
    );

    // §17.1：HANDOFF.md 含 Review history 摘要（不复制 finding 正文）
    const handoffDoc = await readFile(path.join(dir, 'HANDOFF.md'), 'utf8');
    assert.match(handoffDoc, /## Review history 摘要/);
    assert.match(handoffDoc, /decision: pass/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
