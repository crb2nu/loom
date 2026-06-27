import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

import { DaemonClient, ToolExecutionEvent } from "../clients/daemon";

import { UsageAnalyticsManager } from "./usageAnalytics";

class FakeDaemonClient {
  private readonly emitter = new vscode.EventEmitter<ToolExecutionEvent>();
  readonly onToolExecution = this.emitter.event;

  emit(event: ToolExecutionEvent): void {
    this.emitter.fire(event);
  }
}

describe("UsageAnalyticsManager", () => {
  let daemon: FakeDaemonClient;
  let workspaceState: vscode.Memento;
  let channel: vscode.OutputChannel;

  beforeEach(() => {
    daemon = new FakeDaemonClient();
    workspaceState = {
      get: vi.fn(() => undefined),
      update: vi.fn(async () => {}),
    } as unknown as vscode.Memento;
    channel = {
      name: "Test",
      append: vi.fn(),
      appendLine: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      replace: vi.fn(),
    };
  });

  it("records tool execution events and updates aggregates", async () => {
    const manager = new UsageAnalyticsManager(
      daemon as unknown as DaemonClient,
      workspaceState,
      channel
    );

    daemon.emit({
      toolName: "github__list_issues",
      server: "github",
      tool: "list_issues",
      success: true,
      durationMs: 42,
      timestamp: "2026-02-26T12:00:00.000Z",
    });

    daemon.emit({
      toolName: "github__list_issues",
      server: "github",
      tool: "list_issues",
      success: false,
      durationMs: 58,
      timestamp: "2026-02-26T13:00:00.000Z",
      error: "boom",
    });

    await Promise.resolve();

    const snapshot = manager.getSnapshot();
    expect(snapshot.totalCalls).toBe(2);
    expect(snapshot.successCalls).toBe(1);
    expect(snapshot.failureCalls).toBe(1);
    expect(snapshot.byServer.github).toBe(2);
    expect(snapshot.byTool.github__list_issues.count).toBe(2);
    expect(snapshot.byTool.github__list_issues.avgDurationMs).toBe(50);
    const totalByHour = Object.values(snapshot.byHour).reduce((sum, count) => sum + count, 0);
    expect(totalByHour).toBe(2);
    expect(snapshot.recent).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(workspaceState.update).toHaveBeenCalled();
    manager.dispose();
  });

  it("loads persisted usage analytics from workspace state", () => {
    workspaceState = {
      get: vi.fn(() => ({
        totalCalls: 7,
        successCalls: 6,
        failureCalls: 1,
        byServer: { github: 7 },
        byTool: {
          github__list_issues: {
            count: 7,
            successCount: 6,
            failureCount: 1,
            avgDurationMs: 40,
            lastUsedAt: "2026-02-26T12:00:00.000Z",
          },
        },
        byHour: { "12": 7 },
        recent: [],
      })),
      update: vi.fn(async () => {}),
    } as unknown as vscode.Memento;

    const manager = new UsageAnalyticsManager(
      daemon as unknown as DaemonClient,
      workspaceState,
      channel
    );
    const snapshot = manager.getSnapshot();

    expect(snapshot.totalCalls).toBe(7);
    expect(snapshot.byServer.github).toBe(7);
    manager.dispose();
  });

  it("renders usage report as markdown document", async () => {
    const manager = new UsageAnalyticsManager(
      daemon as unknown as DaemonClient,
      workspaceState,
      channel
    );
    daemon.emit({
      toolName: "tavily__search",
      server: "tavily",
      tool: "search",
      success: true,
      durationMs: 123,
      timestamp: "2026-02-26T15:30:00.000Z",
    });
    await Promise.resolve();

    await manager.showReport();

    expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
    const lastCall = vi.mocked(vscode.workspace.openTextDocument).mock.calls[
      vi.mocked(vscode.workspace.openTextDocument).mock.calls.length - 1
    ];
    const docOptions = lastCall?.[0] as { content?: unknown; language?: unknown } | undefined;
    expect(docOptions?.language).toBe("markdown");
    expect(typeof docOptions?.content).toBe("string");
    expect(docOptions?.content).toContain("# Loom Usage Analytics");
    expect(vscode.window.showTextDocument).toHaveBeenCalled();
    manager.dispose();
  });
});
