import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { promises as fsp } from "fs";
import * as os from "os";
import * as http from "http";
import * as https from "https";
import * as crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { parse } from "yaml";

interface TargetSpec {
  description?: string;
  command?: string;
  args?: Array<string | number | boolean>;
  env?: Record<string, string>;
  hint?: string;
  timeout?: number;
  always_allow?: string[];
  type?: string;
}

interface RegistryServer {
  name: string;
  categories?: string[];
  common?: TargetSpec;
  targets?: Record<string, TargetSpec>;
}

interface RegistryDocument {
  version?: number;
  servers?: Array<RegistryServer>;
}

interface SnapshotEnvResult {
  env: Record<string, string>;
  resolved: string[];
  missing: string[];
}

interface HubSettings {
  hubUrl: string;
  httpBaseUrl?: string;
  profile: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

interface HubHealthResponse {
  status?: string;
  timestamp?: string;
  sessions?: number;
}

interface HubReadyResponse {
  ready?: boolean;
  servers?: number;
  error?: string;
}

interface HubServerInfo {
  name: string;
  description?: string;
  categories?: string[];
}

interface HubStatusSnapshot {
  health?: HubHealthResponse;
  readiness?: HubReadyResponse;
  servers: HubServerInfo[];
  lastUpdated?: Date;
  error?: string;
}

interface VscodeConfigSnapshot {
  source: string;
  serverNames: string[];
  hubRouted: string[];
  localRouted: string[];
}

interface ConfigSyncState {
  status: "synced" | "out-of-sync" | "unknown" | "no-generated";
  generatedPath?: string;
  appliedPath?: string;
  generatedHash?: string;
  appliedHash?: string;
  lastChecked: Date;
  diffs?: string[];
}

const REGISTRY_PATH = path.join("mcp", "context", "registry.yaml");
const execFileAsync = promisify(execFile);
const SNAPSHOT_STATE_KEY = "loom.lastSnapshotISO";
const HUB_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_HUB_URL = "wss://mcp.flexinfer.ai/ws";

class HubClient {
  private readonly settings: HubSettings;

  constructor(settings: HubSettings, _channel: vscode.OutputChannel) {
    this.settings = settings;
  }

  async fetchHealth(): Promise<HubHealthResponse> {
    return this.getJson<HubHealthResponse>("/health");
  }

  async fetchReady(): Promise<HubReadyResponse> {
    return this.getJson<HubReadyResponse>("/ready");
  }

  async fetchServers(): Promise<HubServerInfo[]> {
    const payload = await this.getJson<{ servers?: HubServerInfo[] }>("/api/servers");
    return payload.servers ?? [];
  }

  private async getJson<T>(pathName: string): Promise<T> {
    if (!this.settings.httpBaseUrl) {
      throw new Error("Hub URL is not configured");
    }
    const target = new URL(pathName, this.settings.httpBaseUrl);
    const headers = this.buildHeaders();
    return requestJson<T>(target.toString(), headers);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.settings.cfAccessClientId && this.settings.cfAccessClientSecret) {
      headers["CF-Access-Client-Id"] = this.settings.cfAccessClientId;
      headers["CF-Access-Client-Secret"] = this.settings.cfAccessClientSecret;
    }
    return headers;
  }
}

class HubStatusManager implements vscode.Disposable {
  private settings: HubSettings;
  private readonly channel: vscode.OutputChannel;
  private readonly emitter = new vscode.EventEmitter<void>();
  private status: HubStatusSnapshot = { servers: [] };
  private refreshPromise?: Promise<void>;

  constructor(settings: HubSettings, channel: vscode.OutputChannel) {
    this.settings = settings;
    this.channel = channel;
  }

  dispose() {
    this.emitter.dispose();
  }

  getSettings(): HubSettings {
    return this.settings;
  }

  updateSettings(next: HubSettings) {
    this.settings = next;
    void this.refresh();
  }

  getStatus(): HubStatusSnapshot {
    return this.status;
  }

  readonly onDidChange = this.emitter.event;

  async refresh(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh();
    }
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  private async performRefresh(): Promise<void> {
    const now = new Date();
    if (!this.settings.httpBaseUrl) {
      const message = "Invalid MCP hub URL";
      this.channel.appendLine(`[${now.toISOString()}] ${message}`);
      this.status = { ...this.status, error: message, servers: [], lastUpdated: now };
      this.emitter.fire();
      return;
    }

    const client = new HubClient(this.settings, this.channel);

    try {
      const [health, readiness, servers] = await Promise.all([
        client.fetchHealth(),
        client.fetchReady(),
        client.fetchServers(),
      ]);
      this.status = {
        health,
        readiness,
        servers,
        error: undefined,
        lastUpdated: new Date(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(`[${now.toISOString()}] Hub status refresh failed: ${message}`);
      this.status = {
        ...this.status,
        error: message,
        lastUpdated: new Date(),
      };
    }

    this.emitter.fire();
  }
}

class ConfigSyncManager implements vscode.Disposable {
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
    } catch (error) {
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
      const genParsed = JSON.parse(generated) as { servers?: Record<string, unknown> };
      const appParsed = JSON.parse(applied) as { servers?: Record<string, unknown> };

      const genServers = new Set(Object.keys(genParsed.servers ?? {}));
      const appServers = new Set(Object.keys(appParsed.servers ?? {}));

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

export async function activate(context: vscode.ExtensionContext) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceRoot = workspaceFolder?.uri.fsPath ?? "";
  const pythonExecutable = getPythonExecutable();
  const hubChannel = vscode.window.createOutputChannel("Loom Hub");
  context.subscriptions.push(hubChannel);

  const initialHubSettings = deriveHubSettings();
  const hubStatusManager = new HubStatusManager(initialHubSettings, hubChannel);
  context.subscriptions.push(hubStatusManager);
  void hubStatusManager.refresh();
  // Write initial daemon config
  void writeDaemonConfig(initialHubSettings);
  const hubInterval = setInterval(() => {
    void hubStatusManager.refresh();
  }, HUB_REFRESH_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(hubInterval) });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("loom.hubUrl") ||
        event.affectsConfiguration("loom.hubProfile")
      ) {
        const next = deriveHubSettings();
        hubStatusManager.updateSettings(next);
        hubChannel.appendLine(
          `[${new Date().toISOString()}] Hub settings updated (url=${next.hubUrl}, profile=${next.profile})`,
        );
        // Write daemon config file so daemon can pick up changes on restart
        void writeDaemonConfig(next).then(() => {
          hubChannel.appendLine(
            `[${new Date().toISOString()}] Daemon config written to ~/.config/loom/config.yaml`,
          );
        });
      }
    }),
  );

  const registryProvider = new RegistryProvider(
    workspaceRoot,
    context.workspaceState,
    hubStatusManager,
  );
  const registryTree = vscode.window.createTreeView("loomHubOverview", {
    treeDataProvider: registryProvider,
  });
  context.subscriptions.push(registryTree);

  const serverProvider = new ServerProvider(registryProvider, hubStatusManager);
  const serverTree = vscode.window.createTreeView("loomServers", {
    treeDataProvider: serverProvider,
  });
  context.subscriptions.push(serverTree);

  const healthChannel = vscode.window.createOutputChannel("Loom Health");
  context.subscriptions.push(healthChannel);
  const snapshotChannel = vscode.window.createOutputChannel("Loom Snapshot");
  context.subscriptions.push(snapshotChannel);
  const syncChannel = vscode.window.createOutputChannel("Loom Sync");
  context.subscriptions.push(syncChannel);
  const bootstrapChannel = vscode.window.createOutputChannel("Loom Bootstrap");
  context.subscriptions.push(bootstrapChannel);
  const ensureChannel = vscode.window.createOutputChannel("Loom Ensure");
  context.subscriptions.push(ensureChannel);
  const meshChannel = vscode.window.createOutputChannel("Loom Mesh");
  context.subscriptions.push(meshChannel);

  const watcher = watchRegistry(workspaceRoot, () => {
    registryProvider.refresh();
    serverProvider.refresh();
  });
  if (watcher) {
    context.subscriptions.push({ dispose: () => watcher.close() });
  }

  if (workspaceRoot) {
    void ensureServersOnStartup(pythonExecutable, workspaceRoot, ensureChannel);
  }

  // Config sync drift detection
  const syncManager = new ConfigSyncManager(workspaceRoot, syncChannel);
  context.subscriptions.push(syncManager);
  void syncManager.checkSync();

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.showSyncStatus", async () => {
      const state = syncManager.getState();
      const items: vscode.QuickPickItem[] = [];

      items.push({
        label: `$(${getStatusIcon(state.status)}) Status: ${formatSyncStatus(state.status)}`,
        description: `Last checked: ${state.lastChecked.toLocaleTimeString()}`,
      });

      if (state.generatedPath) {
        items.push({
          label: "$(file) Generated config",
          description: state.generatedHash ? `Hash: ${state.generatedHash}` : "Not found",
          detail: state.generatedPath,
        });
      }

      if (state.appliedPath) {
        items.push({
          label: "$(file-code) Applied config",
          description: state.appliedHash ? `Hash: ${state.appliedHash}` : "Not found",
          detail: state.appliedPath,
        });
      }

      if (state.diffs && state.diffs.length > 0) {
        items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
        items.push({
          label: "$(diff) Differences",
          description: `${state.diffs.length} change(s)`,
        });
        for (const diff of state.diffs.slice(0, 10)) {
          items.push({
            label: `    $(circle-filled) ${diff}`,
          });
        }
      }

      if (state.status === "out-of-sync") {
        items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
        items.push({
          label: "$(sync) Sync Now",
          description: "Run Loom: Sync MCP Configs to update",
        });
      }

      const selected = await vscode.window.showQuickPick(items, {
        title: "Loom Config Sync Status",
        placeHolder: "Select an action or press Escape to close",
      });

      if (selected?.label === "$(sync) Sync Now") {
        await vscode.commands.executeCommand("loom.syncConfigs");
      }
    }),
  );

  // Re-check sync status after configs are synced
  context.subscriptions.push(
    syncManager.onDidChange((state) => {
      if (state.status === "out-of-sync") {
        const autoSync = vscode.workspace.getConfiguration("loom").get<string>("autoSyncOnDrift");
        if (autoSync === "auto") {
          void vscode.commands.executeCommand("loom.syncConfigs");
        } else if (autoSync === "prompt") {
          void vscode.window
            .showWarningMessage(
              "Loom: MCP configs are out of sync",
              "Sync Now",
              "Dismiss",
            )
            .then((choice) => {
              if (choice === "Sync Now") {
                void vscode.commands.executeCommand("loom.syncConfigs");
              }
            });
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.showStatus", async () => {
      const summary = await registryProvider.getSummary();
      vscode.window.showInformationMessage(summary);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.showMeshReport", async () => {
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("Loom: workspace folder not detected.");
        return;
      }

      meshChannel.clear();
      meshChannel.appendLine(`[${new Date().toISOString()}] MCP mesh diagnostics`);

      const registry = await registryProvider.getRegistrySnapshot();
      const hubSnapshot = hubStatusManager.getStatus();
      const configSnapshot = await loadVscodeConfigSnapshot(workspaceRoot);

      const registryNames = new Set<string>(registry?.servers?.map((server) => server.name) ?? []);
      const hubNames = new Set<string>(hubSnapshot.servers?.map((server) => server.name) ?? []);
      const configNames = new Set<string>(configSnapshot?.serverNames ?? []);

      meshChannel.appendLine(
        `Hub status: ${hubSnapshot.health?.status ?? hubSnapshot.error ?? "unknown"} (ready=${Boolean(hubSnapshot.readiness?.ready)}, sessions=${hubSnapshot.health?.sessions ?? 0})`,
      );
      meshChannel.appendLine(`Hub URL: ${hubStatusManager.getSettings().hubUrl}`);
      meshChannel.appendLine(`Profile: ${hubStatusManager.getSettings().profile}`);

      if (!registry) {
        meshChannel.appendLine("Registry: registry.yaml not found");
      } else {
        meshChannel.appendLine(`Registry servers: ${registryNames.size}`);
      }

      if (configSnapshot) {
        meshChannel.appendLine(
          `VS Code config: ${configSnapshot.serverNames.length} servers (${configSnapshot.hubRouted.length} via hub, ${configSnapshot.localRouted.length} local) [${path.relative(workspaceRoot, configSnapshot.source)}]`,
        );
      } else {
        meshChannel.appendLine("VS Code config: not found (run sync to generate)");
      }

      if (registryNames.size > 0) {
        const missingFromHub = Array.from(registryNames).filter((name) => !hubNames.has(name));
        const missingFromConfig = Array.from(registryNames).filter((name) => !configNames.has(name));
        const hubOnly = Array.from(hubNames).filter((name) => !registryNames.has(name));
        const configOnly = Array.from(configNames).filter((name) => !registryNames.has(name));

        if (missingFromHub.length > 0) {
          meshChannel.appendLine(`Registry → hub gaps: ${formatNameList(missingFromHub)}`);
        } else {
          meshChannel.appendLine("Registry → hub gaps: none");
        }

        if (missingFromConfig.length > 0) {
          meshChannel.appendLine(`Registry → VS Code gaps: ${formatNameList(missingFromConfig)}`);
        } else {
          meshChannel.appendLine("Registry → VS Code gaps: none");
        }

        if (hubOnly.length > 0) {
          meshChannel.appendLine(`Hub-only servers: ${formatNameList(hubOnly)}`);
        }

        if (configOnly.length > 0) {
          meshChannel.appendLine(`VS Code-only servers: ${formatNameList(configOnly)}`);
        }
      }

      if (configSnapshot?.localRouted.length) {
        meshChannel.appendLine(
          `Local-mode servers: ${formatNameList(configSnapshot.localRouted)} (consider hub-mode)`,
        );
      }

      meshChannel.show(true);
      void vscode.window.showInformationMessage("Loom: mesh report ready");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.syncConfigs", async () => {
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("Loom: workspace folder not detected.");
        return;
      }

      syncChannel.clear();
      syncChannel.appendLine(`[${new Date().toISOString()}] Running MCP sync via loom CLI...`);
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Syncing MCP configurations",
        },
        async () => {
          try {
            const hubSettings = hubStatusManager.getSettings();
            const loomBinary = resolveLoomBinary(workspaceRoot);

            // Sync vscode profile (generates and copies to .vscode/)
            syncChannel.appendLine(`→ ${loomBinary} sync vscode --regen`);
            await execFileAsync(loomBinary, ["sync", "vscode", "--regen"], {
              cwd: workspaceRoot,
              env: { ...process.env, MCP_HUB_URL: hubSettings.hubUrl },
            });
            syncChannel.appendLine("✓ vscode profile synced");

            // Sync claude profile (generates and copies to .claude/)
            syncChannel.appendLine(`→ ${loomBinary} sync claude --regen`);
            await execFileAsync(loomBinary, ["sync", "claude", "--regen"], {
              cwd: workspaceRoot,
              env: { ...process.env, MCP_HUB_URL: hubSettings.hubUrl },
            });
            syncChannel.appendLine("✓ claude profile synced");

            // Sync codex and kilocode profiles
            for (const profile of ["codex", "kilocode"]) {
              syncChannel.appendLine(`→ ${loomBinary} sync ${profile} --regen`);
              await execFileAsync(loomBinary, ["sync", profile, "--regen"], {
                cwd: workspaceRoot,
                env: { ...process.env, MCP_HUB_URL: hubSettings.hubUrl },
              });
              syncChannel.appendLine(`✓ ${profile} profile synced`);
            }

            // Apply keychain/env resolution to .vscode/mcp.json
            await applyGeneratedConfigs(workspaceRoot, syncChannel);

            // Check sync status
            await syncManager.checkSync();

            syncChannel.show(true);
            registryProvider.refresh();
            serverProvider.refresh();
            void vscode.window.showInformationMessage(
              "Loom: synced MCP configs for all profiles",
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            syncChannel.appendLine(`✗ Sync failed: ${message}`);
            syncChannel.show(true);
            void vscode.window.showErrorMessage(
              `Loom: failed to sync configs (${message})`,
            );
          }
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.checkMcpHealth", async () => {
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("Loom: workspace folder not detected.");
        return;
      }
      const scriptPath = path.join(workspaceRoot, "test_mcp_servers.py");
      healthChannel.clear();
      healthChannel.appendLine(`[${new Date().toISOString()}] Running MCP health check...`);

      await runHealthCheck(pythonExecutable, scriptPath, workspaceRoot, healthChannel);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.snapshotContext", async () => {
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("Loom: workspace folder not detected.");
        return;
      }
      const ok = await runSnapshot(pythonExecutable, workspaceRoot, snapshotChannel);
      if (ok) {
        registryProvider.setLastSnapshot(new Date().toISOString());
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.bootstrapContext", async () => {
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("Loom: workspace folder not detected.");
        return;
      }
      bootstrapChannel.clear();
      bootstrapChannel.appendLine(`[${new Date().toISOString()}] Starting bootstrap sequence...`);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Bootstrapping Loom context",
        },
        async () => {
          try {
            const hubSettings = hubStatusManager.getSettings();
            const loomBinary = resolveLoomBinary(workspaceRoot);

            // Sync all profiles using loom CLI
            const profiles = ["vscode", "claude", "codex", "kilocode"];
            for (const profile of profiles) {
              bootstrapChannel.appendLine(`→ ${loomBinary} sync ${profile} --regen`);
              await execFileAsync(loomBinary, ["sync", profile, "--regen"], {
                cwd: workspaceRoot,
                env: { ...process.env, MCP_HUB_URL: hubSettings.hubUrl },
              });
            }
            bootstrapChannel.appendLine("✓ Generated and synced MCP configs for all profiles");

            await applyGeneratedConfigs(workspaceRoot, bootstrapChannel);
            bootstrapChannel.appendLine("✓ Applied keychain/env resolution to workspace config");

            // Check sync status
            await syncManager.checkSync();

            const snapshotOk = await runSnapshot(
              pythonExecutable,
              workspaceRoot,
              snapshotChannel,
            );
            if (snapshotOk) {
              bootstrapChannel.appendLine("✓ Snapshot captured in Qdrant");
              registryProvider.setLastSnapshot(new Date().toISOString());
            } else {
              bootstrapChannel.appendLine("⚠ Snapshot step reported errors; see snapshot channel.");
            }

            bootstrapChannel.show(true);
            void vscode.window.showInformationMessage(
              "Loom: bootstrap completed",
            );
          } catch (error) {
            const execError = error as { message?: string };
            const message = execError.message ?? "Loom: bootstrap failed";
            bootstrapChannel.show(true);
            void vscode.window.showErrorMessage(message);
          }
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.refreshHubStatus", async () => {
      await hubStatusManager.refresh();
      const snapshot = hubStatusManager.getStatus();
      if (snapshot.error) {
        void vscode.window.showWarningMessage(
          `Loom: hub refresh completed with errors (${snapshot.error})`,
        );
      } else {
        void vscode.window.showInformationMessage("Loom: hub status refreshed");
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.verifyHubClient", async () => {
      const wrapperPath = resolveHubWrapperCommand(workspaceRoot);
      hubChannel.appendLine(
        `[${new Date().toISOString()}] Checking hub client via ${wrapperPath || "mcp-hub-wrapper"}`,
      );
      try {
        await execFileAsync(wrapperPath, ["--help"]);
        hubChannel.appendLine("✓ mcp-hub-wrapper responded to --help");
        hubChannel.show(true);
        void vscode.window.showInformationMessage("Loom: hub client detected");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        hubChannel.appendLine(`✗ Hub client check failed: ${message}`);
        hubChannel.show(true);
        void vscode.window.showErrorMessage(`Loom: hub client unavailable (${message})`);
      }
    }),
  );
}

export function deactivate() {
  // no-op for now
}

class RegistryProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly root: string;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private cache: RegistryDocument | null = null;
  private lastSnapshotIso?: string;
  private readonly state: vscode.Memento;
  private readonly hubStatus: HubStatusManager;

  constructor(root: string, workspaceState: vscode.Memento, hubStatus: HubStatusManager) {
    this.root = root;
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
    hubItem.command = {
      command: "loom.refreshHubStatus",
      title: "Refresh hub status",
    };
    items.push(hubItem);

    const hubUrlItem = new vscode.TreeItem(`Hub URL: ${hubSettings.hubUrl}`, vscode.TreeItemCollapsibleState.None);
    hubUrlItem.iconPath = new vscode.ThemeIcon("globe");
    items.push(hubUrlItem);

    const profileItem = new vscode.TreeItem(`Profile: ${hubSettings.profile}`, vscode.TreeItemCollapsibleState.None);
    profileItem.iconPath = new vscode.ThemeIcon("account");
    items.push(profileItem);

    const cfConfigured = Boolean(hubSettings.cfAccessClientId && hubSettings.cfAccessClientSecret);
    const cfLabel = cfConfigured ? "Cloudflare Access: configured" : "Cloudflare Access: not configured";
    const cfItem = new vscode.TreeItem(cfLabel, vscode.TreeItemCollapsibleState.None);
    cfItem.iconPath = new vscode.ThemeIcon(cfConfigured ? "shield" : "warning");
    items.push(cfItem);

    if (hubSnapshot.readiness) {
      const readyLabel = hubSnapshot.readiness.ready
        ? `Gateway ready (${hubSnapshot.readiness.servers ?? 0} servers)`
        : `Gateway not ready (${hubSnapshot.readiness.error ?? "registry unavailable"})`;
      const readyItem = new vscode.TreeItem(readyLabel, vscode.TreeItemCollapsibleState.None);
      readyItem.iconPath = new vscode.ThemeIcon(hubSnapshot.readiness.ready ? "debug-start" : "error");
      items.push(readyItem);
    }

    if (hubSnapshot.lastUpdated) {
      const refreshedItem = new vscode.TreeItem(
        `Last hub poll: ${hubSnapshot.lastUpdated.toLocaleString()}`,
        vscode.TreeItemCollapsibleState.None,
      );
      refreshedItem.iconPath = new vscode.ThemeIcon("history");
      items.push(refreshedItem);
    }

    const registry = await this.loadRegistry();
    if (!registry) {
      const missing = new vscode.TreeItem("registry.yaml not found", vscode.TreeItemCollapsibleState.None);
      missing.iconPath = new vscode.ThemeIcon("warning");
      return [missing];
    }

    const versionItem = new vscode.TreeItem(
      `Registry version ${registry.version ?? 0}`,
      vscode.TreeItemCollapsibleState.None,
    );
    versionItem.iconPath = new vscode.ThemeIcon("gear");
    items.push(versionItem);

    const serverCount = new vscode.TreeItem(
      `${registry.servers?.length ?? 0} server definitions`,
      vscode.TreeItemCollapsibleState.None,
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
        configSnapshot.localRouted.length > 0 ? "warning" : "file-submodule",
      );
      items.push(configItem);
    } else {
      const configItem = new vscode.TreeItem(
        "VS Code config: not found (run sync to generate)",
        vscode.TreeItemCollapsibleState.None,
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
          vscode.TreeItemCollapsibleState.None,
        );
        missingItem.iconPath = new vscode.ThemeIcon("warning");
        items.push(missingItem);
      }

      if (missingFromConfig.length > 0) {
        const missingItem = new vscode.TreeItem(
          `Registry → VS Code gaps: ${formatNameList(missingFromConfig)}`,
          vscode.TreeItemCollapsibleState.None,
        );
        missingItem.iconPath = new vscode.ThemeIcon("warning");
        items.push(missingItem);
      }

      if (configOnly.length > 0) {
        const extrasItem = new vscode.TreeItem(
          `VS Code-only servers: ${formatNameList(configOnly)}`,
          vscode.TreeItemCollapsibleState.None,
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
        vscode.TreeItemCollapsibleState.None,
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
          vscode.TreeItemCollapsibleState.None,
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
            vscode.TreeItemCollapsibleState.None,
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
    if (!this.root) {
      return null;
    }
    const absPath = path.join(this.root, REGISTRY_PATH);
    try {
      const raw = await fsp.readFile(absPath, "utf-8");
      const parsed = parse(raw) as RegistryDocument;
      this.cache = parsed;
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      void vscode.window.showErrorMessage(`Failed to read registry.yaml: ${(error as Error).message}`);
      return null;
    }
  }
}

class ServerProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly registryProvider: RegistryProvider;
  private readonly hubStatus: HubStatusManager;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(registryProvider: RegistryProvider, hubStatus: HubStatusManager) {
    this.registryProvider = registryProvider;
    this.hubStatus = hubStatus;
    this.hubStatus.onDidChange(() => this.refresh());
  }

  refresh() {
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

    const names = new Set<string>([
      ...registryServers.keys(),
      ...hubServers.keys(),
    ]);

    if (names.size === 0) {
      const placeholder = new vscode.TreeItem(
        "No MCP servers detected",
        vscode.TreeItemCollapsibleState.None,
      );
      placeholder.iconPath = new vscode.ThemeIcon("info");
      return [placeholder];
    }

    return Array.from(names)
      .sort()
      .map((name) => {
        const registryEntry = registryServers.get(name);
        const hubEntry = hubServers.get(name);
        const label = name;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = registryEntry?.common?.description ?? hubEntry?.description ?? "";
        item.tooltip = buildServerTooltip(name, registryEntry, hubEntry);

        if (registryEntry && hubEntry) {
          item.iconPath = new vscode.ThemeIcon("plug");
        } else if (registryEntry && !hubEntry) {
          item.iconPath = new vscode.ThemeIcon("warning");
          item.description = item.description || "Registry only";
        } else {
          item.iconPath = new vscode.ThemeIcon("question");
          item.description = item.description || "Hub only";
        }

        return item;
      });
  }
}

function buildServerTooltip(
  serverName: string,
  registryServer?: RegistryServer,
  hubInfo?: HubServerInfo,
): vscode.MarkdownString {
  const lines: string[] = [`**${serverName}**`];
  const base = registryServer?.common ?? {};
  if (base.description) {
    lines.push(base.description);
  } else if (hubInfo?.description) {
    lines.push(hubInfo.description);
  }

  if (hubInfo) {
    lines.push("Hub: available via gateway");
    if (hubInfo.categories?.length) {
      lines.push(`Hub categories: ${hubInfo.categories.join(", ")}`);
    }
  } else {
    lines.push("Hub: not advertising this server");
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

function formatArgs(args?: Array<string | number | boolean>): string {
  if (!args || args.length === 0) {
    return "";
  }
  return args
    .map((value) => {
      if (typeof value === "string" && /\s/.test(value)) {
        return `\"${value}\"`;
      }
      return String(value);
    })
    .join(" ");
}

function watchRegistry(root: string, onChange: () => void): fs.FSWatcher | undefined {
  if (!root) {
    return undefined;
  }
  const target = path.join(root, REGISTRY_PATH);
  try {
    return fs.watch(target, { persistent: false }, () => onChange());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      void vscode.window.showErrorMessage(`Failed to watch registry.yaml: ${(error as Error).message}`);
    }
    return undefined;
  }
}

function requestJson<T>(
  targetUrl: string,
  headers: Record<string, string> = {},
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch (error) {
      reject(error);
      return;
    }

    const httpModule = parsed.protocol === "https:" ? https : http;
    const request = httpModule.request(
      parsed,
      {
        method: "GET",
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          const statusCode = response.statusCode ?? 500;
          if (statusCode >= 400) {
            const reason = body ? `${statusCode} ${body}` : `HTTP ${statusCode}`;
            reject(new Error(reason.trim()));
            return;
          }
          if (!body) {
            resolve({} as T);
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch (error) {
            reject(new Error(`Failed to parse hub response: ${(error as Error).message}`));
          }
        });
      },
    );

    request.on("error", (error) => reject(error));
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Hub request timed out"));
    });
    request.end();
  });
}

function getPythonExecutable(): string {
  return process.env.CM_PYTHON_EXECUTABLE ?? "python3";
}

function deriveHubSettings(): HubSettings {
  const configuration = vscode.workspace.getConfiguration("loom");
  const configuredUrl = configuration.get<string>("hubUrl")?.trim();
  const configuredProfile = configuration.get<string>("hubProfile")?.trim();
  const hubUrl = configuredUrl || process.env.MCP_HUB_URL || DEFAULT_HUB_URL;
  const profile = configuredProfile || process.env.MCP_PROFILE || "codex";
  const httpBaseUrl = convertHubUrlToHttpBase(hubUrl);
  const cfAccessClientId =
    process.env.CF_ACCESS_CLIENT_ID || process.env.CF_Access_Client_Id || undefined;
  const cfAccessClientSecret =
    process.env.CF_ACCESS_CLIENT_SECRET || process.env.CF_Access_ClientSecret || undefined;

  return {
    hubUrl,
    httpBaseUrl,
    profile,
    cfAccessClientId,
    cfAccessClientSecret,
  };
}

interface DaemonConfig {
  hub: {
    url: string;
    enabled: boolean;
    profile: string;
    cf_access_client_id?: string;
    cf_access_client_secret?: string;
  };
  debug: boolean;
}

async function writeDaemonConfig(settings: HubSettings): Promise<void> {
  const configDir = path.join(os.homedir(), ".config", "loom");
  const configPath = path.join(configDir, "config.yaml");

  const config: DaemonConfig = {
    hub: {
      url: settings.hubUrl,
      enabled: true,
      profile: settings.profile,
    },
    debug: false,
  };

  if (settings.cfAccessClientId) {
    config.hub.cf_access_client_id = settings.cfAccessClientId;
  }
  if (settings.cfAccessClientSecret) {
    config.hub.cf_access_client_secret = settings.cfAccessClientSecret;
  }

  try {
    await fsp.mkdir(configDir, { recursive: true });
    const yaml = `# Loom daemon configuration
# This file is managed by the Loom VS Code extension
# Changes will be applied on next daemon restart

hub:
  url: "${config.hub.url}"
  enabled: ${config.hub.enabled}
  profile: "${config.hub.profile}"
${config.hub.cf_access_client_id ? `  cf_access_client_id: "${config.hub.cf_access_client_id}"` : ""}
${config.hub.cf_access_client_secret ? `  cf_access_client_secret: "${config.hub.cf_access_client_secret}"` : ""}

debug: ${config.debug}
`;
    await fsp.writeFile(configPath, yaml, "utf-8");
  } catch (error) {
    console.warn(`Failed to write daemon config: ${(error as Error).message}`);
  }
}

function convertHubUrlToHttpBase(urlText: string): string | undefined {
  if (!urlText) {
    return undefined;
  }
  try {
    const normalized = urlText.startsWith("ws") || urlText.startsWith("http")
      ? urlText
      : `wss://${urlText}`;
    const parsed = new URL(normalized);
    let protocol = parsed.protocol;
    if (protocol === "wss:") {
      protocol = "https:";
    } else if (protocol === "ws:") {
      protocol = "http:";
    }
    return `${protocol}//${parsed.host}`;
  } catch (error) {
    return undefined;
  }
}

async function runHealthCheck(
  pythonExecutable: string,
  scriptPath: string,
  cwd: string,
  channel: vscode.OutputChannel,
) {
  channel.clear();
  channel.appendLine(`[${new Date().toISOString()}] Running MCP health check...`);
  try {
    const { stdout, stderr } = await execFileAsync(pythonExecutable, [scriptPath], { cwd });
    if (stdout) {
      channel.append(stdout);
    }
    if (stderr) {
      channel.append(stderr);
    }
    void vscode.window.showInformationMessage("Loom: MCP health check passed");
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message?: string };
    if (execError.stdout) {
      channel.append(execError.stdout);
    }
    if (execError.stderr) {
      channel.append(execError.stderr);
    }
    channel.show(true);
    const message = execError.message ?? "Loom: MCP health check failed";
    void vscode.window.showErrorMessage(message);
  }
}



async function runSnapshot(
  pythonExecutable: string,
  workspaceRoot: string,
  channel: vscode.OutputChannel,
): Promise<boolean> {
  const scriptPath = path.join(workspaceRoot, "scripts", "context", "snapshot_qdrant.py");
  channel.clear();
  channel.appendLine(`[${new Date().toISOString()}] Capturing repository context...`);

  const snapshotEnv = await buildSnapshotEnv(workspaceRoot);
  if (snapshotEnv.resolved.length > 0) {
    channel.appendLine(`↳ Resolved snapshot env: ${snapshotEnv.resolved.join(", ")}`);
  }
  if (snapshotEnv.missing.length > 0) {
    channel.appendLine(`⚠ Missing snapshot secrets: ${snapshotEnv.missing.join(", ")}`);
  }

  try {
    const { stdout, stderr } = await execFileAsync(pythonExecutable, [scriptPath], {
      cwd: workspaceRoot,
      env: { ...process.env, ...snapshotEnv.env },
    });
    if (stdout) {
      channel.append(stdout);
    }
    if (stderr) {
      channel.append(stderr);
    }
    channel.show(true);
    void vscode.window.showInformationMessage(
      "Loom: Qdrant snapshot completed",
    );
    return true;
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message?: string };
    if (execError.stdout) {
      channel.append(execError.stdout);
    }
    if (execError.stderr) {
      channel.append(execError.stderr);
    }
    channel.show(true);
    const message = execError.message ?? "Loom: snapshot failed";
    void vscode.window.showErrorMessage(message);
    return false;
  }
}

async function buildSnapshotEnv(workspaceRoot: string): Promise<SnapshotEnvResult> {
  const resolved = new Set<string>();
  const missing = new Set<string>();
  const env: Record<string, string> = {};

  if (workspaceRoot) {
    const registryPath = path.join(workspaceRoot, REGISTRY_PATH);
    try {
      const raw = await fsp.readFile(registryPath, "utf-8");
      const registry = parse(raw) as RegistryDocument;
      const qdrant = registry.servers?.find((server) => server.name === "qdrant");
      if (qdrant) {
        const envBlocks = [qdrant.common?.env, qdrant.targets?.vscode?.env, qdrant.targets?.codex?.env];
        for (const block of envBlocks) {
          if (!block) {
            continue;
          }
          for (const [key, value] of Object.entries(block)) {
            if (typeof value !== "string") {
              continue;
            }
            if (isPlaceholder(value)) {
              const resolvedValue = await resolvePlaceholder(value);
              if (resolvedValue !== undefined) {
                env[key] = resolvedValue;
                resolved.add(key);
                missing.delete(key);
              } else {
                missing.add(key);
              }
            } else {
              env[key] = value;
              missing.delete(key);
            }
          }
        }
      }
    } catch (error) {
      console.warn(`Snapshot env: failed to load registry at ${registryPath}: ${(error as Error).message}`);
    }
  }

  if (env.COLLECTION_NAME && !env.QDRANT_COLLECTION) {
    env.QDRANT_COLLECTION = env.COLLECTION_NAME;
  }

  if (!env.MORPH_API_KEY) {
    const morphFromEnv = process.env.MORPH_API_KEY;
    if (morphFromEnv) {
      env.MORPH_API_KEY = morphFromEnv;
    } else {
      const morphSecret = await readKeychainSecret("MORPH_API_KEY");
      if (morphSecret) {
        env.MORPH_API_KEY = morphSecret;
        resolved.add("MORPH_API_KEY");
        missing.delete("MORPH_API_KEY");
      } else {
        missing.add("MORPH_API_KEY");
      }
    }
  }

  if (!env.QDRANT_API_KEY) {
    const qdrantSecret = await readKeychainSecret("QDRANT_API_KEY");
    if (qdrantSecret) {
      env.QDRANT_API_KEY = qdrantSecret;
      resolved.add("QDRANT_API_KEY");
      missing.delete("QDRANT_API_KEY");
    } else {
      missing.add("QDRANT_API_KEY");
    }
  }

  return {
    env,
    resolved: Array.from(resolved).sort(),
    missing: Array.from(missing).sort(),
  };
}


function formatSnapshotLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}

async function applyGeneratedConfigs(workspaceRoot: string, channel: vscode.OutputChannel) {
  // After loom sync, the config is in .vscode-mcp/mcp.json
  // We read it, resolve keychain/env placeholders, and write to .vscode/mcp.json
  const generatedVscode = path.join(workspaceRoot, ".vscode-mcp", "mcp.json");
  const target = path.join(workspaceRoot, ".vscode", "mcp.json");
  try {
    await fsp.access(generatedVscode);
  } catch (error) {
    channel.appendLine("⚠ Skipping VS Code config update; .vscode-mcp/mcp.json not found");
    return;
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });

  try {
    const raw = await fsp.readFile(generatedVscode, "utf-8");
    const parsed = JSON.parse(raw) as { servers?: Record<string, any> };
    const resolvedSecrets: string[] = [];
    const missingSecrets: string[] = [];

    if (parsed.servers) {
      await Promise.all(
        Object.entries(parsed.servers).map(async ([serverName, serverConfig]) => {
          if (!serverConfig || typeof serverConfig !== "object") {
            return;
          }
          const envBlock = serverConfig.env as Record<string, unknown> | undefined;
          if (!envBlock) {
            return;
          }

          await Promise.all(
            Object.entries(envBlock).map(async ([envKey, envValue]) => {
              if (typeof envValue !== "string") {
                return;
              }
              const resolved = await resolvePlaceholder(envValue);
              if (resolved !== undefined) {
                envBlock[envKey] = resolved;
                resolvedSecrets.push(`${serverName}.${envKey}`);
              } else if (isPlaceholder(envValue)) {
                missingSecrets.push(`${serverName}.${envKey}`);
              }
            }),
          );
        }),
      );
    }

    await fsp.writeFile(target, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    channel.appendLine("✓ Updated .vscode/mcp.json from generated artifacts");
    if (resolvedSecrets.length > 0) {
      channel.appendLine(`  ↳ Resolved secrets: ${resolvedSecrets.join(", ")}`);
    }
    if (missingSecrets.length > 0) {
      channel.appendLine(`  ⚠ Missing secrets: ${missingSecrets.join(", ")}`);
    }
  } catch (error) {
    channel.appendLine(
      `⚠ Failed to resolve keychain placeholders; copying file verbatim (${(error as Error).message})`,
    );
    await fsp.copyFile(generatedVscode, target);
  }
}

function isPlaceholder(value: string): boolean {
  return /^\$\{(keychain|env):[^}]+}$/.test(value);
}

async function loadVscodeConfigSnapshot(workspaceRoot: string): Promise<VscodeConfigSnapshot | null> {
  if (!workspaceRoot) {
    return null;
  }
  const candidates = [
    path.join(workspaceRoot, ".vscode", "mcp.json"),
    path.join(workspaceRoot, ".vscode-mcp", "mcp.json"),
  ];

  for (const candidate of candidates) {
    try {
      const raw = await fsp.readFile(candidate, "utf-8");
      const parsed = JSON.parse(raw) as { servers?: Record<string, unknown> };
      const servers = parsed.servers && typeof parsed.servers === "object" ? parsed.servers : {};
      const hubRouted: string[] = [];
      const localRouted: string[] = [];
      const serverNames: string[] = [];

      for (const [name, serverConfig] of Object.entries(servers)) {
        serverNames.push(name);
        if (isHubRoutedConfig(serverConfig)) {
          hubRouted.push(name);
        } else {
          localRouted.push(name);
        }
      }

      return {
        source: candidate,
        serverNames,
        hubRouted,
        localRouted,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      console.warn(`Mesh scan: failed to parse ${candidate}: ${(error as Error).message}`);
    }
  }

  return null;
}

function isHubRoutedConfig(config: any): boolean {
  const command = typeof config?.command === "string" ? config.command : "";
  const args = Array.isArray(config?.args) ? (config.args as unknown[]) : [];
  const joined = [
    command,
    ...args
      .filter((value: unknown) => typeof value === "string")
      .map((value: unknown) => String(value)),
  ].join(" ");
  if (joined.includes("mcp-hub-wrapper") || joined.includes("mcp-ws-adapter")) {
    return true;
  }
  const type = typeof config?.type === "string" ? config.type.toLowerCase() : "";
  return type === "websocket";
}

function formatNameList(names: string[], max = 5): string {
  if (names.length === 0) {
    return "none";
  }
  const sorted = [...names].sort();
  const shown = sorted.slice(0, max);
  const suffix = sorted.length > max ? ` (+${sorted.length - max} more)` : "";
  return `${shown.join(", ")}${suffix}`;
}

function getStatusIcon(status: ConfigSyncState["status"]): string {
  switch (status) {
    case "synced":
      return "check";
    case "out-of-sync":
      return "warning";
    case "no-generated":
      return "info";
    default:
      return "question";
  }
}

function formatSyncStatus(status: ConfigSyncState["status"]): string {
  switch (status) {
    case "synced":
      return "Synced";
    case "out-of-sync":
      return "Out of Sync";
    case "no-generated":
      return "No Generated Config";
    default:
      return "Unknown";
  }
}

async function ensureServersOnStartup(
  pythonExecutable: string,
  workspaceRoot: string,
  channel: vscode.OutputChannel,
) {
  const ensurePath = path.join(workspaceRoot, "scripts", "mcp", "ensure_mcp_servers.py");
  if (!fs.existsSync(ensurePath)) {
    return;
  }

  channel.clear();
  channel.appendLine(`[${new Date().toISOString()}] ensure_mcp_servers.py --fix --refresh-zep-map`);
  try {
    const { stdout, stderr } = await execFileAsync(
      pythonExecutable,
      [ensurePath, "--fix", "--refresh-zep-map"],
      { cwd: workspaceRoot },
    );
    if (stdout) {
      channel.append(stdout);
    }
    if (stderr) {
      channel.append(stderr);
    }
    channel.appendLine("✓ MCP ensure sequence completed");
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message?: string };
    if (execError.stdout) {
      channel.append(execError.stdout);
    }
    if (execError.stderr) {
      channel.append(execError.stderr);
    }
    channel.appendLine(execError.message ?? "✗ ensure_mcp_servers failed");
    channel.show(true);
  }
}

async function resolvePlaceholder(value: string): Promise<string | undefined> {
  const keychainMatch = value.match(/^\$\{keychain:([^}]+)}$/);
  if (keychainMatch) {
    const secret = await readKeychainSecret(keychainMatch[1]);
    if (secret) {
      return secret;
    }
    return undefined;
  }
  const envMatch = value.match(/^\$\{env:([^}:]+)(:-([^}]*))?}$/);
  if (envMatch) {
    const envKey = envMatch[1];
    const defaultValue = envMatch[3];
    const envValue = process.env[envKey];
    if (envValue !== undefined) {
      return envValue;
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
  }
  return undefined;
}

function resolveHubWrapperCommand(workspaceRoot?: string): string {
  const envOverride =
    process.env.MCP_HUB_WRAPPER_PATH?.trim() ?? process.env.MCP_HUB_WRAPPER?.trim();
  if (envOverride && fs.existsSync(envOverride)) {
    return envOverride;
  }

  const pathCandidate = findBinaryInPath("mcp-hub-wrapper");
  if (pathCandidate) {
    return pathCandidate;
  }

  if (workspaceRoot) {
    const shim = path.join(workspaceRoot, "scripts", "mcp", "hub_wrapper.sh");
    if (fs.existsSync(shim)) {
      return shim;
    }
  }

  return "mcp-hub-wrapper";
}

function resolveLoomBinary(workspaceRoot?: string): string {
  // Check environment override
  const envOverride = process.env.LOOM_BINARY?.trim();
  if (envOverride && fs.existsSync(envOverride)) {
    return envOverride;
  }

  // Check ~/.local/bin/loom (installed location)
  const homeLocal = path.join(os.homedir(), ".local", "bin", "loom");
  if (fs.existsSync(homeLocal)) {
    return homeLocal;
  }

  // Check workspace build directory
  if (workspaceRoot) {
    const workspaceBin = path.join(workspaceRoot, "services", "loom-core", "bin", "loom");
    if (fs.existsSync(workspaceBin)) {
      return workspaceBin;
    }
  }

  // Check PATH
  const pathCandidate = findBinaryInPath("loom");
  if (pathCandidate) {
    return pathCandidate;
  }

  // Fallback to assuming it's in PATH
  return "loom";
}

function findBinaryInPath(binaryName: string): string | undefined {
  const pathEntries = process.env.PATH?.split(path.delimiter) ?? [];
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const entry of pathEntries) {
    for (const ext of extensions) {
      const candidate = path.join(entry, `${binaryName}${ext}`);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch (error) {
        continue;
      }
    }
  }
  return undefined;
}

async function readKeychainSecret(name: string): Promise<string | undefined> {
  if (process.platform !== "darwin") {
    return undefined;
  }
  const user = process.env.USER || os.userInfo().username;
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-a",
      user,
      "-s",
      name,
      "-w",
    ]);
    const trimmed = stdout.trim();
    return trimmed ? trimmed : undefined;
  } catch (error) {
    console.warn(`Keychain lookup failed for ${name}: ${(error as Error).message}`);
    return undefined;
  }
}
