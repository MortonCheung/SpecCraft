import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { loadProject } from '../src/core/project.js';
import {
  generateRunId,
  createRun,
  readRun,
  writeRun,
  getActiveRun,
  listRuns,
  updateRunStatus,
  appendRunReport,
  parseRunManifest,
  stringifyRunManifest,
  runDir,
  RUNS_DIR,
} from '../src/core/execution/store.js';
import { captureGitSnapshot } from '../src/core/execution/git.js';
import { parseState, stringifyState, writeState } from '../src/core/state/store.js';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function makeProject(): Promise<string> {
  const dir = await initProject({ projectRoot: await mktmp() });
  return dir;
}

async function mktmp(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(os.tmpdir(), 'speccraft-m21-'));
}

test('M2.1：generateRunId 格式稳定可读', () => {
  const id = generateRunId(new Date('2026-08-31T10:30:12Z'));
  assert.match(id, /^run-20260831T103012-[0-9a-f]{8}$/);
  const ids = new Set(Array.from({ length: 200 }, () => generateRunId()));
  assert.equal(ids.size, 200);
});

test('M2.1：init 预创建 .speccraft/runs/ 目录', async () => {
  const root = await mktmp();
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    assert.equal(await exists(path.join(speccraftDir, RUNS_DIR)), true);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.1：createRun 创建 run 目录结构与 manifest', async () => {
  const root = await mktmp();
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const run = await createRun(speccraftDir, {
      id: 'run-test-00000001',
      baseGit: { branch: 'main', commit: 'abc123', dirty: false },
    });
    assert.equal(run.status, 'prepared');
    assert.equal(run.verificationAttempts, 0);
    assert.deepEqual(run.reports, []);

    const dir = runDir(speccraftDir, 'run-test-00000001');
    assert.equal(await exists(path.join(dir, 'manifest.yaml')), true);
    assert.equal(await exists(path.join(dir, 'verification')), true);
    assert.equal(await exists(path.join(dir, 'logs')), true);

    const back = await readRun(speccraftDir, 'run-test-00000001');
    assert.equal(back.id, 'run-test-00000001');
    assert.equal(back.status, 'prepared');
    assert.deepEqual(back.baseGit, { branch: 'main', commit: 'abc123', dirty: false });
    assert.equal(back.contextFile, 'context.md');
    assert.equal(back.promptFile, 'agent-prompt.md');
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.1：旧项目无 runs/ 目录时 createRun 自动创建', async () => {
  const root = await mktmp();
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    // 模拟旧项目：删除 runs/ 目录
    const { rm } = await import('node:fs/promises');
    await rm(path.join(speccraftDir, RUNS_DIR), { recursive: true, force: true });
    const run = await createRun(speccraftDir, {});
    assert.equal(await exists(runDir(speccraftDir, run.id)), true);
    assert.deepEqual(await listRuns(speccraftDir), [run.id]);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.1：updateRunStatus / appendRunReport / writeRun 持久化', async () => {
  const root = await mktmp();
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const run = await createRun(speccraftDir, { id: 'run-test-00000002' });

    await updateRunStatus(speccraftDir, run, 'in_progress');
    run.startedAt = new Date().toISOString();
    await writeRun(speccraftDir, run);
    await appendRunReport(speccraftDir, run, {
      file: 'agent-report-001.md',
      recordedAt: new Date().toISOString(),
    });

    const back = await readRun(speccraftDir, 'run-test-00000002');
    assert.equal(back.status, 'in_progress');
    assert.equal(back.reports.length, 1);
    assert.equal(back.reports[0].file, 'agent-report-001.md');
    assert.ok(back.startedAt);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.1：getActiveRun 未设置 / 不存在时返回 null', async () => {
  const root = await mktmp();
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    assert.equal(await getActiveRun(speccraftDir, undefined), null);
    assert.equal(await getActiveRun(speccraftDir, 'run-not-exist'), null);

    const run = await createRun(speccraftDir, { id: 'run-test-00000003' });
    const active = await getActiveRun(speccraftDir, 'run-test-00000003');
    assert.equal(active?.id, run.id);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.1：readRun 不存在时抛错', async () => {
  const root = await mktmp();
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    await assert.rejects(() => readRun(speccraftDir, 'run-nope'), /Run 不存在/);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.1：manifest parse/stringify 往返（含 finalGit）', () => {
  const manifest = parseRunManifest(
    stringifyRunManifest({
      id: 'run-x',
      status: 'awaiting_verification',
      createdAt: '2026-08-31T00:00:00Z',
      updatedAt: '2026-08-31T01:00:00Z',
      startedAt: '2026-08-31T00:10:00Z',
      finishedAt: '2026-08-31T00:50:00Z',
      baseGit: { branch: 'feat/a', commit: 'aaa', dirty: true },
      finalGit: { branch: 'feat/a', commit: 'bbb', dirty: false },
      contextFile: 'context.md',
      promptFile: 'agent-prompt.md',
      reports: [{ file: 'agent-report-001.md', recordedAt: '2026-08-31T00:50:00Z' }],
      verificationAttempts: 2,
    }),
  );
  assert.equal(manifest.id, 'run-x');
  assert.equal(manifest.status, 'awaiting_verification');
  assert.deepEqual(manifest.finalGit, { branch: 'feat/a', commit: 'bbb', dirty: false });
  assert.equal(manifest.reports.length, 1);
  assert.equal(manifest.verificationAttempts, 2);
});

test('M2.1：state.active_run 兼容旧 state.yaml（缺省可加载）', async () => {
  const root = await mktmp();
  try {
    const { speccraftDir, state } = await initProject({ projectRoot: root });

    // 旧格式：没有 active_run 字段
    const legacy = parseState(
      (await readFile(path.join(speccraftDir, 'state.yaml'), 'utf8'))
        .split('\n')
        .filter((line) => !line.startsWith('active_run:'))
        .join('\n'),
    );
    assert.equal(legacy.active_run, undefined);

    // 新格式：写入后可读回
    state.active_run = 'run-test-00000004';
    await writeState(speccraftDir, state);
    const { state: back } = await loadProject(root);
    assert.equal(back.active_run, 'run-test-00000004');

    // roundtrip
    const round = parseState(stringifyState(state));
    assert.equal(round.active_run, 'run-test-00000004');
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.1：captureGitSnapshot 在非 Git 目录返回 null（不报致命错误）', async () => {
  const root = await mktmp();
  try {
    const snapshot = await captureGitSnapshot(root);
    assert.equal(snapshot, null);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.1：captureGitSnapshot 在真实 Git 仓库返回快照', async () => {
  // SpecCraft 自身就是 Git 仓库
  const snapshot = await captureGitSnapshot(process.cwd());
  assert.ok(snapshot);
  assert.ok(typeof snapshot.commit === 'string' && snapshot.commit.length > 0);
});
