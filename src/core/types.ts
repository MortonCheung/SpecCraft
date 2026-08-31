/**
 * SpecCraft 核心类型定义。
 *
 * 这些类型是 Workflow / State / Artifact 三层的公共契约，也是
 * "File-first + Declarative Workflow + Lightweight Runtime" 的类型基础。
 * v0.1 只实现到 READY_TO_IMPLEMENT 之前的阶段，但类型保留完整 16 阶段。
 */

/** 阶段合法状态（第一版固定 7 种，见 ADR 0002 §8） */
export const STAGE_STATUSES = [
  'pending',
  'in_progress',
  'waiting_owner_approval',
  'approved',
  'completed',
  'blocked',
  'locked',
] as const;

export type StageStatus = (typeof STAGE_STATUSES)[number];

/** 三层角色权限（见 ADR 0002 §13） */
export const AUTHORITIES = ['owner', 'planner', 'executor'] as const;

export type Authority = (typeof AUTHORITIES)[number];

/**
 * 默认 16 阶段，与 schemas/default-workflow.yaml 保持一致。
 * 保留为常量仅用于校验与默认值，权威来源始终是 workflow 声明文件。
 */
export const DEFAULT_STAGE_IDS = [
  'idea',
  'feasibility',
  'discovery',
  'requirement',
  'concept',
  'research',
  'design',
  'owner-approval',
  'build-brief',
  'site-survey',
  'execution-manual',
  'ready-to-implement',
  'implementation',
  'verification',
  'owner-acceptance',
  'handoff',
] as const;

export type StageId = (typeof DEFAULT_STAGE_IDS)[number] | (string & {});

/**
 * 阶段门禁类型（见 ADR 0002 §7、§9、§14）
 * - all_required_completed：requires 中所有阶段 status === completed
 * - owner_approval：requires 中所有阶段 status === approved（Owner 硬门禁）
 */
export type GateType = 'all_required_completed' | 'owner_approval';

/** 阶段门禁 */
export interface StageGate {
  type: GateType;
}

/** 声明式 Workflow 中的单个阶段（见 ADR 0002 §7） */
export interface StageDefinition {
  id: StageId;
  /** 上游阶段：必须全部完成才能进入本阶段 */
  requires: StageId[];
  /** 本阶段产出的 Artifact id 列表 */
  produces: string[];
  gate: StageGate;
  /**
   * gate 满足时是否自动级联完成（ADR 0003 §3）。
   * 该行为完全由 Workflow 声明决定，Runtime 不得依据 stage id 或版本号猜测。
   * 缺省等价于 false。
   */
  autoComplete?: boolean;
  /** 关联的 Skill id（可选） */
  skill?: string;
  /** 关联的模板路径（可选） */
  template?: string;
  /** 显式声明的下一阶段（可选；缺省按 stages 顺序推导） */
  next?: StageId;
}

/** 声明式 Workflow（schemas/default-workflow.yaml 的解析结果） */
export interface Workflow {
  name: string;
  version: string;
  stages: StageDefinition[];
}

/** 单个阶段的运行时状态 */
export interface StageState {
  status: StageStatus;
  /** Owner 批准人（仅在 waiting_owner_approval → approved 时写入） */
  approvedBy?: string;
  /** 批准时间 ISO 字符串 */
  approvedAt?: string;
  /** 附加说明 */
  note?: string;
}

/** .speccraft/state.yaml 的运行时状态（见 ADR 0002 §8、ADR 0003 §4） */
export interface State {
  current_stage: StageId;
  stages: Record<string, StageState>;
  /**
   * 当前活跃 Execution Run 的 id（ADR 0003 §4）。
   * 旧 state.yaml 没有该字段时必须正常加载（可选字段，不做迁移）。
   */
  active_run?: string;
}

/** Artifact 的 YAML Frontmatter（见 ADR 0002 §6） */
export interface ArtifactFrontmatter {
  artifact: string;
  stage: StageId;
  status: StageStatus;
  version: number;
  id?: string;
  /** 来源 Artifact id 列表 */
  source?: string[];
  /** 依赖 Artifact id 列表 */
  requires?: string[];
}

/** 解析后的 Artifact（frontmatter + 正文） */
export interface Artifact {
  /** 相对 .speccraft/artifacts/ 的文件名 */
  filename: string;
  frontmatter: ArtifactFrontmatter;
  body: string;
}
