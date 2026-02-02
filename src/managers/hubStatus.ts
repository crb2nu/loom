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
  private lastStatusHash = "";

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
      const newStatus = { ...this.status, error: message, servers: [], lastUpdated: now };
      this.updateStatusIfChanged(newStatus);
      return;
    }

    const client = new HubClient(this.settings, this.channel);

    try {
      const [health, readiness, servers] = await Promise.all([
        client.fetchHealth(),
        client.fetchReady(),
        client.fetchServers(),
      ]);
      const newStatus: HubStatusSnapshot = {
        health,
        readiness,
        servers,
        error: undefined,
        lastUpdated: new Date(),
      };
      this.updateStatusIfChanged(newStatus);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(`[${now.toISOString()}] Hub status refresh failed: ${message}`);
      const newStatus: HubStatusSnapshot = {
        ...this.status,
        error: message,
        lastUpdated: new Date(),
      };
      this.updateStatusIfChanged(newStatus);
    }
  }

  /**
   * Update status and only fire event if the meaningful content has changed.
   * Excludes lastUpdated from comparison since it always changes.
   */
  private updateStatusIfChanged(newStatus: HubStatusSnapshot): void {
    const newHash = this.computeStatusHash(newStatus);
    if (newHash !== this.lastStatusHash) {
      this.lastStatusHash = newHash;
      this.status = newStatus;
      this.emitter.fire();
    } else {
      // Update timestamp but don't fire event
      this.status = newStatus;
    }
  }

  /**
   * Compute a hash of the meaningful status fields (excluding lastUpdated).
   */
  private computeStatusHash(status: HubStatusSnapshot): string {
    const hashable = {
      health: status.health,
      readiness: status.readiness,
      servers: status.servers?.map((s) => ({ name: s.name, categories: s.categories })),
      error: status.error,
    };
    return JSON.stringify(hashable);
  }
}
