import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

import * as vscode from "vscode";

import { DaemonClient } from "./clients/daemon";
import { registerAllCommands, CommandContext } from "./commands";
import { HUB_REFRESH_INTERVAL_MS } from "./constants";
import { ConfigSyncManager, HubStatusManager } from "./managers";
import { RegistryProvider, SecretsProvider, ServerProvider, ToolProvider } from "./providers";
import {
  deriveHubSettings,
  findRegistryPath,
  watchRegistry,
  writeDaemonConfig,
} from "./utils/config";
import { getPythonExecutable } from "./utils/helpers";

const execFileAsync = promisify(execFile);

// eslint-disable-next-line @typescript-eslint/require-await -- uses void for fire-and-forget async operations
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
          `[${new Date().toISOString()}] Hub settings updated (url=${next.hubUrl}, profile=${next.profile})`
        );
        // Write daemon config file so daemon can pick up changes on restart
        void writeDaemonConfig(next).then(() => {
          loomChannel.appendLine(
            `[${new Date().toISOString()}] Daemon config written to ~/.config/loom/config.yaml`
          );
        });
      }
    })
  );

  // Find registry - check home directory first
  const registryPath = findRegistryPath(workspaceRoot);

  const registryProvider = new RegistryProvider(
    workspaceRoot,
    registryPath,
    context.workspaceState,
    hubStatusManager
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

  let syncTimeout: NodeJS.Timeout | undefined;

  const watcher = registryPath
    ? watchRegistry(workspaceRoot, registryPath, () => {
        // Refresh UI immediately
        registryProvider.refresh();
        serverProvider.refresh();

        // Debounce sync trigger to avoid multiple runs during file writes
        if (syncTimeout) {
          clearTimeout(syncTimeout);
        }
        syncTimeout = setTimeout(() => {
          void vscode.commands.executeCommand("loom.syncConfigs");
          syncTimeout = undefined;
        }, 1000); // Wait 1s for file write to settle
      })
    : undefined;
  if (watcher) {
    context.subscriptions.push({
      dispose: () => {
        watcher.close();
        if (syncTimeout) {
          clearTimeout(syncTimeout);
        }
      },
    });
  }

  if (workspaceRoot) {
    void ensureServersOnStartup(pythonExecutable, workspaceRoot, loomChannel);
  }

  // Config sync drift detection
  const configSyncManager = new ConfigSyncManager(workspaceRoot, loomChannel);
  context.subscriptions.push(configSyncManager);
  void configSyncManager.checkSync();

  // Re-check sync status after configs are synced
  context.subscriptions.push(
    configSyncManager.onDidChange((state) => {
      if (state.status === "out-of-sync") {
        const autoSync = vscode.workspace.getConfiguration("loom").get<string>("autoSyncOnDrift");
        if (autoSync === "auto") {
          void vscode.commands.executeCommand("loom.syncConfigs");
        } else if (autoSync === "prompt") {
          void vscode.window
            .showWarningMessage("Loom: MCP configs are out of sync", "Sync Now", "Dismiss")
            .then((choice) => {
              if (choice === "Sync Now") {
                void vscode.commands.executeCommand("loom.syncConfigs");
              }
            });
        }
      }
    })
  );

  // Secrets tree view provider
  const secretsProvider = new SecretsProvider(workspaceRoot, loomChannel);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("loomSecrets", secretsProvider)
  );

  // Deep Search
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DeepSearchManager } = require("./managers/deepSearch");
  const deepSearchManager = new DeepSearchManager(daemonClient, loomChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.deepSearch", async () => {
      const query = await vscode.window.showInputBox({
        prompt: "Search across all connected MCP servers",
        placeHolder: "Enter query (e.g. 'error handling', 'PR #123')",
      });

      if (!query) return;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Searching for "${query}"...`,
          cancellable: false,
        },
        async (_progress) => {
          const results: any[] = await deepSearchManager.search(query);

          // Simple output for now - create a new untitled document with JSON results
          // Long term: Use a Webview or QuickPick
          const content = results
            .map(
              (r: { source: string; tool: string; error?: string; data: any }) =>
                `## ${r.source.toUpperCase()} (${r.tool})\n${r.error ? `⚠️ Error: ${r.error}` : JSON.stringify(r.data, null, 2)}\n`
            )
            .join("\n---\n\n");

          const doc = await vscode.workspace.openTextDocument({
            content: `# Deep Search Results: "${query}"\n\n${content}`,
            language: "markdown",
          });
          await vscode.window.showTextDocument(doc);
        }
      );
    })
  );

  // Create command context with all dependencies
  const commandContext: CommandContext = {
    workspaceRoot,
    pythonExecutable,
    loomChannel,
    hubStatusManager,
    configSyncManager,
    daemonClient,
    registryProvider,
    serverProvider,
    toolProvider,
    secretsProvider,
    extensionContext: context,
  };

  // Register all commands
  const commandDisposables = registerAllCommands(commandContext);
  context.subscriptions.push(...commandDisposables);

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.showContextGraph", () => {
      const { ContextGraphPanel } = require("./webviews/ContextGraphPanel");
      ContextGraphPanel.render(context.extensionUri);

      // Initial update
      if (ContextGraphPanel.currentPanel) {
        void registryProvider.getRegistrySnapshot().then((registry) => {
          ContextGraphPanel.currentPanel?.updateGraph(registry, hubStatusManager.getStatus());
        });
      }
    })
  );
}

export function deactivate() {
  // no-op for now
}

async function ensureServersOnStartup(
  pythonExecutable: string,
  workspaceRoot: string,
  channel: vscode.OutputChannel
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
      { cwd: workspaceRoot }
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
