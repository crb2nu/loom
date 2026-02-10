import * as vscode from "vscode";

import { DaemonClient } from "../clients/daemon";
import { ServerHealthMetrics, ServerHealthHistory, DaemonToolInfo } from "../types";
import { Logger } from "../utils/logger";

import { HubStatusManager } from "./hubStatus";

const MAX_HISTORY_SAMPLES = 30; // 15 minutes at 30s interval

/**
 * Manager for collecting and tracking server health metrics.
 */
export class ServerMetricsManager implements vscode.Disposable {
  private readonly daemonClient: DaemonClient;
  private readonly hubStatusManager: HubStatusManager;
  private readonly channel: vscode.OutputChannel;
  private readonly logger: Logger;
  private readonly metrics: Map<string, ServerHealthMetrics>;
  private readonly history: Map<string, ServerHealthHistory>;
  private readonly errorCounts: Map<string, number>;
  private readonly toolCounts: Map<string, number>;
  private readonly emitter = new vscode.EventEmitter<Map<string, ServerHealthMetrics>>();
  readonly onDidChangeMetrics = this.emitter.event;
  private intervalId?: NodeJS.Timeout;
  private intervalMs: number = 30000;
  private cachedTools: DaemonToolInfo[] = [];
  private lastToolFetch: Date | null = null;

  /**
   * @param daemonClient - Client for querying daemon server status.
   * @param hubStatusManager - Manager for hub status information.
   * @param channel - Output channel for logging.
   * @param metricsInterval - Optional override for the metrics collection interval (ms).
   *   When provided, skips reading "loom.serverMetricsInterval" from vscode config.
   */
  constructor(
    daemonClient: DaemonClient,
    hubStatusManager: HubStatusManager,
    channel: vscode.OutputChannel,
    metricsInterval?: number
  ) {
    this.daemonClient = daemonClient;
    this.hubStatusManager = hubStatusManager;
    this.channel = channel;
    this.logger = new Logger(channel, "ServerMetrics");
    this.metrics = new Map();
    this.history = new Map();
    this.errorCounts = new Map();
    this.toolCounts = new Map();

    // Load interval from parameter or config
    this.intervalMs =
      metricsInterval ??
      vscode.workspace.getConfiguration("loom").get<number>("serverMetricsInterval") ??
      30000;

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

      // Refresh tool counts periodically (every 5 minutes)
      await this.refreshToolCounts();

      for (const server of servers) {
        const latencyMs = Date.now() - startTime;
        const status = server.running ? "online" : "offline";

        // Track errors when server goes offline
        if (!server.running) {
          const currentErrors = this.errorCounts.get(server.name) ?? 0;
          this.errorCounts.set(server.name, currentErrors + 1);
        } else {
          // Reset error count when server comes back online
          const currentErrors = this.errorCounts.get(server.name) ?? 0;
          if (currentErrors > 0) {
            // Decay errors gradually when healthy
            this.errorCounts.set(server.name, Math.max(0, currentErrors - 1));
          }
        }

        const metrics: ServerHealthMetrics = {
          serverName: server.name,
          status,
          latencyMs,
          errorCount: this.errorCounts.get(server.name) ?? 0,
          lastCheck: new Date(),
          toolCount: this.toolCounts.get(server.name) ?? 0,
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
            errorCount: this.errorCounts.get(hubServer.name) ?? 0,
            lastCheck: new Date(),
            toolCount: this.toolCounts.get(hubServer.name) ?? 0,
            isHubRouted: true,
          };
          this.metrics.set(hubServer.name, metrics);
          this.updateHistory(hubServer.name, metrics);
        }
      }

      this.emitter.fire(this.metrics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Server metrics collection error: ${message}`);
    }
  }

  /**
   * Refresh tool counts for all servers.
   * Cached for 5 minutes to reduce daemon calls.
   */
  private async refreshToolCounts(): Promise<void> {
    const now = new Date();
    const cacheTimeoutMs = 5 * 60 * 1000; // 5 minutes

    if (this.lastToolFetch && now.getTime() - this.lastToolFetch.getTime() < cacheTimeoutMs) {
      return;
    }

    try {
      const tools = await this.daemonClient.getTools();
      this.cachedTools = tools;
      this.lastToolFetch = now;

      // Count tools per server
      this.toolCounts.clear();
      for (const tool of tools) {
        const serverName = tool.server;
        const currentCount = this.toolCounts.get(serverName) ?? 0;
        this.toolCounts.set(serverName, currentCount + 1);
      }
    } catch {
      // Silently fail - we'll use cached counts
    }
  }

  /**
   * Record an error for a server.
   */
  recordError(serverName: string): void {
    const currentErrors = this.errorCounts.get(serverName) ?? 0;
    this.errorCounts.set(serverName, currentErrors + 1);
  }

  /**
   * Get tool count for a server.
   */
  getToolCount(serverName: string): number {
    return this.toolCounts.get(serverName) ?? 0;
  }

  /**
   * Get error count for a server.
   */
  getErrorCount(serverName: string): number {
    return this.errorCounts.get(serverName) ?? 0;
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
          errorCount: this.errorCounts.get(serverName) ?? 0,
          lastCheck: new Date(),
          toolCount: this.toolCounts.get(serverName) ?? 0,
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
        errorCount: this.errorCounts.get(serverName) ?? 0,
        lastCheck: new Date(),
        toolCount: this.toolCounts.get(serverName) ?? 0,
        isHubRouted: false,
      };

      this.metrics.set(serverName, metrics);
      this.updateHistory(serverName, metrics);
      this.emitter.fire(this.metrics);

      return metrics;
    } catch {
      this.recordError(serverName);
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
