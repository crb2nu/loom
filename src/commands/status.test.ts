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

    ctx = {
      workspaceRoot: "/workspace",
      loomChannel,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hubStatusManager: mockHubStatusManager as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registryProvider: mockRegistryProvider as any,
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

  it("writes a full mesh report with gap diagnostics", async () => {
    registerStatusCommands(ctx);
    const handler = getRegisteredCommandHandler("loom.showMeshReport");

    await handler();

    expect(mockRegistryProvider.getRegistrySnapshot).toHaveBeenCalled();
    expect(mockLoadVscodeConfigSnapshot).toHaveBeenCalledWith("/workspace");
    expect(loomChannel.clear).toHaveBeenCalled();
    expect(loomChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Hub status: ok"));
    expect(loomChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("Registry servers: 2")
    );
    expect(loomChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("Registry → hub gaps: beta")
    );
    expect(loomChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("Registry → VS Code gaps: beta")
    );
    expect(loomChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("Hub-only servers: hub-only")
    );
    expect(loomChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("VS Code-only servers: config-only")
    );
    expect(loomChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("Local-mode servers: config-only")
    );
    expect(loomChannel.appendLine).toHaveBeenCalledWith("Domain readiness:");
    expect(loomChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("- Fleet:"));
    expect(loomChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("- Health:"));
    expect(loomChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("- Tasks:"));
    expect(loomChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("- Memory:"));
    expect(loomChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("- Stream:"));
    expect(loomChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("- Presence:"));
    expect(loomChannel.show).toHaveBeenCalledWith(true);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Loom: mesh report ready");
  });

  it("handles mesh report when registry and config are missing", async () => {
    mockRegistryProvider.getRegistrySnapshot.mockResolvedValueOnce(null);
    mockLoadVscodeConfigSnapshot.mockResolvedValueOnce(null);
    registerStatusCommands(ctx);
    const handler = getRegisteredCommandHandler("loom.showMeshReport");

    await handler();

    expect(loomChannel.appendLine).toHaveBeenCalledWith("Registry: registry.yaml not found");
    expect(loomChannel.appendLine).toHaveBeenCalledWith(
      "VS Code config: not found (run sync to generate)"
    );
  });

  it("reports no registry-to-hub/config gaps when sets are aligned", async () => {
    mockRegistryProvider.getRegistrySnapshot.mockResolvedValueOnce({
      servers: [{ name: "alpha" }],
    });
    mockHubStatusManager.getStatus.mockReturnValueOnce({
      health: { status: "ok", sessions: 1 },
      readiness: { ready: true },
      error: undefined,
      servers: [{ name: "alpha" }],
    });
    mockLoadVscodeConfigSnapshot.mockResolvedValueOnce({
      source: "/workspace/.vscode/mcp.json",
      serverNames: ["alpha"],
      hubRouted: ["alpha"],
      localRouted: [],
    });

    registerStatusCommands(ctx);
    const handler = getRegisteredCommandHandler("loom.showMeshReport");
    await handler();

    expect(loomChannel.appendLine).toHaveBeenCalledWith("Registry → hub gaps: none");
    expect(loomChannel.appendLine).toHaveBeenCalledWith("Registry → VS Code gaps: none");
  });
});
