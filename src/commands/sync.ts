import { execFile } from "child_process";
import { promises as fsp } from "fs";
import * as path from "path";
import { promisify } from "util";

import * as vscode from "vscode";

import { resolveLoomBinary } from "../utils/binary";
import { formatSyncStatus, getStatusIcon } from "../utils/helpers";
import { Logger } from "../utils/logger";
import { isPlaceholder, resolvePlaceholder } from "../utils/secrets";

import { CommandContext } from "./types";

const execFileAsync = promisify(execFile);
const SYNC_PROFILES = ["vscode", "claude", "codex", "kilocode"] as const;

/**
 * Register all sync-related commands.
 */
export function registerSyncCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("loom.showSyncStatus", () => showSyncStatus(ctx)),
    vscode.commands.registerCommand("loom.showOfflineStatus", () => showOfflineStatus(ctx)),
    vscode.commands.registerCommand("loom.syncConfigs", () => syncConfigs(ctx)),
  ];
}

async function showSyncStatus(ctx: CommandContext): Promise<void> {
  const { configSyncManager } = ctx;

  const state = configSyncManager.getState();
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
}

async function syncConfigs(ctx: CommandContext): Promise<void> {
  const {
    workspaceRoot,
    loomChannel,
    hubStatusManager,
    configSyncManager,
    registryProvider,
    serverProvider,
  } = ctx;

  if (!workspaceRoot) {
    void vscode.window.showErrorMessage("Loom: workspace folder not detected.");
    return;
  }

  const logger = new Logger(loomChannel, "Sync");
  loomChannel.clear();
  logger.info("Running MCP sync via loom CLI...");
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Syncing MCP configurations",
    },
    async () => {
      const offlineState = configSyncManager.getOfflineState();
      if (offlineState.mode === "offline") {
        queuePendingProfileSyncs(configSyncManager);
        const pendingCount = configSyncManager.getPendingSyncsCount();
        loomChannel.appendLine(
          `⚠ Hub is offline. Queued ${pendingCount} pending sync(s) for automatic processing when connection recovers.`
        );
        void vscode.window.showWarningMessage(
          `Loom: Hub offline. Queued ${pendingCount} pending sync(s) for retry when back online.`
        );
        return;
      }

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
        for (const profile of SYNC_PROFILES.slice(2)) {
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
        await configSyncManager.checkSync();
        configSyncManager.setOfflineMode("online");

        loomChannel.show(true);
        registryProvider.refresh();
        serverProvider.refresh();
        void vscode.window.showInformationMessage("Loom: synced MCP configs for all profiles");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isConnectivityFailure(message)) {
          configSyncManager.setOfflineMode("offline", message);
          queuePendingProfileSyncs(configSyncManager);
          const pendingCount = configSyncManager.getPendingSyncsCount();
          loomChannel.appendLine(
            `⚠ Hub connectivity issue detected. Queued ${pendingCount} pending sync(s) for retry.`
          );
          loomChannel.show(true);
          void vscode.window.showWarningMessage(
            `Loom: Hub offline. Queued ${pendingCount} pending sync(s) for automatic retry when online.`
          );
          return;
        }

        configSyncManager.setOfflineMode("degraded", message);
        loomChannel.appendLine(`✗ Sync failed: ${message}`);
        loomChannel.show(true);
        void vscode.window.showErrorMessage(`Loom: failed to sync configs (${message})`);
      }
    }
  );
}

async function showOfflineStatus(ctx: CommandContext): Promise<void> {
  const { configSyncManager, hubStatusManager } = ctx;
  const state = configSyncManager.getOfflineState();

  const modeText =
    state.mode === "online" ? "Online" : state.mode === "degraded" ? "Degraded" : "Offline";
  const pendingText = `${state.pendingSyncs.length} pending sync(s)`;
  const reasonText = state.reason ? `Reason: ${state.reason}` : "Reason: none";

  const picks: Array<vscode.QuickPickItem & { action?: string }> = [
    {
      label: `$(cloud) Mode: ${modeText}`,
      description: pendingText,
      detail: reasonText,
    },
  ];

  if (state.pendingSyncs.length > 0) {
    picks.push({
      label: "$(sync) Process pending syncs now",
      description: "Run queued sync operations immediately",
      action: "process",
    });
  }

  if (state.mode !== "online") {
    picks.push({
      label: "$(clock) Queue full profile sync",
      description: "Queue vscode, claude, codex, and kilocode for retry",
      action: "queue",
    });
  }

  picks.push({
    label: "$(refresh) Refresh hub status",
    description: "Re-check hub availability",
    action: "refresh",
  });

  const selected = await vscode.window.showQuickPick(picks, {
    title: "Loom Offline Status",
    placeHolder: "Select an action",
  });

  if (!selected?.action) {
    return;
  }

  if (selected.action === "process") {
    const results = await configSyncManager.processPendingSyncsNow();
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.length - succeeded;
    void vscode.window.showInformationMessage(
      `Loom: processed pending syncs (${succeeded} succeeded, ${failed} failed)`
    );
    return;
  }

  if (selected.action === "queue") {
    queuePendingProfileSyncs(configSyncManager);
    const pendingCount = configSyncManager.getPendingSyncsCount();
    void vscode.window.showInformationMessage(
      `Loom: queued profile syncs for retry (${pendingCount} pending)`
    );
    return;
  }

  if (selected.action === "refresh") {
    await hubStatusManager.refresh();
  }
}

/**
 * Apply generated configs by resolving keychain/env placeholders.
 */
export async function applyGeneratedConfigs(
  workspaceRoot: string,
  channel: vscode.OutputChannel
): Promise<void> {
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
            })
          );
        })
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
      `⚠ Failed to resolve keychain placeholders; copying file verbatim (${(error as Error).message})`
    );
    await fsp.copyFile(generatedVscode, target);
  }
}

function queuePendingProfileSyncs(configSyncManager: CommandContext["configSyncManager"]): void {
  for (const profile of SYNC_PROFILES) {
    configSyncManager.queuePendingSync(profile);
  }
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
