import { execFile } from "child_process";
import * as fs from "fs";
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import * as vscode from "vscode";
import { parse } from "yaml";

import { DaemonClient } from "./clients/daemon";
import { HUB_REFRESH_INTERVAL_MS, REGISTRY_PATH } from "./constants";
import { ConfigSyncManager, HubStatusManager } from "./managers";
import { RegistryProvider, SecretsProvider, ServerProvider, ToolProvider } from "./providers";
import { RegistryDocument, SnapshotEnvResult } from "./types";
import { resolveLoomBinary, resolveHubWrapperCommand } from "./utils/binary";
import {
  deriveHubSettings,
  findRegistryPath,
  loadVscodeConfigSnapshot,
  watchRegistry,
  writeDaemonConfig,
} from "./utils/config";
import { showActionableError } from "./utils/errors";
import {
  formatNameList,
  formatSyncStatus,
  getPythonExecutable,
  getStatusIcon,
} from "./utils/helpers";

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

  const watcher = registryPath
    ? watchRegistry(workspaceRoot, registryPath, () => {
        registryProvider.refresh();
        serverProvider.refresh();
      })
    : undefined;
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

  // Secrets tree view provider
  const secretsProvider = new SecretsProvider(workspaceRoot, loomChannel);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("loomSecrets", secretsProvider)
  );

  // Secrets commands
  context.subscriptions.push(
    vscode.commands.registerCommand("loom.listSecrets", async () => {
      const loomBinary = resolveLoomBinary(workspaceRoot);
      loomChannel.clear();
      loomChannel.appendLine(`[${new Date().toISOString()}] Listing secrets`);
      loomChannel.appendLine(`→ ${loomBinary} secrets list --backends`);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Listing secrets...",
        },
        async () => {
          try {
            const { stdout, stderr } = await execFileAsync(loomBinary, ["secrets", "list", "--backends"], {
              cwd: workspaceRoot || os.homedir(),
              timeout: 10000,
            });

            loomChannel.appendLine("─".repeat(60));
            if (stdout) {
              loomChannel.append(stdout);
            }
            if (stderr) {
              loomChannel.append(stderr);
            }
            loomChannel.show(true);

            // Refresh the secrets tree view
            secretsProvider.refresh();
          } catch (error) {
            const execError = error as { stdout?: string; stderr?: string; message?: string };
            if (execError.stdout) {
              loomChannel.append(execError.stdout);
            }
            if (execError.stderr) {
              loomChannel.append(execError.stderr);
            }
            loomChannel.appendLine(`✗ ${execError.message ?? "Failed to list secrets"}`);
            loomChannel.show(true);
          }
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.setSecret", async () => {
      const key = await vscode.window.showInputBox({
        prompt: "Enter secret key name",
        placeHolder: "e.g., GITHUB_TOKEN, OPENAI_API_KEY",
      });

      if (!key) {
        return;
      }

      const value = await vscode.window.showInputBox({
        prompt: `Enter value for ${key}`,
        password: true,
      });

      if (value === undefined) {
        return;
      }

      const loomBinary = resolveLoomBinary(workspaceRoot);
      loomChannel.appendLine(`[${new Date().toISOString()}] Setting secret: ${key}`);
      loomChannel.appendLine(`→ ${loomBinary} secrets set ${key} [REDACTED]`);

      try {
        const { stdout, stderr } = await execFileAsync(loomBinary, ["secrets", "set", key, value], {
          cwd: workspaceRoot || os.homedir(),
          timeout: 10000,
        });

        if (stdout) {
          loomChannel.appendLine(stdout);
        }
        if (stderr) {
          loomChannel.appendLine(stderr);
        }

        // Clear secrets cache so it gets refreshed
        secretsCache = null;
        secretsProvider.refresh();

        void vscode.window.showInformationMessage(`Loom: Secret '${key}' stored successfully`);
      } catch (error) {
        const execError = error as { stdout?: string; stderr?: string; message?: string };
        loomChannel.appendLine(`✗ ${execError.message ?? "Failed to set secret"}`);
        void vscode.window.showErrorMessage(`Failed to set secret: ${execError.message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.importSecrets", async () => {
      const fileUri = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          "Environment files": ["env"],
          "All files": ["*"],
        },
        title: "Select secrets file to import",
      });

      if (!fileUri || fileUri.length === 0) {
        return;
      }

      const filePath = fileUri[0].fsPath;
      const loomBinary = resolveLoomBinary(workspaceRoot);

      loomChannel.clear();
      loomChannel.appendLine(`[${new Date().toISOString()}] Importing secrets from: ${filePath}`);
      loomChannel.appendLine(`→ ${loomBinary} secrets import "${filePath}"`);
      loomChannel.show(true);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Importing secrets...",
        },
        async () => {
          try {
            const { stdout, stderr } = await execFileAsync(loomBinary, ["secrets", "import", filePath], {
              cwd: workspaceRoot || os.homedir(),
              timeout: 30000,
            });

            loomChannel.appendLine("─".repeat(60));
            if (stdout) {
              loomChannel.append(stdout);
            }
            if (stderr) {
              loomChannel.append(stderr);
            }

            // Clear secrets cache
            secretsCache = null;
            secretsProvider.refresh();

            void vscode.window.showInformationMessage("Loom: Secrets imported successfully");
          } catch (error) {
            const execError = error as { stdout?: string; stderr?: string; message?: string };
            if (execError.stdout) {
              loomChannel.append(execError.stdout);
            }
            if (execError.stderr) {
              loomChannel.append(execError.stderr);
            }
            loomChannel.appendLine(`✗ ${execError.message ?? "Failed to import secrets"}`);
            void vscode.window.showErrorMessage(`Failed to import secrets: ${execError.message}`);
          }
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.validateSecrets", async () => {
      const loomBinary = resolveLoomBinary(workspaceRoot);

      loomChannel.clear();
      loomChannel.appendLine(`[${new Date().toISOString()}] Validating config secrets`);
      loomChannel.appendLine(`→ ${loomBinary} validate configs --all`);
      loomChannel.show(true);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Validating config secrets...",
        },
        async () => {
          try {
            const { stdout, stderr } = await execFileAsync(loomBinary, ["validate", "configs", "--all"], {
              cwd: workspaceRoot || os.homedir(),
              timeout: 60000,
            });

            loomChannel.appendLine("─".repeat(60));
            if (stdout) {
              loomChannel.append(stdout);
            }
            if (stderr) {
              loomChannel.append(stderr);
            }

            if (stdout?.includes("No plaintext secrets found")) {
              void vscode.window.showInformationMessage("Loom: No plaintext secrets found in configs ✓");
            } else {
              void vscode.window.showWarningMessage("Loom: Potential plaintext secrets detected - check output");
            }
          } catch (error) {
            const execError = error as { stdout?: string; stderr?: string; message?: string };
            if (execError.stdout) {
              loomChannel.append(execError.stdout);
            }
            if (execError.stderr) {
              loomChannel.append(execError.stderr);
            }
            loomChannel.appendLine(`\n✗ Validation found issues - see above`);

            // Show the specific error count if available
            const match = execError.message?.match(/found (\d+) potential plaintext/);
            if (match) {
              void vscode.window.showWarningMessage(`Loom: Found ${match[1]} potential plaintext secrets - check output`);
            } else {
              void vscode.window.showWarningMessage("Loom: Validation found issues - check output");
            }
          }
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("loom.refreshSecrets", () => {
      // Clear the local cache
      secretsCache = null;

      // Refresh tree view
      secretsProvider.refresh();

      void vscode.window.showInformationMessage("Loom: Secrets cache refreshed");
    }),
  );
}

export function deactivate() {
  // no-op for now
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



async function applyGeneratedConfigs(workspaceRoot: string, channel: vscode.OutputChannel) {
  // After loom sync, the config is in .vscode-mcp/mcp.json
  // We read it, resolve keychain/env placeholders, and write to .vscode/mcp.json
  const generatedVscode = path.join(workspaceRoot, ".vscode-mcp", "mcp.json");
  const target = path.join(workspaceRoot, ".vscode", "mcp.json");
  try {
    await fsp.access(generatedVscode);
  } catch {
    channel.appendLine("⚠ Skipping VS Code config update; .vscode-mcp/mcp.json not found");
    return;
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });

  try {
    const raw = await fsp.readFile(generatedVscode, "utf-8");
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, Record<string, unknown>> };
    const resolvedSecrets: string[] = [];
    const missingSecrets: string[] = [];

    if (parsed.mcpServers) {
      await Promise.all(
        Object.entries(parsed.mcpServers).map(async ([serverName, serverConfig]) => {
          if (!serverConfig || typeof serverConfig !== "object") {
            return;
          }
          const envBlock = serverConfig["env"] as Record<string, unknown> | undefined;
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
  } catch {
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


