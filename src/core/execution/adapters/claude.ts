/**
 * Claude Code Adapter（ADR 0005 §2）。
 *
 * 只调用用户本机 `claude` CLI，不安装 Anthropic SDK。
 * 接口已按真实 CLI 核验（v2.1.150）：
 *   claude -p --output-format stream-json
 *   resume: --resume <session-id>（或 --session-id <uuid>；--fork-session 开新会话）
 *   prompt 通过 stdin。
 *
 * 不默认注入 --dangerously-skip-permissions；权限由用户自己的 Claude 配置决定。
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
  finalMessageFile: false,
  sessionId: true,
  modelSelection: true,
};

async function prepare(input: ExecutionAdapterInput): Promise<PreparedExecution> {
  return manualAdapter.prepare(input);
}

export const claudeAdapter: CliExecutionAdapter = {
  id: 'claude',
  kind: 'cli',
  capabilities,

  prepare,

  async probe(): Promise<AdapterProbeResult> {
    const command = resolveCommand(undefined, 'claude');
    const result = await probeBinary(command);
    return {
      id: 'claude',
      installed: result.installed,
      ...(result.version ? { version: result.version } : {}),
      ...(result.error ? { error: result.error } : {}),
      capabilities,
    };
  },

  async buildInvocation(input: BuildInvocationInput): Promise<AdapterInvocation> {
    const config = input.adapterConfig;
    const command = resolveCommand(config?.command, 'claude');

    const args: string[] = ['-p', '--output-format', 'stream-json'];
    if (input.sessionId && !input.freshSession) {
      args.push('--resume', input.sessionId);
    }
    if (input.model) args.push('--model', input.model);
    if (config?.extra_args) args.push(...config.extra_args);

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
        continue;
      }
      if (!obj) continue;

      // stream-json：session_id 通常在 init 事件
      sessionId ??= firstString(obj, ['session_id', 'sessionId']);

      const type = typeof obj.type === 'string' ? obj.type : '';
      const subtype = typeof obj.subtype === 'string' ? obj.subtype : '';
      if (type === 'system' && subtype === 'init') {
        events.push({ type: 'agent_started', at: input.startedAt });
      } else if (type === 'assistant') {
        const text = extractAssistantText(obj);
        if (text && subtype === 'success') {
          finalMessage ??= text;
        }
      } else if (type === 'tool_use' || type === 'tool') {
        events.push({ type: 'tool_call', tool: firstString(obj, ['name']), at: input.finishedAt });
      } else if (type === 'result') {
        if (subtype === 'success') {
          events.push({ type: 'agent_completed', at: input.finishedAt });
          const text = firstString(obj, ['result']);
          if (text) finalMessage ??= text;
        } else if (subtype === 'error') {
          events.push({ type: 'error', message: firstString(obj, ['result', 'error']), at: input.finishedAt });
        }
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
      adapter: 'claude',
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

/** 从 stream-json 的 assistant message 提取文本 */
function extractAssistantText(obj: Record<string, unknown>): string | undefined {
  const message = obj.message;
  if (!message || typeof message !== 'object') return undefined;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === 'object') {
      const text = (c as Record<string, unknown>).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}
