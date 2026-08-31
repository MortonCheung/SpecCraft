/**
 * TraeCode Adapter（ADR 0005 §2）。
 *
 * 只调用用户本机 `traecli` CLI。接口基于 SpecCraft v0.4 施工手册方向：
 *   traecli exec [PROMPT] --json
 *   stdin: traecli exec --json -
 *   最终消息: -o / --output-last-message
 *   resume: resume（session 具体返回结构以真实 CLI JSON 为准）
 *   sandbox: 用户显式配置 workspace-write 才映射，否则保持 Provider 默认。
 *
 * 不默认注入 -y / --yolo / --dangerously-bypass-approvals-and-sandbox。
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

async function prepare(input: ExecutionAdapterInput): Promise<PreparedExecution> {
  return manualAdapter.prepare(input);
}

export const traeAdapter: CliExecutionAdapter = {
  id: 'trae',
  kind: 'cli',
  capabilities,

  prepare,

  async probe(): Promise<AdapterProbeResult> {
    const command = resolveCommand(undefined, 'traecli');
    const result = await probeBinary(command);
    return {
      id: 'trae',
      installed: result.installed,
      ...(result.version ? { version: result.version } : {}),
      ...(result.error ? { error: result.error } : {}),
      capabilities,
    };
  },

  async buildInvocation(input: BuildInvocationInput): Promise<AdapterInvocation> {
    const config = input.adapterConfig;
    const command = resolveCommand(config?.command, 'traecli');

    const args: string[] = ['exec'];
    if (input.sessionId && !input.freshSession) {
      args.push('resume', input.sessionId);
    }
    args.push('--json');
    if (input.model) args.push('--model', input.model);
    // sandbox 仅在用户显式配置时映射（不强制覆盖本地默认）
    if (config?.sandbox) args.push('--sandbox', config.sandbox);
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
        continue;
      }
      if (!obj) continue;

      sessionId ??= firstString(obj, ['session_id', 'sessionId', 'session', 'thread_id']);

      const type = typeof obj.type === 'string' ? obj.type : '';
      if (type.includes('start') || type === 'session_started') {
        events.push({ type: 'agent_started', at: input.startedAt });
      } else if (type.includes('tool') || type === 'tool_call') {
        events.push({ type: 'tool_call', tool: firstString(obj, ['name', 'tool']), at: input.finishedAt });
      } else if (type.includes('file') || type === 'file_change') {
        events.push({ type: 'file_change', path: firstString(obj, ['path', 'file']), at: input.finishedAt });
      } else if (type === 'error') {
        events.push({ type: 'error', message: firstString(obj, ['message', 'error']), at: input.finishedAt });
      } else if (type.includes('done') || type.includes('complete') || type === 'result') {
        events.push({ type: 'agent_completed', at: input.finishedAt });
        const text = firstString(obj, ['text', 'message', 'result', 'output', 'final_message']);
        if (text) finalMessage ??= text;
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
      adapter: 'trae',
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
      const nested = firstString(v as Record<string, unknown>, ['id', 'text', 'content', 'value']);
      if (nested) return nested;
    }
  }
  return undefined;
}
