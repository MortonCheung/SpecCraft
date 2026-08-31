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
      if (run.acceptance.attempt > 0) {
        console.log(`  acceptance attempt: ${run.acceptance.attempt}（${run.acceptance.status}）`);
        if (run.acceptance.latestRecord) {
          console.log(`  latest acceptance: ${run.acceptance.latestRecord}`);
        }
      }
      if (run.handoffId) {
        console.log(`  handoff: ${run.handoffId}`);
      }
      // latest dispatch attempt（如有）
      try {
        const { readLatestDispatchAttempt } = await import('../core/dispatch/store.js');
        const latest = await readLatestDispatchAttempt(speccraftDir, run.id);
        if (latest) {
          console.log(`  dispatch attempt: ${latest.attempt}（${latest.adapter}，${latest.status}${latest.session_id ? `，session ${latest.session_id}` : ''}）`);
        }
      } catch {
        // 读取 dispatch 失败不阻塞 status
      }
      console.log('');
    } else {
      console.log(`Active Run: ${state.active_run}（manifest 缺失，请运行 speccraft validate）`);
      console.log('');
    }
  }

  console.log('Stages:');
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
        '  speccraft dispatch（自动）或 speccraft implement finish --report <file>',
      ].join('\n');
    }
    // 返工中：上一次 verification 未通过
    if (run?.status === 'verification_failed') {
      return [
        'Verification 未通过。',
        '在当前 Run 内修复后重新执行 speccraft dispatch（自动）或 implement finish。',
      ].join('\n');
    }
    // dispatch 失败过 → 提示重新 dispatch
    if (run) {
      const { readLatestDispatchAttempt } = await import('../core/dispatch/store.js');
      const latest = await readLatestDispatchAttempt(speccraftDir, run.id);
      if (latest && latest.status !== 'succeeded') {
        return [
          `Dispatch Attempt ${latest.attempt} 失败（${latest.adapter}）。`,
          '修复 adapter/config 后重新执行 speccraft dispatch。',
        ].join('\n');
      }
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
    const { loadProjectConfig } = await import('../core/project.js');
    const config = await loadProjectConfig(speccraftDir);
    const defaultAdapter = config.execution?.defaultAdapter ?? 'manual';
    if (defaultAdapter !== 'manual') {
      return `下一步：speccraft dispatch --adapter ${defaultAdapter}`;
    }
    return '下一步：speccraft implement start';
  }
  if (run.status === 'verification_failed') {
    return [
      'Verification 未通过。',
      '在当前 Run 内修复后重新执行 speccraft dispatch（自动）或 implement finish。',
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

/** speccraft handoff：生成 Handoff Package（确定性交接，幂等） */
export async function cmdHandoff(projectRoot: string = process.cwd()): Promise<number> {
  const { workflow, state, speccraftDir } = await loadProject(projectRoot);
  const { loadProjectConfig } = await import('../core/project.js');
  const config = await loadProjectConfig(speccraftDir);
  const { getActiveRun } = await import('../core/execution/store.js');
  const run = await getActiveRun(speccraftDir, state.active_run);
  if (!run) {
    console.error('错误：没有活跃的 Execution Run，无法 handoff。');
    return 1;
  }
  const { handoff } = await import('../core/handoff/lifecycle.js');
  const result = await handoff(
    speccraftDir,
    projectRoot,
    config.name || path.basename(projectRoot),
    workflow,
    state,
    run,
  );
  const dir = path.join(speccraftDir, 'handoffs', result.handoffId);
  if (result.reused) {
    console.log(`Handoff 已存在，复用现有包：${result.handoffId}`);
  } else {
    console.log(`已生成 Handoff Package：${result.handoffId}`);
  }
  console.log(`路径：${dir}`);
  console.log('handoff = completed');
  return 0;
}

/** speccraft accept [--note <text> | --file <path>] [--by <who>] */
export async function cmdAccept(
  opts: { note?: string; file?: string; by?: string },
  projectRoot: string = process.cwd(),
): Promise<number> {
  const { workflow, state, speccraftDir } = await loadProject(projectRoot);
  const { getActiveRun } = await import('../core/execution/store.js');
  const run = await getActiveRun(speccraftDir, state.active_run);
  if (!run) {
    console.error('错误：没有活跃的 Execution Run，无法 accept。');
    return 1;
  }

  const feedback = await resolveFeedback(opts.note, opts.file, 'acceptance note');
  const { accept } = await import('../core/acceptance/lifecycle.js');
  const { attempt } = await accept(speccraftDir, projectRoot, workflow, state, run, {
    by: opts.by ?? 'owner',
    ...(feedback !== undefined ? { feedback } : {}),
  });
  console.log(`Owner Acceptance：ACCEPTED（acceptance attempt ${attempt}）`);
  console.log('owner-acceptance = completed');
  console.log('下一步：speccraft handoff');
  return 0;
}

/** speccraft reject --reason <text> | --file <path> */
export async function cmdReject(
  opts: { reason?: string; file?: string },
  projectRoot: string = process.cwd(),
): Promise<number> {
  if (!opts.reason && !opts.file) {
    console.error('错误：reject 必须提供反馈（--reason 或 --file 二选一）。');
    return 1;
  }
  const { workflow, state, speccraftDir } = await loadProject(projectRoot);
  const { getActiveRun } = await import('../core/execution/store.js');
  const run = await getActiveRun(speccraftDir, state.active_run);
  if (!run) {
    console.error('错误：没有活跃的 Execution Run，无法 reject。');
    return 1;
  }

  const feedback = (await resolveFeedback(opts.reason, opts.file, 'acceptance feedback')) ?? '';
  if (!feedback.trim()) {
    console.error('错误：reject 反馈不能为空。');
    return 1;
  }
  const { reject } = await import('../core/acceptance/lifecycle.js');
  const { attempt } = await reject(speccraftDir, projectRoot, workflow, state, run, {
    feedback,
  });
  console.log(`Owner Acceptance：REJECTED（acceptance attempt ${attempt}）`);
  console.log('implementation 已重新打开（同一 Run 返工）。');
  console.log('修复后：speccraft implement finish --report <path>');
  return 0;
}

/** 从 --note/--reason 或 --file 解析反馈文本 */
async function resolveFeedback(
  inline: string | undefined,
  file: string | undefined,
  label: string,
): Promise<string | undefined> {
  if (inline !== undefined && inline !== '') return inline;
  if (file) {
    const { readFile } = await import('node:fs/promises');
    return readFile(path.resolve(file), 'utf8');
  }
  return undefined;
}

/** speccraft adapters list：列出全部 adapter（不发真实模型请求） */
export async function cmdAdaptersList(projectRoot: string = process.cwd()): Promise<void> {
  const { listAdapters } = await import('../core/execution/adapters/registry.js');
  const adapters = listAdapters();
  console.log('Adapters:');
  for (const a of adapters) {
    const capabilities = a.kind === 'cli'
      ? `[${Object.entries(a.capabilities).filter(([, v]) => v).map(([k]) => k).join(', ')}]`
      : '';
    console.log(`  ${a.id.padEnd(10)} kind=${a.kind} ${capabilities}`);
  }
}

/** speccraft adapters doctor [id]：本机能力诊断（不发 AI 请求） */
export async function cmdAdaptersDoctor(
  adapterId: string | undefined,
  projectRoot: string = process.cwd(),
): Promise<number> {
  const { getAdapter, listAdapterIds } = await import('../core/execution/adapters/registry.js');
  const ids = adapterId ? [adapterId] : listAdapterIds();
  let failed = false;
  for (const id of ids) {
    const adapter = getAdapter(id);
    if (!adapter) {
      console.log(`${id}: unknown adapter`);
      failed = true;
      continue;
    }
    if (adapter.kind === 'manual') {
      console.log(`${id}: manual (always available)`);
      continue;
    }
    const probe = await adapter.probe();
    if (probe.installed) {
      console.log(`${id}: installed (${probe.version ?? 'version unknown'}) binary=${probe.binary ?? adapter.id}`);
    } else {
      console.log(`${id}: NOT installed${probe.error ? ` — ${probe.error}` : ''}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

/** speccraft dispatch [--adapter <id>] [--run <id>] [--fresh-session] */
export async function cmdDispatch(
  opts: { adapter?: string; run?: string; freshSession?: boolean; task?: string },
  projectRoot: string = process.cwd(),
): Promise<number> {
  const { workflow, state, speccraftDir } = await loadProject(projectRoot);
  const { loadProjectConfig } = await import('../core/project.js');
  const config = await loadProjectConfig(speccraftDir);

  const { getActiveRun, readRun } = await import('../core/execution/store.js');
  const run = opts.run
    ? await readRun(speccraftDir, opts.run)
    : await getActiveRun(speccraftDir, state.active_run);
  if (!run) {
    console.error('错误：没有活跃的 Execution Run，无法 dispatch。');
    return 1;
  }

  const { getAdapter } = await import('../core/execution/adapters/registry.js');
  const adapterId = opts.adapter ?? config.execution?.defaultAdapter ?? 'manual';
  const adapter = getAdapter(adapterId);
  if (!adapter) {
    console.error(`错误：未知 adapter ${adapterId}。`);
    return 1;
  }
  if (adapter.kind !== 'cli') {
    console.error('错误：manual adapter 不支持 dispatch，请用 speccraft implement start。');
    return 1;
  }

  const adapterConfig = config.execution?.adapters[adapterId];

  // Task dispatch（v0.5）：--task 指定单个 Task
  if (opts.task) {
    const { readFile } = await import('node:fs/promises');
    const { readTaskGraph } = await import('../core/tasks/store.js');
    const { dispatchTask } = await import('../core/tasks/dispatch.js');
    const graph = await readTaskGraph(speccraftDir, run.id);
    const task = graph.tasks.find((t) => t.id === opts.task);
    if (!task) {
      console.error(`错误：Task 不存在：${opts.task}`);
      return 1;
    }
    const runContextPath = path.join(speccraftDir, 'runs', run.id, 'context.md');
    let runContext = '';
    try {
      runContext = await readFile(runContextPath, 'utf8');
    } catch {
      runContext = '（无 run context）';
    }
    const { skillsDir } = await import('../utils/paths.js');
    let executionGuard = '';
    try {
      executionGuard = await readFile(path.join(skillsDir, 'execution-guard', 'SKILL.md'), 'utf8');
    } catch {
      executionGuard = '';
    }

    const result = await dispatchTask({
      speccraftDir,
      projectRoot,
      runId: run.id,
      taskId: opts.task,
      adapter,
      runContext,
      executionGuard,
      freshSession: opts.freshSession === true,
      ...(adapterConfig ? { adapterConfig } : {}),
    });

    if (!result.success) {
      console.error(`Task ${opts.task} Dispatch Attempt ${result.attempt} 失败。`);
      console.error(`task ${opts.task} = failed。修复后：speccraft tasks reopen ${opts.task} 或重新 dispatch --task ${opts.task}`);
      return 1;
    }
    console.log(`Task ${opts.task} Dispatch Attempt ${result.attempt} 成功（adapter ${adapter.id}${result.sessionId ? `，session ${result.sessionId}` : ''}）。`);
    console.log(`task ${opts.task} = in_progress（等待 Task Verification）。`);
    console.log(`下一步：speccraft tasks verify ${opts.task}`);
    return 0;
  }

  const promptFile = path.join(speccraftDir, 'runs', run.id, 'agent-prompt.md');

  // before_dispatch hook（blocking）
  const hookCtx = {
    projectRoot,
    speccraftDir,
    runId: run.id,
    env: {
      SPECCRAFT_EVENT: 'before_dispatch',
      SPECCRAFT_PROJECT_ROOT: projectRoot,
      SPECCRAFT_DIR: speccraftDir,
      SPECCRAFT_STAGE: 'implementation',
      SPECCRAFT_ADAPTER: adapter.id,
    },
  };
  const { runBeforeHooks, runAfterHooks } = await import('../core/hooks/lifecycle.js');
  const before = await runBeforeHooks(hookCtx, config.hooks, 'before_dispatch');
  if (before.blocked) {
    console.error('错误：before_dispatch hook 失败，已中止 dispatch。');
    return 1;
  }

  const { dispatchExecution } = await import('../core/dispatch/lifecycle.js');
  const result = await dispatchExecution({
    projectRoot,
    speccraftDir,
    workflow,
    state,
    run,
    adapter,
    promptFile,
    freshSession: opts.freshSession === true,
    ...(adapterConfig ? { adapterConfig } : {}),
  });

  // after_dispatch hook（non-rollback）
  await runAfterHooks(
    { ...hookCtx, env: { ...hookCtx.env, SPECCRAFT_EVENT: 'after_dispatch', SPECCRAFT_DISPATCH_ATTEMPT: String(result.attempt) } },
    config.hooks,
    'after_dispatch',
  );

  if (!result.success) {
    console.error(`Dispatch Attempt ${result.attempt} 失败（adapter ${adapter.id}）。`);
    console.error('implementation 保持 in_progress。修复 adapter/config 后重新 dispatch。');
    return 1;
  }

  console.log(`Dispatch Attempt ${result.attempt} 成功（adapter ${adapter.id}${result.sessionId ? `，session ${result.sessionId}` : ''}）。`);
  console.log(`已生成报告：.speccraft/runs/${run.id}/${result.reportFile}`);
  console.log('implementation = completed');
  console.log('下一步：speccraft verify');
  return 0;
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

  // ---- Acceptance / Handoff 一致性（ADR 0004 §7） ----
  const acceptance = state.stages['owner-acceptance']?.status ?? 'pending';
  const handoff = state.stages['handoff']?.status ?? 'pending';

  // Invariant 1：run awaiting_owner_acceptance → verification completed +
  //   owner-acceptance waiting_owner_approval
  if (run.status === 'awaiting_owner_acceptance') {
    if (verif !== 'completed') {
      violations.push(`run.status = awaiting_owner_acceptance，但 verification 为 ${verif}`);
    }
    if (acceptance !== 'waiting_owner_approval') {
      violations.push(`run.status = awaiting_owner_acceptance，但 owner-acceptance 为 ${acceptance}`);
    }
  }

  // Invariant 2：run acceptance_rejected → implementation in_progress +
  //   verification != completed + owner-acceptance blocked + latest accepted? no（rejected）
  if (run.status === 'acceptance_rejected') {
    if (impl !== 'in_progress') {
      violations.push(`run.status = acceptance_rejected，但 implementation 为 ${impl}`);
    }
    if (verif === 'completed') {
      violations.push('run.status = acceptance_rejected，但 verification 仍为 completed');
    }
    if (acceptance !== 'blocked') {
      violations.push(`run.status = acceptance_rejected，但 owner-acceptance 为 ${acceptance}`);
    }
    if (run.acceptance.status !== 'rejected') {
      violations.push('run.status = acceptance_rejected，但 latest acceptance 不是 rejected');
    }
  }

  // Invariant 3：run accepted → verification completed + owner-acceptance completed +
  //   latest acceptance accepted
  if (run.status === 'accepted') {
    if (verif !== 'completed') {
      violations.push(`run.status = accepted，但 verification 为 ${verif}`);
    }
    if (acceptance !== 'completed') {
      violations.push(`run.status = accepted，但 owner-acceptance 为 ${acceptance}`);
    }
    if (run.acceptance.status !== 'accepted') {
      violations.push('run.status = accepted，但 latest acceptance 不是 accepted');
    }
  }

  // Invariant 4：run handed_off → verification/owner-acceptance/handoff completed +
  //   handoff package 存在
  if (run.status === 'handed_off') {
    if (verif !== 'completed') violations.push('run.status = handed_off，但 verification 未 completed');
    if (acceptance !== 'completed') violations.push('run.status = handed_off，但 owner-acceptance 未 completed');
    if (handoff !== 'completed') violations.push('run.status = handed_off，但 handoff 未 completed');
    if (run.acceptance.status !== 'accepted') violations.push('run.status = handed_off，但 latest acceptance 不是 accepted');
    if (!run.handoffId) violations.push('run.status = handed_off，但缺少 handoff_id');
    if (run.handoffId) {
      const { access: acc } = await import('node:fs/promises');
      const handoffPath = path.join(speccraftDir, 'handoffs', run.handoffId, 'HANDOFF.md');
      try {
        await acc(handoffPath);
      } catch {
        violations.push(`run.status = handed_off，但 handoff package 不存在：${run.handoffId}`);
      }
    }
  }

  // Invariant 5：acceptance attempt 序号连续递增
  const attemptSeq = await checkAcceptanceAttemptSequence(speccraftDir, run.id);
  if (attemptSeq) violations.push(attemptSeq);

  // Invariant 6：acceptance record 引用真实存在的 run + verification attempt
  const refCheck = await checkAcceptanceReferences(speccraftDir, run.id);
  if (refCheck) violations.push(refCheck);

  // ---- Dispatch 一致性（ADR 0005 §4） ----
  violations.push(...(await checkDispatchConsistency(speccraftDir, state, run.id)));

  return violations;
}

/** Dispatch invariant：attempt 编号连续、success/fail 与 implementation 状态一致 */
async function checkDispatchConsistency(
  speccraftDir: string,
  state: State,
  runId: string,
): Promise<string[]> {
  const violations: string[] = [];
  const { listDispatchAttempts, readDispatchAttempt } = await import('../core/dispatch/store.js');
  const attempts = await listDispatchAttempts(speccraftDir, runId);
  if (attempts.length === 0) return violations;

  // 编号必须连续 1..N
  for (let i = 0; i < attempts.length; i++) {
    if (attempts[i] !== i + 1) {
      violations.push(`dispatch attempt 编号不连续：期望 ${i + 1}，实际 ${attempts[i]}`);
      break;
    }
  }

  const latest = await readDispatchAttempt(speccraftDir, runId, attempts[attempts.length - 1]);
  if (!latest) return violations;
  const impl = state.stages['implementation']?.status ?? 'pending';

  // dispatch success 但 implementation 未 completed → 不一致（应已复用 finish）
  if (latest.status === 'succeeded' && impl !== 'completed') {
    violations.push(`latest dispatch 成功，但 implementation 为 ${impl}（应 completed）`);
  }
  // dispatch failed 但 implementation completed → 不一致（失败不得完成）
  if (latest.status !== 'succeeded' && impl === 'completed') {
    violations.push(`latest dispatch 失败，但 implementation 为 completed（不应完成）`);
  }

  return violations;
}

/** Invariant 5：acceptance-001/002/003 必须连续递增 */
async function checkAcceptanceAttemptSequence(
  speccraftDir: string,
  runId: string,
): Promise<string | null> {
  const { readdir } = await import('node:fs/promises');
  const dir = path.join(speccraftDir, 'runs', runId, 'acceptance');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => /^acceptance-\d+\.md$/.test(f));
  } catch {
    return null;
  }
  const nums = files
    .map((f) => Number(f.match(/acceptance-(\d+)\.md/)![1]))
    .sort((a, b) => a - b);
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] !== i + 1) {
      return `acceptance attempt 序号不连续：期望 ${i + 1}，实际 ${nums[i]}`;
    }
  }
  return null;
}

/** Invariant 6：acceptance record 引用真实存在的 run + verification attempt */
async function checkAcceptanceReferences(
  speccraftDir: string,
  runId: string,
): Promise<string | null> {
  const { listAcceptanceRecords } = await import('../core/acceptance/store.js');
  const records = await listAcceptanceRecords(speccraftDir, runId);
  for (const rec of records) {
    if (rec.frontmatter.run_id !== runId) {
      return `acceptance record ${rec.filename} 的 run_id 不匹配（${rec.frontmatter.run_id}）`;
    }
    // verification_attempt 必须 <= 当前 run.verificationAttempts（真实存在的历史）
    const maxAttempt = await readMaxVerificationAttempt(speccraftDir, runId);
    if (rec.frontmatter.verification_attempt > maxAttempt) {
      return `acceptance record ${rec.filename} 引用不存在的 verification attempt ${rec.frontmatter.verification_attempt}`;
    }
  }
  return null;
}

async function readMaxVerificationAttempt(speccraftDir: string, runId: string): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  const dir = path.join(speccraftDir, 'runs', runId, 'verification');
  try {
    const files = (await readdir(dir)).filter((f) => /^attempt-\d+\.yaml$/.test(f));
    return files.length;
  } catch {
    return 0;
  }
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

// ---------------------------------------------------------------------------
// Task Graph CLI（v0.5）
// ---------------------------------------------------------------------------

/** 取 active run；无则抛错 */
async function requireActiveRun(projectRoot: string): Promise<{ speccraftDir: string; runId: string }> {
  const { state, speccraftDir } = await loadProject(projectRoot);
  if (!state.active_run) throw new Error('没有活跃的 Execution Run，请先 speccraft prepare');
  return { speccraftDir, runId: state.active_run };
}

/** speccraft tasks compile：从 execution-manual 编译 Task Graph */
export async function cmdTasksCompile(projectRoot: string = process.cwd()): Promise<number> {
  const { speccraftDir, runId } = await requireActiveRun(projectRoot);
  const { readExecutionManualBody, compileTaskGraph } = await import('../core/tasks/compiler.js');
  try {
    const manualBody = await readExecutionManualBody(speccraftDir);
    const result = await compileTaskGraph({ speccraftDir, runId, manualBody, source: 'execution-manual' });
    console.log(`已编译 Task Graph：${result.graph.tasks.length} 个 Task`);
    for (const [id, status] of Object.entries(result.initial)) {
      console.log(`  ${id}  ${status}`);
    }
    return 0;
  } catch (err) {
    console.error(`错误：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** speccraft tasks list */
export async function cmdTasksList(projectRoot: string = process.cwd()): Promise<number> {
  const { speccraftDir, runId } = await requireActiveRun(projectRoot);
  const { readTaskGraphOrNull } = await import('../core/tasks/store.js');
  const graph = await readTaskGraphOrNull(speccraftDir, runId);
  if (!graph) {
    console.log('当前 Run 没有 Task Graph（legacy Run）。');
    return 0;
  }
  const { readAllTaskManifests } = await import('../core/tasks/store.js');
  const manifests = await readAllTaskManifests(speccraftDir, runId);
  console.log(`Tasks（${graph.tasks.length}）：`);
  for (const t of graph.tasks) {
    const m = manifests.get(t.id);
    const deps = t.dependsOn.length > 0 ? t.dependsOn.join(',') : '-';
    const dA = m?.dispatchAttempts.length ?? 0;
    const vA = m?.verificationAttempts.length ?? 0;
    console.log(`  ${t.id.padEnd(20)} ${(m?.status ?? '?').padEnd(12)} deps=[${deps}] dispatch=${dA} verify=${vA}`);
  }
  return 0;
}

/** speccraft tasks next */
export async function cmdTasksNext(projectRoot: string = process.cwd()): Promise<number> {
  const { speccraftDir, runId } = await requireActiveRun(projectRoot);
  const { readTaskGraphOrNull, readAllTaskManifests } = await import('../core/tasks/store.js');
  const graph = await readTaskGraphOrNull(speccraftDir, runId);
  if (!graph) {
    console.log('当前 Run 没有 Task Graph（legacy Run）。');
    return 0;
  }
  const manifests = await readAllTaskManifests(speccraftDir, runId);
  const { refreshStates, firstReadyTask, hasFailedTask, allCompleted, blockedReason } = await import('../core/tasks/dependency.js');
  const statuses = refreshStates(graph, manifests);

  if (hasFailedTask(statuses)) {
    const failed = graph.tasks.filter((t) => statuses.get(t.id) === 'failed').map((t) => t.id);
    console.log(`有 failed Task：${failed.join(', ')}`);
    console.log('修复后：speccraft tasks reopen <id> 或直接 speccraft dispatch --task <id>');
    return 1;
  }
  if (allCompleted(graph, statuses)) {
    console.log('Task Graph complete。');
    console.log('下一步：speccraft execute（聚合 finish）或 speccraft verify');
    return 0;
  }
  const br = blockedReason(graph, statuses);
  if (br) {
    console.log(`Task ${br.taskId} 被 failed dependency ${br.failedDep} 阻塞。`);
    return 1;
  }
  const next = firstReadyTask(graph, statuses);
  if (next) {
    console.log(`Next task: ${next}`);
    console.log(`下一步：speccraft dispatch --task ${next}`);
    return 0;
  }
  console.log('无 ready Task（可能全部 pending/blocked）。');
  return 1;
}

/** speccraft tasks show <task-id> */
export async function cmdTasksShow(taskId: string, projectRoot: string = process.cwd()): Promise<number> {
  const { speccraftDir, runId } = await requireActiveRun(projectRoot);
  const { readTaskGraph } = await import('../core/tasks/store.js');
  const graph = await readTaskGraph(speccraftDir, runId);
  const task = graph.tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`Task 不存在：${taskId}`);
    return 1;
  }
  const { readTaskManifest } = await import('../core/tasks/store.js');
  const m = await readTaskManifest(speccraftDir, runId, taskId);
  const { listDispatchAttemptsForTask } = await import('../core/dispatch/store.js');
  const { listTaskVerificationAttempts } = await import('../core/tasks/verification/lifecycle.js');
  const dA = await listDispatchAttemptsForTask(speccraftDir, runId, taskId);
  const vA = await listTaskVerificationAttempts(speccraftDir, runId, taskId);

  console.log(`Task: ${task.id}`);
  console.log(`  title: ${task.title}`);
  console.log(`  status: ${m?.status ?? '?'}`);
  console.log(`  summary: ${task.summary}`);
  console.log(`  dependencies: ${task.dependsOn.length > 0 ? task.dependsOn.join(', ') : '（无）'}`);
  console.log(`  scope: ${task.scope.paths.join(', ')}`);
  console.log(`  verification: ${task.verification.commands.join('; ')}（timeout ${task.verification.timeoutSeconds}s）`);
  console.log(`  dispatch attempts: [${dA.join(', ')}]`);
  console.log(`  verification attempts: [${vA.join(', ')}]`);
  if (m?.latestSessionId) console.log(`  provider session: ${m.latestSessionId}`);
  if (m?.lastError) console.log(`  last error: ${m.lastError}`);
  console.log(`  reopened count: ${m?.reopenedCount ?? 0}`);
  return 0;
}

/** speccraft tasks verify <task-id> */
export async function cmdTasksVerify(taskId: string, projectRoot: string = process.cwd()): Promise<number> {
  const { speccraftDir, runId } = await requireActiveRun(projectRoot);
  const { readTaskGraph } = await import('../core/tasks/store.js');
  const graph = await readTaskGraph(speccraftDir, runId);
  const task = graph.tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`Task 不存在：${taskId}`);
    return 1;
  }
  const { verifyTask } = await import('../core/tasks/verification/lifecycle.js');
  try {
    const result = await verifyTask({
      speccraftDir,
      projectRoot,
      runId,
      taskId,
      verification: task.verification,
    });
    console.log(`Task ${taskId} Verification Attempt ${result.attempt}: ${result.passed ? 'PASS' : 'FAIL'}`);
    for (const c of result.commands) {
      console.log(`  ${c.passed ? 'PASS' : 'FAIL'}  ${c.command}`);
    }
    if (result.passed) console.log(`task ${taskId} = completed`);
    else console.log(`task ${taskId} = failed`);
    return result.passed ? 0 : 1;
  } catch (err) {
    console.error(`错误：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** speccraft tasks reopen <task-id> [--cascade] */
export async function cmdTasksReopen(
  taskId: string,
  cascade: boolean,
  projectRoot: string = process.cwd(),
): Promise<number> {
  const { speccraftDir, runId } = await requireActiveRun(projectRoot);
  const { reopenTask } = await import('../core/tasks/rework.js');
  try {
    const result = await reopenTask({ speccraftDir, runId, taskId, cascade });
    console.log(`已重开：${result.reopened.join(', ')}`);
    console.log('历史 evidence 保留。');
    return 0;
  } catch (err) {
    console.error(`错误：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
