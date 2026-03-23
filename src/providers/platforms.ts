import * as path from "path";

import * as vscode from "vscode";

import { PlatformConfigClient } from "../clients/platformConfig";
import { PlatformConfig, PlatformConfigArtifact, PlatformSyncStatus, PlatformType } from "../types";
import { PLATFORMS, getEnabledPlatforms } from "../utils/platform";

/**
 * Tree item types for platforms hierarchy.
 */
type PlatformTreeItemType =
  | "platform"
  | "config-path"
  | "status"
  | "server-count"
  | "doctor"
  | "action";

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
    // checkAllSyncStatus fires its own change event if configs changed,
    // so we don't need to fire the emitter here (avoids double refresh)
    void this.platformConfigClient.checkAllSyncStatus();
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

    const artifactItems = config?.artifacts ?? [
      {
        label: "Repo config",
        path: info.repoConfigPath,
        required: true,
        exists: false,
      },
      {
        label: "Home config",
        path: info.homeConfigPath,
        required: true,
        exists: false,
      },
    ];

    for (const artifact of artifactItems) {
      children.push(this.buildArtifactItem(platform, artifact, config));
    }

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

    if (config?.doctor) {
      for (const [label, value] of [
        ["Doctor", config.doctor.status],
        ["Hooks", config.doctor.hooks],
        ["Permissions", config.doctor.perms],
        ["Schema", config.doctor.schema],
      ] as const) {
        const doctorItem = new PlatformTreeItem(
          `${label}: ${value}`,
          vscode.TreeItemCollapsibleState.None,
          "doctor",
          platform,
          config
        );
        doctorItem.iconPath = new vscode.ThemeIcon(
          value === "ok" || value === "healthy" ? "check" : value === "n/a" ? "dash" : "warning"
        );
        children.push(doctorItem);
      }
    }

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

  private buildArtifactItem(
    platform: PlatformType,
    artifact: PlatformConfigArtifact,
    config?: PlatformConfig
  ): PlatformTreeItem {
    const item = new PlatformTreeItem(
      `${artifact.label}: ${artifact.path}`,
      vscode.TreeItemCollapsibleState.None,
      "config-path",
      platform,
      config
    );

    item.iconPath = new vscode.ThemeIcon(this.getArtifactIcon(artifact));
    item.description = artifact.exists ? (artifact.hash ?? "present") : "missing";
    const commandArguments: string[] = [platform, this.getArtifactLocation(artifact, platform)];
    if (path.isAbsolute(artifact.path)) {
      commandArguments.push(artifact.path);
    }
    item.command = {
      command: "loom.openPlatformConfig",
      title: "Open Config",
      arguments: commandArguments,
    };
    return item;
  }

  private getStatusDescription(config?: PlatformConfig): string {
    if (!config) {
      return "...";
    }

    switch (config.syncStatus) {
      case "synced":
        return config.doctor
          ? `${config.serverCount} servers · ${config.doctor.status}`
          : `${config.serverCount} servers`;
      case "out-of-sync":
        return config.error ?? "needs sync";
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
      const supplementalArtifacts =
        config.artifacts?.filter((artifact) => !artifact.required) ?? [];
      lines.push(
        "",
        `**Status:** ${this.formatStatus(config.syncStatus)}`,
        `**Servers:** ${config.serverCount}`
      );
      if (config.doctor) {
        lines.push(
          `**Doctor:** ${config.doctor.status}`,
          `**Hooks:** ${config.doctor.hooks}`,
          `**Permissions:** ${config.doctor.perms}`,
          `**Schema:** ${config.doctor.schema}`
        );
      }
      if (config.error) {
        lines.push(`**Error:** ${config.error}`);
      }
      if (supplementalArtifacts.length > 0) {
        lines.push("", "**Supplemental Artifacts:**");
        for (const artifact of supplementalArtifacts) {
          lines.push(
            `- ${artifact.label}: ${artifact.exists ? "present" : "missing"} \`${artifact.path}\``
          );
        }
      }
      if (config.lastChecked) {
        lines.push(`**Last Checked:** ${config.lastChecked.toLocaleTimeString()}`);
      }
    }

    const tooltip = new vscode.MarkdownString(lines.join("\n"));
    tooltip.isTrusted = true;
    return tooltip;
  }

  private getArtifactIcon(artifact: PlatformConfigArtifact): string {
    if (!artifact.exists) {
      return artifact.required ? "warning" : "circle-slash";
    }

    if (artifact.path.endsWith("settings.json")) {
      return "gear";
    }

    if (artifact.path.includes(".gemini")) {
      return "home";
    }

    return "file";
  }

  private getArtifactLocation(
    artifact: PlatformConfigArtifact,
    platform: PlatformType
  ): "repo" | "home" | "repo-settings" | "home-settings" {
    if (platform === "antigravity" && artifact.path.endsWith("settings.json")) {
      return artifact.path.includes(".gemini") ? "home-settings" : "repo-settings";
    }

    return artifact.label.toLowerCase().includes("repo") ? "repo" : "home";
  }
}
