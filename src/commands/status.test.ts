/* eslint-disable import/order, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

const mockLoadVscodeConfigSnapshot = vi.hoisted(() => vi.fn());

vi.mock("../utils/config", () => ({
  loadVscodeConfigSnapshot: mockLoadVscodeConfigSnapshot,
}));

import { CommandContext } from "./types";
import { registerStatusCommands } from "./status";

function getRegisteredCommandHandler(command: string): () => Promise<void> {
  const call = vi
    .mocked(vscode.commands.registerCommand)
    .mock.calls.find(([registered]) => registered === command);
  if (!call) {
    throw new Error(`Command not registered: ${command}`);
  }
  return call[1] as () => Promise<void>;
}

describe("status commands", () => {
  let ctx: CommandContext;
  let loomChannel: vscode.OutputChannel;
  let mockRegistryProvider: {
    getSummary: ReturnType<typeof vi.fn>;
    getRegistrySnapshot: ReturnType<typeof vi.fn>;
  };
  let mockHubStatusManager: {
    getStatus: ReturnType<typeof vi.fn>;
    getSettings: ReturnType<typeof vi.fn>;
  };
  let mockPanel: {
    reveal: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    onDidDispose: ReturnType<typeof vi.fn>;
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    webview: {
      html: string;
      cspSource: string;
      postMessage: ReturnType<typeof vi.fn>;
      onDidReceiveMessage: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    loomChannel = {
      name: "Status tests",
      append: vi.fn(),
      appendLine: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      replace: vi.fn(),
    } as unknown as vscode.OutputChannel;

    mockRegistryProvider = {
      getSummary: vi.fn(async () => "Loom summary"),
      getRegistrySnapshot: vi.fn(async () => ({
        servers: [{ name: "alpha" }, { name: "beta" }],
      })),
    };

    mockHubStatusManager = {
      getStatus: vi.fn(() => ({
        health: { status: "ok", sessions: 4 },
        readiness: { ready: true },
        error: undefined,
        servers: [{ name: "alpha" }, { name: "hub-only" }],
      })),
      getSettings: vi.fn(() => ({
        hubUrl: "wss://mcp.example.com/ws",
        profile: "codex",
      })),
    };

    mockLoadVscodeConfigSnapshot.mockResolvedValue({
      source: "/workspace/.vscode/mcp.json",
      serverNames: ["alpha", "config-only"],
      hubRouted: ["alpha"],
      localRouted: ["config-only"],
    });

    mockPanel = {
      reveal: vi.fn(),
      postMessage: vi.fn(),
      onDidDispose: vi.fn(),
      onDidReceiveMessage: vi.fn(),
      dispose: vi.fn(),
      webview: {
        html: "",
        cspSource: "vscode-resource:",
        postMessage: vi.fn(() => Promise.resolve(true)),
        onDidReceiveMessage: vi.fn(),
      },
    };
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mockPanel as never);

    ctx = {
      workspaceRoot: "/workspace",
      pythonExecutable: "python3",
      loomChannel,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hubStatusManager: mockHubStatusManager as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registryProvider: mockRegistryProvider as any,
      daemonClient: {
        connectionState: "connected",
        getServers: vi.fn(() => Promise.resolve([{ name: "alpha", running: true }])),
      } as any,
      serverProvider: {} as any,
      toolProvider: {} as any,
      secretsProvider: {} as any,
      usageAnalyticsManager: {
        getSnapshot: vi.fn(() => ({
          totalCalls: 10,
          successCalls: 8,
          failureCalls: 2,
          byServer: { alpha: 8 },
          byTool: {},
          byHour: {},
          recent: [],
        })),
      } as any,
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
            { tier: "short_term", entry_count: 1, total_tokens: 20 },
          ])
        ),
        listSessions: vi.fn(() =>
          Promise.resolve([{ session_id: "sess-1" }, { session_id: "sess-2" }])
        ),
      } as any,
      agentSessionManager: {
        getSessionId: vi.fn(() => "sess-1"),
      } as any,
      remoteTunnelManager: {} as any,
      configSyncManager: {} as any,
      extensionContext: {
        extensionUri: vscode.Uri.file("/extension"),
      } as any,
    } as unknown as CommandContext;
  });

  it("registers showStatus and showMeshReport commands", () => {
    const disposables = registerStatusCommands(ctx);
    expect(disposables).toHaveLength(2);
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      "loom.showStatus",
      expect.any(Function)
    );
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      "loom.showMeshReport",
      expect.any(Function)
    );
  });

  it("shows summary message for loom.showStatus", async () => {
    registerStatusCommands(ctx);
    const handler = getRegisteredCommandHandler("loom.showStatus");

    await handler();

    expect(mockRegistryProvider.getSummary).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Loom summary");
  });

  it("shows an error when workspace root is missing for mesh report", async () => {
    ctx.workspaceRoot = "";
    registerStatusCommands(ctx);
    const handler = getRegisteredCommandHandler("loom.showMeshReport");

    await handler();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Loom: workspace folder not detected."
    );
  });

  it("opens the parity overview panel with a mesh snapshot", async () => {
    registerStatusCommands(ctx);
    const handler = getRegisteredCommandHandler("loom.showMeshReport");

    await handler();

    expect(mockRegistryProvider.getRegistrySnapshot).toHaveBeenCalled();
    expect(mockLoadVscodeConfigSnapshot).toHaveBeenCalledWith("/workspace");
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      "loomParityOverview",
      "Loom Overview",
      expect.anything(),
      expect.objectContaining({
        enableScripts: true,
      })
    );
    expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "updateSnapshot",
        data: expect.objectContaining({
          summary: {
            ready: 6,
            degraded: 0,
            unavailable: 0,
            attention: [],
          },
          fleet: expect.objectContaining({
            registryCount: 2,
            missingFromHub: ["beta"],
            missingFromConfig: ["beta"],
            hubOnly: ["hub-only"],
            configOnly: ["config-only"],
            localRouted: ["config-only"],
          }),
          health: expect.objectContaining({
            hubStatus: "ok",
            daemonRunningCount: 1,
          }),
        }),
      })
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Loom: overview ready");
  });
});
