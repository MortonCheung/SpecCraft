/**
 * M8.1 — Reviewer Profiles, Frozen Review Plan, Protocol & Runner Tests（§11-§21, §48-§64）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { parseReviewConfig, validateReviewConfig } from '../src/core/reviews/config.js';
import { buildFrozenReviewPlan } from '../src/core/reviews/plan.js';
import {
  writeReviewPlan, readReviewPlan, readReviewPlanOrNull,
  stringifyReviewPlan, parseReviewPlan, hasReviewEvidence,
} from '../src/core/reviews/store.js';
import { parseReviewOutput, deriveReviewDecision } from '../src/core/reviews/protocol.js';
import type { ReviewConfig } from '../src/core/reviews/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(tmpdir(), `review-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
});

describe('M8.1 — Review Config', () => {
  it('review section absent → null', () => {
    assert.equal(parseReviewConfig(undefined), null);
    assert.equal(parseReviewConfig(null), null);
  });

  it('review: enabled: false → disabled', () => {
    const c = parseReviewConfig({ enabled: false });
    assert.equal(c?.enabled, false);
  });

  it('enabled + valid gates → config', () => {
    const c = parseReviewConfig({
      enabled: true,
      reviewers: { r1: { adapter: 'claude', timeout_seconds: 900 } },
      gates: [{ id: 'spec', kind: 'spec_compliance', reviewer: 'r1' }],
    });
    assert.equal(c?.enabled, true);
    assert.equal(c?.gates.length, 1);
    assert.equal(c?.gates[0].kind, 'spec_compliance');
    assert.equal(c?.reviewers.r1?.timeout_seconds, 900);
  });

  it('duplicate gate id → FAIL', () => {
    assert.throws(() => parseReviewConfig({
      enabled: true,
      reviewers: { r1: { adapter: 'claude' } },
      gates: [
        { id: 'x', kind: 'spec_compliance', reviewer: 'r1' },
        { id: 'x', kind: 'code_quality', reviewer: 'r1' },
      ],
    }), /重复/);
  });

  it('unknown reviewer → FAIL', () => {
    assert.throws(() => parseReviewConfig({
      enabled: true,
      reviewers: { r1: { adapter: 'claude' } },
      gates: [{ id: 's', kind: 'spec_compliance', reviewer: 'ghost' }],
    }), /不存在/);
  });

  it('unknown gate kind → FAIL', () => {
    assert.throws(() => parseReviewConfig({
      enabled: true,
      reviewers: { r1: { adapter: 'claude' } },
      gates: [{ id: 's', kind: 'bogus', reviewer: 'r1' }],
    }), /非法/);
  });

  it('default_reviewer non-existent → FAIL', () => {
    assert.throws(() => parseReviewConfig({
      enabled: true,
      default_reviewer: 'ghost',
      reviewers: { r1: { adapter: 'claude' } },
      gates: [{ id: 's', kind: 'spec_compliance', reviewer: 'r1' }],
    }), /default_reviewer.*不存在/);
  });
});

describe('M8.1 — Config Validation', () => {
  it('adapter unknown → FAIL', () => {
    const c: ReviewConfig = {
      enabled: true,
      reviewers: { r1: { adapter: 'bad' } },
      gates: [{ id: 's', kind: 'spec_compliance', reviewer: 'r1' }],
    };
    assert.throws(() => validateReviewConfig(c, new Set(['claude'])), /adapter.*未知/);
  });

  it('valid config passes', () => {
    const c: ReviewConfig = {
      enabled: true,
      reviewers: { r1: { adapter: 'claude' } },
      gates: [{ id: 's', kind: 'spec_compliance', reviewer: 'r1' }],
    };
    assert.doesNotThrow(() => validateReviewConfig(c, new Set(['claude'])));
  });
});

describe('M8.1 — Frozen Review Plan', () => {
  const adapters = { claude: {}, manual: {} } as Record<string, Record<string, never>>;
  const known = new Set(['claude', 'manual']);

  it('disabled → null', () => {
    const p = buildFrozenReviewPlan({
      runId: 'r1', reviewConfig: null, projectAdapters: {}, knownAdapters: known,
    });
    assert.equal(p, null);
  });

  it('enabled + valid → plan', () => {
    const c: ReviewConfig = {
      enabled: true,
      reviewers: { 'primary': { adapter: 'claude', timeout_seconds: 900 } },
      gates: [{ id: 'spec', kind: 'spec_compliance', reviewer: 'primary' }],
    };
    const p = buildFrozenReviewPlan({
      runId: 'r1', reviewConfig: c, projectAdapters: adapters, knownAdapters: known,
    });
    assert.ok(p);
    assert.equal(p.gates.length, 1);
    assert.equal(p.gates[0].adapter, 'claude');
    assert.equal(p.gates[0].resolved.timeout_seconds, 900);
  });

  it('gate order == config order', () => {
    const c: ReviewConfig = {
      enabled: true,
      reviewers: { a: { adapter: 'claude' }, b: { adapter: 'manual' } },
      gates: [
        { id: 'first', kind: 'code_quality', reviewer: 'b' },
        { id: 'second', kind: 'spec_compliance', reviewer: 'a' },
        { id: 'third', kind: 'code_quality', reviewer: 'b' },
      ],
    };
    const p = buildFrozenReviewPlan({
      runId: 'r1', reviewConfig: c, projectAdapters: adapters, knownAdapters: known,
    });
    assert.ok(p);
    assert.deepEqual(p.gates.map((g) => g.id), ['first', 'second', 'third']);
  });

  it('adapter resolution precedence: reviewer override > adapter config > default', () => {
    const c: ReviewConfig = {
      enabled: true,
      reviewers: { r1: { adapter: 'claude', timeout_seconds: 120, model: 'opus' } },
      gates: [{ id: 's', kind: 'spec_compliance', reviewer: 'r1' }],
    };
    const p = buildFrozenReviewPlan({
      runId: 'r1', reviewConfig: c,
      projectAdapters: { claude: { timeout_seconds: 300, model: 'sonnet' } } as any,
      knownAdapters: known,
    });
    assert.ok(p);
    assert.equal(p.gates[0].resolved.timeout_seconds, 120);
    assert.equal(p.gates[0].resolved.model, 'opus');
  });
});

describe('M8.1 — Plan Store Roundtrip', () => {
  const known = new Set(['claude']);

  it('stringify → parse roundtrip', () => {
    const c: ReviewConfig = {
      enabled: true,
      reviewers: { r1: { adapter: 'claude', model: 'sonnet' } },
      gates: [{ id: 'spec', kind: 'spec_compliance', reviewer: 'r1' }],
    };
    const plan = buildFrozenReviewPlan({
      runId: 'rt', reviewConfig: c, projectAdapters: {}, knownAdapters: known,
    });
    assert.ok(plan);
    const parsed = parseReviewPlan(stringifyReviewPlan(plan));
    assert.equal(parsed.run_id, 'rt');
    assert.equal(parsed.gates[0].resolved.model, 'sonnet');
  });

  it('write → read roundtrip', async () => {
    const c: ReviewConfig = {
      enabled: true,
      reviewers: { r1: { adapter: 'claude' } },
      gates: [{ id: 'q', kind: 'code_quality', reviewer: 'r1' }],
    };
    const plan = buildFrozenReviewPlan({
      runId: 'wr', reviewConfig: c, projectAdapters: {}, knownAdapters: known,
    });
    assert.ok(plan);
    await writeReviewPlan(tmpDir, 'wr', plan);
    const back = await readReviewPlan(tmpDir, 'wr');
    assert.equal(back.gates[0].id, 'q');
  });

  it('readReviewPlanOrNull → null when absent', async () => {
    assert.equal(await readReviewPlanOrNull(tmpDir, 'no'), null);
  });
});

describe('M8.1 — Review Evidence Guard', () => {
  it('no evidence → false', async () => {
    assert.equal(await hasReviewEvidence(tmpDir, 'x'), false);
  });

  it('evidence exists → true', async () => {
    const d = path.join(tmpDir, '.speccraft', 'runs', 'ry', 'tasks', 'ta', 'reviews', 'spec', 'attempt-001');
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, 'manifest.yaml'), '', 'utf8');
    assert.equal(await hasReviewEvidence(path.join(tmpDir, '.speccraft'), 'ry'), true);
  });
});

describe('M8.1 — Reviewer Profile ≠ Executor Profile', () => {
  it('same adapter different namespaces', () => {
    const c = parseReviewConfig({
      enabled: true,
      reviewers: { quality: { adapter: 'claude' } },
      gates: [{ id: 'quality', kind: 'code_quality', reviewer: 'quality' }],
    });
    assert.ok(c?.reviewers.quality);
    assert.equal(c.reviewers.quality.adapter, 'claude');
  });
});

describe('M8.4 — Structured Review Protocol', () => {
  it('valid no finding → PASS', () => {
    const out = parseReviewOutput('Here is my review:\n```speccraft-review\nversion: 1\nsummary: "Looks correct"\nfindings: []\n```\n');
    assert.ok(out);
    assert.equal(out.findings.length, 0);
    assert.equal(deriveReviewDecision(out.findings), 'pass');
  });

  it('minor only → PASS', () => {
    const out = parseReviewOutput('```speccraft-review\nversion: 1\nsummary: "Minor notes"\nfindings:\n  - severity: minor\n    category: maintainability\n    path: src/foo.ts\n    message: "could be shorter"\n```\n');
    assert.ok(out);
    assert.equal(deriveReviewDecision(out.findings), 'pass');
  });

  it('major → CHANGES_REQUIRED', () => {
    const out = parseReviewOutput('```speccraft-review\nversion: 1\nsummary: "Issues found"\nfindings:\n  - severity: major\n    category: correctness\n    path: src/foo.ts\n    line: 42\n    message: "null pointer risk"\n```\n');
    assert.ok(out);
    assert.equal(deriveReviewDecision(out.findings), 'changes_required');
  });

  it('blocker → CHANGES_REQUIRED', () => {
    const out = parseReviewOutput('```speccraft-review\nversion: 1\nsummary: "Critical"\nfindings:\n  - severity: blocker\n    category: spec\n    message: "missing required endpoint"\n```\n');
    assert.ok(out);
    assert.equal(deriveReviewDecision(out.findings), 'changes_required');
  });

  it('malformed → null (ERROR)', () => {
    const out = parseReviewOutput('Looks good to me!');
    assert.equal(out, null);
  });

  it('invalid severity → null (ERROR)', () => {
    const out = parseReviewOutput('```speccraft-review\nversion: 1\nsummary: "bad"\nfindings:\n  - severity: warning\n    category: spec\n    message: "x"\n```\n');
    assert.equal(out, null);
  });

  it('multiple machine blocks → null (fail-closed)', () => {
    const out = parseReviewOutput('```speccraft-review\nversion: 1\nsummary: "first"\nfindings: []\n```\n\n```speccraft-review\nversion: 1\nsummary: "second"\nfindings: []\n```\n');
    assert.equal(out, null, 'Multiple machine blocks must be rejected');
  });

  it('version != 1 → null', () => {
    const out = parseReviewOutput('```speccraft-review\nversion: 2\nsummary: "bad"\nfindings: []\n```\n');
    assert.equal(out, null);
  });

  it('empty message → null', () => {
    const out = parseReviewOutput('```speccraft-review\nversion: 1\nsummary: "ok"\nfindings:\n  - severity: minor\n    category: spec\n    message: ""\n```\n');
    assert.equal(out, null);
  });
});
