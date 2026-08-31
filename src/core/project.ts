import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { loadWorkflowFile } from './workflow/loader.js';
import { readState, WORKFLOW_FILE, PROJECT_FILE } from './state/store.js';
import { parseHookConfig } from './hooks/config.js';
import type { HookConfig } from './hooks/types.js';
import type { Workflow, State } from './types.js';

export interface ProjectContext {
  speccraftDir: string;
  workflow: Workflow;
  state: State;
}

/** 项目验证配置（ADR 0003 §6；目标项目自己的验证命令，SpecCraft 不假设 npm） */
export interface VerificationConfig {
  /** 每条命令超时秒数（默认 300） */
  timeoutSeconds: number;
  /** 按声明顺序执行的全部命令 */
  commands: string[];
}

/** 单个 adapter 配置（ADR 0005；不含任何 Secret，认证由 Provider CLI 自己管理） */
export interface ProjectAdapterConfig {
  command?: string;
  timeout_seconds?: number;
  extra_args?: string[];
  model?: string;
  sandbox?: string;
}

/** execution 配置（ADR 0005 §2） */
export interface ExecutionConfig {
  /** 默认 adapter id（缺省 manual） */
  defaultAdapter: string;
  /** 各 adapter 的可选覆盖 */
  adapters: Record<string, ProjectAdapterConfig>;
}

/** .speccraft/project.yaml 的结构（兼容旧文件：verification / execution / hooks 可选） */
export interface ProjectConfig {
  name: string;
  createdAt?: string;
  verification?: VerificationConfig;
  execution?: ExecutionConfig;
  hooks?: HookConfig;
}

/** 解析 project.yaml 文本（旧文件无 verification 字段时给出安全默认值） */
export function parseProjectConfig(source: string): ProjectConfig {
  const loaded = yaml.load(source);
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error('project.yaml 顶层必须是对象');
  }
  const obj = loaded as Record<string, unknown>;

  const config: ProjectConfig = {
    name: typeof obj.name === 'string' && obj.name ? obj.name : '',
  };
  const createdAt =
    typeof obj.created_at === 'string'
      ? obj.created_at
      : typeof obj.createdAt === 'string'
        ? obj.createdAt
        : undefined;
  if (createdAt) config.createdAt = createdAt;

  const v = obj.verification;
  if (v !== undefined && v !== null) {
    if (typeof v !== 'object' || Array.isArray(v)) {
      throw new Error('project.yaml 的 verification 必须是对象');
    }
    const vo = v as Record<string, unknown>;

    let timeoutSeconds = 300;
    if (vo.timeout_seconds !== undefined) {
      if (typeof vo.timeout_seconds !== 'number' || vo.timeout_seconds <= 0) {
        throw new Error('verification.timeout_seconds 必须是正数');
      }
      timeoutSeconds = vo.timeout_seconds;
    }
    if (vo.timeoutSeconds !== undefined && typeof vo.timeoutSeconds === 'number' && vo.timeoutSeconds > 0) {
      timeoutSeconds = vo.timeoutSeconds;
    }

    let commands: string[] = [];
    if (vo.commands !== undefined && vo.commands !== null) {
      if (!Array.isArray(vo.commands)) {
        throw new Error('verification.commands 必须是字符串数组');
      }
      commands = vo.commands.filter((c): c is string => typeof c === 'string' && c.trim() !== '');
    }

    config.verification = { timeoutSeconds, commands };
  }

  const e = obj.execution;
  if (e !== undefined && e !== null) {
    if (typeof e !== 'object' || Array.isArray(e)) {
      throw new Error('project.yaml 的 execution 必须是对象');
    }
    const eo = e as Record<string, unknown>;

    let defaultAdapter = 'manual';
    if (eo.default_adapter !== undefined) {
      if (typeof eo.default_adapter !== 'string' || !eo.default_adapter) {
        throw new Error('execution.default_adapter 必须是非空字符串');
      }
      defaultAdapter = eo.default_adapter;
    }

    const adapters: Record<string, ProjectAdapterConfig> = {};
    if (eo.adapters !== undefined && eo.adapters !== null) {
      if (typeof eo.adapters !== 'object' || Array.isArray(eo.adapters)) {
        throw new Error('execution.adapters 必须是对象');
      }
      for (const [id, raw] of Object.entries(eo.adapters as Record<string, unknown>)) {
        if (typeof raw !== 'object' || raw === null) continue;
        const a = raw as Record<string, unknown>;
        const adapter: ProjectAdapterConfig = {};
        if (typeof a.command === 'string' && a.command) adapter.command = a.command;
        if (typeof a.timeout_seconds === 'number' && a.timeout_seconds > 0) {
          adapter.timeout_seconds = a.timeout_seconds;
        }
        if (Array.isArray(a.extra_args)) {
          adapter.extra_args = a.extra_args.filter((x): x is string => typeof x === 'string');
        }
        if (typeof a.model === 'string' && a.model) adapter.model = a.model;
        if (typeof a.sandbox === 'string' && a.sandbox) adapter.sandbox = a.sandbox;
        adapters[id] = adapter;
      }
    }

    config.execution = { defaultAdapter, adapters };
  }

  if (obj.hooks !== undefined && obj.hooks !== null) {
    config.hooks = parseHookConfig(obj.hooks);
  }

  return config;
}

/** 读取 .speccraft/project.yaml；文件不存在时返回安全默认值 */
export async function loadProjectConfig(speccraftDir: string): Promise<ProjectConfig> {
  const file = path.join(speccraftDir, PROJECT_FILE);
  if (!(await pathExists(file))) {
    return { name: '' };
  }
  return parseProjectConfig(await readFile(file, 'utf8'));
}

/** 加载目标项目的 .speccraft 工作现场（workflow + state） */
export async function loadProject(projectRoot: string): Promise<ProjectContext> {
  const speccraftDir = path.join(path.resolve(projectRoot), '.speccraft');
  if (!(await pathExists(speccraftDir))) {
    throw new Error(`未找到 .speccraft（${speccraftDir}），请先运行 speccraft init`);
  }
  const workflow = await loadWorkflowFile(path.join(speccraftDir, WORKFLOW_FILE));
  const state = await readState(speccraftDir);
  return { speccraftDir, workflow, state };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
