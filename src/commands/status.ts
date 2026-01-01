import * as path from "path";

import * as vscode from "vscode";

import { loadVscodeConfigSnapshot } from "../utils/config";
import { formatNameList } from "../utils/helpers";

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
  const { workspaceRoot, loomChannel, hubStatusManager, registryProvider } = ctx;

  if (!workspaceRoot) {
    void vscode.window.showErrorMessage("Loom: workspace folder not detected.");
    return;
  }

  loomChannel.clear();
  loomChannel.appendLine(`[${new Date().toISOString()}] MCP mesh diagnostics`);

  const registry = await registryProvider.getRegistrySnapshot();
  const hubSnapshot = hubStatusManager.getStatus();
  const configSnapshot = await loadVscodeConfigSnapshot(workspaceRoot);

  const registryNames = new Set<string>(registry?.servers?.map((server) => server.name) ?? []);
  const hubNames = new Set<string>(hubSnapshot.servers?.map((server) => server.name) ?? []);
  const configNames = new Set<string>(configSnapshot?.serverNames ?? []);

  loomChannel.appendLine(
    `Hub status: ${hubSnapshot.health?.status ?? hubSnapshot.error ?? "unknown"} (ready=${Boolean(hubSnapshot.readiness?.ready)}, sessions=${hubSnapshot.health?.sessions ?? 0})`
  );
  loomChannel.appendLine(`Hub URL: ${hubStatusManager.getSettings().hubUrl}`);
  loomChannel.appendLine(`Profile: ${hubStatusManager.getSettings().profile}`);

  if (!registry) {
    loomChannel.appendLine("Registry: registry.yaml not found");
  } else {
    loomChannel.appendLine(`Registry servers: ${registryNames.size}`);
  }

  if (configSnapshot) {
    loomChannel.appendLine(
      `VS Code config: ${configSnapshot.serverNames.length} servers (${configSnapshot.hubRouted.length} via hub, ${configSnapshot.localRouted.length} local) [${path.relative(workspaceRoot, configSnapshot.source)}]`
    );
  } else {
    loomChannel.appendLine("VS Code config: not found (run sync to generate)");
  }

  if (registryNames.size > 0) {
    const missingFromHub = Array.from(registryNames).filter((name) => !hubNames.has(name));
    const missingFromConfig = Array.from(registryNames).filter((name) => !configNames.has(name));
    const hubOnly = Array.from(hubNames).filter((name) => !registryNames.has(name));
    const configOnly = Array.from(configNames).filter((name) => !registryNames.has(name));

    if (missingFromHub.length > 0) {
      loomChannel.appendLine(`Registry → hub gaps: ${formatNameList(missingFromHub)}`);
    } else {
      loomChannel.appendLine("Registry → hub gaps: none");
    }

    if (missingFromConfig.length > 0) {
      loomChannel.appendLine(`Registry → VS Code gaps: ${formatNameList(missingFromConfig)}`);
    } else {
      loomChannel.appendLine("Registry → VS Code gaps: none");
    }

    if (hubOnly.length > 0) {
      loomChannel.appendLine(`Hub-only servers: ${formatNameList(hubOnly)}`);
    }

    if (configOnly.length > 0) {
      loomChannel.appendLine(`VS Code-only servers: ${formatNameList(configOnly)}`);
    }
  }

  if (configSnapshot?.localRouted.length) {
    loomChannel.appendLine(
      `Local-mode servers: ${formatNameList(configSnapshot.localRouted)} (consider hub-mode)`
    );
  }

  loomChannel.show(true);
  void vscode.window.showInformationMessage("Loom: mesh report ready");
}
