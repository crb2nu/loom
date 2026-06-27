/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await, @typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";

import { DaemonClient } from "../clients/daemon";
import { DaemonToolInfo } from "../types";

import { ServerMetricsManager } from "./serverMetrics";

describe("ServerMetricsManager", () => {
  let manager: ServerMetricsManager;
  let daemonServers: Array<{ name: string; running: boolean }>;
  let daemonTools: DaemonToolInfo[];
  let hubServers: Array<{ name: string }>;
  let hubHealthStatus: "ok" | "error";

  let mockDaemonClient: DaemonClient;
  let mockHubStatusManager: { getStatus: ReturnType<typeof vi.fn> };
  let mockChannel: vscode.OutputChannel;

  const resetToolFetchCache = () => {
    // Reset private cache clock so refreshToolCounts executes during test assertions.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).lastToolFetch = null;
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    daemonServers = [];
    daemonTools = [];
    hubServers = [];
    hubHealthStatus = "ok";

    mockDaemonClient = {
      getServers: vi.fn(async () => daemonServers),
      getTools: vi.fn(async () => daemonTools),
    } as unknown as DaemonClient;

    mockHubStatusManager = {
      getStatus: vi.fn(() => ({
        servers: hubServers,
        health: { status: hubHealthStatus },
      })),
    };

    mockChannel = {
      name: "Server Metrics tests",
      append: vi.fn(),
      appendLine: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      replace: vi.fn(),
    };

    manager = new ServerMetricsManager(
      mockDaemonClient,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockHubStatusManager as any,
      mockChannel,
      60000
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    manager.stopCollection();
    vi.mocked(mockDaemonClient.getServers).mockClear();
    vi.mocked(mockDaemonClient.getTools).mockClear();
  });

  afterEach(() => {
    manager.dispose();
  });

  it("collects metrics for daemon and hub-only servers", async () => {
    daemonServers = [
      { name: "shared", running: true },
      { name: "offline-service", running: false },
    ];
    hubServers = [{ name: "shared" }, { name: "hub-only" }];
    daemonTools = [
      { name: "tool-a", server: "shared", serverPrefix: "shared" },
      { name: "tool-b", server: "shared", serverPrefix: "shared" },
      { name: "tool-c", server: "hub-only", serverPrefix: "hub-only" },
    ];
    resetToolFetchCache();

    await manager.collectMetrics();

    const shared = manager.getServerMetrics("shared");
    const offline = manager.getServerMetrics("offline-service");
    const hubOnly = manager.getServerMetrics("hub-only");

    expect(shared?.status).toBe("online");
    expect(shared?.isHubRouted).toBe(true);
    expect(manager.getToolCount("shared")).toBe(2);

    expect(offline?.status).toBe("offline");
    expect(manager.getErrorCount("offline-service")).toBe(1);

    expect(hubOnly?.status).toBe("online");
    expect(hubOnly?.isHubRouted).toBe(true);
    expect(manager.getToolCount("hub-only")).toBe(1);
  });

  it("decays error count when a server recovers", async () => {
    daemonServers = [{ name: "svc", running: false }];
    await manager.collectMetrics();
    expect(manager.getErrorCount("svc")).toBe(1);

    daemonServers = [{ name: "svc", running: true }];
    await manager.collectMetrics();
    expect(manager.getErrorCount("svc")).toBe(0);
  });

  it("caches tool counts for repeated collections", async () => {
    daemonServers = [{ name: "svc", running: true }];
    daemonTools = [{ name: "tool-1", server: "svc", serverPrefix: "svc" }];
    resetToolFetchCache();

    await manager.collectMetrics();
    await manager.collectMetrics();

    expect(mockDaemonClient.getTools).toHaveBeenCalledTimes(1);
  });

  it("fires metrics change events after collection", async () => {
    daemonServers = [{ name: "svc", running: true }];
    const listener = vi.fn();
    manager.onDidChangeMetrics(listener);

    await manager.collectMetrics();

    expect(listener).toHaveBeenCalled();
  });

  it("returns metrics when pinging daemon and hub servers", async () => {
    daemonServers = [{ name: "daemon-only", running: true }];
    hubServers = [{ name: "hub-only" }];

    const daemonPing = await manager.pingServer("daemon-only");
    expect(daemonPing?.status).toBe("online");
    expect(daemonPing?.isHubRouted).toBe(false);

    const hubPing = await manager.pingServer("hub-only");
    expect(hubPing?.status).toBe("online");
    expect(hubPing?.isHubRouted).toBe(true);

    const missingPing = await manager.pingServer("missing");
    expect(missingPing).toBeUndefined();
  });

  it("records ping errors when daemon query throws", async () => {
    vi.mocked(mockDaemonClient.getServers).mockRejectedValueOnce(new Error("daemon failed"));
    await expect(manager.pingServer("broken-service")).resolves.toBeUndefined();
    expect(manager.getErrorCount("broken-service")).toBe(1);
  });

  it("caps history to max sample window", async () => {
    daemonServers = [{ name: "svc", running: true }];

    for (let i = 0; i < 35; i++) {
      await manager.collectMetrics();
    }

    const history = manager.getServerHistory("svc");
    expect(history).toBeDefined();
    expect(history?.samples.length).toBe(30);
  });

  it("updates interval configuration and restarts collection", () => {
    const startSpy = vi.spyOn(manager, "startCollection");
    manager.setInterval(1000);
    expect(startSpy).toHaveBeenCalledTimes(1);
    startSpy.mockRestore();
  });

  it("handles collection failures without throwing", async () => {
    vi.mocked(mockDaemonClient.getServers).mockRejectedValueOnce(new Error("network"));
    await expect(manager.collectMetrics()).resolves.toBeUndefined();
  });

  it("exposes immutable copies of metrics and history maps", async () => {
    daemonServers = [{ name: "svc", running: true }];
    await manager.collectMetrics();

    const metricsCopy = manager.getMetrics();
    const historyCopy = manager.getAllHistory();

    metricsCopy.clear();
    historyCopy.clear();

    expect(manager.getServerMetrics("svc")).toBeDefined();
    expect(manager.getServerHistory("svc")).toBeDefined();
  });
});
