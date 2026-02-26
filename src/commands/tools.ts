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
 * Register all tools-related commands.
 */
export function registerToolsCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("loom.refreshTools", () => refreshTools(ctx)),
    vscode.commands.registerCommand("loom.searchTools", () => searchTools(ctx)),
    vscode.commands.registerCommand("loom.showUsageAnalytics", () => showUsageAnalytics(ctx)),
  ];
}

async function refreshTools(ctx: CommandContext): Promise<void> {
  const { workspaceRoot, loomChannel, toolProvider } = ctx;
  const loomBinary = resolveLoomBinary(workspaceRoot);

  const logger = new Logger(loomChannel, "Tools");
  logger.info("Refreshing tool list...");
  loomChannel.appendLine(`→ ${loomBinary} tools list`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Refreshing Loom tools",
    },
    async () => {
      try {
        const { stdout, stderr } = await execFileAsync(loomBinary, ["tools", "list"], {
          cwd: workspaceRoot || os.homedir(),
          timeout: 30000,
        });

        loomChannel.clear();
        logger.info("Available Tools");
        loomChannel.appendLine("─".repeat(60));
        if (stdout) {
          loomChannel.append(stdout);
        }
        if (stderr) {
          loomChannel.append(stderr);
        }
        loomChannel.show(true);

        // Refresh the tool tree view
        toolProvider.refresh();

        // Count tools from output
        const toolCount =
          (stdout?.match(/^[a-z0-9_-]+__/gm) || []).length ||
          stdout?.split("\n").filter((line: string) => line.trim()).length ||
          0;
        void vscode.window.showInformationMessage(`Loom: ${toolCount} tools available`);
      } catch (error) {
        const execError = error as ExecError;
        if (execError.stdout) {
          loomChannel.append(execError.stdout);
        }
        if (execError.stderr) {
          loomChannel.append(execError.stderr);
        }
        loomChannel.appendLine(`✗ ${execError.message ?? "Failed to list tools"}`);
        loomChannel.show(true);
        await showActionableError(error, "Failed to list tools");
      }
    }
  );
}

async function searchTools(ctx: CommandContext): Promise<void> {
  const { workspaceRoot, loomChannel, toolProvider } = ctx;

  const query = await vscode.window.showInputBox({
    prompt: "Search tools by name or description",
    placeHolder: "e.g., git, kubernetes, search",
    value: "",
  });

  if (query === undefined) {
    return; // User cancelled
  }

  if (query === "") {
    // Clear filter
    toolProvider.clearFilter();
    void vscode.window.showInformationMessage("Loom: Tool filter cleared");
    return;
  }

  // Apply filter to tool tree view
  toolProvider.setFilter(query);

  // Also run CLI search and show in output channel
  const loomBinary = resolveLoomBinary(workspaceRoot);
  const logger = new Logger(loomChannel, "Tools");
  logger.info(`Searching tools for: ${query}`);
  loomChannel.appendLine(`→ ${loomBinary} tools search ${query}`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Searching tools for "${query}"`,
    },
    async () => {
      try {
        const { stdout, stderr } = await execFileAsync(loomBinary, ["tools", "search", query], {
          cwd: workspaceRoot || os.homedir(),
          timeout: 30000,
        });

        loomChannel.clear();
        logger.info(`Search Results: "${query}"`);
        loomChannel.appendLine("─".repeat(60));
        if (stdout) {
          loomChannel.append(stdout);
        }
        if (stderr) {
          loomChannel.append(stderr);
        }
        loomChannel.show(true);

        // Count results
        const matchCount = stdout?.split("\n").filter((line: string) => line.trim()).length || 0;
        void vscode.window.showInformationMessage(
          `Loom: ${matchCount} tools match "${query}" (filter applied to tree view)`
        );
      } catch (error) {
        const execError = error as ExecError;
        if (execError.stdout) {
          loomChannel.append(execError.stdout);
        }
        if (execError.stderr) {
          loomChannel.append(execError.stderr);
        }
        loomChannel.appendLine(`✗ ${execError.message ?? "Failed to search tools"}`);
        loomChannel.show(true);
        await showActionableError(error, "Failed to search tools");
      }
    }
  );
}

async function showUsageAnalytics(ctx: CommandContext): Promise<void> {
  await ctx.usageAnalyticsManager.showReport();
}
