import * as vscode from "vscode";

import { ParityReadModel } from "../readModels";
import { formatNameList } from "../utils/helpers";
import { Logger } from "../utils/logger";
import { ParityOverviewPanel } from "../webviews/ParityOverviewPanel";

import { CommandContext } from "./types";

/**
 * Register all status-related commands.
 */
export function registerStatusCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("loom.showStatus", () => showStatus(ctx)),
    vscode.commands.registerCommand("loom.showMeshReport", () => showMeshReport(ctx)),
  ];
}

async function showStatus(ctx: CommandContext): Promise<void> {
  const { registryProvider } = ctx;

  const summary = await registryProvider.getSummary();
  vscode.window.showInformationMessage(summary);
}

async function showMeshReport(ctx: CommandContext): Promise<void> {
  const {
    workspaceRoot,
    hubStatusManager,
    registryProvider,
    daemonClient,
    usageAnalyticsManager,
    agentContextClient,
    agentSessionManager,
    extensionContext,
  } = ctx;

  if (!workspaceRoot) {
    void vscode.window.showErrorMessage("Loom: workspace folder not detected.");
    return;
  }

  const logger = new Logger(ctx.loomChannel, "Status");
  logger.info("MCP mesh diagnostics");

  const readModel = new ParityReadModel({
    workspaceRoot,
    registryProvider,
    hubStatusManager,
    daemonClient,
    usageAnalyticsManager,
    agentContextClient,
    agentSessionManager,
  });
  const domains = await readModel.collect();
  const { summary, fleet, health } = domains;

  const panel = ParityOverviewPanel.render(extensionContext.extensionUri);
  panel.updateSnapshot(domains);

  const overviewText = `${summary.ready} ready / ${summary.degraded} degraded / ${summary.unavailable} unavailable`;
  const fleetText = `${fleet.registryCount} registry / ${fleet.hubCount} hub / ${fleet.configCount} VS Code`;
  const localModeText = fleet.localRouted.length
    ? ` Local-only: ${formatNameList(fleet.localRouted)}.`
    : "";
  const diagnostics = [
    `Hub status ${health.hubStatus} (ready=${health.hubReady}, sessions=${health.hubSessions}).`,
    `Overview ${overviewText}.`,
    `Fleet ${fleetText}.${localModeText}`,
  ].join(" ");
  logger.info(diagnostics);
  void vscode.window.showInformationMessage("Loom: overview ready");
}
