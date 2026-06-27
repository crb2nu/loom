import * as vscode from "vscode";

import { requestJson } from "../utils/http";

import {
  MILLS_REST_BASE,
  MILLS_REST_PATHS,
  millsAuditFindingPath,
  millsBacklogItemPath,
  millsCouncilRunPath,
  millsPipelineRunPath,
} from "./millsTransport";

/**
 * Additional read-only REST paths surfaced in S7 (cost-preview, eval
 * scores, cross-repo runs, workflow runs, per-squad memory/outcomes,
 * capabilities). Kept here rather than in millsTransport so the S7
 * client expansion is self-contained; a future loom-core rename of the
 * shared `/api/mills` prefix still flows through MILLS_REST_BASE.
 */
const MILLS_S7_PATHS = {
  costPreview: `${MILLS_REST_BASE}/cost-preview`,
  evalScores: `${MILLS_REST_BASE}/eval/scores`,
  crossRepoRuns: `${MILLS_REST_BASE}/cross-repo/runs`,
  workflowRuns: `${MILLS_REST_BASE}/workflow/runs`,
  capabilities: `${MILLS_REST_BASE}/capabilities`,
} as const;

function millsCrossRepoRunPath(id: string): string {
  return `${MILLS_S7_PATHS.crossRepoRuns}/${encodeURIComponent(id)}`;
}

function millsWorkflowRunPath(id: string): string {
  return `${MILLS_S7_PATHS.workflowRuns}/${encodeURIComponent(id)}`;
}

function millsSquadMemoryPath(name: string): string {
  return `${MILLS_REST_PATHS.squads}/${encodeURIComponent(name)}/memory`;
}

function millsSquadOutcomesPath(name: string): string {
  return `${MILLS_REST_PATHS.squads}/${encodeURIComponent(name)}/outcomes`;
}

/**
 * Settings for the Mills HUD client.
 */
export interface MillsSettings {
  /** HUD base URL (e.g. https://hud.loom.flexinfer.ai). Empty disables the client. */
  hudBaseUrl: string;
  /** Optional Cloudflare Access service-token client id for HUD ingress. */
  cfAccessClientId?: string;
  /** Optional Cloudflare Access service-token client secret for HUD ingress. */
  cfAccessClientSecret?: string;
}

/**
 * Loom-mills `/api/mills/status` response shape (per
 * cmd/loom-mills-operator/handlers_status.go).
 * Permissive on unknown keys.
 */
export interface MillsStatusResponse {
  db_ok?: boolean;
  policy_enabled?: boolean;
  policy_version?: string;
  queue_depth?: number;
  active_pipeline_runs?: number;
  last_council_at?: string | null;
  slice?: string;
  [key: string]: unknown;
}

/**
 * Loom-mills `/api/mills/kpis` response is a `KPISnapshot` with
 * an open-ended `Metrics` map. The metric keys are a moving target
 * across loom-core slices, so we keep the map untyped and let
 * consumers (alerting, status bar) read by string key with fallbacks.
 */
export interface MillsKpisResponse {
  ID?: number;
  SnapshotAt?: string;
  WindowSeconds?: number;
  Metrics?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MillsPolicyResponse {
  enabled?: boolean;
  ensemble?: string[];
  [key: string]: unknown;
}

/**
 * Loom-core types are marshaled with default Go encoding/json
 * (PascalCase field names). Types are permissive — we only depend on
 * the fields the extension surfaces today.
 */
export interface MillsBacklogItem {
  ID: string;
  Title?: string;
  State?: string;
  Priority?: string;
  Labels?: string[];
  GitLabIssueIID?: number | null;
  CreatedAt?: string;
  UpdatedAt?: string;
  [key: string]: unknown;
}

export interface MillsPipelineRun {
  ID: string;
  BacklogID?: string;
  Template?: string;
  State?: string;
  CurrentStage?: string;
  Attempts?: number;
  MRIID?: number | null;
  StartedAt?: string;
  EndedAt?: string | null;
  CostUSD?: number;
  [key: string]: unknown;
}

export interface MillsCouncilRun {
  ID: string;
  Trigger?: string;
  Outcome?: string;
  StartedAt?: string;
  EndedAt?: string | null;
  CostFrontierUSD?: number;
  CostLocalUSD?: number;
  BranchName?: string;
  [key: string]: unknown;
}

export interface MillsSquad {
  Name?: string;
  name?: string;
  Description?: string;
  description?: string;
  [key: string]: unknown;
}

export interface MillsAuditFinding {
  ID: number;
  SubjectKind?: string;
  SubjectID?: string;
  Severity?: string;
  RubricID?: string;
  SurvivalScore?: number;
  CostUSD?: number;
  CreatedAt?: string;
  Findings?: Array<Record<string, unknown>>;
  AuditorPool?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * Adaptive policy proposal (Phase 7 slice 7.2). Loom-core stores these
 * as proposed diffs against the live policy ConfigMap; in v1 the
 * extension is read-only — apply/reject lands in slice 4.
 */
export interface MillsPolicyProposal {
  ID: string;
  Status?: string;
  Reason?: string;
  CreatedAt?: string;
  Diff?: string;
  [key: string]: unknown;
}

/**
 * `/api/mills/cost-preview?backlog_id=…` returns a `budget.CostEstimate`
 * (snake_case json tags) wrapped in a `{ ...estimate, source }` envelope.
 * Requires a backlog_id query param; the operator 400s without it and
 * 503s when the policy manager isn't ready.
 */
export interface MillsCostPreview {
  backlog_id?: string;
  path_class?: string;
  median_historical_usd?: number;
  sidecar_slice_count?: number;
  sidecar_overhead_usd?: number;
  recursion_overhead_usd?: number;
  estimate_usd?: number;
  ensemble_cap_usd?: number;
  capped_by_policy?: boolean;
  confidence?: string;
  sample_size?: number;
  source?: string;
  [key: string]: unknown;
}

/**
 * `/api/mills/eval/scores` returns a bare array of `store.EvalScore`
 * (no json tags → Go-default PascalCase field names). The table stays
 * empty until loom-core slice 3.5 starts recording judgments, so an
 * empty array is the common case.
 */
export interface MillsEvalScore {
  ID?: number;
  SubjectKind?: string;
  SubjectID?: string;
  Rubric?: string;
  Score?: number;
  Breakdown?: Record<string, unknown>;
  JudgedBy?: string;
  EvaluatedAt?: string;
  Notes?: string;
  [key: string]: unknown;
}

/**
 * `/api/mills/cross-repo/runs` summary row (snake_case json tags). The
 * list endpoint wraps rows in `{ runs, total, limit, filter }`; the get
 * endpoint returns a bare summary object.
 */
export interface MillsCrossRepoRepoEntry {
  project_id?: number;
  repo_name?: string;
  branch?: string;
  mr_iid?: number | null;
  ci_status?: string;
  gate_status?: string;
  [key: string]: unknown;
}

export interface MillsCrossRepoRun {
  id: string;
  backlog_item_id?: string;
  state?: string;
  atomicity_strategy?: string;
  repos?: MillsCrossRepoRepoEntry[];
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/**
 * `/api/mills/workflow/runs` summary row (snake_case json tags). The
 * list endpoint wraps rows in `{ runs }`; the detail endpoint returns
 * `{ run, steps }` where each step is a `workflowStepView`.
 */
export interface MillsWorkflowRun {
  id: string;
  backlog_id?: string;
  engine?: string;
  template?: string;
  state?: string;
  started_at?: string | null;
  ended_at?: string | null;
  cost_usd?: number;
  step_count?: number;
  [key: string]: unknown;
}

export interface MillsWorkflowStep {
  id?: number;
  step_key?: string;
  event_type?: string;
  status?: string;
  spawn_id?: string;
  call_hash?: string;
  cost_usd?: number;
  cost_source?: string;
  effect_count?: number;
  started_at?: string | null;
  ended_at?: string | null;
  badge?: string;
  [key: string]: unknown;
}

export interface MillsWorkflowRunDetail {
  run: MillsWorkflowRun;
  steps: MillsWorkflowStep[];
}

/**
 * `/api/mills/squads/{name}/memory` returns a bare array of
 * `store.SquadMemory` (no json tags → PascalCase).
 */
export interface MillsSquadMemory {
  ID?: number;
  SquadName?: string;
  Kind?: string;
  Title?: string;
  Body?: string;
  Refs?: string[];
  Importance?: number;
  CreatedAt?: string;
  LastSeenAt?: string;
  [key: string]: unknown;
}

/**
 * `/api/mills/squads/{name}/outcomes` returns a bare array of
 * `store.SquadOutcome` (no json tags → PascalCase).
 */
export interface MillsSquadOutcome {
  ID?: number;
  SquadName?: string;
  PathClass?: string;
  PipelineRunID?: string;
  Outcome?: string;
  CostUSD?: number;
  DurationSeconds?: number;
  CreatedAt?: string;
  [key: string]: unknown;
}

/**
 * `/api/mills/capabilities` returns the operator's autonomy-readiness
 * report (snake_case json tags). Used to render a read-only capability
 * matrix; never throws when a subsystem is unwired.
 */
export interface MillsCapabilityRow {
  id: string;
  status?: string;
  mode?: string;
  required_for_autonomy?: boolean;
  last_checked_at?: string;
  message?: string;
  source?: string;
  config_key?: string;
  [key: string]: unknown;
}

export interface MillsCapabilityReport {
  autonomy_ready?: boolean;
  autonomy_blockers?: string[];
  capabilities?: MillsCapabilityRow[];
  checked_at?: string;
  [key: string]: unknown;
}

export type MillsHealth = "ok" | "paused" | "degraded" | "unreachable" | "unconfigured";

export interface MillsStatusSnapshot {
  health: MillsHealth;
  status?: MillsStatusResponse;
  kpis?: MillsKpisResponse;
  error?: string;
  lastUpdated?: Date;
}

/**
 * Read-only client for the loom-mills HUD proxy at `/api/mills/*`.
 * The extension never talks to the operator directly; HUD provides
 * double-auth and keeps the operator admin token out of the editor.
 */
export class MillsClient {
  private readonly settings: MillsSettings;
  private readonly channel: vscode.OutputChannel;

  constructor(settings: MillsSettings, channel: vscode.OutputChannel) {
    this.settings = settings;
    this.channel = channel;
  }

  isConfigured(): boolean {
    return Boolean(this.settings.hudBaseUrl);
  }

  async fetchStatus(): Promise<MillsStatusResponse> {
    return this.getJson<MillsStatusResponse>(MILLS_REST_PATHS.status);
  }

  async fetchKpis(): Promise<MillsKpisResponse> {
    return this.getJson<MillsKpisResponse>(MILLS_REST_PATHS.kpis);
  }

  async fetchPolicy(): Promise<MillsPolicyResponse> {
    return this.getJson<MillsPolicyResponse>(MILLS_REST_PATHS.policy);
  }

  async fetchBacklog(): Promise<MillsBacklogItem[]> {
    return this.getJsonList<MillsBacklogItem>(MILLS_REST_PATHS.backlog);
  }

  async fetchPipelineRuns(): Promise<MillsPipelineRun[]> {
    return this.getJsonList<MillsPipelineRun>(MILLS_REST_PATHS.pipelineRuns);
  }

  async fetchCouncilRuns(): Promise<MillsCouncilRun[]> {
    return this.getJsonList<MillsCouncilRun>(MILLS_REST_PATHS.councilRuns);
  }

  async fetchSquads(): Promise<MillsSquad[]> {
    return this.getJsonList<MillsSquad>(MILLS_REST_PATHS.squads);
  }

  async fetchAuditFindings(): Promise<MillsAuditFinding[]> {
    return this.getJsonList<MillsAuditFinding>(MILLS_REST_PATHS.auditFindings);
  }

  async fetchPolicyProposals(): Promise<MillsPolicyProposal[]> {
    return this.getJsonList<MillsPolicyProposal>(MILLS_REST_PATHS.policyProposals);
  }

  async fetchBacklogItem(id: string): Promise<MillsBacklogItem> {
    return this.getJson<MillsBacklogItem>(millsBacklogItemPath(id));
  }

  async fetchCouncilRun(id: string): Promise<MillsCouncilRun> {
    return this.getJson<MillsCouncilRun>(millsCouncilRunPath(id));
  }

  async fetchPipelineRun(id: string): Promise<MillsPipelineRun> {
    return this.getJson<MillsPipelineRun>(millsPipelineRunPath(id));
  }

  async fetchAuditFinding(id: string): Promise<MillsAuditFinding> {
    return this.getJson<MillsAuditFinding>(millsAuditFindingPath(id));
  }

  // ---- S7 read surfaces ----------------------------------------------------

  /**
   * Cost preview for a backlog item. The operator requires a
   * `backlog_id` query param (400 without it) and 503s when the policy
   * manager isn't ready; both surface as a thrown Error the caller can
   * render in a detail/empty state.
   */
  async fetchCostPreview(backlogId: string): Promise<MillsCostPreview> {
    const path = `${MILLS_S7_PATHS.costPreview}?backlog_id=${encodeURIComponent(backlogId)}`;
    return this.getJson<MillsCostPreview>(path);
  }

  async fetchEvalScores(): Promise<MillsEvalScore[]> {
    return this.getJsonList<MillsEvalScore>(MILLS_S7_PATHS.evalScores);
  }

  async fetchCrossRepoRuns(): Promise<MillsCrossRepoRun[]> {
    return this.getJsonList<MillsCrossRepoRun>(MILLS_S7_PATHS.crossRepoRuns);
  }

  async fetchCrossRepoRun(id: string): Promise<MillsCrossRepoRun> {
    return this.getJson<MillsCrossRepoRun>(millsCrossRepoRunPath(id));
  }

  async fetchWorkflowRuns(): Promise<MillsWorkflowRun[]> {
    return this.getJsonList<MillsWorkflowRun>(MILLS_S7_PATHS.workflowRuns);
  }

  /**
   * Workflow run detail. The operator returns `{ run, steps }`; we
   * normalize a missing `steps` to an empty array so the detail panel
   * never iterates over undefined.
   */
  async fetchWorkflowRun(id: string): Promise<MillsWorkflowRunDetail> {
    const raw = await this.getJson<Partial<MillsWorkflowRunDetail>>(millsWorkflowRunPath(id));
    return {
      run: raw?.run ?? { id },
      steps: Array.isArray(raw?.steps) ? raw.steps : [],
    };
  }

  /**
   * Per-squad working memory. The operator 404s when the squad isn't in
   * the canonical store and returns a bare array otherwise (empty when
   * the squads loader is unconfigured); both are handled by the caller.
   */
  async fetchSquadMemory(name: string): Promise<MillsSquadMemory[]> {
    return this.getJsonList<MillsSquadMemory>(millsSquadMemoryPath(name));
  }

  async fetchSquadOutcomes(name: string): Promise<MillsSquadOutcome[]> {
    return this.getJsonList<MillsSquadOutcome>(millsSquadOutcomesPath(name));
  }

  /**
   * Autonomy-readiness capability report. Always 200 — the operator
   * reports per-row status rather than erroring on unwired subsystems.
   */
  async fetchCapabilities(): Promise<MillsCapabilityReport> {
    return this.getJson<MillsCapabilityReport>(MILLS_S7_PATHS.capabilities);
  }

  /**
   * Build a snapshot suitable for the status bar.
   * Returns `unconfigured` when no HUD URL is set; never throws.
   */
  async fetchSnapshot(): Promise<MillsStatusSnapshot> {
    if (!this.isConfigured()) {
      return { health: "unconfigured" };
    }
    try {
      const [status, kpis] = await Promise.all([this.fetchStatus(), this.fetchKpis()]);
      return {
        health: deriveHealth(status, kpis),
        status,
        kpis,
        lastUpdated: new Date(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(`[MillsClient] snapshot failed: ${message}`);
      return {
        health: "unreachable",
        error: message,
        lastUpdated: new Date(),
      };
    }
  }

  private async getJson<T>(pathName: string): Promise<T> {
    if (!this.settings.hudBaseUrl) {
      throw new Error("Mills HUD URL is not configured");
    }
    const target = new URL(pathName, this.settings.hudBaseUrl);
    return requestJson<T>(target.toString(), this.buildHeaders());
  }

  /**
   * Fetch a list endpoint; loom-core may return either a bare array
   * or an object with an `items`/`runs`/`findings` key. We unwrap the
   * common shapes and return a plain array; unknown shapes return [].
   */
  private async getJsonList<T>(pathName: string): Promise<T[]> {
    const raw = await this.getJson<unknown>(pathName);
    return coerceList<T>(raw);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.settings.cfAccessClientId && this.settings.cfAccessClientSecret) {
      headers["CF-Access-Client-Id"] = this.settings.cfAccessClientId;
      headers["CF-Access-Client-Secret"] = this.settings.cfAccessClientSecret;
    }
    return headers;
  }
}

/**
 * Common metric keys we read out of `KPISnapshot.Metrics` when present.
 * Loom-core hasn't fixed a contract yet — these are best-effort and the
 * function tolerates missing keys.
 */
export const MILLS_METRIC_KEYS = {
  regressionCount: ["regression_count", "regressions_total", "loom_mills_regression_count_total"],
  auditFindingsTotal: ["audit_findings_total", "loom_mills_audit_findings_total"],
} as const;

export function readMetric(
  kpis: MillsKpisResponse | undefined,
  candidates: readonly string[]
): number | undefined {
  const metrics = kpis?.Metrics;
  if (!metrics) return undefined;
  for (const key of candidates) {
    const v = metrics[key];
    if (typeof v === "number") return v;
  }
  return undefined;
}

export function deriveHealth(status: MillsStatusResponse, kpis: MillsKpisResponse): MillsHealth {
  if (status.policy_enabled === false) {
    return "paused";
  }
  const regressions = readMetric(kpis, MILLS_METRIC_KEYS.regressionCount);
  if ((regressions ?? 0) > 0) {
    return "degraded";
  }
  return "ok";
}

const LIST_WRAPPER_KEYS = [
  "items",
  "runs",
  "findings",
  "squads",
  "backlog",
  "scores",
  "outcomes",
  "memory",
] as const;

export function coerceList<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) {
    return raw as T[];
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of LIST_WRAPPER_KEYS) {
      const candidate = obj[key];
      if (Array.isArray(candidate)) {
        return candidate as T[];
      }
    }
  }
  return [];
}
