/* eslint-disable import/order, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/unbound-method */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

const mockResolveLoomBinary = vi.hoisted(() => vi.fn(() => "/usr/local/bin/loom"));
const mockShowActionableError = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../utils/binary", () => ({
  resolveLoomBinary: mockResolveLoomBinary,
}));

vi.mock("../utils/errors", () => ({
  showActionableError: mockShowActionableError,
}));

import { registerToolsCommands } from "./tools";
import { CommandContext } from "./types";

function getRegisteredCommandHandler(command: string): () => Promise<void> {
  const call = vi
    .mocked(vscode.commands.registerCommand)
    .mock.calls.find(([registered]) => registered === command);
  if (!call) {
    throw new Error(`Command not registered: ${command}`);
  }
  return call[1] as () => Promise<void>;
}

describe("tools commands", () => {
  let ctx: CommandContext;
  let loomChannel: vscode.OutputChannel;
  let mockDaemonClient: {
    getTools: ReturnType<typeof vi.fn>;
  };
  let mockToolProvider: {
    refresh: ReturnType<typeof vi.fn>;
    setFilter: ReturnType<typeof vi.fn>;
    clearFilter: ReturnType<typeof vi.fn>;
  };
  let mockUsageAnalyticsManager: {
    showReport: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    loomChannel = {
      name: "Tools tests",
      append: vi.fn(),
      appendLine: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      replace: vi.fn(),
    } as unknown as vscode.OutputChannel;

    mockDaemonClient = {
      getTools: vi.fn(async () => [
        { name: "zeta__ping", server: "zeta", description: "Ping endpoint" },
        { name: "alpha__search", server: "alpha", description: "Search endpoint" },
      ]),
    };
    mockToolProvider = {
      refresh: vi.fn(),
      setFilter: vi.fn(),
      clearFilter: vi.fn(),
    };
    mockUsageAnalyticsManager = {
      showReport: vi.fn(async () => undefined),
    };

    ctx = {
      workspaceRoot: "/workspace",
      loomChannel,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      daemonClient: mockDaemonClient as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolProvider: mockToolProvider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      usageAnalyticsManager: mockUsageAnalyticsManager as any,
    } as unknown as CommandContext;
  });

  it("registers refresh, search, and usage analytics commands", () => {
    const disposables = registerToolsCommands(ctx);
    expect(disposables).toHaveLength(3);
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      "loom.refreshTools",
      expect.any(Function)
    );
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      "loom.searchTools",
      expect.any(Function)
    );
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      "loom.showUsageAnalytics",
      expect.any(Function)
    );
  });

  it("refreshes tools using DaemonClient contract path and reports count", async () => {
    registerToolsCommands(ctx);
    const handler = getRegisteredCommandHandler("loom.refreshTools");

    await handler();

    expect(mockResolveLoomBinary).toHaveBeenCalledWith("/workspace");
    expect(mockDaemonClient.getTools).toHaveBeenCalledWith(true);
    expect(loomChannel.appendLine).toHaveBeenCalledWith("alpha__search Search endpoint");
    expect(loomChannel.appendLine).toHaveBeenCalledWith("zeta__ping Ping endpoint");
    expect(mockToolProvider.refresh).toHaveBeenCalledWith(false);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Loom: 2 tools available");
  });

  it("shows actionable error when tool refresh fails", async () => {
    const failure = Object.assign(new Error("listing failed"), {
      stdout: "stdout-output",
      stderr: "stderr-output",
    });
    mockDaemonClient.getTools.mockRejectedValueOnce(failure);

    registerToolsCommands(ctx);
    const handler = getRegisteredCommandHandler("loom.refreshTools");

    await handler();

    expect(loomChannel.append).toHaveBeenCalledWith("stdout-output");
    expect(loomChannel.append).toHaveBeenCalledWith("stderr-output");
    expect(loomChannel.appendLine).toHaveBeenCalledWith("✗ listing failed");
    expect(loomChannel.show).toHaveBeenCalledWith(true);
    expect(mockShowActionableError).toHaveBeenCalledWith(failure, "Failed to list tools");
  });
});
