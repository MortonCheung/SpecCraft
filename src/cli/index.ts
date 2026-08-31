#!/usr/bin/env node
import {
  cmdInit,
  cmdStatus,
  cmdNext,
  cmdApprove,
  cmdArtifact,
  cmdValidate,
  cmdPrepare,
  cmdImplementStart,
  cmdImplementFinish,
  cmdVerify,
  cmdAccept,
  cmdReject,
  cmdHandoff,
  cmdAdaptersList,
  cmdAdaptersDoctor,
  cmdDispatch,
  cmdTasksCompile,
  cmdTasksList,
  cmdTasksNext,
  cmdTasksShow,
  cmdTasksVerify,
  cmdTasksReopen,
  cmdExecute,
  cmdWorkspacesList,
  cmdWorkspacesShow,
  cmdWorkspacesClean,
} from './commands.js';

interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Record<string, string>;
}

/**
 * 手写极简参数解析（ADR 0002 §17：v0.1 不引入第三方 CLI 框架）。
 * 支持：位置参数、`--flag`（布尔）、`--key value`、`--key=value`。
 */
function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  let command: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = 'true';
        }
      }
    } else if (command === null) {
      command = token;
    } else {
      positionals.push(token);
    }
  }

  return { command, positionals, flags };
}

function usage(): string {
  return [
    'SpecCraft v0.4 — Human-Directed AI Workflow System',
    '',
    '用法：speccraft <command> [options]',
    '',
    '命令：',
    '  init [projectRoot] [--force]    初始化 .speccraft 工作现场',
    '  status                          查看阶段 / Run / Acceptance / Handoff 状态',
    '  next                            查看下一步（含 Execution / Acceptance 生命周期）',
    '  approve <stage> [--by <who>]    批准指定阶段（Owner 硬门禁）',
    '  artifact <stage>                为指定阶段生成 artifact 并推进',
    '  prepare [--adapter <id>]        编译 Execution Package 并创建 Run',
    '  implement start [--run <id>]     显式开始施工（implementation = in_progress）',
    '  implement finish --report <path> 显式结束施工并提交执行报告',
    '  adapters list                   列出全部 adapter',
    '  adapters doctor [id]            本机 Provider 能力诊断（不发 AI 请求）',
    '  dispatch [--adapter <id>] [--run <id>] [--fresh-session]',
    '                                   调用本地 CLI Agent 自动施工',
    '  verify                           运行项目验证命令（PASS/FAIL）',
    '  accept [--note|--file] [--by]    Owner 验收通过',
    '  reject --reason <text>|--file    Owner 拒绝（重开 implementation，同 Run 返工）',
    '  handoff                          生成 Handoff Package（确定性交接）',
    '  validate                        校验状态一致性（不跳阶段）',
    '  workspaces list                 列出 parallel Workspace（诊断）',
    '  workspaces show <task-id>       查看某 Task 的完整 Workspace 证据',
    '  workspaces clean                清理已成功 integration 的 Workspace 遗留内容',
  ].join('\n');
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  try {
    switch (args.command) {
      case null:
      case undefined:
        console.log(usage());
        return 0;
      case 'init':
        await cmdInit(args.positionals[0], args.flags.force !== undefined);
        return 0;
      case 'status':
        await cmdStatus();
        return 0;
      case 'next':
        await cmdNext();
        return 0;
      case 'approve': {
        const stage = args.positionals[0];
        if (!stage) throw new Error('approve 需要阶段参数：speccraft approve <stage>');
        await cmdApprove(stage, args.flags.by ?? 'owner');
        return 0;
      }
      case 'artifact': {
        const stage = args.positionals[0];
        if (!stage) throw new Error('artifact 需要阶段参数：speccraft artifact <stage>');
        await cmdArtifact(stage);
        return 0;
      }
      case 'prepare':
        await cmdPrepare(args.flags.adapter);
        return 0;
      case 'adapters': {
        const sub = args.positionals[0];
        if (sub === 'list') {
          await cmdAdaptersList();
          return 0;
        }
        if (sub === 'doctor') {
          return await cmdAdaptersDoctor(args.positionals[1]);
        }
        throw new Error('adapters 需要 list 或 doctor 子命令');
      }
      case 'dispatch':
        return await cmdDispatch({
          adapter: args.flags.adapter,
          run: args.flags.run,
          freshSession: args.flags['fresh-session'] !== undefined,
          task: args.flags.task,
        });
      case 'execute':
        return await cmdExecute({
          adapter: args.flags.adapter,
          freshSession: args.flags['fresh-session'] !== undefined,
          parallel: args.flags.parallel !== undefined,
          ...(args.flags['max-parallel'] !== undefined ? { maxParallel: args.flags['max-parallel'] as string } : {}),
        });
      case 'workspaces': {
        const sub = args.positionals[0];
        if (sub === 'list') return await cmdWorkspacesList();
        if (sub === 'show') {
          const id = args.positionals[1];
          if (!id) throw new Error('workspaces show 需要 task id：speccraft workspaces show <task-id>');
          return await cmdWorkspacesShow(id);
        }
        if (sub === 'clean') return await cmdWorkspacesClean();
        throw new Error('workspaces 需要 list | show | clean 子命令');
      }
      case 'tasks': {
        const sub = args.positionals[0];
        if (sub === 'compile') return await cmdTasksCompile();
        if (sub === 'list') return await cmdTasksList();
        if (sub === 'next') return await cmdTasksNext();
        if (sub === 'show') {
          const id = args.positionals[1];
          if (!id) throw new Error('tasks show 需要 task id：speccraft tasks show <task-id>');
          return await cmdTasksShow(id);
        }
        if (sub === 'verify') {
          const id = args.positionals[1];
          if (!id) throw new Error('tasks verify 需要 task id：speccraft tasks verify <task-id>');
          return await cmdTasksVerify(id);
        }
        if (sub === 'reopen') {
          const id = args.positionals[1];
          if (!id) throw new Error('tasks reopen 需要 task id：speccraft tasks reopen <task-id> [--cascade]');
          return await cmdTasksReopen(id, args.flags.cascade !== undefined);
        }
        throw new Error('tasks 需要 compile | list | next | show | verify | reopen 子命令');
      }
      case 'implement': {
        const sub = args.positionals[0];
        if (sub === 'start') {
          await cmdImplementStart(args.flags.run);
          return 0;
        }
        if (sub === 'finish') {
          await cmdImplementFinish(args.flags.report);
          return 0;
        }
        throw new Error('implement 需要 start 或 finish 子命令');
      }
      case 'verify':
        return await cmdVerify();
      case 'accept':
        return await cmdAccept({ note: args.flags.note, file: args.flags.file, by: args.flags.by });
      case 'reject':
        return await cmdReject({ reason: args.flags.reason, file: args.flags.file });
      case 'handoff':
        return await cmdHandoff();
      case 'validate':
        return await cmdValidate();
      default:
        throw new Error(`未知命令：${args.command}\n\n${usage()}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`错误：${message}`);
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
