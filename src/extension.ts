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

interface DaemonServerInfo {
  name: string;
  categories?: string[];
  description?: string;
  running: boolean;
}

interface DaemonToolInfo {
  name: string;
  description?: string;
  server: string;
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

interface ActionableError {
  message: string;
  actions: { label: string; command?: string; url?: string }[];
}

function analyzeError(error: unknown, context: string): ActionableError {
  const err = error as { code?: string; message?: string; stderr?: string };
  const message = err.message ?? String(error);
  const code = err.code ?? "";
  const stderr = err.stderr ?? "";

  // Daemon not running
  if (message.includes("ECONNREFUSED") || message.includes("connect ENOENT") ||
      message.includes("no such file") || stderr.includes("daemon not running")) {
    return {
      message: `${context}: Daemon is not running`,
      actions: [
        { label: "Start Daemon", command: "loom.startDaemon" },
        { label: "Check Status", command: "loom.daemonStatus" },
      ],
    };
  }

  // Binary not found
  if (code === "ENOENT" || message.includes("spawn") && message.includes("ENOENT")) {
    return {
      message: `${context}: Loom binary not found`,
      actions: [
        { label: "Install Loom", url: "https://github.com/crb2nu/loom" },
      ],
    };
  }

  // Timeout
  if (message.includes("timeout") || message.includes("ETIMEDOUT")) {
    return {
      message: `${context}: Operation timed out`,
      actions: [
        { label: "Restart Daemon", command: "loom.restartDaemon" },
        { label: "Check Status", command: "loom.daemonStatus" },
      ],
    };
  }

  // Permission denied
  if (code === "EACCES" || message.includes("permission denied")) {
    return {
      message: `${context}: Permission denied`,
      actions: [],
    };
  }

  // Config sync issues
  if (message.includes("registry") || message.includes("config")) {
    return {
      message: `${context}: Configuration error`,
      actions: [
        { label: "Sync Configs", command: "loom.syncConfigs" },
        { label: "Show Mesh Report", command: "loom.showMeshReport" },
      ],
    };
  }

  // Default
  return {
    message: `${context}: ${message}`,
    actions: [],
  };
}

async function showActionableError(error: unknown, context: string): Promise<void> {
  const analyzed = analyzeError(error, context);

  if (analyzed.actions.length === 0) {
    void vscode.window.showErrorMessage(analyzed.message);
    return;
  }

  const actionLabels = analyzed.actions.map((a) => a.label);
  const selection = await vscode.window.showErrorMessage(
    analyzed.message,
    ...actionLabels,
  );

  if (selection) {
    const action = analyzed.actions.find((a) => a.label === selection);
    if (action?.command) {
      void vscode.commands.executeCommand(action.command);
    } else if (action?.url) {
      void vscode.env.openExternal(vscode.Uri.parse(action.url));
    }
  }
}

// Find registry.yaml - check home directory first, then workspace
function findRegistryPath(workspaceRoot: string): string | null {
  const candidates = [
    path.join(os.homedir(), ".config", "loom", "registry.yaml"),
    path.join(workspaceRoot, "mcp", "context", "registry.yaml"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

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

class DaemonClient {
  private readonly workspaceRoot: string;
  private readonly channel: vscode.OutputChannel;
  private cachedServers: DaemonServerInfo[] = [];
  private lastFetch: Date | null = null;
  private readonly cacheTimeoutMs = 5000;

  constructor(workspaceRoot: string, channel: vscode.OutputChannel) {
    this.workspaceRoot = workspaceRoot;
    this.channel = channel;
  }

  async getServers(forceRefresh = false): Promise<DaemonServerInfo[]> {
    const now = new Date();
    if (
      !forceRefresh &&
      this.lastFetch &&
      now.getTime() - this.lastFetch.getTime() < this.cacheTimeoutMs
    ) {
      return this.cachedServers;
    }

    try {
      const loomBinary = resolveLoomBinary(this.workspaceRoot);
      const { stdout } = await execFileAsync(loomBinary, ["servers", "--json"], {
        cwd: this.workspaceRoot || os.homedir(),
        timeout: 5000,
      });

      const parsed = JSON.parse(stdout) as { servers?: DaemonServerInfo[] };
      this.cachedServers = parsed.servers ?? [];
      this.lastFetch = now;
      return this.cachedServers;
    } catch (error) {
      // Daemon might not be running - try parsing text output
      try {
        const loomBinary = resolveLoomBinary(this.workspaceRoot);
        const { stdout } = await execFileAsync(loomBinary, ["servers"], {
          cwd: this.workspaceRoot || os.homedir(),
          timeout: 5000,
        });

        // Parse text output format: "NAME  STATUS  DESCRIPTION"
        const servers: DaemonServerInfo[] = [];
        const lines = stdout.split("\n").slice(2); // Skip header lines
        for (const line of lines) {
          const match = line.match(/^(\S+)\s+(running|idle)\s*(.*)/);
          if (match) {
            servers.push({
              name: match[1],
              running: match[2] === "running",
              description: match[3]?.trim() || undefined,
            });
          }
        }
        this.cachedServers = servers;
        this.lastFetch = now;
        return this.cachedServers;
      } catch {
        // Daemon not running or error
        return [];
      }
    }
  }

  async isDaemonRunning(): Promise<boolean> {
    try {
      const loomBinary = resolveLoomBinary(this.workspaceRoot);
      await execFileAsync(loomBinary, ["daemon", "status"], {
        cwd: this.workspaceRoot || os.homedir(),
        timeout: 2000,
      });
      return true;
    } catch {
      return false;
    }
  }

  invalidateCache(): void {
    this.lastFetch = null;
    this.cachedServers = [];
    this.cachedTools = [];
    this.lastToolFetch = null;
  }

  private cachedTools: DaemonToolInfo[] = [];
  private lastToolFetch: Date | null = null;

  async getTools(forceRefresh = false): Promise<DaemonToolInfo[]> {
    const now = new Date();
    if (
      !forceRefresh &&
      this.lastToolFetch &&
      now.getTime() - this.lastToolFetch.getTime() < this.cacheTimeoutMs
    ) {
      return this.cachedTools;
    }

    try {
      const loomBinary = resolveLoomBinary(this.workspaceRoot);
      const { stdout } = await execFileAsync(loomBinary, ["tools", "list"], {
        cwd: this.workspaceRoot || os.homedir(),
        timeout: 30000,
      });

      // Parse text output format: "tool_name  description"
      const tools: DaemonToolInfo[] = [];
      const lines = stdout.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("NAME") || trimmed.startsWith("----")) {
          continue;
        }
        // Tool name format: server__toolname
        const match = trimmed.match(/^(\S+)\s*(.*)/);
        if (match) {
          const fullName = match[1];
          const description = match[2]?.trim() || undefined;
          // Parse server from tool name (format: server__toolname)
          const serverMatch = fullName.match(/^([^_]+(?:__)?[^_]*)__(.+)$/);
          const server = serverMatch ? serverMatch[1] : "unknown";
          tools.push({
            name: fullName,
            description,
            server,
          });
        }
      }
      this.cachedTools = tools;
      this.lastToolFetch = now;
      return this.cachedTools;
    } catch {
      // Daemon not running or error
      return [];
    }
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

export async function activate(context: vscode.ExtensionContext) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceRoot = workspaceFolder?.uri.fsPath ?? "";
  const pythonExecutable = getPythonExecutable();

  // Single consolidated output channel for all Loom operations
  const loomChannel = vscode.window.createOutputChannel("Loom");
  context.subscriptions.push(loomChannel);

  const initialHubSettings = deriveHubSettings();
  const hubStatusManager = new HubStatusManager(initialHubSettings, loomChannel);
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
        loomChannel.appendLine(
          `[${new Date().toISOString()}] Hub settings updated (url=${next.hubUrl}, profile=${next.profile})`,
        );
        // Write daemon config file so daemon can pick up changes on restart
        void writeDaemonConfig(next).then(() => {
          loomChannel.appendLine(
            `[${new Date().toISOString()}] Daemon config written to ~/.config/loom/config.yaml`,
          );
        });
      }
    }),
  );

  // Find registry - check home directory first
  const registryPath = findRegistryPath(workspaceRoot);

  const registryProvider = new RegistryProvider(
    workspaceRoot,
    registryPath,
    context.workspaceState,
    hubStatusManager,
  );
  const registryTree = vscode.window.createTreeView("loomHubOverview", {
    treeDataProvider: registryProvider,
  });
  context.subscriptions.push(registryTree);

  // Create daemon client for server status queries
  const daemonClient = new DaemonClient(workspaceRoot, loomChannel);

  const serverProvider = new ServerProvider(registryProvider, hubStatusManager, daemonClient);
  const serverTree = vscode.window.createTreeView("loomServers", {
    treeDataProvider: serverProvider,
  });
  context.subscriptions.push(serverTree);

  // Tool browser view
  const toolProvider = new ToolProvider(daemonClient);
  const toolTree = vscode.window.createTreeView("loomTools", {
    treeDataProvider: toolProvider,
  });
  context.subscriptions.push(toolTree);

  const watcher = watchRegistry(workspaceRoot, () => {
    registryProvider.refresh();
    serverProvider.refresh();
  });
  if (watcher) {
    context.subscriptions.push({ dispose: () => watcher.close() });
  }

  if (workspaceRoot) {
    void ensureServersOnStartup(pythonExecutable, workspaceRoot, loomChannel);
  }

  // Config sync drift detection
  const syncManager = new ConfigSyncManager(workspaceRoot, loomChannel);
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

      loomChannel.clear();
      loomChannel.appendLine(`[${new Date().toISOString()}] MCP mesh diagnostics`);

      const registry = await registryProvider.getRegistrySnapshot();
      const hubSnapshot = hubStatusManager.getStatus();
      const configSnapshot = await loadVscodeConfigSnapshot(workspaceRoot);

      const registryNames = new Set<string>(registry?.servers?.map((server) => server.name) ?? []);
      const hubNames = new Set<string>(hubSnapshot.servers?.map((server) => server.name) ?? []);
      const configNames = new Set<string>(configSnapshot?.serverNames ?? []);

      loomChannel.appendLine(
        `Hub status: ${hubSnapshot.health?.status ?? hubSnapshot.error ?? "unknown"} (ready=${Boolean(hubSnapshot.readiness?.ready)}, sessions=${hubSnapshot.health?.sessions ?? 0})`,
      );
      loomChannel.appendLine(`Hub URL: ${hubStatusManager.getSettings().hubUrl}`);
      loomChannel.appendLine(`Profile: ${hubStatusManager.getSettings().profile}`);

      if (!registry) {
        loomChannel.appendLine("Registry: registry.yaml not found");
      } else {
        loomChannel.appendLine(`Registry servers: ${registryNames.size}`);
      }

      if (configSnapshot) {
        loomChannel.appendLine(
          `VS Code config: ${configSnapshot.serverNames.length} servers (${configSnapshot.hubRouted.length} via hub, ${configSnapshot.localRouted.length} local) [${path.relative(workspaceRoot, configSnapshot.source)}]`,
        );
      } else {
        loomChannel.appendLine("VS Code config: not found (run sync to generate)");
      }

      if (registryNames.size > 0) {
        const missingFromHub = Array.from(registryNames).filter((name) => !hubNames.has(name));
        const missingFromConfig = Array.from(registryNames).filter((name) => !configNames.has(name));
        const hubOnly = Array.from(hubNames).filter((name) => !registryNames.has(name));
        const configOnly = Array.from(configNames).filter((name) => !registryNames.has(name));

        if (missingFromHub.length > 0) {
          loomChannel.appendLine(`Registry → hub gaps: ${formatNameList(missingFromHub)}`);
        } else {
          loomChannel.appendLine("Registry → hub gaps: none");
        }

        if (missingFromConfig.length > 0) {
          loomChannel.appendLine(`Registry → VS Code gaps: ${formatNameList(missingFromConfig)}`);
        } else {
          loomChannel.appendLine("Registry → VS Code gaps: none");
        }

        if (hubOnly.length > 0) {
          loomChannel.appendLine(`Hub-only servers: ${formatNameList(hubOnly)}`);
        }

        if (configOnly.length > 0) {
          loomChannel.appendLine(`VS Code-only servers: ${formatNameList(configOnly)}`);
        }
      }

      if (configSnapshot?.localRouted.length) {
        loomChannel.appendLine(
          `Local-mode servers: ${formatNameList(configSnapshot.localRouted)} (consider hub-mode)`,
        );
      }

      loomChannel.show(true);
      void vscode.window.showInformationMessage("Loom: mesh report ready");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.syncConfigs", async () => {
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("Loom: workspace folder not detected.");
        return;
      }

      loomChannel.clear();
      loomChannel.appendLine(`[${new Date().toISOString()}] Running MCP sync via loom CLI...`);
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
            loomChannel.appendLine(`→ ${loomBinary} sync vscode --regen`);
            await execFileAsync(loomBinary, ["sync", "vscode", "--regen"], {
              cwd: workspaceRoot,
              env: { ...process.env, MCP_HUB_URL: hubSettings.hubUrl },
            });
            loomChannel.appendLine("✓ vscode profile synced");

            // Sync claude profile (generates and copies to .claude/)
            loomChannel.appendLine(`→ ${loomBinary} sync claude --regen`);
            await execFileAsync(loomBinary, ["sync", "claude", "--regen"], {
              cwd: workspaceRoot,
              env: { ...process.env, MCP_HUB_URL: hubSettings.hubUrl },
            });
            loomChannel.appendLine("✓ claude profile synced");

            // Sync codex and kilocode profiles
            for (const profile of ["codex", "kilocode"]) {
              loomChannel.appendLine(`→ ${loomBinary} sync ${profile} --regen`);
              await execFileAsync(loomBinary, ["sync", profile, "--regen"], {
                cwd: workspaceRoot,
                env: { ...process.env, MCP_HUB_URL: hubSettings.hubUrl },
              });
              loomChannel.appendLine(`✓ ${profile} profile synced`);
            }

            // Apply keychain/env resolution to .vscode/mcp.json
            await applyGeneratedConfigs(workspaceRoot, loomChannel);

            // Check sync status
            await syncManager.checkSync();

            loomChannel.show(true);
            registryProvider.refresh();
            serverProvider.refresh();
            void vscode.window.showInformationMessage(
              "Loom: synced MCP configs for all profiles",
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            loomChannel.appendLine(`✗ Sync failed: ${message}`);
            loomChannel.show(true);
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
      loomChannel.clear();
      loomChannel.appendLine(`[${new Date().toISOString()}] Running MCP health check...`);

      await runHealthCheck(pythonExecutable, scriptPath, workspaceRoot, loomChannel);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.snapshotContext", async () => {
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage("Loom: workspace folder not detected.");
        return;
      }
      const ok = await runSnapshot(pythonExecutable, workspaceRoot, loomChannel);
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
      loomChannel.clear();
      loomChannel.appendLine(`[${new Date().toISOString()}] Starting bootstrap sequence...`);

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
              loomChannel.appendLine(`→ ${loomBinary} sync ${profile} --regen`);
              await execFileAsync(loomBinary, ["sync", profile, "--regen"], {
                cwd: workspaceRoot,
                env: { ...process.env, MCP_HUB_URL: hubSettings.hubUrl },
              });
            }
            loomChannel.appendLine("✓ Generated and synced MCP configs for all profiles");

            await applyGeneratedConfigs(workspaceRoot, loomChannel);
            loomChannel.appendLine("✓ Applied keychain/env resolution to workspace config");

            // Check sync status
            await syncManager.checkSync();

            const snapshotOk = await runSnapshot(
              pythonExecutable,
              workspaceRoot,
              loomChannel,
            );
            if (snapshotOk) {
              loomChannel.appendLine("✓ Snapshot captured in Qdrant");
              registryProvider.setLastSnapshot(new Date().toISOString());
            } else {
              loomChannel.appendLine("⚠ Snapshot step reported errors; see snapshot channel.");
            }

            loomChannel.show(true);
            void vscode.window.showInformationMessage(
              "Loom: bootstrap completed",
            );
          } catch (error) {
            const execError = error as { message?: string };
            const message = execError.message ?? "Loom: bootstrap failed";
            loomChannel.show(true);
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
      loomChannel.appendLine(
        `[${new Date().toISOString()}] Checking hub client via ${wrapperPath || "mcp-hub-wrapper"}`,
      );
      try {
        await execFileAsync(wrapperPath, ["--help"]);
        loomChannel.appendLine("✓ mcp-hub-wrapper responded to --help");
        loomChannel.show(true);
        void vscode.window.showInformationMessage("Loom: hub client detected");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        loomChannel.appendLine(`✗ Hub client check failed: ${message}`);
        loomChannel.show(true);
        void vscode.window.showErrorMessage(`Loom: hub client unavailable (${message})`);
      }
    }),
  );

  // Daemon lifecycle commands
  context.subscriptions.push(
    vscode.commands.registerCommand("loom.startDaemon", async () => {
      const loomBinary = resolveLoomBinary(workspaceRoot);
      loomChannel.appendLine(`[${new Date().toISOString()}] Starting loom daemon...`);
      loomChannel.appendLine(`→ ${loomBinary} daemon start`);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Starting Loom daemon",
        },
        async () => {
          try {
            const { stdout, stderr } = await execFileAsync(loomBinary, ["daemon", "start"], {
              cwd: workspaceRoot || os.homedir(),
              timeout: 10000,
            });
            if (stdout) {
              loomChannel.append(stdout);
            }
            if (stderr) {
              loomChannel.append(stderr);
            }
            loomChannel.appendLine("✓ Daemon started");
            loomChannel.show(true);
            void vscode.window.showInformationMessage("Loom: daemon started successfully");
            // Refresh hub status and server list after daemon starts
            await hubStatusManager.refresh();
            serverProvider.refresh();
          } catch (error) {
            const execError = error as { stdout?: string; stderr?: string; message?: string };
            if (execError.stdout) {
              loomChannel.append(execError.stdout);
            }
            if (execError.stderr) {
              loomChannel.append(execError.stderr);
            }
            loomChannel.appendLine(`✗ ${execError.message ?? "Failed to start daemon"}`);
            loomChannel.show(true);
            await showActionableError(error, "Failed to start daemon");
          }
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.stopDaemon", async () => {
      const loomBinary = resolveLoomBinary(workspaceRoot);
      loomChannel.appendLine(`[${new Date().toISOString()}] Stopping loom daemon...`);
      loomChannel.appendLine(`→ ${loomBinary} daemon stop`);

      try {
        const { stdout, stderr } = await execFileAsync(loomBinary, ["daemon", "stop"], {
          cwd: workspaceRoot || os.homedir(),
          timeout: 5000,
        });
        if (stdout) {
          loomChannel.append(stdout);
        }
        if (stderr) {
          loomChannel.append(stderr);
        }
        loomChannel.appendLine("✓ Daemon stopped");
        loomChannel.show(true);
        void vscode.window.showInformationMessage("Loom: daemon stopped");
        serverProvider.refresh();
      } catch (error) {
        const execError = error as { stdout?: string; stderr?: string; message?: string };
        if (execError.stdout) {
          loomChannel.append(execError.stdout);
        }
        if (execError.stderr) {
          loomChannel.append(execError.stderr);
        }
        loomChannel.appendLine(`✗ ${execError.message ?? "Failed to stop daemon"}`);
        loomChannel.show(true);
        await showActionableError(error, "Failed to stop daemon");
        serverProvider.refresh();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.restartDaemon", async () => {
      const loomBinary = resolveLoomBinary(workspaceRoot);
      loomChannel.appendLine(`[${new Date().toISOString()}] Restarting loom daemon...`);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Restarting Loom daemon",
        },
        async () => {
          try {
            // Stop first
            loomChannel.appendLine(`→ ${loomBinary} daemon stop`);
            try {
              await execFileAsync(loomBinary, ["daemon", "stop"], {
                cwd: workspaceRoot || os.homedir(),
                timeout: 5000,
              });
              loomChannel.appendLine("✓ Daemon stopped");
            } catch {
              loomChannel.appendLine("⚠ Daemon was not running");
            }

            // Wait a moment for cleanup
            await new Promise((resolve) => setTimeout(resolve, 500));

            // Start
            loomChannel.appendLine(`→ ${loomBinary} daemon start`);
            const { stdout, stderr } = await execFileAsync(loomBinary, ["daemon", "start"], {
              cwd: workspaceRoot || os.homedir(),
              timeout: 10000,
            });
            if (stdout) {
              loomChannel.append(stdout);
            }
            if (stderr) {
              loomChannel.append(stderr);
            }
            loomChannel.appendLine("✓ Daemon restarted");
            loomChannel.show(true);
            void vscode.window.showInformationMessage("Loom: daemon restarted successfully");
            // Refresh hub status and server list after restart
            await hubStatusManager.refresh();
            serverProvider.refresh();
          } catch (error) {
            const execError = error as { stdout?: string; stderr?: string; message?: string };
            if (execError.stdout) {
              loomChannel.append(execError.stdout);
            }
            if (execError.stderr) {
              loomChannel.append(execError.stderr);
            }
            loomChannel.appendLine(`✗ ${execError.message ?? "Failed to restart daemon"}`);
            loomChannel.show(true);
            await showActionableError(error, "Failed to restart daemon");
          }
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.daemonStatus", async () => {
      const loomBinary = resolveLoomBinary(workspaceRoot);
      loomChannel.appendLine(`[${new Date().toISOString()}] Checking daemon status...`);
      loomChannel.appendLine(`→ ${loomBinary} daemon status`);

      try {
        const { stdout, stderr } = await execFileAsync(loomBinary, ["daemon", "status"], {
          cwd: workspaceRoot || os.homedir(),
          timeout: 5000,
        });

        loomChannel.clear();
        loomChannel.appendLine(`[${new Date().toISOString()}] Daemon Status`);
        loomChannel.appendLine("─".repeat(40));
        if (stdout) {
          loomChannel.append(stdout);
        }
        if (stderr) {
          loomChannel.append(stderr);
        }
        loomChannel.show(true);

        // Parse status to show in notification
        const isRunning = stdout?.toLowerCase().includes("running") ||
                          stdout?.toLowerCase().includes("active") ||
                          stdout?.toLowerCase().includes("pid");
        const statusMessage = isRunning ? "Daemon is running" : "Daemon status retrieved";
        void vscode.window.showInformationMessage(`Loom: ${statusMessage}`);
      } catch (error) {
        const execError = error as { stdout?: string; stderr?: string; message?: string; code?: number };
        loomChannel.clear();
        loomChannel.appendLine(`[${new Date().toISOString()}] Daemon Status`);
        loomChannel.appendLine("─".repeat(40));
        if (execError.stdout) {
          loomChannel.append(execError.stdout);
        }
        if (execError.stderr) {
          loomChannel.append(execError.stderr);
        }
        loomChannel.show(true);

        // Exit code 1 often means daemon is not running, which is informational
        if (execError.code === 1) {
          void vscode.window.showInformationMessage("Loom: daemon is not running");
        } else {
          void vscode.window.showErrorMessage(`Loom: ${execError.message ?? "Failed to get daemon status"}`);
        }
      }
    }),
  );

  // Tool browser commands
  context.subscriptions.push(
    vscode.commands.registerCommand("loom.refreshTools", async () => {
      const loomBinary = resolveLoomBinary(workspaceRoot);
      loomChannel.appendLine(`[${new Date().toISOString()}] Refreshing tool list...`);
      loomChannel.appendLine(`→ ${loomBinary} tools list`);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Refreshing Loom tools",
        },
        async () => {
          try {
            const { stdout, stderr } = await execFileAsync(loomBinary, ["tools", "list"], {
              cwd: workspaceRoot || os.homedir(),
              timeout: 30000,
            });

            loomChannel.clear();
            loomChannel.appendLine(`[${new Date().toISOString()}] Available Tools`);
            loomChannel.appendLine("─".repeat(60));
            if (stdout) {
              loomChannel.append(stdout);
            }
            if (stderr) {
              loomChannel.append(stderr);
            }
            loomChannel.show(true);

            // Refresh the tool tree view
            toolProvider.refresh();

            // Count tools from output
            const toolCount = (stdout?.match(/^[a-z0-9_-]+__/gm) || []).length ||
                              stdout?.split("\n").filter((line: string) => line.trim()).length || 0;
            void vscode.window.showInformationMessage(`Loom: ${toolCount} tools available`);
          } catch (error) {
            const execError = error as { stdout?: string; stderr?: string; message?: string };
            if (execError.stdout) {
              loomChannel.append(execError.stdout);
            }
            if (execError.stderr) {
              loomChannel.append(execError.stderr);
            }
            loomChannel.appendLine(`✗ ${execError.message ?? "Failed to list tools"}`);
            loomChannel.show(true);
            await showActionableError(error, "Failed to list tools");
          }
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.searchTools", async () => {
      const query = await vscode.window.showInputBox({
        prompt: "Search tools by name or description",
        placeHolder: "e.g., git, kubernetes, search",
        value: "",
      });

      if (query === undefined) {
        return; // User cancelled
      }

      if (query === "") {
        // Clear filter
        toolProvider.clearFilter();
        void vscode.window.showInformationMessage("Loom: Tool filter cleared");
        return;
      }

      // Apply filter to tool tree view
      toolProvider.setFilter(query);

      // Also run CLI search and show in output channel
      const loomBinary = resolveLoomBinary(workspaceRoot);
      loomChannel.appendLine(`[${new Date().toISOString()}] Searching tools for: ${query}`);
      loomChannel.appendLine(`→ ${loomBinary} tools search ${query}`);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Searching tools for "${query}"`,
        },
        async () => {
          try {
            const { stdout, stderr } = await execFileAsync(loomBinary, ["tools", "search", query], {
              cwd: workspaceRoot || os.homedir(),
              timeout: 30000,
            });

            loomChannel.clear();
            loomChannel.appendLine(`[${new Date().toISOString()}] Search Results: "${query}"`);
            loomChannel.appendLine("─".repeat(60));
            if (stdout) {
              loomChannel.append(stdout);
            }
            if (stderr) {
              loomChannel.append(stderr);
            }
            loomChannel.show(true);

            // Count results
            const matchCount = stdout?.split("\n").filter((line: string) => line.trim()).length || 0;
            void vscode.window.showInformationMessage(`Loom: ${matchCount} tools match "${query}" (filter applied to tree view)`);
          } catch (error) {
            const execError = error as { stdout?: string; stderr?: string; message?: string };
            if (execError.stdout) {
              loomChannel.append(execError.stdout);
            }
            if (execError.stderr) {
              loomChannel.append(execError.stderr);
            }
            loomChannel.appendLine(`✗ ${execError.message ?? "Failed to search tools"}`);
            loomChannel.show(true);
            await showActionableError(error, "Failed to search tools");
          }
        },
      );
    }),
  );
}

export function deactivate() {
  // no-op for now
}

class RegistryProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly root: string;
  private readonly registryPath: string | null;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private cache: RegistryDocument | null = null;
  private lastSnapshotIso?: string;
  private readonly state: vscode.Memento;
  private readonly hubStatus: HubStatusManager;

  constructor(root: string, registryPath: string | null, workspaceState: vscode.Memento, hubStatus: HubStatusManager) {
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
      void vscode.window.showErrorMessage(`Failed to read registry.yaml: ${(error as Error).message}`);
      return null;
    }
  }
}

class ServerProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly registryProvider: RegistryProvider;
  private readonly hubStatus: HubStatusManager;
  private readonly daemonClient: DaemonClient;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(registryProvider: RegistryProvider, hubStatus: HubStatusManager, daemonClient: DaemonClient) {
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
        const daemonEntry = daemonServerMap.get(name);
        const label = name;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = registryEntry?.common?.description ?? hubEntry?.description ?? daemonEntry?.description ?? "";
        item.tooltip = buildServerTooltip(name, registryEntry, hubEntry, daemonEntry);

        // Determine icon based on status
        if (daemonEntry?.running) {
          // Server is actively running in daemon
          item.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("testing.iconPassed"));
          item.description = `running${item.description ? " - " + item.description : ""}`;
        } else if (daemonEntry && !daemonEntry.running) {
          // Server is known to daemon but idle (lazy loaded)
          item.iconPath = new vscode.ThemeIcon("circle-outline", new vscode.ThemeColor("charts.gray"));
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

class ToolTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly isServer: boolean = false,
    public readonly serverName?: string,
    public readonly toolInfo?: DaemonToolInfo,
  ) {
    super(label, collapsibleState);
  }
}

class ToolProvider implements vscode.TreeDataProvider<ToolTreeItem> {
  private readonly daemonClient: DaemonClient;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private filterQuery: string = "";

  constructor(daemonClient: DaemonClient) {
    this.daemonClient = daemonClient;
  }

  refresh() {
    this.daemonClient.invalidateCache();
    this.emitter.fire();
  }

  setFilter(query: string) {
    this.filterQuery = query.toLowerCase();
    this.emitter.fire();
  }

  clearFilter() {
    this.filterQuery = "";
    this.emitter.fire();
  }

  getTreeItem(element: ToolTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ToolTreeItem): Promise<ToolTreeItem[]> {
    if (!element) {
      // Root level: show servers with tools
      const tools = await this.daemonClient.getTools();

      if (tools.length === 0) {
        const placeholder = new ToolTreeItem(
          "No tools available (daemon not running?)",
          vscode.TreeItemCollapsibleState.None,
        );
        placeholder.iconPath = new vscode.ThemeIcon("warning");
        placeholder.command = {
          command: "loom.startDaemon",
          title: "Start Daemon",
        };
        return [placeholder];
      }

      // Filter tools if query is set
      const filteredTools = this.filterQuery
        ? tools.filter(
            (t) =>
              t.name.toLowerCase().includes(this.filterQuery) ||
              t.description?.toLowerCase().includes(this.filterQuery),
          )
        : tools;

      if (filteredTools.length === 0 && this.filterQuery) {
        const noMatch = new ToolTreeItem(
          `No tools match "${this.filterQuery}"`,
          vscode.TreeItemCollapsibleState.None,
        );
        noMatch.iconPath = new vscode.ThemeIcon("search-stop");
        return [noMatch];
      }

      // Group by server
      const serverMap = new Map<string, DaemonToolInfo[]>();
      for (const tool of filteredTools) {
        const serverTools = serverMap.get(tool.server) ?? [];
        serverTools.push(tool);
        serverMap.set(tool.server, serverTools);
      }

      // Create server items
      return Array.from(serverMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([serverName, serverTools]) => {
          const item = new ToolTreeItem(
            serverName,
            vscode.TreeItemCollapsibleState.Collapsed,
            true,
            serverName,
          );
          item.description = `${serverTools.length} tools`;
          item.iconPath = new vscode.ThemeIcon("server-process");
          return item;
        });
    }

    // Child level: show tools for a server
    if (element.isServer && element.serverName) {
      const tools = await this.daemonClient.getTools();
      const serverTools = tools.filter((t) => t.server === element.serverName);

      // Apply filter
      const filteredTools = this.filterQuery
        ? serverTools.filter(
            (t) =>
              t.name.toLowerCase().includes(this.filterQuery) ||
              t.description?.toLowerCase().includes(this.filterQuery),
          )
        : serverTools;

      return filteredTools.map((tool) => {
        // Extract tool name without server prefix
        const shortName = tool.name.replace(`${element.serverName}__`, "");
        const item = new ToolTreeItem(
          shortName,
          vscode.TreeItemCollapsibleState.None,
          false,
          element.serverName,
          tool,
        );
        item.description = tool.description ?? "";
        item.iconPath = new vscode.ThemeIcon("symbol-method");
        item.tooltip = this.buildToolTooltip(tool, shortName);
        return item;
      });
    }

    return [];
  }

  private buildToolTooltip(tool: DaemonToolInfo, shortName: string): vscode.MarkdownString {
    const lines: string[] = [
      `**${shortName}**`,
      "",
      `Server: \`${tool.server}\``,
      `Full name: \`${tool.name}\``,
    ];
    if (tool.description) {
      lines.push("", tool.description);
    }
    const tooltip = new vscode.MarkdownString(lines.join("\n"));
    tooltip.isTrusted = true;
    return tooltip;
  }
}

function buildServerTooltip(
  serverName: string,
  registryServer?: RegistryServer,
  hubInfo?: HubServerInfo,
  daemonInfo?: DaemonServerInfo,
): vscode.MarkdownString {
  const lines: string[] = [`**${serverName}**`];
  const base = registryServer?.common ?? {};
  if (base.description) {
    lines.push(base.description);
  } else if (hubInfo?.description) {
    lines.push(hubInfo.description);
  } else if (daemonInfo?.description) {
    lines.push(daemonInfo.description);
  }

  // Daemon status
  if (daemonInfo) {
    const status = daemonInfo.running ? "$(circle-filled) **Running**" : "$(circle-outline) Idle (lazy-loaded)";
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

  const secrets = await loadSecretsFromEnvFile();

  if (!env.MORPH_API_KEY) {
    const morphFromEnv = process.env.MORPH_API_KEY ?? secrets["MORPH_API_KEY"];
    if (morphFromEnv) {
      env.MORPH_API_KEY = morphFromEnv;
      resolved.add("MORPH_API_KEY");
      missing.delete("MORPH_API_KEY");
    } else {
      missing.add("MORPH_API_KEY");
    }
  }

  if (!env.QDRANT_API_KEY) {
    // Use MORPH_API_KEY as fallback for QDRANT_API_KEY
    const qdrantSecret = secrets["QDRANT_API_KEY"] ?? secrets["MORPH_API_KEY"];
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
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, any> };
    const resolvedSecrets: string[] = [];
    const missingSecrets: string[] = [];

    if (parsed.mcpServers) {
      await Promise.all(
        Object.entries(parsed.mcpServers).map(async ([serverName, serverConfig]) => {
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
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      const servers = parsed.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : {};
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

// Cache for secrets loaded from env file
let secretsCache: Record<string, string> | null = null;

async function loadSecretsFromEnvFile(): Promise<Record<string, string>> {
  if (secretsCache !== null) {
    return secretsCache;
  }

  secretsCache = {};
  const envFilePath = path.join(os.homedir(), ".config", "secrets", "ai.env");

  try {
    const content = await fsp.readFile(envFilePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      // Handle "export VAR=value" or "VAR=value"
      const match = trimmed.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?$/i);
      if (match) {
        secretsCache[match[1]] = match[2];
      }
    }
  } catch (error) {
    // File doesn't exist or can't be read, that's fine
  }

  return secretsCache;
}

async function resolvePlaceholder(value: string): Promise<string | undefined> {
  // Handle ${keychain:VAR} - read from env file instead of keychain
  const keychainMatch = value.match(/^\$\{keychain:([^}]+)}$/);
  if (keychainMatch) {
    const secrets = await loadSecretsFromEnvFile();
    const varName = keychainMatch[1];
    // Try exact match first, then common aliases
    if (secrets[varName]) {
      return secrets[varName];
    }
    // Handle GITLAB_PERSONAL_ACCESS_TOKEN -> GITLAB_PAT alias
    if (varName === "GITLAB_PERSONAL_ACCESS_TOKEN" && secrets["GITLAB_PAT"]) {
      return secrets["GITLAB_PAT"];
    }
    // Handle GRAFANA_API_TOKEN -> GRAFANA_API_KEY alias
    if (varName === "GRAFANA_API_TOKEN" && secrets["GRAFANA_API_KEY"]) {
      return secrets["GRAFANA_API_KEY"];
    }
    // Handle QDRANT_API_KEY and MORPH_QDRANT_API_KEY from MORPH_API_KEY
    if ((varName === "QDRANT_API_KEY" || varName === "MORPH_QDRANT_API_KEY") && secrets["MORPH_API_KEY"]) {
      return secrets["MORPH_API_KEY"];
    }
    return undefined;
  }

  // Handle ${env:VAR} or ${env:VAR:-default}
  const envMatch = value.match(/^\$\{env:([^}:]+)(:-([^}]*))?}$/);
  if (envMatch) {
    const envKey = envMatch[1];
    const defaultValue = envMatch[3];
    // Check process.env first
    const envValue = process.env[envKey];
    if (envValue !== undefined) {
      return envValue;
    }
    // Then check secrets file
    const secrets = await loadSecretsFromEnvFile();
    if (secrets[envKey]) {
      return secrets[envKey];
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

