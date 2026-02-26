import * as vscode from "vscode";

import { RemoteTunnelProfile } from "../types";

import { CommandContext } from "./types";

interface TunnelQuickPickItem extends vscode.QuickPickItem {
  profile: RemoteTunnelProfile;
}

/**
 * Register remote tunnel commands.
 */
export function registerRemoteTunnelCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("loom.startRemoteTunnel", () => startRemoteTunnel(ctx)),
    vscode.commands.registerCommand("loom.stopRemoteTunnel", () => stopRemoteTunnel(ctx)),
    vscode.commands.registerCommand("loom.remoteTunnelStatus", () => showRemoteTunnelStatus(ctx)),
  ];
}

async function startRemoteTunnel(ctx: CommandContext): Promise<void> {
  const profiles = ctx.remoteTunnelManager.getProfiles();
  if (profiles.length === 0) {
    void vscode.window.showErrorMessage(
      "Loom: No remote tunnel profiles configured. Set loom.remoteTunnels first."
    );
    return;
  }

  const items: TunnelQuickPickItem[] = profiles.map((profile) => ({
    label: profile.name,
    detail: `${profile.namespace}/svc/${profile.service} (${profile.localPort}:${profile.remotePort})`,
    description: profile.context ? `context: ${profile.context}` : undefined,
    profile,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    title: "Start remote MCP tunnel",
    placeHolder: "Select a tunnel profile",
  });

  if (!selected) {
    return;
  }

  try {
    const status = await ctx.remoteTunnelManager.startTunnel(selected.profile.name);
    void vscode.window.showInformationMessage(
      `Loom: Remote tunnel "${selected.profile.name}" active (${status.hubUrl})`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Loom: Failed to start remote tunnel: ${message}`);
  }
}

function stopRemoteTunnel(ctx: CommandContext): void {
  const stopped = ctx.remoteTunnelManager.stopTunnel();
  if (stopped) {
    void vscode.window.showInformationMessage("Loom: Remote tunnel stopped");
  } else {
    void vscode.window.showInformationMessage("Loom: No active remote tunnel");
  }
}

function showRemoteTunnelStatus(ctx: CommandContext): void {
  const status = ctx.remoteTunnelManager.getStatus();
  if (!status.running) {
    void vscode.window.showInformationMessage("Loom: No active remote tunnel");
    return;
  }

  void vscode.window.showInformationMessage(
    `Loom: ${status.profileName} running (${status.hubUrl})`
  );
}
