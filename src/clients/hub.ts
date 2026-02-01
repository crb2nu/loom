import * as vscode from "vscode";

import { HubSettings, HubHealthResponse, HubReadyResponse, HubServerInfo } from "../types";
import { requestJson } from "../utils/http";

export type HubConnectionStatus = "connected" | "disconnected" | "unknown";

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
      const result = await this.getJson<HubHealthResponse>("/health");
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
      const result = await this.getJson<HubReadyResponse>("/ready");
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

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.settings.cfAccessClientId && this.settings.cfAccessClientSecret) {
      headers["CF-Access-Client-Id"] = this.settings.cfAccessClientId;
      headers["CF-Access-Client-Secret"] = this.settings.cfAccessClientSecret;
    }
    return headers;
  }
}
