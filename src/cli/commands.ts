import path from 'node:path';
import { access } from 'node:fs/promises';
import { initProject } from '../core/init.js';
import { loadProject } from '../core/project.js';
import { completeStage, approveStage, artifactDependencies } from '../core/advance.js';
import {
  nextStageId,
  findWaitingApproval,
  validateState,
  evaluateGate,
} from '../core/guards/index.js';
import { writeState } from '../core/state/store.js';
import {
  writeArtifact,
  createArtifact,
  artifactFileName,
  readArtifact,
} from '../core/artifacts/store.js';
import { resolveTemplateContent } from '../core/templates/resolver.js';
import type { StageDefinition, StageStatus } from '../core/types.js';

const STATUS_WIDTH = 22;

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** speccraft init [projectRoot] [--force] */
export async function cmdInit(projectRoot: string | undefined, force: boolean): Promise<void> {
  const root = projectRoot ?? process.cwd();
  const result = await initProject({ projectRoot: root, force });
  console.log(`已初始化 SpecCraft 工作现场：${result.speccraftDir}`);
  console.log(`初始阶段：${result.state.current_stage}`);
}

/** speccraft status */
export async function cmdStatus(): Promise<void> {
  const { workflow, state, speccraftDir } = await loadProject(process.cwd());
  console.log(`工作现场：${speccraftDir}`);
  console.log(`当前阶段：${state.current_stage}`);
  console.log('');
  for (const stage of workflow.stages) {
    const status = state.stages[stage.id]?.status ?? 'pending';
    console.log(`  ${status.padEnd(STATUS_WIDTH)} ${stage.id}`);
  }
}

/** speccraft next */
export async function cmdNext(): Promise<void> {
  const { workflow, state } = await loadProject(process.cwd());
  const waiting = findWaitingApproval(state);
  if (waiting.length > 0) {
    console.log(`待批准阶段：${waiting.join('、')}`);
    console.log('请运行：speccraft approve <stage>');
    return;
  }
  const next = nextStageId(workflow, state);
  if (!next) {
    console.log('没有可进入的下一阶段。');
    return;
  }
  console.log(`下一步阶段：${next}`);
}

/** speccraft approve <stage> [--by <who>] */
export async function cmdApprove(stageId: string, by: string): Promise<void> {
  const { workflow, state, speccraftDir } = await loadProject(process.cwd());
  const stage = workflow.stages.find((s) => s.id === stageId);
  if (!stage) throw new Error(`未知阶段：${stageId}`);
  approveStage(workflow, state, stageId, by);
  await syncArtifactStatus(speccraftDir, stage, 'approved');
  await writeState(speccraftDir, state);
  console.log(`已批准阶段 ${stageId}（批准人：${by}）`);
  console.log(`当前阶段：${state.current_stage}`);
}

/** speccraft artifact <stage> */
export async function cmdArtifact(stageId: string): Promise<void> {
  const { workflow, state, speccraftDir } = await loadProject(process.cwd());
  const stage = workflow.stages.find((s) => s.id === stageId);
  if (!stage) throw new Error(`未知阶段：${stageId}`);
  if (stage.produces.length === 0) {
    throw new Error(`阶段 ${stageId} 不产出 artifact`);
  }

  const current = state.stages[stageId]?.status ?? 'pending';
  if (current !== 'pending') {
    throw new Error(`阶段 ${stageId} 当前状态为 ${current}，不能生成 artifact`);
  }

  const gate = evaluateGate(stage, state);
  if (!gate.satisfied) {
    throw new Error(`阶段 ${stageId} 上游未满足：\n  ${gate.unmet.join('\n  ')}`);
  }

  const target = completeStage(workflow, state, stageId);
  const artifactId = stage.produces[0];
  const source = artifactDependencies(workflow, stage);
  const body = await resolveTemplateContent(stage.template ?? stage.id);
  const artifact = createArtifact(
    {
      artifact: artifactId,
      stage: stageId,
      status: target,
      version: 1,
      ...(source.length > 0 ? { source } : {}),
    },
    body,
  );
  const filePath = path.join(speccraftDir, 'artifacts', artifactFileName(artifactId));
  await writeArtifact(filePath, artifact);
  await writeState(speccraftDir, state);

  console.log(`已生成 artifact：.speccraft/artifacts/${artifactFileName(artifactId)}`);
  console.log(`阶段 ${stageId} 状态：${state.stages[stageId].status}`);
}

/** speccraft prepare [--adapter <id>]：编译 Execution Package 并创建 Run */
export async function cmdPrepare(adapterId: string | undefined): Promise<void> {
  const { prepareExecution } = await import('../core/execution/prepare.js');
  const result = await prepareExecution({
    projectRoot: process.cwd(),
    ...(adapterId ? { adapterId } : {}),
  });
  console.log(`已创建 Execution Run：${result.runId}`);
  for (const file of result.files) {
    console.log(`已生成：.speccraft/runs/${result.runId}/${file}`);
  }
  console.log('');
  console.log('下一步：把 agent-prompt.md 交给施工 Agent，然后运行 speccraft implement start');
}

/** speccraft validate（状态一致性，不跳阶段） */
export async function cmdValidate(): Promise<number> {
  const { workflow, state } = await loadProject(process.cwd());
  const violations = validateState(workflow, state);
  console.log(`Workflow：${workflow.name} v${workflow.version}（${workflow.stages.length} 阶段）`);
  console.log(`当前阶段：${state.current_stage}`);
  if (violations.length === 0) {
    console.log('校验通过：无状态违规。');
    return 0;
  }
  console.log(`发现 ${violations.length} 处违规：`);
  for (const v of violations) console.log(`  - ${v}`);
  return 1;
}

/** 批准后同步 artifact frontmatter.status，保持文件与 state.yaml 一致 */
async function syncArtifactStatus(
  speccraftDir: string,
  stage: StageDefinition,
  status: StageStatus,
): Promise<void> {
  if (stage.produces.length === 0) return;
  const filePath = path.join(speccraftDir, 'artifacts', artifactFileName(stage.produces[0]));
  if (!(await pathExists(filePath))) return;
  const artifact = await readArtifact(filePath);
  if (artifact.frontmatter.status === status) return;
  artifact.frontmatter.status = status;
  await writeArtifact(filePath, artifact);
}
