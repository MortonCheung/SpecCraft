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
import type { StageDefinition, StageStatus, State } from '../core/types.js';

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
export async function cmdStatus(projectRoot: string = process.cwd()): Promise<void> {
  const { workflow, state, speccraftDir } = await loadProject(projectRoot);
  console.log(`工作现场：${speccraftDir}`);
  console.log(`Workflow：${workflow.name} v${workflow.version}`);
  console.log(`当前阶段：${state.current_stage}`);
  console.log('');

  // Active Run（execution 生命周期）
  if (state.active_run) {
    const { getActiveRun } = await import('../core/execution/store.js');
    const run = await getActiveRun(speccraftDir, state.active_run);
    if (run) {
      console.log('Active Run:');
      console.log(`  ${run.id}`);
      console.log(`  status: ${run.status}`);
      console.log(`  verification attempts: ${run.verificationAttempts}`);
      if (run.reports.length > 0) {
        console.log(`  reports: ${run.reports.length}`);
      }
      console.log('');
    } else {
      console.log(`Active Run: ${state.active_run}（manifest 缺失，请运行 speccraft validate）`);
      console.log('');
    }
  }

  for (const stage of workflow.stages) {
    const status = state.stages[stage.id]?.status ?? 'pending';
    console.log(`  ${status.padEnd(STATUS_WIDTH)} ${stage.id}`);
  }
}

/** speccraft next */
export async function cmdNext(projectRoot: string = process.cwd()): Promise<void> {
  const { workflow, state, speccraftDir } = await loadProject(projectRoot);

  // Execution 生命周期引导优先（ready-to-implement 完成之后）。
  // 注意顺序：owner-acceptance 处于 waiting_owner_approval，但它是 accept/reject
  // 决策，不是 `speccraft approve` 的 design 审批，必须走 execution guidance。
  const ready = state.stages['ready-to-implement']?.status === 'completed';
  if (ready) {
    const guidance = await nextExecutionGuidance(speccraftDir, state);
    if (guidance) {
      console.log(guidance);
      return;
    }
  }

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

/** Execution 生命周期引导；返回 null 表示不在 execution 阶段 */
async function nextExecutionGuidance(speccraftDir: string, state: State): Promise<string | null> {
  const impl = state.stages['implementation']?.status ?? 'pending';
  const verif = state.stages['verification']?.status ?? 'pending';
  const acceptance = state.stages['owner-acceptance']?.status ?? 'pending';
  const handoff = state.stages['handoff']?.status ?? 'pending';

  if (handoff === 'completed') {
    return [
      'Workflow completed.',
      `Handoff package 已生成（speccraft status 查看）。`,
    ].join('\n');
  }

  if (impl === 'completed' && verif === 'completed') {
    if (acceptance === 'completed') {
      return '下一步：speccraft handoff';
    }
    if (acceptance === 'waiting_owner_approval') {
      return [
        'Machine verification passed.',
        'Waiting for Owner Acceptance.',
        '',
        'Next:',
        '  speccraft accept',
        'or',
        '  speccraft reject --reason "..."',
      ].join('\n');
    }
    // blocked 状态应伴随 implementation 重开，见下方 in_progress 分支
  }

  if (impl === 'completed') {
    return '下一步：speccraft verify';
  }

  if (impl === 'in_progress') {
    const { getActiveRun } = await import('../core/execution/store.js');
    const run = await getActiveRun(speccraftDir, state.active_run);
    if (run?.status === 'acceptance_rejected') {
      return [
        'Owner rejected the verified implementation.',
        '',
        'Implementation has been reopened.',
        '',
        'Next:',
        '  continue implementation',
        '  speccraft implement finish --report <file>',
      ].join('\n');
    }
    // 返工中：上一次 verification 未通过
    if (run?.status === 'verification_failed') {
      return [
        'Verification 未通过。',
        '在当前 Run 内修复后重新执行 implement finish。',
      ].join('\n');
    }
    return [
      'Agent 正在施工。',
      '完成后运行：',
      'speccraft implement finish --report <path>',
    ].join('\n');
  }

  // impl === pending：检查 active run
  const { getActiveRun } = await import('../core/execution/store.js');
  const run = await getActiveRun(speccraftDir, state.active_run);
  if (!run) {
    return '下一步：speccraft prepare';
  }
  if (run.status === 'prepared') {
    return '下一步：speccraft implement start';
  }
  if (run.status === 'verification_failed') {
    return [
      'Verification 未通过。',
      '在当前 Run 内修复后重新执行 implement finish。',
    ].join('\n');
  }
  return '下一步：speccraft implement start';
}

/** speccraft approve <stage> [--by <who>] */
export async function cmdApprove(stageId: string, by: string, projectRoot: string = process.cwd()): Promise<void> {
  const { workflow, state, speccraftDir } = await loadProject(projectRoot);
  const stage = workflow.stages.find((s) => s.id === stageId);
  if (!stage) throw new Error(`未知阶段：${stageId}`);
  approveStage(workflow, state, stageId, by);
  await syncArtifactStatus(speccraftDir, stage, 'approved');
  await writeState(speccraftDir, state);
  console.log(`已批准阶段 ${stageId}（批准人：${by}）`);
  console.log(`当前阶段：${state.current_stage}`);
}

/** speccraft artifact <stage> */
export async function cmdArtifact(stageId: string, projectRoot: string = process.cwd()): Promise<void> {
  const { workflow, state, speccraftDir } = await loadProject(projectRoot);
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
export async function cmdPrepare(adapterId: string | undefined, projectRoot: string = process.cwd()): Promise<void> {
  const { prepareExecution } = await import('../core/execution/prepare.js');
  const result = await prepareExecution({
    projectRoot,
    ...(adapterId ? { adapterId } : {}),
  });
  console.log(`已创建 Execution Run：${result.runId}`);
  for (const file of result.files) {
    console.log(`已生成：.speccraft/runs/${result.runId}/${file}`);
  }
  console.log('');
  console.log('下一步：把 agent-prompt.md 交给施工 Agent，然后运行 speccraft implement start');
}

/** speccraft implement start [--run <run-id>] */
export async function cmdImplementStart(runId: string | undefined, projectRoot: string = process.cwd()): Promise<void> {
  const { implementStart } = await import('../core/execution/lifecycle.js');
  const result = await implementStart({
    projectRoot,
    ...(runId ? { runId } : {}),
  });
  console.log(`Run ${result.runId} 已开始施工。`);
  console.log('implementation = in_progress');
}

/** speccraft implement finish --report <path> */
export async function cmdImplementFinish(
  reportPath: string | undefined,
  projectRoot: string = process.cwd(),
): Promise<void> {
  if (!reportPath) {
    throw new Error('implement finish 需要报告路径：speccraft implement finish --report <path>');
  }
  const { implementFinish } = await import('../core/execution/lifecycle.js');
  const result = await implementFinish({ projectRoot, reportPath });
  console.log(`已收录执行报告：.speccraft/runs/${result.runId}/${result.reportFile}`);
  console.log('implementation = completed');
  console.log('current_stage = verification');
  console.log('');
  console.log('下一步：speccraft verify');
}

/** speccraft verify：运行项目声明的验证命令 */
export async function cmdVerify(projectRoot: string = process.cwd()): Promise<number> {
  const { verifyExecution } = await import('../core/verification/orchestrator.js');
  const result = await verifyExecution({ projectRoot });

  console.log(`Run ${result.runId} / Attempt ${result.attempt}`);
  for (const c of result.commands) {
    const exit = c.exitCode !== undefined ? `exit ${c.exitCode}` : (c.reason ?? '未知');
    console.log(`  ${c.passed ? 'PASS' : 'FAIL'}  ${c.command}（${exit}，${c.durationMs}ms，${c.log}）`);
  }
  console.log('');
  if (result.passed) {
    console.log('全部验证命令通过。verification = completed');
  } else {
    console.log('验证未通过。verification = blocked，implementation 已重新打开（同一 Run 返工）。');
    console.log('修复后重新执行：speccraft implement finish --report <path>');
  }
  return result.passed ? 0 : 1;
}

/** speccraft validate（状态一致性 + execution 一致性） */
export async function cmdValidate(projectRoot: string = process.cwd()): Promise<number> {
  const { workflow, state, speccraftDir } = await loadProject(projectRoot);
  const violations = validateState(workflow, state);
  violations.push(...(await validateExecutionConsistency(speccraftDir, state)));
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

/**
 * Execution 一致性检查（ADR 0003 §7）。
 * 只检查 Run / State / Attempt 之间的矛盾，不替代 speccraft verify。
 */
async function validateExecutionConsistency(speccraftDir: string, state: State): Promise<string[]> {
  const violations: string[] = [];
  const impl = state.stages['implementation']?.status ?? 'pending';
  const verif = state.stages['verification']?.status ?? 'pending';

  const { getActiveRun } = await import('../core/execution/store.js');
  const run = await getActiveRun(speccraftDir, state.active_run);

  // active_run 指向的 manifest 必须真实存在
  if (state.active_run && !run) {
    violations.push(`state.active_run 指向的 Run 不存在：${state.active_run}`);
  }

  // implementation in_progress / completed 必须有 active run
  if ((impl === 'in_progress' || impl === 'completed') && !run) {
    violations.push(`implementation 处于 ${impl}，但不存在 active run`);
  }

  if (!run) return violations;

  // run status ↔ verification completed（ADR 0004：PASS 后进入 owner acceptance）
  const verifiedRunStatuses: string[] = [
    'verified', // legacy v0.2
    'awaiting_owner_acceptance',
    'accepted',
    'handed_off',
  ];
  if (verif === 'completed' && !verifiedRunStatuses.includes(run.status)) {
    violations.push(`verification = completed，但 run.status 为 ${run.status}`);
  }
  if (verif !== 'completed' && run.status === 'awaiting_owner_acceptance') {
    violations.push(`run.status = awaiting_owner_acceptance，但 verification 状态为 ${verif}`);
  }

  // verification completed 必须存在 PASS attempt
  if (verif === 'completed') {
    const hasPass = await hasPassedAttempt(speccraftDir, run.id);
    if (!hasPass) {
      violations.push('verification = completed，但不存在 PASS verification attempt');
    }
  }

  // implementation completed 必须有 execution report
  if (impl === 'completed' && run.reports.length === 0) {
    violations.push('implementation = completed，但 active run 没有 execution report');
  }

  // run in_progress ↔ implementation in_progress
  if (run.status === 'in_progress' && impl !== 'in_progress') {
    violations.push(`run.status = in_progress，但 implementation 状态为 ${impl}`);
  }

  // run awaiting_verification ↔ implementation completed（verification 未完成）
  if (run.status === 'awaiting_verification' && impl !== 'completed') {
    violations.push(`run.status = awaiting_verification，但 implementation 状态为 ${impl}`);
  }

  // run verification_failed ↔ implementation 应为 in_progress（返工中）
  if (run.status === 'verification_failed' && impl !== 'in_progress') {
    violations.push(`run.status = verification_failed，但 implementation 状态为 ${impl}（应回到 in_progress 返工）`);
  }

  return violations;
}

/** 检查 run 目录中是否存在 passed=true 的 attempt */
async function hasPassedAttempt(speccraftDir: string, runId: string): Promise<boolean> {
  const { readdir, readFile } = await import('node:fs/promises');
  const yaml = (await import('js-yaml')).default;
  const dir = path.join(speccraftDir, 'runs', runId, 'verification');
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return false;
  }
  for (const f of files) {
    if (!/^attempt-\d+\.yaml$/.test(f)) continue;
    try {
      const parsed = yaml.load(await readFile(path.join(dir, f), 'utf8')) as {
        passed?: unknown;
      } | null;
      if (parsed && parsed.passed === true) return true;
    } catch {
      // 单个文件损坏不阻塞整体判断
    }
  }
  return false;
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
