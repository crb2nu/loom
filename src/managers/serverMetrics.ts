import * as vscode from "vscode";

import { DaemonClient } from "../clients/daemon";
import { ServerHealthMetrics, ServerHealthHistory } from "../types";

import { HubStatusManager } from "./hubStatus";

const MAX_HISTORY_SAMPLES = 30; // 15 minutes at 30s interval

/**
 * Manager for collecting and tracking server health metrics.
 */
export class ServerMetricsManager implements vscode.Disposable {
  private readonly daemonClient: DaemonClient;
  private readonly hubStatusManager: HubStatusManager;
  private readonly channel: vscode.OutputChannel;
  private readonly metrics: Map<string, ServerHealthMetrics>;
  private readonly history: Map<string, ServerHealthHistory>;
  private readonly emitter = new vscode.EventEmitter<Map<string, ServerHealthMetrics>>();
  readonly onDidChangeMetrics = this.emitter.event;
  private intervalId?: NodeJS.Timeout;
  private intervalMs: number = 30000;

  constructor(
    daemonClient: DaemonClient,
    hubStatusManager: HubStatusManager,
    channel: vscode.OutputChannel
  ) {
    this.daemonClient = daemonClient;
    this.hubStatusManager = hubStatusManager;
    this.channel = channel;
    this.metrics = new Map();
    this.history = new Map();

    // Load interval from config
    this.intervalMs =
      vscode.workspace.getConfiguration("loom").get<number>("serverMetricsInterval") ?? 30000;

    // Start collection
    this.startCollection();
  }

  /**
   * Start periodic metrics collection.
   */
  startCollection(): void {
    this.stopCollection();

    // Initial collection
    void this.collectMetrics();

    // Periodic collection
    this.intervalId = setInterval(() => {
      void this.collectMetrics();
    }, this.intervalMs);
  }

  /**
   * Stop periodic metrics collection.
   */
  stopCollection(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  /**
   * Collect metrics from all servers.
   */
  async collectMetrics(): Promise<void> {
    const startTime = Date.now();

    try {
      // Get servers from daemon
      const servers = await this.daemonClient.getServers(true);
      const hubStatus = this.hubStatusManager.getStatus();
      const hubServers = new Set(hubStatus.servers.map((s) => s.name));

      for (const server of servers) {
        const latencyMs = Date.now() - startTime;
        const status = server.running ? "online" : "offline";

        const metrics: ServerHealthMetrics = {
          serverName: server.name,
          status,
          latencyMs,
          errorCount: 0, // TODO: Track errors
          lastCheck: new Date(),
          toolCount: 0, // TODO: Count tools per server
          isHubRouted: hubServers.has(server.name),
        };

        this.metrics.set(server.name, metrics);
        this.updateHistory(server.name, metrics);
      }

      // Add hub-only servers that daemon doesn't know about
      for (const hubServer of hubStatus.servers) {
        if (!this.metrics.has(hubServer.name)) {
          const metrics: ServerHealthMetrics = {
            serverName: hubServer.name,
            status: "online",
            latencyMs: 0,
            errorCount: 0,
            lastCheck: new Date(),
            toolCount: 0,
            isHubRouted: true,
          };
          this.metrics.set(hubServer.name, metrics);
          this.updateHistory(hubServer.name, metrics);
        }
      }

      this.emitter.fire(this.metrics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(
        `[${new Date().toISOString()}] Server metrics collection error: ${message}`
      );
    }
  }

  /**
   * Update history for a server.
   */
  private updateHistory(serverName: string, metrics: ServerHealthMetrics): void {
    let history = this.history.get(serverName);
    if (!history) {
      history = { serverName, samples: [] };
      this.history.set(serverName, history);
    }

    history.samples.push({
      timestamp: metrics.lastCheck,
      latencyMs: metrics.latencyMs,
      status: metrics.status,
    });

    // Trim old samples
    if (history.samples.length > MAX_HISTORY_SAMPLES) {
      history.samples = history.samples.slice(-MAX_HISTORY_SAMPLES);
    }
  }

  /**
   * Get current metrics for all servers.
   */
  getMetrics(): Map<string, ServerHealthMetrics> {
    return new Map(this.metrics);
  }

  /**
   * Get metrics for a specific server.
   */
  getServerMetrics(serverName: string): ServerHealthMetrics | undefined {
    return this.metrics.get(serverName);
  }

  /**
   * Get history for a specific server.
   */
  getServerHistory(serverName: string): ServerHealthHistory | undefined {
    return this.history.get(serverName);
  }

  /**
   * Get all history data.
   */
  getAllHistory(): Map<string, ServerHealthHistory> {
    return new Map(this.history);
  }

  /**
   * Ping a specific server and update its metrics.
   */
  async pingServer(serverName: string): Promise<ServerHealthMetrics | undefined> {
    const startTime = Date.now();

    try {
      // Force refresh servers
      const servers = await this.daemonClient.getServers(true);
      const server = servers.find((s) => s.name === serverName);

      if (!server) {
        // Check hub
        const hubStatus = this.hubStatusManager.getStatus();
        const hubServer = hubStatus.servers.find((s) => s.name === serverName);
        if (!hubServer) {
          return undefined;
        }

        const metrics: ServerHealthMetrics = {
          serverName,
          status: "online",
          latencyMs: Date.now() - startTime,
          errorCount: 0,
          lastCheck: new Date(),
          toolCount: 0,
          isHubRouted: true,
        };
        this.metrics.set(serverName, metrics);
        this.updateHistory(serverName, metrics);
        return metrics;
      }

      const metrics: ServerHealthMetrics = {
        serverName,
        status: server.running ? "online" : "offline",
        latencyMs: Date.now() - startTime,
        errorCount: 0,
        lastCheck: new Date(),
        toolCount: 0,
        isHubRouted: false,
      };

      this.metrics.set(serverName, metrics);
      this.updateHistory(serverName, metrics);
      this.emitter.fire(this.metrics);

      return metrics;
    } catch {
      return undefined;
    }
  }

  /**
   * Set the collection interval.
   */
  setInterval(ms: number): void {
    this.intervalMs = ms;
    this.startCollection();
  }

  dispose(): void {
    this.stopCollection();
    this.emitter.dispose();
  }
}
