import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import type { Workflow, StageDefinition, StageGate } from '../types.js';

const VALID_GATE_TYPES = new Set(['all_required_completed', 'owner_approval']);

/** 解析 YAML 文本为 Workflow，并做结构校验 */
export function parseWorkflow(source: string): Workflow {
  const loaded = yaml.load(source);
  return validateWorkflow(loaded);
}

/** 读取并解析一个 Workflow 声明文件 */
export async function loadWorkflowFile(filePath: string): Promise<Workflow> {
  const source = await readFile(filePath, 'utf8');
  return parseWorkflow(source);
}

/**
 * 将任意 YAML 解析结果校验并规整为 Workflow。
 * 不合法时抛出带上下文的 Error（stage id、gate.type 等）。
 */
export function validateWorkflow(input: unknown): Workflow {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('workflow 顶层必须是对象');
  }
  const obj = input as Record<string, unknown>;

  const name = typeof obj.name === 'string' && obj.name ? obj.name : 'default';
  const version = typeof obj.version === 'string' && obj.version ? obj.version : '0.1.0';

  if (!Array.isArray(obj.stages) || obj.stages.length === 0) {
    throw new Error('workflow.stages 必须是非空数组');
  }

  const stages: StageDefinition[] = [];
  const seenIds = new Set<string>();

  for (const rawStage of obj.stages) {
    if (typeof rawStage !== 'object' || rawStage === null) {
      throw new Error('workflow.stages 中存在非对象元素');
    }
    const s = rawStage as Record<string, unknown>;

    const id = typeof s.id === 'string' ? s.id : '';
    if (!id) throw new Error('stage 缺少 id');
    if (seenIds.has(id)) throw new Error(`stage id 重复: ${id}`);
    seenIds.add(id);

    const requires = toStrArray(s.requires, `stage ${id} 的 requires`);
    const produces = toStrArray(s.produces, `stage ${id} 的 produces`);

    const gateRaw = (s.gate ?? {}) as Record<string, unknown>;
    const gateType =
      typeof gateRaw.type === 'string' ? gateRaw.type : 'all_required_completed';
    if (!VALID_GATE_TYPES.has(gateType)) {
      throw new Error(`stage ${id} 的 gate.type 非法: ${gateType}`);
    }
    const gate: StageGate = { type: gateType as StageGate['type'] };

    stages.push({
      id,
      requires,
      produces,
      gate,
      skill: typeof s.skill === 'string' ? s.skill : undefined,
      template: typeof s.template === 'string' ? s.template : undefined,
      next: typeof s.next === 'string' ? s.next : undefined,
    });
  }

  for (const stage of stages) {
    for (const req of stage.requires) {
      if (!seenIds.has(req)) {
        throw new Error(`stage ${stage.id} 的 requires 引用了未知阶段: ${req}`);
      }
    }
    if (stage.next && !seenIds.has(stage.next)) {
      throw new Error(`stage ${stage.id} 的 next 引用了未知阶段: ${stage.next}`);
    }
  }

  return { name, version, stages };
}

function toStrArray(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  return value.filter((v): v is string => typeof v === 'string');
}
