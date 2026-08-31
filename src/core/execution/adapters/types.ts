/**
 * Execution Adapter 抽象（ADR 0003 §5）。
 *
 * Adapter 是 SpecCraft Runtime 与外部施工执行者之间的 seam。
 * v0.2 只实现 manual adapter：生成可交给任意 Agent 的 Execution Package，
 * 不调用任何 AI 厂商 API。codex / claude / trae / opencode 是未来接入点。
 */

import type { ExecutionRunManifest, GitSnapshot } from '../types.js';

/** Adapter prepare 的输入 */
export interface ExecutionAdapterInput {
  /** .speccraft 目录绝对路径 */
  speccraftDir: string;
  /** Run id */
  runId: string;
  /** 已创建的 Run manifest（status = prepared） */
  manifest: ExecutionRunManifest;
  /** Execution Manual artifact 正文（必须显式嵌入 agent-prompt） */
  executionManual: string;
  /** Context Compiler 编译后的上游 context（Markdown） */
  compiledContext: string;
  /** execution-guard skill 正文（注入施工守卫规则） */
  executionGuard: string;
  /** 项目验证配置（写入 prompt 的 Verification Requirements 段） */
  verification: {
    commands: string[];
    timeoutSeconds: number;
  };
  /** prepare 时刻的 Git 快照（可能为空：目标项目不是 Git 仓库） */
  gitSnapshot: GitSnapshot | null;
  /** 上游已完成的关键阶段（用于 Execution Goal 概述） */
  readyStages: string[];
}

/** Adapter prepare 的产物 */
export interface PreparedExecution {
  /** 生成的文件（相对 run 目录）→ 内容 */
  files: Record<string, string>;
}

/**
 * Execution Adapter 接口。
 *
 * 约束：
 * - prepare 是纯生成过程：只写 run 目录内文件，不改 workflow/state；
 * - 不得执行任何验证命令；
 * - 不得进行任何 Git 写操作。
 */
export interface ExecutionAdapter {
  /** adapter 标识（如 manual） */
  id: string;
  prepare(input: ExecutionAdapterInput): Promise<PreparedExecution>;
}
