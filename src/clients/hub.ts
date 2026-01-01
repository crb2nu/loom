import * as vscode from "vscode";

import { HubSettings, HubHealthResponse, HubReadyResponse, HubServerInfo } from "../types";
import { requestJson } from "../utils/http";

/**
 * Client for communicating with the MCP Hub API.
 */
export class HubClient {
  private readonly settings: HubSettings;

  constructor(settings: HubSettings, _channel: vscode.OutputChannel) {
    this.settings = settings;
  }

  /**
   * Fetch the hub health status.
   */
  async fetchHealth(): Promise<HubHealthResponse> {
    return this.getJson<HubHealthResponse>("/health");
  }

  /**
   * Fetch the hub readiness status.
   */
  async fetchReady(): Promise<HubReadyResponse> {
    return this.getJson<HubReadyResponse>("/ready");
  }

  /**
   * Fetch the list of servers from the hub.
   */
  async fetchServers(): Promise<HubServerInfo[]> {
    const payload = await this.getJson<{ servers?: HubServerInfo[] }>("/api/servers");
    return payload.servers ?? [];
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
