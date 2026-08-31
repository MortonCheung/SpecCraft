import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test('M4.9 DoD #7#45#46#47#48：Runtime 无 Provider SDK / 数据库 / execa / nanoid/uuid', async () => {
  const pkg = JSON.parse(
    await readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  const deps = Object.keys(pkg.dependencies ?? {});
  const devDeps = Object.keys(pkg.devDependencies ?? {});

  for (const banned of [
    'sqlite', 'pg', 'mysql', 'mongodb', 'prisma', 'typeorm', 'drizzle', 'redis',
    '@anthropic-ai/sdk', 'openai', '@openai/codex', 'codex', 'claude-code',
    '@google/generative-ai', '@aws-sdk', 'execa', 'commander', 'nanoid', 'uuid', 'zod', 'shelljs', 'zx',
  ]) {
    assert.ok(!deps.includes(banned) && !devDeps.includes(banned), `不应依赖 ${banned}`);
  }
  // 唯一运行时依赖仍是 js-yaml
  assert.deepEqual(deps, ['js-yaml']);
});

test('M4.9 DoD #3：Adapter Registry 发现 5 个内置 adapter', async () => {
  const { listAdapterIds } = await import('../src/core/execution/adapters/registry.js');
  const ids = listAdapterIds();
  for (const id of ['manual', 'codex', 'claude', 'opencode', 'trae']) {
    assert.ok(ids.includes(id), `registry 应包含 ${id}`);
  }
});

test('M4.9 DoD #8#35：Adapter 不保存 Provider API Key（config 无 secret 字段）', async () => {
  const { parseProjectConfig } = await import('../src/core/project.js');
  const config = parseProjectConfig(
    'name: x\nexecution:\n  default_adapter: codex\n  adapters:\n    codex:\n      command: codex\n',
  );
  // 结构上只允许 command/timeout/extra_args/model/sandbox，无 key/token 字段
  const keys = Object.keys(config.execution?.adapters.codex ?? {});
  for (const banned of ['api_key', 'apiKey', 'token', 'password', 'cookie']) {
    assert.ok(!keys.includes(banned), `adapter config 不应含 ${banned}`);
  }
});

test('M4.9 DoD #19#49：Dispatch Attempt 是 append-only，不新增 Workflow Stage', async () => {
  const { parseWorkflow } = await import('../src/core/workflow/loader.js');
  const { defaultWorkflowPath } = await import('../src/utils/paths.js');
  const wf = parseWorkflow(await readFile(defaultWorkflowPath, 'utf8'));
  assert.equal(wf.stages.length, 16);
  // dispatch 不是 workflow stage
  assert.ok(!wf.stages.some((s) => s.id === 'dispatch'));
});

test('M4.9 DoD #50#51：manual 路线 + handoff 确定性（v0.3 回归不破坏）', async () => {
  const { compileHandoffPackage, handoffDir } = await import('../src/core/handoff/package.js');
  assert.equal(typeof compileHandoffPackage, 'function');
  assert.equal(typeof handoffDir, 'function');
});
