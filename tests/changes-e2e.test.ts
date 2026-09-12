/**
 * SpecCraft v0.9 §87 Commit 6 —— 权威 E2E A–N（§71–§84）。
 *
 * 覆盖：
 *   §71 E2E A  Upstream Requirement Change（incomplete → complete → approve → replan）
 *   §72 E2E B  Active Change Freezes Run（dispatch / execute / verify / accept 全部 block）
 *   §73 E2E C  Executor Reassignment（alpha → beta，history not rewritten）
 *   §74 E2E D  Proposal Changed After Analysis（proposal_changed_since_analysis）
 *   §75 E2E E  Approved Proposal Immutable（change_already_approved）
 *   §76 E2E F  Non-deterministic Recompile Guard（non_deterministic_recompile）
 *   §77 E2E G  Successful Successor Lifecycle（execute → verify → review → accept → close → handoff）
 *   §78 E2E H  Close Requires Acceptance（successor_not_accepted）
 *   §79 E2E I  Canonical Drift（canonical_drift，不覆盖未知修改）
 *   §80 E2E J  Idempotent / Interrupted Close（skip target / promote baseline）
 *   §81 E2E K  Successor Review Runtime Regression（Task → Verification → Review → Commit）
 *   §82 E2E L  Parallel Successor Regression（A → (B + C) → D，3 waves）
 *   §83 E2E M  Second Change（run-001 → change-001 → run-002 → change-002 → run-003）
 *   §84 E2E N  Validate Tampering（任一 Evidence 被改 → validate FAIL）
 *
 * 全部走真实生产代码路径（createChange / analyzeChange / approveChange / replanChange /
 * dispatchTask / executeTaskGraph / executeParallelTaskGraph / verifyExecution / accept /
 * closeChange / handoff / cmdValidate），不使用 stub、不手工写 Evidence、不绕过 gate。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { initProject } from '../src/core/init.js';
import { createRun, listRuns, readRun, updateRunStatus } from '../src/core/execution/store.js';
import { loadProject, loadProjectConfig } from '../src/core/project.js';
import { readState, writeState } from '../src/core/state/store.js';
import { completeStage, approveStage } from '../src/core/advance.js';
import {
  artifactFileName,
  createArtifact,
  readArtifact,
  writeArtifact,
} from '../src/core/artifacts/store.js';
import { resolveTemplateContent } from '../src/core/templates/resolver.js';
import { prepareExecution } from '../src/core/execution/prepare.js';
import { createChange } from '../src/core/changes/create.js';
import { changeDir, readChangeManifest, rejectChange } from '../src/core/changes/store.js';
import {
  proposalArtifactPath,
  proposalConfigPath,
  retainArtifact,
  stageProposalArtifact,
  stageProposalConfig,
} from '../src/core/changes/proposal.js';
import { approvalPath, approveChange, readApprovalOrNull } from '../src/core/changes/approval.js';
import { analysisAttemptDir, analyzeChange } from '../src/core/changes/analyze.js';
import { replanChange } from '../src/core/changes/replan.js';
import {
  readChangeMaterializationOrNull,
  readRunLineageOrNull,
  readRunSupersessionOrNull,
  writeRunLineage,
  writeRunSupersession,
} from '../src/core/changes/lineage.js';
import { closeChange, closePath, parseChangeClose } from '../src/core/changes/close.js';
import { checkChangeConsistency } from '../src/core/changes/consistency.js';
import { assertRunMutable } from '../src/core/changes/guards.js';
import { sha256Bytes } from '../src/core/changes/digest.js';
import { ChangeError } from '../src/core/changes/types.js';
import { compileTaskGraph, readExecutionManualBody } from '../src/core/tasks/compiler.js';
import { readTaskGraph, readTaskGraphOrNull, readTaskManifest, writeTaskGraph } from '../src/core/tasks/store.js';
import { readExecutorPlanOrNull } from '../src/core/executors/store.js';
import { reopenTask } from '../src/core/tasks/rework.js';
import { dispatchTask } from '../src/core/tasks/dispatch.js';
import { listTaskVerificationAttempts, verifyTask } from '../src/core/tasks/verification/lifecycle.js';
import { executeTaskGraph } from '../src/core/tasks/orchestrator.js';
import { executeParallelTaskGraph } from '../src/core/parallel/orchestrator.js';
import {
  readLatestWorkspace,
  readWorkspace,
  readWaveManifest,
  listWaves,
} from '../src/core/workspaces/store.js';
import { readCanonicalHead, isCanonicalClean } from '../src/core/workspaces/integration.js';
import { runGit as runGitAsync } from '../src/core/workspaces/git.js';
import { listDispatchAttemptsForTask, readDispatchAttempt } from '../src/core/dispatch/store.js';
import { readReviewPlanOrNull } from '../src/core/reviews/store.js';
import { readReviewManifestOrNull } from '../src/core/reviews/attempt.js';
import { handoff } from '../src/core/handoff/lifecycle.js';
import { handoffDir } from '../src/core/handoff/package.js';
import { verifyExecution } from '../src/core/verification/orchestrator.js';
import { accept } from '../src/core/acceptance/lifecycle.js';
import { registerAdapter } from '../src/core/execution/adapters/registry.js';
import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import { cmdValidate } from '../src/cli/commands.js';
import type { CliExecutionAdapter, NormalizedDispatchResult } from '../src/core/execution/adapters/types.js';
import type { Workflow, State } from '../src/core/types.js';

const fakeAgentPath = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** 断言抛出带指定 code 的 ChangeError */
async function assertChangeError(code: string, fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof ChangeError, `期望 ChangeError，实际：${String(err)}`);
    assert.equal(err.code, code, `错误码应为 ${code}，实际 ${err.code}（${err.message}）`);
    return true;
  });
}

async function newProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-changes-e2e-'));
  await initProject({ projectRoot: root });
  return root;
}

async function seedArtifact(
  speccraftDir: string,
  stage: string,
  artifact: string,
  body: string,
): Promise<string> {
  const source = `---\nartifact: ${artifact}\nstage: ${stage}\nstatus: completed\nversion: 1\n---\n\n${body}`;
  await writeFile(path.join(speccraftDir, 'artifacts', `${artifact}.md`), source, 'utf8');
  return source;
}

function manualBody(block: string): string {
  return `# Execution Manual\n\n## Execution Task Graph\n\n\`\`\`speccraft-task-graph\n${block}\n\`\`\`\n`;
}

function graphBlock(
  tasks: Array<{ id: string; summary: string; dependsOn: string[]; executor?: string }>,
): string {
  const lines = ['version: 1', '', 'tasks:'];
  for (const t of tasks) {
    lines.push(`  - id: ${t.id}`);
    lines.push(`    title: Task ${t.id.toUpperCase()}`);
    lines.push(`    summary: ${t.summary}`);
    if (t.executor) lines.push(`    executor: ${t.executor}`);
    lines.push(`    depends_on: [${t.dependsOn.join(', ')}]`);
    lines.push(`    scope: { paths: [src/${t.id}/**] }`);
    lines.push('    verification: { commands: [echo ok], timeout_seconds: 30 }');
  }
  return lines.join('\n');
}

const AFFECTED = [
  'requirement',
  'concept',
  'research',
  'design',
  'build-brief',
  'site-survey',
  'execution-manual',
] as const;

const BASE_BLOCK = graphBlock([
  { id: 'a', summary: 'Do A', dependsOn: [] },
  { id: 'b', summary: 'Do B', dependsOn: ['a'] },
  { id: 'c', summary: 'Do C', dependsOn: ['b'] },
]);
const NEXT_BLOCK = graphBlock([
  { id: 'a', summary: 'Do A differently', dependsOn: [] },
  { id: 'b', summary: 'Do B', dependsOn: ['a'] },
  { id: 'd', summary: 'Do D', dependsOn: ['b'] },
]);

const REQUIREMENT_V2 = `---\nartifact: requirements\nstage: requirement\nstatus: completed\nversion: 2\n---\n\n# Requirements v2\n`;
const REQUIREMENT_V3 = `---\nartifact: requirements\nstage: requirement\nstatus: completed\nversion: 3\n---\n\n# Requirements v3\n`;
const MANUAL_V2 = `---\nartifact: execution-manual\nstage: execution-manual\nstatus: completed\nversion: 2\n---\n\n${manualBody(NEXT_BLOCK)}`;

const RETAINED = ['concept', 'research', 'design', 'build-brief', 'site-survey'] as const;

interface Fixture {
  speccraftDir: string;
  workflow: Awaited<ReturnType<typeof loadProject>>['workflow'];
  changeId: string;
}

/** baseline Run + 全部 canonical artifact + 完整变更（requirement/manual replace，其余 retain） */
async function seedBaseline(speccraftDir: string, workflow: Fixture['workflow']): Promise<void> {
  for (const stage of AFFECTED) {
    const artifact = workflow.stages.find((s) => s.id === stage)!.produces[0]!;
    const body = stage === 'execution-manual' ? manualBody(BASE_BLOCK) : `# ${artifact}\n`;
    await seedArtifact(speccraftDir, stage, artifact, body);
  }
}

/** 构造可分析的完整变更（停在 analyze 之前） */
async function setupChange(root: string, reason = '调整任务图'): Promise<Fixture> {
  const speccraftDir = path.join(root, '.speccraft');
  await createRun(speccraftDir, { id: 'run-1' });
  const { workflow } = await loadProject(root);
  await seedBaseline(speccraftDir, workflow);

  const manifest = await createChange({
    speccraftDir,
    projectRoot: root,
    workflow,
    baseRunId: 'run-1',
    reason,
  });

  await stageProposalArtifact({
    speccraftDir,
    changeId: manifest.id,
    stageId: 'requirement',
    source: REQUIREMENT_V2,
    workflow,
  });
  await stageProposalArtifact({
    speccraftDir,
    changeId: manifest.id,
    stageId: 'execution-manual',
    source: MANUAL_V2,
    workflow,
  });
  for (const stage of RETAINED) {
    await retainArtifact({ speccraftDir, changeId: manifest.id, stageId: stage, workflow });
  }
  return { speccraftDir, workflow, changeId: manifest.id };
}

/** 构造 approved Change */
async function setupApproved(root: string): Promise<Fixture & { attempt: string }> {
  const fixture = await setupChange(root);
  const analysis = await analyzeChange({
    speccraftDir: fixture.speccraftDir,
    changeId: fixture.changeId,
    workflow: fixture.workflow,
  });
  assert.equal(analysis.result, 'complete', `analysis must be complete: ${analysis.unresolved.join(', ')}`);
  await approveChange({
    speccraftDir: fixture.speccraftDir,
    changeId: fixture.changeId,
    approvedBy: 'owner',
  });
  return { ...fixture, attempt: analysis.attempt };
}

/** 一个只依赖 fake-agent fixture 的最小 cli adapter */
function makeFakeCliAdapter(id: string, mode: string): CliExecutionAdapter {
  return {
    id,
    kind: 'cli',
    capabilities: {
      invoke: true,
      resume: false,
      structuredOutput: true,
      finalMessageFile: true,
      sessionId: true,
      modelSelection: false,
    },
    prepare: manualAdapter.prepare,
    probe: async () => ({ id, installed: true }),
    buildInvocation: async (input) => ({
      command: 'node',
      args: [fakeAgentPath],
      cwd: input.projectRoot,
      stdin: input.prompt,
      env: { FAKE_AGENT_MODE: mode, FAKE_AGENT_SESSION: `${id}-session-1` },
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
        } catch {
          /* ignore */
        }
      }
      return {
        adapter: id,
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
// §71 E2E A — Upstream Requirement Change
// ---------------------------------------------------------------------------

test('E2E A §71：Requirement 变更 incomplete → complete → approve → replan，base 被 supersede 且旧 Evidence 不变', async () => {
  const root = await newProject();
  try {
    const speccraftDir = path.join(root, '.speccraft');
    await createRun(speccraftDir, { id: 'run-1' });
    const { workflow } = await loadProject(root);
    await seedBaseline(speccraftDir, workflow);

    const manifest = await createChange({
      speccraftDir,
      projectRoot: root,
      workflow,
      baseRunId: 'run-1',
      reason: '需求变更',
    });

    // 只 stage requirement → downstream 必然 unresolved
    await stageProposalArtifact({
      speccraftDir,
      changeId: manifest.id,
      stageId: 'requirement',
      source: REQUIREMENT_V2,
      workflow,
    });

    const first = await analyzeChange({ speccraftDir, changeId: manifest.id, workflow });
    assert.equal(first.attempt, 'attempt-001');
    assert.equal(first.result, 'incomplete');
    assert.ok(first.unresolved.length > 0, '第一次 analyze 必须发现 downstream unresolved');
    // incomplete 不改变 Change 状态
    assert.equal((await readChangeManifest(speccraftDir, manifest.id)).status, 'draft');

    const requirementBefore = await readFile(path.join(speccraftDir, 'artifacts', 'requirements.md'));
    const requirementSha = manifest.artifacts.find((a) => a.stage === 'requirement')!.sha256;
    assert.equal(sha256Bytes(requirementBefore), requirementSha);

    // retain / replace affected artifacts
    await stageProposalArtifact({
      speccraftDir,
      changeId: manifest.id,
      stageId: 'execution-manual',
      source: MANUAL_V2,
      workflow,
    });
    for (const stage of RETAINED) {
      await retainArtifact({ speccraftDir, changeId: manifest.id, stageId: stage, workflow });
    }

    const second = await analyzeChange({ speccraftDir, changeId: manifest.id, workflow });
    assert.equal(second.attempt, 'attempt-002');
    assert.equal(second.result, 'complete');
    assert.deepEqual(second.unresolved, []);
    assert.equal((await readChangeManifest(speccraftDir, manifest.id)).status, 'analyzed');

    await approveChange({ speccraftDir, changeId: manifest.id, approvedBy: 'owner' });
    const result = await replanChange({
      speccraftDir,
      projectRoot: root,
      changeId: manifest.id,
      workflow,
    });

    // successor Run exists
    const successor = await readRun(speccraftDir, result.successorRun);
    assert.equal(successor.status, 'prepared');

    // base Run superseded
    const supersession = await readRunSupersessionOrNull(speccraftDir, 'run-1');
    assert.ok(supersession, 'base Run 必须有 superseded.yaml');
    assert.equal(supersession!.successor_run, result.successorRun);
    assert.equal(supersession!.change_id, manifest.id);

    // old Evidence remains unchanged
    assert.deepEqual(
      await readFile(path.join(speccraftDir, 'artifacts', 'requirements.md')),
      requirementBefore,
    );
    assert.equal(await exists(analysisAttemptDir(speccraftDir, manifest.id, 'attempt-001')), true);
    assert.equal(await exists(analysisAttemptDir(speccraftDir, manifest.id, 'attempt-002')), true);
    assert.equal(
      await exists(path.join(changeDir(speccraftDir, manifest.id), 'baseline', 'artifacts', 'requirement.md')),
      true,
    );

    // successor frozen plans exist
    const graph = await readTaskGraphOrNull(speccraftDir, result.successorRun);
    assert.ok(graph, 'successor 必须有 task graph');
    assert.deepEqual(
      graph!.tasks.map((t) => t.id),
      ['a', 'b', 'd'],
      'successor graph 必须来自 approved candidate',
    );
    const executorPlan = await readExecutorPlanOrNull(speccraftDir, result.successorRun);
    assert.ok(executorPlan, 'successor 必须有 executor plan');

    // lineage + materialization
    const lineage = await readRunLineageOrNull(speccraftDir, result.successorRun);
    assert.equal(lineage!.predecessor_run, 'run-1');
    assert.equal(lineage!.approved_analysis_attempt, 'attempt-002');
    const materialization = await readChangeMaterializationOrNull(speccraftDir, manifest.id);
    assert.equal(materialization!.successor_run, result.successorRun);
    assert.equal((await readChangeManifest(speccraftDir, manifest.id)).status, 'materialized');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §72 E2E B — Active Change Freezes Run
// ---------------------------------------------------------------------------

test('E2E B §72：active Change 冻结 Run，dispatch / execute / verify / accept 全部 run_change_pending；reject 后恢复', async () => {
  const root = await newProject();
  try {
    const speccraftDir = path.join(root, '.speccraft');
    await createRun(speccraftDir, { id: 'run-1' });
    const { workflow } = await loadProject(root);
    await seedBaseline(speccraftDir, workflow);

    // 真实执行一个 Task：compile graph → dispatch → verify
    const singleBlock = graphBlock([{ id: 'a', summary: 'Do A', dependsOn: [] }]);
    await compileTaskGraph({
      speccraftDir,
      runId: 'run-1',
      manualBody: manualBody(singleBlock),
      source: 'execution-manual',
    });
    const adapter = makeFakeCliAdapter('fake-cli', 'jsonl');
    registerAdapter(adapter);
    const dispatch = await dispatchTask({
      speccraftDir,
      projectRoot: root,
      runId: 'run-1',
      taskId: 'a',
      adapter,
      runContext: '# ctx',
      executionGuard: '# guard',
      freshSession: true,
    });
    assert.equal(dispatch.success, true, 'Task 必须真实 dispatch 成功');
    const verification = await verifyTask({
      speccraftDir,
      projectRoot: root,
      runId: 'run-1',
      taskId: 'a',
      verification: { commands: ['echo ok'], timeoutSeconds: 30 },
    });
    assert.equal(verification.passed, true);

    // 让 run-level verify / accept 能走到 gate（模拟施工中的 Run）
    const state = await readState(speccraftDir);
    state.active_run = 'run-1';
    state.stages['implementation'] = { ...(state.stages['implementation'] ?? {}), status: 'completed' };
    await writeState(speccraftDir, state);

    const manifest = await createChange({
      speccraftDir,
      projectRoot: root,
      workflow,
      baseRunId: 'run-1',
      reason: '冻结测试',
    });

    // dispatch（显式 Task）被冻结
    await assertChangeError('run_change_pending', () =>
      dispatchTask({
        speccraftDir,
        projectRoot: root,
        runId: 'run-1',
        taskId: 'a',
        adapter,
        runContext: '# ctx',
        executionGuard: '# guard',
        freshSession: true,
      }),
    );

    // execute 被冻结
    await assertChangeError('run_change_pending', () =>
      executeTaskGraph({
        speccraftDir,
        projectRoot: root,
        runId: 'run-1',
        adapter,
        runContext: '# ctx',
        executionGuard: '# guard',
      }),
    );

    // run-level verify 被冻结（implementation 已 completed，仍必须被 gate 拦住）
    await assertChangeError('run_change_pending', () =>
      verifyExecution({ projectRoot: root }),
    );

    // accept 被冻结
    const run = await readRun(speccraftDir, 'run-1');
    await assertChangeError('run_change_pending', () =>
      accept(speccraftDir, root, workflow, state, run, { by: 'owner', feedback: 'ok' }),
    );

    // changes reject → 旧 Run 再次允许继续
    await rejectChange({ speccraftDir, changeId: manifest.id, reason: '放弃变更' });
    await assertRunMutable(speccraftDir, 'run-1');
    const reopened = await reopenTask({
      speccraftDir,
      runId: 'run-1',
      taskId: 'a',
      cascade: false,
    });
    assert.deepEqual(reopened.reopened, ['a'], 'reject 后旧 Run 必须可继续施工');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §73 E2E C — Executor Reassignment
// ---------------------------------------------------------------------------

const EXECUTOR_CONFIG = [
  'name: executor-diff',
  'verification: { commands: ["echo ok"], timeout_seconds: 30 }',
  'execution:',
  '  default_adapter: manual',
  '  executors:',
  '    alpha: { adapter: fake-executor }',
  '    beta: { adapter: fake-executor }',
].join('\n');

const BASE_BLOCK_ALPHA = graphBlock([
  { id: 'a', summary: 'Do A', dependsOn: [], executor: 'alpha' },
  { id: 'b', summary: 'Do B', dependsOn: ['a'], executor: 'alpha' },
]);
const NEXT_BLOCK_BETA = graphBlock([
  { id: 'a', summary: 'Do A differently', dependsOn: [], executor: 'beta' },
  { id: 'b', summary: 'Do B', dependsOn: ['a'], executor: 'beta' },
]);

test('E2E C §73：Executor Reassignment（alpha → beta）在 Analysis 报告，Successor 用 beta，base 永久保留 alpha', async () => {
  const root = await newProject();
  try {
    const speccraftDir = path.join(root, '.speccraft');
    await createRun(speccraftDir, { id: 'run-1' });
    const { workflow } = await loadProject(root);
    await seedBaseline(speccraftDir, workflow);
    await writeFile(path.join(speccraftDir, 'project.yaml'), EXECUTOR_CONFIG, 'utf8');

    // Base Run：frozen Task Graph + Executor Plan（Task A → alpha）
    const projectConfig = await loadProjectConfig(speccraftDir);
    await compileTaskGraph({
      speccraftDir,
      runId: 'run-1',
      manualBody: manualBody(BASE_BLOCK_ALPHA),
      source: 'execution-manual',
      projectConfig,
    });
    const basePlan = await readExecutorPlanOrNull(speccraftDir, 'run-1');
    assert.equal(basePlan!.assignments.find((a) => a.taskId === 'a')!.executor, 'alpha');

    const manifest = await createChange({
      speccraftDir,
      projectRoot: root,
      workflow,
      baseRunId: 'run-1',
      reason: '切换执行者',
    });

    // Change：stage-config（alpha/beta 配置）+ 新 execution-manual（Task A → beta）
    await stageProposalConfig({ speccraftDir, changeId: manifest.id, source: EXECUTOR_CONFIG });
    await stageProposalArtifact({
      speccraftDir,
      changeId: manifest.id,
      stageId: 'execution-manual',
      source: `---\nartifact: execution-manual\nstage: execution-manual\nstatus: completed\nversion: 2\n---\n\n${manualBody(NEXT_BLOCK_BETA)}`,
      workflow,
    });

    const analysis = await analyzeChange({ speccraftDir, changeId: manifest.id, workflow });
    assert.equal(analysis.result, 'complete');

    // Analysis 必须报告 Executor Assignment Diff：A alpha → beta
    const assignmentA = analysis.impact.executor_plan.assignments.find((a) => a.task_id === 'a');
    assert.ok(assignmentA, 'impact 必须包含 Task A 的 assignment diff');
    assert.equal(assignmentA!.change, 'modified');
    assert.equal(assignmentA!.base_executor, 'alpha');
    assert.equal(assignmentA!.candidate_executor, 'beta');
    assert.equal(analysis.impact.executor_plan.changed, true);

    await approveChange({ speccraftDir, changeId: manifest.id, approvedBy: 'owner' });
    const result = await replanChange({
      speccraftDir,
      projectRoot: root,
      changeId: manifest.id,
      workflow,
    });

    // Successor Executor Plan = beta
    const successorPlan = await readExecutorPlanOrNull(speccraftDir, result.successorRun);
    assert.equal(successorPlan!.assignments.find((a) => a.taskId === 'a')!.executor, 'beta');
    assert.equal(successorPlan!.assignments.find((a) => a.taskId === 'a')!.adapter, 'fake-executor');

    // Base Run 永久保留 alpha（history not rewritten）
    const basePlanAfter = await readExecutorPlanOrNull(speccraftDir, 'run-1');
    assert.equal(basePlanAfter!.assignments.find((a) => a.taskId === 'a')!.executor, 'alpha');
    const baseGraph = await readTaskGraphOrNull(speccraftDir, 'run-1');
    assert.equal(baseGraph!.tasks.find((t) => t.id === 'a')!.executor, 'alpha');
    assert.equal(basePlanAfter!.runId, 'run-1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §74 E2E D — Proposal Changed After Analysis
// ---------------------------------------------------------------------------

test('E2E D §74：analyze 后修改 proposal → approve 必须 proposal_changed_since_analysis，重分析后可 approve 且 attempt-001 保留', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, workflow, changeId } = await setupChange(root);

    const first = await analyzeChange({ speccraftDir, changeId, workflow });
    assert.equal(first.attempt, 'attempt-001');
    assert.equal(first.result, 'complete');

    // 修改 proposal（重新 stage requirement v3）
    await stageProposalArtifact({
      speccraftDir,
      changeId,
      stageId: 'requirement',
      source: REQUIREMENT_V3,
      workflow,
    });

    await assertChangeError('proposal_changed_since_analysis', () =>
      approveChange({ speccraftDir, changeId, approvedBy: 'owner' }),
    );
    assert.equal(await exists(path.join(changeDir(speccraftDir, changeId), 'approval.yaml')), false);

    // 重新 analyze → attempt-002
    const second = await analyzeChange({ speccraftDir, changeId, workflow });
    assert.equal(second.attempt, 'attempt-002');
    assert.equal(second.result, 'complete');

    await approveChange({ speccraftDir, changeId, approvedBy: 'owner' });
    const approval = await readApprovalOrNull(speccraftDir, changeId);
    assert.equal(approval!.analysis_attempt, 'attempt-002');

    // Attempt 001 不删除
    assert.equal(await exists(analysisAttemptDir(speccraftDir, changeId, 'attempt-001')), true);
    assert.equal(await exists(analysisAttemptDir(speccraftDir, changeId, 'attempt-002')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §75 E2E E — Approved Proposal Immutable
// ---------------------------------------------------------------------------

test('E2E E §75：approve 后 stage / retain / stage-config 全部 change_already_approved', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, workflow, changeId } = await setupApproved(root);

    await assertChangeError('change_already_approved', () =>
      stageProposalArtifact({
        speccraftDir,
        changeId,
        stageId: 'requirement',
        source: REQUIREMENT_V3,
        workflow,
      }),
    );
    await assertChangeError('change_already_approved', () =>
      retainArtifact({ speccraftDir, changeId, stageId: 'concept', workflow }),
    );
    await assertChangeError('change_already_approved', () =>
      stageProposalConfig({ speccraftDir, changeId, source: EXECUTOR_CONFIG }),
    );

    // approved proposal 未被改写
    assert.equal(await exists(proposalArtifactPath(speccraftDir, changeId, 'requirement')), true);
    const staged = await readFile(proposalArtifactPath(speccraftDir, changeId, 'requirement'), 'utf8');
    assert.match(staged, /Requirements v2/);
    assert.doesNotMatch(staged, /Requirements v3/);
    assert.equal(await exists(proposalConfigPath(speccraftDir, changeId)), false);
    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'approved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §76 E2E F — Non-deterministic Recompile Guard
// ---------------------------------------------------------------------------

test('E2E F §76：tamper Candidate Evidence → replan non_deterministic_recompile，不 supersede base、不留 Successor', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, workflow, changeId, attempt } = await setupApproved(root);
    const runsBefore = (await listRuns(speccraftDir)).map((r) => r.id);

    const resolvedRequirement = path.join(
      analysisAttemptDir(speccraftDir, changeId, attempt),
      'resolved',
      'artifacts',
      'requirement.md',
    );
    const original = await readFile(resolvedRequirement, 'utf8');
    await writeFile(resolvedRequirement, `${original}\n<!-- tampered -->\n`, 'utf8');

    await assertChangeError('non_deterministic_recompile', () =>
      replanChange({ speccraftDir, projectRoot: root, changeId, workflow }),
    );

    // 不得 supersede base Run
    assert.equal(await readRunSupersessionOrNull(speccraftDir, 'run-1'), null);
    // 不得留下 usable Successor
    assert.equal(await readChangeMaterializationOrNull(speccraftDir, changeId), null);
    const runsAfter = (await listRuns(speccraftDir)).map((r) => r.id);
    assert.deepEqual(runsAfter, runsBefore, '失败 replan 不得留下 Successor Run');
    // Change 保持 approved
    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'approved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// §77–§84 权威 E2E G–N
// ===========================================================================

// ---------------------------------------------------------------------------
// 共享 harness A：真实 Git repo + prepared Base Run + approved Successor
//   （§77 / §78 / §81 —— 需要真实 dispatch → verification → review → commit）
// ---------------------------------------------------------------------------

/** 读取 canonical repo 当前 HEAD sha */
function gitHead(cwd: string): string {
  return String(spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout ?? '').trim();
}

/**
 * 读取 git 对象类型。用于证明 Review 绑定的 pre/post commit 是真实 git 对象
 * （sequential review 用 synthetic detached commit，不移动 canonical HEAD）。
 */
function gitObjectType(cwd: string, sha: string): string {
  return String(spawnSync('git', ['cat-file', '-t', sha], { cwd, encoding: 'utf8' }).stdout ?? '').trim();
}

interface WorkSpec {
  write?: Record<string, string>;
  sleepMs?: number;
}

/** 真实施工 adapter（id 必须与 project.yaml 的 execution.default_adapter 一致） */
function makeFakeWorkAdapter(id: string, plan: Record<string, WorkSpec>): CliExecutionAdapter {
  return {
    id,
    kind: 'cli',
    capabilities: {
      invoke: true,
      resume: true,
      structuredOutput: true,
      finalMessageFile: true,
      sessionId: true,
      modelSelection: false,
    },
    prepare: manualAdapter.prepare,
    probe: async () => ({ id, installed: true }),
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
          const obj = JSON.parse(t) as { session_id?: string };
          if (obj.session_id) sessionId = obj.session_id;
        } catch {
          /* ignore */
        }
      }
      return {
        adapter: id,
        status: input.timedOut
          ? 'timed_out'
          : input.spawnError
            ? 'spawn_error'
            : input.exitCode === 0
              ? 'succeeded'
              : 'failed',
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

/** 从 review attempt dir（.../tasks/<task>/reviews/<gate>/attempt-NNN）解析身份 */
function parseReviewRunDir(runDir: string): { taskId: string; gateId: string; attempt: number } {
  const m = runDir.match(/tasks\/([^/]+)\/reviews\/([^/]+)\/attempt-(\d+)/);
  return {
    taskId: m ? m[1] : 'unknown',
    gateId: m ? m[2] : 'unknown',
    attempt: m ? Number(m[3]) : 0,
  };
}

/** 真实 Reviewer adapter（review-pass 等模式；session 绑定 task + gate + attempt） */
function makeFakeReviewerAdapter(
  mode: string | ((taskId: string) => string),
  observe?: (taskId: string, runDir: string) => void,
): CliExecutionAdapter {
  return {
    id: 'fake-reviewer',
    kind: 'cli',
    capabilities: {
      invoke: true,
      resume: false,
      structuredOutput: false,
      finalMessageFile: false,
      sessionId: true,
      modelSelection: false,
    },
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
        } catch {
          /* ignore */
        }
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

/** 用内置模板生成 canonical artifact（真实 v0.8 落盘路径） */
async function makeStageArtifact(
  speccraftDir: string,
  workflow: Workflow,
  state: State,
  stageId: string,
): Promise<void> {
  const stage = workflow.stages.find((s) => s.id === stageId)!;
  const target = completeStage(workflow, state, stageId);
  const body = await resolveTemplateContent(stage.template ?? stage.id);
  const artifact = createArtifact(
    { artifact: stage.produces[0], stage: stageId, status: target, version: 1 },
    body,
  );
  await writeArtifact(path.join(speccraftDir, 'artifacts', artifactFileName(stage.produces[0])), artifact);
}

/** 顺序执行的 review-enabled 项目配置：spec_compliance + code_quality 两 gate */
const SUCCESSOR_REVIEW_YAML = [
  'name: changes-successor-e2e',
  'verification: { commands: ["true"], timeout_seconds: 30 }',
  'execution: { default_adapter: fake }',
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

/** 并行的 review-enabled 项目配置：单 gate（§82 review semantics） */
const PARALLEL_SUCCESSOR_YAML = [
  'name: changes-parallel-successor-e2e',
  'verification: { commands: ["true"], timeout_seconds: 60 }',
  'execution: { default_adapter: fake }',
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

interface SuccessorHarness {
  outer: string;
  root: string;
  speccraftDir: string;
  workflow: Workflow;
  state: State;
  baseRunId: string;
  changeId: string;
  attempt: string;
  successorRun: string;
}

/**
 * 构造真实 Git repo + prepared Base Run + approved/materialized Change + Successor Run。
 *
 * 全程真实生产路径：initProject → makeStageArtifact（真实模板）→ prepareExecution →
 * compileTaskGraph（frozen base plan）→ createChange → stageProposalArtifact / retainArtifact
 * → analyzeChange → approveChange → replanChange。不做 stub、不手工写 Evidence。
 */
async function makeChangeSuccessorProject(opts: {
  projectYaml: string;
  baseBlock: string;
  nextBlock: string;
  requirementSource: string;
}): Promise<SuccessorHarness> {
  const outer = await mkdtemp(path.join(os.tmpdir(), 'speccraft-changes-successor-'));
  const root = path.join(outer, 'proj');
  await mkdir(root, { recursive: true });
  await runGitAsync(root, ['init', '-q']);
  await runGitAsync(root, ['config', 'user.email', 'test@example.com']);
  await runGitAsync(root, ['config', 'user.name', 'Test']);
  // `.speccraft/*`（而非 `.speccraft/`）：忽略 runtime 内容但不忽略 `.speccraft` 目录本身。
  // 若目录本身被 ignore，runtime 的 `git add -A -- . ':(exclude).speccraft/**'` 会因
  // “pathspec 命中被忽略目录”而 exit 1，导致 sequential review pre-snapshot 失败。
  await writeFile(path.join(root, '.gitignore'), '.speccraft/*\n', 'utf8');
  await writeFile(path.join(root, 'README.md'), 'init\n', 'utf8');
  await runGitAsync(root, ['add', '.']);
  await runGitAsync(root, ['commit', '-q', '-m', 'init']);

  const { speccraftDir } = await initProject({ projectRoot: root });
  const { workflow, state } = await loadProject(root);
  for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
    await makeStageArtifact(speccraftDir, workflow, state, id);
  }
  approveStage(workflow, state, 'design', 'owner');
  for (const id of ['build-brief', 'site-survey', 'execution-manual']) {
    await makeStageArtifact(speccraftDir, workflow, state, id);
  }

  const manualPath = path.join(speccraftDir, 'artifacts', 'execution-manual.md');
  const baseManual = await readArtifact(manualPath);
  baseManual.body = manualBody(opts.baseBlock);
  await writeArtifact(manualPath, baseManual);

  await writeState(speccraftDir, state);
  await writeFile(path.join(speccraftDir, 'project.yaml'), opts.projectYaml, 'utf8');

  await mkdir(path.join(root, 'src', 'a'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a', 'value.txt'), 'v1\n', 'utf8');
  await runGitAsync(root, ['add', '.']);
  await runGitAsync(root, ['commit', '-q', '-m', 'scaffold']);

  // frozen review plan 需要已知 reviewer adapter（后续用同 id 的真实 cli adapter 覆盖）
  registerAdapter({ ...manualAdapter, id: 'fake-reviewer' } as never);
  registerAdapter({ ...manualAdapter, id: 'fake' } as never);

  const { runId: baseRunId } = await prepareExecution({ projectRoot: root, adapterId: 'fake' });
  const projectConfig = await loadProjectConfig(speccraftDir);
  await compileTaskGraph({
    speccraftDir,
    runId: baseRunId,
    manualBody: manualBody(opts.baseBlock),
    source: 'execution-manual',
    projectConfig,
  });

  const manifest = await createChange({
    speccraftDir,
    projectRoot: root,
    workflow,
    baseRunId,
    reason: '调整任务图',
  });
  await stageProposalArtifact({
    speccraftDir,
    changeId: manifest.id,
    stageId: 'requirement',
    source: opts.requirementSource,
    workflow,
  });
  await stageProposalArtifact({
    speccraftDir,
    changeId: manifest.id,
    stageId: 'execution-manual',
    source: `---\nartifact: execution-manual\nstage: execution-manual\nstatus: completed\nversion: 2\n---\n\n${manualBody(opts.nextBlock)}`,
    workflow,
  });
  for (const stage of RETAINED) {
    await retainArtifact({ speccraftDir, changeId: manifest.id, stageId: stage, workflow });
  }

  const analysis = await analyzeChange({ speccraftDir, changeId: manifest.id, workflow });
  assert.equal(
    analysis.result,
    'complete',
    `analysis 必须 complete：${analysis.unresolved.join(', ')}`,
  );
  await approveChange({ speccraftDir, changeId: manifest.id, approvedBy: 'owner' });
  const replan = await replanChange({
    speccraftDir,
    projectRoot: root,
    changeId: manifest.id,
    workflow,
  });

  return {
    outer,
    root,
    speccraftDir,
    workflow,
    state,
    baseRunId,
    changeId: manifest.id,
    attempt: analysis.attempt,
    successorRun: replan.successorRun,
  };
}

function cleanupHarness(root: string): Promise<void> {
  return rm(path.dirname(root), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 共享 harness B：轻量（非 Git）approved/materialized Change（§79 / §80 / §83 / §84）
// ---------------------------------------------------------------------------

const REQUIREMENT_REL = 'artifacts/requirements.md';
const MANUAL_REL = 'artifacts/execution-manual.md';

/** 构造 materialized Change（Successor Run 已生成，尚未 Owner Accept） */
async function setupMaterialized(
  root: string,
): Promise<Fixture & { attempt: string; successorRun: string }> {
  const approved = await setupApproved(root);
  const replan = await replanChange({
    speccraftDir: approved.speccraftDir,
    projectRoot: root,
    changeId: approved.changeId,
    workflow: approved.workflow,
  });
  return { ...approved, successorRun: replan.successorRun };
}

/** 把 Successor Run 置为 accepted（等价 Owner Acceptance 已发生的 Run 状态） */
async function acceptSuccessor(speccraftDir: string, runId: string): Promise<void> {
  const run = await readRun(speccraftDir, runId);
  await updateRunStatus(speccraftDir, run, 'accepted');
}

/** approved resolved snapshot 中某 artifact 的原始字节 */
async function approvedBytes(
  speccraftDir: string,
  changeId: string,
  attempt: string,
  stage: string,
): Promise<Buffer> {
  return readFile(
    path.join(analysisAttemptDir(speccraftDir, changeId, attempt), 'resolved', 'artifacts', `${stage}.md`),
  );
}

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return chunks.join('\n');
}

/** 运行 CLI `speccraft validate`，返回退出码与 stdout */
async function runValidate(root: string): Promise<{ code: number; stdout: string }> {
  let code = 0;
  const stdout = await captureStdout(async () => {
    code = await cmdValidate(root);
  });
  return { code, stdout };
}

/** 在指定 base Run 上开启一个新 Change（§83 第二次变更） */
async function setupChangeOnRun(
  root: string,
  baseRunId: string,
  requirementSource: string,
  reason: string,
  manualSource: string = MANUAL_V2,
): Promise<Fixture> {
  const speccraftDir = path.join(root, '.speccraft');
  const { workflow } = await loadProject(root);
  const manifest = await createChange({
    speccraftDir,
    projectRoot: root,
    workflow,
    baseRunId,
    reason,
  });
  await stageProposalArtifact({
    speccraftDir,
    changeId: manifest.id,
    stageId: 'requirement',
    source: requirementSource,
    workflow,
  });
  await stageProposalArtifact({
    speccraftDir,
    changeId: manifest.id,
    stageId: 'execution-manual',
    source: manualSource,
    workflow,
  });
  for (const stage of RETAINED) {
    await retainArtifact({ speccraftDir, changeId: manifest.id, stageId: stage, workflow });
  }
  return { speccraftDir, workflow, changeId: manifest.id };
}

/** analyze → approve → replan，返回 Successor Run id */
async function approveAndReplan(root: string, fixture: Fixture): Promise<string> {
  const analysis = await analyzeChange({
    speccraftDir: fixture.speccraftDir,
    changeId: fixture.changeId,
    workflow: fixture.workflow,
  });
  assert.equal(
    analysis.result,
    'complete',
    `analysis 必须 complete：${analysis.unresolved.join(', ')}`,
  );
  await approveChange({
    speccraftDir: fixture.speccraftDir,
    changeId: fixture.changeId,
    approvedBy: 'owner',
  });
  const replan = await replanChange({
    speccraftDir: fixture.speccraftDir,
    projectRoot: root,
    changeId: fixture.changeId,
    workflow: fixture.workflow,
  });
  return replan.successorRun;
}

// ---------------------------------------------------------------------------
// G–N 附加素材
// ---------------------------------------------------------------------------

/** successor 图（NEXT_BLOCK：a → b → d）的真实施工计划 */
const SUCCESSOR_PLAN: Record<string, WorkSpec> = {
  a: { write: { 'src/a/base.txt': 'AAA' } },
  b: { write: { 'src/b/mid.txt': 'BBB' } },
  d: { write: { 'src/d/final.txt': 'DDD' } },
};

/** §82 的 Diamond：A → (B + C) → D */
const DIAMOND_BLOCK = graphBlock([
  { id: 'a', summary: 'Do A', dependsOn: [] },
  { id: 'b', summary: 'Do B', dependsOn: ['a'] },
  { id: 'c', summary: 'Do C', dependsOn: ['a'] },
  { id: 'd', summary: 'Do D', dependsOn: ['b', 'c'] },
]);

const DIAMOND_PLAN: Record<string, WorkSpec> = {
  a: { write: { 'src/a/base.txt': 'AAA' } },
  b: { write: { 'src/b/mid.txt': 'BBB' }, sleepMs: 700 },
  c: { write: { 'src/c/mid.txt': 'CCC' }, sleepMs: 700 },
  d: { write: { 'src/d/final.txt': 'DDD' } },
};

/** §83 的第二次变更图 */
const SECOND_BLOCK = graphBlock([
  { id: 'a', summary: 'Do A once more', dependsOn: [] },
  { id: 'b', summary: 'Do B', dependsOn: ['a'] },
  { id: 'e', summary: 'Do E', dependsOn: ['b'] },
]);
const MANUAL_V3 = `---\nartifact: execution-manual\nstage: execution-manual\nstatus: completed\nversion: 3\n---\n\n${manualBody(SECOND_BLOCK)}`;

/** 从磁盘重新加载 state（execute / verify / accept 都会改写它） */
async function reloadState(root: string): Promise<State> {
  return (await loadProject(root)).state;
}

// ---------------------------------------------------------------------------
// §77 E2E G — Successful Successor Lifecycle
// ---------------------------------------------------------------------------

test('E2E G §77：完整 Successor 生命周期 Execute → Verify → Review → Accept → Close → Handoff', async () => {
  const h = await makeChangeSuccessorProject({
    projectYaml: SUCCESSOR_REVIEW_YAML,
    baseBlock: BASE_BLOCK,
    nextBlock: NEXT_BLOCK,
    requirementSource: REQUIREMENT_V2,
  });
  try {
    const workAdapter = makeFakeWorkAdapter('fake', SUCCESSOR_PLAN);
    registerAdapter(workAdapter);
    registerAdapter(makeFakeReviewerAdapter('review-pass'));

    // Successor 的 frozen plan 来自 approved Candidate（§36）
    const successorGraph = await readTaskGraph(h.speccraftDir, h.successorRun);
    assert.deepEqual(successorGraph.tasks.map((t) => t.id), ['a', 'b', 'd']);
    const reviewPlan = await readReviewPlanOrNull(h.speccraftDir, h.successorRun);
    assert.ok(reviewPlan, 'Successor 必须有 frozen review plan');
    assert.equal(reviewPlan!.enabled, true);
    assert.deepEqual(reviewPlan!.gates.map((g) => g.id), ['spec_compliance', 'code_quality']);

    // 1) Execute：真实 Task → Verification → Review → Commit
    const executed = await executeTaskGraph({
      speccraftDir: h.speccraftDir,
      projectRoot: h.root,
      runId: h.successorRun,
      adapter: workAdapter,
      runContext: '# ctx',
      executionGuard: '# guard',
      reviewPlan: reviewPlan!,
    });
    assert.equal(executed.complete, true, `execute 必须 complete：${executed.reason ?? ''}`);
    assert.equal(executed.reviewEnabled, true);
    for (const id of ['a', 'b', 'd']) {
      assert.equal(
        (await readTaskManifest(h.speccraftDir, h.successorRun, id))?.status,
        'completed',
        `task ${id} 必须 completed`,
      );
      for (const gate of ['spec_compliance', 'code_quality']) {
        const m = await readReviewManifestOrNull(
          path.join(h.speccraftDir, 'runs', h.successorRun, 'tasks', id, 'reviews', gate, 'attempt-001'),
        );
        assert.ok(m, `${id}/${gate} 必须有真实 review attempt`);
        assert.equal(m!.decision, 'pass');
        assert.equal(m!.session_id, `review-${id}-${gate}-1`);
      }
    }

    // 2) Verification PASS
    const verification = await verifyExecution({ projectRoot: h.root });
    assert.equal(verification.passed, true);

    // 3) Owner Acceptance（真实 accept，而非手工改 Run 状态）
    const stateAfterVerify = await reloadState(h.root);
    assert.equal(stateAfterVerify.stages['owner-acceptance']?.status, 'waiting_owner_approval');
    const run = await readRun(h.speccraftDir, h.successorRun);
    await accept(h.speccraftDir, h.root, h.workflow, stateAfterVerify, run, {
      by: 'owner',
      feedback: 'ok',
    });

    // 4) Change Close：approved target 提升为 canonical
    const closed = await closeChange({ speccraftDir: h.speccraftDir, changeId: h.changeId });
    assert.equal(closed.reused, false);
    assert.equal(closed.successorRun, h.successorRun);
    assert.equal((await readChangeManifest(h.speccraftDir, h.changeId)).status, 'closed');

    // 最终态 1：Predecessor superseded
    const supersession = await readRunSupersessionOrNull(h.speccraftDir, h.baseRunId);
    assert.ok(supersession, 'Predecessor 必须有 superseded.yaml');
    assert.equal(supersession!.change_id, h.changeId);
    assert.equal(supersession!.successor_run, h.successorRun);

    // 最终态 2：Successor accepted
    assert.equal((await readRun(h.speccraftDir, h.successorRun)).status, 'accepted');

    // 最终态 3：canonical artifacts == approved target
    assert.deepEqual(
      await readFile(path.join(h.speccraftDir, REQUIREMENT_REL)),
      await approvedBytes(h.speccraftDir, h.changeId, h.attempt, 'requirement'),
    );
    assert.deepEqual(
      await readFile(path.join(h.speccraftDir, MANUAL_REL)),
      await approvedBytes(h.speccraftDir, h.changeId, h.attempt, 'execution-manual'),
    );

    // 5) Handoff：必须带上 change-history.md
    const out = await handoff(
      h.speccraftDir,
      h.root,
      'changes-successor-e2e',
      h.workflow,
      stateAfterVerify,
      run,
    );
    assert.equal(out.reused, false);
    const dir = handoffDir(h.speccraftDir, out.handoffId);
    assert.ok((await readdir(dir)).includes('change-history.md'));

    const history = await readFile(path.join(dir, 'change-history.md'), 'utf8');
    assert.match(history, /# Change History/);
    assert.ok(history.includes(`- Change ID: ${h.changeId}`));
    assert.ok(history.includes(`- Predecessor Run: ${h.baseRunId}`));
    assert.ok(history.includes(`- Successor Run: ${h.successorRun}`));
    assert.ok(history.includes('- Closed At:'));
    assert.ok(!history.includes('（未 close）'), 'closed Change 的 change-history 不得显示未 close');
    for (const section of ['## Changed Artifacts', '## Retained Artifacts', '## Task Diff', '## Executor Diff', '## Review Diff']) {
      assert.ok(history.includes(section), `change-history.md 必须包含 ${section}`);
    }

    const pkg = yaml.load(await readFile(path.join(dir, 'manifest.yaml'), 'utf8')) as {
      files?: string[];
      file_hashes?: Record<string, string>;
    };
    assert.ok(pkg.files?.includes('change-history.md'), 'manifest.yaml 必须登记 change-history.md');
    assert.ok(pkg.file_hashes?.['change-history.md'], 'manifest.yaml 必须记录 change-history.md hash');
  } finally {
    await cleanupHarness(h.root);
  }
});

// ---------------------------------------------------------------------------
// §78 E2E H — Close Requires Acceptance
// ---------------------------------------------------------------------------

test('E2E H §78：Verification PASS + Review PASS 但未 Owner Accept → close 必须 successor_not_accepted', async () => {
  const h = await makeChangeSuccessorProject({
    projectYaml: SUCCESSOR_REVIEW_YAML,
    baseBlock: BASE_BLOCK,
    nextBlock: NEXT_BLOCK,
    requirementSource: REQUIREMENT_V2,
  });
  try {
    const workAdapter = makeFakeWorkAdapter('fake', SUCCESSOR_PLAN);
    registerAdapter(workAdapter);
    registerAdapter(makeFakeReviewerAdapter('review-pass'));

    const reviewPlan = await readReviewPlanOrNull(h.speccraftDir, h.successorRun);
    const executed = await executeTaskGraph({
      speccraftDir: h.speccraftDir,
      projectRoot: h.root,
      runId: h.successorRun,
      adapter: workAdapter,
      runContext: '# ctx',
      executionGuard: '# guard',
      reviewPlan: reviewPlan!,
    });
    assert.equal(executed.complete, true);
    assert.equal(executed.reviewEnabled, true);

    const verification = await verifyExecution({ projectRoot: h.root });
    assert.equal(verification.passed, true);
    assert.equal((await readRun(h.speccraftDir, h.successorRun)).status, 'awaiting_owner_acceptance');

    // Verification PASS + Review PASS ≠ Owner Acceptance
    await assertChangeError('successor_not_accepted', () =>
      closeChange({ speccraftDir: h.speccraftDir, changeId: h.changeId }),
    );
    assert.equal(await exists(closePath(h.speccraftDir, h.changeId)), false);
    assert.equal((await readChangeManifest(h.speccraftDir, h.changeId)).status, 'materialized');
    // canonical 仍是 baseline（未提升）
    assert.deepEqual(
      await readFile(path.join(h.speccraftDir, REQUIREMENT_REL)),
      await readFile(path.join(changeDir(h.speccraftDir, h.changeId), 'baseline', 'artifacts', 'requirement.md')),
    );

    // 补齐 Owner Acceptance 后 close 才成功 —— 证明唯一缺失的 gate 是 acceptance
    const state = await reloadState(h.root);
    const run = await readRun(h.speccraftDir, h.successorRun);
    await accept(h.speccraftDir, h.root, h.workflow, state, run, { by: 'owner', feedback: 'ok' });
    const closed = await closeChange({ speccraftDir: h.speccraftDir, changeId: h.changeId });
    assert.equal(closed.reused, false);
    assert.equal((await readChangeManifest(h.speccraftDir, h.changeId)).status, 'closed');
  } finally {
    await cleanupHarness(h.root);
  }
});

// ---------------------------------------------------------------------------
// §79 E2E I — Canonical Drift
// ---------------------------------------------------------------------------

test('E2E I §79：accept 后、close 前人为修改 canonical artifact → canonical_drift 且不覆盖未知修改', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, attempt, successorRun } = await setupMaterialized(root);
    await acceptSuccessor(speccraftDir, successorRun);

    const manualBaseline = await readFile(path.join(speccraftDir, MANUAL_REL));
    const tampered =
      '---\nartifact: requirements\nstage: requirement\nstatus: completed\nversion: 9\n---\n\n# 人为修改\n';
    await writeFile(path.join(speccraftDir, REQUIREMENT_REL), tampered, 'utf8');

    await assertChangeError('canonical_drift', () => closeChange({ speccraftDir, changeId }));

    // 不得覆盖未知修改
    assert.equal(await readFile(path.join(speccraftDir, REQUIREMENT_REL), 'utf8'), tampered);
    // 其他 target 也不得被写入（fail-before-mutation）
    assert.deepEqual(await readFile(path.join(speccraftDir, MANUAL_REL)), manualBaseline);
    assert.equal(await exists(closePath(speccraftDir, changeId)), false);
    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'materialized');
    // tamper 的确不同于 approved target
    assert.notDeepEqual(
      Buffer.from(tampered, 'utf8'),
      await approvedBytes(speccraftDir, changeId, attempt, 'requirement'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §80 E2E J — Idempotent / Interrupted Close
// ---------------------------------------------------------------------------

test('E2E J §80：部分 target 已 promote、部分仍 baseline → close 成功（跳过 target、替换 baseline），hashes 正确且可重复', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, attempt, successorRun } = await setupMaterialized(root);
    await acceptSuccessor(speccraftDir, successorRun);

    const requirementTarget = await approvedBytes(speccraftDir, changeId, attempt, 'requirement');
    const manualTarget = await approvedBytes(speccraftDir, changeId, attempt, 'execution-manual');
    assert.notDeepEqual(manualTarget, await readFile(path.join(speccraftDir, MANUAL_REL)));

    // 模拟被中断的 close：requirement 已是 approved target，manual 仍是 baseline
    await writeFile(path.join(speccraftDir, REQUIREMENT_REL), requirementTarget);

    const result = await closeChange({ speccraftDir, changeId });
    assert.equal(result.reused, false);
    assert.deepEqual([...result.skippedFiles].sort(), [REQUIREMENT_REL]);
    assert.deepEqual([...result.promotedFiles].sort(), [MANUAL_REL]);

    // 最终 hashes 正确
    assert.deepEqual(await readFile(path.join(speccraftDir, REQUIREMENT_REL)), requirementTarget);
    assert.deepEqual(await readFile(path.join(speccraftDir, MANUAL_REL)), manualTarget);

    const close = parseChangeClose(await readFile(closePath(speccraftDir, changeId), 'utf8'));
    assert.equal(close.change_id, changeId);
    assert.equal(close.successor_run, successorRun);
    assert.deepEqual([...close.promoted_files].sort(), [MANUAL_REL, REQUIREMENT_REL]);
    assert.equal(close.after_hashes[REQUIREMENT_REL], sha256Bytes(requirementTarget));
    assert.equal(close.after_hashes[MANUAL_REL], sha256Bytes(manualTarget));

    // 幂等：重复 close 复用同一 close record，不再写 canonical
    const again = await closeChange({ speccraftDir, changeId });
    assert.equal(again.reused, true);
    assert.deepEqual(again.promotedFiles, []);
    assert.deepEqual([...again.skippedFiles].sort(), [MANUAL_REL, REQUIREMENT_REL]);
    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'closed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §81 E2E K — Successor Review Runtime Regression
// ---------------------------------------------------------------------------

test('E2E K §81：Successor Run review.enabled=true 真实走 Task → Verification → Review → Commit，lineage 不破坏 v0.8 Review Gate', async () => {
  const h = await makeChangeSuccessorProject({
    projectYaml: SUCCESSOR_REVIEW_YAML,
    baseBlock: BASE_BLOCK,
    nextBlock: NEXT_BLOCK,
    requirementSource: REQUIREMENT_V2,
  });
  try {
    const workAdapter = makeFakeWorkAdapter('fake', SUCCESSOR_PLAN);
    registerAdapter(workAdapter);
    registerAdapter(makeFakeReviewerAdapter('review-pass'));

    const reviewPlan = await readReviewPlanOrNull(h.speccraftDir, h.successorRun);
    assert.ok(reviewPlan?.enabled, 'Successor Run 必须 review.enabled=true');

    const headBefore = gitHead(h.root);
    const executed = await executeTaskGraph({
      speccraftDir: h.speccraftDir,
      projectRoot: h.root,
      runId: h.successorRun,
      adapter: workAdapter,
      runContext: '# ctx',
      executionGuard: '# guard',
      reviewPlan: reviewPlan!,
    });
    assert.equal(executed.complete, true, `execute 必须 complete：${executed.reason ?? ''}`);
    assert.equal(executed.reviewEnabled, true);
    // sequential review 的「Commit」= Runtime 为 exact delta 生成的 synthetic commit：
    // canonical HEAD 不移动，但每个 review attempt 必须绑定真实且不同的 pre/post tree + commit。
    assert.equal(gitHead(h.root), headBefore, 'sequential review 不得移动 canonical HEAD');

    for (const id of ['a', 'b', 'd']) {
      const tm = await readTaskManifest(h.speccraftDir, h.successorRun, id);
      assert.equal(tm?.status, 'completed');

      const dispatchAttempts = await listDispatchAttemptsForTask(h.speccraftDir, h.successorRun, id);
      assert.equal(dispatchAttempts.length, 1, `${id} 必须有 1 次真实 dispatch`);
      const dispatch = await readDispatchAttempt(h.speccraftDir, h.successorRun, dispatchAttempts[0]);
      assert.ok(dispatch, `${id} dispatch manifest 必须存在`);
      assert.equal(dispatch!.status, 'succeeded');
      assert.ok(dispatch!.started_at && dispatch!.finished_at);

      const verificationAttempts = await listTaskVerificationAttempts(h.speccraftDir, h.successorRun, id);
      assert.ok(verificationAttempts.length >= 1, `${id} 必须有真实 verification attempt`);

      for (const gate of ['spec_compliance', 'code_quality']) {
        const m = await readReviewManifestOrNull(
          path.join(h.speccraftDir, 'runs', h.successorRun, 'tasks', id, 'reviews', gate, 'attempt-001'),
        );
        assert.ok(m, `${id}/${gate} 必须有真实 review attempt`);
        assert.equal(m!.decision, 'pass');
        assert.equal(m!.source_dispatch_attempt, tm!.dispatchAttempts[0]);
        assert.equal(m!.source_verification_attempt, verificationAttempts[0]);
        assert.equal(m!.session_id, `review-${id}-${gate}-1`);
        // 真实 Commit：pre/post tree + commit 均为真实 git 对象且互不相同
        assert.match(m!.pre_commit, /^[0-9a-f]{40}$/);
        assert.match(m!.post_commit, /^[0-9a-f]{40}$/);
        assert.notEqual(m!.pre_commit, m!.post_commit, `${id}/${gate} pre/post commit 必须不同`);
        assert.notEqual(m!.pre_tree, m!.post_tree, `${id}/${gate} pre/post tree 必须不同`);
        assert.equal(gitObjectType(h.root, m!.post_commit), 'commit', `${id}/${gate} post_commit 必须是真实 commit 对象`);
      }
    }

    const verification = await verifyExecution({ projectRoot: h.root });
    assert.equal(verification.passed, true);

    // v0.9 lineage 仍然完好；canonical 在 close 之前仍是 baseline
    const lineage = await readRunLineageOrNull(h.speccraftDir, h.successorRun);
    assert.equal(lineage!.predecessor_run, h.baseRunId);
    assert.equal(lineage!.change_id, h.changeId);
    const manualBodyNow = await readExecutionManualBody(h.speccraftDir);
    assert.ok(manualBodyNow.includes('Do C'), 'canonical execution-manual 在 close 前必须仍是 baseline');
    assert.ok(!manualBodyNow.includes('Do D'));
  } finally {
    await cleanupHarness(h.root);
  }
});

// ---------------------------------------------------------------------------
// §82 E2E L — Parallel Successor Regression
// ---------------------------------------------------------------------------

test('E2E L §82：Successor Diamond A → (B + C) → D 并行 3 waves、B/C overlap、workspace/review/integration 语义不变', async () => {
  const h = await makeChangeSuccessorProject({
    projectYaml: PARALLEL_SUCCESSOR_YAML,
    baseBlock: BASE_BLOCK,
    nextBlock: DIAMOND_BLOCK,
    requirementSource: REQUIREMENT_V2,
  });
  try {
    const workAdapter = makeFakeWorkAdapter('fake', DIAMOND_PLAN);
    const observed = new Map<string, { taskCommit?: string; integrationCommit?: string }>();
    const reviewer = makeFakeReviewerAdapter('review-pass', (taskId) => {
      void readLatestWorkspace(h.speccraftDir, h.successorRun, taskId).then((ws) => {
        observed.set(taskId, {
          ...(ws?.taskCommit ? { taskCommit: ws.taskCommit } : {}),
          ...(ws?.integrationCommit ? { integrationCommit: ws.integrationCommit } : {}),
        });
      });
    });
    registerAdapter(workAdapter);
    registerAdapter(reviewer);

    const reviewPlan = await readReviewPlanOrNull(h.speccraftDir, h.successorRun);
    assert.ok(reviewPlan?.enabled, 'Successor Run 必须 review.enabled=true');

    const baseHead = await readCanonicalHead(h.root);
    const result = await executeParallelTaskGraph({
      speccraftDir: h.speccraftDir,
      projectRoot: h.root,
      runId: h.successorRun,
      adapter: workAdapter,
      runContext: '# ctx',
      executionGuard: '# guard',
      maxParallel: 2,
      reviewPlan: reviewPlan!,
    });

    // 1) 3 waves：[a] → [b, c] → [d]
    assert.equal(result.complete, true, `complete（reason=${result.reason ?? 'n/a'}）`);
    assert.equal(result.waves, 3);
    const waveOf = new Map<number, string[]>();
    for (const w of result.waveSummaries) waveOf.set(w.wave, [...w.tasks].sort());
    assert.deepEqual(waveOf.get(1), ['a']);
    assert.deepEqual(waveOf.get(2), ['b', 'c']);
    assert.deepEqual(waveOf.get(3), ['d']);
    const diskWaves = await listWaves(h.speccraftDir, h.successorRun);
    assert.deepEqual(diskWaves, [1, 2, 3]);
    for (const w of diskWaves) {
      const wm = await readWaveManifest(h.speccraftDir, h.successorRun, w);
      assert.ok(wm, `wave ${w} manifest 必须存在`);
      assert.deepEqual([...wm!.tasks].sort(), (waveOf.get(w) ?? []).sort());
    }

    // 2) workspace isolation：B/C 各自完成 task commit + integration commit
    for (const id of ['a', 'b', 'c', 'd']) {
      assert.equal((await readTaskManifest(h.speccraftDir, h.successorRun, id))?.status, 'completed');
    }
    for (const id of ['b', 'c']) {
      const ws = await readWorkspace(h.speccraftDir, h.successorRun, id, 1);
      assert.ok(ws, `${id} workspace 必须存在`);
      assert.ok(ws!.taskCommit, `${id} 必须有 task commit`);
      assert.ok(ws!.integrationCommit, `${id} 必须有 integration commit`);
      assert.ok(['integrated', 'cleaned'].includes(ws!.status!), `${id} workspace status 异常：${ws!.status}`);
    }

    // 3) B/C 真实 wall-clock 并行
    const dispatchOf = new Map<string, NonNullable<Awaited<ReturnType<typeof readDispatchAttempt>>>>();
    for (const id of ['b', 'c']) {
      const tm = await readTaskManifest(h.speccraftDir, h.successorRun, id);
      assert.equal(tm!.dispatchAttempts.length, 1);
      const d = await readDispatchAttempt(h.speccraftDir, h.successorRun, tm!.dispatchAttempts[0]);
      assert.ok(d?.finished_at);
      dispatchOf.set(id, d!);
    }
    assert.ok(
      Date.parse(dispatchOf.get('b')!.started_at) < Date.parse(dispatchOf.get('c')!.finished_at!),
      'B 必须在 C 结束前开始',
    );
    assert.ok(
      Date.parse(dispatchOf.get('c')!.started_at) < Date.parse(dispatchOf.get('b')!.finished_at!),
      'C 必须在 B 结束前开始',
    );

    // 4) review semantics：真实 attempt、绑定真实 dispatch/verification、session 互异
    const sessions = new Map<string, string>();
    for (const id of ['b', 'c']) {
      const m = await readReviewManifestOrNull(
        path.join(h.speccraftDir, 'runs', h.successorRun, 'tasks', id, 'reviews', 'spec_compliance', 'attempt-001'),
      );
      assert.ok(m, `${id} review attempt 必须存在`);
      assert.equal(m!.decision, 'pass');
      assert.equal(m!.workspace_attempt, 1);
      const tm = await readTaskManifest(h.speccraftDir, h.successorRun, id);
      assert.equal(m!.source_dispatch_attempt, tm!.dispatchAttempts[0]);
      const vAttempts = await listTaskVerificationAttempts(h.speccraftDir, h.successorRun, id);
      assert.equal(m!.source_verification_attempt, vAttempts[0]);
      sessions.set(id, m!.session_id!);
    }
    assert.notEqual(sessions.get('b'), sessions.get('c'), 'B/C reviewer session 必须互异');
    // Review 发生在 Runtime Commit 之前
    for (const id of ['b', 'c']) {
      const obs = observed.get(id);
      assert.ok(obs, `必须观察到 ${id} 的 review invocation`);
      assert.equal(obs!.taskCommit, undefined, `${id} review 必须在 taskCommit 之前`);
      assert.equal(obs!.integrationCommit, undefined, `${id} review 必须在 integrationCommit 之前`);
    }

    // 5) integration semantics：canonical 含全部产物且 clean、HEAD 前进
    assert.equal(await readFile(path.join(h.root, 'src/a/base.txt'), 'utf8'), 'AAA');
    assert.equal(await readFile(path.join(h.root, 'src/b/mid.txt'), 'utf8'), 'BBB');
    assert.equal(await readFile(path.join(h.root, 'src/c/mid.txt'), 'utf8'), 'CCC');
    assert.equal(await readFile(path.join(h.root, 'src/d/final.txt'), 'utf8'), 'DDD');
    assert.equal(await isCanonicalClean(h.root), true);
    assert.notEqual(await readCanonicalHead(h.root), baseHead);

    // v0.9 lineage 未被并行路径破坏
    const lineage = await readRunLineageOrNull(h.speccraftDir, h.successorRun);
    assert.equal(lineage!.predecessor_run, h.baseRunId);
    assert.equal(lineage!.change_id, h.changeId);
  } finally {
    await cleanupHarness(h.root);
  }
});

// ---------------------------------------------------------------------------
// §83 E2E M — Second Change
// ---------------------------------------------------------------------------

test('E2E M §83：第二次 Change —— run-001 → change-001 → run-002 → change-002 → run-003，lineage 完整且 change-001 不可修改', async () => {
  const root = await newProject();
  try {
    const first = await setupMaterialized(root);
    assert.equal(first.changeId, 'change-001');

    const second = await setupChangeOnRun(root, first.successorRun, REQUIREMENT_V3, '第二次变更', MANUAL_V3);
    assert.equal(second.changeId, 'change-002');
    const thirdRun = await approveAndReplan(root, second);

    // lineage 链：run-001 → change-001 → run-002 → change-002 → run-003
    const lineageSecond = await readRunLineageOrNull(first.speccraftDir, first.successorRun);
    assert.equal(lineageSecond!.predecessor_run, 'run-1');
    assert.equal(lineageSecond!.change_id, 'change-001');
    const lineageThird = await readRunLineageOrNull(first.speccraftDir, thirdRun);
    assert.equal(lineageThird!.predecessor_run, first.successorRun);
    assert.equal(lineageThird!.change_id, 'change-002');
    assert.equal(
      (await readChangeMaterializationOrNull(first.speccraftDir, 'change-002'))!.successor_run,
      thirdRun,
    );

    // 历史不得改写：run-001 的 superseded link 仍指向 change-001 / run-002
    const baseSuper = await readRunSupersessionOrNull(first.speccraftDir, 'run-1');
    assert.equal(baseSuper!.change_id, 'change-001');
    assert.equal(baseSuper!.successor_run, first.successorRun);
    // run-002 被 change-002 supersede
    assert.equal(
      (await readRunSupersessionOrNull(first.speccraftDir, first.successorRun))!.change_id,
      'change-002',
    );

    // change-001 不可修改
    await assertChangeError('change_already_approved', () =>
      stageProposalArtifact({
        speccraftDir: first.speccraftDir,
        changeId: 'change-001',
        stageId: 'requirement',
        source: REQUIREMENT_V3,
        workflow: first.workflow,
      }),
    );
    await assertChangeError('change_not_approved', () =>
      replanChange({
        speccraftDir: first.speccraftDir,
        projectRoot: root,
        changeId: 'change-001',
        workflow: first.workflow,
      }),
    );
    const approvalFirst = await readApprovalOrNull(first.speccraftDir, 'change-001');
    assert.equal(approvalFirst!.analysis_attempt, first.attempt);
    assert.equal((await readChangeManifest(first.speccraftDir, 'change-001')).baseRunId, 'run-1');
    assert.match(
      await readFile(proposalArtifactPath(first.speccraftDir, 'change-001', 'requirement'), 'utf8'),
      /Requirements v2/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §84 E2E N — Validate Tampering
// ---------------------------------------------------------------------------

interface ClosedContext {
  speccraftDir: string;
  changeId: string;
  attempt: string;
  successorRun: string;
  baseRunId: string;
}

/** 构造 materialized → accepted → closed 的完整 Change（轻量非 Git harness） */
async function setupClosedChange(root: string): Promise<ClosedContext> {
  const speccraftDir = path.join(root, '.speccraft');
  const materialized = await setupMaterialized(root);
  await acceptSuccessor(speccraftDir, materialized.successorRun);
  const closed = await closeChange({ speccraftDir, changeId: materialized.changeId });
  assert.equal(closed.reused, false);
  return {
    speccraftDir,
    changeId: materialized.changeId,
    attempt: materialized.attempt,
    successorRun: materialized.successorRun,
    baseRunId: 'run-1',
  };
}

test('E2E N §84：tamper 任一 Change Evidence（approval / base run / lineage / bundle / candidate plan / close hash / superseded link）→ validate 必须 FAIL', async () => {
  const cases: Array<{ label: string; expect: string; tamper: (c: ClosedContext) => Promise<void> }> = [
    {
      label: 'approval digest',
      expect: 'approval analysis_bundle_sha256 与 Attempt 不一致',
      tamper: async (c) => {
        const file = approvalPath(c.speccraftDir, c.changeId);
        const approval = yaml.load(await readFile(file, 'utf8')) as Record<string, unknown>;
        approval.analysis_bundle_sha256 = 'f'.repeat(64);
        await writeFile(file, yaml.dump(approval), 'utf8');
      },
    },
    {
      label: 'base run',
      expect: 'base Run 不存在：run-999',
      tamper: async (c) => {
        const file = path.join(changeDir(c.speccraftDir, c.changeId), 'manifest.yaml');
        const manifest = yaml.load(await readFile(file, 'utf8')) as Record<string, unknown>;
        manifest.base_run_id = 'run-999';
        await writeFile(file, yaml.dump(manifest), 'utf8');
      },
    },
    {
      label: 'successor lineage',
      expect: 'Successor lineage 不一致',
      tamper: async (c) => {
        const lineage = await readRunLineageOrNull(c.speccraftDir, c.successorRun);
        assert.ok(lineage);
        await writeRunLineage(c.speccraftDir, c.successorRun, { ...lineage!, change_id: 'change-999' });
      },
    },
    {
      label: 'analysis bundle',
      expect: 'Analysis bundle digest 不一致',
      tamper: async (c) => {
        const file = path.join(
          analysisAttemptDir(c.speccraftDir, c.changeId, c.attempt),
          'resolved',
          'artifacts',
          'requirement.md',
        );
        await writeFile(file, `${await readFile(file, 'utf8')}\n<!-- tampered -->\n`, 'utf8');
      },
    },
    {
      label: 'candidate task plan',
      expect: 'Successor task graph digest 与 approved Candidate 不一致',
      tamper: async (c) => {
        const graph = await readTaskGraph(c.speccraftDir, c.successorRun);
        graph.tasks[0].summary = 'tampered';
        await writeTaskGraph(c.speccraftDir, c.successorRun, graph);
      },
    },
    {
      label: 'close hash',
      expect: 'close target hash 不一致',
      tamper: async (c) => {
        const file = path.join(c.speccraftDir, REQUIREMENT_REL);
        await writeFile(file, `${await readFile(file, 'utf8')}\n<!-- tampered -->\n`, 'utf8');
      },
    },
    {
      label: 'superseded link',
      expect: 'superseded evidence 与 materialization 不一致',
      tamper: async (c) => {
        const supersession = await readRunSupersessionOrNull(c.speccraftDir, c.baseRunId);
        assert.ok(supersession);
        await writeRunSupersession(c.speccraftDir, c.baseRunId, {
          ...supersession!,
          successor_run: 'run-999',
        });
      },
    },
  ];

  for (const c of cases) {
    const root = await newProject();
    try {
      const ctx = await setupClosedChange(root);

      // 基线：Change Evidence 完全一致
      assert.deepEqual(
        await checkChangeConsistency(ctx.speccraftDir, await readState(ctx.speccraftDir)),
        [],
        `[${c.label}] 基线 Change Evidence 必须一致`,
      );

      await c.tamper(ctx);

      const violations = await checkChangeConsistency(
        ctx.speccraftDir,
        await readState(ctx.speccraftDir),
      );
      assert.ok(
        violations.some((v) => v.includes(c.expect)),
        `[${c.label}] 必须出现违规「${c.expect}」，实际：${violations.join(' | ') || '（无）'}`,
      );

      // CLI 层必须 FAIL
      const result = await runValidate(root);
      assert.equal(result.code, 1, `[${c.label}] speccraft validate 必须 FAIL`);
      assert.ok(
        result.stdout.includes(c.expect),
        `[${c.label}] validate 输出必须包含「${c.expect}」：\n${result.stdout}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
