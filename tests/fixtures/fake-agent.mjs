#!/usr/bin/env node
/**
 * Fake Agent CLI（仅供测试，不调用任何真实 Provider）。
 *
 * 通过环境变量控制行为，模拟一个 Provider CLI Agent 的非交互执行：
 *
 *   FAKE_AGENT_MODE = success | fail | timeout | jsonl | stream | work
 *   FAKE_AGENT_SESSION = 输出的 session id（可选）
 *
 * 行为：
 *   success → stdout 打印一行结果 + final message，exit 0
 *   fail    → stderr 打印错误，exit 1
 *   timeout → 长时间 sleep（被 runner 超时杀掉）
 *   jsonl   → 输出多行 JSON（含 agent events + session id + final message），exit 0
 *   stream  → 输出多行 stream-json（模拟 claude stream-json），exit 0
 *   work    → v0.6 parallel E2E 用：按 FAKE_AGENT_PLAN 在 cwd（isolated
 *             worktree）里真实写文件 / sleep / git commit / 越界写 /
 *             人为制造 canonical drift，然后输出 JSONL，exit 0
 *
 * work 模式的 FAKE_AGENT_PLAN（JSON，key = task id，从 stdin prompt 的
 * "- Task ID: <id>" 行解析）：
 *
 *   {
 *     "b": {
 *       "write":      { "src/backend/handler.ts": "content" },
 *       "outOfScope": ["package.json"],
 *       "sleepMs":    800,
 *       "gitCommit":  true,        // Executor 自己 git commit（故障测试）
 *       "drift":      true,        // 向 FAKE_AGENT_CANONICAL 提交 empty commit（drift 测试）
 *       "fail":       true         // exit 1
 *     }
 *   }
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const mode = process.env.FAKE_AGENT_MODE ?? 'success';
const session = process.env.FAKE_AGENT_SESSION ?? `session-${Math.random().toString(16).slice(2, 10)}`;

function runGit(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

async function readStdin() {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    stdin += chunk;
  }
  return stdin;
}

function emitJsonl(sessionId, text) {
  const events = [
    { type: 'agent_started', session_id: sessionId },
    { type: 'tool_call', tool: 'write', path: 'task-output' },
    { type: 'file_change', path: 'task-output' },
    { type: 'agent_completed', session_id: sessionId },
  ];
  for (const e of events) console.log(JSON.stringify(e));
  console.log(JSON.stringify({ type: 'final_message', text, session_id: sessionId }));
}

async function main() {
  const stdin = await readStdin();

  switch (mode) {
    case 'success':
      console.log(`fake-agent: ok (prompt ${stdin.length} chars)`);
      console.log('FINAL_MESSAGE: done');
      process.exit(0);
      return;
    case 'fail':
      console.error('fake-agent: something went wrong');
      process.exit(1);
      return;
    case 'timeout':
      await new Promise((r) => setTimeout(r, 60000));
      console.log('should not reach');
      process.exit(0);
      return;
    case 'jsonl':
      emitJsonl(session, 'completed');
      process.exit(0);
      return;
    case 'stream': {
      console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: session }));
      console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] }, session_id: session }));
      console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: session }));
      process.exit(0);
      return;
    }
    case 'work': {
      // Task Package prompt 含 "- Task ID: <id>" 行
      const m = stdin.match(/Task ID:\s*(\S+)/);
      const taskId = m ? m[1] : '_unknown_';
      let plan = {};
      try {
        plan = JSON.parse(process.env.FAKE_AGENT_PLAN ?? '{}');
      } catch {
        /* 空 plan */
      }
      const spec = plan[taskId] ?? {};

      // 写文件（scope 内 / 越界由调用方决定；自动创建父目录）
      const writes = spec.write ?? {};
      for (const [rel, content] of Object.entries(writes)) {
        const abs = path.resolve(process.cwd(), rel);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, String(content), 'utf8');
      }
      for (const rel of spec.outOfScope ?? []) {
        const abs = path.resolve(process.cwd(), rel);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, 'out-of-scope\n', 'utf8');
      }

      // 人为 canonical drift：向 canonical 仓库提交 empty commit
      if (spec.drift && process.env.FAKE_AGENT_CANONICAL) {
        runGit(process.env.FAKE_AGENT_CANONICAL, ['commit', '--allow-empty', '-m', 'drift']);
      }

      // Executor Git Mutation 故障：agent 自己 add + commit
      if (spec.gitCommit) {
        runGit(process.cwd(), ['add', '-A']);
        runGit(process.cwd(), ['commit', '-m', 'fake-agent mutation']);
      }

      // 睡眠（真并行时间证据）
      if (spec.sleepMs) {
        await new Promise((r) => setTimeout(r, spec.sleepMs));
      }

      if (spec.fail) {
        console.error(`fake-agent: work failed (task ${taskId})`);
        process.exit(1);
        return;
      }

      emitJsonl(session, `work done (task ${taskId})`);
      process.exit(0);
      return;
    }
    default:
      console.error(`unknown mode: ${mode}`);
      process.exit(2);
  }
}

main();
