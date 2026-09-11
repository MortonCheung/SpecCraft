/**
 * SpecCraft v0.9 §70 —— Commit 2 单元测试。
 *
 * 覆盖：Change ID allocation / baseline snapshot / raw-byte digest /
 * bundle digest stability / state transitions / active change detection。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { createRun } from '../src/core/execution/store.js';
import { loadProject } from '../src/core/project.js';
import { sha256Bytes, sha256File, bundleDigest } from '../src/core/changes/digest.js';
import {
  ChangeError,
  CHANGE_SET_STATUSES,
  CHANGE_SOURCES,
  canTransitionChange,
  isActiveChangeStatus,
  isChangeSetStatus,
  isChangeSource,
} from '../src/core/changes/types.js';
import type { ChangeSetManifest } from '../src/core/changes/types.js';
import {
  allocateChangeDir,
  changeDir,
  discardChangeDir,
  findActiveChangeForRun,
  formatChangeId,
  isChangeId,
  listChangeIds,
  listChangeManifests,
  nextChangeNumber,
  parseChangeManifest,
  parseChangeNumber,
  readChangeManifest,
  readChangeManifestOrNull,
  readChangeRequestOrNull,
  stringifyChangeManifest,
  updateChangeStatus,
  writeChangeManifest,
} from '../src/core/changes/store.js';
import { createChange } from '../src/core/changes/create.js';
import { cmdChangesCreate, cmdChangesList, cmdChangesShow } from '../src/cli/commands.js';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function newProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-change-'));
  await initProject({ projectRoot: root });
  return root;
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

function sampleManifest(overrides: Partial<ChangeSetManifest> = {}): ChangeSetManifest {
  return {
    id: 'change-001',
    status: 'draft',
    baseRunId: 'run-1',
    source: 'owner',
    reason: '新增安全需求',
    createdAt: '2026-09-12T00:00:00.000Z',
    gitHead: null,
    workflow: { name: 'default', version: '1', digest: 'w-digest' },
    projectDigest: 'p-digest',
    artifacts: [
      {
        stage: 'requirement',
        artifact: 'requirements',
        path: 'baseline/artifacts/requirement.md',
        sha256: 'a'.repeat(64),
      },
    ],
    baseTaskGraphDigest: null,
    baseExecutorPlanDigest: null,
    baseReviewPlanDigest: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------- Change ID

test('v0.9 §8：Change ID 确定性格式与解析', () => {
  assert.equal(formatChangeId(1), 'change-001');
  assert.equal(formatChangeId(42), 'change-042');
  assert.equal(formatChangeId(1000), 'change-1000');
  assert.throws(() => formatChangeId(0), /非法 Change 编号/);
  assert.throws(() => formatChangeId(-1), /非法 Change 编号/);

  assert.equal(parseChangeNumber('change-001'), 1);
  assert.equal(parseChangeNumber('change-1000'), 1000);
  assert.equal(parseChangeNumber('change-0'), null);
  assert.equal(parseChangeNumber('change-abc'), null);
  assert.equal(parseChangeNumber('change-001-x'), null);
  assert.equal(parseChangeNumber('001'), null);
  assert.equal(isChangeId('change-001'), true);
  assert.equal(isChangeId('notes'), false);
  assert.equal(isChangeId(1), false);
});

test('v0.9 §8：编号分配防碰撞且忽略非 change 目录', async () => {
  const root = await newProject();
  try {
    const speccraftDir = path.join(root, '.speccraft');
    assert.deepEqual(await listChangeIds(speccraftDir), []);
    assert.equal(await nextChangeNumber(speccraftDir), 1);

    const first = await allocateChangeDir(speccraftDir);
    assert.equal(first.changeId, 'change-001');
    const second = await allocateChangeDir(speccraftDir);
    assert.equal(second.changeId, 'change-002');
    assert.notEqual(first.dir, second.dir);

    // 非 change-NNN 目录不参与编号
    await mkdir(path.join(speccraftDir, 'changes', 'notes'), { recursive: true });
    assert.deepEqual(await listChangeIds(speccraftDir), ['change-001', 'change-002']);
    assert.equal(await nextChangeNumber(speccraftDir), 3);

    // 丢弃后编号不被复用（目录已存在则跳过）
    await discardChangeDir(speccraftDir, 'change-002');
    assert.deepEqual(await listChangeIds(speccraftDir), ['change-001']);
    assert.equal((await allocateChangeDir(speccraftDir)).changeId, 'change-002');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- manifest IO

test('v0.9 §9：change manifest stringify/parse 往返', () => {
  const manifest = sampleManifest({ sourceRef: 'review/report.md', gitHead: 'abc123' });
  const round = parseChangeManifest(stringifyChangeManifest(manifest));
  assert.deepEqual(round, manifest);
});

test('v0.9 §9：manifest 缺失字段（gitHead/projectDigest/plan digests）保持 null', () => {
  const manifest = sampleManifest();
  const round = parseChangeManifest(stringifyChangeManifest(manifest));
  assert.equal(round.gitHead, null);
  assert.equal(round.baseTaskGraphDigest, null);
  assert.equal(round.baseExecutorPlanDigest, null);
  assert.equal(round.baseReviewPlanDigest, null);
  assert.equal(round.sourceRef, undefined);
});

test('v0.9 §9：manifest 非法输入被拒绝', () => {
  assert.throws(
    () => parseChangeManifest('id: bogus\nstatus: draft\nbase_run_id: r\nsource: owner\nworkflow: {name: a, version: "1"}\n'),
    /id 非法/,
  );
  assert.throws(
    () => parseChangeManifest('id: change-001\nstatus: bogus\nbase_run_id: r\nsource: owner\nworkflow: {name: a, version: "1"}\n'),
    /status 非法/,
  );
  assert.throws(
    () => parseChangeManifest('id: change-001\nstatus: draft\nsource: owner\nworkflow: {name: a, version: "1"}\n'),
    /缺少 base_run_id/,
  );
  assert.throws(
    () => parseChangeManifest('id: change-001\nstatus: draft\nbase_run_id: r\nsource: bogus\nworkflow: {name: a, version: "1"}\n'),
    /source 非法/,
  );
  assert.throws(
    () => parseChangeManifest('id: change-001\nstatus: draft\nbase_run_id: r\nsource: owner\n'),
    /缺少 workflow 身份/,
  );
});

test('v0.9 §9：readChangeManifest 不存在时抛错，OrNull 返回 null', async () => {
  const root = await newProject();
  try {
    const speccraftDir = path.join(root, '.speccraft');
    await assert.rejects(() => readChangeManifest(speccraftDir, 'change-001'), /Change 不存在/);
    assert.equal(await readChangeManifestOrNull(speccraftDir, 'change-001'), null);

    await writeChangeManifest(speccraftDir, sampleManifest());
    const back = await readChangeManifest(speccraftDir, 'change-001');
    assert.equal(back.reason, '新增安全需求');
    assert.equal(await exists(path.join(changeDir(speccraftDir, 'change-001'), 'manifest.yaml')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------- state machine

test('v0.9 §7：Change 状态集合与合法迁移', () => {
  assert.deepEqual(CHANGE_SET_STATUSES, [
    'draft',
    'analyzed',
    'approved',
    'materialized',
    'closed',
    'rejected',
  ]);
  for (const s of CHANGE_SET_STATUSES) assert.equal(isChangeSetStatus(s), true);
  assert.equal(isChangeSetStatus('bogus'), false);

  assert.equal(canTransitionChange('draft', 'analyzed'), true);
  assert.equal(canTransitionChange('draft', 'rejected'), true);
  assert.equal(canTransitionChange('analyzed', 'approved'), true);
  assert.equal(canTransitionChange('analyzed', 'rejected'), true);
  assert.equal(canTransitionChange('approved', 'materialized'), true);
  assert.equal(canTransitionChange('materialized', 'closed'), true);

  // 禁止跳步 / 回退 / 终态再迁移
  assert.equal(canTransitionChange('draft', 'approved'), false);
  assert.equal(canTransitionChange('draft', 'materialized'), false);
  assert.equal(canTransitionChange('analyzed', 'materialized'), false);
  assert.equal(canTransitionChange('approved', 'closed'), false);
  assert.equal(canTransitionChange('materialized', 'approved'), false);
  assert.equal(canTransitionChange('closed', 'draft'), false);
  assert.equal(canTransitionChange('rejected', 'draft'), false);
});

test('v0.9 §61：active 状态判定（draft/analyzed/approved/materialized 冻结 base Run）', () => {
  for (const s of ['draft', 'analyzed', 'approved', 'materialized'] as const) {
    assert.equal(isActiveChangeStatus(s), true);
  }
  assert.equal(isActiveChangeStatus('closed'), false);
  assert.equal(isActiveChangeStatus('rejected'), false);
});

test('v0.9 §7：updateChangeStatus 合法迁移落盘，非法迁移抛 invalid_change_transition', async () => {
  const root = await newProject();
  try {
    const speccraftDir = path.join(root, '.speccraft');
    const manifest = sampleManifest();
    await writeChangeManifest(speccraftDir, manifest);

    await updateChangeStatus(speccraftDir, manifest, 'analyzed');
    assert.equal((await readChangeManifest(speccraftDir, 'change-001')).status, 'analyzed');

    // 非法：analyzed → materialized
    await assert.rejects(
      () => updateChangeStatus(speccraftDir, manifest, 'materialized'),
      (err: unknown) => {
        assert.ok(err instanceof ChangeError);
        assert.equal((err as ChangeError).code, 'invalid_change_transition');
        return true;
      },
    );
    // 状态未被隐式修改
    assert.equal((await readChangeManifest(speccraftDir, 'change-001')).status, 'analyzed');

    await updateChangeStatus(speccraftDir, manifest, 'rejected');
    assert.equal((await readChangeManifest(speccraftDir, 'change-001')).status, 'rejected');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------- digest

test('v0.9 §11：sha256Bytes 对原始字节稳定且不 trim', () => {
  // 标准向量：空串
  assert.equal(
    sha256Bytes(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(sha256Bytes('abc'), sha256Bytes(Buffer.from('abc', 'utf8')));
  // raw-byte 规则：带尾随空白的字节与其 trim 结果不同
  assert.notEqual(sha256Bytes('abc \n'), sha256Bytes('abc'));
  // 换行风格不同 => digest 不同（不做 normalize）
  assert.notEqual(sha256Bytes('a\nb'), sha256Bytes('a\r\nb'));
});

test('v0.9 §11：sha256File 基于文件原始字节', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-digest-'));
  try {
    const file = path.join(root, 'artifact.md');
    const bytes = Buffer.from('# Title\n\n  keep  trailing  \n', 'utf8');
    await writeFile(file, bytes);
    assert.equal(await sha256File(file), sha256Bytes(bytes));
    assert.equal(await sha256File(file), sha256Bytes(await readFile(file)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §12：bundleDigest 顺序无关、内容敏感', () => {
  const entries = [
    { path: 'artifacts/design.md', sha256: 'b'.repeat(64) },
    { path: 'artifacts/requirement.md', sha256: 'a'.repeat(64) },
    { path: 'project.yaml', sha256: 'c'.repeat(64) },
  ];
  const reversed = [...entries].reverse();

  assert.equal(bundleDigest(entries), bundleDigest(reversed));
  assert.equal(bundleDigest(entries), bundleDigest(entries));

  // 与手工构造的规范载荷一致：路径升序 + `<path>\0<sha>\n`
  const canonical = [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((e) => `${e.path}\0${e.sha256}\n`)
    .join('');
  assert.equal(bundleDigest(entries), sha256Bytes(canonical));

  // 任一文件 digest 变化 => bundle 变化
  const mutated = entries.map((e) =>
    e.path === 'project.yaml' ? { ...e, sha256: 'd'.repeat(64) } : e,
  );
  assert.notEqual(bundleDigest(entries), bundleDigest(mutated));

  // 路径变化 => bundle 变化
  const renamed = entries.map((e) =>
    e.path === 'project.yaml' ? { ...e, path: 'project-2.yaml' } : e,
  );
  assert.notEqual(bundleDigest(entries), bundleDigest(renamed));

  assert.equal(bundleDigest([]), sha256Bytes(''));
});

// ------------------------------------------------------------- createChange

test('v0.9 §10–§11：createChange 做真实字节 baseline snapshot 并捕获 digests', async () => {
  const root = await newProject();
  try {
    const speccraftDir = path.join(root, '.speccraft');
    const run = await createRun(speccraftDir, { id: 'run-1' });
    const { workflow } = await loadProject(root);

    // 只产出 requirement 阶段的 canonical artifact，design 尚未产出
    const bytes = Buffer.from('# Requirements\n\n  保留尾随空白  \n', 'utf8');
    await writeFile(path.join(speccraftDir, 'artifacts', 'requirements.md'), bytes);

    const manifest = await createChange({
      speccraftDir,
      projectRoot: root,
      workflow,
      baseRunId: run.id,
      reason: '新增安全需求',
      now: new Date('2026-09-12T00:00:00.000Z'),
    });

    assert.equal(manifest.id, 'change-001');
    assert.equal(manifest.status, 'draft');
    assert.equal(manifest.baseRunId, 'run-1');
    assert.equal(manifest.source, 'owner');
    assert.equal(manifest.createdAt, '2026-09-12T00:00:00.000Z');
    assert.equal(manifest.workflow.name, workflow.name);
    assert.equal(manifest.workflow.version, workflow.version);
    assert.equal(manifest.workflow.digest, await sha256File(path.join(speccraftDir, 'workflow.yaml')));
    assert.equal(manifest.projectDigest, await sha256File(path.join(speccraftDir, 'project.yaml')));
    assert.equal(manifest.gitHead, null); // 临时目录不是 Git 仓库

    // 只记录真实存在的 canonical artifact；未产出的不伪造
    const stages = manifest.artifacts.map((a) => a.stage);
    assert.deepEqual(stages, ['requirement']);
    const baseline = manifest.artifacts[0];
    assert.equal(baseline.artifact, 'requirements');
    assert.equal(baseline.path, 'baseline/artifacts/requirement.md');
    assert.equal(baseline.sha256, sha256Bytes(bytes));
    // raw-byte 规则：不是 trim 后的 digest
    assert.notEqual(baseline.sha256, sha256Bytes(bytes.toString('utf8').trim()));

    // 快照内容与 canonical 原始字节逐字节一致
    const snapshot = path.join(
      changeDir(speccraftDir, 'change-001'),
      'baseline',
      'artifacts',
      'requirement.md',
    );
    assert.deepEqual(await readFile(snapshot), bytes);
    assert.equal(await sha256File(snapshot), baseline.sha256);

    // baseline/manifest.yaml 与 request.md 被写入
    assert.equal(
      await exists(path.join(changeDir(speccraftDir, 'change-001'), 'baseline', 'manifest.yaml')),
      true,
    );
    assert.equal(await readChangeRequestOrNull(speccraftDir, 'change-001'), '新增安全需求');

    // 尚无 frozen plan => digest 为 null（不伪造）
    assert.equal(manifest.baseTaskGraphDigest, null);
    assert.equal(manifest.baseExecutorPlanDigest, null);
    assert.equal(manifest.baseReviewPlanDigest, null);

    // 落盘 manifest 可被读回
    assert.deepEqual(await readChangeManifest(speccraftDir, 'change-001'), manifest);
    assert.deepEqual(await listChangeManifests(speccraftDir), [manifest]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §61：同一 base Run 只允许一个 active Change', async () => {
  const root = await newProject();
  try {
    const speccraftDir = path.join(root, '.speccraft');
    const run = await createRun(speccraftDir, { id: 'run-1' });
    const { workflow } = await loadProject(root);
    const base = { speccraftDir, projectRoot: root, workflow, baseRunId: run.id };

    const first = await createChange({ ...base, reason: '第一次变更' });
    assert.equal((await findActiveChangeForRun(speccraftDir, 'run-1'))?.id, first.id);

    await assert.rejects(
      () => createChange({ ...base, reason: '第二次变更' }),
      (err: unknown) => {
        assert.ok(err instanceof ChangeError);
        assert.equal((err as ChangeError).code, 'change_already_active');
        return true;
      },
    );
    // 失败不留下半成品目录
    assert.deepEqual(await listChangeIds(speccraftDir), ['change-001']);

    // rejected 之后 base Run 恢复可执行 => 可创建后继 Change
    const manifest = await readChangeManifest(speccraftDir, first.id);
    await updateChangeStatus(speccraftDir, manifest, 'rejected');
    assert.equal(await findActiveChangeForRun(speccraftDir, 'run-1'), null);

    const second = await createChange({ ...base, reason: '第二次变更' });
    assert.equal(second.id, 'change-002');
    assert.equal((await findActiveChangeForRun(speccraftDir, 'run-1'))?.id, 'change-002');
    // 另一个 Run 不受影响
    assert.equal(await findActiveChangeForRun(speccraftDir, 'run-2'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §10：base Run 的 frozen plan digest 在存在时被记录', async () => {
  const root = await newProject();
  try {
    const speccraftDir = path.join(root, '.speccraft');
    const run = await createRun(speccraftDir, { id: 'run-1' });
    const { workflow } = await loadProject(root);

    const graphPath = path.join(speccraftDir, 'runs', 'run-1', 'tasks', 'graph.yaml');
    await mkdir(path.dirname(graphPath), { recursive: true });
    await writeFile(graphPath, 'version: 1\nrun_id: run-1\ntasks: []\n', 'utf8');

    const manifest = await createChange({
      speccraftDir,
      projectRoot: root,
      workflow,
      baseRunId: 'run-1',
      reason: '变更',
    });
    assert.equal(manifest.baseTaskGraphDigest, await sha256File(graphPath));
    assert.equal(manifest.baseExecutorPlanDigest, null);
    assert.equal(manifest.baseReviewPlanDigest, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §10：createChange 拒绝空请求与不存在的 base Run', async () => {
  const root = await newProject();
  try {
    const speccraftDir = path.join(root, '.speccraft');
    await createRun(speccraftDir, { id: 'run-1' });
    const { workflow } = await loadProject(root);
    const base = { speccraftDir, projectRoot: root, workflow, baseRunId: 'run-1' };

    await assert.rejects(() => createChange({ ...base, reason: '   ' }), /不能为空/);
    await assert.rejects(
      () => createChange({ ...base, reason: 'ok', baseRunId: 'run-none' }),
      /Run 不存在|不存在/,
    );
    // 无成功创建
    assert.deepEqual(await listChangeIds(speccraftDir), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- CLI surface

test('v0.9 §87：changes create/list/show CLI', async () => {
  const root = await newProject();
  try {
    const speccraftDir = path.join(root, '.speccraft');
    await createRun(speccraftDir, { id: 'run-1' });
    await writeFile(
      path.join(speccraftDir, 'artifacts', 'requirements.md'),
      '# Requirements\n',
      'utf8',
    );

    const created = await captureStdout(() =>
      cmdChangesCreate({ baseRun: 'run-1', reason: '新增安全需求', source: 'review' }, root),
    );
    assert.match(created, /已创建 Change Set：change-001/);
    assert.match(created, /base run: run-1/);
    assert.match(created, /source: review/);
    assert.match(created, /status: draft/);
    assert.match(created, /baseline artifacts: 1/);

    const listed = await captureStdout(() => cmdChangesList(root));
    assert.match(listed, /ID\s+BASE RUN\s+STATUS\s+SOURCE/);
    assert.match(listed, /change-001\s+run-1\s+draft\s+review/);

    const shown = await captureStdout(() => cmdChangesShow('change-001', root));
    assert.match(shown, /Change Set：change-001/);
    assert.match(shown, /status: draft/);
    assert.match(shown, /Request:[\s\S]*新增安全需求/);
    assert.match(shown, /Baseline:/);
    assert.match(shown, /requirement → requirements/);
    assert.match(shown, /Proposal：（无）/);
    assert.match(shown, /Approval：（无）/);

    // show 是只读的，不改变状态
    const after = await readChangeManifest(speccraftDir, 'change-001');
    assert.equal(after.status, 'draft');

    // 空项目 list 输出
    const emptyRoot = await newProject();
    try {
      const empty = await captureStdout(() => cmdChangesList(emptyRoot));
      assert.match(empty, /没有 Change Set/);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §87：changes create 参数校验与 --file 输入', async () => {
  const root = await newProject();
  try {
    const speccraftDir = path.join(root, '.speccraft');
    await createRun(speccraftDir, { id: 'run-1' });

    await assert.rejects(() => cmdChangesCreate({ reason: 'x' }, root), /需要 --base-run/);
    await assert.rejects(
      () => cmdChangesCreate({ baseRun: 'run-1' }, root),
      /必须且只能提供 --reason <text> 或 --file <path> 之一/,
    );
    await assert.rejects(
      () => cmdChangesCreate({ baseRun: 'run-1', reason: 'a', file: 'b' }, root),
      /必须且只能提供 --reason <text> 或 --file <path> 之一/,
    );
    await assert.rejects(
      () => cmdChangesCreate({ baseRun: 'run-1', reason: 'a', source: 'bogus' }, root),
      /--source 非法/,
    );
    assert.deepEqual(await listChangeIds(speccraftDir), []);

    // --file 读取文件内容作为请求正文
    const file = path.join(root, 'request.md');
    await writeFile(file, '来自文件的变更请求\n', 'utf8');
    await captureStdout(() => cmdChangesCreate({ baseRun: 'run-1', file }, root));
    assert.equal(await readChangeRequestOrNull(speccraftDir, 'change-001'), '来自文件的变更请求\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v0.9 §10：Change 来源枚举', () => {
  assert.deepEqual(CHANGE_SOURCES, ['owner', 'review', 'verification', 'site-survey', 'external']);
  for (const s of CHANGE_SOURCES) assert.equal(isChangeSource(s), true);
  assert.equal(isChangeSource('bogus'), false);
});
