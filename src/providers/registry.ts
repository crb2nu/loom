import * as fs from "fs";
import { promises as fsp } from "fs";
import * as path from "path";

import * as vscode from "vscode";
import { parse } from "yaml";

import { REGISTRY_PATH, SNAPSHOT_STATE_KEY } from "../constants";
import { HubStatusManager } from "../managers/hubStatus";
import { RegistryDocument } from "../types";
import { loadVscodeConfigSnapshot } from "../utils/config";
import { formatNameList, formatSnapshotLabel } from "../utils/helpers";

/**
 * Tree data provider for the Loom Hub overview panel.
 * Shows registry info, hub status, and config sync state.
 */
export class RegistryProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly root: string;
  private readonly registryPath: string | null;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private cache: RegistryDocument | null = null;
  private lastSnapshotIso?: string;
  private readonly state: vscode.Memento;
  private readonly hubStatus: HubStatusManager;

  constructor(
    root: string,
    registryPath: string | null,
    workspaceState: vscode.Memento,
    hubStatus: HubStatusManager
  ) {
    this.root = root;
    this.registryPath = registryPath;
    this.state = workspaceState;
    this.hubStatus = hubStatus;
    this.lastSnapshotIso = this.state.get<string>(SNAPSHOT_STATE_KEY);
    this.hubStatus.onDidChange(() => this.refresh());
  }

  refresh() {
    this.cache = null;
    this.emitter.fire();
  }

  setLastSnapshot(isoTimestamp: string) {
    this.lastSnapshotIso = isoTimestamp;
    void this.state.update(SNAPSHOT_STATE_KEY, isoTimestamp);
    this.refresh();
  }

  async ensureRegistryLoaded() {
    await this.loadRegistry();
  }

  async getSummary(): Promise<string> {
    const registry = await this.loadRegistry();
    const hubSnapshot = this.hubStatus.getStatus();
    const hubLabel = hubSnapshot.error
      ? `hub error: ${hubSnapshot.error}`
      : `hub ${hubSnapshot.health?.status ?? "unknown"}`;
    const configSnapshot = this.root ? await loadVscodeConfigSnapshot(this.root) : null;

    if (!registry) {
      return `Loom: registry not found; ${hubLabel}`;
    }
    const count = registry.servers?.length ?? 0;
    const configLabel = configSnapshot
      ? `${configSnapshot.serverNames.length} VS Code servers (${configSnapshot.hubRouted.length} hub)`
      : "VS Code config missing";
    return `Loom: registry loaded (${count} servers); ${configLabel}; ${hubLabel}`;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const items: vscode.TreeItem[] = [];
    const hubSettings = this.hubStatus.getSettings();
    const hubSnapshot = this.hubStatus.getStatus();

    const hubStatusLabel = hubSnapshot.error
      ? `Hub status: ${hubSnapshot.error}`
      : `Hub status: ${hubSnapshot.health?.status ?? "unknown"} (${hubSnapshot.health?.sessions ?? 0} sessions)`;
    const hubItem = new vscode.TreeItem(hubStatusLabel, vscode.TreeItemCollapsibleState.None);
    hubItem.iconPath = new vscode.ThemeIcon(hubSnapshot.error ? "error" : "server-process");
    if (hubSnapshot.error) {
      hubItem.tooltip = `Hub Error: ${hubSnapshot.error}`;
      hubItem.contextValue = "hubError";
    } else {
      hubItem.tooltip = "Connection to MCP Hub is healthy";
    }
    hubItem.command = {
      command: "loom.refreshHubStatus",
      title: "Refresh hub status",
    };
    items.push(hubItem);

    const hubUrlItem = new vscode.TreeItem(
      `Hub URL: ${hubSettings.hubUrl}`,
      vscode.TreeItemCollapsibleState.None
    );
    hubUrlItem.iconPath = new vscode.ThemeIcon("globe");
    items.push(hubUrlItem);

    const profileItem = new vscode.TreeItem(
      `Profile: ${hubSettings.profile}`,
      vscode.TreeItemCollapsibleState.None
    );
    profileItem.iconPath = new vscode.ThemeIcon("account");
    items.push(profileItem);

    const cfConfigured = Boolean(hubSettings.cfAccessClientId && hubSettings.cfAccessClientSecret);
    const cfLabel = cfConfigured
      ? "Cloudflare Access: configured"
      : "Cloudflare Access: not configured";
    const cfItem = new vscode.TreeItem(cfLabel, vscode.TreeItemCollapsibleState.None);
    cfItem.iconPath = new vscode.ThemeIcon(cfConfigured ? "shield" : "warning");
    items.push(cfItem);

    if (hubSnapshot.readiness) {
      const readyLabel = hubSnapshot.readiness.ready
        ? `Gateway ready (${hubSnapshot.readiness.servers ?? 0} servers)`
        : `Gateway not ready (${hubSnapshot.readiness.error ?? "registry unavailable"})`;
      const readyItem = new vscode.TreeItem(readyLabel, vscode.TreeItemCollapsibleState.None);
      readyItem.iconPath = new vscode.ThemeIcon(
        hubSnapshot.readiness.ready ? "debug-start" : "error"
      );
      items.push(readyItem);
    }

    if (hubSnapshot.lastUpdated) {
      const refreshedItem = new vscode.TreeItem(
        `Last hub poll: ${hubSnapshot.lastUpdated.toLocaleString()}`,
        vscode.TreeItemCollapsibleState.None
      );
      refreshedItem.iconPath = new vscode.ThemeIcon("history");
      items.push(refreshedItem);
    }

    const registry = await this.loadRegistry();
    if (!registry) {
      const missing = new vscode.TreeItem(
        "registry.yaml not found",
        vscode.TreeItemCollapsibleState.None
      );
      missing.iconPath = new vscode.ThemeIcon("warning");
      return [missing];
    }

    const versionItem = new vscode.TreeItem(
      `Registry version ${registry.version ?? 0}`,
      vscode.TreeItemCollapsibleState.None
    );
    versionItem.iconPath = new vscode.ThemeIcon("gear");
    items.push(versionItem);

    const serverCount = new vscode.TreeItem(
      `${registry.servers?.length ?? 0} server definitions`,
      vscode.TreeItemCollapsibleState.None
    );
    serverCount.iconPath = new vscode.ThemeIcon("list-selection");
    items.push(serverCount);

    const registryNames = new Set<string>(registry.servers?.map((server) => server.name) ?? []);
    const hubNames = new Set<string>(hubSnapshot.servers?.map((server) => server.name) ?? []);
    const configSnapshot = this.root ? await loadVscodeConfigSnapshot(this.root) : null;
    const configNames = new Set<string>(configSnapshot?.serverNames ?? []);

    if (configSnapshot) {
      const configLabel = `VS Code config: ${configSnapshot.serverNames.length} servers (${configSnapshot.hubRouted.length} hub / ${configSnapshot.localRouted.length} local)`;
      const configItem = new vscode.TreeItem(configLabel, vscode.TreeItemCollapsibleState.None);
      configItem.iconPath = new vscode.ThemeIcon(
        configSnapshot.localRouted.length > 0 ? "warning" : "file-submodule"
      );
      items.push(configItem);
    } else {
      const configItem = new vscode.TreeItem(
        "VS Code config: not found (run sync to generate)",
        vscode.TreeItemCollapsibleState.None
      );
      configItem.iconPath = new vscode.ThemeIcon("warning");
      items.push(configItem);
    }

    if (registryNames.size > 0) {
      const missingFromHub = Array.from(registryNames).filter((name) => !hubNames.has(name));
      const missingFromConfig = Array.from(registryNames).filter((name) => !configNames.has(name));
      const configOnly = Array.from(configNames).filter((name) => !registryNames.has(name));

      if (missingFromHub.length > 0) {
        const missingItem = new vscode.TreeItem(
          `Registry → hub gaps: ${formatNameList(missingFromHub)}`,
          vscode.TreeItemCollapsibleState.None
        );
        missingItem.iconPath = new vscode.ThemeIcon("warning");
        items.push(missingItem);
      }

      if (missingFromConfig.length > 0) {
        const missingItem = new vscode.TreeItem(
          `Registry → VS Code gaps: ${formatNameList(missingFromConfig)}`,
          vscode.TreeItemCollapsibleState.None
        );
        missingItem.iconPath = new vscode.ThemeIcon("warning");
        items.push(missingItem);
      }

      if (configOnly.length > 0) {
        const extrasItem = new vscode.TreeItem(
          `VS Code-only servers: ${formatNameList(configOnly)}`,
          vscode.TreeItemCollapsibleState.None
        );
        extrasItem.iconPath = new vscode.ThemeIcon("question");
        items.push(extrasItem);
      }
    }

    const snapshotLabel = this.lastSnapshotIso
      ? `Last snapshot: ${formatSnapshotLabel(this.lastSnapshotIso)}`
      : "Last snapshot: not captured";
    const snapshotItem = new vscode.TreeItem(snapshotLabel, vscode.TreeItemCollapsibleState.None);
    snapshotItem.iconPath = new vscode.ThemeIcon("database");
    snapshotItem.command = this.lastSnapshotIso
      ? {
          command: "loom.snapshotContext",
          title: "Run Snapshot",
        }
      : undefined;
    items.push(snapshotItem);

    if (this.root) {
      const target = path.join(this.root, REGISTRY_PATH);
      const openItem = new vscode.TreeItem(
        "Open registry.yaml",
        vscode.TreeItemCollapsibleState.None
      );
      openItem.iconPath = new vscode.ThemeIcon("file-code");
      openItem.command = {
        command: "vscode.open",
        title: "Open registry",
        arguments: [vscode.Uri.file(target)],
      };
      items.push(openItem);

      if (configSnapshot) {
        const openConfig = new vscode.TreeItem(
          `Open ${path.relative(this.root, configSnapshot.source)}`,
          vscode.TreeItemCollapsibleState.None
        );
        openConfig.iconPath = new vscode.ThemeIcon("file");
        openConfig.command = {
          command: "vscode.open",
          title: "Open VS Code MCP config",
          arguments: [vscode.Uri.file(configSnapshot.source)],
        };
        items.push(openConfig);
      } else {
        const generatedPath = path.join(this.root, "generated", "mcp", "vscode", "mcp.json");
        if (fs.existsSync(generatedPath)) {
          const openGenerated = new vscode.TreeItem(
            `Open generated/mcp/vscode/mcp.json`,
            vscode.TreeItemCollapsibleState.None
          );
          openGenerated.iconPath = new vscode.ThemeIcon("file");
          openGenerated.command = {
            command: "vscode.open",
            title: "Open generated VS Code MCP config",
            arguments: [vscode.Uri.file(generatedPath)],
          };
          items.push(openGenerated);
        }
      }
    }

    return items;
  }

  async getRegistrySnapshot(): Promise<RegistryDocument | null> {
    return this.loadRegistry();
  }

  private async loadRegistry(): Promise<RegistryDocument | null> {
    if (this.cache) {
      return this.cache;
    }
    if (!this.registryPath) {
      return null;
    }
    try {
      const raw = await fsp.readFile(this.registryPath, "utf-8");
      const parsed = parse(raw) as RegistryDocument;
      this.cache = parsed;
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      void vscode.window.showErrorMessage(
        `Failed to read registry.yaml: ${(error as Error).message}`
      );
      return null;
    }
  }
}
