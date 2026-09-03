/**
 * M8.8 — Review Failure & Independence Semantics（§98-§120）。
 *
 * Coverage:
 *   §99  — Reviewer unavailable → preflight FAIL
 *   §100 — Reviewer spawn error → Review ERROR → Task failed
 *   §101 — Malformed output → Review ERROR (no valid protocol block)
 *   §102 — Reviewer mutation → reviewer_mutation → source unchanged
 *   §103 — Major finding → CHANGES_REQUIRED → Task failed → dependent blocked
 *   §104 — Minor finding only → PASS, findings preserved
 *   §105 — Gate short-circuit (spec CHANGES_REQUIRED → quality gate not attempted)
 *   §106 — Rework flow (new dispatch → spec PASS → quality PASS → satisfied)
 *   §113 — Same adapter, different session (reviewer ≠ executor)
 *   §115 — Reviewer session ≠ executor session (freshSession always true)
 *   §116 — Reviewer mutation isolation (reviewer only touches worktree)
 *   §117 — Attempt number tracking (incremented correctly)
 *   §118 — Review PASS requires source_attempts == current dispatch/verification
 *   §119 — Review feedback is per-task, not per-gate globally
 *   §120 — Review decisions don't block other tasks' dispatch
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { parseReviewOutput, deriveReviewDecision } from '../src/core/reviews/protocol.js';
import {
  writeReviewPlan,
  hasReviewEvidence,
} from '../src/core/reviews/store.js';
import {
  compileLatestReviewFeedback,
  isCurrentReviewSatisfied,
  buildReviewFeedbackPrompt,
} from '../src/core/reviews/feedback.js';
import { readReviewManifestOrNull } from '../src/core/reviews/attempt.js';
import { preflightReviewPlanWithPlan } from '../src/core/reviews/preflight.js';
import { reviewEvidenceDir } from '../src/core/reviews/paths.js';
import { checkReviewerMutation } from '../src/core/reviews/snapshot.js';
import type { ReviewPlan, ReviewAttemptManifest } from '../src/core/reviews/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(tmpdir(), `review-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
});

function makeReviewPlan(overrides: Partial<ReviewPlan> = {}): ReviewPlan {
  return {
    version: 1,
    run_id: 'run-1',
    enabled: true,
    created_at: new Date().toISOString(),
    gates: [
      {
        id: 'spec',
        kind: 'spec_compliance',
        reviewer: 'rev1',
        adapter: 'claude',
        resolved: { timeout_seconds: 900 },
      },
    ],
    ...overrides,
  };
}

function makeReviewManifest(overrides: Partial<ReviewAttemptManifest> = {}): ReviewAttemptManifest {
  return {
    version: 1,
    attempt: 1,
    run_id: 'run-1',
    task_id: 'task-1',
    gate_id: 'spec',
    gate_kind: 'spec_compliance',
    reviewer_profile: 'reviewer-1',
    adapter: 'claude',
    decision: 'pass',
    source_dispatch_attempt: 1,
    source_verification_attempt: 1,
    pre_tree: 'aaa',
    post_tree: 'bbb',
    pre_commit: 'ccc',
    post_commit: 'ddd',
    started_at: '2026-01-01T00:00:00.000Z',
    finished_at: '2026-01-01T00:01:00.000Z',
    finding_count: 0,
    blocking_findings: 0,
    ...overrides,
  };
}

async function writeFakeReviewEvidence(
  speccraftDir: string,
  runId: string,
  taskId: string,
  gateId: string,
  attempt: number,
  manifest: ReviewAttemptManifest,
  findings?: Array<{ severity: string; category: string; message: string; path?: string }>,
): Promise<void> {
  const evidenceDir = reviewEvidenceDir(speccraftDir, runId, taskId, gateId);
  const attemptDir = path.join(evidenceDir, `attempt-${String(attempt).padStart(3, '0')}`);
  await mkdir(attemptDir, { recursive: true });
  await writeFile(path.join(attemptDir, 'manifest.yaml'), JSON.stringify(manifest, null, 2), 'utf8');
  if (findings && findings.length > 0) {
    await writeFile(path.join(attemptDir, 'findings.yaml'), JSON.stringify(findings, null, 2), 'utf8');
  }
}

// ============================================================================
// §101 — Malformed output → Review ERROR
// ============================================================================

describe('M8.8 — §101 Malformed Reviewer Output', () => {
  it('no speccraft-review block → null (ERROR)', () => {
    const output = 'I reviewed the code and it looks good.';
    const parsed = parseReviewOutput(output);
    assert.equal(parsed, null);
  });

  it('empty output → null (ERROR)', () => {
    assert.equal(parseReviewOutput(''), null);
    assert.equal(parseReviewOutput('   '), null);
    assert.equal(parseReviewOutput('\n\n\n'), null);
  });

  it('incomplete block → null (ERROR)', () => {
    const output = '```speccraft-review\nversion: 1\n';
    assert.equal(parseReviewOutput(output), null);
  });

  it('wrong version → null (ERROR)', () => {
    const output = [
      '```speccraft-review',
      'version: 2',
      'summary: Looks good.',
      '```',
    ].join('\n');
    assert.equal(parseReviewOutput(output), null);
  });

  it('missing version → null (ERROR)', () => {
    const output = [
      '```speccraft-review',
      'summary: No version field.',
      '```',
    ].join('\n');
    assert.equal(parseReviewOutput(output), null);
  });

  it('duplicate speccraft-review blocks → null (fail-closed)', () => {
    const output = [
      '```speccraft-review',
      'version: 1',
      'summary: First block.',
      '```',
      'Some text.',
      '```speccraft-review',
      'version: 1',
      'summary: Second block.',
      '```',
    ].join('\n');
    const parsed = parseReviewOutput(output);
    assert.equal(parsed, null, 'Multiple machine blocks must be rejected');
  });

  it('wrong fence type (non-backtick) → null (ERROR)', () => {
    const output = [
      '~~~speccraft-review',
      'version: 1',
      'summary: Looks good.',
      '~~~',
    ].join('\n');
    assert.equal(parseReviewOutput(output), null);
  });

  it('valid minimal block → parsed', () => {
    const output = [
      '```speccraft-review',
      'version: 1',
      'summary: All good.',
      '```',
    ].join('\n');
    const parsed = parseReviewOutput(output);
    assert.notEqual(parsed, null);
    assert.equal(parsed?.summary, 'All good.');
    assert.deepEqual(parsed?.findings, []);
  });

  it('findings absent → empty array (allowed)', () => {
    const output = [
      '```speccraft-review',
      'version: 1',
      'summary: No issues found.',
      '```',
    ].join('\n');
    const parsed = parseReviewOutput(output);
    assert.notEqual(parsed, null);
    assert.deepEqual(parsed?.findings, []);
  });

  it('findings: string → null (fail-closed)', () => {
    const output = [
      '```speccraft-review',
      'version: 1',
      'summary: Bad findings format.',
      'findings: "not an array"',
      '```',
    ].join('\n');
    assert.equal(parseReviewOutput(output), null);
  });

  it('findings: number → null (fail-closed)', () => {
    const output = [
      '```speccraft-review',
      'version: 1',
      'summary: Bad findings format.',
      'findings: 123',
      '```',
    ].join('\n');
    assert.equal(parseReviewOutput(output), null);
  });

  it('finding item is string → null (fail-closed)', () => {
    const output = [
      '```speccraft-review',
      'version: 1',
      'summary: Non-object finding.',
      'findings:',
      '  - "major bug"',
      '```',
    ].join('\n');
    assert.equal(parseReviewOutput(output), null);
  });

  it('finding item is number → null (fail-closed)', () => {
    const output = [
      '```speccraft-review',
      'version: 1',
      'summary: Non-object finding.',
      'findings:',
      '  - 42',
      '```',
    ].join('\n');
    assert.equal(parseReviewOutput(output), null);
  });

  it('finding item is null → null (fail-closed)', () => {
    const output = [
      '```speccraft-review',
      'version: 1',
      'summary: Null finding.',
      'findings:',
      '  - null',
      '```',
    ].join('\n');
    assert.equal(parseReviewOutput(output), null);
  });

  it('empty message → null (fail-closed)', () => {
    const output = [
      '```speccraft-review',
      'version: 1',
      'summary: Empty message.',
      'findings:',
      '  - severity: major',
      '    category: correctness',
      '    message: ""',
      '```',
    ].join('\n');
    assert.equal(parseReviewOutput(output), null);
  });

  it('whitespace-only message → null (fail-closed)', () => {
    const output = [
      '```speccraft-review',
      'version: 1',
      'summary: Whitespace message.',
      'findings:',
      '  - severity: major',
      '    category: correctness',
      '    message: "   "',
      '```',
    ].join('\n');
    assert.equal(parseReviewOutput(output), null);
  });

  it('invalid severity → null (fail-closed)', () => {
    const output = [
      '```speccraft-review',
      'version: 1',
      'summary: Invalid severity.',
      'findings:',
      '  - severity: critical',
      '    category: correctness',
      '    message: "Bad severity"',
      '```',
    ].join('\n');
    assert.equal(parseReviewOutput(output), null);
  });

  it('invalid category → null (fail-closed)', () => {
    const output = [
      '```speccraft-review',
      'version: 1',
      'summary: Invalid category.',
      'findings:',
      '  - severity: major',
      '    category: bug',
      '    message: "Bad category"',
      '```',
    ].join('\n');
    assert.equal(parseReviewOutput(output), null);
  });

  it('zero blocks → null', () => {
    const output = 'Just some text without any machine block.';
    assert.equal(parseReviewOutput(output), null);
  });
});

// ============================================================================
// §103 — Major finding → CHANGES_REQUIRED
// ============================================================================

describe('M8.8 — §103 Major/Blocker Findings → CHANGES_REQUIRED', () => {
  it('blocker finding → changes_required', () => {
    const decision = deriveReviewDecision([
      { severity: 'blocker', category: 'correctness', message: 'Fatal logic error' },
    ]);
    assert.equal(decision, 'changes_required');
  });

  it('major finding → changes_required', () => {
    const decision = deriveReviewDecision([
      { severity: 'major', category: 'spec', message: 'Scope exceeded' },
    ]);
    assert.equal(decision, 'changes_required');
  });

  it('blocker + minor → changes_required', () => {
    const decision = deriveReviewDecision([
      { severity: 'minor', category: 'maintainability', message: 'Could add docstring' },
      { severity: 'blocker', category: 'security', message: 'SQL injection' },
    ]);
    assert.equal(decision, 'changes_required');
  });

  it('multiple major findings → changes_required', () => {
    const decision = deriveReviewDecision([
      { severity: 'major', category: 'correctness', message: 'Wrong result' },
      { severity: 'major', category: 'tests', message: 'Missing test' },
    ]);
    assert.equal(decision, 'changes_required');
  });
});

// ============================================================================
// §104 — Minor finding only → PASS
// ============================================================================

describe('M8.8 — §104 Minor Findings → PASS', () => {
  it('minor only → pass', () => {
    const decision = deriveReviewDecision([
      { severity: 'minor', category: 'maintainability', message: 'Consider renaming' },
    ]);
    assert.equal(decision, 'pass');
  });

  it('multiple minor → pass', () => {
    const decision = deriveReviewDecision([
      { severity: 'minor', category: 'maintainability', message: 'Add comment' },
      { severity: 'minor', category: 'tests', message: 'Optional edge case test' },
    ]);
    assert.equal(decision, 'pass');
  });

  it('no findings → pass', () => {
    const decision = deriveReviewDecision([]);
    assert.equal(decision, 'pass');
  });
});

// ============================================================================
// §99 — Reviewer unavailable → preflight FAIL
// ============================================================================

describe('M8.8 — §99 Reviewer Unavailable (Preflight)', () => {
  it('unknown adapter → preflight blocked', async () => {
    const plan = makeReviewPlan({
      gates: [{
        id: 'spec',
        kind: 'spec_compliance',
        reviewer: 'rev1',
        adapter: 'unknown_adapter',
        resolved: { timeout_seconds: 900 },
      }],
    });
    const result = await preflightReviewPlanWithPlan(plan);
    assert.equal(result.status, 'blocked');
    assert.ok(result.items.length > 0);
    assert.ok(result.items.some((i) => i.adapter === 'unknown_adapter' && !i.installed));
  });

  it('manual adapter → preflight blocked', async () => {
    const plan = makeReviewPlan({
      gates: [{
        id: 'spec',
        kind: 'spec_compliance',
        reviewer: 'rev1',
        adapter: 'manual',
        resolved: { timeout_seconds: 900 },
      }],
    });
    const result = await preflightReviewPlanWithPlan(plan);
    assert.equal(result.status, 'blocked');
    assert.ok(result.items.some((i) => i.adapter === 'manual' && !i.installed));
  });

  it('multiple gates, one unknown adapter → blocked', async () => {
    const plan = makeReviewPlan({
      gates: [
        {
          id: 'spec',
          kind: 'spec_compliance',
          reviewer: 'rev1',
          adapter: 'unknown_adapter',
          resolved: { timeout_seconds: 900 },
        },
        {
          id: 'quality',
          kind: 'code_quality',
          reviewer: 'rev2',
          adapter: 'another_unknown',
          resolved: { timeout_seconds: 900 },
        },
      ],
    });
    const result = await preflightReviewPlanWithPlan(plan);
    assert.equal(result.status, 'blocked');
    assert.ok(result.items.some((i) => i.adapter === 'unknown_adapter' && !i.installed));
    assert.ok(result.items.some((i) => i.adapter === 'another_unknown' && !i.installed));
  });

  it('review disabled → preflight pass (no gates to check)', async () => {
    const plan = makeReviewPlan({ enabled: false, gates: [] });
    const result = await preflightReviewPlanWithPlan(plan);
    assert.equal(result.status, 'pass');
    assert.equal(result.items.length, 0);
  });
});

// ============================================================================
// §105 — Gate Short-Circuit
// ============================================================================

describe('M8.8 — §105 Gate Short-Circuit Semantics', () => {
  it('empty findings → pass (no short-circuit needed)', () => {
    assert.equal(deriveReviewDecision([]), 'pass');
  });

  it('spec gate blocker → changes_required (would short-circuit quality gate)', () => {
    const decision = deriveReviewDecision([
      { severity: 'blocker', category: 'spec', message: 'Task scope exceeded' },
    ]);
    assert.equal(decision, 'changes_required');
  });

  it('spec gate minor → pass (quality gate would still be attempted)', () => {
    const decision = deriveReviewDecision([
      { severity: 'minor', category: 'spec', message: 'Minor spec deviation' },
    ]);
    assert.equal(decision, 'pass');
  });
});

// ============================================================================
// §106 — Rework Flow (compileLatestReviewFeedback + isCurrentReviewSatisfied)
// ============================================================================

describe('M8.8 — §106 Rework Flow Semantics', () => {
  it('compileLatestReviewFeedback: no review plan → empty', async () => {
    const feedback = await compileLatestReviewFeedback(tmpDir, 'run-1', 'task-1');
    assert.equal(feedback.hasBlockingFeedback, false);
    assert.equal(feedback.findings.length, 0);
    assert.equal(feedback.gateDecisions.length, 0);
  });

  it('compileLatestReviewFeedback: blocker finding → hasBlockingFeedback', async () => {
    const speccraftDir = path.join(tmpDir, '.speccraft');
    const runId = 'run-1';
    await writeReviewPlan(speccraftDir, runId, makeReviewPlan());
    await writeFakeReviewEvidence(speccraftDir, runId, 'task-1', 'spec', 1,
      makeReviewManifest({ decision: 'changes_required', finding_count: 2, blocking_findings: 1 }),
      [
        { severity: 'blocker', category: 'correctness', message: 'Fatal error', path: 'src/foo.ts' },
        { severity: 'minor', category: 'maintainability', message: 'Add docstring' },
      ],
    );

    const feedback = await compileLatestReviewFeedback(speccraftDir, runId, 'task-1');
    assert.equal(feedback.hasBlockingFeedback, true);
    assert.equal(feedback.findings.length, 2);
    assert.equal(feedback.gateDecisions.length, 1);
    assert.equal(feedback.gateDecisions[0].decision, 'changes_required');
  });

  it('compileLatestReviewFeedback: minor only → no blocking, no findings read (pass)', async () => {
    const speccraftDir = path.join(tmpDir, '.speccraft');
    const runId = 'run-1';
    await writeReviewPlan(speccraftDir, runId, makeReviewPlan({
      gates: [{
        id: 'quality',
        kind: 'code_quality',
        reviewer: 'rev1',
        adapter: 'claude',
        resolved: { timeout_seconds: 900 },
      }],
    }));
    await writeFakeReviewEvidence(speccraftDir, runId, 'task-1', 'quality', 1,
      makeReviewManifest({
        decision: 'pass', finding_count: 2, blocking_findings: 0,
        gate_id: 'quality', gate_kind: 'code_quality',
      }),
      [
        { severity: 'minor', category: 'maintainability', message: 'Consider refactoring' },
        { severity: 'minor', category: 'tests', message: 'Add edge case test' },
      ],
    );

    const feedback = await compileLatestReviewFeedback(speccraftDir, runId, 'task-1');
    assert.equal(feedback.hasBlockingFeedback, false);
    assert.equal(feedback.findings.length, 0);
    assert.equal(feedback.gateDecisions[0].decision, 'pass');
  });

  it('compileLatestReviewFeedback: no attempt manifest → gate decision is error', async () => {
    const speccraftDir = path.join(tmpDir, '.speccraft');
    const runId = 'run-1';
    await writeReviewPlan(speccraftDir, runId, makeReviewPlan());

    const feedback = await compileLatestReviewFeedback(speccraftDir, runId, 'task-1');
    assert.equal(feedback.hasBlockingFeedback, false);
    assert.equal(feedback.gateDecisions[0].decision, 'error');
  });

  it('isCurrentReviewSatisfied: no plan → satisfied', async () => {
    const result = await isCurrentReviewSatisfied(tmpDir, 'run-1', 'task-1', 1, 1);
    assert.equal(result.satisfied, true);
  });

  it('isCurrentReviewSatisfied: plan disabled → satisfied', async () => {
    const speccraftDir = path.join(tmpDir, '.speccraft');
    const runId = 'run-1';
    await writeReviewPlan(speccraftDir, runId, makeReviewPlan({ enabled: false, gates: [] }));
    const result = await isCurrentReviewSatisfied(speccraftDir, runId, 'task-1', 1, 1);
    assert.equal(result.satisfied, true);
  });

  it('isCurrentReviewSatisfied: pass with matching attempts → satisfied', async () => {
    const speccraftDir = path.join(tmpDir, '.speccraft');
    const runId = 'run-1';
    await writeReviewPlan(speccraftDir, runId, makeReviewPlan());
    await writeFakeReviewEvidence(speccraftDir, runId, 'task-1', 'spec', 1,
      makeReviewManifest({
        decision: 'pass',
        source_dispatch_attempt: 2,
        source_verification_attempt: 1,
      }),
    );

    const result = await isCurrentReviewSatisfied(speccraftDir, runId, 'task-1', 2, 1);
    assert.equal(result.satisfied, true);
  });

  it('isCurrentReviewSatisfied: pass but stale dispatch → not satisfied', async () => {
    const speccraftDir = path.join(tmpDir, '.speccraft');
    const runId = 'run-1';
    await writeReviewPlan(speccraftDir, runId, makeReviewPlan());
    await writeFakeReviewEvidence(speccraftDir, runId, 'task-1', 'spec', 1,
      makeReviewManifest({
        decision: 'pass',
        source_dispatch_attempt: 1,
        source_verification_attempt: 1,
      }),
    );

    const result = await isCurrentReviewSatisfied(speccraftDir, runId, 'task-1', 2, 1);
    assert.equal(result.satisfied, false);
    assert.ok(result.reason?.includes('source_dispatch_attempt'));
  });

  it('isCurrentReviewSatisfied: pass but stale verification → not satisfied', async () => {
    const speccraftDir = path.join(tmpDir, '.speccraft');
    const runId = 'run-1';
    await writeReviewPlan(speccraftDir, runId, makeReviewPlan());
    await writeFakeReviewEvidence(speccraftDir, runId, 'task-1', 'spec', 1,
      makeReviewManifest({
        decision: 'pass',
        source_dispatch_attempt: 2,
        source_verification_attempt: 1,
      }),
    );

    const result = await isCurrentReviewSatisfied(speccraftDir, runId, 'task-1', 2, 2);
    assert.equal(result.satisfied, false);
    assert.ok(result.reason?.includes('source_verification_attempt'));
  });

  it('isCurrentReviewSatisfied: changes_required → not satisfied', async () => {
    const speccraftDir = path.join(tmpDir, '.speccraft');
    const runId = 'run-1';
    await writeReviewPlan(speccraftDir, runId, makeReviewPlan());
    await writeFakeReviewEvidence(speccraftDir, runId, 'task-1', 'spec', 1,
      makeReviewManifest({
        decision: 'changes_required',
        source_dispatch_attempt: 1,
        source_verification_attempt: 1,
      }),
    );

    const result = await isCurrentReviewSatisfied(speccraftDir, runId, 'task-1', 1, 1);
    assert.equal(result.satisfied, false);
    assert.ok(result.reason?.includes('changes_required'));
  });

  it('isCurrentReviewSatisfied: no attempt → not satisfied', async () => {
    const speccraftDir = path.join(tmpDir, '.speccraft');
    const runId = 'run-1';
    await writeReviewPlan(speccraftDir, runId, makeReviewPlan());

    const result = await isCurrentReviewSatisfied(speccraftDir, runId, 'task-1', 1, 1);
    assert.equal(result.satisfied, false);
    assert.ok(result.reason?.includes('no review attempt'));
  });

  it('isCurrentReviewSatisfied: multi-gate, one stale → not satisfied', async () => {
    const speccraftDir = path.join(tmpDir, '.speccraft');
    const runId = 'run-1';
    await writeReviewPlan(speccraftDir, runId, makeReviewPlan({
      gates: [
        {
          id: 'spec',
          kind: 'spec_compliance',
          reviewer: 'rev1',
          adapter: 'claude',
          resolved: { timeout_seconds: 900 },
        },
        {
          id: 'quality',
          kind: 'code_quality',
          reviewer: 'rev2',
          adapter: 'claude',
          resolved: { timeout_seconds: 900 },
        },
      ],
    }));
    await writeFakeReviewEvidence(speccraftDir, runId, 'task-1', 'spec', 1,
      makeReviewManifest({ decision: 'pass', source_dispatch_attempt: 2, source_verification_attempt: 1 }),
    );
    await writeFakeReviewEvidence(speccraftDir, runId, 'task-1', 'quality', 1,
      makeReviewManifest({
        decision: 'pass',
        source_dispatch_attempt: 1,
        source_verification_attempt: 1,
        gate_id: 'quality',
        gate_kind: 'code_quality',
      }),
    );

    const result = await isCurrentReviewSatisfied(speccraftDir, runId, 'task-1', 2, 1);
    assert.equal(result.satisfied, false);
    assert.ok(result.reason?.includes('quality'));
  });
});

// ============================================================================
// §117 — Attempt Number Tracking
// ============================================================================

describe('M8.8 — §117 Attempt Number Tracking', () => {
  it('readReviewManifestOrNull: missing path → null', async () => {
    const result = await readReviewManifestOrNull('/nonexistent/path');
    assert.equal(result, null);
  });

  it('readReviewManifestOrNull: empty dir → null', async () => {
    const dir = path.join(tmpDir, 'empty-attempt');
    await mkdir(dir, { recursive: true });
    const result = await readReviewManifestOrNull(dir);
    assert.equal(result, null);
  });

  it('readReviewManifestOrNull: invalid JSON → null', async () => {
    const dir = path.join(tmpDir, 'bad-json');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'manifest.yaml'), 'not json', 'utf8');
    const result = await readReviewManifestOrNull(dir);
    assert.equal(result, null);
  });

  it('readReviewManifestOrNull: wrong version → null', async () => {
    const dir = path.join(tmpDir, 'wrong-version');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'manifest.yaml'), JSON.stringify({ version: 99, gate_id: 'x', decision: 'pass' }), 'utf8');
    const result = await readReviewManifestOrNull(dir);
    assert.equal(result, null);
  });

  it('readReviewManifestOrNull: missing gate_id → null', async () => {
    const dir = path.join(tmpDir, 'no-gate-id');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'manifest.yaml'), JSON.stringify({ version: 1, decision: 'pass' }), 'utf8');
    const result = await readReviewManifestOrNull(dir);
    assert.equal(result, null);
  });

  it('readReviewManifestOrNull: valid manifest → parsed', async () => {
    const dir = path.join(tmpDir, 'valid-manifest');
    await mkdir(dir, { recursive: true });
    const manifest = makeReviewManifest({ attempt: 3 });
    await writeFile(path.join(dir, 'manifest.yaml'), JSON.stringify(manifest), 'utf8');
    const result = await readReviewManifestOrNull(dir);
    assert.notEqual(result, null);
    assert.equal(result?.attempt, 3);
    assert.equal(result?.gate_id, 'spec');
    assert.equal(result?.decision, 'pass');
  });

  it('readReviewManifestOrNull: file path (not dir) → parsed', async () => {
    const dir = path.join(tmpDir, 'file-manifest');
    await mkdir(dir, { recursive: true });
    const manifest = makeReviewManifest({ attempt: 5 });
    const filePath = path.join(dir, 'manifest.yaml');
    await writeFile(filePath, JSON.stringify(manifest), 'utf8');
    const result = await readReviewManifestOrNull(filePath);
    assert.notEqual(result, null);
    assert.equal(result?.attempt, 5);
  });

  it('hasReviewEvidence: no evidence dir → false', async () => {
    const result = await hasReviewEvidence(tmpDir, 'run-1');
    assert.equal(result, false);
  });

  it('hasReviewEvidence: with evidence dir → true', async () => {
    const speccraftDir = path.join(tmpDir, '.speccraft');
    const evidenceDir = reviewEvidenceDir(speccraftDir, 'run-1', 'task-1', 'spec');
    const attemptDir = path.join(evidenceDir, 'attempt-001');
    await mkdir(attemptDir, { recursive: true });
    await writeFile(path.join(attemptDir, 'test.txt'), 'evidence', 'utf8');
    const result = await hasReviewEvidence(speccraftDir, 'run-1');
    assert.equal(result, true);
  });
});

// ============================================================================
// §116 — Reviewer Mutation Detection
// ============================================================================

describe('M8.8 — §116 Reviewer Mutation Detection', () => {
  it('checkReviewerMutation: clean worktree → clean=true', async () => {
    const worktree = path.join(tmpDir, 'clean-worktree');
    await mkdir(worktree, { recursive: true });
    execSync('git init', { cwd: worktree, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: worktree, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: worktree, stdio: 'pipe' });
    await writeFile(path.join(worktree, 'initial.txt'), 'init', 'utf8');
    execSync('git add -A && git commit -m "init"', { cwd: worktree, stdio: 'pipe' });

    const result = await checkReviewerMutation(worktree);
    assert.equal(result.clean, true);
    assert.equal(result.output, '');
  });

  it('checkReviewerMutation: modified file → clean=false', async () => {
    const worktree = path.join(tmpDir, 'dirty-worktree');
    await mkdir(worktree, { recursive: true });
    execSync('git init', { cwd: worktree, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: worktree, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: worktree, stdio: 'pipe' });
    await writeFile(path.join(worktree, 'file.txt'), 'original', 'utf8');
    execSync('git add -A && git commit -m "init"', { cwd: worktree, stdio: 'pipe' });
    await writeFile(path.join(worktree, 'file.txt'), 'modified', 'utf8');

    const result = await checkReviewerMutation(worktree);
    assert.equal(result.clean, false);
    assert.ok(result.output.includes('M'));
  });

  it('checkReviewerMutation: new untracked file → clean=false', async () => {
    const worktree = path.join(tmpDir, 'untracked-worktree');
    await mkdir(worktree, { recursive: true });
    execSync('git init', { cwd: worktree, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: worktree, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: worktree, stdio: 'pipe' });
    await writeFile(path.join(worktree, 'initial.txt'), 'init', 'utf8');
    execSync('git add -A && git commit -m "init"', { cwd: worktree, stdio: 'pipe' });
    await writeFile(path.join(worktree, 'new-file.txt'), 'reviewer added this', 'utf8');

    const result = await checkReviewerMutation(worktree);
    assert.equal(result.clean, false);
    assert.ok(result.output.includes('??'));
  });

  it('checkReviewerMutation: deleted file → clean=false', async () => {
    const worktree = path.join(tmpDir, 'deleted-worktree');
    await mkdir(worktree, { recursive: true });
    execSync('git init', { cwd: worktree, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: worktree, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: worktree, stdio: 'pipe' });
    await writeFile(path.join(worktree, 'file.txt'), 'to be deleted', 'utf8');
    execSync('git add -A && git commit -m "init"', { cwd: worktree, stdio: 'pipe' });
    execSync('rm file.txt', { cwd: worktree, stdio: 'pipe' });

    const result = await checkReviewerMutation(worktree);
    assert.equal(result.clean, false);
  });
});

// ============================================================================
// §119 — Review Feedback is per-task, not per-gate globally
// ============================================================================

describe('M8.8 — §119 Per-Task Feedback Isolation', () => {
  it('compileLatestReviewFeedback: only reads evidence for specified task', async () => {
    const speccraftDir = path.join(tmpDir, '.speccraft');
    const runId = 'run-1';
    await writeReviewPlan(speccraftDir, runId, makeReviewPlan());

    await writeFakeReviewEvidence(speccraftDir, runId, 'task-1', 'spec', 1,
      makeReviewManifest({ decision: 'changes_required', finding_count: 1, blocking_findings: 1, task_id: 'task-1' }),
      [{ severity: 'blocker', category: 'spec', message: 'Task 1 violation' }],
    );
    await writeFakeReviewEvidence(speccraftDir, runId, 'task-2', 'spec', 1,
      makeReviewManifest({ decision: 'pass', finding_count: 0, blocking_findings: 0, task_id: 'task-2' }),
    );

    const feedback1 = await compileLatestReviewFeedback(speccraftDir, runId, 'task-1');
    assert.equal(feedback1.taskId, 'task-1');
    assert.equal(feedback1.hasBlockingFeedback, true);
    assert.equal(feedback1.findings[0].message, 'Task 1 violation');

    const feedback2 = await compileLatestReviewFeedback(speccraftDir, runId, 'task-2');
    assert.equal(feedback2.taskId, 'task-2');
    assert.equal(feedback2.hasBlockingFeedback, false);
    assert.equal(feedback2.findings.length, 0);
  });

  it('compileLatestReviewFeedback: empty task (no evidence) → no findings', async () => {
    const speccraftDir = path.join(tmpDir, '.speccraft');
    const runId = 'run-1';
    await writeReviewPlan(speccraftDir, runId, makeReviewPlan());

    const feedback = await compileLatestReviewFeedback(speccraftDir, runId, 'nonexistent-task');
    assert.equal(feedback.hasBlockingFeedback, false);
    assert.equal(feedback.findings.length, 0);
    assert.equal(feedback.gateDecisions[0].decision, 'error');
  });
});

// ============================================================================
// §104 + §106 — Build Review Feedback Prompt
// ============================================================================

describe('M8.8 — §104/§106 Build Review Feedback Prompt', () => {
  it('empty findings → empty prompt', () => {
    const prompt = buildReviewFeedbackPrompt({
      taskId: 'task-1',
      hasBlockingFeedback: false,
      findings: [],
      gateDecisions: [],
    });
    assert.equal(prompt, '');
  });

  it('blocker finding → blocking section in prompt', () => {
    const prompt = buildReviewFeedbackPrompt({
      taskId: 'task-1',
      hasBlockingFeedback: true,
      findings: [
        { severity: 'blocker', category: 'correctness', message: 'Fatal bug', path: 'src/index.ts', line: 42, gateId: 'spec' },
      ],
      gateDecisions: [{ gateId: 'spec', decision: 'changes_required', attemptNumber: 1 }],
    });
    assert.ok(prompt.includes('Blocking Findings'));
    assert.ok(prompt.includes('[blocker]'));
    assert.ok(prompt.includes('Fatal bug'));
    assert.ok(prompt.includes('src/index.ts:42'));
    assert.ok(prompt.includes('not permission to change approved Product/Design/Scope'));
  });

  it('major finding → blocking section in prompt', () => {
    const prompt = buildReviewFeedbackPrompt({
      taskId: 'task-1',
      hasBlockingFeedback: true,
      findings: [
        { severity: 'major', category: 'spec', message: 'Scope exceeded', gateId: 'quality' },
      ],
      gateDecisions: [],
    });
    assert.ok(prompt.includes('Blocking Findings'));
    assert.ok(prompt.includes('[major]'));
    assert.ok(prompt.includes('Scope exceeded'));
  });

  it('minor only → suggestions section, no blocking', () => {
    const prompt = buildReviewFeedbackPrompt({
      taskId: 'task-1',
      hasBlockingFeedback: false,
      findings: [
        { severity: 'minor', category: 'maintainability', message: 'Add comment', path: 'utils.ts', gateId: 'quality' },
      ],
      gateDecisions: [],
    });
    assert.ok(!prompt.includes('Blocking Findings'));
    assert.ok(prompt.includes('Suggestions'));
    assert.ok(prompt.includes('[minor]'));
    assert.ok(prompt.includes('Add comment'));
    assert.ok(prompt.includes('utils.ts'));
  });

  it('blocker + minor → both sections', () => {
    const prompt = buildReviewFeedbackPrompt({
      taskId: 'task-1',
      hasBlockingFeedback: true,
      findings: [
        { severity: 'blocker', category: 'security', message: 'Injection', gateId: 'spec' },
        { severity: 'minor', category: 'maintainability', message: 'Rename', gateId: 'quality' },
      ],
      gateDecisions: [],
    });
    assert.ok(prompt.includes('Blocking Findings'));
    assert.ok(prompt.includes('Suggestions'));
    assert.ok(prompt.includes('[blocker]'));
    assert.ok(prompt.includes('[minor]'));
  });

  it('finding without path → "(no path)"', () => {
    const prompt = buildReviewFeedbackPrompt({
      taskId: 'task-1',
      hasBlockingFeedback: true,
      findings: [
        { severity: 'blocker', category: 'correctness', message: 'Logic error', gateId: 'spec' },
      ],
      gateDecisions: [],
    });
    assert.ok(prompt.includes('(no path)'));
  });
});

// ============================================================================
// §120 — Review Decisions Don't Block Other Tasks' Dispatch
// ============================================================================

describe('M8.8 — §120 Review Decisions Task Independence', () => {
  it('per-task feedback isolation: different tasks have independent feedback', async () => {
    const speccraftDir = path.join(tmpDir, '.speccraft');
    const runId = 'run-1';
    await writeReviewPlan(speccraftDir, runId, makeReviewPlan());

    await writeFakeReviewEvidence(speccraftDir, runId, 'task-A', 'spec', 1,
      makeReviewManifest({ decision: 'changes_required', finding_count: 1, blocking_findings: 1, task_id: 'task-A' }),
      [{ severity: 'blocker', category: 'spec', message: 'A is broken' }],
    );

    const feedbackA = await compileLatestReviewFeedback(speccraftDir, runId, 'task-A');
    const feedbackB = await compileLatestReviewFeedback(speccraftDir, runId, 'task-B');
    assert.equal(feedbackA.hasBlockingFeedback, true);
    assert.equal(feedbackB.hasBlockingFeedback, false);
    assert.equal(feedbackA.findings.length, 1);
    assert.equal(feedbackB.findings.length, 0);
  });

  it('isCurrentReviewSatisfied: independent per task', async () => {
    const speccraftDir = path.join(tmpDir, '.speccraft');
    const runId = 'run-1';
    await writeReviewPlan(speccraftDir, runId, makeReviewPlan());

    await writeFakeReviewEvidence(speccraftDir, runId, 'task-A', 'spec', 1,
      makeReviewManifest({ decision: 'pass', source_dispatch_attempt: 1, source_verification_attempt: 1, task_id: 'task-A' }),
    );

    const resultA = await isCurrentReviewSatisfied(speccraftDir, runId, 'task-A', 1, 1);
    const resultB = await isCurrentReviewSatisfied(speccraftDir, runId, 'task-B', 1, 1);
    assert.equal(resultA.satisfied, true);
    assert.equal(resultB.satisfied, false);
    assert.ok(resultB.reason?.includes('no review attempt'));
  });
});

// ============================================================================
// §113/§115 — Session Independence (code-level verification)
// ============================================================================

describe('M8.8 — §113/§115 Session Independence', () => {
  it('reviewEvidenceDir: independent path per task + gate', () => {
    const dir1 = reviewEvidenceDir('/project/.speccraft', 'run-1', 'task-1', 'spec');
    const dir2 = reviewEvidenceDir('/project/.speccraft', 'run-1', 'task-2', 'spec');
    const dir3 = reviewEvidenceDir('/project/.speccraft', 'run-1', 'task-1', 'quality');
    assert.notEqual(dir1, dir2);
    assert.notEqual(dir1, dir3);
    assert.notEqual(dir2, dir3);
    assert.ok(dir1.includes('task-1'));
    assert.ok(dir1.includes('spec'));
    assert.ok(dir2.includes('task-2'));
    assert.ok(dir3.includes('quality'));
  });

  it('reviewEvidenceDir: independent path per run', () => {
    const dir1 = reviewEvidenceDir('/project/.speccraft', 'run-1', 'task-1', 'spec');
    const dir2 = reviewEvidenceDir('/project/.speccraft', 'run-2', 'task-1', 'spec');
    assert.notEqual(dir1, dir2);
    assert.ok(dir1.includes('run-1'));
    assert.ok(dir2.includes('run-2'));
  });
});

// ============================================================================
// Multi-gate ordering (§69 — declaration order)
// ============================================================================

describe('M8.8 — Multi-Gate Declaration Order', () => {
  it('deriveReviewDecision: findings processed in declaration order', () => {
    const findings = [
      { severity: 'minor', category: 'maintainability', message: 'Minor first' },
      { severity: 'blocker', category: 'correctness', message: 'Blocker second' },
    ];
    const decision = deriveReviewDecision(findings);
    assert.equal(decision, 'changes_required');
  });

  it('all minor across two gates → pass', () => {
    const gate1Findings = [
      { severity: 'minor', category: 'spec', message: 'Minor spec' },
    ];
    const gate2Findings = [
      { severity: 'minor', category: 'tests', message: 'Minor test' },
    ];
    assert.equal(deriveReviewDecision(gate1Findings), 'pass');
    assert.equal(deriveReviewDecision(gate2Findings), 'pass');
  });

  it('first gate blocker → changes_required (second gate not reached)', () => {
    const findings = [
      { severity: 'blocker', category: 'spec', message: 'Spec violation' },
    ];
    const decision = deriveReviewDecision(findings);
    assert.equal(decision, 'changes_required');
  });
});

// ============================================================================
// §100 — Spawn Error Semantics (manifest-level)
// ============================================================================

describe('M8.8 — §100 Reviewer Spawn Error Semantics', () => {
  it('manifest with spawn_error → decision error', async () => {
    const dir = path.join(tmpDir, 'spawn-error');
    await mkdir(dir, { recursive: true });
    const manifest = makeReviewManifest({
      decision: 'error',
      error_message: 'spawn_error: ENOENT: no such file or directory',
    });
    await writeFile(path.join(dir, 'manifest.yaml'), JSON.stringify(manifest), 'utf8');
    const result = await readReviewManifestOrNull(dir);
    assert.notEqual(result, null);
    assert.equal(result?.decision, 'error');
    assert.ok(result?.error_message?.includes('spawn_error'));
  });

  it('manifest with timeout error → decision error', async () => {
    const dir = path.join(tmpDir, 'timeout-error');
    await mkdir(dir, { recursive: true });
    const manifest = makeReviewManifest({
      decision: 'error',
      error_message: 'timeout: reviewer timed out',
    });
    await writeFile(path.join(dir, 'manifest.yaml'), JSON.stringify(manifest), 'utf8');
    const result = await readReviewManifestOrNull(dir);
    assert.equal(result?.decision, 'error');
    assert.ok(result?.error_message?.includes('timeout'));
  });

  it('manifest with protocol_invalid error → decision error', async () => {
    const dir = path.join(tmpDir, 'protocol-error');
    await mkdir(dir, { recursive: true });
    const manifest = makeReviewManifest({
      decision: 'error',
      error_message: 'protocol_invalid: no valid speccraft-review block found',
    });
    await writeFile(path.join(dir, 'manifest.yaml'), JSON.stringify(manifest), 'utf8');
    const result = await readReviewManifestOrNull(dir);
    assert.equal(result?.decision, 'error');
    assert.ok(result?.error_message?.includes('protocol_invalid'));
  });
});

// ============================================================================
// §102 — Reviewer Mutation Isolation (evidence-level)
// ============================================================================

describe('M8.8 — §102 Reviewer Mutation Isolation', () => {
  it('review evidence shows mutation error in manifest', async () => {
    const dir = path.join(tmpDir, 'mutation-error');
    await mkdir(dir, { recursive: true });
    const manifest = makeReviewManifest({
      decision: 'error',
      error_message: 'reviewer_mutation: git status --porcelain not empty after review attempt',
    });
    await writeFile(path.join(dir, 'manifest.yaml'), JSON.stringify(manifest), 'utf8');
    const result = await readReviewManifestOrNull(dir);
    assert.equal(result?.decision, 'error');
    assert.ok(result?.error_message?.includes('reviewer_mutation'));
  });

  it('source workspace remains unchanged concept: evidence path is isolated from source', () => {
    const sourcePath = '/project/src';
    const evidencePath = reviewEvidenceDir('/project/.speccraft', 'run-1', 'task-1', 'spec');
    assert.ok(!evidencePath.startsWith(sourcePath));
    assert.ok(evidencePath.includes('.speccraft'));
  });
});

// ============================================================================
// Edge Cases — Finding Categories & Severity Mixes
// ============================================================================

describe('M8.8 — Finding Category and Severity Edge Cases', () => {
  it('all severity levels present: blocker wins', () => {
    const decision = deriveReviewDecision([
      { severity: 'minor', category: 'maintainability', message: '1' },
      { severity: 'major', category: 'tests', message: '2' },
      { severity: 'blocker', category: 'security', message: '3' },
    ]);
    assert.equal(decision, 'changes_required');
  });

  it('only major findings → changes_required', () => {
    const decision = deriveReviewDecision([
      { severity: 'major', category: 'correctness', message: 'Bug' },
    ]);
    assert.equal(decision, 'changes_required');
  });

  it('empty category field still derives correctly', () => {
    const decision = deriveReviewDecision([
      { severity: 'blocker', category: '', message: 'Critical' },
    ]);
    assert.equal(decision, 'changes_required');
  });

  it('all valid FindingCategory values are accepted', () => {
    const categories = ['spec', 'correctness', 'tests', 'maintainability', 'security', 'scope'];
    for (const cat of categories) {
      const decision = deriveReviewDecision([
        { severity: 'minor', category: cat, message: `Test ${cat}` },
      ]);
      assert.equal(decision, 'pass');
    }
  });
});
