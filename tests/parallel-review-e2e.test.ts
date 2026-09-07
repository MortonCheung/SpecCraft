/**
 * Parallel Review E2E（v0.8 §14 / E2E I-J）。
 *
 * 通过 executeParallelTaskGraph() 真实链路验证 parallel Review Attempt 证据：
 *   P1a: review PASS → task 集成并 completed；attempt manifest 必须写
 *         workspace_attempt == 对应 workspace attempt（1），decision == pass，
 *         session_id 由 adapter.normalize 提取（fresh session）。
 *   P1b: Reviewer mutation（review-dirty）→ attempt decision=error +
 *         error_code=reviewer_mutation（结构化，不埋进字符串）；
 *         workspace failed / failure_phase == review / task failed。
 *   P2a: 权威 Diamond A → (B + C) → D，review-enabled 全 PASS：
 *         waves == 3（[a]、[b,c]、[d]）；B/C 真实 wall-clock 并行
 *         （dispatch started/finished 双向重叠）；B/C Review 真实发生
 *         （decision=pass、workspace_attempt=1、session 存在且互异、
 *         source dispatch/verification attempt 真实绑定）；
 *         Review invocation 时 workspace 尚无 taskCommit/integrationCommit
 *         （证明 Review 在 Runtime Commit 之前）；集成后 B/C 产物进入
 *         canonical、D 只出现在第三个 wave、canonical clean。
 *   P2b: Diamond review FAIL（B=review-major，C=review-pass）：
 *         B changes_required → workspace failed(review) / task failed /
 *         taskCommit 与 integrationCommit 缺失 / canonical 不含 B 变更；
 *         D 不得执行。
 *
 * 所有断言均读取真实落盘 Evidence（review / workspace / dispatch / wave
 * manifest），不用 stub、不手工写 fake manifest，不绕过 orchestrator。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
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
import { readDispatchAttempt } from '../src/core/dispatch/store.js';
import { listTaskVerificationAttempts } from '../src/core/tasks/verification/lifecycle.js';
import { readReviewManifestOrNull } from '../src/core/reviews/attempt.js';
import { readReviewPlanOrNull } from '../src/core/reviews/store.js';
import { readWorkspace, readLatestWorkspace, listWaves, readWaveManifest } from '../src/core/workspaces/store.js';
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

/** 从 review attempt dir（.../tasks/<task>/reviews/<gate>/attempt-NNN）解析 task/gate/attempt */
function parseReviewRunDir(runDir: string): { taskId: string; gateId: string; attempt: number } {
  const m = runDir.match(/tasks\/([^/]+)\/reviews\/([^/]+)\/attempt-(\d+)/);
  return {
    taskId: m ? m[1] : 'unknown',
    gateId: m ? m[2] : 'unknown',
    attempt: m ? Number(m[3]) : 0,
  };
}

/** Reviewer 观察回调：buildInvocation 时观察现有 workspace Evidence（v0.8：Review 在 taskCommit 之前） */
export type ReviewInvocationObserve = (taskId: string, runDir: string) => void;

/**
 * Fake Reviewer Adapter（id = fake-reviewer；review-pass / review-dirty 等模式）。
 *
 * session id 绑定 task + gate + attempt（如 review-b-spec_compliance-1），
 * 保证同 wave 不同 Task（B/C）的 Reviewer session 全局互异（E2E L 语义）。
 * mode 可为常量字符串或按 taskId 解析的函数（Diamond FAIL 需要 per-task 决策）。
 * observe 回调由调用方闭包持有真实 speccraftDir/runId，在 buildInvocation 时
 * 读取 workspace Evidence（未改生产代码）。
 */
function makeReviewerAdapter(
  mode: string | ((taskId: string) => string),
  observe?: ReviewInvocationObserve,
): CliExecutionAdapter {
  return {
    id: 'fake-reviewer',
    kind: 'cli',
    capabilities: { invoke: true, resume: false, structuredOutput: false, finalMessageFile: false, sessionId: true, modelSelection: false },
    prepare: manualAdapter.prepare,
    probe: async () => ({ id: 'fake-reviewer', installed: true }),
    buildInvocation: async (input) => {
      const { taskId, gateId, attempt } = parseReviewRunDir(input.runDir);
      const resolved = typeof mode === 'function' ? mode(taskId) : mode;
      if (observe) observe(taskId, input.runDir);
      return {
        command: 'node',
        args: [fakeAgentPath],
        cwd: input.projectRoot,
        stdin: input.prompt,
        env: {
          FAKE_AGENT_MODE: resolved,
          FAKE_AGENT_SESSION: `review-${taskId}-${gateId}-${attempt}`,
        },
        timeoutMs: 10000,
      };
    },
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

/** 权威 Diamond：A → (B + C) → D（E2E I-J 自述 scope / 依赖） */
const DIAMOND_BLOCK = taskBlock([
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
    scope: { paths: [src/backend/**] }
    ${VERIF_OK}`,
  `  - id: c
    title: C
    summary: Do C
    depends_on: [a]
    scope: { paths: [src/frontend/**] }
    ${VERIF_OK}`,
  `  - id: d
    title: D
    summary: Do D
    depends_on: [b, c]
    scope: { paths: [src/d/**] }
    ${VERIF_OK}`,
]);

/** Diamond 施工计划：A/B/C/D 各写一个 scope 内文件；B/C 加 600–800ms 睡眠制造真实时间重叠 */
const DIAMOND_PLAN: Record<string, WorkSpec> = {
  a: { write: { 'src/a/base.txt': 'AAA' } },
  b: { write: { 'src/backend/handler.ts': 'BBB' }, sleepMs: 700 },
  c: { write: { 'src/frontend/view.ts': 'CCC' }, sleepMs: 700 },
  d: { write: { 'src/d/final.txt': 'DDD' } },
};

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

// ---------------------------------------------------------------------------
// 权威 E2E I：Diamond A → (B + C) → D，review-enabled 全 PASS
// ---------------------------------------------------------------------------

test('P2a — review-enabled Diamond PASS：waves==3、B/C 真并行、B/C Review 必经真实 Attempt 且在 Runtime Commit 之前、D 仅第三 wave', async () => {
  const workAdapter = makeWorkAdapter(DIAMOND_PLAN);
  const p = await makeReviewParallelProject(DIAMOND_BLOCK);
  // Review invocation 现场观察：闭包持有真实 speccraftDir/runId，读取 workspace Evidence
  const observed = new Map<string, { status?: string; taskCommit?: string; integrationCommit?: string }>();
  const reviewer = makeReviewerAdapter('review-pass', async (taskId, runDir) => {
    void runDir;
    const ws = await readLatestWorkspace(p.speccraftDir, p.runId, taskId);
    observed.set(taskId, {
      status: ws?.status,
      ...(ws?.taskCommit ? { taskCommit: ws.taskCommit } : {}),
      ...(ws?.integrationCommit ? { integrationCommit: ws.integrationCommit } : {}),
    });
  });
  try {
    registerAdapter(workAdapter);
    registerAdapter(reviewer);

    const reviewPlan = await readReviewPlanOrNull(p.speccraftDir, p.runId);
    assert.ok(reviewPlan, 'Frozen review plan must exist');
    assert.ok(reviewPlan!.enabled, 'Review must be enabled');

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

    // 1) complete + waves == 3
    assert.equal(result.complete, true, `complete（reason=${result.reason ?? 'n/a'}）`);
    assert.equal(result.waves, 3, 'Diamond must run 3 waves');

    // 2) wave 组成：[a] → [b, c] → [d]，D 只出现在第三个 wave
    const waveOf = new Map<number, string[]>();
    for (const w of result.waveSummaries) waveOf.set(w.wave, [...w.tasks].sort());
    assert.deepEqual(waveOf.get(1), ['a'], 'wave 1 must be [a]');
    assert.deepEqual(waveOf.get(2), ['b', 'c'], 'wave 2 must be [b, c]');
    assert.deepEqual(waveOf.get(3), ['d'], 'wave 3 must be [d]');
    // 磁盘 Evidence（真实 wave manifest）一致
    const diskWaves = await listWaves(p.speccraftDir, p.runId);
    assert.deepEqual(diskWaves, [1, 2, 3], 'wave manifests on disk must be 1/2/3');
    for (const w of diskWaves) {
      const wm = await readWaveManifest(p.speccraftDir, p.runId, w);
      assert.ok(wm, `wave ${w} manifest must exist`);
      assert.deepEqual([...wm!.tasks].sort(), (waveOf.get(w) ?? []).sort());
    }

    // 3) B/C 全部 completed + workspace 存在 taskCommit / integrationCommit
    for (const id of ['a', 'b', 'c', 'd']) {
      assert.equal((await readTaskManifest(p.speccraftDir, p.runId, id))?.status, 'completed', `task ${id}`);
    }
    for (const id of ['b', 'c']) {
      const ws = await readWorkspace(p.speccraftDir, p.runId, id, 1);
      assert.ok(ws, `workspace for ${id} must exist`);
      assert.ok(ws!.taskCommit, `${id} must have task commit`);
      assert.ok(ws!.integrationCommit, `${id} must have integration commit`);
      assert.ok(['integrated', 'cleaned'].includes(ws!.status!), `${id} workspace must be integrated/cleaned（got ${ws!.status}）`);
    }

    // 4) B/C 真实 wall-clock 并行：B.start < C.finish && C.start < B.finish
    const dispatchOf = new Map<string, NonNullable<Awaited<ReturnType<typeof readDispatchAttempt>>>>();
    for (const id of ['b', 'c']) {
      const tm = await readTaskManifest(p.speccraftDir, p.runId, id);
      assert.ok(tm && tm.dispatchAttempts.length === 1, `${id} must have exactly one dispatch attempt`);
      const d = await readDispatchAttempt(p.speccraftDir, p.runId, tm!.dispatchAttempts[0]);
      assert.ok(d, `dispatch manifest for ${id} must exist`);
      assert.ok(d!.finished_at, `${id} dispatch must have finished_at`);
      dispatchOf.set(id, d!);
    }
    const bStart = Date.parse(dispatchOf.get('b')!.started_at);
    const bFinish = Date.parse(dispatchOf.get('b')!.finished_at!);
    const cStart = Date.parse(dispatchOf.get('c')!.started_at);
    const cFinish = Date.parse(dispatchOf.get('c')!.finished_at!);
    assert.ok(bStart < cFinish, `B must start before C finishes（b=${dispatchOf.get('b')!.started_at}，c=${dispatchOf.get('c')!.finished_at}）`);
    assert.ok(cStart < bFinish, `C must start before B finishes（c=${dispatchOf.get('c')!.started_at}，b=${dispatchOf.get('b')!.finished_at}）`);

    // 5) B/C Review 真实发生：decision=pass、workspace_attempt=1、session 存在且互异、
    //    source dispatch/verification attempt == B/C 各自真实 attempt
    const reviewSession = new Map<string, string>();
    for (const id of ['b', 'c']) {
      const attemptDir = path.join(p.speccraftDir, 'runs', p.runId, 'tasks', id, 'reviews', 'spec_compliance', 'attempt-001');
      const m = await readReviewManifestOrNull(attemptDir);
      assert.ok(m, `review attempt manifest for ${id} must exist`);
      assert.equal(m!.decision, 'pass', `${id} review must pass`);
      assert.equal(m!.workspace_attempt, 1, `${id} workspace_attempt must be 1`);
      assert.ok(m!.session_id, `${id} must carry reviewer session_id`);
      const tm = await readTaskManifest(p.speccraftDir, p.runId, id);
      assert.equal(m!.source_dispatch_attempt, tm!.dispatchAttempts[0], `${id} review must bind the real dispatch attempt`);
      const vAttempts = await listTaskVerificationAttempts(p.speccraftDir, p.runId, id);
      assert.equal(m!.source_verification_attempt, vAttempts[0], `${id} review must bind the real verification attempt`);
      reviewSession.set(id, m!.session_id!);
    }
    assert.notEqual(reviewSession.get('b'), reviewSession.get('c'), 'B/C reviewer sessions must be independent');
    assert.equal(reviewSession.get('b'), 'review-b-spec_compliance-1');
    assert.equal(reviewSession.get('c'), 'review-c-spec_compliance-1');

    // 6) Review 在 Runtime Commit 之前：reviewer invocation 时 workspace 尚无 taskCommit/integrationCommit
    for (const id of ['b', 'c']) {
      const obs = observed.get(id);
      assert.ok(obs, `must observe review invocation for ${id}`);
      assert.equal(obs!.taskCommit, undefined, `${id} review must run before taskCommit`);
      assert.equal(obs!.integrationCommit, undefined, `${id} review must run before integrationCommit`);
    }

    // 7) 集成后 canonical 含 B/C 产物、canonical clean
    assert.equal(await readFile(path.join(p.root, 'src/backend/handler.ts'), 'utf8'), 'BBB');
    assert.equal(await readFile(path.join(p.root, 'src/frontend/view.ts'), 'utf8'), 'CCC');
    assert.equal(await readFile(path.join(p.root, 'src/d/final.txt'), 'utf8'), 'DDD');
    assert.equal(await isCanonicalClean(p.root), true);
  } finally {
    await projectCleanup(p.root);
  }
});

// ---------------------------------------------------------------------------
// 权威 E2E J：Diamond review FAIL —— B=major → failed(review)，D 不得执行
// ---------------------------------------------------------------------------

test('P2b — Diamond review FAIL（B=major，C=PASS）：B changes_required → failed(review)，taskCommit/integrationCommit 缺失，canonical 不含 B，D 不得执行', async () => {
  const workAdapter = makeWorkAdapter(DIAMOND_PLAN);
  const p = await makeReviewParallelProject(DIAMOND_BLOCK);
  const reviewer = makeReviewerAdapter((taskId) => (taskId === 'b' ? 'review-major' : 'review-pass'));
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
      maxParallel: 2,
      reviewPlan: reviewPlan!,
    });

    // B 触发 review 失败 → task failed；parallel 主循环统一以 failed_task 收口（保留 failed(review) evidence）
    assert.equal(result.complete, false);
    assert.equal(result.reason, 'failed_task');

    // B：verification PASS → review changes_required → workspace failed(review) → task failed
    const bReviewDir = path.join(p.speccraftDir, 'runs', p.runId, 'tasks', 'b', 'reviews', 'spec_compliance', 'attempt-001');
    const bReview = await readReviewManifestOrNull(bReviewDir);
    assert.ok(bReview, 'B review attempt must exist');
    assert.equal(bReview!.decision, 'changes_required');
    const bVerify = await listTaskVerificationAttempts(p.speccraftDir, p.runId, 'b');
    assert.ok(bVerify.length >= 1, 'B must have reached verification PASS before review');
    assert.equal(bReview!.source_verification_attempt, bVerify[0], 'B review must bind its real verification attempt');

    const wsB = await readWorkspace(p.speccraftDir, p.runId, 'b', 1);
    assert.ok(wsB, 'B workspace must exist');
    assert.equal(wsB!.status, 'failed');
    assert.equal(wsB!.failurePhase, 'review', 'B must fail in review phase');
    assert.equal(wsB!.taskCommit, undefined, 'B must have no task commit');
    assert.equal(wsB!.integrationCommit, undefined, 'B must have no integration commit');
    assert.equal((await readTaskManifest(p.speccraftDir, p.runId, 'b'))?.status, 'failed');

    // canonical 不含 B 变更（src/backend/handler.ts 不得存在）
    await assert.rejects(readFile(path.join(p.root, 'src/backend/handler.ts'), 'utf8'), /ENOENT/, 'canonical must not contain B change');

    // D 不得执行：不在 executed、无 workspace evidence
    assert.ok(!result.executed.includes('d'), 'D must not be executed');
    assert.equal(await readWorkspace(p.speccraftDir, p.runId, 'd', 1), null, 'D must have no workspace evidence');
    const dTask = await readTaskManifest(p.speccraftDir, p.runId, 'd');
    assert.ok(dTask, 'D task manifest must exist (created at graph compile)');
    assert.ok(['ready', 'blocked'].includes(dTask!.status), `D must remain ready/blocked（got ${dTask!.status}）`);
  } finally {
    await projectCleanup(p.root);
  }
});
