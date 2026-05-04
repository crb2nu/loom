import * as vscode from "vscode";

import { requestJson } from "../utils/http";

import {
  MILLS_REST_PATHS,
  millsAuditFindingPath,
  millsBacklogItemPath,
  millsCouncilRunPath,
  millsPipelineRunPath,
} from "./millsTransport";

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
 * Subset of the loom-mills `/api/mills/status` response we surface in the extension.
 * Loom-core may return additional fields; we keep the type permissive.
 */
export interface MillsStatusResponse {
  enabled?: boolean;
  paused?: boolean;
  stage?: string;
  policy_version?: string;
  [key: string]: unknown;
}

export interface MillsKpisResponse {
  regression_count?: number;
  council_runs_total?: number;
  pipeline_runs_total?: number;
  budget_remaining_usd?: number;
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

export function deriveHealth(status: MillsStatusResponse, kpis: MillsKpisResponse): MillsHealth {
  if (status.enabled === false || status.paused === true) {
    return "paused";
  }
  if ((kpis.regression_count ?? 0) > 0) {
    return "degraded";
  }
  return "ok";
}

const LIST_WRAPPER_KEYS = ["items", "runs", "findings", "squads", "backlog"] as const;

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
