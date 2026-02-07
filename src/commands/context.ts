import { execFile } from "child_process";
import { promises as fsp } from "fs";
import * as path from "path";
import { promisify } from "util";

import * as vscode from "vscode";
import { parse } from "yaml";

import { REGISTRY_PATH } from "../constants";
import { RegistryDocument, SnapshotEnvResult } from "../types";
import { resolveLoomBinary } from "../utils/binary";
import { isPlaceholder, loadSecretsFromEnvFile, resolvePlaceholder } from "../utils/secrets";

import { applyGeneratedConfigs } from "./sync";
import { CommandContext, ExecError } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Register all context-related commands.
 */
export function registerContextCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("loom.checkMcpHealth", () => checkMcpHealth(ctx)),
    vscode.commands.registerCommand("loom.snapshotContext", () => snapshotContext(ctx)),
    vscode.commands.registerCommand("loom.bootstrapContext", () => bootstrapContext(ctx)),
  ];
}

async function checkMcpHealth(ctx: CommandContext): Promise<void> {
  const { workspaceRoot, pythonExecutable, loomChannel } = ctx;

  if (!workspaceRoot) {
    void vscode.window.showErrorMessage("Loom: workspace folder not detected.");
    return;
  }
  const scriptPath = path.join(workspaceRoot, "test_mcp_servers.py");
  loomChannel.clear();
  loomChannel.appendLine(`[${new Date().toISOString()}] Running MCP health check...`);

  await runHealthCheck(pythonExecutable, scriptPath, workspaceRoot, loomChannel);
}

async function snapshotContext(ctx: CommandContext): Promise<void> {
  const { workspaceRoot, pythonExecutable, loomChannel, registryProvider } = ctx;

  if (!workspaceRoot) {
    void vscode.window.showErrorMessage("Loom: workspace folder not detected.");
    return;
  }
  const ok = await runSnapshot(pythonExecutable, workspaceRoot, loomChannel);
  if (ok) {
    registryProvider.setLastSnapshot(new Date().toISOString());
  }
}

async function bootstrapContext(ctx: CommandContext): Promise<void> {
  const {
    workspaceRoot,
    pythonExecutable,
    loomChannel,
    hubStatusManager,
    configSyncManager,
    registryProvider,
  } = ctx;

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
        await configSyncManager.checkSync();

        const snapshotOk = await runSnapshot(pythonExecutable, workspaceRoot, loomChannel);
        if (snapshotOk) {
          loomChannel.appendLine("✓ Snapshot captured in Qdrant");
          registryProvider.setLastSnapshot(new Date().toISOString());
        } else {
          loomChannel.appendLine("⚠ Snapshot step reported errors; see snapshot channel.");
        }

        loomChannel.show(true);
        void vscode.window.showInformationMessage("Loom: bootstrap completed");
      } catch (error) {
        const execError = error as { message?: string };
        const message = execError.message ?? "Loom: bootstrap failed";
        loomChannel.show(true);
        void vscode.window.showErrorMessage(message);
      }
    }
  );
}

async function runHealthCheck(
  pythonExecutable: string,
  scriptPath: string,
  cwd: string,
  channel: vscode.OutputChannel
): Promise<void> {
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
    const execError = error as ExecError;
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
  channel: vscode.OutputChannel
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
    void vscode.window.showInformationMessage("Loom: Qdrant snapshot completed");
    return true;
  } catch (error) {
    const execError = error as ExecError;
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
        const envBlocks = [
          qdrant.common?.env,
          qdrant.targets?.vscode?.env,
          qdrant.targets?.codex?.env,
        ];
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
      // Silently ignore registry load failures - the file may not exist
      void error;
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
