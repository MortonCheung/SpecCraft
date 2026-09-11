import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { parseArtifact, artifactFileName } from '../artifacts/store.js';
import type { Workflow } from '../types.js';

/** Execution Context 中的一个来源片段 */
export interface ContextSection {
  artifactId: string;
  stage: string;
  status: string;
  /** body 中的第一个标题（作为片段摘要） */
  title: string;
  body: string;
}

/** 编译后的 Execution Context（见 ADR 0002 §10） */
export interface ExecutionContext {
  /** 目标阶段（如 execution-manual） */
  target: string;
  sections: ContextSection[];
}

/**
 * 收集 target 阶段的传递上游 Artifact id（按 workflow 声明顺序）。
 * 只保留施工真正需要的前置信息，避免 Prompt 无限膨胀。
 */
export function collectUpstreamArtifacts(workflow: Workflow, targetStageId: string): string[] {
  const needed = new Set<string>();
  const visit = (stageId: string): void => {
    const stage = workflow.stages.find((s) => s.id === stageId);
    if (!stage) return;
    for (const req of stage.requires) {
      const upstream = workflow.stages.find((s) => s.id === req);
      if (!upstream) continue;
      const artifactId = upstream.produces[0];
      if (artifactId) needed.add(artifactId);
      visit(req);
    }
  };
  visit(targetStageId);

  const ordered: string[] = [];
  for (const stage of workflow.stages) {
    const artifactId = stage.produces[0];
    if (artifactId && needed.has(artifactId)) ordered.push(artifactId);
  }
  return ordered;
}

/** 读取并编译 target 阶段的传递上游 Artifact 为 Execution Context */
export async function compileContext(
  speccraftDir: string,
  workflow: Workflow,
  targetStageId: string,
): Promise<ExecutionContext> {
  return compileContextFrom(workflow, targetStageId, (artifactId) =>
    path.join(speccraftDir, 'artifacts', artifactFileName(artifactId)),
  );
}

/**
 * 编译 target 阶段的传递上游 Artifact 为 Execution Context，artifact 来源由调用方决定。
 *
 * v0.9 §23：Successor Run 必须基于 approved resolved snapshot 编译 Execution Package，
 * 不能读取当前 canonical artifacts；因此 compile / render 逻辑只保留一份。
 */
export async function compileContextFrom(
  workflow: Workflow,
  targetStageId: string,
  resolveArtifactFile: (artifactId: string) => string,
): Promise<ExecutionContext> {
  const artifactIds = collectUpstreamArtifacts(workflow, targetStageId);
  const sections: ContextSection[] = [];
  for (const id of artifactIds) {
    const filePath = resolveArtifactFile(id);
    if (!(await pathExists(filePath))) continue;
    const source = await readFile(filePath, 'utf8');
    const { frontmatter, body } = parseArtifact(source);
    sections.push({
      artifactId: frontmatter.artifact,
      stage: frontmatter.stage,
      status: frontmatter.status,
      title: extractTitle(body),
      body: body.trim(),
    });
  }
  return { target: targetStageId, sections };
}

/** 将 Execution Context 渲染为 Markdown（供 Execution Manual / Adapter 注入） */
export function renderContext(ctx: ExecutionContext): string {
  const header = `# Execution Context（target: ${ctx.target}）\n`;
  if (ctx.sections.length === 0) {
    return `${header}\n（无上游 Artifact）\n`;
  }
  const body = ctx.sections
    .map((s) => {
      const heading = s.title ? s.title : s.artifactId;
      return `## [${s.artifactId}] ${heading}\n\n${s.body}`;
    })
    .join('\n\n---\n\n');
  return `${header}\n${body}\n`;
}

function extractTitle(body: string): string {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
