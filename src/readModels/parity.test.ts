import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadVscodeConfigSnapshot = vi.hoisted(() => vi.fn());

vi.mock("../utils/config", () => ({
  loadVscodeConfigSnapshot: mockLoadVscodeConfigSnapshot,
}));

import { ParityReadModel } from "./parity";

describe("ParityReadModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports unavailable optional domains when agent context and usage analytics are missing", async () => {
    mockLoadVscodeConfigSnapshot.mockResolvedValueOnce({
      source: "/workspace/.vscode/mcp.json",
      serverNames: ["alpha"],
      hubRouted: ["alpha"],
      localRouted: [],
    });

    const readModel = new ParityReadModel({
      workspaceRoot: "/workspace",
      registryProvider: {
        getRegistrySnapshot: vi.fn(() =>
          Promise.resolve({
            servers: [{ name: "alpha" }],
          })
        ),
      } as never,
      hubStatusManager: {
        getStatus: vi.fn(() => ({
          health: { status: "ok", sessions: 2 },
          readiness: { ready: true },
          error: undefined,
          servers: [{ name: "alpha" }],
        })),
      } as never,
    });

    const snapshot = await readModel.collect();

    expect(snapshot.fleet.state).toBe("ready");
    expect(snapshot.health.state).toBe("ready");
    expect(snapshot.tasks.state).toBe("unavailable");
    expect(snapshot.memory.state).toBe("unavailable");
    expect(snapshot.stream.state).toBe("unavailable");
    expect(snapshot.presence.state).toBe("unavailable");
  });

  it("uses capability clients for tasks/memory/presence and stream", async () => {
    mockLoadVscodeConfigSnapshot.mockResolvedValueOnce({
      source: "/workspace/.vscode/mcp.json",
      serverNames: ["alpha"],
      hubRouted: ["alpha"],
      localRouted: [],
    });

    const readModel = new ParityReadModel({
      workspaceRoot: "/workspace",
      registryProvider: {
        getRegistrySnapshot: vi.fn(() =>
          Promise.resolve({
            servers: [{ name: "alpha" }],
          })
        ),
      } as never,
      hubStatusManager: {
        getStatus: vi.fn(() => ({
          health: { status: "ok", sessions: 2 },
          readiness: { ready: true },
          error: undefined,
          servers: [{ name: "alpha" }],
        })),
      } as never,
      daemonClient: {
        connectionState: "connected",
        getServers: vi.fn(() => Promise.resolve([{ name: "alpha", running: true }])),
      } as never,
      agentContextClient: {
        listTasks: vi.fn(() =>
          Promise.resolve([
            { status: "blocked", priority: "high" },
            { status: "in_progress", priority: "medium" },
          ])
        ),
        getMemoryTiers: vi.fn(() =>
          Promise.resolve([
            { tier: "working", entry_count: 2, total_tokens: 40 },
            { tier: "short_term", entry_count: 1, total_tokens: 30 },
            { tier: "long_term", entry_count: 0, total_tokens: 0 },
          ])
        ),
        listSessions: vi.fn(() =>
          Promise.resolve([{ session_id: "sess-1" }, { session_id: "sess-2" }])
        ),
      } as never,
      agentSessionManager: {
        getSessionId: vi.fn(() => "sess-1"),
      } as never,
      usageAnalyticsManager: {
        getSnapshot: vi.fn(() => ({
          totalCalls: 10,
          successCalls: 9,
          failureCalls: 1,
          byServer: { alpha: 8 },
          byTool: {},
          byHour: {},
          recent: [],
        })),
      } as never,
    });

    const snapshot = await readModel.collect();

    expect(snapshot.health.state).toBe("ready");
    expect(snapshot.tasks.state).toBe("ready");
    expect(snapshot.tasks.total).toBe(2);
    expect(snapshot.tasks.blocked).toBe(1);
    expect(snapshot.memory.state).toBe("ready");
    expect(snapshot.memory.totalEntries).toBe(3);
    expect(snapshot.memory.totalTokens).toBe(70);
    expect(snapshot.presence.state).toBe("ready");
    expect(snapshot.presence.activeSessions).toBe(2);
    expect(snapshot.stream.state).toBe("ready");
    expect(snapshot.stream.topServer).toBe("alpha");
  });
});
