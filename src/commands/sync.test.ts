/* eslint-disable import/order, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

const mockExecFileAsync = vi.hoisted(() => vi.fn());
const mockAccess = vi.hoisted(() => vi.fn());
const mockGetEnabledPlatforms = vi.hoisted(() => vi.fn(() => ["vscode"]));

vi.mock("util", () => ({
  promisify: vi.fn(() => mockExecFileAsync),
}));

vi.mock("fs", () => ({
  promises: {
    access: mockAccess,
    mkdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    copyFile: vi.fn(),
  },
}));

vi.mock("../utils/binary", () => ({
  resolveLoomBinary: vi.fn(() => "/usr/local/bin/loom"),
}));

vi.mock("../utils/helpers", () => ({
  formatSyncStatus: vi.fn(() => "Synced"),
  getStatusIcon: vi.fn(() => "check"),
}));

vi.mock("../utils/platform", () => ({
  getEnabledPlatforms: mockGetEnabledPlatforms,
}));

vi.mock("../utils/secrets", () => ({
  isPlaceholder: vi.fn(() => false),
  resolvePlaceholder: vi.fn(async (value: string) => value),
}));

import { CommandContext } from "./types";
import { registerSyncCommands } from "./sync";

function getRegisteredCommandHandler(command: string): () => Promise<void> {
  const call = vi
    .mocked(vscode.commands.registerCommand)
    .mock.calls.find(([registered]) => registered === command);
  if (!call) {
    throw new Error(`Command not registered: ${command}`);
  }
  return call[1] as () => Promise<void>;
}

describe("sync commands", () => {
  let ctx: CommandContext;
  let loomChannel: vscode.OutputChannel;
  let resolveSync: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveSync = undefined;
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    vi.mocked(vscode.window.withProgress).mockImplementation(async (_options, task) =>
      task({ report: vi.fn() } as vscode.Progress<unknown>, {} as vscode.CancellationToken)
    );

    loomChannel = {
      name: "Sync tests",
      append: vi.fn(),
      appendLine: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      replace: vi.fn(),
    } as unknown as vscode.OutputChannel;

    ctx = {
      workspaceRoot: "/workspace",
      pythonExecutable: "/usr/bin/python3",
      loomChannel,
      hubStatusManager: {
        getSettings: vi.fn(() => ({ hubUrl: "https://hub.example" })),
      } as unknown as CommandContext["hubStatusManager"],
      configSyncManager: {
        getOfflineState: vi.fn(() => ({ mode: "online", pendingSyncs: [] })),
        getPendingSyncsCount: vi.fn(() => 0),
        queuePendingSync: vi.fn(),
        checkSync: vi.fn(async () => undefined),
        setOfflineMode: vi.fn(),
      } as unknown as CommandContext["configSyncManager"],
      registryProvider: {
        refresh: vi.fn(),
      } as unknown as CommandContext["registryProvider"],
      serverProvider: {
        refresh: vi.fn(),
      } as unknown as CommandContext["serverProvider"],
    } as unknown as CommandContext;
  });

  it("deduplicates concurrent sync runs", async () => {
    mockExecFileAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSync = () => resolve({ stdout: "", stderr: "" });
        })
    );

    registerSyncCommands(ctx);
    const handler = getRegisteredCommandHandler("loom.syncConfigs");

    const firstRun = handler();
    const secondRun = handler();

    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);

    resolveSync?.();
    await Promise.all([firstRun, secondRun]);

    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Loom: synced MCP configs for all profiles"
    );
  });
});
