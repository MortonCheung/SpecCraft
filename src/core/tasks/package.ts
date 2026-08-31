/**
 * Task Package（ADR 0006 §6）。
 *
 * 每个 Task 生成自己的 context.md 与 prompt.md（确定性，不调用 AI）。
 * context.md 复用 run 的 Compiled Context；prompt.md 内嵌 Task 契约 + Guard。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { taskDir } from './store.js';
import type { TaskDefinition, TaskGraph } from './types.js';

export interface TaskPackageInput {
  speccraftDir: string;
  runId: string;
  graph: TaskGraph;
  task: TaskDefinition;
  /** run 级 Compiled Context（context.md 内容） */
  runContext: string;
  /** execution-guard skill 正文 */
  executionGuard: string;
}

/** 渲染 Task context.md */
export function renderTaskContext(input: TaskPackageInput): string {
  return [
    `# Task Context`,
    '',
    `Run: ${input.runId}`,
    `Task: ${input.task.id}`,
    '',
    '以下为 Run 级 Compiled Context（复用 Context Compiler）：',
    '',
    input.runContext.trim(),
    '',
  ].join('\n');
}

/** 渲染 Task prompt.md */
export function renderTaskPrompt(input: TaskPackageInput): string {
  const t = input.task;
  const deps = t.dependsOn.length > 0 ? t.dependsOn.map((d) => `- ${d}`).join('\n') : '- （无）';
  const scope = t.scope.paths.map((p) => `- ${p}`).join('\n');
  const commands = t.verification.commands.map((c) => `- \`${c}\``).join('\n');

  return [
    `# SpecCraft Task Prompt`,
    '',
    `- Run ID: ${input.runId}`,
    `- Task ID: ${t.id}`,
    `- Task Title: ${t.title}`,
    '',
    `## 任务目标`,
    '',
    t.summary.trim(),
    '',
    `## 依赖`,
    '',
    deps,
    '',
    `## 允许修改的 Scope`,
    '',
    scope,
    '',
    `## 验证命令（Task Verification 将按此执行）`,
    '',
    commands,
    '',
    `## Execution Guard（施工守卫）`,
    '',
    input.executionGuard.trim(),
    '',
    `## 硬性禁止`,
    '',
    '- 禁止修改 Scope 之外的文件；',
    '- 禁止重新设计产品；',
    '- 禁止新增 Task；',
    '- 禁止改变整体技术栈 / Workflow / Runtime 语义。',
    '',
    `## 完成后应报告什么`,
    '',
    '在最终报告中说明：修改了什么、改了哪些文件、执行了哪些验证、',
    '与 Task 目标的差异（如有）、遗留问题。',
    '',
  ].join('\n');
}

/** 生成并落盘 Task Package（context.md + prompt.md） */
export async function generateTaskPackage(input: TaskPackageInput): Promise<string[]> {
  const dir = taskDir(input.speccraftDir, input.runId, input.task.id);
  await mkdir(dir, { recursive: true });

  const contextPath = path.join(dir, 'context.md');
  const promptPath = path.join(dir, 'prompt.md');
  await writeFile(contextPath, renderTaskContext(input), 'utf8');
  await writeFile(promptPath, renderTaskPrompt(input), 'utf8');
  return ['context.md', 'prompt.md'];
}
