import { execFile } from "child_process";
import * as os from "os";
import { promisify } from "util";

import * as vscode from "vscode";

import { resolveLoomBinary } from "../utils/binary";
import { showActionableError } from "../utils/errors";
import { Logger } from "../utils/logger";

import { CommandContext, ExecError } from "./types";

const execFileAsync = promisify(execFile);

interface LoomToolSearchResponse {
  query?: string;
  detail?: string;
  total?: number;
  count?: number;
  nextCursor?: string;
  results?: Array<{
    name?: string;
    server?: string;
    description?: string;
  }>;
}

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
  const { workspaceRoot, loomChannel, toolProvider, daemonClient } = ctx;
  const loomBinary = resolveLoomBinary(workspaceRoot);

  const logger = new Logger(loomChannel, "Tools");
  logger.info("Refreshing tool list...");
  loomChannel.appendLine(`→ ${loomBinary} tools list --json --page N --limit N`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Refreshing Loom tools",
    },
    async () => {
      try {
        const tools = await daemonClient.getTools(true);

        loomChannel.clear();
        logger.info("Available Tools");
        loomChannel.appendLine("─".repeat(60));

        if (tools.length > 0) {
          const sortedTools = [...tools].sort((a, b) => a.name.localeCompare(b.name));
          for (const tool of sortedTools) {
            const description = tool.description ? ` ${tool.description}` : "";
            loomChannel.appendLine(`${tool.name}${description}`);
          }
        } else {
          loomChannel.appendLine("No tools returned");
        }
        loomChannel.show(true);

        // Refresh the tool tree view
        toolProvider.refresh(false);

        void vscode.window.showInformationMessage(`Loom: ${tools.length} tools available`);
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
        const { stdout, stderr } = await execFileAsync(
          loomBinary,
          ["tools", "search", query, "--json", "--detail", "summary", "--limit", "200"],
          {
            cwd: workspaceRoot || os.homedir(),
            timeout: 30000,
          }
        );

        const parsed = JSON.parse(stdout) as LoomToolSearchResponse;
        const results = Array.isArray(parsed.results) ? parsed.results : [];

        loomChannel.clear();
        logger.info(`Search Results: "${query}"`);
        loomChannel.appendLine("─".repeat(60));

        if (results.length === 0) {
          loomChannel.appendLine(`No tools matched "${query}"`);
        } else {
          for (const result of results) {
            const parts = [result.name ?? "<unknown>"];
            if (result.server?.trim()) {
              parts.push(`(${result.server.trim()})`);
            }
            if (result.description?.trim()) {
              parts.push(result.description.trim());
            }
            loomChannel.appendLine(parts.join(" "));
          }
          if (parsed.nextCursor) {
            loomChannel.appendLine("");
            loomChannel.appendLine(`More results available (cursor: ${parsed.nextCursor})`);
          }
        }
        if (stderr) {
          loomChannel.append(stderr);
        }
        loomChannel.show(true);

        void vscode.window.showInformationMessage(
          `Loom: ${parsed.count ?? results.length} tools match "${query}" (filter applied to tree view)`
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
