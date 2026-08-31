/**
 * Codex CLI Adapter（ADR 0005 §2）。
 *
 * 只调用用户本机 `codex` CLI，不引入 @openai/* / OpenAI SDK。
 * 接口基于 SpecCraft v0.4 施工手册方向：`codex exec --json -`（stdin prompt）。
 *
 * 注意：Codex CLI 会更新，具体参数以真实 `codex --help` 为准；probe() 会在
 * 未安装时返回 not installed，doctor 给出清晰诊断。
 */

import type {
  AdapterCapabilities,
  AdapterInvocation,
  AdapterProbeResult,
  BuildInvocationInput,
  CliExecutionAdapter,
  ExecutionAdapterInput,
  NormalizedDispatchResult,
  NormalizeInput,
  PreparedExecution,
  AgentEvent,
} from './types.js';
import { manualAdapter } from './manual.js';
import { probeBinary, resolveCommand, resolveTimeoutSeconds } from './cli-helpers.js';

const DEFAULT_TIMEOUT_SECONDS = 3600;

const capabilities: AdapterCapabilities = {
  invoke: true,
  resume: true,
  structuredOutput: true,
  finalMessageFile: true,
  sessionId: true,
  modelSelection: true,
};

/** 复用 manual prepare：codex 同样基于 Execution Package（agent-prompt.md） */
async function prepare(input: ExecutionAdapterInput): Promise<PreparedExecution> {
  return manualAdapter.prepare(input);
}

export const codexAdapter: CliExecutionAdapter = {
  id: 'codex',
  kind: 'cli',
  capabilities,

  prepare,

  async probe(): Promise<AdapterProbeResult> {
    const command = resolveCommand(undefined, 'codex');
    const result = await probeBinary(command);
    return {
      id: 'codex',
      installed: result.installed,
      ...(result.version ? { version: result.version } : {}),
      ...(result.error ? { error: result.error } : {}),
      capabilities,
    };
  },

  async buildInvocation(input: BuildInvocationInput): Promise<AdapterInvocation> {
    const config = input.adapterConfig;
    const command = resolveCommand(config?.command, 'codex');

    const args: string[] = ['exec', '--json'];
    if (input.sessionId && !input.freshSession) {
      // resume 上一 provider session（具体 flag 以真实 --help 为准）
      args.push('--resume', input.sessionId);
    }
    if (input.model) args.push('--model', input.model);
    if (config?.extra_args) args.push(...config.extra_args);
    args.push('-'); // prompt 通过 stdin

    return {
      command,
      args,
      cwd: input.projectRoot,
      stdin: input.prompt,
      timeoutMs: resolveTimeoutSeconds(config?.timeout_seconds, DEFAULT_TIMEOUT_SECONDS) * 1000,
    };
  },

  async normalize(input: NormalizeInput): Promise<NormalizedDispatchResult> {
    const lines = input.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const events: AgentEvent[] = [];
    let sessionId: string | undefined;
    let finalMessage: string | undefined;

    for (const line of lines) {
      let obj: Record<string, unknown> | null = null;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // 非 JSON 行（纯文本输出）→ 尝试作为 final message
        if (!finalMessage && line.length > 0 && !line.startsWith('{')) {
          finalMessage = line;
        }
        continue;
      }
      if (!obj) continue;

      // session / thread id（容忍不同字段名）
      sessionId ??= firstString(obj, ['thread_id', 'threadId', 'session_id', 'sessionId']);

      const type = typeof obj.type === 'string' ? obj.type : '';
      if (type.includes('thread.started') || type === 'agent_started') {
        events.push({ type: 'agent_started', at: input.startedAt });
      } else if (type.includes('tool') || type === 'tool_call') {
        events.push({ type: 'tool_call', tool: firstString(obj, ['name', 'tool']), at: input.finishedAt });
      } else if (type.includes('file') || type === 'file_change') {
        events.push({ type: 'file_change', path: firstString(obj, ['path', 'file']), at: input.finishedAt });
      } else if (type === 'error') {
        events.push({ type: 'error', message: firstString(obj, ['message']), at: input.finishedAt });
      } else if (type.includes('done') || type === 'agent_completed') {
        events.push({ type: 'agent_completed', at: input.finishedAt });
      }

      // final message
      const text = firstString(obj, ['text', 'message', 'final_message', 'output']);
      if (text && (type.includes('result') || type.includes('final') || type.includes('done'))) {
        finalMessage ??= text;
      }
    }

    const status: NormalizedDispatchResult['status'] = input.timedOut
      ? 'timed_out'
      : input.spawnError
        ? 'spawn_error'
        : input.exitCode === 0
          ? 'succeeded'
          : 'failed';

    return {
      adapter: 'codex',
      status,
      ...(input.exitCode !== null ? { exitCode: input.exitCode } : {}),
      ...(input.signal !== null && input.signal !== undefined ? { signal: input.signal } : {}),
      timedOut: input.timedOut,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs: input.durationMs,
      ...(sessionId ? { sessionId } : {}),
      ...(finalMessage ? { finalMessage } : {}),
      events,
      rawLog: input.stdout,
      stderr: input.stderr,
    };
  },
};

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
    if (v && typeof v === 'object') {
      const nested = firstString(v as Record<string, unknown>, ['text', 'content', 'value', 'id']);
      if (nested) return nested;
    }
  }
  return undefined;
}
