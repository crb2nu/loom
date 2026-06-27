import * as vscode from "vscode";

import { DaemonClient, ToolExecutionEvent } from "../clients/daemon";
import { Logger } from "../utils/logger";

const STORAGE_KEY = "loom.usageAnalytics.v1";
const MAX_RECENT_EVENTS = 50;

interface ToolUsageStats {
  count: number;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
  lastUsedAt: string;
}

interface PersistedUsageAnalytics {
  byHour: Record<string, number>;
  byServer: Record<string, number>;
  byTool: Record<string, ToolUsageStats>;
  failureCalls: number;
  recent: ToolExecutionEvent[];
  successCalls: number;
  totalCalls: number;
}

const EMPTY_ANALYTICS: PersistedUsageAnalytics = {
  totalCalls: 0,
  successCalls: 0,
  failureCalls: 0,
  byServer: {},
  byTool: {},
  byHour: {},
  recent: [],
};

/**
 * Tracks daemon tool usage patterns across extension sessions.
 */
export class UsageAnalyticsManager implements vscode.Disposable {
  private readonly logger: Logger;
  private readonly toolExecutionDisposable: vscode.Disposable;
  private readonly data: PersistedUsageAnalytics;

  constructor(
    daemonClient: DaemonClient,
    private readonly workspaceState: vscode.Memento,
    channel: vscode.OutputChannel
  ) {
    this.logger = new Logger(channel, "UsageAnalytics");
    this.data = this.load();
    this.toolExecutionDisposable = daemonClient.onToolExecution((event) => {
      void this.record(event);
    });
  }

  private load(): PersistedUsageAnalytics {
    const persisted = this.workspaceState.get<PersistedUsageAnalytics>(STORAGE_KEY);
    if (!persisted) {
      return { ...EMPTY_ANALYTICS };
    }
    return {
      totalCalls: persisted.totalCalls ?? 0,
      successCalls: persisted.successCalls ?? 0,
      failureCalls: persisted.failureCalls ?? 0,
      byServer: persisted.byServer ?? {},
      byTool: persisted.byTool ?? {},
      byHour: persisted.byHour ?? {},
      recent: Array.isArray(persisted.recent) ? persisted.recent : [],
    };
  }

  private async record(event: ToolExecutionEvent): Promise<void> {
    this.data.totalCalls += 1;
    if (event.success) {
      this.data.successCalls += 1;
    } else {
      this.data.failureCalls += 1;
    }

    this.data.byServer[event.server] = (this.data.byServer[event.server] ?? 0) + 1;

    const toolStats = this.data.byTool[event.toolName] ?? {
      count: 0,
      successCount: 0,
      failureCount: 0,
      avgDurationMs: 0,
      lastUsedAt: event.timestamp,
    };
    const nextCount = toolStats.count + 1;
    const nextAvg = Math.round(
      (toolStats.avgDurationMs * toolStats.count + event.durationMs) / nextCount
    );
    this.data.byTool[event.toolName] = {
      count: nextCount,
      successCount: toolStats.successCount + (event.success ? 1 : 0),
      failureCount: toolStats.failureCount + (event.success ? 0 : 1),
      avgDurationMs: nextAvg,
      lastUsedAt: event.timestamp,
    };

    const hour = new Date(event.timestamp).getHours().toString().padStart(2, "0");
    this.data.byHour[hour] = (this.data.byHour[hour] ?? 0) + 1;

    this.data.recent.unshift(event);
    if (this.data.recent.length > MAX_RECENT_EVENTS) {
      this.data.recent = this.data.recent.slice(0, MAX_RECENT_EVENTS);
    }

    await this.workspaceState.update(STORAGE_KEY, this.data);
  }

  getSnapshot(): PersistedUsageAnalytics {
    return {
      totalCalls: this.data.totalCalls,
      successCalls: this.data.successCalls,
      failureCalls: this.data.failureCalls,
      byServer: { ...this.data.byServer },
      byTool: Object.fromEntries(
        Object.entries(this.data.byTool).map(([tool, stats]) => [tool, { ...stats }])
      ),
      byHour: { ...this.data.byHour },
      recent: this.data.recent.map((event) => ({ ...event })),
    };
  }

  async showReport(): Promise<void> {
    const snapshot = this.getSnapshot();
    const topTools = Object.entries(snapshot.byTool)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10);
    const topServers = Object.entries(snapshot.byServer)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const lines: string[] = [
      "# Loom Usage Analytics",
      "",
      `- Total tool calls: **${snapshot.totalCalls}**`,
      `- Success: **${snapshot.successCalls}**`,
      `- Failure: **${snapshot.failureCalls}**`,
      "",
      "## Top Servers",
      "",
    ];

    if (topServers.length === 0) {
      lines.push("- No tool calls recorded yet.");
    } else {
      lines.push(...topServers.map(([server, count]) => `- \`${server}\`: ${count}`));
    }

    lines.push("", "## Top Tools", "");
    if (topTools.length === 0) {
      lines.push("- No tool calls recorded yet.");
    } else {
      lines.push(
        ...topTools.map(
          ([tool, stats]) =>
            `- \`${tool}\`: ${stats.count} calls (${stats.successCount} ok / ${stats.failureCount} fail), avg ${stats.avgDurationMs}ms`
        )
      );
    }

    lines.push("", "## Usage by Hour (Local Time)", "");
    const hourRows = Object.entries(snapshot.byHour).sort(([a], [b]) => a.localeCompare(b));
    if (hourRows.length === 0) {
      lines.push("- No tool calls recorded yet.");
    } else {
      lines.push(...hourRows.map(([hour, count]) => `- ${hour}:00 - ${count}`));
    }

    const document = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: lines.join("\n"),
    });
    await vscode.window.showTextDocument(document, { preview: true });
    this.logger.info("Opened usage analytics report");
  }

  dispose(): void {
    this.toolExecutionDisposable.dispose();
  }
}
