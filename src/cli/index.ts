#!/usr/bin/env node
import {
  cmdInit,
  cmdStatus,
  cmdNext,
  cmdApprove,
  cmdArtifact,
  cmdValidate,
  cmdPrepare,
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
    'SpecCraft v0.1 — Human-Directed AI Workflow System',
    '',
    '用法：speccraft <command> [options]',
    '',
    '命令：',
    '  init [projectRoot] [--force]    初始化 .speccraft 工作现场',
    '  status                          查看当前阶段与各阶段状态',
    '  next                            查看下一步阶段 / 待批准阶段',
    '  approve <stage> [--by <who>]    批准指定阶段（Owner 硬门禁）',
    '  artifact <stage>                为指定阶段生成 artifact 并推进',
    '  prepare [--adapter manual]      编译 Execution Package 并创建 Run',
    '  validate                        校验状态一致性（不跳阶段）',
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
