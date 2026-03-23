import * as crypto from "crypto";
import * as fs from "fs";
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";

import * as vscode from "vscode";

import { ConfigSyncState } from "../types";
import { resolveLoomBinary } from "../utils/binary";
import { Logger } from "../utils/logger";
import { getCurrentPlatformInfo } from "../utils/platform";

export type OfflineMode = "online" | "offline" | "degraded";

export interface OfflineState {
  mode: OfflineMode;
  lastOnline: Date | null;
  pendingSyncs: Array<{ platform: string; timestamp: Date }>;
  cachedServers: string[];
  reason?: string;
}

export interface PendingSyncResult {
  platform: string;
  success: boolean;
  error?: string;
}

/**
 * Manages configuration synchronization between generated and applied MCP configs.
 */
export class ConfigSyncManager implements vscode.Disposable {
  private readonly root: string;
  private readonly channel: vscode.OutputChannel;
  private readonly logger: Logger;
  private readonly emitter = new vscode.EventEmitter<ConfigSyncState>();
  private readonly offlineEmitter = new vscode.EventEmitter<OfflineState>();
  private readonly statusBar: vscode.StatusBarItem;
  private readonly offlineStatusBar: vscode.StatusBarItem;
  private state: ConfigSyncState = { status: "unknown", lastChecked: new Date() };
  private offlineState: OfflineState = {
    mode: "online",
    lastOnline: null,
    pendingSyncs: [],
    cachedServers: [],
  };
  private readonly _onPendingSyncsProcessed = new vscode.EventEmitter<PendingSyncResult[]>();
  readonly onPendingSyncsProcessed = this._onPendingSyncsProcessed.event;
  private watchers: fs.FSWatcher[] = [];
  private checkPromise?: Promise<void>;

  readonly onDidChangeOffline = this.offlineEmitter.event;

  constructor(root: string, channel: vscode.OutputChannel) {
    this.root = root;
    this.channel = channel;
    this.logger = new Logger(channel, "ConfigSync");
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
    this._onPendingSyncsProcessed.dispose();
    this.statusBar.dispose();
    this.offlineStatusBar.dispose();
    for (const watcher of this.watchers) {
      watcher.close();
    }
  }

  readonly onDidChange = this.emitter.event;

  private applyState(nextState: ConfigSyncState): void {
    const changed = this.hasMeaningfulStateChange(this.state, nextState);
    this.state = nextState;
    this.updateStatusBar();

    if (!changed) {
      return;
    }

    this.logState();
    this.emitter.fire(this.state);
  }

  private hasMeaningfulStateChange(previous: ConfigSyncState, next: ConfigSyncState): boolean {
    const previousDiffs = previous.diffs ?? [];
    const nextDiffs = next.diffs ?? [];

    return (
      previous.status !== next.status ||
      previous.generatedPath !== next.generatedPath ||
      previous.appliedPath !== next.appliedPath ||
      previous.generatedHash !== next.generatedHash ||
      previous.appliedHash !== next.appliedHash ||
      previousDiffs.length !== nextDiffs.length ||
      previousDiffs.some((diff, index) => diff !== nextDiffs[index])
    );
  }

  /**
   * Get current offline state.
   */
  getOfflineState(): OfflineState {
    return {
      ...this.offlineState,
      pendingSyncs: [...this.offlineState.pendingSyncs],
      cachedServers: [...this.offlineState.cachedServers],
    };
  }

  /**
   * Set offline mode.
   */
  setOfflineMode(mode: OfflineMode, reason?: string): void {
    const wasOnline = this.offlineState.mode === "online";
    const changed = this.offlineState.mode !== mode;
    this.offlineState.mode = mode;
    this.offlineState.reason = reason;

    if (mode === "online" && !wasOnline) {
      this.offlineState.lastOnline = new Date();
      // Process pending syncs
      void this.processPendingSyncs();
    }

    // Skip status bar, event, and log updates when mode hasn't changed
    if (!changed) {
      return;
    }

    this.updateOfflineStatusBar();
    this.offlineEmitter.fire(this.offlineState);

    if (mode !== "online") {
      this.offlineStatusBar.show();
      this.logger.info(`Offline mode: ${mode}${reason ? ` (${reason})` : ""}`);
    } else {
      this.offlineStatusBar.hide();
      this.logger.info("Back online");
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
      this.updateOfflineStatusBar();
      this.offlineEmitter.fire(this.getOfflineState());
      this.logger.info(`Queued pending sync for ${platform}`);
    }
  }

  /**
   * Process pending syncs immediately.
   */
  async processPendingSyncsNow(): Promise<PendingSyncResult[]> {
    return this.processPendingSyncs();
  }

  /**
   * Update cached server list for offline mode.
   */
  updateCachedServers(servers: string[]): void {
    this.offlineState.cachedServers = [...servers];
    this.logger.info(`Cached ${servers.length} servers for offline mode`);
  }

  /**
   * Get cached servers for offline mode.
   */
  getCachedServers(): string[] {
    return [...this.offlineState.cachedServers];
  }

  /**
   * Get pending syncs count.
   */
  getPendingSyncsCount(): number {
    return this.offlineState.pendingSyncs.length;
  }

  /**
   * Process pending syncs when back online.
   * Executes `loom sync <platform> --regen` for each queued platform.
   */
  private async processPendingSyncs(): Promise<PendingSyncResult[]> {
    if (this.offlineState.pendingSyncs.length === 0) {
      return [];
    }

    const pending = [...this.offlineState.pendingSyncs];
    this.offlineState.pendingSyncs = [];
    this.updateOfflineStatusBar();
    this.offlineEmitter.fire(this.getOfflineState());

    this.logger.info(`Processing ${pending.length} pending syncs`);

    const results: PendingSyncResult[] = [];
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    for (const sync of pending) {
      this.channel.appendLine(`  - Syncing ${sync.platform}...`);

      try {
        const loomBinary = resolveLoomBinary(this.root);
        await execFileAsync(loomBinary, ["sync", sync.platform, "--regen"], {
          cwd: this.root || os.homedir(),
          timeout: 30000,
        });

        this.channel.appendLine(`    ✓ ${sync.platform} synced successfully`);
        results.push({ platform: sync.platform, success: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.channel.appendLine(`    ✗ ${sync.platform} failed: ${message}`);

        // Re-queue failed syncs
        this.offlineState.pendingSyncs.push({
          platform: sync.platform,
          timestamp: new Date(),
        });

        results.push({ platform: sync.platform, success: false, error: message });
      }
    }

    // Notify listeners of results
    this._onPendingSyncsProcessed.fire(results);

    // Show summary notification
    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    if (failed > 0) {
      vscode.window.showWarningMessage(
        `Processed pending syncs: ${successful} succeeded, ${failed} failed. Failed syncs will be retried.`
      );
    } else if (successful > 0) {
      vscode.window.showInformationMessage(`Processed ${successful} pending sync(s) successfully.`);
    }

    this.updateOfflineStatusBar();
    this.offlineEmitter.fire(this.getOfflineState());
    return results;
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
      this.applyState({ status: "unknown", lastChecked: new Date() });
      return;
    }

    const { generatedPath, appliedPath } = this.getSyncPaths();

    try {
      await fsp.access(generatedPath);
    } catch {
      this.applyState({
        status: "no-generated",
        appliedPath,
        lastChecked: new Date(),
      });
      return;
    }

    let generatedContent: string;
    let appliedContent: string | undefined;

    try {
      generatedContent = await fsp.readFile(generatedPath, "utf-8");
    } catch {
      this.applyState({ status: "unknown", lastChecked: new Date() });
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

    let nextState: ConfigSyncState;

    if (!appliedContent) {
      nextState = {
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
      nextState = {
        status: "synced",
        generatedPath,
        appliedPath,
        generatedHash,
        appliedHash,
        lastChecked: new Date(),
      };
    } else {
      nextState = {
        status: "out-of-sync",
        generatedPath,
        appliedPath,
        generatedHash,
        appliedHash,
        lastChecked: new Date(),
        diffs,
      };
    }

    this.applyState(nextState);
  }

  private logState(): void {
    if (this.state.status === "synced") {
      this.logger.info(`Config sync: OK (hash=${this.state.generatedHash})`);
    } else if (this.state.status === "out-of-sync") {
      this.logger.warn("Config drift detected:");
      for (const diff of this.state.diffs ?? []) {
        this.channel.appendLine(`  - ${diff}`);
      }
    } else if (this.state.status === "no-generated") {
      this.logger.info(`No generated config found at ${this.state.appliedPath}`);
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

    const { generatedPath, appliedPath } = this.getSyncPaths();

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

  private getSyncPaths(): { generatedPath: string; appliedPath: string } {
    const platform = getCurrentPlatformInfo();

    // VS Code maintains a generated source-of-truth file under .vscode-mcp and an
    // applied file under .vscode after placeholder resolution.
    if (platform.type === "vscode") {
      return {
        generatedPath: path.join(this.root, ".vscode-mcp", "mcp.json"),
        appliedPath: path.join(this.root, ".vscode", "mcp.json"),
      };
    }

    return {
      generatedPath: path.join(this.root, platform.repoConfigPath),
      appliedPath: path.join(os.homedir(), platform.homeConfigPath),
    };
  }
}
