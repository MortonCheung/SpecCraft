import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseWorkflow } from '../src/core/workflow/loader.js';
import { isLegacyWorkflow } from '../src/core/workflow/legacy.js';
import {
  createInitialState,
  parseState,
  stringifyState,
  isStageStatus,
  setStageStatus,
} from '../src/core/state/store.js';
import {
  evaluateGate,
  needsOwnerApproval,
  nextStageId,
  validateState,
  designGuard,
  surveyGuard,
} from '../src/core/guards/index.js';
import { completeStage, approveStage, artifactDependencies, markStageCompleted } from '../src/core/advance.js';
import {
  parseArtifact,
  stringifyArtifact,
  createArtifact,
  artifactFileName,
} from '../src/core/artifacts/store.js';
import { collectUpstreamArtifacts } from '../src/core/context/compiler.js';
import { defaultWorkflowPath } from '../src/utils/paths.js';
import type { Workflow, StageDefinition } from '../src/core/types.js';

const workflow: Workflow = parseWorkflow(readFileSync(defaultWorkflowPath, 'utf8'));

function stage(id: string): StageDefinition {
  const s = workflow.stages.find((x) => x.id === id);
  assert.ok(s, `阶段 ${id} 应存在`);
  return s!;
}

test('DoD #3：正确读取 Workflow（16 阶段）', () => {
  assert.equal(workflow.name, 'default');
  assert.equal(workflow.stages.length, 16);
  assert.equal(workflow.stages[0].id, 'idea');
  assert.equal(workflow.stages[workflow.stages.length - 1].id, 'handoff');
});

test('DoD #4：createInitialState 全 pending，current_stage=idea', () => {
  const state = createInitialState(workflow);
  assert.equal(state.current_stage, 'idea');
  for (const s of workflow.stages) {
    assert.equal(state.stages[s.id].status, 'pending');
  }
});

test('state parse/stringify 往返', () => {
  const state = createInitialState(workflow);
  state.stages['idea'] = { status: 'completed' };
  const round = parseState(stringifyState(state));
  assert.equal(round.stages['idea'].status, 'completed');
  assert.equal(round.current_stage, 'idea');
});

test('isStageStatus 校验合法状态', () => {
  assert.equal(isStageStatus('completed'), true);
  assert.equal(isStageStatus('waiting_owner_approval'), true);
  assert.equal(isStageStatus('bogus'), false);
});

test('DoD #11：design 未批准时 build-brief 门禁不满足', () => {
  const state = createInitialState(workflow);
  for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
    completeStage(workflow, state, id);
  }
  assert.equal(state.stages['design'].status, 'waiting_owner_approval');
  assert.equal(evaluateGate(stage('build-brief'), state).satisfied, false);
  assert.equal(designGuard(state).passed, false);
});

test('DoD #12：site-survey 未完成时 execution-manual 门禁不满足', () => {
  const state = createInitialState(workflow);
  for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
    completeStage(workflow, state, id);
  }
  approveStage(workflow, state, 'design', 'owner');
  completeStage(workflow, state, 'build-brief');
  assert.equal(evaluateGate(stage('execution-manual'), state).satisfied, false);
  assert.equal(surveyGuard(state).passed, false);
});

test('DoD #13：完整流程推进到 ready-to-implement', () => {
  const state = createInitialState(workflow);
  for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
    completeStage(workflow, state, id);
  }
  approveStage(workflow, state, 'design', 'owner');
  for (const id of ['build-brief', 'site-survey', 'execution-manual']) {
    completeStage(workflow, state, id);
  }
  assert.equal(state.stages['ready-to-implement'].status, 'completed');
  assert.deepEqual(validateState(workflow, state), []);
});

// ---------------------------------------------------------------------------
// M2.0：声明式 transition 语义（ADR 0003 §3）
// ---------------------------------------------------------------------------

test('M2.0 #2：默认 Workflow 的 auto_complete 声明正确', () => {
  assert.equal(stage('owner-approval').autoComplete, true);
  assert.equal(stage('ready-to-implement').autoComplete, true);
  assert.notEqual(stage('implementation').autoComplete, true);
  assert.notEqual(stage('owner-acceptance').autoComplete, true);
  assert.notEqual(stage('verification').autoComplete, true);
});

test('M2.0 #3：implementation 不会自动完成（gate 已满足也必须保持 pending）', () => {
  const state = createInitialState(workflow);
  for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
    completeStage(workflow, state, id);
  }
  approveStage(workflow, state, 'design', 'owner');
  for (const id of ['build-brief', 'site-survey', 'execution-manual']) {
    completeStage(workflow, state, id);
  }
  // gate 已满足，但 implementation 未声明 auto_complete
  assert.equal(evaluateGate(stage('implementation'), state).satisfied, true);
  assert.equal(state.stages['implementation'].status, 'pending');
  // 没有版本截止后，current_stage 应落在下一个可进入阶段
  assert.equal(state.current_stage, 'implementation');
});

test('M2.0 #1：legacy v0.1 workflow（无 auto_complete）仍可读取', () => {
  const legacySource = [
    'name: legacy',
    'version: "0.1.0"',
    'stages:',
    '  - id: idea',
    '    requires: []',
    '    produces: [idea]',
    '    gate: { type: all_required_completed }',
    '  - id: owner-approval',
    '    requires: [idea]',
    '    produces: []',
    '    gate: { type: owner_approval }',
    '  - id: implementation',
    '    requires: [owner-approval]',
    '    produces: []',
    '    gate: { type: all_required_completed }',
    '  - id: verification',
    '    requires: [implementation]',
    '    produces: [verification]',
    '    gate: { type: all_required_completed }',
  ].join('\n');

  const legacy = parseWorkflow(legacySource);
  assert.equal(legacy.stages.length, 4);
  // 该 Workflow 不含推进边界阶段 ready-to-implement，无法可靠推断 v0.1 语义，
  // 兼容层取保守值：不自动完成任何阶段。
  assert.equal(legacy.stages.find((s) => s.id === 'owner-approval')!.autoComplete, false);
  assert.equal(legacy.stages.find((s) => s.id === 'implementation')!.autoComplete, false);
  assert.equal(legacy.stages.find((s) => s.id === 'idea')!.autoComplete, false);

  // 推进行为随之保守：owner-approval 不会自动完成
  const state = createInitialState(legacy);
  completeStage(legacy, state, 'idea');
  assert.equal(state.stages['owner-approval'].status, 'pending');
});

test('M2.0：legacy v0.1 默认 16 阶段 workflow 可读取且语义等价', () => {
  const legacySource = readFileSync(defaultWorkflowPath, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('auto_complete:'))
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  const legacy = parseWorkflow(legacySource);
  assert.equal(legacy.stages.length, 16);
  assert.equal(legacy.stages.find((s) => s.id === 'owner-approval')!.autoComplete, true);
  assert.equal(legacy.stages.find((s) => s.id === 'ready-to-implement')!.autoComplete, true);
  assert.equal(legacy.stages.find((s) => s.id === 'implementation')!.autoComplete, false);
  assert.equal(legacy.stages.find((s) => s.id === 'owner-acceptance')!.autoComplete, false);

  // 归一化后的 legacy workflow 在 Runtime 中行为与新 workflow 一致
  const state = createInitialState(legacy);
  for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
    completeStage(legacy, state, id);
  }
  approveStage(legacy, state, 'design', 'owner');
  for (const id of ['build-brief', 'site-survey', 'execution-manual']) {
    completeStage(legacy, state, id);
  }
  assert.equal(state.stages['owner-approval'].status, 'completed');
  assert.equal(state.stages['ready-to-implement'].status, 'completed');
  assert.equal(state.stages['implementation'].status, 'pending');
});

test('M2.0：显式声明 auto_complete 的新 workflow 不再走 legacy 兼容', () => {
  const source = [
    'name: modern',
    'version: "0.2.0"',
    'stages:',
    '  - id: a',
    '    requires: []',
    '    produces: []',
    '    auto_complete: false',
    '    gate: { type: all_required_completed }',
    '  - id: b',
    '    requires: [a]',
    '    produces: []',
    '    gate: { type: all_required_completed }',
  ].join('\n');

  const wf = parseWorkflow(source);
  assert.equal(isLegacyWorkflow(wf), false);
  // a 显式 false；b 未声明 → 缺省 false（不再套用 v0.1 的 produces 为空规则）
  assert.equal(wf.stages[0].autoComplete, false);
  assert.equal(wf.stages[1].autoComplete, undefined);

  const state = createInitialState(wf);
  completeStage(wf, state, 'a');
  assert.equal(state.stages['b'].status, 'pending');
});

test('M2.0：verification completed 后 current_stage 停在 verification', () => {
  const state = createInitialState(workflow);
  for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
    completeStage(workflow, state, id);
  }
  approveStage(workflow, state, 'design', 'owner');
  for (const id of ['build-brief', 'site-survey', 'execution-manual']) {
    completeStage(workflow, state, id);
  }
  // Runtime 命令路径：不经过 Owner 批准判定
  markStageCompleted(workflow, state, 'implementation');
  assert.equal(state.current_stage, 'verification');

  markStageCompleted(workflow, state, 'verification');
  assert.equal(state.stages['verification'].status, 'completed');
  assert.equal(state.current_stage, 'verification');
  // owner-acceptance 是 owner_approval 门禁，不会自动进入
  assert.equal(state.stages['owner-acceptance'].status, 'pending');
});

test('DoD #6：validateState 检测跳阶段', () => {
  const state = createInitialState(workflow);
  state.stages['design'] = { status: 'completed' };
  const violations = validateState(workflow, state);
  assert.ok(violations.some((v) => v.includes('design')));
});

test('DoD #9：nextStageId 正确', () => {
  const state = createInitialState(workflow);
  assert.equal(nextStageId(workflow, state), 'idea');
  completeStage(workflow, state, 'idea');
  assert.equal(nextStageId(workflow, state), 'feasibility');
});

test('DoD #5：approveStage 记录批准人与时间，并级联 owner-approval', () => {
  const state = createInitialState(workflow);
  for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
    completeStage(workflow, state, id);
  }
  approveStage(workflow, state, 'design', 'owner');
  assert.equal(state.stages['design'].status, 'approved');
  assert.equal(state.stages['design'].approvedBy, 'owner');
  assert.ok(state.stages['design'].approvedAt);
  assert.equal(state.stages['owner-approval'].status, 'completed');
});

test('DoD #7：artifact create/stringify/parse 往返', () => {
  const artifact = createArtifact(
    { artifact: 'idea', stage: 'idea', status: 'completed', version: 1 },
    '# 概述\n\n内容\n',
  );
  const parsed = parseArtifact(stringifyArtifact(artifact));
  assert.equal(parsed.frontmatter.artifact, 'idea');
  assert.equal(parsed.frontmatter.status, 'completed');
  assert.match(parsed.body, /# 概述/);
});

test('artifactFileName 约定', () => {
  assert.equal(artifactFileName('design'), 'design.md');
});

test('artifactDependencies 返回上游 produces', () => {
  assert.deepEqual(artifactDependencies(workflow, stage('design')), ['requirements', 'research']);
});

test('needsOwnerApproval：design 需要批准，research 不需要', () => {
  assert.equal(needsOwnerApproval(workflow, 'design'), true);
  assert.equal(needsOwnerApproval(workflow, 'research'), false);
});

test('Context Compiler：execution-manual 上游 artifact 闭包', () => {
  const ids = collectUpstreamArtifacts(workflow, 'execution-manual');
  assert.deepEqual(ids, [
    'idea', 'feasibility', 'discovery', 'requirements', 'concept',
    'research', 'design', 'build-brief', 'site-survey',
  ]);
});
