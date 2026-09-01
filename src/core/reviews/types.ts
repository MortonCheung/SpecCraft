/**
 * Review 领域类型（ADR 0009）。
 *
 * Review ≠ Verification；Review ≠ Owner Acceptance；
 * Reviewer ≠ Executor；Reviewer Profile ≠ Executor Profile。
 */

/** Review Gate Kind（v0.8 固定两种） */
export type ReviewGateKind = 'spec_compliance' | 'code_quality';

export const REVIEW_GATE_KINDS: readonly ReviewGateKind[] = ['spec_compliance', 'code_quality'];

export function isReviewGateKind(value: unknown): value is ReviewGateKind {
  return typeof value === 'string' && (REVIEW_GATE_KINDS as readonly string[]).includes(value);
}

/** Reviewer Profile Config（project.yaml review.reviewers.<id>） */
export interface ReviewerProfileConfig {
  adapter: string;
  model?: string;
  timeout_seconds?: number;
  extra_args?: string[];
  sandbox?: string;
}

/** Review Gate Config（project.yaml review.gates[]） */
export interface ReviewGateConfig {
  id: string;
  kind: ReviewGateKind;
  reviewer: string;
}

/** Review Section Config（project.yaml review:） */
export interface ReviewConfig {
  enabled: boolean;
  default_reviewer?: string;
  reviewers: Record<string, ReviewerProfileConfig>;
  gates: ReviewGateConfig[];
}

/** Frozen Review Gate（plan.yaml 中的 gate，已解析 adapter config） */
export interface FrozenReviewGate {
  id: string;
  kind: ReviewGateKind;
  reviewer: string;
  adapter: string;
  resolved: {
    timeout_seconds: number;
    model?: string;
    extra_args?: string[];
    sandbox?: string;
  };
}

/** Frozen Review Plan（.speccraft/runs/<run-id>/reviews/plan.yaml） */
export interface ReviewPlan {
  version: 1;
  run_id: string;
  enabled: boolean;
  created_at: string;
  gates: FrozenReviewGate[];
}

/** Review Gate Decision */
export type ReviewDecision = 'pass' | 'changes_required' | 'error';

/** Review Finding Severity */
export type FindingSeverity = 'blocker' | 'major' | 'minor';

export const FINDING_SEVERITIES: readonly FindingSeverity[] = ['blocker', 'major', 'minor'];

export function isFindingSeverity(value: unknown): value is FindingSeverity {
  return typeof value === 'string' && (FINDING_SEVERITIES as readonly string[]).includes(value);
}

/** Review Finding Category */
export type FindingCategory = 'spec' | 'correctness' | 'tests' | 'maintainability' | 'security' | 'scope';

export const FINDING_CATEGORIES: readonly FindingCategory[] = [
  'spec',
  'correctness',
  'tests',
  'maintainability',
  'security',
  'scope',
];

export function isFindingCategory(value: unknown): value is FindingCategory {
  return typeof value === 'string' && (FINDING_CATEGORIES as readonly string[]).includes(value);
}

/** Review Finding */
export interface ReviewFinding {
  severity: FindingSeverity;
  category: FindingCategory;
  path?: string;
  line?: number;
  message: string;
}

/** Structured Review Output（speccraft-review YAML block） */
export interface ReviewOutput {
  version: 1;
  summary: string;
  findings: ReviewFinding[];
}

/** Review Attempt Manifest */
export interface ReviewAttemptManifest {
  version: 1;
  attempt: number;
  run_id: string;
  task_id: string;
  gate_id: string;
  gate_kind: ReviewGateKind;
  reviewer_profile: string;
  adapter: string;
  decision: ReviewDecision;
  source_dispatch_attempt: number;
  source_verification_attempt: number;
  workspace_attempt?: number;
  pre_tree: string;
  post_tree: string;
  pre_commit: string;
  post_commit: string;
  started_at: string;
  finished_at: string;
  session_id?: string;
  finding_count: number;
  blocking_findings: number;
  error_code?: string;
  error_message?: string;
}
