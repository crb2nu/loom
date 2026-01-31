import * as os from "os";
import * as path from "path";

import * as vscode from "vscode";

import { PlatformConfigClient } from "../clients/platformConfig";
import { PlatformsProvider } from "../providers/platforms";
import { PlatformType } from "../types";
import { PLATFORMS, getEnabledPlatforms } from "../utils/platform";

/**
 * Context for platform-related commands.
 */
export interface PlatformCommandContext {
  workspaceRoot: string;
  loomChannel: vscode.OutputChannel;
  platformConfigClient: PlatformConfigClient;
  platformsProvider: PlatformsProvider;
}

/**
 * Register all platform-related commands.
 */
export function registerPlatformCommands(ctx: PlatformCommandContext): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Show platform configs (refresh view)
  disposables.push(
    vscode.commands.registerCommand("loom.showPlatformConfigs", async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Checking platform configs...",
          cancellable: false,
        },
        async () => {
          await ctx.platformConfigClient.checkAllSyncStatus();
          ctx.platformsProvider.refresh();
        }
      );
    })
  );

  // Sync specific platform
  disposables.push(
    vscode.commands.registerCommand(
      "loom.syncPlatformConfig",
      async (platformArg?: PlatformType) => {
        let platform = platformArg;

        if (!platform) {
          // Show picker if not provided
          const enabledPlatforms = getEnabledPlatforms();
          const picks = enabledPlatforms.map((p) => ({
            label: PLATFORMS[p].displayName,
            description: PLATFORMS[p].description,
            platform: p,
          }));

          const selected = await vscode.window.showQuickPick(picks, {
            placeHolder: "Select platform to sync",
            title: "Sync Platform Config",
          });

          if (!selected) {
            return;
          }
          platform = selected.platform;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Syncing ${PLATFORMS[platform].displayName}...`,
            cancellable: false,
          },
          async () => {
            const result = await ctx.platformConfigClient.syncPlatform(platform);

            if (result.success) {
              vscode.window.showInformationMessage(
                `${PLATFORMS[platform].displayName} synced: ${result.serversUpdated ?? 0} servers`
              );
            } else {
              vscode.window.showErrorMessage(
                `Failed to sync ${PLATFORMS[platform].displayName}: ${result.message}`
              );
            }
          }
        );
      }
    )
  );

  // Sync all platforms
  disposables.push(
    vscode.commands.registerCommand("loom.syncAllPlatforms", async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Syncing all platforms...",
          cancellable: false,
        },
        async (progress) => {
          const enabledPlatforms = getEnabledPlatforms();
          let completed = 0;
          let succeeded = 0;

          for (const platform of enabledPlatforms) {
            progress.report({
              message: `${PLATFORMS[platform].displayName}...`,
              increment: 100 / enabledPlatforms.length,
            });

            const result = await ctx.platformConfigClient.syncPlatform(platform);
            completed++;
            if (result.success) {
              succeeded++;
            }
          }

          vscode.window.showInformationMessage(`Synced ${succeeded}/${completed} platforms`);
        }
      );
    })
  );

  // Show diff between repo and home
  disposables.push(
    vscode.commands.registerCommand(
      "loom.diffPlatformConfig",
      async (platformArg?: PlatformType) => {
        let platform = platformArg;

        if (!platform) {
          const enabledPlatforms = getEnabledPlatforms();
          const picks = enabledPlatforms.map((p) => ({
            label: PLATFORMS[p].displayName,
            platform: p,
          }));

          const selected = await vscode.window.showQuickPick(picks, {
            placeHolder: "Select platform to diff",
            title: "Diff Platform Config",
          });

          if (!selected) {
            return;
          }
          platform = selected.platform;
        }

        const diff = await ctx.platformConfigClient.getDiff(platform);

        // Show in new document
        const doc = await vscode.workspace.openTextDocument({
          content: diff,
          language: "markdown",
        });
        await vscode.window.showTextDocument(doc);
      }
    )
  );

  // Open platform config file
  disposables.push(
    vscode.commands.registerCommand(
      "loom.openPlatformConfig",
      async (platformArg?: PlatformType, locationArg?: "repo" | "home") => {
        let platform = platformArg;
        let location = locationArg;

        if (!platform) {
          const enabledPlatforms = getEnabledPlatforms();
          const picks = enabledPlatforms.map((p) => ({
            label: PLATFORMS[p].displayName,
            platform: p,
          }));

          const selected = await vscode.window.showQuickPick(picks, {
            placeHolder: "Select platform",
            title: "Open Platform Config",
          });

          if (!selected) {
            return;
          }
          platform = selected.platform;
        }

        if (!location) {
          const locationPicks = [
            { label: "Repo", description: "Workspace config", location: "repo" as const },
            { label: "Home", description: "User home config", location: "home" as const },
          ];

          const selectedLocation = await vscode.window.showQuickPick(locationPicks, {
            placeHolder: "Select config location",
            title: "Open Platform Config",
          });

          if (!selectedLocation) {
            return;
          }
          location = selectedLocation.location;
        }

        const info = PLATFORMS[platform];
        const filePath =
          location === "repo"
            ? path.join(ctx.workspaceRoot, info.repoConfigPath)
            : path.join(os.homedir(), info.homeConfigPath);

        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
          await vscode.window.showTextDocument(doc);
        } catch {
          const create = await vscode.window.showErrorMessage(
            `Config file not found: ${filePath}`,
            "Create",
            "Cancel"
          );

          if (create === "Create") {
            // Create the file with empty config
            const edit = new vscode.WorkspaceEdit();
            edit.createFile(vscode.Uri.file(filePath), { ignoreIfExists: true });
            await vscode.workspace.applyEdit(edit);

            // Write initial content
            const initialContent =
              info.configFormat === "json"
                ? JSON.stringify({ mcpServers: {} }, null, 2)
                : "# Gemini MCP Configuration\n[mcpServers]\n";

            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            const wsEdit = new vscode.WorkspaceEdit();
            wsEdit.insert(doc.uri, new vscode.Position(0, 0), initialContent);
            await vscode.workspace.applyEdit(wsEdit);
            await doc.save();
            await vscode.window.showTextDocument(doc);
          }
        }
      }
    )
  );

  // Regenerate platform config
  disposables.push(
    vscode.commands.registerCommand(
      "loom.regeneratePlatformConfig",
      async (platformArg?: PlatformType) => {
        let platform = platformArg;

        if (!platform) {
          const enabledPlatforms = getEnabledPlatforms();
          const picks = enabledPlatforms.map((p) => ({
            label: PLATFORMS[p].displayName,
            description: PLATFORMS[p].description,
            platform: p,
          }));

          const selected = await vscode.window.showQuickPick(picks, {
            placeHolder: "Select platform to regenerate",
            title: "Regenerate Platform Config",
          });

          if (!selected) {
            return;
          }
          platform = selected.platform;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Regenerating ${PLATFORMS[platform].displayName} config...`,
            cancellable: false,
          },
          async () => {
            const result = await ctx.platformConfigClient.regenerateConfig(platform);

            if (result.success) {
              vscode.window.showInformationMessage(
                `${PLATFORMS[platform].displayName} regenerated: ${result.serversUpdated ?? 0} servers`
              );
            } else {
              vscode.window.showErrorMessage(
                `Failed to regenerate ${PLATFORMS[platform].displayName}: ${result.message}`
              );
            }
          }
        );
      }
    )
  );

  // Pull from home
  disposables.push(
    vscode.commands.registerCommand("loom.pullFromHome", async (platformArg?: PlatformType) => {
      let platform = platformArg;

      if (!platform) {
        const enabledPlatforms = getEnabledPlatforms();
        const picks = enabledPlatforms.map((p) => ({
          label: PLATFORMS[p].displayName,
          platform: p,
        }));

        const selected = await vscode.window.showQuickPick(picks, {
          placeHolder: "Select platform to pull",
          title: "Pull Config from Home",
        });

        if (!selected) {
          return;
        }
        platform = selected.platform;
      }

      const confirm = await vscode.window.showWarningMessage(
        `This will overwrite the repo config for ${PLATFORMS[platform].displayName} with the home config. Continue?`,
        "Pull",
        "Cancel"
      );

      if (confirm !== "Pull") {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Pulling ${PLATFORMS[platform].displayName} from home...`,
          cancellable: false,
        },
        async () => {
          const result = await ctx.platformConfigClient.pullFromHome(platform);

          if (result.success) {
            vscode.window.showInformationMessage(
              `${PLATFORMS[platform].displayName} pulled: ${result.serversUpdated ?? 0} servers`
            );
          } else {
            vscode.window.showErrorMessage(
              `Failed to pull ${PLATFORMS[platform].displayName}: ${result.message}`
            );
          }
        }
      );
    })
  );

  // Backup all configs
  disposables.push(
    vscode.commands.registerCommand("loom.backupConfigs", async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Backing up configs...",
          cancellable: false,
        },
        async () => {
          const backupDir = await ctx.platformConfigClient.backupConfigs();
          vscode.window.showInformationMessage(`Configs backed up to: ${backupDir}`);
        }
      );
    })
  );

  // Refresh platforms view
  disposables.push(
    vscode.commands.registerCommand("loom.refreshPlatforms", () => {
      ctx.platformsProvider.refresh();
    })
  );

  return disposables;
}
