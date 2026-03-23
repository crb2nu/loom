/* eslint-disable import/order, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { PlatformCommandContext, registerPlatformCommands } from "./platforms";

function getRegisteredCommandHandler(command: string): (...args: unknown[]) => Promise<void> {
  const call = vi
    .mocked(vscode.commands.registerCommand)
    .mock.calls.find(([registered]) => registered === command);
  if (!call) {
    throw new Error(`Command not registered: ${command}`);
  }
  return call[1] as (...args: unknown[]) => Promise<void>;
}

describe("platform commands", () => {
  let ctx: PlatformCommandContext;
  let platformConfigClient: {
    getDoctorReport: ReturnType<typeof vi.fn>;
    fixDoctorIssues: ReturnType<typeof vi.fn>;
    checkAllSyncStatus: ReturnType<typeof vi.fn>;
  };
  let platformsProvider: {
    refresh: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.window.withProgress).mockImplementation(async (_options, task) =>
      task({ report: vi.fn() } as vscode.Progress<unknown>, {} as vscode.CancellationToken)
    );
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({
      uri: vscode.Uri.parse("untitled:doctor.md"),
      getText: () => "",
    } as vscode.TextDocument);

    platformConfigClient = {
      getDoctorReport: vi.fn(async () => ({
        ok: false,
        platforms: [
          {
            platform: "claude",
            hooks: "stale",
            perms: "ok",
            schema: "ok",
            status: "stale",
          },
        ],
      })),
      fixDoctorIssues: vi.fn(async () => ({
        output: "fixed",
        report: {
          ok: true,
          platforms: [
            {
              platform: "claude",
              hooks: "ok",
              perms: "ok",
              schema: "ok",
              status: "healthy",
            },
          ],
        },
      })),
      checkAllSyncStatus: vi.fn(async () => undefined),
    };

    platformsProvider = {
      refresh: vi.fn(),
    };

    ctx = {
      workspaceRoot: "/workspace",
      loomChannel: {
        name: "platform command tests",
        append: vi.fn(),
        appendLine: vi.fn(),
        clear: vi.fn(),
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
        replace: vi.fn(),
      } as unknown as vscode.OutputChannel,
      platformConfigClient:
        platformConfigClient as unknown as PlatformCommandContext["platformConfigClient"],
      platformsProvider:
        platformsProvider as unknown as PlatformCommandContext["platformsProvider"],
    };
  });

  it("registers the doctor fix command", () => {
    registerPlatformCommands(ctx);

    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      "loom.fixDoctorIssues",
      expect.any(Function)
    );
  });

  it("runs doctor fix, refreshes platforms, and opens the updated report", async () => {
    registerPlatformCommands(ctx);
    const handler = getRegisteredCommandHandler("loom.fixDoctorIssues");

    await handler();

    expect(platformConfigClient.fixDoctorIssues).toHaveBeenCalled();
    expect(platformsProvider.refresh).toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ language: "markdown" })
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Loom: doctor issues fixed successfully"
    );
  });
});
