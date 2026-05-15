import * as vscode from "vscode";

import { HubSettings, HubHealthResponse, HubReadyResponse, HubServerInfo } from "../types";
import { requestJson, requestText } from "../utils/http";

export type HubConnectionStatus = "connected" | "disconnected" | "unknown";

type HubApiHealthPayload = {
  status?: string;
  timestamp?: string;
  sessions?: number;
  servers?: Record<string, HubApiServerHealth>;
  divergence?: unknown[];
  cache_backend?: string;
  cacheBackend?: string;
};

type HubApiServerHealth = {
  healthy?: boolean;
  local?: HubApiHealthEntry;
  hub?: HubApiHealthEntry;
};

type HubApiHealthEntry = {
  healthy?: boolean;
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
  const healthStates = Object.values(servers).map(isServerHealthy);
  const hasUnhealthyServer = healthStates.some((healthy) => healthy === false);
  const status = normalizeHealthStatus(payload.status, hasUnhealthyServer, divergence.length > 0);

  return {
    status,
    timestamp: payload.timestamp,
    sessions: payload.sessions,
    servers,
    divergence,
    cacheBackend: payload.cacheBackend ?? payload.cache_backend,
  };
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
  hasUnhealthyServer: boolean,
  hasDivergence: boolean
): string {
  if (hasDivergence || hasUnhealthyServer) {
    return "degraded";
  }
  if (!status) {
    return "ok";
  }
  return status === "healthy" ? "ok" : status;
}

function isServerHealthy(server: HubApiServerHealth): boolean | undefined {
  const states = [server.healthy, server.local?.healthy, server.hub?.healthy].filter(
    (value): value is boolean => typeof value === "boolean"
  );
  if (states.length === 0) {
    return undefined;
  }
  return states.every(Boolean);
}

function isOptionalApiUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    /^(HTTP )?404\b/.test(error.message) || error.message.includes("Failed to parse hub response")
  );
}
