import * as vscode from "vscode";

import { PlatformConfigClient } from "../clients/platformConfig";
import { PlatformConfig, PlatformSyncStatus, PlatformType } from "../types";
import { PLATFORMS, getEnabledPlatforms } from "../utils/platform";

/**
 * Tree item types for platforms hierarchy.
 */
type PlatformTreeItemType = "platform" | "config-path" | "status" | "server-count" | "action";

/**
 * Custom TreeItem for platforms that tracks item type and metadata.
 */
export class PlatformTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: PlatformTreeItemType,
    public readonly platform?: PlatformType,
    public readonly config?: PlatformConfig
  ) {
    super(label, collapsibleState);
  }
}

/**
 * Tree data provider for the Loom Platforms panel.
 * Shows platform configurations with sync status and actions.
 */
export class PlatformsProvider implements vscode.TreeDataProvider<PlatformTreeItem> {
  private readonly platformConfigClient: PlatformConfigClient;
  private readonly emitter = new vscode.EventEmitter<PlatformTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(platformConfigClient: PlatformConfigClient) {
    this.platformConfigClient = platformConfigClient;

    // Refresh when configs change
    platformConfigClient.onDidChange(() => {
      this.emitter.fire();
    });
  }

  refresh(): void {
    void this.platformConfigClient.checkAllSyncStatus();
    this.emitter.fire();
  }

  getTreeItem(element: PlatformTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PlatformTreeItem): PlatformTreeItem[] {
    if (!element) {
      // Root level: show platforms
      return this.getRootItems();
    }

    if (element.itemType === "platform" && element.platform) {
      return this.getPlatformChildren(element.platform);
    }

    return [];
  }

  private getRootItems(): PlatformTreeItem[] {
    const enabledPlatforms = getEnabledPlatforms();
    const configs = this.platformConfigClient.getConfigs();
    const configMap = new Map(configs.map((c) => [c.platform, c]));

    const items: PlatformTreeItem[] = [];

    for (const platform of enabledPlatforms) {
      const info = PLATFORMS[platform];
      const config = configMap.get(platform);

      const item = new PlatformTreeItem(
        info.displayName,
        vscode.TreeItemCollapsibleState.Collapsed,
        "platform",
        platform,
        config
      );

      item.iconPath = new vscode.ThemeIcon(info.icon);
      item.description = this.getStatusDescription(config);
      item.tooltip = this.buildPlatformTooltip(platform, config);

      // Context value for context menu actions
      item.contextValue = config ? `platform-${config.syncStatus}` : "platform-unknown";

      items.push(item);
    }

    if (items.length === 0) {
      const placeholder = new PlatformTreeItem(
        "No platforms enabled",
        vscode.TreeItemCollapsibleState.None,
        "status"
      );
      placeholder.iconPath = new vscode.ThemeIcon("info");
      placeholder.description = "Configure loom.enabledPlatforms";
      return [placeholder];
    }

    return items;
  }

  private getPlatformChildren(platform: PlatformType): PlatformTreeItem[] {
    const config = this.platformConfigClient.getConfig(platform);
    const info = PLATFORMS[platform];
    const children: PlatformTreeItem[] = [];

    // Config path
    const repoPathItem = new PlatformTreeItem(
      `Repo: ${info.repoConfigPath}`,
      vscode.TreeItemCollapsibleState.None,
      "config-path",
      platform,
      config
    );
    repoPathItem.iconPath = new vscode.ThemeIcon("file");
    repoPathItem.description = config?.repoHash ? `#${config.repoHash}` : "missing";
    repoPathItem.command = {
      command: "loom.openPlatformConfig",
      title: "Open Config",
      arguments: [platform, "repo"],
    };
    children.push(repoPathItem);

    // Home path
    const homePathItem = new PlatformTreeItem(
      `Home: ${info.homeConfigPath}`,
      vscode.TreeItemCollapsibleState.None,
      "config-path",
      platform,
      config
    );
    homePathItem.iconPath = new vscode.ThemeIcon("home");
    homePathItem.description = config?.homeHash ? `#${config.homeHash}` : "missing";
    homePathItem.command = {
      command: "loom.openPlatformConfig",
      title: "Open Config",
      arguments: [platform, "home"],
    };
    children.push(homePathItem);

    // Status
    const statusItem = new PlatformTreeItem(
      `Status: ${this.formatStatus(config?.syncStatus)}`,
      vscode.TreeItemCollapsibleState.None,
      "status",
      platform,
      config
    );
    statusItem.iconPath = new vscode.ThemeIcon(this.getStatusIcon(config?.syncStatus));
    if (config?.error) {
      statusItem.description = config.error;
    }
    children.push(statusItem);

    // Server count
    const serverCountItem = new PlatformTreeItem(
      `Servers: ${config?.serverCount ?? 0}`,
      vscode.TreeItemCollapsibleState.None,
      "server-count",
      platform,
      config
    );
    serverCountItem.iconPath = new vscode.ThemeIcon("server");
    children.push(serverCountItem);

    return children;
  }

  private getStatusDescription(config?: PlatformConfig): string {
    if (!config) {
      return "...";
    }

    switch (config.syncStatus) {
      case "synced":
        return `${config.serverCount} servers`;
      case "out-of-sync":
        return "needs sync";
      case "missing":
        return "not configured";
      case "error":
        return "error";
      default:
        return "checking...";
    }
  }

  private formatStatus(status?: PlatformSyncStatus): string {
    switch (status) {
      case "synced":
        return "Synced";
      case "out-of-sync":
        return "Out of Sync";
      case "missing":
        return "Missing";
      case "error":
        return "Error";
      default:
        return "Unknown";
    }
  }

  private getStatusIcon(status?: PlatformSyncStatus): string {
    switch (status) {
      case "synced":
        return "check";
      case "out-of-sync":
        return "warning";
      case "missing":
        return "circle-slash";
      case "error":
        return "error";
      default:
        return "question";
    }
  }

  private buildPlatformTooltip(
    platform: PlatformType,
    config?: PlatformConfig
  ): vscode.MarkdownString {
    const info = PLATFORMS[platform];
    const lines: string[] = [
      `**${info.displayName}**`,
      "",
      info.description,
      "",
      `Format: ${info.configFormat.toUpperCase()}`,
      `Repo: \`${info.repoConfigPath}\``,
      `Home: \`${info.homeConfigPath}\``,
    ];

    if (config) {
      lines.push(
        "",
        `**Status:** ${this.formatStatus(config.syncStatus)}`,
        `**Servers:** ${config.serverCount}`
      );
      if (config.error) {
        lines.push(`**Error:** ${config.error}`);
      }
      if (config.lastChecked) {
        lines.push(`**Last Checked:** ${config.lastChecked.toLocaleTimeString()}`);
      }
    }

    const tooltip = new vscode.MarkdownString(lines.join("\n"));
    tooltip.isTrusted = true;
    return tooltip;
  }
}
