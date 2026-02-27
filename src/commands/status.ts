import * as path from "path";

import * as vscode from "vscode";

import { ParityReadModel } from "../readModels";
import { formatNameList } from "../utils/helpers";
import { Logger } from "../utils/logger";

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
    loomChannel,
    hubStatusManager,
    registryProvider,
    daemonClient,
    usageAnalyticsManager,
    agentContextClient,
    agentSessionManager,
  } = ctx;

  if (!workspaceRoot) {
    void vscode.window.showErrorMessage("Loom: workspace folder not detected.");
    return;
  }

  const logger = new Logger(loomChannel, "Status");
  loomChannel.clear();
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
  const { fleet, health, tasks, memory, stream, presence } = domains;

  loomChannel.appendLine(
    `Hub status: ${health.hubStatus} (ready=${health.hubReady}, sessions=${health.hubSessions})`
  );
  loomChannel.appendLine(`Hub URL: ${hubStatusManager.getSettings().hubUrl}`);
  loomChannel.appendLine(`Profile: ${hubStatusManager.getSettings().profile}`);

  if (!fleet.hasRegistry) {
    loomChannel.appendLine("Registry: registry.yaml not found");
  } else {
    loomChannel.appendLine(`Registry servers: ${fleet.registryCount}`);
  }

  if (fleet.hasConfig && fleet.configSource) {
    loomChannel.appendLine(
      `VS Code config: ${fleet.configCount} servers (${fleet.configCount - fleet.localRouted.length} via hub, ${fleet.localRouted.length} local) [${path.relative(workspaceRoot, fleet.configSource)}]`
    );
  } else {
    loomChannel.appendLine("VS Code config: not found (run sync to generate)");
  }

  if (fleet.registryCount > 0) {
    if (fleet.missingFromHub.length > 0) {
      loomChannel.appendLine(`Registry → hub gaps: ${formatNameList(fleet.missingFromHub)}`);
    } else {
      loomChannel.appendLine("Registry → hub gaps: none");
    }

    if (fleet.missingFromConfig.length > 0) {
      loomChannel.appendLine(`Registry → VS Code gaps: ${formatNameList(fleet.missingFromConfig)}`);
    } else {
      loomChannel.appendLine("Registry → VS Code gaps: none");
    }

    if (fleet.hubOnly.length > 0) {
      loomChannel.appendLine(`Hub-only servers: ${formatNameList(fleet.hubOnly)}`);
    }

    if (fleet.configOnly.length > 0) {
      loomChannel.appendLine(`VS Code-only servers: ${formatNameList(fleet.configOnly)}`);
    }
  }

  if (fleet.localRouted.length) {
    loomChannel.appendLine(
      `Local-mode servers: ${formatNameList(fleet.localRouted)} (consider hub-mode)`
    );
  }

  loomChannel.appendLine("");
  loomChannel.appendLine("Domain readiness:");
  loomChannel.appendLine(
    `- Fleet: ${formatDomainState(fleet.state, fleet.reason)} (${fleet.registryCount} registry / ${fleet.hubCount} hub / ${fleet.configCount} VS Code)`
  );
  loomChannel.appendLine(
    `- Health: ${formatDomainState(health.state, health.reason)} (daemon ${health.daemonConnection}, running ${health.daemonRunningCount}/${health.daemonServerCount})`
  );
  loomChannel.appendLine(
    `- Tasks: ${formatDomainState(tasks.state, tasks.reason)} (total ${tasks.total}, blocked ${tasks.blocked})`
  );
  loomChannel.appendLine(
    `- Memory: ${formatDomainState(memory.state, memory.reason)} (entries ${memory.totalEntries}, tokens ${memory.totalTokens})`
  );
  loomChannel.appendLine(
    `- Stream: ${formatDomainState(stream.state, stream.reason)} (total ${stream.totalCalls}, failures ${stream.failureCalls})`
  );
  loomChannel.appendLine(
    `- Presence: ${formatDomainState(presence.state, presence.reason)} (active sessions ${presence.activeSessions})`
  );

  loomChannel.show(true);
  void vscode.window.showInformationMessage("Loom: mesh report ready");
}

function formatDomainState(state: string, reason?: string): string {
  return reason ? `${state} (${reason})` : state;
}
