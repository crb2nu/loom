import { execFile } from "child_process";
import { promisify } from "util";

import * as vscode from "vscode";

import { resolveHubWrapperCommand } from "../utils/binary";
import { Logger } from "../utils/logger";

import { CommandContext } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Register all hub-related commands.
 */
export function registerHubCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("loom.refreshHubStatus", () => refreshHubStatus(ctx)),
    vscode.commands.registerCommand("loom.verifyHubClient", () => verifyHubClient(ctx)),
  ];
}

async function refreshHubStatus(ctx: CommandContext): Promise<void> {
  const { hubStatusManager } = ctx;

  await hubStatusManager.refresh();
  const snapshot = hubStatusManager.getStatus();
  if (snapshot.error) {
    void vscode.window.showWarningMessage(
      `Loom: hub refresh completed with errors (${snapshot.error})`
    );
  } else {
    void vscode.window.showInformationMessage("Loom: hub status refreshed");
  }
}

async function verifyHubClient(ctx: CommandContext): Promise<void> {
  const { workspaceRoot, loomChannel } = ctx;

  const wrapperPath = resolveHubWrapperCommand(workspaceRoot);
  const logger = new Logger(loomChannel, "Hub");
  logger.info(`Checking hub client via ${wrapperPath || "mcp-hub-wrapper"}`);
  try {
    await execFileAsync(wrapperPath, ["--help"]);
    loomChannel.appendLine("✓ mcp-hub-wrapper responded to --help");
    loomChannel.show(true);
    void vscode.window.showInformationMessage("Loom: hub client detected");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    loomChannel.appendLine(`✗ Hub client check failed: ${message}`);
    loomChannel.show(true);
    void vscode.window.showErrorMessage(`Loom: hub client unavailable (${message})`);
  }
}
