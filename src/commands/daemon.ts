import { execFile } from "child_process";
import * as os from "os";
import { promisify } from "util";

import * as vscode from "vscode";

import { resolveLoomBinary } from "../utils/binary";
import { showActionableError } from "../utils/errors";
import { Logger } from "../utils/logger";

import { CommandContext, ExecError } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Register all daemon-related commands.
 */
export function registerDaemonCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("loom.startDaemon", () => startDaemon(ctx)),
    vscode.commands.registerCommand("loom.stopDaemon", () => stopDaemon(ctx)),
    vscode.commands.registerCommand("loom.restartDaemon", () => restartDaemon(ctx)),
    vscode.commands.registerCommand("loom.daemonStatus", () => daemonStatus(ctx)),
  ];
}

async function startDaemon(ctx: CommandContext): Promise<void> {
  const { workspaceRoot, loomChannel, hubStatusManager, serverProvider } = ctx;
  const loomBinary = resolveLoomBinary(workspaceRoot);

  const logger = new Logger(loomChannel, "Daemon");
  logger.info("Starting loom daemon...");
  loomChannel.appendLine(`→ ${loomBinary} daemon start`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Starting Loom daemon",
    },
    async () => {
      try {
        const { stdout, stderr } = await execFileAsync(loomBinary, ["daemon", "start"], {
          cwd: workspaceRoot || os.homedir(),
          timeout: 10000,
        });
        if (stdout) {
          loomChannel.append(stdout);
        }
        if (stderr) {
          loomChannel.append(stderr);
        }
        loomChannel.appendLine("✓ Daemon started");
        loomChannel.show(true);
        void vscode.window.showInformationMessage("Loom: daemon started successfully");
        // Refresh hub status and server list after daemon starts
        await hubStatusManager.refresh();
        serverProvider.refresh();
      } catch (error) {
        const execError = error as ExecError;
        if (execError.stdout) {
          loomChannel.append(execError.stdout);
        }
        if (execError.stderr) {
          loomChannel.append(execError.stderr);
        }
        loomChannel.appendLine(`✗ ${execError.message ?? "Failed to start daemon"}`);
        loomChannel.show(true);
        await showActionableError(error, "Failed to start daemon");
      }
    }
  );
}

async function stopDaemon(ctx: CommandContext): Promise<void> {
  const { workspaceRoot, loomChannel, serverProvider } = ctx;
  const loomBinary = resolveLoomBinary(workspaceRoot);

  const logger = new Logger(loomChannel, "Daemon");
  logger.info("Stopping loom daemon...");
  loomChannel.appendLine(`→ ${loomBinary} daemon stop`);

  try {
    const { stdout, stderr } = await execFileAsync(loomBinary, ["daemon", "stop"], {
      cwd: workspaceRoot || os.homedir(),
      timeout: 5000,
    });
    if (stdout) {
      loomChannel.append(stdout);
    }
    if (stderr) {
      loomChannel.append(stderr);
    }
    loomChannel.appendLine("✓ Daemon stopped");
    loomChannel.show(true);
    void vscode.window.showInformationMessage("Loom: daemon stopped");
    serverProvider.refresh();
  } catch (error) {
    const execError = error as ExecError;
    if (execError.stdout) {
      loomChannel.append(execError.stdout);
    }
    if (execError.stderr) {
      loomChannel.append(execError.stderr);
    }
    loomChannel.appendLine(`✗ ${execError.message ?? "Failed to stop daemon"}`);
    loomChannel.show(true);
    await showActionableError(error, "Failed to stop daemon");
    serverProvider.refresh();
  }
}

async function restartDaemon(ctx: CommandContext): Promise<void> {
  const { workspaceRoot, loomChannel, hubStatusManager, serverProvider } = ctx;
  const loomBinary = resolveLoomBinary(workspaceRoot);

  const logger = new Logger(loomChannel, "Daemon");
  logger.info("Restarting loom daemon...");

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Restarting Loom daemon",
    },
    async () => {
      try {
        // Stop first
        loomChannel.appendLine(`→ ${loomBinary} daemon stop`);
        try {
          await execFileAsync(loomBinary, ["daemon", "stop"], {
            cwd: workspaceRoot || os.homedir(),
            timeout: 5000,
          });
          loomChannel.appendLine("✓ Daemon stopped");
        } catch {
          loomChannel.appendLine("⚠ Daemon was not running");
        }

        // Wait a moment for cleanup
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Start
        loomChannel.appendLine(`→ ${loomBinary} daemon start`);
        const { stdout, stderr } = await execFileAsync(loomBinary, ["daemon", "start"], {
          cwd: workspaceRoot || os.homedir(),
          timeout: 10000,
        });
        if (stdout) {
          loomChannel.append(stdout);
        }
        if (stderr) {
          loomChannel.append(stderr);
        }
        loomChannel.appendLine("✓ Daemon restarted");
        loomChannel.show(true);
        void vscode.window.showInformationMessage("Loom: daemon restarted successfully");
        // Refresh hub status and server list after restart
        await hubStatusManager.refresh();
        serverProvider.refresh();
      } catch (error) {
        const execError = error as ExecError;
        if (execError.stdout) {
          loomChannel.append(execError.stdout);
        }
        if (execError.stderr) {
          loomChannel.append(execError.stderr);
        }
        loomChannel.appendLine(`✗ ${execError.message ?? "Failed to restart daemon"}`);
        loomChannel.show(true);
        await showActionableError(error, "Failed to restart daemon");
      }
    }
  );
}

async function daemonStatus(ctx: CommandContext): Promise<void> {
  const { workspaceRoot, loomChannel } = ctx;
  const loomBinary = resolveLoomBinary(workspaceRoot);

  const logger = new Logger(loomChannel, "Daemon");
  logger.info("Checking daemon status...");
  loomChannel.appendLine(`→ ${loomBinary} daemon status`);

  try {
    const { stdout, stderr } = await execFileAsync(loomBinary, ["daemon", "status"], {
      cwd: workspaceRoot || os.homedir(),
      timeout: 5000,
    });

    loomChannel.clear();
    logger.info("Daemon Status");
    loomChannel.appendLine("─".repeat(40));
    if (stdout) {
      loomChannel.append(stdout);
    }
    if (stderr) {
      loomChannel.append(stderr);
    }
    loomChannel.show(true);

    // Parse status to show in notification
    const isRunning =
      stdout?.toLowerCase().includes("running") ||
      stdout?.toLowerCase().includes("active") ||
      stdout?.toLowerCase().includes("pid");
    const statusMessage = isRunning ? "Daemon is running" : "Daemon status retrieved";
    void vscode.window.showInformationMessage(`Loom: ${statusMessage}`);
  } catch (error) {
    const execError = error as ExecError & { code?: number };
    loomChannel.clear();
    logger.info("Daemon Status");
    loomChannel.appendLine("─".repeat(40));
    if (execError.stdout) {
      loomChannel.append(execError.stdout);
    }
    if (execError.stderr) {
      loomChannel.append(execError.stderr);
    }
    loomChannel.show(true);

    // Exit code 1 often means daemon is not running, which is informational
    if (execError.code === 1) {
      void vscode.window.showInformationMessage("Loom: daemon is not running");
    } else {
      void vscode.window.showErrorMessage(
        `Loom: ${execError.message ?? "Failed to get daemon status"}`
      );
    }
  }
}
