import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { createRun } from '../src/core/execution/store.js';
import {
  acceptanceFileName,
  isAcceptanceDecision,
} from '../src/core/acceptance/types.js';
import {
  stringifyAcceptanceRecord,
  parseAcceptanceRecord,
  renderAcceptanceBody,
} from '../src/core/acceptance/report.js';
import {
  writeAcceptanceRecord,
  readAcceptanceRecord,
  readLatestAcceptance,
  listAcceptanceRecords,
  nextAcceptanceAttempt,
} from '../src/core/acceptance/store.js';
import type { AcceptanceFrontmatter } from '../src/core/acceptance/types.js';

function fm(overrides: Partial<AcceptanceFrontmatter>): AcceptanceFrontmatter {
  return {
    kind: 'owner-acceptance',
    run_id: 'run-004',
    attempt: 1,
    decision: 'accepted',
    owner: 'owner',
    created_at: '2026-08-31T00:00:00.000Z',
    verification_attempt: 1,
    verification_status: 'pass',
    ...overrides,
  };
}

test('M3.1：first attempt == 001，second == 002', () => {
  assert.equal(acceptanceFileName(1), 'acceptance-001.md');
  assert.equal(acceptanceFileName(2), 'acceptance-002.md');
  assert.equal(acceptanceFileName(12), 'acceptance-012.md');
});

test('M3.1：isAcceptanceDecision 校验', () => {
  assert.equal(isAcceptanceDecision('accepted'), true);
  assert.equal(isAcceptanceDecision('rejected'), true);
  assert.equal(isAcceptanceDecision('bogus'), false);
});

test('M3.1：accepted record roundtrip', () => {
  const source = stringifyAcceptanceRecord(
    fm({ decision: 'accepted' }),
    renderAcceptanceBody('accepted', 'Owner acceptance passed.'),
  );
  const parsed = parseAcceptanceRecord(source);
  assert.equal(parsed.frontmatter.decision, 'accepted');
  assert.equal(parsed.frontmatter.run_id, 'run-004');
  assert.equal(parsed.frontmatter.verification_attempt, 1);
  assert.match(parsed.body, /ACCEPTED/);
  assert.match(parsed.body, /Owner acceptance passed\./);
});

test('M3.1：rejected record roundtrip', () => {
  const source = stringifyAcceptanceRecord(
    fm({ decision: 'rejected' }),
    renderAcceptanceBody('rejected', '交互逻辑不符合批准方案。'),
  );
  const parsed = parseAcceptanceRecord(source);
  assert.equal(parsed.frontmatter.decision, 'rejected');
  assert.match(parsed.body, /REJECTED/);
  assert.match(parsed.body, /交互逻辑不符合批准方案。/);
});

test('M3.1：store 写入 / latest / history / next attempt 序号', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-acc-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const run = await createRun(speccraftDir, { id: 'run-004' });

    // 首次无记录
    assert.equal(await readLatestAcceptance(speccraftDir, 'run-004'), null);
    assert.equal(await nextAcceptanceAttempt(speccraftDir, 'run-004'), 1);

    // attempt 1 rejected
    const f1 = await writeAcceptanceRecord(
      speccraftDir,
      'run-004',
      1,
      stringifyAcceptanceRecord(
        fm({ decision: 'rejected', attempt: 1 }),
        renderAcceptanceBody('rejected', '不好。'),
      ),
    );
    assert.equal(f1, 'acceptance/acceptance-001.md');
    assert.equal(await nextAcceptanceAttempt(speccraftDir, 'run-004'), 2);

    // attempt 2 accepted
    await writeAcceptanceRecord(
      speccraftDir,
      'run-004',
      2,
      stringifyAcceptanceRecord(
        fm({ decision: 'accepted', attempt: 2 }),
        renderAcceptanceBody('accepted', '通过。'),
      ),
    );

    const latest = await readLatestAcceptance(speccraftDir, 'run-004');
    assert.equal(latest?.frontmatter.decision, 'accepted');
    assert.equal(latest?.frontmatter.attempt, 2);

    const history = await listAcceptanceRecords(speccraftDir, 'run-004');
    assert.equal(history.length, 2);
    assert.equal(history[0].frontmatter.decision, 'rejected');
    assert.equal(history[1].frontmatter.decision, 'accepted');
    assert.equal(history[0].filename, 'acceptance/acceptance-001.md');
    assert.equal(history[1].filename, 'acceptance/acceptance-002.md');

    void run;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.1：禁止覆盖已有 record', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-acc-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    await createRun(speccraftDir, { id: 'run-004' });
    await writeAcceptanceRecord(
      speccraftDir,
      'run-004',
      1,
      stringifyAcceptanceRecord(fm({ decision: 'rejected' }), renderAcceptanceBody('rejected', 'x')),
    );
    await assert.rejects(
      () =>
        writeAcceptanceRecord(
          speccraftDir,
          'run-004',
          1,
          stringifyAcceptanceRecord(fm({ decision: 'accepted' }), renderAcceptanceBody('accepted', 'y')),
        ),
      /禁止覆盖/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M3.1：损坏 / 非法 record 被拒绝解析', () => {
  assert.throws(
    () => parseAcceptanceRecord('no frontmatter'),
    /缺少 YAML frontmatter/,
  );
  assert.throws(
    () => parseAcceptanceRecord('---\nkind: wrong\n---\n'),
    /kind 必须为 owner-acceptance/,
  );
  assert.throws(
    () =>
      parseAcceptanceRecord(
        stringifyAcceptanceRecord(fm({ decision: 'bogus' as never }), ''),
      ),
    /decision 非法/,
  );
});
