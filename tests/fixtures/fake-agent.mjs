#!/usr/bin/env node
/**
 * Fake Agent CLI（仅供测试，不调用任何真实 Provider）。
 *
 * 通过环境变量控制行为，模拟一个 Provider CLI Agent 的非交互执行：
 *
 *   FAKE_AGENT_MODE = success | fail | timeout | jsonl | stream
 *   FAKE_AGENT_SESSION = 输出的 session id（可选）
 *
 * 行为：
 *   success → stdout 打印一行结果 + final message，exit 0
 *   fail    → stderr 打印错误，exit 1
 *   timeout → 长时间 sleep（被 runner 超时杀掉）
 *   jsonl   → 输出多行 JSON（含 agent events + session id + final message），exit 0
 *   stream  → 输出多行 stream-json（模拟 claude stream-json），exit 0
 */

const mode = process.env.FAKE_AGENT_MODE ?? 'success';
const session = process.env.FAKE_AGENT_SESSION ?? `session-${Math.random().toString(16).slice(2, 10)}`;

async function main() {
  // 读取 stdin（prompt）
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    stdin += chunk;
  }

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
    case 'jsonl': {
      const events = [
        { type: 'agent_started', session_id: session },
        { type: 'tool_call', tool: 'write', path: 'foo.txt' },
        { type: 'file_change', path: 'foo.txt' },
        { type: 'agent_completed', session_id: session },
      ];
      for (const e of events) console.log(JSON.stringify(e));
      console.log(`{"type":"final_message","text":"completed","session_id":"${session}"}`);
      process.exit(0);
      return;
    }
    case 'stream': {
      console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: session }));
      console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] }, session_id: session }));
      console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: session }));
      process.exit(0);
      return;
    }
    default:
      console.error(`unknown mode: ${mode}`);
      process.exit(2);
  }
}

main();
