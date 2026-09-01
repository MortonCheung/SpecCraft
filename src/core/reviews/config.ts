/**
 * Review Config 解析与验证（ADR 0009 §12-§17）。
 */

import type { ReviewConfig, ReviewGateConfig, ReviewerProfileConfig, ReviewGateKind } from './types.js';
import { isReviewGateKind } from './types.js';

/** 解析 project.yaml 的 review section */
export function parseReviewConfig(source: unknown): ReviewConfig | null {
  if (source === undefined || source === null) {
    return null;
  }

  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('review section 必须是对象');
  }

  const obj = source as Record<string, unknown>;

  const enabled = obj.enabled === true;
  if (!enabled) {
    return { enabled: false, reviewers: {}, gates: [] };
  }

  const defaultReviewer = typeof obj.default_reviewer === 'string' ? obj.default_reviewer : undefined;

  const reviewers: Record<string, ReviewerProfileConfig> = {};
  if (obj.reviewers !== undefined && obj.reviewers !== null) {
    if (typeof obj.reviewers !== 'object' || Array.isArray(obj.reviewers)) {
      throw new Error('review.reviewers 必须是对象');
    }
    const rs = obj.reviewers as Record<string, unknown>;
    for (const [id, cfg] of Object.entries(rs)) {
      if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
        throw new Error(`reviewer "${id}" 配置必须是对象`);
      }
      const c = cfg as Record<string, unknown>;
      if (typeof c.adapter !== 'string' || !c.adapter) {
        throw new Error(`reviewer "${id}" 缺少 adapter`);
      }
      const profile: ReviewerProfileConfig = { adapter: c.adapter };
      if (typeof c.model === 'string') profile.model = c.model;
      if (typeof c.timeout_seconds === 'number' && c.timeout_seconds > 0) {
        profile.timeout_seconds = c.timeout_seconds;
      }
      if (Array.isArray(c.extra_args)) {
        profile.extra_args = c.extra_args.filter((a): a is string => typeof a === 'string');
      }
      if (typeof c.sandbox === 'string') profile.sandbox = c.sandbox;
      reviewers[id] = profile;
    }
  }

  const gates: ReviewGateConfig[] = [];
  if (obj.gates === undefined || obj.gates === null) {
    throw new Error('review enabled 但 gates 为空');
  }
  if (!Array.isArray(obj.gates)) {
    throw new Error('review.gates 必须是数组');
  }
  const seenIds = new Set<string>();
  for (const g of obj.gates) {
    if (typeof g !== 'object' || g === null || Array.isArray(g)) {
      throw new Error('gate 必须是对象');
    }
    const go = g as Record<string, unknown>;
    if (typeof go.id !== 'string' || !go.id) {
      throw new Error('gate 缺少 id');
    }
    if (seenIds.has(go.id)) {
      throw new Error(`gate id "${go.id}" 重复`);
    }
    seenIds.add(go.id);
    if (!isReviewGateKind(go.kind)) {
      throw new Error(`gate "${go.id}" kind 非法：${go.kind}`);
    }
    if (typeof go.reviewer !== 'string' || !go.reviewer) {
      throw new Error(`gate "${go.id}" 缺少 reviewer`);
    }
    if (!reviewers[go.reviewer]) {
      throw new Error(`gate "${go.id}" reviewer "${go.reviewer}" 不存在`);
    }
    gates.push({ id: go.id, kind: go.kind as ReviewGateKind, reviewer: go.reviewer });
  }

  if (defaultReviewer && !reviewers[defaultReviewer]) {
    throw new Error(`default_reviewer "${defaultReviewer}" 不存在`);
  }

  return { enabled: true, default_reviewer: defaultReviewer, reviewers, gates };
}

/** 验证 Review Config（gate adapter 存在性由 preflight 检查） */
export function validateReviewConfig(config: ReviewConfig, knownAdapters: Set<string>): void {
  if (!config.enabled) return;

  for (const [id, profile] of Object.entries(config.reviewers)) {
    if (!knownAdapters.has(profile.adapter)) {
      throw new Error(`reviewer "${id}" adapter "${profile.adapter}" 未知`);
    }
  }
}
