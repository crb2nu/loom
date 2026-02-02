import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

import * as vscode from "vscode";

import { DaemonClient, SkillsClient, AgentContextClient, PlatformConfigClient } from "./clients";
import {
  registerAllCommands,
  CommandContext,
  registerSkillsCommands,
  registerAgentContextCommands,
  registerServerHealthCommands,
} from "./commands";
import { registerPlatformCommands } from "./commands/platforms";
import { HUB_REFRESH_INTERVAL_MS } from "./constants";
import {
  ConfigSyncManager,
  HubStatusManager,
  AgentSessionManager,
  AnnotationDecorationManager,
  ServerMetricsManager,
  ProfileManager,
  SkillRecommendationManager,
} from "./managers";
import { DeepSearchManager, SearchResult } from "./managers/deepSearch";
import {
  RegistryProvider,
  SecretsProvider,
  ServerProvider,
  ToolProvider,
  SkillsProvider,
  AgentContextProvider,
  TasksProvider,
  PlatformsProvider,
} from "./providers";
import {
  deriveHubSettings,
  findRegistryPath,
  watchRegistry,
  writeDaemonConfig,
} from "./utils/config";
import { getPythonExecutable } from "./utils/helpers";
import { detectPlatform, getPlatformStatusText } from "./utils/platform";
import { ContextGraphPanel } from "./webviews/ContextGraphPanel";
import { KnowledgeGraphPanel } from "./webviews/KnowledgeGraphPanel";
import { MemoryDashboardPanel } from "./webviews/MemoryDashboardPanel";
import { SyncDashboardPanel } from "./webviews/SyncDashboardPanel";

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

  // ============================================================================
  // Platform Configuration Integration
  // ============================================================================
  const detectedPlatform = detectPlatform();
  loomChannel.appendLine(
    `[${new Date().toISOString()}] Detected platform: ${getPlatformStatusText()} (${detectedPlatform})`
  );

  const platformConfigClient = new PlatformConfigClient(workspaceRoot, loomChannel);
  context.subscriptions.push(platformConfigClient);

  const platformsProvider = new PlatformsProvider(platformConfigClient);
  const platformsTree = vscode.window.createTreeView("loomPlatforms", {
    treeDataProvider: platformsProvider,
  });
  context.subscriptions.push(platformsTree);

  // Check sync status on startup if configured
  const syncOnStartup =
    vscode.workspace.getConfiguration("loom").get<boolean>("syncOnStartup") ?? false;
  if (syncOnStartup) {
    void platformConfigClient.checkAllSyncStatus().then(() => {
      loomChannel.appendLine(
        `[${new Date().toISOString()}] Platform sync status checked on startup`
      );
    });
  }

  // Register platform commands
  const platformCommandDisposables = registerPlatformCommands({
    workspaceRoot,
    loomChannel,
    platformConfigClient,
    platformsProvider,
  });
  context.subscriptions.push(...platformCommandDisposables);

  // Sync dashboard command
  context.subscriptions.push(
    vscode.commands.registerCommand("loom.showSyncDashboard", () => {
      SyncDashboardPanel.render(context.extensionUri, platformConfigClient);
    })
  );

  // Deep Search
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
          const results: SearchResult[] = await deepSearchManager.search(query);

          // Simple output for now - create a new untitled document with JSON results
          // Long term: Use a Webview or QuickPick
          const content = results
            .map(
              (r: SearchResult) =>
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
      ContextGraphPanel.render(context.extensionUri);

      // Initial update
      if (ContextGraphPanel.currentPanel) {
        void registryProvider.getRegistrySnapshot().then((registry) => {
          ContextGraphPanel.currentPanel?.updateGraph(registry, hubStatusManager.getStatus());
        });
      }
    })
  );

  // ============================================================================
  // Skills Integration
  // ============================================================================
  const skillsClient = new SkillsClient(loomChannel);
  skillsClient.initialize(workspaceRoot);
  context.subscriptions.push({ dispose: () => skillsClient.dispose() });

  // Skill recommendation manager for context-aware suggestions
  const skillRecommendationManager = new SkillRecommendationManager(loomChannel, skillsClient);
  if (workspaceRoot) {
    skillRecommendationManager.initialize(workspaceRoot);
  }
  context.subscriptions.push({ dispose: () => skillRecommendationManager.dispose() });

  // Wire up file change events to update recommendations
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      skillRecommendationManager.onFileChange(doc.uri);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      skillRecommendationManager.onFileChange(doc.uri);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        skillRecommendationManager.onFileChange(editor.document.uri);
      }
    })
  );

  // Wire up diagnostic events for error-based recommendations
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((e) => {
      for (const uri of e.uris) {
        const diagnostics = vscode.languages.getDiagnostics(uri);
        for (const diag of diagnostics) {
          if (diag.severity === vscode.DiagnosticSeverity.Error) {
            skillRecommendationManager.onError(diag.message);
          }
        }
      }
    })
  );

  const skillsProvider = new SkillsProvider(skillsClient, skillRecommendationManager);
  const skillsTree = vscode.window.createTreeView("loomSkills", {
    treeDataProvider: skillsProvider,
  });
  context.subscriptions.push(skillsTree);

  const skillsCommandDisposables = registerSkillsCommands({
    workspaceRoot,
    loomChannel,
    skillsClient,
    skillsProvider,
  });
  context.subscriptions.push(...skillsCommandDisposables);

  // ============================================================================
  // Agent Context Integration
  // ============================================================================
  const agentId = vscode.workspace.getConfiguration("loom").get<string>("agentId") ?? "vscode-loom";
  const agentContextClient = new AgentContextClient(workspaceRoot, loomChannel, agentId);

  const agentSessionManager = new AgentSessionManager(
    agentContextClient,
    loomChannel,
    context.workspaceState
  );
  context.subscriptions.push(agentSessionManager);

  const agentContextProvider = new AgentContextProvider(agentContextClient, agentSessionManager);
  const agentContextTree = vscode.window.createTreeView("loomAgentContext", {
    treeDataProvider: agentContextProvider,
  });
  context.subscriptions.push(agentContextTree);

  const tasksProvider = new TasksProvider(agentContextClient, agentSessionManager);
  const tasksTree = vscode.window.createTreeView("loomTasks", {
    treeDataProvider: tasksProvider,
  });
  context.subscriptions.push(tasksTree);

  const annotationDecorationManager = new AnnotationDecorationManager(agentContextClient);
  context.subscriptions.push(annotationDecorationManager);

  // Set initial annotation decoration state from config
  const showAnnotations =
    vscode.workspace.getConfiguration("loom").get<boolean>("showAnnotationDecorations") ?? true;
  annotationDecorationManager.setEnabled(showAnnotations);

  const agentContextCommandDisposables = registerAgentContextCommands({
    workspaceRoot,
    loomChannel,
    agentContextClient,
    agentSessionManager,
    agentContextProvider,
    tasksProvider,
    extensionContext: context,
  });
  context.subscriptions.push(...agentContextCommandDisposables);

  // Knowledge Graph and Memory Dashboard commands
  context.subscriptions.push(
    vscode.commands.registerCommand("loom.showKnowledgeGraph", async () => {
      const panel = KnowledgeGraphPanel.render(context.extensionUri);
      const graphData = await agentContextClient.getKnowledgeGraph();
      panel.updateGraph(graphData);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.showMemoryDashboard", async () => {
      const sessionId = agentSessionManager.getSessionId();
      const panel = MemoryDashboardPanel.render(context.extensionUri);
      const tiers = await agentContextClient.getMemoryTiers(sessionId);
      panel.updateTiers(tiers);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.toggleAnnotations", () => {
      const enabled = annotationDecorationManager.toggle();
      vscode.window.showInformationMessage(`Code annotations ${enabled ? "enabled" : "disabled"}`);
    })
  );

  // ============================================================================
  // Server Health Integration
  // ============================================================================
  const serverMetricsManager = new ServerMetricsManager(
    daemonClient,
    hubStatusManager,
    loomChannel
  );
  context.subscriptions.push(serverMetricsManager);

  const profileManager = new ProfileManager(hubStatusManager, daemonClient, loomChannel);
  context.subscriptions.push(profileManager);

  const serverHealthCommandDisposables = registerServerHealthCommands({
    loomChannel,
    serverMetricsManager,
    profileManager,
    extensionContext: context,
  });
  context.subscriptions.push(...serverHealthCommandDisposables);

  // Auto-start session if configured
  const autoStartSession =
    vscode.workspace.getConfiguration("loom").get<boolean>("autoStartSession") ?? false;
  if (autoStartSession && workspaceFolder) {
    const namespace = `workspace/${workspaceFolder.name}`;
    void agentSessionManager.startSession(namespace, "Auto-started session");
  }
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
