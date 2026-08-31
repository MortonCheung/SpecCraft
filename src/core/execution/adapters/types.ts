/**
 * Execution Adapter 契约（ADR 0003 §5 / ADR 0005 §2）。
 *
 * Adapter 是 SpecCraft Runtime 与外部施工执行者之间的 provider-neutral seam：
 * - Core 绝不 import Codex / Claude / OpenCode / Trae；
 * - Provider-specific 内容只能存在于 Adapter 层；
 * - Adapter 只负责 Provider invocation 构造、输出解析、session 元数据；
 * - Adapter 不修改 state.yaml / workflow stage / verification / acceptance / handoff。
 *
 * Adapter 采用 discriminated union，避免 optional-method soup：
 *   kind = 'manual' | 'cli'
 *   manual：生成 Execution Package（v0.2/v0.3 已有，保持完全兼容）
 *   cli：调用用户本机已安装、已登录的 CLI Agent
 */

import type { ExecutionRunManifest, GitSnapshot } from '../types.js';

// ---------------------------------------------------------------------------
// prepare（manual 与 cli 共享）
// ---------------------------------------------------------------------------

/** Adapter prepare 的输入 */
export interface ExecutionAdapterInput {
  speccraftDir: string;
  runId: string;
  manifest: ExecutionRunManifest;
  executionManual: string;
  compiledContext: string;
  executionGuard: string;
  verification: { commands: string[]; timeoutSeconds: number };
  gitSnapshot: GitSnapshot | null;
  readyStages: string[];
}

/** Adapter prepare 的产物 */
export interface PreparedExecution {
  /** 生成的文件（相对 run 目录）→ 内容 */
  files: Record<string, string>;
}

// ---------------------------------------------------------------------------
// 能力模型
// ---------------------------------------------------------------------------

/** Adapter 声明的能力（common denominator，不做 optional soup） */
export interface AdapterCapabilities {
  /** 支持非交互式一次性调用 */
  invoke: boolean;
  /** 支持 resume 同一 provider session */
  resume: boolean;
  /** 支持结构化输出（JSON / JSONL） */
  structuredOutput: boolean;
  /** 支持输出最终消息到文件 */
  finalMessageFile: boolean;
  /** 能从输出中取得 provider session id */
  sessionId: boolean;
  /** 支持 model 选择 */
  modelSelection: boolean;
}

/** project.yaml 中单个 adapter 的配置（不含任何 Secret） */
export interface AdapterConfig {
  command?: string;
  timeout_seconds?: number;
  extra_args?: string[];
  model?: string;
  sandbox?: string;
}

/** 本机能力探测结果（不发 AI 请求、不消耗 Token） */
export interface AdapterProbeResult {
  id: string;
  installed: boolean;
  binary?: string;
  version?: string;
  capabilities?: AdapterCapabilities;
  /** 探测失败时的诊断信息 */
  error?: string;
}

// ---------------------------------------------------------------------------
// cli adapter：invocation 构造 + 结果归一化
// ---------------------------------------------------------------------------

/** 构造一次 Provider CLI 调用 */
export interface AdapterInvocation {
  command: string;
  args: string[];
  cwd: string;
  /** prompt 通过 stdin 传入（如 codex exec --json -） */
  stdin?: string;
  /** 或通过文件传入（如 opencode run --file） */
  promptFile?: string;
  env?: Record<string, string>;
  timeoutMs: number;
}

/** buildInvocation 的输入 */
export interface BuildInvocationInput {
  projectRoot: string;
  runDir: string;
  /** agent-prompt.md 全文 */
  prompt: string;
  /** agent-prompt.md 绝对路径（provider 支持 --file 时用） */
  promptFile?: string;
  /** 上一 attempt 的 provider session id（resume） */
  sessionId?: string;
  /** 是否强制新 session */
  freshSession: boolean;
  model?: string;
  adapterConfig?: AdapterConfig;
}

/** normalize 的输入（Dispatch Runner 收集的原始进程证据） */
export interface NormalizeInput {
  projectRoot: string;
  runDir: string;
  adapterId: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError?: string;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** provider 结构化输出原始内容（若支持；不支持则 undefined） */
  rawJsonl?: string;
}

// ---------------------------------------------------------------------------
// 归一化事件模型（common denominator only）
// ---------------------------------------------------------------------------

/** 统一事件模型；Provider 专属信息保留在原始输出，不强行统一 */
export type AgentEvent =
  | { type: 'agent_started'; at?: string }
  | { type: 'agent_message'; text: string; at?: string }
  | { type: 'tool_call'; tool?: string; at?: string }
  | { type: 'file_change'; path?: string; at?: string }
  | { type: 'command'; command?: string; at?: string }
  | { type: 'warning'; message?: string; at?: string }
  | { type: 'error'; message?: string; at?: string }
  | { type: 'agent_completed'; at?: string };

export type DispatchStatus = 'succeeded' | 'failed' | 'timed_out' | 'spawn_error';

/** normalize 后的统一执行结果（Dispatch Runtime 消费） */
export interface NormalizedDispatchResult {
  adapter: string;
  status: DispatchStatus;
  exitCode?: number;
  signal?: string | null;
  timedOut: boolean;
  startedAt?: string;
  finishedAt?: string;
  durationMs: number;
  /** provider session id（与 SpecCraft Run ID 分离） */
  sessionId?: string;
  /** 最终消息（若 provider 提供） */
  finalMessage?: string;
  /** 归一化事件 */
  events: AgentEvent[];
  /** 原始输出引用（由 runner 保存） */
  rawLog?: string;
  eventsLog?: string;
  stderr?: string;
}

// ---------------------------------------------------------------------------
// Adapter union
// ---------------------------------------------------------------------------

export interface ExecutionAdapterBase {
  id: string;
  kind: 'manual' | 'cli';
  prepare(input: ExecutionAdapterInput): Promise<PreparedExecution>;
}

export interface ManualExecutionAdapter extends ExecutionAdapterBase {
  kind: 'manual';
}

export interface CliExecutionAdapter extends ExecutionAdapterBase {
  kind: 'cli';
  capabilities: AdapterCapabilities;
  probe(): Promise<AdapterProbeResult>;
  buildInvocation(input: BuildInvocationInput): Promise<AdapterInvocation>;
  normalize(input: NormalizeInput): Promise<NormalizedDispatchResult>;
}

export type ExecutionAdapter = ManualExecutionAdapter | CliExecutionAdapter;
