import * as crypto from "crypto";
import * as fs from "fs";
import { promises as fsp } from "fs";
import * as path from "path";

import * as vscode from "vscode";

import { ConfigSyncState } from "../types";

/**
 * Manages configuration synchronization between generated and applied MCP configs.
 */
export class ConfigSyncManager implements vscode.Disposable {
  private readonly root: string;
  private readonly channel: vscode.OutputChannel;
  private readonly emitter = new vscode.EventEmitter<ConfigSyncState>();
  private readonly statusBar: vscode.StatusBarItem;
  private state: ConfigSyncState = { status: "unknown", lastChecked: new Date() };
  private watchers: fs.FSWatcher[] = [];
  private checkPromise?: Promise<void>;

  constructor(root: string, channel: vscode.OutputChannel) {
    this.root = root;
    this.channel = channel;
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = "loom.showSyncStatus";
    this.updateStatusBar();
    this.statusBar.show();
    this.setupWatchers();
  }

  dispose() {
    this.emitter.dispose();
    this.statusBar.dispose();
    for (const watcher of this.watchers) {
      watcher.close();
    }
  }

  readonly onDidChange = this.emitter.event;

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
