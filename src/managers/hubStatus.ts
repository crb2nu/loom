import * as vscode from "vscode";

import { HubClient } from "../clients/hub";
import { HubSettings, HubStatusSnapshot } from "../types";

/**
 * Manages the hub connection status, periodically refreshing health and server info.
 */
export class HubStatusManager implements vscode.Disposable {
  private settings: HubSettings;
  private readonly channel: vscode.OutputChannel;
  private readonly emitter = new vscode.EventEmitter<void>();
  private status: HubStatusSnapshot = { servers: [] };
  private refreshPromise?: Promise<void>;

  constructor(settings: HubSettings, channel: vscode.OutputChannel) {
    this.settings = settings;
    this.channel = channel;
  }

  dispose() {
    this.emitter.dispose();
  }

  getSettings(): HubSettings {
    return this.settings;
  }

  updateSettings(next: HubSettings) {
    this.settings = next;
    void this.refresh();
  }

  getStatus(): HubStatusSnapshot {
    return this.status;
  }

  readonly onDidChange = this.emitter.event;

  async refresh(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh();
    }
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  private async performRefresh(): Promise<void> {
    const now = new Date();
    if (!this.settings.httpBaseUrl) {
      const message = "Invalid MCP hub URL";
      this.channel.appendLine(`[${now.toISOString()}] ${message}`);
      this.status = { ...this.status, error: message, servers: [], lastUpdated: now };
      this.emitter.fire();
      return;
    }

    const client = new HubClient(this.settings, this.channel);

    try {
      const [health, readiness, servers] = await Promise.all([
        client.fetchHealth(),
        client.fetchReady(),
        client.fetchServers(),
      ]);
      this.status = {
        health,
        readiness,
        servers,
        error: undefined,
        lastUpdated: new Date(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(`[${now.toISOString()}] Hub status refresh failed: ${message}`);
      this.status = {
        ...this.status,
        error: message,
        lastUpdated: new Date(),
      };
    }

    this.emitter.fire();
  }
}
