import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initProject } from '../src/core/init.js';
import { loadProject } from '../src/core/project.js';
import { completeStage, approveStage } from '../src/core/advance.js';
import { writeArtifact, readArtifact, createArtifact, artifactFileName } from '../src/core/artifacts/store.js';
import { resolveTemplateContent } from '../src/core/templates/resolver.js';
import { prepareExecution } from '../src/core/execution/prepare.js';
import { readRun } from '../src/core/execution/store.js';
import { registerAdapter } from '../src/core/execution/adapters/registry.js';
import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import { verifyExecution } from '../src/core/verification/orchestrator.js';
import { compileTaskGraph } from '../src/core/tasks/compiler.js';
import { executeTaskGraph } from '../src/core/tasks/orchestrator.js';
import { readTaskManifest, readAllTaskManifests } from '../src/core/tasks/store.js';
import { executeParallelTaskGraph } from '../src/core/parallel/orchestrator.js';
import { readWorkspace, listWaves } from '../src/core/workspaces/store.js';
import { readCanonicalHead, isCanonicalClean } from '../src/core/workspaces/integration.js';
import { runGit } from '../src/core/workspaces/git.js';
import { listDispatchAttemptsForTask, readDispatchAttempt } from '../src/core/dispatch/store.js';
import type { CliExecutionAdapter, NormalizedDispatchResult } from '../src/core/execution/adapters/types.js';
import type { Workflow, State } from '../src/core/types.js';

const fakeAgentPath = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// fake work adapter：在 isolated worktree（cwd）里按 plan 真实施工
// ---------------------------------------------------------------------------

interface WorkSpec {
  write?: Record<string, string>;
  outOfScope?: string[];
  sleepMs?: number;
  gitCommit?: boolean;
  drift?: boolean;
  fail?: boolean;
}

function makeWorkAdapter(
  getPlan: () => Record<string, WorkSpec>,
  canonical?: string,
  getSession: () => string = () => `sess-${Math.random().toString(16).slice(2, 10)}`,
): CliExecutionAdapter {
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
        FAKE_AGENT_PLAN: JSON.stringify(getPlan()),
        FAKE_AGENT_SESSION: getSession(),
        ...(canonical ? { FAKE_AGENT_CANONICAL: canonical } : {}),
      },
      timeoutMs: 60000,
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
        adapter: 'fake',
        status: input.timedOut ? 'timed_out' : input.spawnError ? 'spawn_error' : input.exitCode === 0 ? 'succeeded' : 'failed',
        exitCode: input.exitCode ?? undefined,
        timedOut: input.timedOut,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        durationMs: input.durationMs,
        ...(sessionId ? { sessionId } : {}),
        ...(finalMessage ? { finalMessage } : {}),
        events: [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 最小可执行项目（真实 Git repo + 完整 Workflow → prepared Run）
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

/** 搭建真实 Git repo + 完整 Workflow + task graph + prepared Run */
async function makeParallelProject(
  block: string,
  adapter: CliExecutionAdapter,
): Promise<{ root: string; speccraftDir: string; runId: string; baseCommit: string; outer: string }> {
  // repo 放在 mkdtemp 外层目录的子目录里：每个测试独享 <outer>/.speccraft-worktrees，
  // 避免跨测试文件并行时共享/误删同一个 worktrees 根目录。
  const outer = await mkdtemp(path.join(os.tmpdir(), 'speccraft-par-'));
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

  await writeFile(
    path.join(speccraftDir, 'project.yaml'),
    'name: par-e2e\nexecution:\n  default_adapter: fake\nverification:\n  timeout_seconds: 60\n  commands:\n    - "true"\n',
    'utf8',
  );

  registerAdapter(adapter);
  const { runId } = await prepareExecution({ projectRoot: root, adapterId: 'fake' });
  const { readExecutionManualBody } = await import('../src/core/tasks/compiler.js');
  await compileTaskGraph({ speccraftDir, runId, manualBody: block, source: 'execution-manual' });
  return { root, speccraftDir, runId, baseCommit, outer };
}

/** 删除整个测试外层目录（含 repo 与 <outer>/.speccraft-worktrees） */
function projectCleanup(root: string): Promise<void> {
  return rm(path.dirname(root), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// §24 真并行 E2E
// ---------------------------------------------------------------------------

test('M6.9 §24 E2E：A → (B‖C) → D 真并行（B/C 时间重叠）→ 确定性集成 → Run Verification PASS', async () => {
  const plan: Record<string, WorkSpec> = {
    a: { write: { 'src/a/base.txt': 'A' } },
    b: { write: { 'src/backend/handler.ts': 'B' }, sleepMs: 800 },
    c: { write: { 'src/frontend/view.ts': 'C' }, sleepMs: 800 },
    d: { write: { 'src/d/final.txt': 'D' } },
  };
  const adapter = makeWorkAdapter(() => plan);
  const p = await makeParallelProject(DIAMOND_BLOCK, adapter);
  try {
    const result = await executeParallelTaskGraph({
      speccraftDir: p.speccraftDir,
      projectRoot: p.root,
      runId: p.runId,
      adapter,
      runContext: '# ctx',
      executionGuard: '# guard',
      maxParallel: 2,
    });

    // 全图完成：3 个 wave（A；B+C；D）
    assert.equal(result.complete, true);
    assert.equal(result.waves, 3);
    assert.deepEqual(
      result.waveSummaries,
      [
        { wave: 1, tasks: ['a'] },
        { wave: 2, tasks: ['b', 'c'] },
        { wave: 3, tasks: ['d'] },
      ],
    );
    for (const id of ['a', 'b', 'c', 'd']) {
      assert.equal((await readTaskManifest(p.speccraftDir, p.runId, id))?.status, 'completed', `task ${id}`);
    }
    assert.equal((await readRun(p.speccraftDir, p.runId)).status, 'awaiting_verification');

    // ---- 真并行硬断言：B started before C finished AND C started before B finished ----
    const bAttempt = (await listDispatchAttemptsForTask(p.speccraftDir, p.runId, 'b')).at(-1)!;
    const cAttempt = (await listDispatchAttemptsForTask(p.speccraftDir, p.runId, 'c')).at(-1)!;
    const bm = await readDispatchAttempt(p.speccraftDir, p.runId, bAttempt);
    const cm = await readDispatchAttempt(p.speccraftDir, p.runId, cAttempt);
    assert.ok(bm?.started_at && bm.finished_at, 'B dispatch 时间证据缺失');
    assert.ok(cm?.started_at && cm.finished_at, 'C dispatch 时间证据缺失');
    const bStart = Date.parse(bm.started_at), bFinish = Date.parse(bm.finished_at!);
    const cStart = Date.parse(cm.started_at), cFinish = Date.parse(cm.finished_at!);
    assert.ok(bStart < cFinish, `B 必须在 C 结束前开始（B start ${bStart} >= C finish ${cFinish}）`);
    assert.ok(cStart < bFinish, `C 必须在 B 结束前开始（C start ${cStart} >= B finish ${bFinish}）`);

    // ---- 隔离硬断言：B/C 不共享 working directory / branch，但共享 Run ID ----
    const wsB = await readWorkspace(p.speccraftDir, p.runId, 'b', 1);
    const wsC = await readWorkspace(p.speccraftDir, p.runId, 'c', 1);
    assert.ok(wsB && wsC);
    assert.notEqual(wsB.workspaceRoot, wsC.workspaceRoot);
    assert.notEqual(wsB.branch, wsC.branch);
    assert.equal(wsB.runId, p.runId);
    assert.equal(wsC.runId, p.runId);
    assert.equal(wsB.status, 'cleaned');
    assert.equal(wsC.status, 'cleaned');

    // ---- 集成硬断言：Task 变更确定性进入 canonical ----
    assert.equal(await readFile(path.join(p.root, 'src', 'backend', 'handler.ts'), 'utf8'), 'B');
    assert.equal(await readFile(path.join(p.root, 'src', 'frontend', 'view.ts'), 'utf8'), 'C');
    assert.equal(await readFile(path.join(p.root, 'src', 'a', 'base.txt'), 'utf8'), 'A');
    assert.equal(await readFile(path.join(p.root, 'src', 'd', 'final.txt'), 'utf8'), 'D');
    assert.notEqual(await readCanonicalHead(p.root), p.baseCommit); // integration commits 已进入
    assert.equal(await isCanonicalClean(p.root), true);
    assert.ok(result.integrationCommits.length >= 4);

    // 集成后 worktree 已清理（§12.8）
    assert.equal(await exists(wsB.workspaceRoot), false);
    assert.equal(await exists(wsC.workspaceRoot), false);

    // ---- Run Verification PASS（独立于 Task Verification）----
    const v = await verifyExecution({ projectRoot: p.root });
    assert.equal(v.passed, true);

    // ---- 16 Workflow Stages 不变 ----
    const { state: finalState } = await loadProject(p.root);
    assert.equal(Object.keys(finalState.stages).length, 16);
  } finally {
    await projectCleanup(p.root);
  }
});

// ---------------------------------------------------------------------------
// §30 Sequential Regression：默认 execute 仍走 v0.5 sequential route
// ---------------------------------------------------------------------------

test('M6.9 §30：默认（无 --parallel）仍为 v0.5 sequential route —— 不建 worktree / wave', async () => {
  // jsonl fake agent（v0.5 语义：dispatch 只输出，不写文件；Task Verification 由 Runtime 跑）
  const adapter: CliExecutionAdapter = {
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
      env: { FAKE_AGENT_MODE: 'jsonl' },
      timeoutMs: 10000,
    }),
    normalize: async (input): Promise<NormalizedDispatchResult> => ({
      adapter: 'fake',
      status: input.timedOut ? 'timed_out' : input.spawnError ? 'spawn_error' : input.exitCode === 0 ? 'succeeded' : 'failed',
      exitCode: input.exitCode ?? undefined,
      timedOut: input.timedOut,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs: input.durationMs,
      events: [],
    }),
  };
  const p = await makeParallelProject(LINEAR_BLOCK, adapter);
  try {
    const result = await executeTaskGraph({
      speccraftDir: p.speccraftDir,
      projectRoot: p.root,
      runId: p.runId,
      adapter,
      runContext: '# ctx',
      executionGuard: '# guard',
    });
    assert.equal(result.complete, true);

    // sequential route：不产生 wave / workspace evidence
    assert.equal((await listWaves(p.speccraftDir, p.runId)).length, 0);
    assert.equal(await exists(path.join(p.speccraftDir, 'runs', p.runId, 'tasks', 'a', 'workspaces')), false);
    assert.equal(await exists(path.join(p.speccraftDir, 'runs', p.runId, 'tasks', 'b', 'workspaces')), false);
    // worktrees 目录不存在
    assert.equal(await exists(path.join(path.dirname(p.root), '.speccraft-worktrees')), false);

    const manifests = await readAllTaskManifests(p.speccraftDir, p.runId);
    assert.equal(manifests.get('a')?.status, 'completed');
    assert.equal(manifests.get('b')?.status, 'completed');
    assert.equal((await readRun(p.speccraftDir, p.runId)).status, 'awaiting_verification');
  } finally {
    await projectCleanup(p.root);
  }
});
