/**
 * OpenCode Adapter（ADR 0005 §2）。
 *
 * 只调用用户本机 `opencode` CLI。接口基于 SpecCraft v0.4 施工手册方向：
 *   opencode run --format json
 *   resume: --session <id>
 *   prompt 通过 --file 或 stdin。
 *
 * 不假定所有用户 binary 名一致，command 允许 project.yaml 覆盖。
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

export const opencodeAdapter: CliExecutionAdapter = {
  id: 'opencode',
  kind: 'cli',
  capabilities,

  prepare,

  async probe(): Promise<AdapterProbeResult> {
    const command = resolveCommand(undefined, 'opencode');
    const result = await probeBinary(command);
    return {
      id: 'opencode',
      installed: result.installed,
      ...(result.version ? { version: result.version } : {}),
      ...(result.error ? { error: result.error } : {}),
      capabilities,
    };
  },

  async buildInvocation(input: BuildInvocationInput): Promise<AdapterInvocation> {
    const config = input.adapterConfig;
    const command = resolveCommand(config?.command, 'opencode');

    const args: string[] = ['run', '--format', 'json'];
    if (input.sessionId && !input.freshSession) {
      args.push('--session', input.sessionId);
    }
    if (input.model) args.push('--model', input.model);
    if (config?.extra_args) args.push(...config.extra_args);

    // 优先 --file 附加 agent-prompt.md，避免巨大 argv
    if (input.promptFile) {
      args.push('--file', input.promptFile);
    }

    return {
      command,
      args,
      cwd: input.projectRoot,
      // 有 --file 时用短指令，否则整段 prompt 走 stdin
      stdin: input.promptFile
        ? 'Execute the attached SpecCraft Execution Package.'
        : input.prompt,
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

      sessionId ??= firstString(obj, ['session_id', 'sessionId', 'session']);

      const type = typeof obj.type === 'string' ? obj.type : '';
      if (type.includes('start') || type === 'session_started') {
        events.push({ type: 'agent_started', at: input.startedAt });
      } else if (type.includes('tool') || type === 'tool_call') {
        events.push({ type: 'tool_call', tool: firstString(obj, ['name', 'tool']), at: input.finishedAt });
      } else if (type.includes('file') || type === 'file_change') {
        events.push({ type: 'file_change', path: firstString(obj, ['path', 'file']), at: input.finishedAt });
      } else if (type === 'error') {
        events.push({ type: 'error', message: firstString(obj, ['message', 'error']), at: input.finishedAt });
      } else if (type.includes('done') || type.includes('complete') || type.includes('result')) {
        events.push({ type: 'agent_completed', at: input.finishedAt });
        const text = firstString(obj, ['text', 'message', 'result', 'output']);
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
      adapter: 'opencode',
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
