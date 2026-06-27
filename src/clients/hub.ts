import * as vscode from "vscode";

import { HubSettings, HubHealthResponse, HubReadyResponse, HubServerInfo } from "../types";
import { requestJson, requestText } from "../utils/http";

export type HubConnectionStatus = "connected" | "disconnected" | "unknown";

/**
 * Number of consecutive health-probe failures (`consecFails`) at or above
 * which a server endpoint is treated as degraded even if `healthy` is still
 * reported true. Mirrors the daemon's own 3-failure offline threshold.
 */
const DEGRADED_CONSEC_FAILS_THRESHOLD = 3;

/**
 * One endpoint's health, mirroring loom-core's
 * `internal/visibility/contracts/health.HealthEntry`.
 */
export interface HubHealthEntry {
  healthy?: boolean;
  consecFails?: number;
  avgLatencyMs?: number;
  errorMessage?: string;
}

/**
 * Per-server divergence between the health monitor and the router, mirroring
 * loom-core's `health.HealthDivergence`.
 */
export interface HubHealthDivergence {
  monitor_healthy?: boolean;
  router_available?: boolean;
  reason?: string;
}

/**
 * Top-level divergence summary entry, mirroring loom-core's
 * `health.HealthDivergenceEntry` (one per disagreeing server).
 */
export interface HubHealthDivergenceEntry {
  server?: string;
  reason?: string;
}

/**
 * One server's consolidated health, mirroring loom-core's
 * `health.ServerHealth`. `monitor` and `divergence` are optional and absent
 * on older daemons — both must parse to `undefined` without error.
 */
export interface HubServerHealth {
  local?: HubHealthEntry;
  hub?: HubHealthEntry;
  monitor?: HubHealthEntry;
  target?: string;
  transport?: string;
  divergence?: HubHealthDivergence;
}

type HubApiHealthPayload = {
  status?: string;
  timestamp?: string;
  sessions?: number;
  servers?: Record<string, HubServerHealth>;
  divergence?: HubHealthDivergenceEntry[];
  cache_backend?: string;
  cacheBackend?: string;
};

/**
 * Boot-time HUD config, mirroring loom-core's `GET /api/hud/config` response.
 * `allowed_views`/`allowed_sub_views` are null/absent when the HUD reports the
 * full (unrestricted) surface; populated only for the operator subset.
 */
export interface HubConfig {
  subset: string;
  allowedViews?: string[];
  allowedSubViews?: Record<string, string[]>;
}

type HubApiConfigPayload = {
  subset?: string;
  allowed_views?: string[] | null;
  allowed_sub_views?: Record<string, string[]> | null;
};

type HubApiStatusPayload = {
  running?: boolean;
  ready?: boolean;
  servers?: number;
  activeConns?: number;
  idleConns?: number;
  processes?: unknown[];
  error?: string;
};

/**
 * Client for communicating with the MCP Hub API.
 */
export class HubClient {
  private readonly settings: HubSettings;
  private readonly channel: vscode.OutputChannel;
  private connectionStatus: HubConnectionStatus = "unknown";
  private lastHealthCheck: Date | null = null;
  private consecutiveFailures = 0;
  private readonly maxConsecutiveFailures = 3;

  constructor(settings: HubSettings, channel: vscode.OutputChannel) {
    this.settings = settings;
    this.channel = channel;
  }

  /**
   * Get current connection status.
   */
  getConnectionStatus(): HubConnectionStatus {
    return this.connectionStatus;
  }

  /**
   * Check if hub is currently reachable.
   */
  isOnline(): boolean {
    return this.connectionStatus === "connected";
  }

  /**
   * Perform a connectivity check.
   */
  async checkConnectivity(): Promise<boolean> {
    try {
      await this.fetchHealth();
      this.connectionStatus = "connected";
      this.consecutiveFailures = 0;
      this.lastHealthCheck = new Date();
      return true;
    } catch {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        this.connectionStatus = "disconnected";
      }
      return false;
    }
  }

  /**
   * Fetch the hub health status.
   */
  async fetchHealth(): Promise<HubHealthResponse> {
    try {
      const result = await this.fetchApiHealth();
      this.connectionStatus = "connected";
      this.consecutiveFailures = 0;
      this.lastHealthCheck = new Date();
      return result;
    } catch (error) {
      this.handleConnectionError(error);
      throw error;
    }
  }

  /**
   * Fetch the hub readiness status.
   */
  async fetchReady(): Promise<HubReadyResponse> {
    try {
      const result = await this.fetchApiStatus();
      this.connectionStatus = "connected";
      this.consecutiveFailures = 0;
      return result;
    } catch (error) {
      this.handleConnectionError(error);
      throw error;
    }
  }

  /**
   * Fetch the list of servers from the hub.
   */
  async fetchServers(): Promise<HubServerInfo[]> {
    try {
      const payload = await this.getJson<{ servers?: HubServerInfo[] }>("/api/servers");
      this.connectionStatus = "connected";
      this.consecutiveFailures = 0;
      return payload.servers ?? [];
    } catch (error) {
      if (isOptionalApiUnavailable(error)) {
        return [];
      }
      this.handleConnectionError(error);
      throw error;
    }
  }

  /**
   * Fetch the HUD's boot-time config (`GET /api/hud/config`).
   *
   * Returns the view-restriction allowlist the HUD applies when running as an
   * operator subset. When the endpoint is unavailable (older / gateway-only
   * hubs that 404), resolves to the unrestricted `{ subset: "full" }` default
   * rather than throwing, so callers can treat "no config" as "no restriction".
   */
  async fetchHudConfig(): Promise<HubConfig> {
    try {
      const payload = await this.getJson<HubApiConfigPayload>("/api/hud/config");
      this.connectionStatus = "connected";
      this.consecutiveFailures = 0;
      return normalizeHudConfig(payload);
    } catch (error) {
      if (isOptionalApiUnavailable(error)) {
        return { subset: "full" };
      }
      this.handleConnectionError(error);
      throw error;
    }
  }

  /**
   * Return the list of allowed top-level view ids when the HUD reports an
   * operator subset, or `undefined` when there is no restriction (full HUD).
   */
  async fetchAllowedViews(): Promise<string[] | undefined> {
    const config = await this.fetchHudConfig();
    return allowedViewsFromConfig(config);
  }

  /**
   * Get the last successful health check time.
   */
  getLastHealthCheck(): Date | null {
    return this.lastHealthCheck;
  }

  /**
   * Get consecutive failure count.
   */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  private handleConnectionError(error: unknown): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      if (this.connectionStatus !== "disconnected") {
        this.connectionStatus = "disconnected";
        const message = error instanceof Error ? error.message : String(error);
        this.channel.appendLine(
          `[HubClient] Hub offline after ${this.consecutiveFailures} failures: ${message}`
        );
      }
    }
  }

  private async getJson<T>(pathName: string): Promise<T> {
    if (!this.settings.httpBaseUrl) {
      throw new Error("Hub URL is not configured");
    }
    const target = new URL(pathName, this.settings.httpBaseUrl);
    const headers = this.buildHeaders();
    return requestJson<T>(target.toString(), headers);
  }

  private async fetchApiHealth(): Promise<HubHealthResponse> {
    try {
      const payload = await this.getJson<HubApiHealthPayload>("/api/health");
      return normalizeHealthPayload(payload);
    } catch (apiError) {
      try {
        const text = await this.getText("/health");
        return normalizePlainHealth(text);
      } catch {
        throw apiError;
      }
    }
  }

  private async fetchApiStatus(): Promise<HubReadyResponse> {
    try {
      const payload = await this.getJson<HubApiStatusPayload>("/api/status");
      return normalizeStatusPayload(payload);
    } catch (apiError) {
      try {
        const text = await this.getText("/ready");
        return normalizePlainReady(text);
      } catch {
        throw apiError;
      }
    }
  }

  private async getText(pathName: string): Promise<string> {
    if (!this.settings.httpBaseUrl) {
      throw new Error("Hub URL is not configured");
    }
    const target = new URL(pathName, this.settings.httpBaseUrl);
    const headers = this.buildHeaders();
    return requestText(target.toString(), headers);
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

function normalizeHealthPayload(payload: HubApiHealthPayload): HubHealthResponse {
  const divergence = payload.divergence ?? [];
  const servers = payload.servers ?? {};
  const hasDegradedServer = Object.values(servers).some(isServerDegraded);
  const status = normalizeHealthStatus(payload.status, hasDegradedServer, divergence.length > 0);

  return {
    status,
    timestamp: payload.timestamp,
    sessions: payload.sessions,
    servers,
    divergence,
    cacheBackend: payload.cacheBackend ?? payload.cache_backend,
  };
}

/**
 * Resolve the allowed top-level view ids from a parsed HUD config. Returns
 * `undefined` when the HUD reports no restriction (full subset).
 */
export function allowedViewsFromConfig(config: HubConfig): string[] | undefined {
  if (config.allowedViews && config.allowedViews.length > 0) {
    return config.allowedViews;
  }
  return undefined;
}

/**
 * Report whether a given view id is allowed under the supplied HUD config.
 * When the HUD reports no restriction (full subset), every view is allowed.
 */
export function isViewAllowed(config: HubConfig, viewId: string): boolean {
  const allowed = allowedViewsFromConfig(config);
  if (!allowed) {
    return true;
  }
  return allowed.includes(viewId);
}

/**
 * Report whether a sub-view is allowed under the supplied HUD config. An
 * allowed parent view with no sub-view entry (or an empty list) permits all of
 * its sub-views, matching loom-core's "empty list ⇒ all sub-views allowed".
 */
export function isSubViewAllowed(config: HubConfig, viewId: string, subViewId: string): boolean {
  if (!isViewAllowed(config, viewId)) {
    return false;
  }
  const subViews = config.allowedSubViews?.[viewId];
  if (!subViews || subViews.length === 0) {
    return true;
  }
  return subViews.includes(subViewId);
}

/**
 * Derive a degraded state for a single server entry. A server is degraded when
 * any of its endpoints is explicitly unhealthy, has crossed the consecutive-
 * failure threshold, or the daemon reports a monitor/router divergence.
 * Old payloads (no monitor/divergence) degrade purely on local/hub health.
 */
export function isServerDegraded(server: HubServerHealth): boolean {
  if (server.divergence) {
    return true;
  }
  const entries = [server.local, server.hub, server.monitor];
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    if (entry.healthy === false) {
      return true;
    }
    if ((entry.consecFails ?? 0) >= DEGRADED_CONSEC_FAILS_THRESHOLD) {
      return true;
    }
  }
  return false;
}

function normalizePlainHealth(body: string): HubHealthResponse {
  const statusText = body.trim().toLowerCase();
  const status = statusText === "ok" || statusText === "healthy" ? "ok" : statusText || "ok";
  return { status };
}

function normalizeStatusPayload(payload: HubApiStatusPayload): HubReadyResponse {
  const ready = payload.ready ?? payload.running;
  return {
    ready,
    running: payload.running,
    servers: payload.servers,
    activeConns: payload.activeConns,
    idleConns: payload.idleConns,
    processes: payload.processes,
    error: payload.error,
  };
}

function normalizePlainReady(body: string): HubReadyResponse {
  const statusText = body.trim().toLowerCase();
  return { ready: statusText === "ok" || statusText === "ready" || statusText === "true" };
}

function normalizeHealthStatus(
  status: string | undefined,
  hasDegradedServer: boolean,
  hasDivergence: boolean
): string {
  if (hasDivergence || hasDegradedServer) {
    return "degraded";
  }
  if (!status) {
    return "ok";
  }
  return status === "healthy" ? "ok" : status;
}

function normalizeHudConfig(payload: HubApiConfigPayload): HubConfig {
  const subset = payload.subset && payload.subset.trim() !== "" ? payload.subset : "full";
  const config: HubConfig = { subset };
  if (payload.allowed_views) {
    config.allowedViews = payload.allowed_views;
  }
  if (payload.allowed_sub_views) {
    config.allowedSubViews = payload.allowed_sub_views;
  }
  return config;
}

function isOptionalApiUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    /^(HTTP )?404\b/.test(error.message) || error.message.includes("Failed to parse hub response")
  );
}
