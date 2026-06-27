/* eslint-disable import/order, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

const mockExecFileAsync = vi.hoisted(() => vi.fn());
const mockResolveHubWrapperCommand = vi.hoisted(() =>
  vi.fn(() => "/usr/local/bin/mcp-hub-wrapper")
);

vi.mock("util", () => ({
  promisify: vi.fn(() => mockExecFileAsync),
}));

vi.mock("../utils/binary", () => ({
  resolveHubWrapperCommand: mockResolveHubWrapperCommand,
}));

import { CommandContext } from "./types";
import { registerHubCommands } from "./hub";

function getRegisteredCommandHandler(command: string): () => Promise<void> {
  const call = vi
    .mocked(vscode.commands.registerCommand)
    .mock.calls.find(([registered]) => registered === command);
  if (!call) {
    throw new Error(`Command not registered: ${command}`);
  }
  return call[1] as () => Promise<void>;
}

describe("hub commands", () => {
  let ctx: CommandContext;
  let loomChannel: vscode.OutputChannel;
  let mockHubStatusManager: {
    refresh: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    loomChannel = {
      name: "Hub tests",
      append: vi.fn(),
      appendLine: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      replace: vi.fn(),
    };

    mockHubStatusManager = {
      refresh: vi.fn(async () => undefined),
      getStatus: vi.fn(() => ({ error: undefined })),
    };

    ctx = {
      workspaceRoot: "/workspace",
      loomChannel,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hubStatusManager: mockHubStatusManager as any,
    } as unknown as CommandContext;
  });

  it("registers refresh and verify hub commands", () => {
    const disposables = registerHubCommands(ctx);
    expect(disposables).toHaveLength(2);
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      "loom.refreshHubStatus",
      expect.any(Function)
    );
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      "loom.verifyHubClient",
      expect.any(Function)
    );
  });

  it("shows info message when hub refresh succeeds", async () => {
    registerHubCommands(ctx);
    const handler = getRegisteredCommandHandler("loom.refreshHubStatus");

    await handler();

    expect(mockHubStatusManager.refresh).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Loom: hub status refreshed");
  });

  it("shows warning message when hub refresh reports an error", async () => {
    mockHubStatusManager.getStatus.mockReturnValueOnce({ error: "timeout" });
    registerHubCommands(ctx);
    const handler = getRegisteredCommandHandler("loom.refreshHubStatus");

    await handler();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      "Loom: hub refresh completed with errors (timeout)"
    );
  });

  it("verifies hub client successfully", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });
    registerHubCommands(ctx);
    const handler = getRegisteredCommandHandler("loom.verifyHubClient");

    await handler();

    expect(mockResolveHubWrapperCommand).toHaveBeenCalledWith("/workspace");
    expect(mockExecFileAsync).toHaveBeenCalledWith("/usr/local/bin/mcp-hub-wrapper", ["--help"]);
    expect(loomChannel.appendLine).toHaveBeenCalledWith("✓ mcp-hub-wrapper responded to --help");
    expect(loomChannel.show).toHaveBeenCalledWith(true);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Loom: hub client detected");
  });

  it("reports hub client verification failures", async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error("executable not found"));
    registerHubCommands(ctx);
    const handler = getRegisteredCommandHandler("loom.verifyHubClient");

    await handler();

    expect(loomChannel.appendLine).toHaveBeenCalledWith(
      "✗ Hub client check failed: executable not found"
    );
    expect(loomChannel.show).toHaveBeenCalledWith(true);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Loom: hub client unavailable (executable not found)"
    );
  });
});
