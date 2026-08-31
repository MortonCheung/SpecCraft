import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test('M3.7 DoD #26：v0.3 仍不依赖数据库 / AI SDK / execa / nanoid / uuid 包', async () => {
  const pkg = JSON.parse(
    await readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  const deps = Object.keys(pkg.dependencies ?? {});
  const devDeps = Object.keys(pkg.devDependencies ?? {});

  for (const banned of [
    'sqlite', 'pg', 'mysql', 'mongodb', 'prisma', 'typeorm', 'drizzle',
    'redis',
    '@anthropic-ai/sdk', 'openai', 'codex', 'claude-code', '@google/generative-ai',
    'execa', 'commander', 'nanoid', 'uuid', 'zod',
  ]) {
    assert.ok(!deps.includes(banned) && !devDeps.includes(banned), `不应依赖 ${banned}`);
  }
  // 唯一运行时依赖仍是 js-yaml
  assert.deepEqual(deps, ['js-yaml']);
});

test('M3.7 DoD：default workflow 16 阶段，owner-acceptance gate = all_required_completed', async () => {
  const { parseWorkflow } = await import('../src/core/workflow/loader.js');
  const { defaultWorkflowPath } = await import('../src/utils/paths.js');
  const wf = parseWorkflow(await readFile(defaultWorkflowPath, 'utf8'));

  assert.equal(wf.stages.length, 16);
  assert.equal(wf.version, '0.3.0');
  const ownerAcceptance = wf.stages.find((s) => s.id === 'owner-acceptance')!;
  assert.equal(ownerAcceptance.gate.type, 'all_required_completed');
  assert.equal(ownerAcceptance.autoComplete, undefined);
  const handoff = wf.stages.find((s) => s.id === 'handoff')!;
  assert.equal(handoff.gate.type, 'all_required_completed');
});
