/**
 * Locked wire-format names for the loom-core mills feature
 * (renamed from "hive" — see `services/loom-core/.loom/96-rename-hive-to-mills-naming-map-2026-05-04.md`).
 *
 * Centralized so a future loom-core rename only touches this file.
 */

export const MILLS_REST_BASE = "/api/mills";

export const MILLS_REST_PATHS = {
  status: `${MILLS_REST_BASE}/status`,
  kpis: `${MILLS_REST_BASE}/kpis`,
  policy: `${MILLS_REST_BASE}/policy`,
  backlog: `${MILLS_REST_BASE}/backlog`,
  pipelineRuns: `${MILLS_REST_BASE}/pipeline/runs`,
  councilRuns: `${MILLS_REST_BASE}/council/runs`,
  squads: `${MILLS_REST_BASE}/squads`,
  auditFindings: `${MILLS_REST_BASE}/audit/findings`,
  policyProposals: `${MILLS_REST_BASE}/policy/proposals`,
} as const;

/**
 * Detail-endpoint path builders. Loom-core mounts each as
 * `${list}/{id}` so we share the construction logic.
 */
export function millsBacklogItemPath(id: string): string {
  return `${MILLS_REST_PATHS.backlog}/${encodeURIComponent(id)}`;
}

export function millsCouncilRunPath(id: string): string {
  return `${MILLS_REST_PATHS.councilRuns}/${encodeURIComponent(id)}`;
}

export function millsPipelineRunPath(id: string): string {
  return `${MILLS_REST_PATHS.pipelineRuns}/${encodeURIComponent(id)}`;
}

export function millsAuditFindingPath(id: string): string {
  return `${MILLS_REST_PATHS.auditFindings}/${encodeURIComponent(id)}`;
}

/** Mutation endpoints (slice 4). All require the HUD admin token. */
export const MILLS_REST_MUTATIONS = {
  councilDryrun: `${MILLS_REST_BASE}/council/dryrun`,
  councilRun: `${MILLS_REST_BASE}/council/run`,
  backlogCreate: `${MILLS_REST_BASE}/backlog`,
} as const;

export function millsPipelinePausePath(id: string): string {
  return `${MILLS_REST_PATHS.pipelineRuns}/${encodeURIComponent(id)}/pause`;
}

export function millsPipelineResumePath(id: string): string {
  return `${MILLS_REST_PATHS.pipelineRuns}/${encodeURIComponent(id)}/resume`;
}

export function millsPipelineEscalatePath(id: string): string {
  return `${MILLS_REST_PATHS.pipelineRuns}/${encodeURIComponent(id)}/escalate`;
}

export function millsPolicyProposalApplyPath(id: string): string {
  return `${MILLS_REST_PATHS.policyProposals}/${encodeURIComponent(id)}/apply`;
}

export function millsPolicyProposalRejectPath(id: string): string {
  return `${MILLS_REST_PATHS.policyProposals}/${encodeURIComponent(id)}/reject`;
}

export const MILLS_PROMETHEUS_PREFIX = "loom_mills_";

export const MILLS_HUD_ADMIN_TOKEN_ENV = {
  preferred: "LOOM_HUD_ADMIN_TOKEN",
  fallback: "HUD_ADMIN_TOKEN",
} as const;

export const MILLS_NAMESPACE = "loom-mills";
