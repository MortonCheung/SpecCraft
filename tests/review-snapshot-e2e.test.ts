/**
 * v0.8 E2E F / G / H — Exact Snapshot Hardening（SpecCraft v0.8 §22 + §3.1-§4.1）。
 *
 * 全部使用真实 git（linked worktree / read-tree / commit-tree / diff-tree），不 mock：
 *
 *   F — Linked Worktree Snapshot：`.git` 是 gitfile 的 linked worktree 里
 *       captureTreeSnapshot() 必须成功，且 real index / working tree / HEAD 不被污染。
 *   G — `.speccraft` Runtime Exclusion：即使 `.speccraft/` 未被 ignore（甚至被 track），
 *       snapshot tree 绝不含任何 `.speccraft` 条目。
 *   H — Synthetic Parent Chain：postCommit 的 parent 必须是 preCommit；
 *       review worktree 满足 HEAD == postCommit、HEAD^ == preCommit、
 *       `git diff HEAD^ HEAD` == exact delta。
 *   + §4.1 — Runtime Git Identity：无 user.name/user.email 的仓库 commit-tree 仍成功，
 *     author/committer 固定为 SpecCraft Runtime。
 *   + §3.2 — read-tree HEAD 基底：被 .gitignore 但已被 track 的文件必须留在 snapshot
 *     （不能被空 index add -A 的错误实现吞掉）。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  captureTreeSnapshot,
  computeExactDelta,
  createReviewWorktree,
  removeReviewWorktree,
  checkReviewerMutation,
} from '../src/core/reviews/snapshot.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'snapshot-e2e-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

/** 真实 git helper（execFileSync 数组形式，不经 shell；stdout trim；失败即抛错） */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
}

function treeFiles(root: string, treeId: string): string[] {
  return git(root, ['ls-tree', '-r', '--name-only', treeId]).split('\n').filter(Boolean);
}

// ============================================================================
// E2E F — Linked Worktree Snapshot（§3.1）
// ============================================================================

describe('E2E F — Linked Worktree Snapshot', () => {
  it('captureTreeSnapshot succeeds inside a linked worktree (.git is a gitfile)', async () => {
    const main = path.join(tmpRoot, 'main');
    await mkdir(main, { recursive: true });
    git(main, ['init', '-q']);
    git(main, ['config', 'user.email', 'a@b.c']);
    git(main, ['config', 'user.name', 'T']);
    await writeFiles(main, { 'src/a.txt': 'one', 'src/base.txt': 'base' });
    git(main, ['add', '-A']);
    git(main, ['commit', '-qm', 'init']);

    // linked worktree（parallel workspace 的形态）
    const wt = path.join(tmpRoot, 'wt');
    git(main, ['worktree', 'add', '-q', '-d', wt, 'HEAD']);
    const gitFile = await readFile(path.join(wt, '.git'), 'utf8');
    assert.ok(gitFile.startsWith('gitdir:'), `linked worktree .git must be a gitfile, got: ${gitFile}`);

    // executor 在 linked worktree 里产生变更（含新增 + 修改）
    await writeFiles(wt, { 'src/a.txt': 'two', 'src/new.txt': 'fresh' });

    const snap = await captureTreeSnapshot(wt, 'pre-test', 'Review pre-snapshot: E2E F');
    assert.equal(snap.ok, true, snap.error);
    assert.match(snap.commitId, /^[0-9a-f]{40}$/);
    assert.match(snap.treeId, /^[0-9a-f]{40}$/);

    // snapshot tree 反映 working tree 变更
    const files = treeFiles(wt, snap.treeId);
    assert.ok(files.includes('src/new.txt'), 'snapshot must include new untracked file');
    assert.ok(files.includes('src/a.txt'));

    // real index / working tree 未被污染：变更仍未 staged（alternate index 独立于 real index）
    const status = git(wt, ['status', '--porcelain']);
    const statusLines = status.split('\n');
    assert.ok(statusLines.some((l) => /^ ?M src\/a\.txt$/.test(l)),
      `a.txt must remain unstaged-modified (XY=M in worktree column), status: ${status}`);
    assert.ok(statusLines.some((l) => /^\?\? src\/new\.txt$/.test(l)),
      `new.txt must remain untracked, status: ${status}`);

    // source HEAD 未被移动
    assert.equal(git(wt, ['rev-parse', 'HEAD']), git(main, ['rev-parse', 'HEAD']));

    git(main, ['worktree', 'remove', '--force', wt]);
  });

  it('captureTreeSnapshot succeeds in a linked worktree used as review host (post → worktree add)', async () => {
    const main = path.join(tmpRoot, 'main2');
    await mkdir(main, { recursive: true });
    git(main, ['init', '-q']);
    git(main, ['config', 'user.email', 'a@b.c']);
    git(main, ['config', 'user.name', 'T']);
    await writeFiles(main, { 'src/a.txt': 'one' });
    git(main, ['add', '-A']);
    git(main, ['commit', '-qm', 'init']);

    const wt = path.join(tmpRoot, 'wt2');
    git(main, ['worktree', 'add', '-q', '-d', wt, 'HEAD']);

    const pre = await captureTreeSnapshot(wt, 'pre-wt2', 'pre');
    assert.equal(pre.ok, true, pre.error);
    await writeFiles(wt, { 'src/a.txt': 'changed' });
    const post = await captureTreeSnapshot(wt, 'post-wt2', 'post', pre.commitId);
    assert.equal(post.ok, true, post.error);

    // 从 linked worktree 再衍生 detached review worktree
    const rwPath = path.join(tmpRoot, 'rw2');
    const rw = await createReviewWorktree(wt, rwPath, post.commitId);
    assert.equal(rw.ok, true, rw.error);
    try {
      assert.equal(git(rwPath, ['rev-parse', 'HEAD']), post.commitId);
    } finally {
      const removed = await removeReviewWorktree(wt, rwPath);
      assert.equal(removed.ok, true, removed.error);
    }
    git(main, ['worktree', 'remove', '--force', wt]);
  });
});

// ============================================================================
// E2E G — `.speccraft` Runtime Exclusion（§3.3）
// ============================================================================

describe('E2E G — .speccraft Runtime Exclusion', () => {
  it('snapshot never contains .speccraft even when tracked, written, and not ignored', async () => {
    const repo = path.join(tmpRoot, 'g');
    await mkdir(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'a@b.c']);
    git(repo, ['config', 'user.name', 'T']);
    // .speccraft/ 被 track 进 HEAD，且没有 .gitignore
    await writeFiles(repo, {
      'src/a.txt': 'one',
      '.speccraft/tracked.txt': 'tracked runtime file',
    });
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init with tracked .speccraft']);

    // runtime 再写入 untracked .speccraft 文件 + 任务真实变更
    await writeFiles(repo, {
      '.speccraft/runs/run-1/runtime.bin': 'secret',
      'src/a.txt': 'two',
      'src/b.txt': 'b',
    });

    const snap = await captureTreeSnapshot(repo, 'post-g', 'Review post-snapshot: E2E G');
    assert.equal(snap.ok, true, snap.error);

    const files = treeFiles(repo, snap.treeId);
    assert.ok(!files.some((f) => f.startsWith('.speccraft/')), `tree must exclude .speccraft, got: ${files.join(', ')}`);
    assert.ok(files.includes('src/b.txt'), 'normal new file must be included');
    assert.ok(files.includes('src/a.txt'));

    // source repo 未被修改：HEAD tree 仍保留被 track 的 .speccraft/tracked.txt
    const headFiles = treeFiles(repo, 'HEAD');
    assert.ok(headFiles.includes('.speccraft/tracked.txt'), 'source HEAD must keep tracked .speccraft file');
    assert.equal(git(repo, ['status', '--porcelain']).includes('.speccraft'), true,
      'untracked .speccraft still visible to real status (no .gitignore pollution)');
  });

  it('snapshot captures the exact task delta without .speccraft noise (computeExactDelta)', async () => {
    const repo = path.join(tmpRoot, 'g2');
    await mkdir(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'a@b.c']);
    git(repo, ['config', 'user.name', 'T']);
    await writeFiles(repo, { 'src/a.txt': 'one' });
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);

    const pre = await captureTreeSnapshot(repo, 'pre-g2', 'pre');
    assert.equal(pre.ok, true, pre.error);
    await writeFiles(repo, { 'src/a.txt': 'two', '.speccraft/run.bin': 'x' });
    const post = await captureTreeSnapshot(repo, 'post-g2', 'post', pre.commitId);
    assert.equal(post.ok, true, post.error);

    const delta = await computeExactDelta(repo, pre.commitId, post.commitId);
    assert.equal(delta.ok, true, delta.error);
    assert.ok(delta.patch.includes('+two'), 'delta must contain task change');
    assert.ok(!delta.patch.includes('.speccraft'), 'delta must not contain .speccraft');
  });
});

// ============================================================================
// E2E H — Synthetic Parent Chain（§3.2 + §4）
// ============================================================================

describe('E2E H — Synthetic Parent Chain', () => {
  it('review worktree: HEAD == postCommit, HEAD^ == preCommit, diff HEAD^ HEAD == exact delta', async () => {
    const repo = path.join(tmpRoot, 'h');
    await mkdir(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'a@b.c']);
    git(repo, ['config', 'user.name', 'T']);
    await writeFiles(repo, { 'src/a.txt': 'one', 'README.md': 'readme' });
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);
    const sourceHead = git(repo, ['rev-parse', 'HEAD']);

    // pre snapshot（dispatch 前）：parent 自动 = source HEAD
    const pre = await captureTreeSnapshot(repo, 'pre-h', 'Review pre-snapshot: h');
    assert.equal(pre.ok, true, pre.error);
    assert.equal(git(repo, ['rev-parse', `${pre.commitId}^`]), sourceHead,
      'preCommit parent must be source HEAD');

    // executor 产生变更
    await writeFiles(repo, { 'src/a.txt': 'two', 'src/new.txt': 'added' });

    // post snapshot：parent = preCommit（与 orchestrator 调用一致）
    const post = await captureTreeSnapshot(repo, 'post-h', 'Review post-snapshot: h', pre.commitId);
    assert.equal(post.ok, true, post.error);
    assert.equal(git(repo, ['rev-parse', `${post.commitId}^`]), pre.commitId,
      'postCommit parent must be preCommit');

    // exact delta
    const delta = await computeExactDelta(repo, pre.commitId, post.commitId);
    assert.equal(delta.ok, true, delta.error);

    // review worktree
    const rwPath = path.join(tmpRoot, 'h-review-wt');
    const rw = await createReviewWorktree(repo, rwPath, post.commitId);
    assert.equal(rw.ok, true, rw.error);
    try {
      assert.equal(git(rwPath, ['rev-parse', 'HEAD']), post.commitId);
      assert.equal(git(rwPath, ['rev-parse', 'HEAD^']), pre.commitId,
        'review worktree HEAD^ must == preCommit');

      const worktreeDiff = git(rwPath, ['diff', 'HEAD^', 'HEAD']);
      assert.equal(worktreeDiff, delta.patch.trim(),
        'git diff HEAD^ HEAD in review worktree must equal exact delta');

      // delta 内容：只含任务变更，无 README / 无 .speccraft
      assert.ok(worktreeDiff.includes('+two'));
      assert.ok(worktreeDiff.includes('+added'));
      assert.ok(!worktreeDiff.includes('README.md'));

      // 干净的 review worktree + 正确 expectedHead → mutation check clean
      const mut = await checkReviewerMutation(rwPath, post.commitId);
      assert.equal(mut.clean, true, mut.output);
    } finally {
      const removed = await removeReviewWorktree(repo, rwPath);
      assert.equal(removed.ok, true, removed.error);
    }

    // source repo 未被移动/引用污染
    assert.equal(git(repo, ['rev-parse', 'HEAD']), sourceHead, 'source HEAD must not move');
    assert.equal(git(repo, ['branch', '--contains', post.commitId]), '',
      'synthetic postCommit must not be reachable from any branch');
  });

  it('review worktree HEAD drift is detected by checkReviewerMutation(expectedHead)', async () => {
    const repo = path.join(tmpRoot, 'h2');
    await mkdir(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'a@b.c']);
    git(repo, ['config', 'user.name', 'T']);
    await writeFiles(repo, { 'src/a.txt': 'one' });
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);

    const pre = await captureTreeSnapshot(repo, 'pre-h2', 'pre');
    await writeFiles(repo, { 'src/a.txt': 'two' });
    const post = await captureTreeSnapshot(repo, 'post-h2', 'post', pre.commitId);

    const rwPath = path.join(tmpRoot, 'h2-review-wt');
    const rw = await createReviewWorktree(repo, rwPath, post.commitId);
    assert.equal(rw.ok, true, rw.error);
    try {
      // reviewer 修改后自己 commit → status 变干净 → 只有 expectedHead 检查能抓到 HEAD drift
      git(rwPath, ['config', 'user.email', 'a@b.c']);
      git(rwPath, ['config', 'user.name', 'T']);
      await writeFiles(rwPath, { 'src/a.txt': 'tampered' });
      git(rwPath, ['add', '-A']);
      git(rwPath, ['commit', '-qm', 'reviewer commit']);

      assert.notEqual(git(rwPath, ['rev-parse', 'HEAD']), post.commitId);

      const plain = await checkReviewerMutation(rwPath);
      assert.equal(plain.clean, true, 'status-only check must NOT detect clean-after-commit');

      const guarded = await checkReviewerMutation(rwPath, post.commitId);
      assert.equal(guarded.clean, false);
      assert.equal(guarded.headDrift, true, 'expectedHead guard must flag HEAD drift');
      assert.ok(guarded.output.includes('HEAD drift'));
    } finally {
      await removeReviewWorktree(repo, rwPath);
    }
  });
});

// ============================================================================
// §4.1 — Runtime Git Identity
// ============================================================================

describe('E2E — Runtime Git Identity (no user.name/user.email)', () => {
  it('commit-tree succeeds and records SpecCraft Runtime identity', async () => {
    const repo = path.join(tmpRoot, 'noid');
    await mkdir(repo, { recursive: true });
    git(repo, ['init', '-q']);
    // 不写任何 user.name / user.email config
    await writeFiles(repo, { 'src/a.txt': 'one' });
    // init commit 用一次性 -c 身份完成，config 里依旧没有 identity
    git(repo, ['-c', 'user.name=T', '-c', 'user.email=a@b.c', 'add', '-A']);
    git(repo, ['-c', 'user.name=T', '-c', 'user.email=a@b.c', 'commit', '-qm', 'init']);

    await writeFiles(repo, { 'src/a.txt': 'two' });
    const snap = await captureTreeSnapshot(repo, 'pre-noid', 'snapshot without identity config');
    assert.equal(snap.ok, true, snap.error);
    assert.match(snap.commitId, /^[0-9a-f]{40}$/);

    const author = git(repo, ['log', '-1', '--format=%an <%ae>', snap.commitId]);
    assert.equal(author, 'SpecCraft Runtime <speccraft@local>', 'author must be injected runtime identity');
    const committer = git(repo, ['log', '-1', '--format=%cn <%ce>', snap.commitId]);
    assert.equal(committer, 'SpecCraft Runtime <speccraft@local>');
  });
});

// ============================================================================
// §3.2 — read-tree HEAD 基底：tracked-but-ignored 文件必须保留
// ============================================================================

describe('E2E — read-tree HEAD base keeps tracked-but-ignored files', () => {
  it('a file added to .gitignore AFTER being tracked stays in the snapshot', async () => {
    const repo = path.join(tmpRoot, 'ignored');
    await mkdir(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'a@b.c']);
    git(repo, ['config', 'user.name', 'T']);
    await writeFiles(repo, { 'src/a.txt': 'one', 'data.log': 'v1' });
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);

    // 之后才 ignore data.log（tracked 文件不受 .gitignore 影响，必须仍在快照中）
    await writeFiles(repo, { '.gitignore': 'data.log', 'data.log': 'v2', 'src/a.txt': 'two' });

    const pre = await captureTreeSnapshot(repo, 'pre-ig', 'pre');
    assert.equal(pre.ok, true, pre.error);
    const post = await captureTreeSnapshot(repo, 'post-ig', 'post', pre.commitId);
    assert.equal(post.ok, true, post.error);

    const files = treeFiles(repo, post.treeId);
    assert.ok(files.includes('data.log'), 'tracked-but-ignored file must survive (read-tree HEAD base)');

    // real repo 未被破坏：data.log 仍是 tracked（ignore 只影响 untracked 文件；
    // 修改后的 tracked 文件在 status 里正常出现，但绝不能是 ?? untracked）
    const status = git(repo, ['status', '--porcelain']);
    const statusLines = status.split('\n');
    assert.ok(!statusLines.some((l) => l.includes('?? data.log')), 'data.log must not become untracked');
    assert.ok(statusLines.some((l) => /^ ?M data\.log$/.test(l)), `data.log must show tracked modification, status: ${status}`);
  });
});
