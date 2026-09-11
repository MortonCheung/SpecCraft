/**
 * SpecCraft v0.9 §87 Commit 4 —— 单元测试。
 *
 * 覆盖：Owner Approval / digest binding / Deterministic Replanning /
 * Run Lineage / Active Change Freeze / Superseded Run。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { createRun } from '../src/core/execution/store.js';
import { loadProject } from '../src/core/project.js';
import { readState } from '../src/core/state/store.js';
import { createChange } from '../src/core/changes/create.js';
import { readChangeManifest, readChangeRejectionOrNull, rejectChange } from '../src/core/changes/store.js';
import { stageProposalArtifact, retainArtifact } from '../src/core/changes/proposal.js';
import { approveChange, approvalPath, readApprovalOrNull } from '../src/core/changes/approval.js';
import { analyzeChange, analysisAttemptDir, readAnalysisAttemptOrNull } from '../src/core/changes/analyze.js';
import {
  lineagePath,
  materializationPath,
  readChangeMaterializationOrNull,
  readRunLineageOrNull,
  readRunSupersessionOrNull,
  supersededPath,
} from '../src/core/changes/lineage.js';
import { replanChange } from '../src/core/changes/replan.js';
import { assertRunMutable } from '../src/core/changes/guards.js';
import { reopenTask } from '../src/core/tasks/rework.js';
import { compileTaskGraphFromManual } from '../src/core/tasks/compiler.js';
import { parseTaskGraph } from '../src/core/tasks/store.js';
import { writeTaskGraph } from '../src/core/tasks/store.js';
import { executorPlanPath } from '../src/core/executors/store.js';
import { ChangeError } from '../src/core/changes/types.js';

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-replan-'));
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

function graphBlock(tasks: Array<{ id: string; summary: string; dependsOn: string[] }>): string {
  const lines = ['version: 1', '', 'tasks:'];
  for (const t of tasks) {
    lines.push(`  - id: ${t.id}`);
    lines.push(`    title: Task ${t.id.toUpperCase()}`);
    lines.push(`    summary: ${t.summary}`);
    lines.push(`    depends_on: [${t.dependsOn.join(', ')}]`);
    lines.push(`    scope: { paths: [src/${t.id}/**] }`);
    lines.push('    verification: { commands: [npm test], timeout_seconds: 60 }');
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

interface Fixture {
  speccraftDir: string;
  workflow: Awaited<ReturnType<typeof loadProject>>['workflow'];
  changeId: string;
}

/** 构造一个 baseline Run + 完整变更，但停在 analyze 之前 */
async function setupChange(root: string, reason = '调整任务图'): Promise<Fixture> {
  const speccraftDir = path.join(root, '.speccraft');
  await createRun(speccraftDir, { id: 'run-1' });
  const { workflow } = await loadProject(root);

  for (const stage of AFFECTED) {
    const artifact = workflow.stages.find((s) => s.id === stage)!.produces[0]!;
    const body = stage === 'execution-manual' ? manualBody(BASE_BLOCK) : `# ${artifact}\n`;
    await seedArtifact(speccraftDir, stage, artifact, body);
  }
  await writeTaskGraph(
    speccraftDir,
    'run-1',
    compileTaskGraphFromManual({
      manualBody: manualBody(BASE_BLOCK),
      runId: 'run-1',
      source: 'execution-manual',
    }),
  );

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
    source: `---\nartifact: requirements\nstage: requirement\nstatus: completed\nversion: 2\n---\n\n# Requirements v2\n`,
    workflow,
  });
  await stageProposalArtifact({
    speccraftDir,
    changeId: manifest.id,
    stageId: 'execution-manual',
    source: `---\nartifact: execution-manual\nstage: execution-manual\nstatus: completed\nversion: 2\n---\n\n${manualBody(NEXT_BLOCK)}`,
    workflow,
  });
  for (const stage of ['concept', 'research', 'design', 'build-brief', 'site-survey']) {
    await retainArtifact({ speccraftDir, changeId: manifest.id, stageId: stage, workflow });
  }

  return { speccraftDir, workflow, changeId: manifest.id };
}

/** 构造一个已经 approved 的 Change */
async function setupApproved(root: string): Promise<Fixture & { attempt: string }> {
  const fixture = await setupChange(root);
  const analysis = await analyzeChange({
    speccraftDir: fixture.speccraftDir,
    changeId: fixture.changeId,
    workflow: fixture.workflow,
  });
  assert.equal(analysis.result, 'complete');
  await approveChange({
    speccraftDir: fixture.speccraftDir,
    changeId: fixture.changeId,
    approvedBy: 'owner',
  });
  return { ...fixture, attempt: analysis.attempt };
}

// ---------------------------------------------------------------------------
// §31–§34 Owner Approval
// ---------------------------------------------------------------------------

test('v0.9 §32：approve 绑定 latest complete Analysis 的 digest，且不可重复批准', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, attempt } = await setupApproved(root);

    const attemptRecord = await readAnalysisAttemptOrNull(speccraftDir, changeId, attempt);
    assert.ok(attemptRecord);
    const approval = await readApprovalOrNull(speccraftDir, changeId);
    assert.ok(approval, 'approval.yaml 应存在');
    assert.ok(await exists(approvalPath(speccraftDir, changeId)));

    assert.equal(approval.change_id, changeId);
    assert.equal(approval.analysis_attempt, attempt);
    assert.equal(approval.approved_by, 'owner');
    // §12/§32：digest binding
    assert.equal(approval.analysis_bundle_sha256, attemptRecord.analysis_bundle_sha256);
    assert.equal(approval.impact_sha256, attemptRecord.impact_sha256);
    assert.equal(approval.candidate_task_graph_digest, attemptRecord.candidate.task_graph_digest);
    assert.equal(approval.candidate_executor_plan_digest, attemptRecord.candidate.executor_plan_digest);
    assert.equal(approval.candidate_review_plan_digest, attemptRecord.candidate.review_plan_digest);

    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'approved');

    // 重复批准 → change_already_approved
    await assertChangeError('change_already_approved', () =>
      approveChange({ speccraftDir, changeId, approvedBy: 'owner' }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §34：approved Change 禁止 stage / retain 修改', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, workflow } = await setupApproved(root);

    await assertChangeError('change_already_approved', () =>
      stageProposalArtifact({
        speccraftDir,
        changeId,
        stageId: 'requirement',
        source: `---\nartifact: requirements\nstage: requirement\nstatus: completed\nversion: 3\n---\n\n# v3\n`,
        workflow,
      }),
    );
    await assertChangeError('change_already_approved', () =>
      retainArtifact({ speccraftDir, changeId, stageId: 'design', workflow }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §33：Analysis 之后 Proposal 被修改 → proposal_changed_since_analysis', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, workflow } = await setupChange(root);
    await analyzeChange({ speccraftDir, changeId, workflow });

    // Analysis 之后重新 stage（文件名相同，内容不同）
    await stageProposalArtifact({
      speccraftDir,
      changeId,
      stageId: 'requirement',
      source: `---\nartifact: requirements\nstage: requirement\nstatus: completed\nversion: 9\n---\n\n# Requirements v9\n`,
      workflow,
    });

    await assertChangeError('proposal_changed_since_analysis', () =>
      approveChange({ speccraftDir, changeId, approvedBy: 'owner' }),
    );
    // 仍然是 analyzed（approval 未写入）
    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'analyzed');
    assert.equal(await readApprovalOrNull(speccraftDir, changeId), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §31：no_effect 的 Change 不可进入 approval', async () => {
  const root = await newProject();
  try {
    const speccraftDir = path.join(root, '.speccraft');
    await createRun(speccraftDir, { id: 'run-1' });
    const { workflow } = await loadProject(root);

    let requirementSource = '';
    for (const stage of AFFECTED) {
      const artifact = workflow.stages.find((s) => s.id === stage)!.produces[0]!;
      const source = await seedArtifact(speccraftDir, stage, artifact, `# ${artifact}\n`);
      if (stage === 'requirement') requirementSource = source;
    }

    const manifest = await createChange({
      speccraftDir,
      projectRoot: root,
      workflow,
      baseRunId: 'run-1',
      reason: '无实际变化',
    });
    await stageProposalArtifact({
      speccraftDir,
      changeId: manifest.id,
      stageId: 'requirement',
      source: requirementSource,
      workflow,
    });
    for (const stage of ['concept', 'research', 'design', 'build-brief', 'site-survey', 'execution-manual']) {
      await retainArtifact({ speccraftDir, changeId: manifest.id, stageId: stage, workflow });
    }
    await analyzeChange({ speccraftDir, changeId: manifest.id, workflow });

    await assertChangeError('no_effect', () =>
      approveChange({ speccraftDir, changeId: manifest.id, approvedBy: 'owner' }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §32：没有 complete Analysis 时 approve → no_complete_analysis', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId } = await setupChange(root);
    await assertChangeError('no_complete_analysis', () =>
      approveChange({ speccraftDir, changeId, approvedBy: 'owner' }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §14 Reject Change
// ---------------------------------------------------------------------------

test('v0.9 §14：draft / analyzed 可 reject，approved 不可', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId } = await setupChange(root);

    const rejected = await rejectChange({ speccraftDir, changeId, reason: 'Owner 放弃该变更' });
    assert.equal(rejected.status, 'rejected');
    const rejection = await readChangeRejectionOrNull(speccraftDir, changeId);
    assert.ok(rejection);
    assert.equal(rejection.change_id, changeId);
    assert.equal(rejection.reason, 'Owner 放弃该变更');

    // 已 rejected → 再 reject → change_rejected
    await assertChangeError('change_rejected', () =>
      rejectChange({ speccraftDir, changeId, reason: 'again' }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §14：approved 的 Change 不可 reject（invalid_change_transition）', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId } = await setupApproved(root);
    await assertChangeError('invalid_change_transition', () =>
      rejectChange({ speccraftDir, changeId, reason: 'too late' }),
    );
    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'approved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §14：reject 必须提供非空 reason', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId } = await setupChange(root);
    await assert.rejects(
      () => rejectChange({ speccraftDir, changeId, reason: '   ' }),
      /changes reject 需要 --reason/,
    );
    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'draft');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §13 Active Change Freeze
// ---------------------------------------------------------------------------

test('v0.9 §13：active Change 阻止 Run mutation，三种 active 状态均冻结', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, workflow } = await setupChange(root);

    // draft → 冻结
    await assertChangeError('run_change_pending', () => assertRunMutable(speccraftDir, 'run-1'));

    // analyzed → 冻结
    await analyzeChange({ speccraftDir, changeId, workflow });
    await assertChangeError('run_change_pending', () => assertRunMutable(speccraftDir, 'run-1'));

    // approved → 冻结
    await approveChange({ speccraftDir, changeId, approvedBy: 'owner' });
    await assertChangeError('run_change_pending', () => assertRunMutable(speccraftDir, 'run-1'));

    // 其他 Run 不受该 Change 影响（freeze 绑定 base Run）
    await assertRunMutable(speccraftDir, 'run-other');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §13：真实 mutation 入口（task reopen）在冻结时抛 run_change_pending', async () => {
  const root = await newProject();
  try {
    const speccraftDir = path.join(root, '.speccraft');
    await createRun(speccraftDir, { id: 'run-1' });
    const { workflow } = await loadProject(root);

    await createChange({
      speccraftDir,
      projectRoot: root,
      workflow,
      baseRunId: 'run-1',
      reason: '冻结测试',
    });

    // 守卫必须在「Task 不存在」等业务校验之前失败
    await assertChangeError('run_change_pending', () =>
      reopenTask({ speccraftDir, runId: 'run-1', taskId: 'no-such-task', cascade: false }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §13：reject 之后 Run 恢复可 mutation', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, workflow } = await setupChange(root);
    await assertChangeError('run_change_pending', () => assertRunMutable(speccraftDir, 'run-1'));

    await rejectChange({ speccraftDir, changeId, reason: '放弃该变更' });
    await assertRunMutable(speccraftDir, 'run-1');

    // rejected 的 Change 不再冻结，且不进入 approval
    await assertChangeError('change_rejected', () =>
      approveChange({ speccraftDir, changeId, approvedBy: 'owner' }),
    );
    void workflow;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §35–§40 Deterministic Replanning
// ---------------------------------------------------------------------------

test('v0.9 §35：只有 approved 可以 replan', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, workflow } = await setupChange(root);

    await assertChangeError('change_not_approved', () =>
      replanChange({ speccraftDir, projectRoot: root, changeId, workflow }),
    );

    await rejectChange({ speccraftDir, changeId, reason: '放弃' });
    await assertChangeError('change_rejected', () =>
      replanChange({ speccraftDir, projectRoot: root, changeId, workflow }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §35–§39：replan 创建 Successor Run、写 lineage/materialization、supersede predecessor', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, workflow, attempt } = await setupApproved(root);
    const approval = await readApprovalOrNull(speccraftDir, changeId);
    assert.ok(approval);

    const result = await replanChange({ speccraftDir, projectRoot: root, changeId, workflow });

    assert.equal(result.changeId, changeId);
    assert.equal(result.predecessorRun, 'run-1');
    assert.match(result.successorRun, /^run-/);
    assert.notEqual(result.successorRun, 'run-1');
    assert.equal(result.attempt, attempt);

    // §36：重新编译的 digest 必须与 approved Candidate 完全一致
    assert.equal(result.taskGraphDigest, approval.candidate_task_graph_digest);
    assert.equal(result.executorPlanDigest, approval.candidate_executor_plan_digest);
    assert.equal(result.reviewPlanDigest, approval.candidate_review_plan_digest);

    // §7：change → materialized
    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'materialized');

    // §38：lineage 与 materialization 互相一致
    const lineage = await readRunLineageOrNull(speccraftDir, result.successorRun);
    assert.ok(lineage, 'successor lineage.yaml 应存在');
    assert.equal(lineage.predecessor_run, 'run-1');
    assert.equal(lineage.change_id, changeId);
    assert.equal(lineage.approved_analysis_attempt, attempt);

    const materialization = await readChangeMaterializationOrNull(speccraftDir, changeId);
    assert.ok(materialization, 'materialization.yaml 应存在');
    assert.equal(materialization.successor_run, result.successorRun);
    assert.equal(materialization.change_id, changeId);
    assert.equal(materialization.approved_analysis_attempt, attempt);

    // §39：predecessor 被 supersede（且不改写旧 Run 既有 evidence）
    const supersession = await readRunSupersessionOrNull(speccraftDir, 'run-1');
    assert.ok(supersession, 'predecessor superseded.yaml 应存在');
    assert.equal(supersession.change_id, changeId);
    assert.equal(supersession.successor_run, result.successorRun);

    // §37：Successor 拥有自己的 frozen Evidence，不共享 predecessor
    const successorGraph = parseTaskGraph(
      await readFile(path.join(speccraftDir, 'runs', result.successorRun, 'tasks', 'graph.yaml'), 'utf8'),
    );
    assert.equal(successorGraph.runId, result.successorRun);
    assert.ok(successorGraph.tasks.some((t) => t.id === 'd'));
    assert.ok(!successorGraph.tasks.some((t) => t.id === 'c'));
    assert.ok(
      await exists(executorPlanPath(speccraftDir, result.successorRun)),
      'successor 应拥有自己的 Executor Plan',
    );
    assert.ok(await exists(path.join(speccraftDir, 'runs', result.successorRun, 'agent-prompt.md')));

    // predecessor 自己的 graph 不被改写
    const predecessorGraph = parseTaskGraph(
      await readFile(path.join(speccraftDir, 'runs', 'run-1', 'tasks', 'graph.yaml'), 'utf8'),
    );
    assert.equal(predecessorGraph.runId, 'run-1');

    // §42：只切换执行目标，不自动施工
    const stateAfter = await readState(speccraftDir);
    assert.equal(stateAfter.active_run, result.successorRun);

    // 成功后再 replan → change_not_approved（materialized）
    await assertChangeError('change_not_approved', () =>
      replanChange({ speccraftDir, projectRoot: root, changeId, workflow }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §41：Successor 可 mutation，predecessor 永久不可 mutation', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, workflow } = await setupApproved(root);
    const result = await replanChange({ speccraftDir, projectRoot: root, changeId, workflow });

    await assertChangeError('run_superseded', () => assertRunMutable(speccraftDir, 'run-1'));
    await assertRunMutable(speccraftDir, result.successorRun);

    // superseded 是永久终态：即使 Change 已 materialized 也先报 run_superseded
    assert.ok(await exists(supersededPath(speccraftDir, 'run-1')));
    assert.ok(await exists(lineagePath(speccraftDir, result.successorRun)));
    assert.ok(await exists(materializationPath(speccraftDir, changeId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §36：approved snapshot 被篡改 → non_deterministic_recompile，且 Change 保持 approved', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, workflow, attempt } = await setupApproved(root);

    // tamper：改写 approved resolved snapshot
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

    // §40：Change 保持 approved，predecessor 未被 supersede，可修复后重试
    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'approved');
    assert.equal(await readRunSupersessionOrNull(speccraftDir, 'run-1'), null);
    assert.equal(await readChangeMaterializationOrNull(speccraftDir, changeId), null);

    // 修复环境后重新 replan 成功
    await writeFile(resolvedRequirement, original, 'utf8');
    const result = await replanChange({ speccraftDir, projectRoot: root, changeId, workflow });
    assert.match(result.successorRun, /^run-/);
    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'materialized');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
