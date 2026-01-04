import { execFile } from "child_process";
import * as os from "os";
import { promisify } from "util";

import * as vscode from "vscode";

import { resolveLoomBinary } from "../utils/binary";

import { CommandContext, ExecError } from "./types";

const execFileAsync = promisify(execFile);

// Module-level cache for secrets (shared across commands)
let secretsCache: Record<string, string> | null = null;

/**
 * Clear the secrets cache. Call this when secrets are modified.
 */
export function clearSecretsCache(): void {
  secretsCache = null;
}

/**
 * Get the current secrets cache value.
 */
export function getSecretsCache(): Record<string, string> | null {
  return secretsCache;
}

/**
 * Set the secrets cache value.
 */
export function setSecretsCache(cache: Record<string, string> | null): void {
  secretsCache = cache;
}

/**
 * Register all secrets-related commands.
 */
export function registerSecretsCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("loom.listSecrets", () => listSecrets(ctx)),
    vscode.commands.registerCommand("loom.setSecret", () => setSecret(ctx)),
    vscode.commands.registerCommand("loom.importSecrets", () => importSecrets(ctx)),
    vscode.commands.registerCommand("loom.validateSecrets", () => validateSecrets(ctx)),
    vscode.commands.registerCommand("loom.refreshSecrets", () => refreshSecrets(ctx)),
  ];
}

async function listSecrets(ctx: CommandContext): Promise<void> {
  const { workspaceRoot, loomChannel, secretsProvider } = ctx;
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
        const { stdout, stderr } = await execFileAsync(
          loomBinary,
          ["secrets", "list", "--backends"],
          {
            cwd: workspaceRoot || os.homedir(),
            timeout: 10000,
          }
        );

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
        const execError = error as ExecError;
        if (execError.stdout) {
          loomChannel.append(execError.stdout);
        }
        if (execError.stderr) {
          loomChannel.append(execError.stderr);
        }
        loomChannel.appendLine(`✗ ${execError.message ?? "Failed to list secrets"}`);
        loomChannel.show(true);
      }
    }
  );
}

async function setSecret(ctx: CommandContext): Promise<void> {
  const { workspaceRoot, loomChannel, secretsProvider } = ctx;

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
    const execError = error as ExecError;
    loomChannel.appendLine(`✗ ${execError.message ?? "Failed to set secret"}`);
    void vscode.window.showErrorMessage(`Failed to set secret: ${execError.message}`);
  }
}

async function importSecrets(ctx: CommandContext): Promise<void> {
  const { workspaceRoot, loomChannel, secretsProvider } = ctx;

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
        const { stdout, stderr } = await execFileAsync(
          loomBinary,
          ["secrets", "import", filePath],
          {
            cwd: workspaceRoot || os.homedir(),
            timeout: 30000,
          }
        );

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
        const execError = error as ExecError;
        if (execError.stdout) {
          loomChannel.append(execError.stdout);
        }
        if (execError.stderr) {
          loomChannel.append(execError.stderr);
        }
        loomChannel.appendLine(`✗ ${execError.message ?? "Failed to import secrets"}`);
        void vscode.window.showErrorMessage(`Failed to import secrets: ${execError.message}`);
      }
    }
  );
}

async function validateSecrets(ctx: CommandContext): Promise<void> {
  const { workspaceRoot, loomChannel } = ctx;
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
        const { stdout, stderr } = await execFileAsync(
          loomBinary,
          ["validate", "configs", "--all"],
          {
            cwd: workspaceRoot || os.homedir(),
            timeout: 60000,
          }
        );

        loomChannel.appendLine("─".repeat(60));
        if (stdout) {
          loomChannel.append(stdout);
        }
        if (stderr) {
          loomChannel.append(stderr);
        }

        if (stdout?.includes("No plaintext secrets found")) {
          void vscode.window.showInformationMessage(
            "Loom: No plaintext secrets found in configs ✓"
          );
        } else {
          void vscode.window.showWarningMessage(
            "Loom: Potential plaintext secrets detected - check output"
          );
        }
      } catch (error) {
        const execError = error as ExecError;
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
          void vscode.window.showWarningMessage(
            `Loom: Found ${match[1]} potential plaintext secrets - check output`
          );
        } else {
          void vscode.window.showWarningMessage("Loom: Validation found issues - check output");
        }
      }
    }
  );
}

function refreshSecrets(ctx: CommandContext): void {
  const { secretsProvider } = ctx;

  // Clear the local cache
  secretsCache = null;

  // Refresh tree view
  secretsProvider.refresh();

  void vscode.window.showInformationMessage("Loom: Secrets cache refreshed");
}
