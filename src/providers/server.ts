import * as vscode from "vscode";

import { DaemonClient } from "../clients/daemon";
import { HubStatusManager } from "../managers/hubStatus";
import { DaemonServerInfo, HubServerInfo, RegistryServer, TargetSpec } from "../types";
import { formatArgs } from "../utils/helpers";

import { RegistryProvider } from "./registry";

/**
 * Build a tooltip for a server showing its status across registry, hub, and daemon.
 */
function buildServerTooltip(
  serverName: string,
  registryServer?: RegistryServer,
  hubInfo?: HubServerInfo,
  daemonInfo?: DaemonServerInfo
): vscode.MarkdownString {
  const lines: string[] = [`**${serverName}**`];
  const base: TargetSpec = registryServer?.common ?? {};
  if (base.description) {
    lines.push(base.description);
  } else if (hubInfo?.description) {
    lines.push(hubInfo.description);
  } else if (daemonInfo?.description) {
    lines.push(daemonInfo.description);
  }

  // Daemon status
  if (daemonInfo) {
    const status = daemonInfo.running
      ? "$(circle-filled) **Running**"
      : "$(circle-outline) Idle (lazy-loaded)";
    lines.push(`Daemon: ${status}`);
  } else {
    lines.push("Daemon: not connected");
  }

  if (hubInfo) {
    lines.push("Hub: $(plug) available via gateway");
    if (hubInfo.categories?.length) {
      lines.push(`Hub categories: ${hubInfo.categories.join(", ")}`);
    }
  } else {
    lines.push("Hub: $(warning) not advertising this server");
  }

  if (registryServer) {
    if (base.command) {
      const rendered = [base.command, formatArgs(base.args)].filter(Boolean).join(" ");
      lines.push(`Registry command: \`${rendered}\``);
    }
    if (base.hint) {
      lines.push(base.hint);
    }
    if (registryServer.categories?.length) {
      lines.push(`Registry categories: ${registryServer.categories.join(", ")}`);
    }
    if (base.timeout !== undefined) {
      lines.push(`Timeout: ${base.timeout}s`);
    }
  } else {
    lines.push("Registry: entry missing");
  }

  const tooltip = new vscode.MarkdownString(lines.join("\n\n"));
  tooltip.isTrusted = true;
  return tooltip;
}

/**
 * Tree data provider for the Loom Servers panel.
 * Shows all MCP servers from registry, hub, and daemon.
 */
export class ServerProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly registryProvider: RegistryProvider;
  private readonly hubStatus: HubStatusManager;
  private readonly daemonClient: DaemonClient;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    registryProvider: RegistryProvider,
    hubStatus: HubStatusManager,
    daemonClient: DaemonClient
  ) {
    this.registryProvider = registryProvider;
    this.hubStatus = hubStatus;
    this.daemonClient = daemonClient;
    this.hubStatus.onDidChange(() => this.refresh());
  }

  refresh() {
    this.daemonClient.invalidateCache();
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) {
      return [];
    }
    const registry = await this.registryProvider.getRegistrySnapshot();
    const registryServers = new Map<string, RegistryServer>();
    for (const server of registry?.servers ?? []) {
      registryServers.set(server.name, server);
    }
    const hubServers = new Map<string, HubServerInfo>();
    for (const server of this.hubStatus.getStatus().servers ?? []) {
      hubServers.set(server.name, server);
    }

    // Get daemon server status
    const daemonServers = await this.daemonClient.getServers();
    const daemonServerMap = new Map<string, DaemonServerInfo>();
    for (const server of daemonServers) {
      daemonServerMap.set(server.name, server);
    }

    const names = new Set<string>([
      ...registryServers.keys(),
      ...hubServers.keys(),
      ...daemonServerMap.keys(),
    ]);

    if (names.size === 0) {
      const placeholder = new vscode.TreeItem(
        "No MCP servers detected",
        vscode.TreeItemCollapsibleState.None
      );
      placeholder.iconPath = new vscode.ThemeIcon("info");
      return [placeholder];
    }

    return Array.from(names)
      .sort()
      .map((name) => {
        const registryEntry = registryServers.get(name);
        const hubEntry = hubServers.get(name);
        const daemonEntry = daemonServerMap.get(name);
        const label = name;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description =
          registryEntry?.common?.description ??
          hubEntry?.description ??
          daemonEntry?.description ??
          "";
        item.tooltip = buildServerTooltip(name, registryEntry, hubEntry, daemonEntry);

        // Determine icon based on status
        if (daemonEntry?.running) {
          // Server is actively running in daemon
          item.iconPath = new vscode.ThemeIcon(
            "circle-filled",
            new vscode.ThemeColor("testing.iconPassed")
          );
          item.description = `running${item.description ? " - " + item.description : ""}`;
        } else if (daemonEntry && !daemonEntry.running) {
          // Server is known to daemon but idle (lazy loaded)
          item.iconPath = new vscode.ThemeIcon(
            "circle-outline",
            new vscode.ThemeColor("charts.gray")
          );
          item.description = `idle${item.description ? " - " + item.description : ""}`;
        } else if (registryEntry && hubEntry) {
          // In both registry and hub but daemon not running
          item.iconPath = new vscode.ThemeIcon("plug");
        } else if (registryEntry && !hubEntry) {
          item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow"));
          item.description = item.description || "Registry only";
        } else {
          item.iconPath = new vscode.ThemeIcon("question");
          item.description = item.description || "Hub only";
        }

        return item;
      });
  }
}
