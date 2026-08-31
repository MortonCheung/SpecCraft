import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initProject } from '../src/core/init.js';
import { loadProject } from '../src/core/project.js';
import { completeStage, approveStage } from '../src/core/advance.js';
import { writeArtifact, createArtifact, artifactFileName } from '../src/core/artifacts/store.js';
import { resolveTemplateContent } from '../src/core/templates/resolver.js';
import { prepareExecution } from '../src/core/execution/prepare.js';
import { manualAdapter } from '../src/core/execution/adapters/manual.js';
import { parseProjectConfig } from '../src/core/project.js';
import type { Workflow, State } from '../src/core/types.js';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function makeArtifact(
  speccraftDir: string,
  workflow: Workflow,
  state: State,
  stageId: string,
): Promise<void> {
  const stage = workflow.stages.find((s) => s.id === stageId)!;
  const target = completeStage(workflow, state, stageId);
  const body = await resolveTemplateContent(stage.template ?? stage.id);
  const artifact = createArtifact(
    { artifact: stage.produces[0], stage: stageId, status: target, version: 1 },
    body,
  );
  await writeArtifact(
    path.join(speccraftDir, 'artifacts', artifactFileName(stage.produces[0])),
    artifact,
  );
}

/** 建一个已推进到 ready-to-implement 的测试项目 */
async function makeReadyProject(): Promise<{ root: string; speccraftDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-prep-'));
  const { speccraftDir } = await initProject({ projectRoot: root });
  const { workflow, state } = await loadProject(root);
  for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
    await makeArtifact(speccraftDir, workflow, state, id);
  }
  approveStage(workflow, state, 'design', 'owner');
  for (const id of ['build-brief', 'site-survey', 'execution-manual']) {
    await makeArtifact(speccraftDir, workflow, state, id);
  }
  const { writeState } = await import('../src/core/state/store.js');
  await writeState(speccraftDir, state);
  return { root, speccraftDir };
}

test('M2.2 #4：ready-to-implement 未完成时 prepare 拒绝', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-prep-'));
  try {
    await initProject({ projectRoot: root });
    await assert.rejects(
      () => prepareExecution({ projectRoot: root }),
      /ready-to-implement == completed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.2 #4b：execution-manual 未完成时 prepare 拒绝', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'speccraft-prep-'));
  try {
    const { speccraftDir } = await initProject({ projectRoot: root });
    const { workflow, state } = await loadProject(root);
    for (const id of ['idea', 'feasibility', 'discovery', 'requirement', 'concept', 'research', 'design']) {
      await makeArtifact(speccraftDir, workflow, state, id);
    }
    approveStage(workflow, state, 'design', 'owner');
    // 只做到 build-brief，跳过 site-survey / execution-manual
    await makeArtifact(speccraftDir, workflow, state, 'build-brief');
    // ready-to-implement 因 execution-manual 未完成而保持 pending，
    // prepare 在第一道门禁即拒绝（两个条件都未满足）
    await assert.rejects(
      () => prepareExecution({ projectRoot: root }),
      /ready-to-implement == completed|execution-manual == completed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.2 #5-#8：prepare 创建 run、生成 package、写入 active_run', async () => {
  const { root, speccraftDir } = await makeReadyProject();
  try {
    const result = await prepareExecution({ projectRoot: root });

    // run 结构
    assert.match(result.runId, /^run-/);
    assert.equal(await exists(path.join(result.runDir, 'manifest.yaml')), true);
    assert.equal(await exists(path.join(result.runDir, 'context.md')), true);
    assert.equal(await exists(path.join(result.runDir, 'agent-prompt.md')), true);
    assert.equal(await exists(path.join(result.runDir, 'verification')), true);
    assert.equal(await exists(path.join(result.runDir, 'logs')), true);

    // active_run 正确
    const { state } = await loadProject(root);
    assert.equal(state.active_run, result.runId);

    // prepare 不把 implementation 置为 in_progress
    assert.equal(state.stages['implementation'].status, 'pending');

    // context.md 内容：来自 Context Compiler（上游闭包）
    const context = await readFile(path.join(result.runDir, 'context.md'), 'utf8');
    for (const id of ['idea', 'requirements', 'research', 'design', 'build-brief', 'site-survey', 'execution-manual']) {
      assert.ok(context.includes(`[${id}]`), `context.md 应包含 ${id}`);
    }

    // agent-prompt.md 内容：10 节结构
    const prompt = await readFile(path.join(result.runDir, 'agent-prompt.md'), 'utf8');
    for (const section of [
      'Worker Role',
      'Real Repository Rule',
      'Execution Goal',
      'Execution Manual',
      'Compiled Context',
      'Execution Guard',
      'Forbidden Changes',
      'Verification Requirements',
      'Git Rules',
      'Execution Report Contract',
    ]) {
      assert.ok(prompt.includes(section), `agent-prompt.md 应包含 ${section}`);
    }
    // Execution Manual 正文直接嵌入（不是引用文件名）
    assert.ok(prompt.includes('# 概述')); // default template 正文
    // Execution Guard 注入
    assert.ok(prompt.includes('execution-guard') || prompt.includes('复用守卫') || prompt.includes('YAGNI'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.2：prepare 读入 project.yaml 的 verification 配置', async () => {
  const { root, speccraftDir } = await makeReadyProject();
  try {
    await writeFile(
      path.join(speccraftDir, 'project.yaml'),
      [
        'name: test',
        'verification:',
        '  timeout_seconds: 120',
        '  commands:',
        '    - npm test',
        '    - npm run build',
      ].join('\n'),
      'utf8',
    );
    const result = await prepareExecution({ projectRoot: root });
    const prompt = await readFile(path.join(result.runDir, 'agent-prompt.md'), 'utf8');
    assert.ok(prompt.includes('npm test'));
    assert.ok(prompt.includes('npm run build'));
    assert.ok(prompt.includes('120 秒'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.2 #27：manual adapter 可单独运行（不依赖 CLI）', async () => {
  const prepared = await manualAdapter.prepare({
    speccraftDir: '/tmp/unused',
    runId: 'run-standalone-test',
    manifest: {
      id: 'run-standalone-test',
      status: 'prepared',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      contextFile: 'context.md',
      promptFile: 'agent-prompt.md',
      reports: [],
      verificationAttempts: 0,
      acceptance: { attempt: 0, status: 'none' },
    },
    executionManual: '# 手册\n\n做一件事。',
    compiledContext: '# Execution Context\n\n上游内容。',
    executionGuard: '# Execution Guard\n\nYAGNI 原则。',
    verification: { commands: ['npm test'], timeoutSeconds: 300 },
    gitSnapshot: null,
    readyStages: ['idea', 'design'],
  });
  assert.equal(Object.keys(prepared.files).length, 2);
  assert.ok(prepared.files['context.md'].includes('上游内容'));
  assert.ok(prepared.files['agent-prompt.md'].includes('做一件事'));
});

test('M2.2：未知 adapter 拒绝', async () => {
  const { root } = await makeReadyProject();
  try {
    await assert.rejects(
      () => prepareExecution({ projectRoot: root, adapterId: 'codex' }),
      /未知 execution adapter/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2.2：parseProjectConfig 兼容旧 project.yaml（无 verification）', () => {
  const config = parseProjectConfig('name: old-project\ncreated_at: "2026-01-01"\n');
  assert.equal(config.name, 'old-project');
  assert.equal(config.createdAt, '2026-01-01');
  assert.equal(config.verification, undefined);
});

test('M2.2：parseProjectConfig 解析 verification', () => {
  const config = parseProjectConfig(
    [
      'name: new-project',
      'verification:',
      '  timeout_seconds: 60',
      '  commands:',
      '    - pytest',
      '    - cargo test',
    ].join('\n'),
  );
  assert.equal(config.verification?.timeoutSeconds, 60);
  assert.deepEqual(config.verification?.commands, ['pytest', 'cargo test']);
});

test('M2.2：parseProjectConfig 默认值（有 verification 无字段）', () => {
  const config = parseProjectConfig('name: x\nverification: {}\n');
  assert.equal(config.verification?.timeoutSeconds, 300);
  assert.deepEqual(config.verification?.commands, []);
});
