import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseWorkflow } from '../src/core/workflow/loader.js';
import {
  createInitialState,
  parseState,
  stringifyState,
  isStageStatus,
} from '../src/core/state/store.js';
import {
  evaluateGate,
  needsOwnerApproval,
  nextStageId,
  validateState,
  designGuard,
  surveyGuard,
} from '../src/core/guards/index.js';
import { completeStage, approveStage, artifactDependencies } from '../src/core/advance.js';
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
  assert.equal(state.current_stage, 'ready-to-implement');
  assert.deepEqual(validateState(workflow, state), []);
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
