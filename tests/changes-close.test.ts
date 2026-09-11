/**
 * SpecCraft v0.9 §87 Commit 5 —— 单元测试。
 *
 * 覆盖：
 *   §46–§50 Canonical Artifact Promotion / Close
 *     - Acceptance Requirement（Successor 必须 Owner Accepted）
 *     - Canonical Drift Guard（fail-before-mutation，禁止覆盖未知修改）
 *     - 幂等 / 可中断 close（skip 已完成文件，替换剩余 baseline）
 *   §51 Handoff Gate（unclosed Change 阻止 handoff）
 *   §52 Handoff Change History（确定性 change-history.md + file_hashes）
 *   §58 Change Consistency（validate tampering → FAIL）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { initProject } from '../src/core/init.js';
import { createRun, readRun, updateRunStatus } from '../src/core/execution/store.js';
import { loadProject } from '../src/core/project.js';
import { readState, writeState } from '../src/core/state/store.js';
import { createChange } from '../src/core/changes/create.js';
import { changeDir, readChangeManifest, rejectChange } from '../src/core/changes/store.js';
import { stageProposalArtifact, retainArtifact } from '../src/core/changes/proposal.js';
import { approveChange } from '../src/core/changes/approval.js';
import { analysisAttemptDir, analyzeChange } from '../src/core/changes/analyze.js';
import { replanChange } from '../src/core/changes/replan.js';
import {
  readRunLineageOrNull,
  writeRunLineage,
  writeRunSupersession,
} from '../src/core/changes/lineage.js';
import { closeChange, closePath, parseChangeClose } from '../src/core/changes/close.js';
import { checkChangeConsistency } from '../src/core/changes/consistency.js';
import { readTaskGraphOrNull, writeTaskGraph } from '../src/core/tasks/store.js';
import { canHandoff } from '../src/core/handoff/lifecycle.js';
import { compileChangeHistory } from '../src/core/handoff/compiler.js';
import { compileHandoffPackage, handoffDir } from '../src/core/handoff/package.js';
import { writeAcceptanceRecord } from '../src/core/acceptance/store.js';
import { sha256Bytes } from '../src/core/changes/digest.js';
import { ChangeError } from '../src/core/changes/types.js';
import { cmdChangesClose, cmdChangesReplan, cmdNext, cmdStatus } from '../src/cli/commands.js';

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

/** 生成一个把指定 env 追加写入 E2E_HOOK_OBS 并返回 exitCode 的 hook 命令 */
function makeHookCommand(keys: string[], exitCode: number): string {
  const script =
    `const fs=require('fs');const k=[${keys.map((k) => `'${k}'`).join(',')}];` +
    `fs.appendFileSync(process.env.E2E_HOOK_OBS,k.map(x=>x+'='+(process.env[x]||'')).join(String.fromCharCode(10))+String.fromCharCode(10));` +
    `process.exit(${exitCode})`;
  return `node -e "${script.replace(/"/g, '\\"')}"`;
}

/** 写入带 hooks 的 project.yaml */
async function writeProjectHooks(
  speccraftDir: string,
  hooks: Record<string, Array<{ id: string; command: string }>>,
): Promise<void> {
  await writeFile(
    path.join(speccraftDir, 'project.yaml'),
    yaml.dump({ name: 'close-test', hooks }, { indent: 2, lineWidth: -1, noRefs: true }),
    'utf8',
  );
}

function parseObs(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (!line.includes('=')) continue;
    const idx = line.indexOf('=');
    map.set(line.slice(0, idx), line.slice(idx + 1));
  }
  return map;
}

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-close-'));
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

const REQUIREMENT_V2 = `---\nartifact: requirements\nstage: requirement\nstatus: completed\nversion: 2\n---\n\n# Requirements v2\n`;
const MANUAL_V2 = `---\nartifact: execution-manual\nstage: execution-manual\nstatus: completed\nversion: 2\n---\n\n${manualBody(NEXT_BLOCK)}`;

interface Fixture {
  speccraftDir: string;
  workflow: Awaited<ReturnType<typeof loadProject>>['workflow'];
  changeId: string;
}

/** 构造 baseline Run + 完整变更，停在 analyze 之前 */
async function setupChange(root: string): Promise<Fixture> {
  const speccraftDir = path.join(root, '.speccraft');
  await createRun(speccraftDir, { id: 'run-1' });
  const { workflow } = await loadProject(root);

  for (const stage of AFFECTED) {
    const artifact = workflow.stages.find((s) => s.id === stage)!.produces[0]!;
    const body = stage === 'execution-manual' ? manualBody(BASE_BLOCK) : `# ${artifact}\n`;
    await seedArtifact(speccraftDir, stage, artifact, body);
  }

  const manifest = await createChange({
    speccraftDir,
    projectRoot: root,
    workflow,
    baseRunId: 'run-1',
    reason: '调整任务图',
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
  for (const stage of ['concept', 'research', 'design', 'build-brief', 'site-survey']) {
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
  assert.equal(analysis.result, 'complete');
  await approveChange({
    speccraftDir: fixture.speccraftDir,
    changeId: fixture.changeId,
    approvedBy: 'owner',
  });
  return { ...fixture, attempt: analysis.attempt };
}

/** 构造 materialized Change（已生成 Successor Run，但尚未 Owner Accept） */
async function setupMaterialized(
  root: string,
): Promise<Fixture & { attempt: string; successorRun: string }> {
  const approved = await setupApproved(root);
  const result = await replanChange({
    speccraftDir: approved.speccraftDir,
    projectRoot: root,
    changeId: approved.changeId,
    workflow: approved.workflow,
  });
  return { ...approved, successorRun: result.successorRun };
}

/** 把 Successor Run 置为 accepted */
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

const REQUIREMENT_REL = 'artifacts/requirements.md';
const MANUAL_REL = 'artifacts/execution-manual.md';

// ---------------------------------------------------------------------------
// §47 / §78 Close Preconditions —— Acceptance Requirement
// ---------------------------------------------------------------------------

test('v0.9 §47/§78：Successor 未 Owner Accepted 时 close 必须失败', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId } = await setupMaterialized(root);

    await assertChangeError('successor_not_accepted', () =>
      closeChange({ speccraftDir, changeId }),
    );

    // 状态与 canonical 均未改变（fail-before-mutation）
    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'materialized');
    assert.equal(await exists(closePath(speccraftDir, changeId)), false);
    const canonical = await readFile(path.join(speccraftDir, REQUIREMENT_REL), 'utf8');
    assert.doesNotMatch(canonical, /Requirements v2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §47：只有 materialized 的 Change 可以 close', async () => {
  const root = await newProject();
  try {
    // approved（未 replan）→ change_not_materialized
    const approved = await setupApproved(root);
    await assertChangeError('change_not_materialized', () =>
      closeChange({ speccraftDir: approved.speccraftDir, changeId: approved.changeId }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §47：rejected 的 Change 不可 close', async () => {
  const root = await newProject();
  try {
    const rejected = await setupChange(root);
    await rejectChange({ speccraftDir: rejected.speccraftDir, changeId: rejected.changeId, reason: '放弃' });
    await assertChangeError('change_rejected', () =>
      closeChange({ speccraftDir: rejected.speccraftDir, changeId: rejected.changeId }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §46 / §50 Canonical Promotion
// ---------------------------------------------------------------------------

test('v0.9 §46/§50：Accepted 后 close 把 approved version 提升为 canonical', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, attempt, successorRun } = await setupMaterialized(root);
    await acceptSuccessor(speccraftDir, successorRun);

    const result = await closeChange({
      speccraftDir,
      changeId,
      now: new Date('2026-09-12T00:00:00.000Z'),
    });

    assert.equal(result.reused, false);
    assert.equal(result.successorRun, successorRun);
    assert.deepEqual(result.promotedFiles.sort(), [MANUAL_REL, REQUIREMENT_REL].sort());
    assert.deepEqual(result.skippedFiles, []);

    // §50 Change 状态 closed
    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'closed');

    // canonical artifacts == approved target
    const reqBytes = await approvedBytes(speccraftDir, changeId, attempt, 'requirement');
    const manualBytes = await approvedBytes(speccraftDir, changeId, attempt, 'execution-manual');
    assert.deepEqual(await readFile(path.join(speccraftDir, REQUIREMENT_REL)), reqBytes);
    assert.deepEqual(await readFile(path.join(speccraftDir, MANUAL_REL)), manualBytes);

    // close.yaml 结构（§50）
    assert.equal(await exists(closePath(speccraftDir, changeId)), true);
    const close = parseChangeClose(await readFile(closePath(speccraftDir, changeId), 'utf8'));
    assert.equal(close.change_id, changeId);
    assert.equal(close.successor_run, successorRun);
    assert.equal(close.approved_analysis_attempt, attempt);
    assert.equal(close.closed_at, '2026-09-12T00:00:00.000Z');
    assert.deepEqual(close.promoted_files, [MANUAL_REL, REQUIREMENT_REL]);
    assert.equal(close.after_hashes[REQUIREMENT_REL], sha256Bytes(reqBytes));
    assert.equal(close.after_hashes[MANUAL_REL], sha256Bytes(manualBytes));
    assert.equal(
      close.before_hashes[REQUIREMENT_REL],
      (await readChangeManifest(speccraftDir, changeId)).artifacts.find((a) => a.stage === 'requirement')!.sha256,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §48 / §79 Canonical Drift Guard
// ---------------------------------------------------------------------------

test('v0.9 §48/§79：canonical 被未知修改时 close 必须 canonical_drift 且不覆盖', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, successorRun } = await setupMaterialized(root);
    await acceptSuccessor(speccraftDir, successorRun);

    // 人为制造第三种 hash（既不等于 baseline 也不等于 approved target）
    const canonicalFile = path.join(speccraftDir, REQUIREMENT_REL);
    const drifted = '# Requirements v2\n\n人工偷偷改了一行\n';
    await writeFile(canonicalFile, drifted, 'utf8');

    await assertChangeError('canonical_drift', () => closeChange({ speccraftDir, changeId }));

    // 未知修改不得被覆盖
    assert.equal(await readFile(canonicalFile, 'utf8'), drifted);
    // fail-before-mutation：另一目标文件也保持 baseline
    const manual = await readFile(path.join(speccraftDir, MANUAL_REL), 'utf8');
    assert.doesNotMatch(manual, /Do D/);
    // Change 保持 materialized，可修复后重试
    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'materialized');
    assert.equal(await exists(closePath(speccraftDir, changeId)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §49 / §80 Idempotent / Interrupted Close
// ---------------------------------------------------------------------------

test('v0.9 §49/§80：部分 target 已完成时 close 跳过已完成文件并完成剩余替换', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, attempt, successorRun } = await setupMaterialized(root);
    await acceptSuccessor(speccraftDir, successorRun);

    // 模拟上一次中断：requirement 已是 approved target，execution-manual 仍是 baseline
    const reqBytes = await approvedBytes(speccraftDir, changeId, attempt, 'requirement');
    await writeFile(path.join(speccraftDir, REQUIREMENT_REL), reqBytes);

    const result = await closeChange({ speccraftDir, changeId });

    assert.equal(result.reused, false);
    assert.deepEqual(result.skippedFiles, [REQUIREMENT_REL]);
    assert.deepEqual(result.promotedFiles, [MANUAL_REL]);

    // 最终 hashes 正确
    const close = parseChangeClose(await readFile(closePath(speccraftDir, changeId), 'utf8'));
    for (const rel of close.promoted_files) {
      const bytes = await readFile(path.join(speccraftDir, rel));
      assert.equal(sha256Bytes(bytes), close.after_hashes[rel], `${rel} after hash 应正确`);
    }
    const manualBytes = await approvedBytes(speccraftDir, changeId, attempt, 'execution-manual');
    assert.deepEqual(await readFile(path.join(speccraftDir, MANUAL_REL)), manualBytes);

    // 已 closed 后再 close → 幂等复用，不重复覆盖
    const again = await closeChange({ speccraftDir, changeId });
    assert.equal(again.reused, true);
    assert.deepEqual(again.promotedFiles, []);
    assert.deepEqual(again.skippedFiles.sort(), close.promoted_files.slice().sort());
    assert.equal(again.close.closed_at, close.closed_at);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §51 Handoff Gate
// ---------------------------------------------------------------------------

test('v0.9 §51：未 close 的 Change 阻止 Successor handoff，close 后放行', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, successorRun } = await setupMaterialized(root);
    await acceptSuccessor(speccraftDir, successorRun);

    // 写入 accepted 的 Owner Acceptance 记录（Verification/Review 不是 Owner Acceptance）
    const record = [
      '---',
      'kind: owner-acceptance',
      `run_id: ${successorRun}`,
      'attempt: 1',
      'decision: accepted',
      'owner: owner',
      'created_at: 2026-09-12T00:00:00.000Z',
      'verification_attempt: 1',
      'verification_status: pass',
      '---',
      '',
      '# Owner Acceptance',
      '',
      '## Decision',
      '',
      'ACCEPTED',
      '',
      '## Feedback',
      '',
      '（无）',
      '',
    ].join('\n');
    await writeAcceptanceRecord(speccraftDir, successorRun, 1, record);

    const state = await readState(speccraftDir);
    state.stages['verification']!.status = 'completed';
    state.stages['owner-acceptance']!.status = 'completed';
    const run = await readRun(speccraftDir, successorRun);

    const blocked = await canHandoff(speccraftDir, state, run);
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason ?? '', /unclosed change/);
    assert.match(blocked.reason ?? '', new RegExp(changeId));

    await closeChange({ speccraftDir, changeId });

    const allowed = await canHandoff(speccraftDir, state, run);
    assert.equal(allowed.ok, true, allowed.reason);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §52 Handoff Change History
// ---------------------------------------------------------------------------

test('v0.9 §52：Successor Handoff 生成确定性 change-history.md 与 file_hashes', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, workflow, changeId, successorRun } = await setupMaterialized(root);
    await acceptSuccessor(speccraftDir, successorRun);
    await closeChange({ speccraftDir, changeId });

    // compileChangeHistory：非 Change Run 返回 null，Successor 返回确定性文本
    assert.equal(await compileChangeHistory(speccraftDir, 'run-1'), null);
    const history = await compileChangeHistory(speccraftDir, successorRun);
    assert.ok(history !== null);
    assert.match(history!, new RegExp(`- Change ID: ${changeId}`));
    assert.match(history!, /- Predecessor Run: run-1/);
    assert.match(history!, new RegExp(`- Successor Run: ${successorRun}`));
    assert.match(history!, /- Reason: 调整任务图/);
    assert.match(history!, /## Changed Artifacts/);
    assert.match(history!, /## Retained Artifacts/);

    const run = await readRun(speccraftDir, successorRun);
    const written = await compileHandoffPackage({
      speccraftDir,
      projectRoot: root,
      projectName: 'close-test',
      workflow,
      run,
      handoffId: 'handoff-001',
      createdAt: '2026-09-12T00:00:00.000Z',
    });
    assert.ok(written.includes('change-history.md'), '应生成 change-history.md');

    const dir = handoffDir(speccraftDir, 'handoff-001');
    const manifestText = await readFile(path.join(dir, 'manifest.yaml'), 'utf8');
    const manifest = yaml.load(manifestText) as {
      files: string[];
      file_hashes: Record<string, string>;
    };
    assert.ok(manifest.files.includes('change-history.md'));

    // file_hashes 覆盖 Package 内文件，且不含 manifest.yaml 自身
    const historyText = await readFile(path.join(dir, 'change-history.md'), 'utf8');
    assert.equal(manifest.file_hashes['change-history.md'], sha256Bytes(historyText));
    assert.equal(manifest.file_hashes['HANDOFF.md'], sha256Bytes(await readFile(path.join(dir, 'HANDOFF.md'), 'utf8')));
    assert.equal(manifest.file_hashes['manifest.yaml'], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §58 / §84 Validate Tampering
// ---------------------------------------------------------------------------

test('v0.9 §58/§84：Change evidence 一致时 validate 无违规', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, successorRun } = await setupMaterialized(root);
    await acceptSuccessor(speccraftDir, successorRun);
    await closeChange({ speccraftDir, changeId });

    const state = await readState(speccraftDir);
    assert.deepEqual(await checkChangeConsistency(speccraftDir, state), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §58/§84：tamper close hash / successor lineage / superseded link 时 validate FAIL', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, successorRun } = await setupMaterialized(root);
    await acceptSuccessor(speccraftDir, successorRun);
    await closeChange({ speccraftDir, changeId });

    const state = await readState(speccraftDir);
    assert.deepEqual(await checkChangeConsistency(speccraftDir, state), []);

    // (1) tamper canonical artifact → close target hash 不一致
    await writeFile(path.join(speccraftDir, REQUIREMENT_REL), '# tampered\n', 'utf8');
    const afterCanonical = await checkChangeConsistency(speccraftDir, state);
    assert.ok(
      afterCanonical.some((v) => /close target hash 不一致/.test(v)),
      `期望 close target hash 违规，实际：${afterCanonical.join(' | ')}`,
    );

    // (2) tamper successor lineage → lineage 不一致
    const lineage = await readRunLineageOrNull(speccraftDir, successorRun);
    assert.ok(lineage);
    await writeRunLineage(speccraftDir, successorRun, { ...lineage!, change_id: 'change-999' });
    const afterLineage = await checkChangeConsistency(speccraftDir, state);
    assert.ok(
      afterLineage.some((v) => /lineage 不一致/.test(v)),
      `期望 lineage 违规，实际：${afterLineage.join(' | ')}`,
    );

    // (3) tamper superseded link → predecessor supersession 不一致
    await writeRunLineage(speccraftDir, successorRun, lineage!);
    await writeRunSupersession(speccraftDir, 'run-1', {
      change_id: 'change-999',
      successor_run: successorRun,
      superseded_at: '2026-09-12T00:00:00.000Z',
    });
    const afterSuperseded = await checkChangeConsistency(speccraftDir, state);
    assert.ok(
      afterSuperseded.some((v) => /superseded evidence 与 materialization 不一致/.test(v)),
      `期望 superseded 违规，实际：${afterSuperseded.join(' | ')}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §58/§84：tamper analysis bundle / candidate task plan 时 validate FAIL', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, attempt, successorRun } = await setupMaterialized(root);
    await acceptSuccessor(speccraftDir, successorRun);

    const state = await readState(speccraftDir);
    assert.deepEqual(await checkChangeConsistency(speccraftDir, state), []);

    // (1) tamper candidate task plan（Successor frozen Task Graph）
    const graph = await readTaskGraphOrNull(speccraftDir, successorRun);
    assert.ok(graph);
    await writeTaskGraph(speccraftDir, successorRun, {
      ...graph!,
      tasks: graph!.tasks.map((t) => ({ ...t, summary: `${t.summary}（被篡改）` })),
    });
    const afterPlan = await checkChangeConsistency(speccraftDir, state);
    assert.ok(
      afterPlan.some((v) => /Successor task graph digest 与 approved Candidate 不一致/.test(v)),
      `期望 candidate task plan 违规，实际：${afterPlan.join(' | ')}`,
    );

    // (2) tamper approved Analysis bundle（resolved snapshot 内容）
    const resolved = path.join(
      analysisAttemptDir(speccraftDir, changeId, attempt),
      'resolved',
      'artifacts',
      'requirement.md',
    );
    await writeFile(resolved, '# tampered resolved\n', 'utf8');
    const violations = await checkChangeConsistency(speccraftDir, state);
    assert.ok(
      violations.some((v) => /Analysis bundle digest 不一致/.test(v)),
      `期望 analysis bundle 违规，实际：${violations.join(' | ')}`,
    );
    // 状态未改变
    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'materialized');
    assert.ok(await exists(changeDir(speccraftDir, changeId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §53 CLI `changes close` + §59 Hooks
// ---------------------------------------------------------------------------

test('v0.9 §53/§59：CLI changes close 输出契约 + before/after_change_close hook env', async () => {
  const root = await newProject();
  const obsFile = path.join(os.tmpdir(), `change-close-hook-${Date.now()}.txt`);
  process.env.E2E_HOOK_OBS = obsFile;
  const keys = [
    'SPECCRAFT_EVENT',
    'SPECCRAFT_CHANGE_ID',
    'SPECCRAFT_CHANGE_BASE_RUN',
    'SPECCRAFT_CHANGE_SUCCESSOR_RUN',
  ];
  try {
    const { speccraftDir, changeId, successorRun } = await setupMaterialized(root);
    await acceptSuccessor(speccraftDir, successorRun);
    await writeProjectHooks(speccraftDir, {
      before_change_close: [{ id: 'obs-before', command: makeHookCommand(keys, 0) }],
      after_change_close: [{ id: 'obs-after', command: makeHookCommand(keys, 0) }],
    });

    const out = await captureStdout(async () => {
      const code = await cmdChangesClose(changeId, root);
      assert.equal(code, 0);
    });

    assert.match(out, new RegExp(`Change 已 close：${changeId}`));
    assert.match(out, new RegExp(`successor run: ${successorRun}`));
    assert.match(out, /promoted files: artifacts\/execution-manual\.md, artifacts\/requirements\.md/);
    assert.match(out, /canonical artifacts 已提升为 approved 版本/);
    assert.match(out, /下一步：speccraft handoff/);

    // hook env 契约：before + after 都被真实调用
    const obs = await readFile(obsFile, 'utf8');
    assert.match(obs, /SPECCRAFT_EVENT=before_change_close/);
    assert.match(obs, /SPECCRAFT_EVENT=after_change_close/);
    const events = obs.split('\n').filter((l) => l.startsWith('SPECCRAFT_EVENT='));
    assert.equal(events.length, 2);
    for (const expected of [
      `SPECCRAFT_CHANGE_ID=${changeId}`,
      'SPECCRAFT_CHANGE_BASE_RUN=run-1',
      `SPECCRAFT_CHANGE_SUCCESSOR_RUN=${successorRun}`,
    ]) {
      assert.ok(obs.includes(expected), `hook env 应包含 ${expected}`);
    }

    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'closed');
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.E2E_HOOK_OBS;
    try {
      await rm(obsFile);
    } catch {
      /* 忽略 */
    }
  }
});

test('v0.9 §59：before_change_close hook 失败 → blocking，close 不执行', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, successorRun } = await setupMaterialized(root);
    await acceptSuccessor(speccraftDir, successorRun);
    await writeProjectHooks(speccraftDir, {
      before_change_close: [{ id: 'fail', command: makeHookCommand(['SPECCRAFT_EVENT'], 1) }],
    });

    const code = await cmdChangesClose(changeId, root);
    assert.equal(code, 1);
    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'materialized');
    assert.equal(await exists(closePath(speccraftDir, changeId)), false);
    const canonical = await readFile(path.join(speccraftDir, REQUIREMENT_REL), 'utf8');
    assert.doesNotMatch(canonical, /Requirements v2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §59：after_change_close hook 失败 → warning only，close 仍成功不回滚', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, successorRun } = await setupMaterialized(root);
    await acceptSuccessor(speccraftDir, successorRun);
    await writeProjectHooks(speccraftDir, {
      after_change_close: [{ id: 'fail', command: makeHookCommand(['SPECCRAFT_EVENT'], 1) }],
    });

    const code = await cmdChangesClose(changeId, root);
    assert.equal(code, 0);
    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'closed');
    assert.ok(await exists(closePath(speccraftDir, changeId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §59：before_change_replan hook env 契约（CLI replan）', async () => {
  const root = await newProject();
  const obsFile = path.join(os.tmpdir(), `change-replan-hook-${Date.now()}.txt`);
  process.env.E2E_HOOK_OBS = obsFile;
  const keys = ['SPECCRAFT_EVENT', 'SPECCRAFT_CHANGE_ID', 'SPECCRAFT_CHANGE_BASE_RUN'];
  try {
    const { speccraftDir, changeId } = await setupApproved(root);
    await writeProjectHooks(speccraftDir, {
      before_change_replan: [{ id: 'obs', command: makeHookCommand(keys, 0) }],
    });

    const out = await captureStdout(async () => {
      const code = await cmdChangesReplan(changeId, root);
      assert.equal(code, 0);
    });
    assert.match(out, /Successor Run：run-/);
    assert.equal((await readChangeManifest(speccraftDir, changeId)).status, 'materialized');

    const envMap = parseObs(await readFile(obsFile, 'utf8'));
    assert.equal(envMap.get('SPECCRAFT_EVENT'), 'before_change_replan');
    assert.equal(envMap.get('SPECCRAFT_CHANGE_ID'), changeId);
    assert.equal(envMap.get('SPECCRAFT_CHANGE_BASE_RUN'), 'run-1');
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.E2E_HOOK_OBS;
    try {
      await rm(obsFile);
    } catch {
      /* 忽略 */
    }
  }
});

// ---------------------------------------------------------------------------
// §56 status / §57 next
// ---------------------------------------------------------------------------

test('v0.9 §56/§57：status 展示 Change 摘要，next 引导 close（accepted successor）', async () => {
  const root = await newProject();
  try {
    const { speccraftDir, changeId, successorRun } = await setupMaterialized(root);
    await acceptSuccessor(speccraftDir, successorRun);

    // §56 status：Unclosed Accepted Change + Superseded Run + Successor Run
    const statusOut = await captureStdout(() => cmdStatus(root));
    assert.match(statusOut, /Changes:/);
    assert.match(statusOut, /Unclosed Accepted Change: 1/);
    assert.match(statusOut, new RegExp(`${changeId} → speccraft changes close ${changeId}`));
    assert.match(statusOut, /Superseded Run: 1/);
    assert.match(statusOut, /run-1 → superseded by run-/);
    assert.match(statusOut, new RegExp(`Successor Run: 1`));

    // §57 next：Successor accepted 但 Change 未 closed → 必须先 close
    const state = await readState(speccraftDir);
    state.stages['ready-to-implement']!.status = 'completed';
    state.active_run = successorRun;
    await writeState(speccraftDir, state);

    const nextOut = await captureStdout(() => cmdNext(root));
    assert.match(nextOut, new RegExp(`Change ${changeId} 尚未 closed`));
    assert.match(nextOut, new RegExp(`speccraft changes close ${changeId}`));

    // close 之后 next 不再引导 close
    await closeChange({ speccraftDir, changeId });
    const nextAfter = await captureStdout(() => cmdNext(root));
    assert.doesNotMatch(nextAfter, new RegExp(`speccraft changes close ${changeId}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
