import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
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
import { DEFAULT_STAGE_IDS } from '../core/types.js';
import type { StageDefinition, StageStatus, State, Workflow } from '../core/types.js';
import type { ChangeSource } from '../core/changes/types.js';

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
      // Task Graph 摘要（如有）
      try {
        const { readTaskGraphOrNull, readAllTaskManifests } = await import('../core/tasks/store.js');
        const graph = await readTaskGraphOrNull(speccraftDir, run.id);
        if (graph) {
          const manifests = await readAllTaskManifests(speccraftDir, run.id);
          const { refreshStates } = await import('../core/tasks/dependency.js');
          const statuses = refreshStates(graph, manifests);
          const count: Record<string, number> = { ready: 0, in_progress: 0, completed: 0, failed: 0, blocked: 0, pending: 0 };
          for (const s of statuses.values()) count[s] = (count[s] ?? 0) + 1;
          console.log(`Tasks:`);
          console.log(`  total: ${graph.tasks.length}  ready: ${count.ready}  in_progress: ${count.in_progress}  completed: ${count.completed}  failed: ${count.failed}  blocked: ${count.blocked}  pending: ${count.pending}`);

          // v0.6：Execution Mode + Parallel 摘要（§18，不打印历史 Workspace 明细）
          const { listWaves, readWaveManifest } = await import('../core/workspaces/store.js');
          const { listWorkspaceSummaries } = await import('../core/workspaces/diagnostics.js');
          const waves = await listWaves(speccraftDir, run.id);
          console.log(`  Execution Mode: ${waves.length > 0 ? 'parallel' : 'sequential'}`);
          if (waves.length > 0) {
            const latestWave = await readWaveManifest(speccraftDir, run.id, waves[waves.length - 1]);
            if (latestWave) {
              const running = !latestWave.finishedAt;
              console.log(`  Parallel:`);
              console.log(`    current wave: ${latestWave.wave}${running ? '（进行中）' : '（已结束）'}`);
              console.log(`    max parallel: ${latestWave.maxParallel}`);
            }
            const summaries = await listWorkspaceSummaries(speccraftDir, run.id, graph);
            const active = summaries.filter((s) => ['created', 'active', 'verified', 'committed'].includes(s.status)).length;
            const pending = summaries.filter((s) => s.status === 'committed').length;
            const conflict = summaries.filter((s) => s.status === 'integration_conflict').length;
            console.log(`    active workspaces: ${active}`);
            console.log(`    integration pending: ${pending}  conflict: ${conflict}`);
          }

          // v0.7 §52：Executors / Assignments（有 frozen Executor Plan 时；不打印历史 dispatch）
          const { readExecutorPlanOrNull } = await import('../core/executors/store.js');
          const executorPlan = await readExecutorPlanOrNull(speccraftDir, run.id);
          if (executorPlan) {
            console.log('Executors:');
            const seenExecutors = new Set<string>();
            for (const a of executorPlan.assignments) {
              if (!seenExecutors.has(a.executor)) {
                seenExecutors.add(a.executor);
                console.log(`  ${a.executor} → ${a.adapter}`);
              }
            }
            console.log('Assignments:');
            console.log(`  ${executorPlan.assignments.length} tasks`);
            console.log(`  ${new Set(executorPlan.assignments.map((a) => a.executor)).size} executors`);
            console.log(`  ${new Set(executorPlan.assignments.map((a) => a.adapter)).size} adapters`);
            // Parallel mode：active executor capacity（§52，按 Wave 中未 finished 的 executor 统计）
            if (waves.length > 0) {
              const activeByExecutor = new Map<string, number>();
              for (const [taskId, s] of statuses) {
                if (s !== 'in_progress') continue;
                const a = executorPlan.assignments.find((x) => x.taskId === taskId);
                if (a) activeByExecutor.set(a.executor, (activeByExecutor.get(a.executor) ?? 0) + 1);
              }
              if (activeByExecutor.size > 0) {
                const capByExecutor = new Map(executorPlan.assignments.map((a) => [a.executor, a.maxConcurrency]));
                console.log('  active executor capacity:');
                for (const [ex, n] of [...activeByExecutor.entries()].sort()) {
                  const cap = capByExecutor.get(ex);
                  console.log(`    ${ex}: ${n}/${cap ?? '∞'}`);
                }
              }
            }
          }
        }
      } catch {
        // 读取 tasks 失败不阻塞 status
      }
      // v0.8 §91：Review 简要信息 + §19 failed tasks 计数（只统计 review 原因失败的 task）
      try {
        const { readReviewPlanOrNull } = await import('../core/reviews/store.js');
        const reviewPlan = await readReviewPlanOrNull(speccraftDir, run.id);
        if (reviewPlan?.enabled && reviewPlan.gates.length > 0) {
          console.log('Review:');
          console.log(`  enabled`);
          console.log(`  gates: ${reviewPlan.gates.map((g) => g.id).join(', ')}`);
          const { readTaskGraphOrNull, readAllTaskManifests } = await import('../core/tasks/store.js');
          const graph = await readTaskGraphOrNull(speccraftDir, run.id);
          if (graph) {
            const manifests = await readAllTaskManifests(speccraftDir, run.id);
            const { refreshStates } = await import('../core/tasks/dependency.js');
            const statuses = refreshStates(graph, manifests);
            const failedTasks = graph.tasks.filter((t) => statuses.get(t.id) === 'failed');
            let reviewFailed = 0;
            for (const t of failedTasks) {
              const { latestReviewGateStates } = await import('../core/reviews/feedback.js');
              const gates = await latestReviewGateStates(speccraftDir, run.id, t.id);
              if (gates.some((g) => g.decision === 'changes_required' || g.decision === 'error')) reviewFailed += 1;
            }
            console.log(`  failed tasks: ${reviewFailed}`);
          }
        }
      } catch {
        // 读取 review 失败不阻塞 status
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
    const guidance = await nextExecutionGuidance(projectRoot, speccraftDir, state);
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
async function nextExecutionGuidance(projectRoot: string, speccraftDir: string, state: State): Promise<string | null> {
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

  // Task Graph 级下一步（有 task graph 且 implementation 未 completed 时优先）
  if (impl !== 'completed' && state.active_run) {
    const taskGuidance = await taskGraphGuidance(projectRoot, speccraftDir, state.active_run);
    if (taskGuidance) return taskGuidance;
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

/** Task Graph 级下一步引导；无 task graph 返回 null */
async function taskGraphGuidance(projectRoot: string, speccraftDir: string, runId: string): Promise<string | null> {
  const { readTaskGraphOrNull, readAllTaskManifests } = await import('../core/tasks/store.js');
  const graph = await readTaskGraphOrNull(speccraftDir, runId);
  if (!graph) return null;
  const manifests = await readAllTaskManifests(speccraftDir, runId);
  const { refreshStates, firstReadyTask, hasFailedTask, allCompleted } = await import('../core/tasks/dependency.js');
  const statuses = refreshStates(graph, manifests);

  // v0.7 §54：Executor Plan 未生成 / Adapter unavailable 引导（只读，不修改 Git / 状态）
  const { readExecutorPlanOrNull } = await import('../core/executors/store.js');
  const executorPlan = await readExecutorPlanOrNull(speccraftDir, runId);
  const hasExplicitExecutor = graph.tasks.some((t) => t.executor !== undefined);
  if (hasExplicitExecutor && !executorPlan) {
    return 'Compile Task Graph / Executor Plan first.';
  }
  const blockedByTask = new Map<string, { executor: string; adapter: string }>();
  if (executorPlan) {
    const { collectExecutorDiagnostics } = await import('../core/executors/diagnostics.js');
    const diag = await collectExecutorDiagnostics(executorPlan);
    for (const b of diag.blocked) blockedByTask.set(b.taskId, { executor: b.executor, adapter: b.adapter });
  }

  if (hasFailedTask(statuses)) {
    const failed = graph.tasks.filter((t) => statuses.get(t.id) === 'failed').map((t) => t.id);
    const blockedFailed = failed.map((id) => blockedByTask.get(id)).find((b) => b);
    if (blockedFailed) return executorBlockedMessage(blockedFailed);

    // v0.8 §19/§21：review failed guidance（changes_required rework + review ERROR）。
    // review ERROR 即使没有 blocker findings 也必须明确引导，不得退化成普通 unknown failure。
    const { readReviewPlanOrNull } = await import('../core/reviews/store.js');
    const reviewPlan = await readReviewPlanOrNull(speccraftDir, runId);
    if (reviewPlan?.enabled) {
      const { compileLatestReviewFeedback, latestReviewGateStates } = await import('../core/reviews/feedback.js');
      for (const id of failed) {
        const gateStates = await latestReviewGateStates(speccraftDir, runId, id);
        const errorGate = gateStates.find((g) => g.decision === 'error');
        if (errorGate) {
          return [
            `Task ${id} review ERROR（gate ${errorGate.gateId}${errorGate.errorCode ? `，error_code ${errorGate.errorCode}` : ''}）。`,
            '',
            'Inspect:',
            `  speccraft reviews show ${id}`,
            '',
            'Rework:',
            `  speccraft tasks reopen ${id}`,
          ].join('\n');
        }
      }
      for (const id of failed) {
        const fb = await compileLatestReviewFeedback(speccraftDir, runId, id);
        if (fb.hasBlockingFeedback) {
          return [
            `Task ${id} requires review rework.`,
            '',
            'Inspect:',
            `  speccraft reviews show ${id}`,
            '',
            'Then:',
            `  speccraft tasks reopen ${id}`,
          ].join('\n');
        }
      }
    }

    // v0.6 §19：integration conflict 单独提示（需人工 resolution/rework）
    const { readWorkspaceDetail } = await import('../core/workspaces/diagnostics.js');
    const conflicts: string[] = [];
    for (const id of failed) {
      const detail = await readWorkspaceDetail(speccraftDir, runId, id);
      if (detail.some((m) => m.status === 'integration_conflict')) conflicts.push(id);
    }
    if (conflicts.length > 0) {
      return [
        `Task ${conflicts.join(', ')} integration conflict requires human resolution/rework.`,
        `修复后：speccraft tasks reopen ${conflicts[0]}（下一次 execute 将使用新的 Workspace Attempt）`,
      ].join('\n');
    }
    return [
      `有 failed Task：${failed.join(', ')}`,
      `修复后：speccraft tasks reopen ${failed[0]} 或 speccraft dispatch --task ${failed[0]}`,
    ].join('\n');
  }
  if (allCompleted(graph, statuses)) {
    return [
      'Implementation Task Graph complete.',
      'Next:',
      '  speccraft execute（聚合 finish）或 speccraft verify',
    ].join('\n');
  }
  const inProgress = graph.tasks.find((t) => statuses.get(t.id) === 'in_progress');
  if (inProgress) {
    return [
      `Task verification required: ${inProgress.id}`,
      `Next: speccraft tasks verify ${inProgress.id}`,
    ].join('\n');
  }
  const next = firstReadyTask(graph, statuses);
  if (next) {
    // v0.6 §19：多个 ready → 提示 parallel（含 scope 冲突 / canonical dirty 检查，只读不改 Git）
    const readyTasks = graph.tasks.filter((t) => statuses.get(t.id) === 'ready');
    if (readyTasks.length >= 2) {
      // v0.7 §54：任一 ready Task 的 executor adapter 不可用 → 提示 doctor
      const blockedReady = readyTasks.map((t) => blockedByTask.get(t.id)).find((b) => b);
      if (blockedReady) return executorBlockedMessage(blockedReady);
      const { planWave } = await import('../core/parallel/planner.js');
      const plan = planWave({ graph, statuses, maxParallel: 2 });
      const safe = plan.tasks.length;
      const lines: string[] = [];
      if (safe < readyTasks.length) {
        lines.push(`${readyTasks.length} tasks ready, but only ${safe} are safe in the next wave.`);
      } else {
        lines.push(`${readyTasks.length} tasks are ready for parallel execution:`);
      }
      lines.push(...readyTasks.map((t) => `- ${t.id}`));
      lines.push('', 'Run:', '  speccraft execute --parallel');
      const { isCanonicalClean } = await import('../core/workspaces/integration.js');
      if (projectRoot && !(await isCanonicalClean(projectRoot))) {
        return [
          'Parallel execution blocked:',
          'canonical workspace has user changes.',
          '',
          '提交或清理后重试（speccraft next 不自动修改 Git）。',
        ].join('\n');
      }
      return lines.join('\n');
    }
    const blockedNext = blockedByTask.get(next);
    if (blockedNext) return executorBlockedMessage(blockedNext);
    return [
      `Next: dispatch task ${next}`,
      `  speccraft dispatch --task ${next}（或 speccraft execute 自动顺序执行）`,
    ].join('\n');
  }
  return 'Task Graph：无 ready Task（可能全部 pending/blocked）。';
}

/** v0.7 §54：executor adapter 不可用时的 next 引导 */
function executorBlockedMessage(blocked: { executor: string; adapter: string }): string {
  return [
    'Execution blocked:',
    `executor ${blocked.executor} requires unavailable adapter ${blocked.adapter}.`,
    '',
    'Run:',
    'speccraft executors doctor',
  ].join('\n');
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
    // v0.7 §40：Explicit Executor Graph 禁止 --adapter 覆盖（与 cmdExecute 一致）
    const hasExplicitExecutor = graph.tasks.some((t) => t.executor !== undefined);
    if (opts.adapter && hasExplicitExecutor) {
      console.error('错误：--adapter cannot override explicit Task Executor assignments');
      return 1;
    }
    // v0.7 §51 hooks：frozen plan.yaml → ExecutorResolver（ADR 0008 §38），注入 executor 信息
    let resolvedAdapter = adapter;
    let resolvedAdapterConfig = adapterConfig;
    let executorProfile: string | undefined;
    const { readExecutorPlanOrNull } = await import('../core/executors/store.js');
    const { buildExecutorResolver } = await import('../core/executors/resolver.js');
    const executorPlan = opts.adapter ? null : await readExecutorPlanOrNull(speccraftDir, run.id);
    if (executorPlan) {
      try {
        const r = buildExecutorResolver({ plan: executorPlan }).resolve(opts.task);
        resolvedAdapter = r.adapter;
        resolvedAdapterConfig = r.adapterConfig;
        executorProfile = r.executorId;
      } catch (err) {
        console.error(`错误：${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }
    const runContextPath = path.join(speccraftDir, 'runs', run.id, 'context.md');

    // v0.7 §58.1：单 Task Preflight Gate（frozen plan 存在时）。adapter 不可用 →
    // 中止且零副作用（no task status change / no dispatch attempt）。
    if (executorPlan) {
      const { preflightExecutorPlan, formatPreflightBlocked } = await import('../core/executors/preflight.js');
      const singlePlan = {
        ...executorPlan,
        assignments: executorPlan.assignments.filter((a) => a.taskId === opts.task),
      };
      if (singlePlan.assignments.length > 0) {
        const preflight = await preflightExecutorPlan(singlePlan);
        if (preflight.status === 'blocked') {
          console.error(formatPreflightBlocked(preflight));
          console.error('修复后：speccraft executors doctor');
          return 1;
        }
      }
    }

    // v0.8 §22-§25：Review Preflight Gate。review enabled 且 reviewer 不可用 →
    // 零副作用中止（no dispatch / no task mutation / 不 fallback 到其它 reviewer）。
    const { readReviewPlanOrNull } = await import('../core/reviews/store.js');
    const reviewPlan = await readReviewPlanOrNull(speccraftDir, run.id);
    if (reviewPlan?.enabled) {
      const { preflightReviewPlanWithPlan, formatReviewPreflightBlocked } = await import('../core/reviews/preflight.js');
      const reviewPreflight = await preflightReviewPlanWithPlan(reviewPlan);
      if (reviewPreflight.status === 'blocked') {
        console.error(formatReviewPreflightBlocked(reviewPreflight));
        console.error('修复后：speccraft reviews doctor');
        return 1;
      }
    }

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

    // before_dispatch hook（blocking，含 SPECCRAFT_TASK_ID / SPECCRAFT_EXECUTOR_PROFILE）
    const taskHookCtx = {
      projectRoot,
      speccraftDir,
      runId: run.id,
      env: {
        SPECCRAFT_EVENT: 'before_dispatch',
        SPECCRAFT_PROJECT_ROOT: projectRoot,
        SPECCRAFT_DIR: speccraftDir,
        SPECCRAFT_STAGE: 'implementation',
        SPECCRAFT_ADAPTER: resolvedAdapter.id,
        SPECCRAFT_TASK_ID: opts.task,
        ...(executorProfile ? { SPECCRAFT_EXECUTOR_PROFILE: executorProfile } : {}),
      },
    };
    const { runBeforeHooks, runAfterHooks } = await import('../core/hooks/lifecycle.js');
    const taskBefore = await runBeforeHooks(taskHookCtx, config.hooks, 'before_dispatch');
    if (taskBefore.blocked) {
      console.error('错误：before_dispatch hook 失败，已中止 dispatch。');
      return 1;
    }

    const result = await dispatchTask({
      speccraftDir,
      projectRoot,
      runId: run.id,
      taskId: opts.task,
      adapter: resolvedAdapter,
      runContext,
      executionGuard,
      freshSession: opts.freshSession === true,
      ...(resolvedAdapterConfig ? { adapterConfig: resolvedAdapterConfig } : {}),
      ...(executorProfile ? { executorProfile } : {}),
    });

    await runAfterHooks(
      { ...taskHookCtx, env: { ...taskHookCtx.env, SPECCRAFT_EVENT: 'after_dispatch', SPECCRAFT_DISPATCH_ATTEMPT: String(result.attempt) } },
      config.hooks,
      'after_dispatch',
    );

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
  violations.push(...(await validateExecutionConsistency(speccraftDir, state, workflow)));
  // v0.7 §55：16 Workflow Stages unchanged（不变量）
  violations.push(...checkWorkflowStagesInvariant(workflow));
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
async function validateExecutionConsistency(
  speccraftDir: string,
  state: State,
  workflow: Workflow,
): Promise<string[]> {
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

  // ---- Task Graph 一致性（ADR 0006） ----
  violations.push(...(await checkTaskConsistency(speccraftDir, run.id)));

  // ---- Workspace / Parallel 一致性（ADR 0007 §20） ----
  violations.push(...(await checkWorkspaceConsistency(speccraftDir, run.id)));

  // ---- Executor Plan 一致性（v0.7 §55：Executor invariants） ----
  violations.push(...(await checkExecutorPlanConsistency(speccraftDir, run.id)));

  // ---- Review 一致性（v0.8 §16：Review invariants） ----
  violations.push(...(await checkReviewConsistency(speccraftDir, run.id)));

  return violations;
}

/** v0.7 §55：16 Workflow Stages unchanged（不变量） */
function checkWorkflowStagesInvariant(workflow: Workflow): string[] {
  const stageIds = workflow.stages.map((s) => s.id);
  if (stageIds.length !== DEFAULT_STAGE_IDS.length) {
    return [`16 Workflow Stages unchanged 违规：workflow 有 ${stageIds.length} 个阶段，预期 ${DEFAULT_STAGE_IDS.length}`];
  }
  for (let i = 0; i < DEFAULT_STAGE_IDS.length; i++) {
    if (stageIds[i] !== DEFAULT_STAGE_IDS[i]) {
      return [
        `16 Workflow Stages unchanged 违规：第 ${i + 1} 个阶段为 "${stageIds[i]}"，预期 "${DEFAULT_STAGE_IDS[i]}"`,
      ];
    }
  }
  return [];
}

/**
 * Review 一致性（v0.8 §16）。
 *
 * 只读 frozen Review Plan / task graph + manifests / review attempt manifests /
 * dispatch / verification / workspace evidence，不修改任何状态。
 * review disabled 或无 frozen plan → 无 Review invariant（legacy 兼容跳过）。
 */
async function checkReviewConsistency(
  speccraftDir: string,
  runId: string,
): Promise<string[]> {
  const violations: string[] = [];
  const { readReviewPlanOrNull } = await import('../core/reviews/store.js');
  const { isValidReviewGateKind, listReviewAttempts, listTaskReviewEvidence } = await import('../core/reviews/attempt.js');
  const plan = await readReviewPlanOrNull(speccraftDir, runId);
  if (!plan || !plan.enabled) return violations;

  // ---- Plan（§16 Plan invariants） ----
  if (plan.run_id !== runId) {
    violations.push(`Review Plan run_id ${plan.run_id} 不匹配 Run ID ${runId}`);
  }
  const gateIds = plan.gates.map((g) => g.id);
  if (new Set(gateIds).size !== gateIds.length) {
    violations.push('Review Plan gate ids 重复');
  }
  for (const g of plan.gates) {
    if (!isValidReviewGateKind(g.kind)) {
      violations.push(`Review Plan gate ${g.id} 的 kind 非法：${g.kind}`);
    }
  }

  const { readTaskGraphOrNull, readAllTaskManifests } = await import('../core/tasks/store.js');
  const graph = await readTaskGraphOrNull(speccraftDir, runId);
  const graphTaskIds = new Set((graph?.tasks ?? []).map((t) => t.id));
  const byGate = new Map(plan.gates.map((g) => [g.id, g]));

  // dispatch evidence（global attempt number → manifest；供 source/session reference 检查）
  const { listDispatchAttempts, readDispatchAttempt } = await import('../core/dispatch/store.js');
  const dispatchByNumber = new Map<number, { task_id?: string; session_id?: string }>();
  for (const a of await listDispatchAttempts(speccraftDir, runId)) {
    const dm = await readDispatchAttempt(speccraftDir, runId, a);
    if (dm) dispatchByNumber.set(a, dm);
  }

  // ---- Attempt references / Source Evidence / Mutation / Session independence ----
  const { listTaskVerificationAttempts } = await import('../core/tasks/verification/lifecycle.js');
  for (const t of graph?.tasks ?? []) {
    const existingVerification = new Set(await listTaskVerificationAttempts(speccraftDir, runId, t.id));
    for (const gate of plan.gates) {
      const attempts = await listReviewAttempts(speccraftDir, runId, t.id, gate.id);
      if (attempts.length === 0) continue;
      const seenSessions = new Set<string>();
      for (const m of attempts) {
        const label = `task ${t.id} gate ${gate.id} attempt ${m.attempt}`;
        // Attempt references：reviewer_profile / adapter 必须与 frozen gate 一致
        if (m.reviewer_profile !== gate.reviewer) {
          violations.push(`Review ${label} reviewer_profile（${m.reviewer_profile}）≠ frozen gate.reviewer（${gate.reviewer}）`);
        }
        if (m.adapter !== gate.adapter) {
          violations.push(`Review ${label} adapter（${m.adapter}）≠ frozen gate.adapter（${gate.adapter}）`);
        }
        // Mutation：error_code == reviewer_mutation 时 decision 不得是 pass
        if (m.error_code === 'reviewer_mutation' && m.decision === 'pass') {
          violations.push(`Review ${label} error_code=reviewer_mutation，但 decision 为 pass（不得放行）`);
        }
        // Session independence：同 task 的 review session 不得等于 executor dispatch session
        const dm = dispatchByNumber.get(m.source_dispatch_attempt);
        if (m.session_id && dm?.session_id && m.session_id === dm.session_id) {
          violations.push(`Review ${label} session 不得等于 executor dispatch session（source dispatch ${m.source_dispatch_attempt}）`);
        }
        // 同 Gate 多 attempts：非空 session_id 不得重复
        if (m.session_id) {
          if (seenSessions.has(m.session_id)) {
            violations.push(`Review ${label} 复用 session ${m.session_id}（同 gate 多 attempts 必须 fresh session）`);
          }
          seenSessions.add(m.session_id);
        }
        // Source Evidence：source dispatch attempt 必须真实存在且属于同一 task
        const srcDispatch = dispatchByNumber.get(m.source_dispatch_attempt);
        if (!srcDispatch || srcDispatch.task_id !== t.id) {
          violations.push(`Review ${label} 引用不存在的 source dispatch attempt ${m.source_dispatch_attempt}（task ${t.id}）`);
        }
        // Source Evidence：source verification attempt 必须真实存在
        if (!existingVerification.has(m.source_verification_attempt)) {
          violations.push(`Review ${label} 引用不存在的 source verification attempt ${m.source_verification_attempt}`);
        }
        // Source Evidence：Review PASS 要求 source verification PASS
        if (m.decision === 'pass' && existingVerification.has(m.source_verification_attempt)) {
          const vPassed = await readVerificationPassed(speccraftDir, runId, t.id, m.source_verification_attempt);
          if (vPassed !== true) {
            violations.push(`Review ${label} decision=pass，但 source verification attempt ${m.source_verification_attempt} 不是 PASS`);
          }
        }
      }
    }
  }

  // ---- Completion / Stale Evidence（§16） ----
  // Review evidence 引用已不存在的 task / gate（plan 外 gate）—— 遍历 evidence 目录
  const { readdir } = await import('node:fs/promises');
  const tasksRoot = path.join(speccraftDir, 'runs', runId, 'tasks');
  let taskDirs: string[] = [];
  try {
    taskDirs = (await readdir(tasksRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    taskDirs = [];
  }
  for (const taskId of taskDirs) {
    if (taskId.startsWith('.')) continue;
    const gateEvidence = await listTaskReviewEvidence(speccraftDir, runId, taskId);
    for (const { gateId, attempts } of gateEvidence) {
      if (!byGate.has(gateId)) {
        violations.push(`Review evidence 的 gate ${gateId}（task ${taskId}）不在 frozen Review Plan`);
      }
      if (attempts.length > 0 && !graphTaskIds.has(taskId)) {
        violations.push(`Review evidence 引用不存在的 task：${taskId}（gate ${gateId}）`);
      }
    }
  }

  // 有 Task Graph 时断言 completion invariants
  if (graph) {
    const manifests = await readAllTaskManifests(speccraftDir, runId);
    const { isCurrentReviewSatisfied } = await import('../core/reviews/feedback.js');
    for (const t of graph.tasks) {
      const m = manifests.get(t.id);
      if (m?.status !== 'completed') continue;
      const dispatchAttempts = [...dispatchByNumber.keys()]
        .filter((n) => dispatchByNumber.get(n)?.task_id === t.id)
        .sort((a, b) => a - b);
      const verificationAttempts = await listTaskVerificationAttempts(speccraftDir, runId, t.id);
      if (dispatchAttempts.length === 0 || verificationAttempts.length === 0) continue;
      const latestDispatch = dispatchAttempts[dispatchAttempts.length - 1];
      const latestVerification = verificationAttempts[verificationAttempts.length - 1];
      const r = await isCurrentReviewSatisfied(
        speccraftDir, runId, t.id, latestDispatch, latestVerification,
      );
      if (!r.satisfied) {
        violations.push(`Task ${t.id} completed，但 required review gates 未满足最新 dispatch/verification（${latestDispatch}/${latestVerification}）：${r.reason}`);
      }
    }

    // Parallel：workspace integrated → required review gates satisfied（§16 Parallel）
    const { listWorkspaceAttempts, readWorkspace } = await import('../core/workspaces/store.js');
    for (const t of graph.tasks) {
      for (const attemptNum of await listWorkspaceAttempts(speccraftDir, runId, t.id)) {
        const wm = await readWorkspace(speccraftDir, runId, t.id, attemptNum);
        if (!wm || wm.status !== 'integrated') continue;
        const wDispatch = wm.dispatchAttempts?.filter((n) => dispatchByNumber.has(n)).sort((a, b) => a - b) ?? [];
        const wVerification = [...(wm.verificationAttempts ?? [])].sort((a, b) => a - b);
        if (wDispatch.length === 0 || wVerification.length === 0) continue;
        const r = await isCurrentReviewSatisfied(
          speccraftDir, runId, t.id, wDispatch[wDispatch.length - 1], wVerification[wVerification.length - 1],
        );
        if (!r.satisfied) {
          violations.push(`Task ${t.id} workspace attempt ${attemptNum} 已 integrated，但 required review gates 未满足：${r.reason}`);
        }
      }
    }
  }

  return violations;
}

/** 读取某 task 的 verification attempt manifest 的 passed 字段（缺失/损坏 → null） */
async function readVerificationPassed(
  speccraftDir: string,
  runId: string,
  taskId: string,
  attempt: number,
): Promise<boolean | null> {
  const { readFile } = await import('node:fs/promises');
  const yaml = (await import('js-yaml')).default;
  const file = path.join(
    speccraftDir, 'runs', runId, 'tasks', taskId, 'verification',
    `attempt-${String(attempt).padStart(3, '0')}`, 'manifest.yaml',
  );
  try {
    const parsed = yaml.load(await readFile(file, 'utf8')) as { passed?: unknown } | null;
    if (parsed && typeof parsed.passed === 'boolean') return parsed.passed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Executor Plan 一致性（v0.7 §55）。
 *
 * 只读 frozen plan.yaml / task graph / workspace manifests / dispatch attempts，
 * 不修改任何状态。legacy Run（无 Executor Plan）跳过大部分校验。
 */
async function checkExecutorPlanConsistency(
  speccraftDir: string,
  runId: string,
): Promise<string[]> {
  const violations: string[] = [];
  const { readExecutorPlanOrNull } = await import('../core/executors/store.js');
  const { readTaskGraphOrNull } = await import('../core/tasks/store.js');
  const { isValidExecutorId } = await import('../core/executors/resolver.js');
  const { LEGACY_EXECUTOR_ID } = await import('../core/executors/types.js');
  const { loadProjectConfig } = await import('../core/project.js');
  const graph = await readTaskGraphOrNull(speccraftDir, runId);
  const plan = await readExecutorPlanOrNull(speccraftDir, runId);

  if (!plan) {
    // 无 Executor Plan：Explicit Executor Graph 必须已 compile（其余 legacy 兼容跳过）
    if (graph && graph.tasks.some((t) => t.executor !== undefined)) {
      violations.push('graph 声明了 explicit task.executor，但缺少 Executor Plan（请先 speccraft tasks compile）');
    }
    return violations;
  }

  // 1. Executor Plan run_id == Run ID
  if (plan.runId !== runId) {
    violations.push(`Executor Plan run_id ${plan.runId} 不匹配 Run ID ${runId}`);
  }

  // 2. 每个 Task 恰好一个 assignment（无重复 taskId）
  const seenTask = new Set<string>();
  for (const a of plan.assignments) {
    if (seenTask.has(a.taskId)) {
      violations.push(`Executor Plan 中 task ${a.taskId} 出现多个 assignment`);
    }
    seenTask.add(a.taskId);
  }

  if (!graph) {
    // 有 plan 但无 Task Graph：run 无 graph（异常态，但图相关校验无法进行）
    return violations;
  }
  const graphIds = graph.tasks.map((t) => t.id);

  // 3. assignment Task 必须存在
  for (const a of plan.assignments) {
    if (!graphIds.includes(a.taskId)) {
      violations.push(`Executor assignment 引用不存在的 task：${a.taskId}`);
    }
  }

  // 4. graph Task 必须有 assignment
  const byTask = new Map(plan.assignments.map((a) => [a.taskId, a]));
  for (const t of graph.tasks) {
    if (!byTask.has(t.id)) {
      violations.push(`Task ${t.id} 缺少 Executor assignment`);
    }
  }

  const config = await loadProjectConfig(speccraftDir);
  const executors = config.execution?.executors ?? {};
  const adapters = config.execution?.adapters ?? {};
  const defaultAdapter = config.execution?.defaultAdapter ?? 'manual';

  // 5. explicit task.executor == assignment.executor
  // 13. unknown executor → invalid
  for (const t of graph.tasks) {
    const a = byTask.get(t.id);
    if (t.executor !== undefined && a && a.executor !== t.executor) {
      violations.push(`Task ${t.id} 显式 executor "${t.executor}" 不匹配 assignment executor "${a.executor}"`);
    }
    if (!isValidExecutorId(t.id)) continue;
    if (t.executor !== undefined && !isValidExecutorId(t.executor)) {
      violations.push(`unknown executor → invalid：task ${t.id} 的 executor "${t.executor}"`);
    }
  }

  // 6. assignment executor 必须存在（config.execution.executors 或 legacy-default）
  for (const a of plan.assignments) {
    if (a.executor === LEGACY_EXECUTOR_ID) continue; // legacy 逻辑 profile
    if (!executors[a.executor]) {
      violations.push(`assignment executor ${a.executor}（task ${a.taskId}）不存在于 project.yaml execution.executors`);
    }
  }

  // 7. assignment adapter 必须存在（config.execution.adapters 或 legacy default_adapter）
  for (const a of plan.assignments) {
    const known = a.adapter === defaultAdapter || adapters[a.adapter] !== undefined;
    if (!known) {
      violations.push(`assignment adapter ${a.adapter}（task ${a.taskId}）不存在于 project.yaml execution.adapters`);
    }
  }

  // 8. workspace.executor_profile == assignment.executor（遍历 workspace manifests）
  const { listWorkspaceAttempts, readWorkspace } = await import('../core/workspaces/store.js');
  for (const t of graph.tasks) {
    const a = byTask.get(t.id);
    if (!a) continue;
    for (const attempt of await listWorkspaceAttempts(speccraftDir, runId, t.id)) {
      const ws = await readWorkspace(speccraftDir, runId, t.id, attempt);
      if (!ws) continue;
      if (ws.executorProfile !== undefined && ws.executorProfile !== a.executor) {
        violations.push(
          `workspace ${t.id}/attempt-${String(attempt).padStart(3, '0')} executor_profile ${ws.executorProfile} 不匹配 assignment executor ${a.executor}`,
        );
      }
    }
  }

  // 9/10. dispatch.executor_profile == assignment.executor；dispatch.adapter == assignment.adapter
  // 11. 同 Task retry 不得改变 executor profile
  // 14. manual executor 不得出现在 auto execution evidence
  const { listDispatchAttempts, readDispatchAttempt } = await import('../core/dispatch/store.js');
  const attempts = await listDispatchAttempts(speccraftDir, runId);
  const profileByTask = new Map<string, Set<string>>();
  for (const n of attempts) {
    const m = await readDispatchAttempt(speccraftDir, runId, n);
    if (!m) continue;
    const a = m.task_id ? byTask.get(m.task_id) : undefined;
    // 9：dispatch.executor_profile == assignment.executor
    if (a && m.executor_profile !== undefined && m.executor_profile !== a.executor) {
      violations.push(`dispatch attempt ${n} executor_profile ${m.executor_profile} 不匹配 assignment executor ${a.executor}`);
    }
    // 10：dispatch.adapter == assignment.adapter
    if (a && m.adapter && m.adapter !== a.adapter) {
      violations.push(`dispatch attempt ${n} adapter ${m.adapter} 不匹配 assignment adapter ${a.adapter}`);
    }
    // 14：manual executor 不得出现在 auto execution evidence
    const effectiveAdapter = a?.adapter ?? m.adapter;
    if (effectiveAdapter === 'manual') {
      violations.push(`manual executor cannot be auto-dispatched：dispatch attempt ${n} 使用 manual adapter`);
    }
    // 11：同 Task retry 的 executor profile 集合
    if (m.task_id && m.executor_profile !== undefined) {
      if (!profileByTask.has(m.task_id)) profileByTask.set(m.task_id, new Set());
      profileByTask.get(m.task_id)!.add(m.executor_profile);
    }
  }
  for (const [taskId, profiles] of profileByTask) {
    if (profiles.size > 1) {
      violations.push(`Task ${taskId} retry 改变了 executor profile：${[...profiles].join(' → ')}`);
    }
  }

  // 12. new Workspace Attempt 不得改变 executor profile
  for (const t of graph.tasks) {
    const profiles = new Set<string>();
    for (const attempt of await listWorkspaceAttempts(speccraftDir, runId, t.id)) {
      const ws = await readWorkspace(speccraftDir, runId, t.id, attempt);
      if (ws?.executorProfile) profiles.add(ws.executorProfile);
    }
    if (profiles.size > 1) {
      violations.push(`Task ${t.id} 的 new Workspace Attempt 改变了 executor profile：${[...profiles].join(' → ')}`);
    }
  }

  return violations;
}

/** Workspace invariant（§20）：workspace ↔ task / attempt / branch / integration 一致性 */
async function checkWorkspaceConsistency(speccraftDir: string, runId: string): Promise<string[]> {
  const violations: string[] = [];
  const { readTaskGraphOrNull, readAllTaskManifests } = await import('../core/tasks/store.js');
  const graph = await readTaskGraphOrNull(speccraftDir, runId);
  if (!graph) return violations; // legacy Run 无 workspace

  const { listWaves } = await import('../core/workspaces/store.js');
  const waves = await listWaves(speccraftDir, runId);
  const { listWorkspaceSummaries } = await import('../core/workspaces/diagnostics.js');
  const summaries = await listWorkspaceSummaries(speccraftDir, runId, graph);
  if (waves.length === 0 && summaries.length === 0) return violations; // sequential route

  const manifests = await readAllTaskManifests(speccraftDir, runId);
  const taskIds = graph.tasks.map((t) => t.id);
  const seenRoots = new Map<string, string>();
  const seenBranches = new Map<string, string>();
  const integratedTasks = new Set<string>();

  const byTask = new Map<string, typeof summaries>();
  for (const s of summaries) {
    if (!byTask.has(s.taskId)) byTask.set(s.taskId, []);
    byTask.get(s.taskId)!.push(s);
  }

  for (const s of summaries) {
    const label = `${s.taskId}/attempt-${String(s.attempt).padStart(3, '0')}`;
    // active workspace ↔ task 存在
    if (!taskIds.includes(s.taskId)) {
      violations.push(`workspace ${label} 引用不存在的 task_id ${s.taskId}`);
      continue;
    }
    // workspaceRoot / branch 唯一（parallel Task 不共享）
    if (s.workspaceRoot) {
      if (seenRoots.has(s.workspaceRoot)) {
        violations.push(`workspace ${label} 与 ${seenRoots.get(s.workspaceRoot)} 共享 workspaceRoot：${s.workspaceRoot}`);
      } else {
        seenRoots.set(s.workspaceRoot, label);
      }
    }
    if (s.branch) {
      if (seenBranches.has(s.branch)) {
        violations.push(`workspace ${label} 与 ${seenBranches.get(s.branch)} 共享 branch：${s.branch}`);
      } else {
        seenBranches.set(s.branch, label);
      }
    }
    // base commit 字段合法
    if (!/^[0-9a-f]{7,40}$/.test(s.baseCommit)) {
      violations.push(`workspace ${label} 的 base_commit 非法：${s.baseCommit}`);
    }
    if (s.taskCommit && !/^[0-9a-f]{7,40}$/.test(s.taskCommit)) {
      violations.push(`workspace ${label} 的 task_commit 非法：${s.taskCommit}`);
    }
    if (s.status === 'integrated' || s.status === 'cleaned') {
      integratedTasks.add(s.taskId);
      // Workspace integrated → Task 必须 completed
      if (manifests.get(s.taskId)?.status !== 'completed') {
        violations.push(`workspace ${label} 已 integrated，但 task ${s.taskId} 状态为 ${manifests.get(s.taskId)?.status ?? '?'}`);
      }
    }
    if (s.status === 'integration_conflict') {
      // integration_conflict → task 不得 completed
      if (manifests.get(s.taskId)?.status === 'completed') {
        violations.push(`workspace ${label} 为 integration_conflict，但 task ${s.taskId} 为 completed`);
      }
    }
  }

  // Task completed in parallel route → 必须存在 integrated workspace evidence
  if (waves.length > 0) {
    for (const t of graph.tasks) {
      if (manifests.get(t.id)?.status === 'completed' && !integratedTasks.has(t.id)) {
        violations.push(`task ${t.id} 在 parallel route 为 completed，但缺少 integrated workspace evidence`);
      }
    }
  }

  // workspace verified → task 不得已经 completed（除非 subsequently integrated）
  for (const [taskId, list] of byTask) {
    const hasIntegrated = list.some((s) => s.status === 'integrated' || s.status === 'cleaned');
    const hasVerifiedOnly = list.some((s) => s.status === 'verified' || s.status === 'committed');
    if (manifests.get(taskId)?.status === 'completed' && hasVerifiedOnly && !hasIntegrated) {
      violations.push(`task ${taskId} 为 completed，但最新 workspace 仅 verified/committed（未 integration）`);
    }
  }

  // dispatch attempt 的 workspace_attempt 必须对应实际 Workspace Attempt
  const { listDispatchAttempts, readDispatchAttempt } = await import('../core/dispatch/store.js');
  for (const a of await listDispatchAttempts(speccraftDir, runId)) {
    const m = await readDispatchAttempt(speccraftDir, runId, a);
    if (!m?.workspace_attempt || !m.task_id) continue;
    const attempts = byTask.get(m.task_id)?.map((s) => s.attempt) ?? [];
    if (!attempts.includes(m.workspace_attempt)) {
      violations.push(`dispatch attempt ${a} 引用不存在的 workspace attempt：${m.task_id}/${m.workspace_attempt}`);
    }
    if (m.workspace_root && m.task_id) {
      const list = byTask.get(m.task_id) ?? [];
      if (!list.some((s) => s.workspaceRoot === m.workspace_root)) {
        violations.push(`dispatch attempt ${a} 的 workspace_root 不匹配任何 workspace：${m.workspace_root}`);
      }
    }
  }

  // scope audit violations 非空 → workspace 不得 integrated
  const { readWorkspaceDetail } = await import('../core/workspaces/diagnostics.js');
  for (const t of graph.tasks) {
    for (const m of await readWorkspaceDetail(speccraftDir, runId, t.id)) {
      if (m.scopeAudit.violations.length > 0 && (m.status === 'integrated' || m.status === 'cleaned')) {
        violations.push(`workspace ${t.id}/attempt-${String(m.attempt).padStart(3, '0')} 有 scope violations 却已 integrated`);
      }
      // workspace run_id / task_id 一致性
      if (m.runId !== runId) {
        violations.push(`workspace ${t.id}/attempt-${String(m.attempt).padStart(3, '0')} 的 run_id 不匹配：${m.runId}`);
      }
      if (m.taskId !== t.id) {
        violations.push(`workspace 目录 task ${t.id} 下 manifest task_id 为 ${m.taskId}`);
      }
    }
  }

  return violations;
}

/** Task Graph invariant：schema/DAG/manifest/evidence 一致性 */
async function checkTaskConsistency(speccraftDir: string, runId: string): Promise<string[]> {
  const violations: string[] = [];
  const { readTaskGraphOrNull, readAllTaskManifests } = await import('../core/tasks/store.js');
  const graph = await readTaskGraphOrNull(speccraftDir, runId);
  if (!graph) return violations; // legacy Run 不强制 Task Graph

  // task id 唯一
  const ids = graph.tasks.map((t) => t.id);
  if (new Set(ids).size !== ids.length) {
    violations.push('Task Graph 存在重复 task id');
  }

  // 依赖存在 + 无 self + 无 cycle（复用 compiler 校验）
  const { validateGraphConstraints } = await import('../core/tasks/compiler.js');
  try {
    validateGraphConstraints(graph);
  } catch (err) {
    violations.push(`Task Graph 约束违规：${err instanceof Error ? err.message : String(err)}`);
  }

  const manifests = await readAllTaskManifests(speccraftDir, runId);
  const { refreshStates } = await import('../core/tasks/dependency.js');
  const statuses = refreshStates(graph, manifests);

  // manifest id 匹配 graph + completed 必须有 PASS verification
  for (const t of graph.tasks) {
    const m = manifests.get(t.id);
    if (!m) {
      violations.push(`Task ${t.id} 缺少 manifest`);
      continue;
    }
    if (m.id !== t.id) {
      violations.push(`Task manifest id 不匹配：${m.id} != ${t.id}`);
    }
    if (m.status === 'completed' && m.verificationAttempts.length === 0) {
      violations.push(`Task ${t.id} 为 completed 但没有 Task Verification attempt`);
    }
  }

  // failed task 的 dependents 不得 ready
  for (const t of graph.tasks) {
    const depFailed = t.dependsOn.some((d) => statuses.get(d) === 'failed');
    if (depFailed && statuses.get(t.id) === 'ready') {
      violations.push(`Task ${t.id} 依赖 failed 但状态为 ready`);
    }
  }

  // task dispatch attempt 的 task_id 必须存在于 graph
  const { listDispatchAttempts, readDispatchAttempt } = await import('../core/dispatch/store.js');
  const attempts = await listDispatchAttempts(speccraftDir, runId);
  for (const a of attempts) {
    const m = await readDispatchAttempt(speccraftDir, runId, a);
    if (m?.task_id && !ids.includes(m.task_id)) {
      violations.push(`dispatch attempt ${a} 引用不存在的 task_id ${m.task_id}`);
    }
  }

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

/** speccraft tasks compile：从 execution-manual 编译 Task Graph + Executor Plan */
export async function cmdTasksCompile(projectRoot: string = process.cwd()): Promise<number> {
  const { speccraftDir, runId } = await requireActiveRun(projectRoot);
  const { loadProjectConfig } = await import('../core/project.js');
  const projectConfig = await loadProjectConfig(speccraftDir);
  const { readExecutionManualBody, compileTaskGraph } = await import('../core/tasks/compiler.js');
  try {
    const manualBody = await readExecutionManualBody(speccraftDir);
    const result = await compileTaskGraph({
      speccraftDir,
      runId,
      manualBody,
      source: 'execution-manual',
      projectConfig,
    });
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
    // v0.8 §19：review failed 任务优先引导 reviews show / tasks reopen
    const { readReviewPlanOrNull } = await import('../core/reviews/store.js');
    const reviewPlan = await readReviewPlanOrNull(speccraftDir, runId);
    if (reviewPlan?.enabled) {
      const { latestReviewGateStates } = await import('../core/reviews/feedback.js');
      for (const id of failed) {
        const gates = await latestReviewGateStates(speccraftDir, runId, id);
        const failedGate = gates.find((g) => g.decision === 'changes_required' || g.decision === 'error');
        if (failedGate) {
          console.log(`Task ${id} review ${failedGate.decision === 'error' ? 'ERROR' : 'rework required'}（gate ${failedGate.gateId}）。`);
          console.log(`查看：speccraft reviews show ${id}`);
          console.log(`重开：speccraft tasks reopen ${id}`);
          return 1;
        }
      }
    }
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
  // v0.7 §53：Executor / Adapter / Assignment source（只读 frozen plan.yaml）
  const { readExecutorPlanOrNull } = await import('../core/executors/store.js');
  const executorPlan = await readExecutorPlanOrNull(speccraftDir, runId);
  const assignment = executorPlan?.assignments.find((a) => a.taskId === taskId);
  if (assignment) {
    console.log(`  executor: ${assignment.executor}`);
    console.log(`  adapter: ${assignment.adapter}`);
    console.log(`  assignment source: ${assignment.source}`);
  } else {
    // legacy：无 plan → legacy-default 逻辑 profile；adapter 取最新 dispatch attempt
    let legacyAdapter = 'manual';
    if (dA.length > 0) {
      const { readDispatchAttempt } = await import('../core/dispatch/store.js');
      const last = await readDispatchAttempt(speccraftDir, runId, dA[dA.length - 1]);
      if (last?.adapter) legacyAdapter = last.adapter;
    }
    console.log('  executor: legacy-default');
    console.log(`  adapter: ${legacyAdapter}`);
    console.log('  assignment source: legacy');
  }
  console.log(`  verification: ${task.verification.commands.join('; ')}（timeout ${task.verification.timeoutSeconds}s）`);
  console.log(`  dispatch attempts: [${dA.join(', ')}]`);
  console.log(`  verification attempts: [${vA.join(', ')}]`);
  if (m?.latestSessionId) console.log(`  provider session: ${m.latestSessionId}`);
  if (m?.lastError) console.log(`  last error: ${m.lastError}`);
  console.log(`  reopened count: ${m?.reopenedCount ?? 0}`);
  // v0.8 §92：Review status per gate
  try {
    const { readReviewPlanOrNull } = await import('../core/reviews/store.js');
    const { reviewEvidenceDir } = await import('../core/reviews/paths.js');
    const { readdir } = await import('node:fs/promises');
    const reviewPlan = await readReviewPlanOrNull(speccraftDir, runId);
    if (reviewPlan?.enabled && reviewPlan.gates.length > 0) {
      console.log('  Reviews:');
      for (const gate of reviewPlan.gates) {
        const evidenceDir = reviewEvidenceDir(speccraftDir, runId, taskId, gate.id);
        let attemptCount = 0;
        let latestDecision = 'none';
        try {
          const entries = await readdir(evidenceDir);
          const attempts = entries.filter((e) => /^attempt-\d+$/.test(e)).sort();
          attemptCount = attempts.length;
          if (attempts.length > 0) {
            const { readReviewManifestOrNull } = await import('../core/reviews/attempt.js');
            const manifest = await readReviewManifestOrNull(`${evidenceDir}/${attempts[attempts.length - 1]}/manifest.yaml`);
            if (manifest) latestDecision = manifest.decision;
          }
        } catch {
          // no evidence yet
        }
        console.log(`    ${gate.id}: attempts ${attemptCount}  latest: ${latestDecision.toUpperCase()}`);
      }
    }
  } catch {
    // review not available
  }
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

// ---------------------------------------------------------------------------
// Workspaces CLI（v0.6 §15：只读诊断 + 成功 terminal 清理，无内部操作命令）
// ---------------------------------------------------------------------------

/** speccraft workspaces list */
export async function cmdWorkspacesList(projectRoot: string = process.cwd()): Promise<number> {
  const { speccraftDir, runId } = await requireActiveRun(projectRoot);
  const { readTaskGraphOrNull } = await import('../core/tasks/store.js');
  const graph = await readTaskGraphOrNull(speccraftDir, runId);
  if (!graph) {
    console.log('当前 Run 没有 Task Graph（legacy Run），无 Workspace。');
    return 0;
  }
  const { listWorkspaceSummaries } = await import('../core/workspaces/diagnostics.js');
  const summaries = await listWorkspaceSummaries(speccraftDir, runId, graph);
  if (summaries.length === 0) {
    console.log('无 Workspace（未执行过 parallel execute）。');
    return 0;
  }
  console.log(`Workspaces（${summaries.length}）：`);
  console.log(`  ${'Task'.padEnd(20)} ${'Attempt'.padEnd(8)} ${'Status'.padEnd(22)} Branch / Base / Task Commit / Workspace`);
  for (const s of summaries) {
    const commit = s.taskCommit ?? '-';
    const short = (c: string, n: number) => (c === '-' ? '-' : c.slice(0, n));
    console.log(
      `  ${s.taskId.padEnd(20)} ${String(s.attempt).padEnd(8)} ${s.status.padEnd(22)} ${s.branch} | ${short(s.baseCommit, 10)} | ${short(commit, 10)} | ${s.workspaceRoot}`,
    );
  }
  return 0;
}

/** speccraft workspaces show <task-id> */
export async function cmdWorkspacesShow(taskId: string, projectRoot: string = process.cwd()): Promise<number> {
  const { speccraftDir, runId } = await requireActiveRun(projectRoot);
  const { readTaskGraph } = await import('../core/tasks/store.js');
  const graph = await readTaskGraph(speccraftDir, runId);
  const task = graph.tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`Task 不存在：${taskId}`);
    return 1;
  }
  const { readWorkspaceDetail } = await import('../core/workspaces/diagnostics.js');
  const details = await readWorkspaceDetail(speccraftDir, runId, taskId);
  if (details.length === 0) {
    console.log(`Task ${taskId} 没有 Workspace（未执行过 parallel execute）。`);
    return 0;
  }
  console.log(`Task: ${taskId}`);
  for (const m of details) {
    console.log('');
    console.log(`  Workspace Attempt ${m.attempt}（${m.status}）`);
    console.log(`    branch: ${m.branch}`);
    console.log(`    base commit: ${m.baseCommit}`);
    console.log(`    task commit: ${m.taskCommit ?? '（无）'}`);
    console.log(`    integration commit: ${m.integrationCommit ?? '（无）'}`);
    console.log(`    workspace: ${m.workspaceRoot}`);
    // scope audit（§15.3）
    console.log(`    scope audit: ${m.scopeAudit.passed ? 'PASS' : 'FAIL'}（declared [${m.scopeAudit.declared.join(', ') || '无'}]）`);
    if (m.scopeAudit.violations.length > 0) {
      console.log(`    scope violations: ${m.scopeAudit.violations.join(', ')}`);
    }
    console.log(`    dispatch attempts: [${m.dispatchAttempts.join(', ') || '无'}]`);
    console.log(`    verification attempts: [${m.verificationAttempts.join(', ') || '无'}]`);
    if (m.failurePhase) console.log(`    failure phase: ${m.failurePhase}`);
    if (m.conflictingPaths?.length) console.log(`    conflicting paths: ${m.conflictingPaths.join(', ')}`);
    if (m.lastError) console.log(`    last error: ${m.lastError}`);
  }
  return 0;
}

/** speccraft workspaces clean：只清理 integrated/cleaned 的遗留内容 */
export async function cmdWorkspacesClean(projectRoot: string = process.cwd()): Promise<number> {
  const { speccraftDir, runId } = await requireActiveRun(projectRoot);
  const { readTaskGraphOrNull } = await import('../core/tasks/store.js');
  const graph = await readTaskGraphOrNull(speccraftDir, runId);
  if (!graph) {
    console.log('当前 Run 没有 Task Graph（legacy Run），无 Workspace。');
    return 0;
  }
  const { cleanWorkspaces } = await import('../core/workspaces/diagnostics.js');
  const result = await cleanWorkspaces(projectRoot, speccraftDir, runId, graph);

  if (result.cleaned.length > 0) {
    console.log(`已清理 ${result.cleaned.length} 个成功 Workspace：`);
    for (const c of result.cleaned) console.log(`  - ${c}`);
  } else {
    console.log('没有可清理的成功 Workspace。');
  }
  if (result.skipped.length > 0) {
    console.log(`跳过 ${result.skipped.length} 个非成功 Workspace（禁止删除）：`);
    for (const s of result.skipped) {
      console.log(`  - ${s.taskId}/attempt-${String(s.attempt).padStart(3, '0')}（${s.status}）`);
    }
  }
  if (result.warnings.length > 0) {
    console.log('警告：');
    for (const w of result.warnings) console.log(`  - ${w}`);
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Executor CLI（v0.7，ADR 0008 §28）
// ---------------------------------------------------------------------------

/** speccraft executors list：读取 project.yaml 列出 Executor Profile */
export async function cmdExecutorsList(projectRoot: string = process.cwd()): Promise<number> {
  const { loadProject, loadProjectConfig } = await import('../core/project.js');
  const { speccraftDir } = await loadProject(projectRoot);
  const config = await loadProjectConfig(speccraftDir);
  const executors = config.execution?.executors ?? {};
  const defaultExecutor = config.execution?.defaultExecutor;

  console.log('Executors:');
  if (Object.keys(executors).length === 0) {
    console.log('  （无 executors 配置 —— legacy 模式，运行时使用 legacy-default）');
    return 0;
  }
  console.log(`  default_executor: ${defaultExecutor ?? '（未配置）'}`);
  console.log(`  ${'Executor'.padEnd(13)} ${'Adapter'.padEnd(10)} ${'Model'.padEnd(14)} Max Concurrency`);
  for (const [id, p] of Object.entries(executors)) {
    console.log(
      `  ${id.padEnd(13)} ${p.adapter.padEnd(10)} ${(p.model ?? '-').padEnd(14)} ${
        p.maxConcurrency ?? 'unlimited'
      }`,
    );
  }
  return 0;
}

/** speccraft executors plan：读取当前 Run 的 frozen plan.yaml */
export async function cmdExecutorsPlan(projectRoot: string = process.cwd()): Promise<number> {
  const { speccraftDir, runId } = await requireActiveRun(projectRoot);
  const { readExecutorPlanOrNull } = await import('../core/executors/store.js');
  const plan = await readExecutorPlanOrNull(speccraftDir, runId);
  if (!plan) {
    console.log('当前 Run 没有 Executor Plan（请先 speccraft tasks compile）。');
    return 1;
  }
  console.log(`Executor Plan（run ${runId}，default_executor: ${plan.defaultExecutor}）：`);
  console.log(`  ${'Task'.padEnd(13)} ${'Executor'.padEnd(13)} ${'Adapter'.padEnd(10)} ${'Source'.padEnd(8)} Concurrency`);
  for (const a of plan.assignments) {
    console.log(
      `  ${a.taskId.padEnd(13)} ${a.executor.padEnd(13)} ${a.adapter.padEnd(10)} ${a.source.padEnd(8)} ${
        a.maxConcurrency ?? 'unlimited'
      }`,
    );
  }
  return 0;
}

/** speccraft executors doctor：probe Plan 实际需要的 adapter（去重，不按 Task） */
export async function cmdExecutorsDoctor(projectRoot: string = process.cwd()): Promise<number> {
  const { speccraftDir, runId } = await requireActiveRun(projectRoot);
  const { readExecutorPlanOrNull } = await import('../core/executors/store.js');
  const plan = await readExecutorPlanOrNull(speccraftDir, runId);
  if (!plan) {
    console.log('当前 Run 没有 Executor Plan（请先 speccraft tasks compile）。');
    return 1;
  }
  const { collectExecutorDiagnostics } = await import('../core/executors/diagnostics.js');
  const diag = await collectExecutorDiagnostics(plan);

  console.log(`Executor Doctor（run ${runId}，${diag.adapters.length} 个 adapter）：`);
  for (const d of diag.adapters) {
    if (!d.registered) {
      console.log(`  adapter ${d.adapter}: unknown（未注册）`);
    } else if (d.installed) {
      console.log(
        `  adapter ${d.adapter}: installed${d.version ? ` (${d.version})` : ''}${
          d.binary ? ` binary=${d.binary}` : ''
        }`,
      );
    } else {
      console.log(`  adapter ${d.adapter}: NOT installed${d.error ? ` — ${d.error}` : ''}`);
    }
    console.log(`    used by: ${d.usedBy.join(', ')}`);
    if (!d.capabilityOk) {
      console.log(`    capability mismatch: model "${d.modelRequested}" not supported`);
    }
  }
  if (diag.blocked.length > 0) {
    console.log(`\npreflight blocked（${diag.blocked.length}）：`);
    for (const b of diag.blocked) {
      console.log(`  task ${b.taskId} / ${b.executor} → ${b.adapter}: ${b.reason}`);
    }
    return 1;
  }
  console.log('\npreflight PASS');
  return 0;
}

// ---------------------------------------------------------------------------
// Review CLI（v0.8，ADR 0009 §27-§31）
// ---------------------------------------------------------------------------

/** speccraft reviews list：列出当前 Run 的 Review Gate / Kind / Reviewer / Adapter */
export async function cmdReviewsList(projectRoot: string = process.cwd()): Promise<number> {
  const { speccraftDir, runId } = await requireActiveRun(projectRoot);
  const { readReviewPlanOrNull } = await import('../core/reviews/store.js');
  const plan = await readReviewPlanOrNull(speccraftDir, runId);
  if (!plan || !plan.enabled) {
    console.log('当前 Run 未启用 Review（review.enabled != true）。');
    return 0;
  }
  const { reviewsListFromPlan } = await import('../core/reviews/diagnostics.js');
  const list = reviewsListFromPlan(plan);

  console.log(`Review Gates（run ${runId}）：`);
  console.log(`  ${'Gate'.padEnd(13)} ${'Kind'.padEnd(16)} ${'Reviewer'.padEnd(13)} Adapter`);
  for (const g of list.gates) {
    console.log(`  ${g.id.padEnd(13)} ${g.kind.padEnd(16)} ${g.reviewer.padEnd(13)} ${g.adapter}`);
  }
  console.log('\nReviewer Profiles：');
  for (const [id, p] of Object.entries(list.reviewerProfiles)) {
    console.log(`  ${id.padEnd(13)} adapter=${p.adapter} timeout=${p.timeout ?? 900}s`);
  }
  return 0;
}

/** speccraft reviews plan：显示 frozen Run Review Plan */
export async function cmdReviewsPlan(projectRoot: string = process.cwd()): Promise<number> {
  const { speccraftDir, runId } = await requireActiveRun(projectRoot);
  const { readReviewPlanOrNull } = await import('../core/reviews/store.js');
  const plan = await readReviewPlanOrNull(speccraftDir, runId);
  if (!plan || !plan.enabled) {
    console.log('当前 Run 没有启用的 Review Plan（请先 speccraft tasks compile）。');
    return 1;
  }
  const { reviewsPlanFromPlan } = await import('../core/reviews/diagnostics.js');
  const p = reviewsPlanFromPlan(plan);

  console.log(`Review Plan（run ${p.runId}，frozen）：`);
  console.log(`  ${'Gate'.padEnd(13)} ${'Kind'.padEnd(16)} ${'Reviewer'.padEnd(13)} ${'Adapter'.padEnd(10)} Timeout`);
  for (const g of p.gates) {
    console.log(
      `  ${g.id.padEnd(13)} ${g.kind.padEnd(16)} ${g.reviewer.padEnd(13)} ${g.adapter.padEnd(10)} ${g.timeout}s`,
    );
  }
  return 0;
}

/** speccraft reviews doctor：只 probe Review Plan 真正依赖的 adapter（去重，不按 Task × Gate） */
export async function cmdReviewsDoctor(projectRoot: string = process.cwd()): Promise<number> {
  const { speccraftDir, runId } = await requireActiveRun(projectRoot);
  const { readReviewPlanOrNull } = await import('../core/reviews/store.js');
  const plan = await readReviewPlanOrNull(speccraftDir, runId);
  if (!plan || !plan.enabled) {
    console.log('当前 Run 没有启用的 Review Plan（请先 speccraft tasks compile）。');
    return 1;
  }
  const { reviewsDoctor } = await import('../core/reviews/diagnostics.js');
  const items = await reviewsDoctor(plan);

  console.log(`Review Doctor（run ${runId}，${items.length} 个 adapter，已去重）：`);
  let blocked = false;
  for (const d of items) {
    if (d.installed) {
      console.log(`  adapter ${d.adapter}: installed${d.version ? ` (${d.version})` : ''}`);
    } else {
      blocked = true;
      console.log(`  adapter ${d.adapter}: NOT available${d.error ? ` — ${d.error}` : ''}`);
    }
  }
  if (blocked) {
    console.log('\nreview preflight blocked（reviewer 不可用，不得 fallback 到其它 reviewer）');
    return 1;
  }
  console.log('\nreview preflight PASS');
  return 0;
}

/** speccraft reviews show <task-id>：查看某 Task 的 Review Gate 进展与证据绑定 */
export async function cmdReviewsShow(taskId: string, projectRoot: string = process.cwd()): Promise<number> {
  const { speccraftDir, runId } = await requireActiveRun(projectRoot);
  const { reviewsShow } = await import('../core/reviews/diagnostics.js');
  const summary = await reviewsShow(speccraftDir, runId, taskId);

  console.log(`Task Reviews（run ${runId} / task ${summary.taskId}）：`);
  if (summary.gates.length === 0) {
    console.log('  （无 review attempt 证据）');
    return 0;
  }
  console.log(
    `  ${'Gate'.padEnd(13)} ${'Attempts'.padEnd(9)} ${'Decision'.padEnd(17)} ${'Reviewer'.padEnd(13)} ${'Adapter'.padEnd(10)} Findings`,
  );
  for (const g of summary.gates) {
    console.log(
      `  ${g.gateId.padEnd(13)} ${String(g.attempts).padEnd(9)} ${(g.latestDecision ?? '-').padEnd(17)} ${(
        g.reviewer ?? '-'
      ).padEnd(13)} ${(g.adapter ?? '-').padEnd(10)} ${g.findingCount ?? 0}（blocking ${g.blockingFindings ?? 0}）`,
    );
    if (g.sourceDispatchAttempt !== undefined || g.sourceVerificationAttempt !== undefined) {
      console.log(
        `    source: dispatch_attempt=${g.sourceDispatchAttempt ?? '-'} verification_attempt=${
          g.sourceVerificationAttempt ?? '-'
        }`,
      );
    }
  }
  return 0;
}

/** speccraft execute：确定性顺序执行 Task Graph（单写者）；--parallel 走隔离并行路线 */
export async function cmdExecute(
  opts: { adapter?: string; freshSession?: boolean; parallel?: boolean; maxParallel?: string },
  projectRoot: string = process.cwd(),
): Promise<number> {
  const { state, speccraftDir } = await loadProject(projectRoot);
  if (!state.active_run) {
    console.error('错误：没有活跃的 Execution Run，请先 speccraft prepare。');
    return 1;
  }
  const runId = state.active_run;
  const { readTaskGraphOrNull } = await import('../core/tasks/store.js');
  const graph = await readTaskGraphOrNull(speccraftDir, runId);
  if (!graph) {
    console.error('错误：当前 Run 没有 Task Graph（legacy Run）。请用 speccraft dispatch 或 implement start。');
    return 1;
  }

  const { loadProjectConfig } = await import('../core/project.js');
  const config = await loadProjectConfig(speccraftDir);
  const { getAdapter } = await import('../core/execution/adapters/registry.js');
  const adapterId = opts.adapter ?? config.execution?.defaultAdapter ?? 'manual';
  const adapter = getAdapter(adapterId);
  if (!adapter || adapter.kind !== 'cli') {
    console.error(`错误：adapter ${adapterId} 不是可用的 cli adapter。`);
    return 1;
  }
  const adapterConfig = config.execution?.adapters[adapterId];

  // v0.7 §40：--adapter 规则。Explicit Executor Graph（任何 Task 声明 executor）
  // 禁止 --adapter 覆盖；Legacy Graph 仍允许 single-adapter override。
  const hasExplicitExecutor = graph.tasks.some((t) => t.executor !== undefined);
  if (hasExplicitExecutor && opts.adapter) {
    console.error('错误：--adapter cannot override explicit Task Executor assignments');
    return 1;
  }

  // v0.7：frozen plan.yaml → ExecutorResolver（ADR 0008 §18、§38）。
  // 仅当未传 --adapter（legacy single-adapter override）且 plan 存在时启用。
  const { readExecutorPlanOrNull } = await import('../core/executors/store.js');
  const { buildExecutorResolver } = await import('../core/executors/resolver.js');
  const executorPlan = opts.adapter ? null : await readExecutorPlanOrNull(speccraftDir, runId);
  const executorResolver = executorPlan ? buildExecutorResolver({ plan: executorPlan }) : undefined;

  // v0.7 §58.1：Executor Preflight Gate。frozen plan 任一 adapter 不可用 →
  // 整体 blocked，且不产生任何施工副作用（no implementStart / no worktree /
  // no task status change / no dispatch attempt / canonical unchanged）。
  if (executorPlan) {
    const { preflightExecutorPlan, formatPreflightBlocked } = await import('../core/executors/preflight.js');
    const preflight = await preflightExecutorPlan(executorPlan);
    if (preflight.status === 'blocked') {
      console.error(formatPreflightBlocked(preflight));
      console.error('修复后：speccraft executors doctor');
      return 1;
    }
  }

  const { readFile } = await import('node:fs/promises');
  let runContext = '';
  try {
    runContext = await readFile(path.join(speccraftDir, 'runs', runId, 'context.md'), 'utf8');
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

  // v0.8：加载 frozen review plan（§18）
  const { readReviewPlanOrNull } = await import('../core/reviews/store.js');
  const reviewPlan = await readReviewPlanOrNull(speccraftDir, runId);

  // v0.8：review preflight（§22-§24）— 在施工前验证 reviewer adapter 可用性
  if (reviewPlan?.enabled) {
    const { preflightReviewPlanWithPlan, formatReviewPreflightBlocked } = await import('../core/reviews/preflight.js');
    const preflight = await preflightReviewPlanWithPlan(reviewPlan);
    if (preflight.status === 'blocked') {
      console.error(formatReviewPreflightBlocked(preflight));
      console.error('修复后重新执行。');
      return 1;
    }
  }

  // --parallel：显式 opt-in（默认 sequential，保持 v0.5 行为）
  if (opts.parallel) {
    const { isValidMaxParallel, DEFAULT_MAX_PARALLEL } = await import('../core/parallel/types.js');
    let maxParallel = DEFAULT_MAX_PARALLEL;
    if (opts.maxParallel !== undefined) {
      const n = Number(opts.maxParallel);
      if (!isValidMaxParallel(n)) {
        console.error('错误：--max-parallel 必须是 >= 1 的整数。');
        return 1;
      }
      maxParallel = n;
    }

    const { executeParallelTaskGraph } = await import('../core/parallel/orchestrator.js');
    const result = await executeParallelTaskGraph({
      speccraftDir,
      projectRoot,
      runId,
      adapter,
      runContext,
      executionGuard,
      maxParallel,
      freshSession: opts.freshSession === true,
      ...(adapterConfig ? { adapterConfig } : {}),
      ...(executorResolver ? { executorResolver } : {}),
      ...(config.hooks ? { hooks: config.hooks } : {}),
      ...(reviewPlan ? { reviewPlan } : {}),
    });

    if (!result.complete) {
      if (result.reason === 'review_failed') {
        console.error(`parallel execute 中止：Review 未通过，已完成 ${result.completed}/${graph.tasks.length} 个 Task。`);
      } else {
        console.error(`parallel execute 中止（${result.reason}），已完成 ${result.completed}/${graph.tasks.length} 个 Task。`);
      }
      if (result.reason === 'canonical_drift') {
        console.error('canonical workspace 已漂移（用户在并行期间修改/commit）。工作区已保留，处理后重新执行。');
      }
      console.error(`waves：${result.waves}；执行过：${result.executed.join(', ') || '（无）'}`);
      return 1;
    }

    console.log(`Task Graph 完成（parallel，${result.waves} 个 wave，${result.parallelTasks} 个并行 Task）。`);
    for (const w of result.waveSummaries) {
      console.log(`  wave-${String(w.wave).padStart(3, '0')}: ${w.tasks.join(' + ')}`);
    }
    console.log(`integration commits：${result.integrationCommits.length}`);
    console.log(`已生成 Aggregate Report：${result.reportFile}`);
    console.log('implementation = completed，Run = awaiting_verification');
    console.log('下一步：speccraft verify');
    return 0;
  }

  const { executeTaskGraph } = await import('../core/tasks/orchestrator.js');
  const result = await executeTaskGraph({
    speccraftDir,
    projectRoot,
    runId,
    adapter,
    runContext,
    executionGuard,
    freshSession: opts.freshSession === true,
    ...(adapterConfig ? { adapterConfig } : {}),
    ...(executorResolver ? { executorResolver } : {}),
    ...(config.hooks ? { hooks: config.hooks } : {}),
    ...(reviewPlan ? { reviewPlan } : {}),
  });

  if (!result.complete) {
    if (result.reason === 'review_failed') {
      console.error(`execute 中止：Task "${result.reviewFailedTask}" Review 未通过，已完成 ${result.completedTasks}/${graph.tasks.length} 个 Task。`);
    } else {
      console.error(`execute 中止（${result.reason}），已完成 ${result.completedTasks}/${graph.tasks.length} 个 Task。`);
    }
    console.error(`已顺序执行：${result.executed.join(', ') || '（无）'}`);
    return 1;
  }

  console.log(`Task Graph 完成（${result.executed.join(' → ')}）。`);
  if (result.reviewEnabled) {
    console.log('Review：已通过所有 Review Gates。');
  }
  console.log(`已生成 Aggregate Report：${result.reportFile}`);
  console.log('implementation = completed，Run = awaiting_verification');
  console.log('下一步：speccraft verify');
  return 0;
}

/** speccraft changes create --base-run <run-id> (--reason <text> | --file <path>) */
export async function cmdChangesCreate(
  options: {
    baseRun?: string | undefined;
    reason?: string | undefined;
    file?: string | undefined;
    source?: string | undefined;
    sourceRef?: string | undefined;
  },
  projectRoot: string = process.cwd(),
): Promise<number> {
  if (!options.baseRun) {
    throw new Error('changes create 需要 --base-run <run-id>');
  }
  const hasReason = options.reason !== undefined;
  const hasFile = options.file !== undefined;
  if (hasReason === hasFile) {
    throw new Error('changes create 必须且只能提供 --reason <text> 或 --file <path> 之一');
  }

  const { CHANGE_SOURCES, isChangeSource } = await import('../core/changes/types.js');
  let source: ChangeSource | undefined;
  if (options.source !== undefined) {
    if (!isChangeSource(options.source)) {
      throw new Error(`--source 非法：${options.source}（可选：${CHANGE_SOURCES.join(' | ')}）`);
    }
    source = options.source;
  }

  const { speccraftDir, workflow } = await loadProject(projectRoot);
  const reason = hasFile
    ? await readFile(path.resolve(options.file as string), 'utf8')
    : (options.reason ?? '');

  const { createChange } = await import('../core/changes/create.js');
  const manifest = await createChange({
    speccraftDir,
    projectRoot,
    workflow,
    baseRunId: options.baseRun,
    reason,
    ...(source ? { source } : {}),
    ...(options.sourceRef ? { sourceRef: options.sourceRef } : {}),
  });

  console.log(`已创建 Change Set：${manifest.id}`);
  console.log(`  base run: ${manifest.baseRunId}`);
  console.log(`  source: ${manifest.source}${manifest.sourceRef ? `（${manifest.sourceRef}）` : ''}`);
  console.log(`  status: ${manifest.status}`);
  console.log(`  baseline artifacts: ${manifest.artifacts.length}`);
  console.log(`下一步：speccraft changes show ${manifest.id}`);
  return 0;
}

/** speccraft changes list */
export async function cmdChangesList(projectRoot: string = process.cwd()): Promise<number> {
  const { speccraftDir } = await loadProject(projectRoot);
  const { listChangeIds, listAnalysisAttempts, readChangeManifestOrNull, changeDir } = await import(
    '../core/changes/store.js'
  );

  const ids = await listChangeIds(speccraftDir);
  if (ids.length === 0) {
    console.log('没有 Change Set。');
    return 0;
  }

  const header = [
    'ID'.padEnd(12),
    'BASE RUN'.padEnd(30),
    'STATUS'.padEnd(14),
    'SOURCE'.padEnd(14),
    'LATEST ANALYSIS'.padEnd(18),
    'SUCCESSOR RUN'.padEnd(14),
    'CREATED',
  ].join('');
  console.log(header);

  for (const id of ids) {
    const manifest = await readChangeManifestOrNull(speccraftDir, id);
    if (!manifest) {
      console.log(`${id.padEnd(12)}（manifest 缺失，请运行 speccraft validate）`);
      continue;
    }
    const attempts = await listAnalysisAttempts(speccraftDir, id);
    const latest = attempts.length > 0 ? attempts[attempts.length - 1] : '-';
    const materialization = await readYamlObjectOrNull(
      path.join(changeDir(speccraftDir, id), 'materialization.yaml'),
    );
    const successor =
      typeof materialization?.successor_run === 'string' ? materialization.successor_run : '-';
    console.log(
      [
        manifest.id.padEnd(12),
        manifest.baseRunId.padEnd(30),
        manifest.status.padEnd(14),
        manifest.source.padEnd(14),
        latest.padEnd(18),
        successor.padEnd(14),
        manifest.createdAt,
      ].join(''),
    );
  }
  return 0;
}

/** speccraft changes show <change-id>（只读，不修改状态） */
export async function cmdChangesShow(
  changeId: string,
  projectRoot: string = process.cwd(),
): Promise<number> {
  const { speccraftDir } = await loadProject(projectRoot);
  const {
    readChangeManifest,
    readChangeRequestOrNull,
    listProposalFiles,
    listAnalysisAttempts,
    changeFileExists,
    changeDir,
  } = await import('../core/changes/store.js');

  const manifest = await readChangeManifest(speccraftDir, changeId);
  const present = '（存在）';
  const absent = '（无）';

  console.log(`Change Set：${manifest.id}`);
  console.log(`  status: ${manifest.status}`);
  console.log(`  base run: ${manifest.baseRunId}`);
  console.log(`  source: ${manifest.source}${manifest.sourceRef ? `（${manifest.sourceRef}）` : ''}`);
  console.log(`  created at: ${manifest.createdAt}`);
  console.log(`  git head: ${manifest.gitHead ?? 'null'}`);
  console.log('');

  console.log('Request:');
  const request = await readChangeRequestOrNull(speccraftDir, changeId);
  if (request === null) {
    console.log(`  ${absent}`);
  } else {
    for (const line of request.replace(/\n$/, '').split('\n')) console.log(`  ${line}`);
  }
  console.log('');

  console.log('Baseline:');
  console.log(
    `  workflow: ${manifest.workflow.name} v${manifest.workflow.version}` +
      `（digest ${manifest.workflow.digest ?? 'null'}）`,
  );
  console.log(`  project digest: ${manifest.projectDigest ?? 'null'}`);
  if (manifest.artifacts.length === 0) {
    console.log('  artifacts: （无）');
  } else {
    console.log('  artifacts:');
    for (const a of manifest.artifacts) {
      console.log(`    ${a.stage} → ${a.artifact}  sha256=${a.sha256}  ${a.path}`);
    }
  }
  console.log(`  base task graph digest: ${manifest.baseTaskGraphDigest ?? 'null'}`);
  console.log(`  base executor plan digest: ${manifest.baseExecutorPlanDigest ?? 'null'}`);
  console.log(`  base review plan digest: ${manifest.baseReviewPlanDigest ?? 'null'}`);
  console.log('');

  const proposalFiles = await listProposalFiles(speccraftDir, changeId);
  console.log(`Proposal：${proposalFiles.length > 0 ? present : absent}`);
  for (const f of proposalFiles) console.log(`  ${f}`);

  const hasResolutions = await changeFileExists(speccraftDir, changeId, 'proposal/resolutions.yaml');
  console.log(`Resolutions：${hasResolutions ? present : absent}`);

  const attempts = await listAnalysisAttempts(speccraftDir, changeId);
  console.log(`Latest Analysis：${attempts.length > 0 ? attempts[attempts.length - 1] : absent}`);

  console.log(
    `Approval：${(await changeFileExists(speccraftDir, changeId, 'approval.yaml')) ? present : absent}`,
  );
  const materializationPath = path.join(changeDir(speccraftDir, changeId), 'materialization.yaml');
  const materialization = await readYamlObjectOrNull(materializationPath);
  const successorRun =
    typeof materialization?.successor_run === 'string' ? materialization.successor_run : null;
  console.log(
    `Materialization：${
      materialization ? `${present}${successorRun ? ` → ${successorRun}` : ''}` : absent
    }`,
  );
  console.log(
    `Close：${(await changeFileExists(speccraftDir, changeId, 'close.yaml')) ? present : absent}`,
  );

  if (successorRun) {
    const lineage = await pathExists(
      path.join(speccraftDir, 'runs', successorRun, 'lineage.yaml'),
    );
    console.log(`Lineage：${lineage ? `${present} → runs/${successorRun}/lineage.yaml` : absent}`);
  } else {
    console.log(`Lineage：${absent}`);
  }
  return 0;
}

/** speccraft changes stage <change-id> --artifact <stage-id> --file <replacement.md> */
export async function cmdChangesStage(
  changeId: string,
  options: { artifact?: string | undefined; file?: string | undefined },
  projectRoot: string = process.cwd(),
): Promise<number> {
  if (!options.artifact) {
    throw new Error('changes stage 需要 --artifact <stage-id>');
  }
  if (!options.file) {
    throw new Error('changes stage 需要 --file <replacement.md>');
  }
  const { speccraftDir, workflow } = await loadProject(projectRoot);
  const source = await readFile(path.resolve(options.file), 'utf8');

  const { stageProposalArtifact, proposalArtifactPath } = await import(
    '../core/changes/proposal.js'
  );
  await stageProposalArtifact({
    speccraftDir,
    changeId,
    stageId: options.artifact,
    source,
    workflow,
  });

  console.log(`已 stage artifact replacement：${changeId}`);
  console.log(`  stage: ${options.artifact}`);
  console.log(`  file: ${proposalArtifactPath(speccraftDir, changeId, options.artifact)}`);
  console.log(`下一步：speccraft changes analyze ${changeId}`);
  return 0;
}

/** speccraft changes stage-config <change-id> --file ./project.yaml */
export async function cmdChangesStageConfig(
  changeId: string,
  options: { file?: string | undefined },
  projectRoot: string = process.cwd(),
): Promise<number> {
  if (!options.file) {
    throw new Error('changes stage-config 需要 --file ./project.yaml');
  }
  const { speccraftDir } = await loadProject(projectRoot);
  const source = await readFile(path.resolve(options.file), 'utf8');

  const { stageProposalConfig, proposalConfigPath } = await import('../core/changes/proposal.js');
  await stageProposalConfig({ speccraftDir, changeId, source });

  console.log(`已 stage project.yaml replacement：${changeId}`);
  console.log(`  file: ${proposalConfigPath(speccraftDir, changeId)}`);
  console.log(`下一步：speccraft changes analyze ${changeId}`);
  return 0;
}

/** speccraft changes retain <change-id> --artifact <stage-id> */
export async function cmdChangesRetain(
  changeId: string,
  options: { artifact?: string | undefined },
  projectRoot: string = process.cwd(),
): Promise<number> {
  if (!options.artifact) {
    throw new Error('changes retain 需要 --artifact <stage-id>');
  }
  const { speccraftDir, workflow } = await loadProject(projectRoot);

  const { retainArtifact } = await import('../core/changes/proposal.js');
  await retainArtifact({ speccraftDir, changeId, stageId: options.artifact, workflow });

  console.log(`已 retain artifact：${changeId}`);
  console.log(`  stage: ${options.artifact}（现有内容仍然成立）`);
  console.log(`下一步：speccraft changes analyze ${changeId}`);
  return 0;
}

/** speccraft changes analyze <change-id>（每次创建新的不可变 Analysis Attempt） */
export async function cmdChangesAnalyze(
  changeId: string,
  projectRoot: string = process.cwd(),
): Promise<number> {
  const { speccraftDir, workflow } = await loadProject(projectRoot);

  const { analyzeChange, analysisAttemptDir } = await import('../core/changes/analyze.js');
  const result = await analyzeChange({ speccraftDir, changeId, workflow });
  const dir = analysisAttemptDir(speccraftDir, changeId, result.attempt);

  console.log(`Analysis Attempt：${result.attempt}（${result.result}）`);
  console.log(`  change: ${result.changeId}`);
  console.log(`  base run: ${result.impact.base_run}`);
  console.log(`  changed artifacts: ${formatStageList(result.impact.changed_artifacts)}`);
  console.log(`  affected artifacts: ${formatStageList(result.impact.affected_artifacts)}`);
  console.log(`  impact report: ${path.join(dir, 'impact.md')}`);

  if (result.unresolved.length > 0) {
    console.log('');
    console.log('Unresolved affected artifacts:');
    for (const stage of result.unresolved) console.log(`- ${stage}`);
    console.log('');
    console.log('请为以上 stage 提供 replacement 或显式 retain，然后重新运行：');
    console.log(`  speccraft changes analyze ${changeId}`);
    return 1;
  }

  console.log(`  no effect: ${result.noEffect ? 'yes' : 'no'}`);
  console.log(`  successor run required: ${result.impact.required_successor_run ? 'yes' : 'no'}`);
  if (result.noEffect) {
    console.log('该 Change 不产生任何影响（no_effect），不会进入 approval。');
    return 0;
  }
  console.log(`下一步：speccraft changes approve ${changeId} --by <owner>`);
  return 0;
}

/** speccraft changes approve <change-id> --by <owner>（Owner 批准并绑定 Analysis digest） */
export async function cmdChangesApprove(
  changeId: string,
  options: { by?: string | undefined },
  projectRoot: string = process.cwd(),
): Promise<number> {
  if (!options.by) {
    throw new Error('changes approve 需要 --by <owner>');
  }
  const { speccraftDir } = await loadProject(projectRoot);

  const { approveChange, approvalPath } = await import('../core/changes/approval.js');
  const result = await approveChange({
    speccraftDir,
    changeId,
    approvedBy: options.by,
  });

  console.log(`Change 已批准：${result.changeId}`);
  console.log(`  attempt: ${result.attempt}`);
  console.log(`  approved by: ${result.approval.approved_by}`);
  console.log(`  approved at: ${result.approval.approved_at}`);
  console.log(`  approval: ${approvalPath(speccraftDir, changeId)}`);
  console.log(`下一步：speccraft changes replan ${changeId}`);
  return 0;
}

/** speccraft changes reject <change-id> --reason <text>|--file <path> */
export async function cmdChangesReject(
  changeId: string,
  options: { reason?: string | undefined; file?: string | undefined },
  projectRoot: string = process.cwd(),
): Promise<number> {
  const hasReason = options.reason !== undefined;
  const hasFile = options.file !== undefined;
  if (hasReason === hasFile) {
    throw new Error('changes reject 必须且只能提供 --reason <text> 或 --file <path> 之一');
  }
  const { speccraftDir } = await loadProject(projectRoot);
  const reason = hasFile
    ? await readFile(path.resolve(options.file as string), 'utf8')
    : (options.reason ?? '');

  const { rejectChange, rejectionPath } = await import('../core/changes/store.js');
  const manifest = await rejectChange({ speccraftDir, changeId, reason });

  console.log(`Change 已拒绝：${manifest.id}`);
  console.log(`  status: ${manifest.status}`);
  console.log(`  base run: ${manifest.baseRunId}（恢复可执行）`);
  console.log(`  rejection: ${rejectionPath(speccraftDir, changeId)}`);
  return 0;
}

/**
 * speccraft changes replan <change-id>（§35–§42）。
 *
 * 只创建 Successor Run 并编译 frozen state；不 dispatch、不 execute（§42）。
 */
export async function cmdChangesReplan(
  changeId: string,
  projectRoot: string = process.cwd(),
): Promise<number> {
  const { speccraftDir, workflow } = await loadProject(projectRoot);

  const { replanChange } = await import('../core/changes/replan.js');
  const result = await replanChange({ speccraftDir, projectRoot, changeId, workflow });

  console.log(`Successor Run：${result.successorRun}`);
  console.log(`  change: ${result.changeId}（materialized）`);
  console.log(`  approved analysis attempt: ${result.attempt}`);
  console.log(`  predecessor: ${result.predecessorRun}（superseded）`);
  console.log(`  task graph digest: ${result.taskGraphDigest ?? 'null'}`);
  console.log(`  executor plan digest: ${result.executorPlanDigest ?? 'null'}`);
  console.log(`  review plan digest: ${result.reviewPlanDigest ?? 'null'}`);
  console.log(`  lineage: .speccraft/runs/${result.successorRun}/lineage.yaml`);
  console.log('replan 不自动施工；请显式运行 speccraft execute 或 speccraft dispatch。');
  return 0;
}

function formatStageList(stages: readonly string[]): string {
  return stages.length > 0 ? stages.join(', ') : '（无）';
}

/** 读取一个 YAML 对象文件；不存在或非法时返回 null（用于只读展示） */
async function readYamlObjectOrNull(file: string): Promise<Record<string, unknown> | null> {
  try {
    const yaml = (await import('js-yaml')).default;
    const loaded = yaml.load(await readFile(file, 'utf8'));
    if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) return null;
    return loaded as Record<string, unknown>;
  } catch {
    return null;
  }
}
