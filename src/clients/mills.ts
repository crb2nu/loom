import * as vscode from "vscode";

import { requestJson } from "../utils/http";

import { MILLS_REST_PATHS } from "./millsTransport";

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

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.settings.cfAccessClientId && this.settings.cfAccessClientSecret) {
      headers["CF-Access-Client-Id"] = this.settings.cfAccessClientId;
      headers["CF-Access-Client-Secret"] = this.settings.cfAccessClientSecret;
    }
    return headers;
  }
}

export function deriveHealth(
  status: MillsStatusResponse,
  kpis: MillsKpisResponse
): MillsHealth {
  if (status.enabled === false || status.paused === true) {
    return "paused";
  }
  if ((kpis.regression_count ?? 0) > 0) {
    return "degraded";
  }
  return "ok";
}
