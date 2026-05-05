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
  MillsStatusManager,
  MillsAlertingManager,
  AgentSessionManager,
  AnnotationDecorationManager,
  ServerMetricsManager,
  ProfileManager,
  SkillRecommendationManager,
  PluginManager,
  RemoteTunnelManager,
  UsageAnalyticsManager,
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
  MillsTreeProvider,
} from "./providers";
import { HubStatusSnapshot } from "./types";
import {
  deriveHubSettings,
  deriveMillsConfig,
  findRegistryPath,
  watchRegistry,
  writeDaemonConfig,
} from "./utils/config";
import { ConfigManager } from "./utils/configManager";
import { getPythonExecutable } from "./utils/helpers";
import { Logger } from "./utils/logger";
import { MillsTokenStore } from "./utils/millsToken";
import { detectPlatform, getPlatformStatusText } from "./utils/platform";
import { ContextGraphPanel } from "./webviews/ContextGraphPanel";
import { KnowledgeGraphPanel } from "./webviews/KnowledgeGraphPanel";
import { MemoryDashboardPanel } from "./webviews/MemoryDashboardPanel";
import { OnboardingPanel } from "./webviews/OnboardingPanel";
import { ServerHealthPanel } from "./webviews/ServerHealthPanel";
import { SyncDashboardPanel } from "./webviews/SyncDashboardPanel";

const execFileAsync = promisify(execFile);

// ============================================================================
// Activation Environment — shared context passed between setup functions
// ============================================================================

interface ActivationEnvironment {
  workspaceRoot: string;
  workspaceFolder: vscode.WorkspaceFolder | undefined;
  pythonExecutable: string;
  loomChannel: vscode.OutputChannel;
  logger: Logger;
  configManager: ConfigManager;
  hubStatusManager: HubStatusManager;
  daemonClient: DaemonClient;
  registryProvider: RegistryProvider;
  serverProvider: ServerProvider;
  toolProvider: ToolProvider;
  secretsProvider: SecretsProvider;
  configSyncManager: ConfigSyncManager;
  platformConfigClient: PlatformConfigClient;
  skillsClient: SkillsClient;
  agentContextClient: AgentContextClient;
  agentSessionManager: AgentSessionManager;
  annotationDecorationManager: AnnotationDecorationManager;
  usageAnalyticsManager: UsageAnalyticsManager;
  remoteTunnelManager: RemoteTunnelManager;
  profileManager: ProfileManager;
}

// ============================================================================
// Setup Functions
// ============================================================================

function initializeEnvironment(
  context: vscode.ExtensionContext
): Pick<
  ActivationEnvironment,
  | "workspaceRoot"
  | "workspaceFolder"
  | "pythonExecutable"
  | "loomChannel"
  | "logger"
  | "configManager"
> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceRoot = workspaceFolder?.uri.fsPath ?? "";
  const pythonExecutable = getPythonExecutable();

  // Single consolidated output channel for all Loom operations
  const loomChannel = vscode.window.createOutputChannel("Loom");
  context.subscriptions.push(loomChannel);

  // Root logger for all Loom operations
  const logger = new Logger(loomChannel, "Loom");

  // Centralized configuration manager for all loom.* settings
  const configManager = new ConfigManager();
  context.subscriptions.push(configManager);

  return { workspaceRoot, workspaceFolder, pythonExecutable, loomChannel, logger, configManager };
}

function registerHubIntegration(
  loomChannel: vscode.OutputChannel,
  logger: Logger,
  context: vscode.ExtensionContext
): HubStatusManager {
  const hubLogger = logger.child("Hub");
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
        hubLogger.info(`Hub settings updated (url=${next.hubUrl}, profile=${next.profile})`);
        // Write daemon config file so daemon can pick up changes on restart
        void writeDaemonConfig(next).then(() => {
          hubLogger.info("Daemon config written to ~/.config/loom/config.yaml");
        });
      }
    })
  );

  return hubStatusManager;
}

function registerMillsIntegration(
  loomChannel: vscode.OutputChannel,
  logger: Logger,
  context: vscode.ExtensionContext
): {
  millsStatusManager: MillsStatusManager;
  millsTreeProvider: MillsTreeProvider;
  millsAlertingManager: MillsAlertingManager;
} {
  const millsLogger = logger.child("Mills");
  const initial = deriveMillsConfig();
  const settings = {
    hudBaseUrl: initial.hudBaseUrl,
    cfAccessClientId: initial.cfAccessClientId,
    cfAccessClientSecret: initial.cfAccessClientSecret,
  };
  const manager = new MillsStatusManager(settings, initial.refreshIntervalMs, loomChannel);
  context.subscriptions.push(manager);
  manager.start();

  const treeProvider = new MillsTreeProvider(settings, loomChannel);
  const treeView = vscode.window.createTreeView("loomMills", {
    treeDataProvider: treeProvider,
  });
  context.subscriptions.push(treeView);

  const alertingManager = new MillsAlertingManager(
    settings,
    initial.alertingIntervalMs,
    manager,
    loomChannel
  );
  context.subscriptions.push(alertingManager);
  alertingManager.start();

  // Refresh tree whenever the status manager learns of a change
  // (paused → ok, regression count moved, etc.).
  context.subscriptions.push(
    manager.onDidChange(() => {
      treeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("loom.mills.hudBaseUrl") ||
        event.affectsConfiguration("loom.mills.refreshIntervalMs") ||
        event.affectsConfiguration("loom.mills.alertingIntervalMs")
      ) {
        const next = deriveMillsConfig();
        const nextSettings = {
          hudBaseUrl: next.hudBaseUrl,
          cfAccessClientId: next.cfAccessClientId,
          cfAccessClientSecret: next.cfAccessClientSecret,
        };
        manager.updateSettings(nextSettings, next.refreshIntervalMs);
        treeProvider.updateSettings(nextSettings);
        alertingManager.updateSettings(nextSettings, next.alertingIntervalMs);
        millsLogger.info(
          `Mills settings updated (hudBaseUrl=${next.hudBaseUrl || "<empty>"}, refreshMs=${next.refreshIntervalMs}, alertMs=${next.alertingIntervalMs})`
        );
      }
    })
  );

  return {
    millsStatusManager: manager,
    millsTreeProvider: treeProvider,
    millsAlertingManager: alertingManager,
  };
}

function registerRegistryAndServers(
  env: Pick<
    ActivationEnvironment,
    "workspaceRoot" | "pythonExecutable" | "loomChannel" | "hubStatusManager"
  >,
  context: vscode.ExtensionContext
): {
  registryProvider: RegistryProvider;
  serverProvider: ServerProvider;
  toolProvider: ToolProvider;
  daemonClient: DaemonClient;
} {
  // Find registry - check home directory first
  const registryPath = findRegistryPath(env.workspaceRoot);

  const registryProvider = new RegistryProvider(
    env.workspaceRoot,
    registryPath,
    context.workspaceState,
    env.hubStatusManager
  );
  const registryTree = vscode.window.createTreeView("loomHubOverview", {
    treeDataProvider: registryProvider,
  });
  context.subscriptions.push(registryTree);

  // Create daemon client for server status queries
  const daemonClient = new DaemonClient(env.workspaceRoot, env.loomChannel);

  const serverProvider = new ServerProvider(registryProvider, env.hubStatusManager, daemonClient);
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
    ? watchRegistry(env.workspaceRoot, registryPath, () => {
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

  if (env.workspaceRoot) {
    void ensureServersOnStartup(env.pythonExecutable, env.workspaceRoot, env.loomChannel);
  }

  return { registryProvider, serverProvider, toolProvider, daemonClient };
}

function registerConfigSync(
  env: Pick<
    ActivationEnvironment,
    "workspaceRoot" | "loomChannel" | "configManager" | "hubStatusManager"
  >,
  context: vscode.ExtensionContext
): { configSyncManager: ConfigSyncManager; secretsProvider: SecretsProvider } {
  // Config sync drift detection
  const configSyncManager = new ConfigSyncManager(env.workspaceRoot, env.loomChannel);
  context.subscriptions.push(configSyncManager);
  void configSyncManager.checkSync();

  // Re-check sync status after configs are synced
  context.subscriptions.push(
    configSyncManager.onDidChange((state) => {
      if (state.status === "out-of-sync") {
        const autoSync = env.configManager.get("autoSyncOnDrift");
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

  // Keep offline mode in sync with hub connectivity.
  context.subscriptions.push(
    env.hubStatusManager.onDidChange(() => {
      const snapshot = env.hubStatusManager.getStatus();
      const { mode, reason } = getOfflineModeFromHub(snapshot);
      configSyncManager.setOfflineMode(mode, reason);
    })
  );

  // Secrets tree view provider
  const secretsProvider = new SecretsProvider(env.workspaceRoot, env.loomChannel);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("loomSecrets", secretsProvider)
  );

  return { configSyncManager, secretsProvider };
}

function getOfflineModeFromHub(snapshot: HubStatusSnapshot): {
  mode: "online" | "offline" | "degraded";
  reason?: string;
} {
  if (snapshot.error) {
    if (isConnectivityFailure(snapshot.error)) {
      return { mode: "offline", reason: snapshot.error };
    }
    return { mode: "degraded", reason: snapshot.error };
  }

  if (snapshot.readiness && snapshot.readiness.ready === false) {
    return { mode: "degraded", reason: snapshot.readiness.error ?? "Hub not ready" };
  }

  if (snapshot.health?.status && snapshot.health.status !== "ok") {
    return { mode: "degraded", reason: `Hub health: ${snapshot.health.status}` };
  }

  return { mode: "online", reason: undefined };
}

function isConnectivityFailure(message: string): boolean {
  const text = message.toLowerCase();
  return [
    "econnrefused",
    "enotfound",
    "etimedout",
    "timed out",
    "network",
    "socket",
    "connect",
    "offline",
    "unable to fetch",
    "fetch failed",
  ].some((pattern) => text.includes(pattern));
}

// ============================================================================
// Platform Configuration Integration
// ============================================================================
function registerPlatforms(
  env: Pick<ActivationEnvironment, "workspaceRoot" | "loomChannel" | "configManager">,
  context: vscode.ExtensionContext
): PlatformConfigClient {
  const platformLogger = new Logger(env.loomChannel, "Platform");
  const detectedPlatform = detectPlatform();
  platformLogger.info(`Detected platform: ${getPlatformStatusText()} (${detectedPlatform})`);

  const platformConfigClient = new PlatformConfigClient(
    env.workspaceRoot,
    env.loomChannel,
    env.configManager
  );
  context.subscriptions.push(platformConfigClient);

  const platformsProvider = new PlatformsProvider(platformConfigClient);
  const platformsTree = vscode.window.createTreeView("loomPlatforms", {
    treeDataProvider: platformsProvider,
  });
  context.subscriptions.push(platformsTree);

  // Check sync status on startup if configured
  const syncOnStartup = env.configManager.get("syncOnStartup");
  if (syncOnStartup) {
    void platformConfigClient.checkAllSyncStatus().then(() => {
      platformLogger.info("Platform sync status checked on startup");
    });
  }

  // Register platform commands
  const platformCommandDisposables = registerPlatformCommands({
    workspaceRoot: env.workspaceRoot,
    loomChannel: env.loomChannel,
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

  return platformConfigClient;
}

// ============================================================================
// Onboarding Wizard
// ============================================================================
function registerOnboarding(
  env: Pick<
    ActivationEnvironment,
    "workspaceRoot" | "configManager" | "daemonClient" | "platformConfigClient" | "profileManager"
  >,
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("loom.showOnboarding", () => {
      OnboardingPanel.render(
        context.extensionUri,
        env.platformConfigClient,
        env.daemonClient,
        env.profileManager,
        env.workspaceRoot
      );
    })
  );

  // Check if first run - show onboarding prompt
  const hasCompletedOnboarding = env.configManager.get("onboardingComplete");

  if (!hasCompletedOnboarding) {
    // Delay prompt slightly to let extension activate
    setTimeout(() => {
      void vscode.window
        .showInformationMessage(
          "Welcome to Loom! Would you like to run the setup wizard?",
          "Yes, Set Up",
          "Skip for Now"
        )
        .then((result) => {
          if (result === "Yes, Set Up") {
            void vscode.commands.executeCommand("loom.showOnboarding");
          }
        });
    }, 2000);
  }
}

// Deep Search
function registerDeepSearch(
  env: Pick<ActivationEnvironment, "daemonClient" | "loomChannel">,
  context: vscode.ExtensionContext
): void {
  const deepSearchManager = new DeepSearchManager(env.daemonClient, env.loomChannel);

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
          const successCount = results.filter((result) => result.status === "ok").length;

          const content = results
            .map((result: SearchResult) => formatDeepSearchResult(result))
            .join("\n---\n\n");

          const doc = await vscode.workspace.openTextDocument({
            content: [
              `# Deep Search Results: "${query}"`,
              "",
              `Summary: ${successCount}/${results.length} tools succeeded`,
              "",
              content || "_No results_",
            ].join("\n"),
            language: "markdown",
          });
          await vscode.window.showTextDocument(doc);
        }
      );
    })
  );
}

function formatDeepSearchResult(result: SearchResult): string {
  const status = result.status === "ok" ? "ok" : "error";
  const latency = result.durationMs !== undefined ? `${result.durationMs}ms` : "n/a";
  const count = result.resultCount !== undefined ? String(result.resultCount) : "n/a";
  const executedAt = result.executedAt ? result.executedAt.toISOString() : "n/a";
  const snippet = result.snippet ?? "n/a";

  const lines = [
    `## ${result.source.toUpperCase()} (${result.tool})`,
    `- Status: ${status}`,
    `- Latency: ${latency}`,
    `- Result count: ${count}`,
    `- Executed at: ${executedAt}`,
    `- Snippet: ${snippet}`,
  ];

  if (result.error) {
    lines.push("", `⚠️ Error: ${result.error}`);
    return lines.join("\n");
  }

  const rawPayload = (() => {
    try {
      return JSON.stringify(result.data, null, 2);
    } catch {
      return String(result.data);
    }
  })();

  lines.push("", "```json", rawPayload, "```");
  return lines.join("\n");
}

function registerCoreCommands(
  env: Pick<
    ActivationEnvironment,
    | "workspaceRoot"
    | "pythonExecutable"
    | "loomChannel"
    | "hubStatusManager"
    | "configSyncManager"
    | "daemonClient"
    | "registryProvider"
    | "serverProvider"
    | "toolProvider"
    | "secretsProvider"
    | "usageAnalyticsManager"
    | "remoteTunnelManager"
    | "agentContextClient"
    | "agentSessionManager"
  > & {
    millsStatusManager?: MillsStatusManager;
    millsTreeProvider?: MillsTreeProvider;
    millsTokenStore?: MillsTokenStore;
  },
  context: vscode.ExtensionContext
): void {
  // Create command context with all dependencies
  const commandContext: CommandContext = {
    workspaceRoot: env.workspaceRoot,
    pythonExecutable: env.pythonExecutable,
    loomChannel: env.loomChannel,
    hubStatusManager: env.hubStatusManager,
    millsStatusManager: env.millsStatusManager,
    millsTreeProvider: env.millsTreeProvider,
    millsTokenStore: env.millsTokenStore,
    configSyncManager: env.configSyncManager,
    daemonClient: env.daemonClient,
    registryProvider: env.registryProvider,
    serverProvider: env.serverProvider,
    toolProvider: env.toolProvider,
    secretsProvider: env.secretsProvider,
    usageAnalyticsManager: env.usageAnalyticsManager,
    remoteTunnelManager: env.remoteTunnelManager,
    extensionContext: context,
    agentContextClient: env.agentContextClient,
    agentSessionManager: env.agentSessionManager,
  };

  // Register all commands
  const commandDisposables = registerAllCommands(commandContext);
  context.subscriptions.push(...commandDisposables);

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.showContextGraph", () => {
      ContextGraphPanel.render(context.extensionUri);

      // Initial update
      if (ContextGraphPanel.currentPanel) {
        void env.registryProvider.getRegistrySnapshot().then((registry) => {
          ContextGraphPanel.currentPanel?.updateGraph(registry, env.hubStatusManager.getStatus());
        });
      }
    })
  );
}

function registerUsageAnalytics(
  env: Pick<ActivationEnvironment, "daemonClient" | "loomChannel">,
  context: vscode.ExtensionContext
): UsageAnalyticsManager {
  const usageAnalyticsManager = new UsageAnalyticsManager(
    env.daemonClient,
    context.workspaceState,
    env.loomChannel
  );
  context.subscriptions.push(usageAnalyticsManager);
  return usageAnalyticsManager;
}

function registerRemoteTunnels(
  env: Pick<ActivationEnvironment, "workspaceRoot" | "configManager" | "loomChannel">,
  context: vscode.ExtensionContext
): RemoteTunnelManager {
  const remoteTunnelManager = new RemoteTunnelManager(
    env.workspaceRoot,
    env.configManager,
    env.loomChannel
  );
  context.subscriptions.push(remoteTunnelManager);
  return remoteTunnelManager;
}

// ============================================================================
// Skills Integration
// ============================================================================
function registerSkillsIntegration(
  env: Pick<ActivationEnvironment, "workspaceRoot" | "loomChannel" | "configManager">,
  context: vscode.ExtensionContext
): SkillsClient {
  const skillsClient = new SkillsClient(env.loomChannel);
  skillsClient.initialize(
    env.workspaceRoot,
    undefined,
    env.configManager.get("skillsRegistryPath")
  );
  context.subscriptions.push({ dispose: () => skillsClient.dispose() });

  // Skill recommendation manager for context-aware suggestions
  const skillRecommendationManager = new SkillRecommendationManager(env.loomChannel, skillsClient);
  if (env.workspaceRoot) {
    skillRecommendationManager.initialize(env.workspaceRoot);
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
    workspaceRoot: env.workspaceRoot,
    loomChannel: env.loomChannel,
    skillsClient,
    skillsProvider,
    configManager: env.configManager,
  });
  context.subscriptions.push(...skillsCommandDisposables);

  return skillsClient;
}

// ============================================================================
// Agent Context Integration
// ============================================================================
function registerAgentContext(
  env: Pick<ActivationEnvironment, "workspaceRoot" | "loomChannel" | "configManager">,
  context: vscode.ExtensionContext
): {
  agentContextClient: AgentContextClient;
  agentSessionManager: AgentSessionManager;
  annotationDecorationManager: AnnotationDecorationManager;
} {
  const agentId = env.configManager.get("agentId");
  const agentContextClient = new AgentContextClient(env.workspaceRoot, env.loomChannel, agentId);

  const agentSessionManager = new AgentSessionManager(
    agentContextClient,
    env.loomChannel,
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
  const showAnnotations = env.configManager.get("showAnnotationDecorations");
  annotationDecorationManager.setEnabled(showAnnotations);

  const agentContextCommandDisposables = registerAgentContextCommands({
    workspaceRoot: env.workspaceRoot,
    loomChannel: env.loomChannel,
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

  return { agentContextClient, agentSessionManager, annotationDecorationManager };
}

// ============================================================================
// Server Health Integration
// ============================================================================
function registerServerHealth(
  env: Pick<
    ActivationEnvironment,
    "configManager" | "daemonClient" | "hubStatusManager" | "loomChannel" | "workspaceRoot"
  >,
  context: vscode.ExtensionContext
): ProfileManager {
  const serverMetricsManager = new ServerMetricsManager(
    env.daemonClient,
    env.hubStatusManager,
    env.loomChannel,
    env.configManager.get("serverMetricsInterval")
  );
  context.subscriptions.push(serverMetricsManager);

  const profileManager = new ProfileManager(
    env.hubStatusManager,
    env.daemonClient,
    env.workspaceRoot,
    env.loomChannel,
    env.configManager
  );
  context.subscriptions.push(profileManager);

  const serverHealthCommandDisposables = registerServerHealthCommands({
    loomChannel: env.loomChannel,
    serverMetricsManager,
    profileManager,
    extensionContext: context,
  });
  context.subscriptions.push(...serverHealthCommandDisposables);
  return profileManager;
}

// ============================================================================
// Plugin System Integration
// ============================================================================
function registerPlugins(
  env: Pick<ActivationEnvironment, "workspaceRoot" | "loomChannel" | "configManager">,
  context: vscode.ExtensionContext
): void {
  const pluginLogger = new Logger(env.loomChannel, "Plugins");
  const pluginManager = new PluginManager({
    workspaceRoot: env.workspaceRoot,
    extensionContext: context,
    outputChannel: env.loomChannel,
    logger: pluginLogger,
  });
  context.subscriptions.push(pluginManager);

  const reloadConfiguredPlugins = () => {
    const pluginSpecs = env.configManager.get("plugins");
    void pluginManager.reloadConfiguredPlugins(pluginSpecs);
  };

  reloadConfiguredPlugins();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("loom.plugins")) {
        pluginLogger.info("Reloading plugins after configuration change");
        reloadConfiguredPlugins();
      }
    })
  );
}

function maybeAutoStartSession(
  env: Pick<ActivationEnvironment, "workspaceFolder" | "configManager" | "agentSessionManager">
): void {
  // Auto-start session if configured
  const autoStartSession = env.configManager.get("autoStartSession");
  if (autoStartSession && env.workspaceFolder) {
    const namespace = `workspace/${env.workspaceFolder.name}`;
    void env.agentSessionManager.startSession(namespace, "Auto-started session");
  }
}

// ============================================================================
// Activation Orchestrator
// ============================================================================

// eslint-disable-next-line @typescript-eslint/require-await -- uses void for fire-and-forget async operations
export async function activate(context: vscode.ExtensionContext) {
  const base = initializeEnvironment(context);

  const hubStatusManager = registerHubIntegration(base.loomChannel, base.logger, context);
  const { millsStatusManager, millsTreeProvider } = registerMillsIntegration(
    base.loomChannel,
    base.logger,
    context
  );
  const millsTokenStore = new MillsTokenStore(context.secrets);

  const { registryProvider, serverProvider, toolProvider, daemonClient } =
    registerRegistryAndServers({ ...base, hubStatusManager }, context);

  const usageAnalyticsManager = registerUsageAnalytics(
    { daemonClient, loomChannel: base.loomChannel },
    context
  );
  const remoteTunnelManager = registerRemoteTunnels(base, context);

  const { configSyncManager, secretsProvider } = registerConfigSync(
    { ...base, hubStatusManager },
    context
  );

  const platformConfigClient = registerPlatforms(base, context);
  const profileManager = registerServerHealth(
    {
      configManager: base.configManager,
      daemonClient,
      hubStatusManager,
      loomChannel: base.loomChannel,
      workspaceRoot: base.workspaceRoot,
    },
    context
  );

  registerOnboarding({ ...base, daemonClient, platformConfigClient, profileManager }, context);

  registerDeepSearch({ daemonClient, loomChannel: base.loomChannel }, context);

  registerSkillsIntegration(base, context);

  const { agentContextClient, agentSessionManager } = registerAgentContext(base, context);

  registerCoreCommands(
    {
      ...base,
      hubStatusManager,
      millsStatusManager,
      millsTreeProvider,
      millsTokenStore,
      configSyncManager,
      daemonClient,
      registryProvider,
      serverProvider,
      toolProvider,
      secretsProvider,
      usageAnalyticsManager,
      remoteTunnelManager,
      agentContextClient,
      agentSessionManager,
    },
    context
  );

  registerPlugins(
    {
      workspaceRoot: base.workspaceRoot,
      loomChannel: base.loomChannel,
      configManager: base.configManager,
    },
    context
  );

  maybeAutoStartSession({
    workspaceFolder: base.workspaceFolder,
    configManager: base.configManager,
    agentSessionManager,
  });
}

export function deactivate() {
  // Dispose any open webview panels
  // These panels maintain static currentPanel references that need explicit cleanup
  ContextGraphPanel.currentPanel?.dispose();
  KnowledgeGraphPanel.currentPanel?.dispose();
  MemoryDashboardPanel.currentPanel?.dispose();
  OnboardingPanel.currentPanel?.dispose();
  ServerHealthPanel.currentPanel?.dispose();
  SyncDashboardPanel.currentPanel?.dispose();
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

  const startupLogger = new Logger(channel, "Startup");
  channel.clear();
  startupLogger.info("ensure_mcp_servers.py --fix --refresh-zep-map");
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
