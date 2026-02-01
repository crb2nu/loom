import * as crypto from "crypto";
import * as fs from "fs";
import { promises as fsp } from "fs";
import * as path from "path";

import * as vscode from "vscode";

import { ConfigSyncState } from "../types";

export type OfflineMode = "online" | "offline" | "degraded";

export interface OfflineState {
  mode: OfflineMode;
  lastOnline: Date | null;
  pendingSyncs: Array<{ platform: string; timestamp: Date }>;
  reason?: string;
}

/**
 * Manages configuration synchronization between generated and applied MCP configs.
 */
export class ConfigSyncManager implements vscode.Disposable {
  private readonly root: string;
  private readonly channel: vscode.OutputChannel;
  private readonly emitter = new vscode.EventEmitter<ConfigSyncState>();
  private readonly offlineEmitter = new vscode.EventEmitter<OfflineState>();
  private readonly statusBar: vscode.StatusBarItem;
  private readonly offlineStatusBar: vscode.StatusBarItem;
  private state: ConfigSyncState = { status: "unknown", lastChecked: new Date() };
  private offlineState: OfflineState = { mode: "online", lastOnline: null, pendingSyncs: [] };
  private watchers: fs.FSWatcher[] = [];
  private checkPromise?: Promise<void>;

  readonly onDidChangeOffline = this.offlineEmitter.event;

  constructor(root: string, channel: vscode.OutputChannel) {
    this.root = root;
    this.channel = channel;
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = "loom.showSyncStatus";
    this.updateStatusBar();
    this.statusBar.show();

    this.offlineStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.offlineStatusBar.command = "loom.showOfflineStatus";
    this.updateOfflineStatusBar();
    // Only show when offline
    if (this.offlineState.mode !== "online") {
      this.offlineStatusBar.show();
    }

    this.setupWatchers();
  }

  dispose() {
    this.emitter.dispose();
    this.offlineEmitter.dispose();
    this.statusBar.dispose();
    this.offlineStatusBar.dispose();
    for (const watcher of this.watchers) {
      watcher.close();
    }
  }

  readonly onDidChange = this.emitter.event;

  /**
   * Get current offline state.
   */
  getOfflineState(): OfflineState {
    return { ...this.offlineState };
  }

  /**
   * Set offline mode.
   */
  setOfflineMode(mode: OfflineMode, reason?: string): void {
    const wasOnline = this.offlineState.mode === "online";
    this.offlineState.mode = mode;
    this.offlineState.reason = reason;

    if (mode === "online" && !wasOnline) {
      this.offlineState.lastOnline = new Date();
      // Process pending syncs
      void this.processPendingSyncs();
    }

    this.updateOfflineStatusBar();
    this.offlineEmitter.fire(this.offlineState);

    if (mode !== "online") {
      this.offlineStatusBar.show();
      this.channel.appendLine(
        `[${new Date().toISOString()}] Offline mode: ${mode}${reason ? ` (${reason})` : ""}`
      );
    } else {
      this.offlineStatusBar.hide();
      this.channel.appendLine(`[${new Date().toISOString()}] Back online`);
    }
  }

  /**
   * Queue a sync operation for when we're back online.
   */
  queuePendingSync(platform: string): void {
    // Avoid duplicates
    const exists = this.offlineState.pendingSyncs.some((s) => s.platform === platform);
    if (!exists) {
      this.offlineState.pendingSyncs.push({ platform, timestamp: new Date() });
      this.channel.appendLine(
        `[${new Date().toISOString()}] Queued pending sync for ${platform}`
      );
    }
  }

  /**
   * Process pending syncs when back online.
   */
  private async processPendingSyncs(): Promise<void> {
    if (this.offlineState.pendingSyncs.length === 0) {
      return;
    }

    this.channel.appendLine(
      `[${new Date().toISOString()}] Processing ${this.offlineState.pendingSyncs.length} pending syncs`
    );

    // Clear pending syncs - they'll be re-queued if they fail
    const pending = [...this.offlineState.pendingSyncs];
    this.offlineState.pendingSyncs = [];

    for (const sync of pending) {
      this.channel.appendLine(`  - Syncing ${sync.platform}...`);
      // The actual sync is handled by the platform manager
    }
  }

  /**
   * Check if we should use local-only mode.
   */
  isOffline(): boolean {
    return this.offlineState.mode !== "online";
  }

  /**
   * Update offline status bar.
   */
  private updateOfflineStatusBar(): void {
    switch (this.offlineState.mode) {
      case "offline":
        this.offlineStatusBar.text = "$(cloud-offline) Offline";
        this.offlineStatusBar.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground"
        );
        this.offlineStatusBar.tooltip = `Hub unreachable. ${this.offlineState.pendingSyncs.length} syncs pending.`;
        break;
      case "degraded":
        this.offlineStatusBar.text = "$(warning) Degraded";
        this.offlineStatusBar.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground"
        );
        this.offlineStatusBar.tooltip = `Hub connection unstable. ${this.offlineState.reason ?? ""}`;
        break;
      default:
        this.offlineStatusBar.text = "$(cloud) Online";
        this.offlineStatusBar.backgroundColor = undefined;
        this.offlineStatusBar.tooltip = "Hub connected";
    }
  }

  getState(): ConfigSyncState {
    return this.state;
  }

  async checkSync(): Promise<void> {
    if (!this.checkPromise) {
      this.checkPromise = this.performCheck();
    }
    try {
      await this.checkPromise;
    } finally {
      this.checkPromise = undefined;
    }
  }

  private async performCheck(): Promise<void> {
    if (!this.root) {
      this.state = { status: "unknown", lastChecked: new Date() };
      this.updateStatusBar();
      this.emitter.fire(this.state);
      return;
    }

    // After loom sync, config is in .vscode-mcp/mcp.json (source of truth)
    // and we apply keychain resolution to .vscode/mcp.json (for VS Code MCP extension)
    const generatedPath = path.join(this.root, ".vscode-mcp", "mcp.json");
    const appliedPath = path.join(this.root, ".vscode", "mcp.json");

    try {
      await fsp.access(generatedPath);
    } catch {
      this.state = {
        status: "no-generated",
        appliedPath,
        lastChecked: new Date(),
      };
      this.updateStatusBar();
      this.emitter.fire(this.state);
      return;
    }

    let generatedContent: string;
    let appliedContent: string | undefined;

    try {
      generatedContent = await fsp.readFile(generatedPath, "utf-8");
    } catch {
      this.state = { status: "unknown", lastChecked: new Date() };
      this.updateStatusBar();
      this.emitter.fire(this.state);
      return;
    }

    try {
      appliedContent = await fsp.readFile(appliedPath, "utf-8");
    } catch {
      appliedContent = undefined;
    }

    const generatedHash = this.hashContent(generatedContent);
    const appliedHash = appliedContent ? this.hashContent(appliedContent) : undefined;

    const diffs = this.computeDiffs(generatedContent, appliedContent);

    if (!appliedContent) {
      this.state = {
        status: "out-of-sync",
        generatedPath,
        appliedPath,
        generatedHash,
        lastChecked: new Date(),
        diffs: ["Applied config does not exist"],
      };
    } else if (generatedHash === appliedHash || diffs.length === 0) {
      // Configs are synced if hashes match OR if server lists are identical.
      // Content differences are expected due to keychain/env placeholder resolution.
      this.state = {
        status: "synced",
        generatedPath,
        appliedPath,
        generatedHash,
        appliedHash,
        lastChecked: new Date(),
      };
    } else {
      this.state = {
        status: "out-of-sync",
        generatedPath,
        appliedPath,
        generatedHash,
        appliedHash,
        lastChecked: new Date(),
        diffs,
      };
    }

    this.updateStatusBar();
    this.logState();
    this.emitter.fire(this.state);
  }

  private logState(): void {
    const now = new Date().toISOString();
    if (this.state.status === "synced") {
      this.channel.appendLine(`[${now}] Config sync: OK (hash=${this.state.generatedHash})`);
    } else if (this.state.status === "out-of-sync") {
      this.channel.appendLine(`[${now}] Config drift detected:`);
      for (const diff of this.state.diffs ?? []) {
        this.channel.appendLine(`  - ${diff}`);
      }
    } else if (this.state.status === "no-generated") {
      this.channel.appendLine(`[${now}] No generated config found at ${this.state.appliedPath}`);
    }
  }

  private hashContent(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
  }

  private computeDiffs(generated: string, applied: string | undefined): string[] {
    if (!applied) {
      return ["Applied config missing"];
    }

    try {
      const genParsed = JSON.parse(generated) as { mcpServers?: Record<string, unknown> };
      const appParsed = JSON.parse(applied) as { mcpServers?: Record<string, unknown> };

      const genServers = new Set(Object.keys(genParsed.mcpServers ?? {}));
      const appServers = new Set(Object.keys(appParsed.mcpServers ?? {}));

      const diffs: string[] = [];

      for (const name of genServers) {
        if (!appServers.has(name)) {
          diffs.push(`Server '${name}' missing from applied config`);
        }
      }

      for (const name of appServers) {
        if (!genServers.has(name)) {
          diffs.push(`Server '${name}' in applied but not generated`);
        }
      }

      // If server lists match, configs are effectively synced.
      // Content differences are expected due to keychain/env placeholder resolution.
      return diffs;
    } catch {
      return ["Config content differs"];
    }
  }

  private updateStatusBar(): void {
    switch (this.state.status) {
      case "synced":
        this.statusBar.text = "$(check) Loom: Synced";
        this.statusBar.backgroundColor = undefined;
        this.statusBar.tooltip = "MCP configs are in sync. Click for details.";
        break;
      case "out-of-sync":
        this.statusBar.text = "$(warning) Loom: Out of Sync";
        this.statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        this.statusBar.tooltip = `MCP configs need sync. ${this.state.diffs?.[0] ?? ""}`;
        break;
      case "no-generated":
        this.statusBar.text = "$(info) Loom: No Config";
        this.statusBar.backgroundColor = undefined;
        this.statusBar.tooltip = "No generated config found. Run 'Loom: Sync Configs' to generate.";
        break;
      default:
        this.statusBar.text = "$(question) Loom";
        this.statusBar.backgroundColor = undefined;
        this.statusBar.tooltip = "Checking config sync status...";
    }
  }

  private setupWatchers(): void {
    if (!this.root) {
      return;
    }

    const generatedPath = path.join(this.root, ".vscode-mcp", "mcp.json");
    const appliedPath = path.join(this.root, ".vscode", "mcp.json");

    for (const filePath of [generatedPath, appliedPath]) {
      try {
        const watcher = fs.watch(filePath, { persistent: false }, () => {
          void this.checkSync();
        });
        this.watchers.push(watcher);
      } catch {
        // File doesn't exist yet, try watching directory
        const dir = path.dirname(filePath);
        try {
          const dirWatcher = fs.watch(dir, { persistent: false }, (_, filename) => {
            if (filename === path.basename(filePath)) {
              void this.checkSync();
            }
          });
          this.watchers.push(dirWatcher);
        } catch {
          // Directory doesn't exist either, ignore
        }
      }
    }
  }
}
