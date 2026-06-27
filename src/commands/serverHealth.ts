import * as vscode from "vscode";

import { HubClient, HubServerHealth, HubHealthDivergenceEntry } from "../clients/hub";
import { ProfileManager } from "../managers/profileManager";
import { ServerMetricsManager } from "../managers/serverMetrics";
import { ServerHealthPanel } from "../webviews/ServerHealthPanel";

export interface ServerHealthCommandContext {
  loomChannel: vscode.OutputChannel;
  serverMetricsManager: ServerMetricsManager;
  profileManager: ProfileManager;
  hubClient: HubClient;
  extensionContext: vscode.ExtensionContext;
}

interface HubHealthView {
  hubServers: Record<string, HubServerHealth>;
  divergence: HubHealthDivergenceEntry[];
}

/**
 * Fetch the hub `/api/health` per-server map and top-level divergence for the
 * Server Health panel. A hub failure degrades gracefully to an empty view so
 * the metrics dashboard still renders without the divergence banner.
 */
async function fetchHubHealthView(
  hubClient: HubClient,
  channel: vscode.OutputChannel
): Promise<HubHealthView> {
  try {
    const health = await hubClient.fetchHealth();
    return {
      hubServers: (health.servers ?? {}) as Record<string, HubServerHealth>,
      divergence: (health.divergence ?? []) as HubHealthDivergenceEntry[],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    channel.appendLine(`[ServerHealth] hub health fetch failed: ${message}`);
    return { hubServers: {}, divergence: [] };
  }
}

/**
 * Register server health commands.
 */
export function registerServerHealthCommands(ctx: ServerHealthCommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("loom.showServerHealth", async () => {
      const panel = ServerHealthPanel.render(ctx.extensionContext.extensionUri);

      // Update with current data
      const metrics = ctx.serverMetricsManager.getMetrics();
      const history = ctx.serverMetricsManager.getAllHistory();
      const routing = await ctx.profileManager.getRoutingStatus();
      const hubHealth = await fetchHubHealthView(ctx.hubClient, ctx.loomChannel);

      panel.updateData({
        metrics: Array.from(metrics.values()),
        history,
        routing,
        hubServers: hubHealth.hubServers,
        divergence: hubHealth.divergence,
      });

      // Subscribe to updates
      const disposable = ctx.serverMetricsManager.onDidChangeMetrics(async (newMetrics) => {
        const newRouting = await ctx.profileManager.getRoutingStatus();
        const newHubHealth = await fetchHubHealthView(ctx.hubClient, ctx.loomChannel);
        panel.updateData({
          metrics: Array.from(newMetrics.values()),
          history: ctx.serverMetricsManager.getAllHistory(),
          routing: newRouting,
          hubServers: newHubHealth.hubServers,
          divergence: newHubHealth.divergence,
        });
      });

      // Clean up when panel is closed
      ctx.extensionContext.subscriptions.push(disposable);
    }),

    vscode.commands.registerCommand("loom.pingServer", async (serverName?: string) => {
      if (!serverName) {
        // Show picker with all servers
        const metrics = ctx.serverMetricsManager.getMetrics();
        const items = Array.from(metrics.values()).map((m) => ({
          label: m.serverName,
          description: `${m.status} - ${m.latencyMs}ms`,
          serverName: m.serverName,
        }));

        if (items.length === 0) {
          vscode.window.showInformationMessage("No servers to ping");
          return;
        }

        const selected = await vscode.window.showQuickPick(items, {
          title: "Ping Server",
          placeHolder: "Select a server to ping",
        });

        if (!selected) return;
        serverName = selected.serverName;
      }

      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Pinging ${serverName}...`,
        },
        async () => {
          return ctx.serverMetricsManager.pingServer(serverName);
        }
      );

      if (result) {
        vscode.window.showInformationMessage(
          `${serverName}: ${result.status} (${result.latencyMs}ms)`
        );
      } else {
        vscode.window.showErrorMessage(`Failed to ping ${serverName}`);
      }
    }),

    vscode.commands.registerCommand("loom.switchProfile", async () => {
      const profiles = await ctx.profileManager.getProfiles();
      const activeProfile = ctx.profileManager.getActiveProfileName();

      const items = profiles.map((p) => ({
        label: p.name === activeProfile ? `$(check) ${p.name}` : p.name,
        description: p.description ?? "loom-core profile",
        detail:
          p.servers === "*"
            ? `All servers${p.maxTools ? ` · max ${p.maxTools} tools` : ""}`
            : `${p.servers.length} server${p.servers.length !== 1 ? "s" : ""}${p.maxTools ? ` · max ${p.maxTools} tools` : ""}`,
        profileName: p.name,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        title: "Switch Server Profile",
        placeHolder: `Current: ${activeProfile}`,
      });

      if (!selected) return;

      const success = await ctx.profileManager.switchProfile(selected.profileName);
      if (success) {
        vscode.window.showInformationMessage(`Switched to profile: ${selected.profileName}`);
      }
    }),

    vscode.commands.registerCommand("loom.showRoutingStatus", async () => {
      const routing = await ctx.profileManager.getRoutingStatus();

      const lines: string[] = [
        `# Routing Status`,
        "",
        `**Active Profile:** ${routing.activeProfile}`,
        `**Hub Status:** ${routing.hubHealthy ? "Healthy" : "Unhealthy"}`,
        ...(routing.profileDescription
          ? [`**Profile Description:** ${routing.profileDescription}`]
          : []),
        ...(routing.profileMaxTools ? [`**Profile Max Tools:** ${routing.profileMaxTools}`] : []),
        ...(routing.profileCategories && routing.profileCategories.length > 0
          ? [`**Profile Categories:** ${routing.profileCategories.join(", ")}`]
          : []),
        "",
        "## Hub Routed",
        ...(routing.hubRouted.length > 0 ? routing.hubRouted.map((s) => `- ${s}`) : ["- None"]),
        "",
        "## Local",
        ...(routing.localRouted.length > 0 ? routing.localRouted.map((s) => `- ${s}`) : ["- None"]),
      ];

      const doc = await vscode.workspace.openTextDocument({
        content: lines.join("\n"),
        language: "markdown",
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand("loom.refreshServerMetrics", async () => {
      await ctx.serverMetricsManager.collectMetrics();
      vscode.window.showInformationMessage("Server metrics refreshed");
    }),
  ];
}
