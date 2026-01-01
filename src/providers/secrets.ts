import { execFile } from "child_process";
import * as os from "os";
import { promisify } from "util";

import * as vscode from "vscode";

import { resolveLoomBinary } from "../utils/binary";

const execFileAsync = promisify(execFile);

/**
 * Tree data provider for the Loom Secrets panel.
 * Shows secrets configured in the loom secret store.
 */
export class SecretsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly workspaceRoot: string | undefined;
  private readonly channel: vscode.OutputChannel;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private cachedSecrets: string[] | null = null;

  constructor(workspaceRoot: string | undefined, channel: vscode.OutputChannel) {
    this.workspaceRoot = workspaceRoot;
    this.channel = channel;
  }

  refresh() {
    this.cachedSecrets = null;
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) {
      return []; // No children for secret items
    }

    // Root level: fetch secrets from loom CLI
    try {
      const secrets = await this.fetchSecrets();

      if (secrets.length === 0) {
        const placeholder = new vscode.TreeItem(
          "No secrets configured",
          vscode.TreeItemCollapsibleState.None
        );
        placeholder.iconPath = new vscode.ThemeIcon("key");
        placeholder.command = {
          command: "loom.setSecret",
          title: "Add Secret",
        };
        placeholder.tooltip = "Click to add a secret";
        return [placeholder];
      }

      return secrets.map((secretKey) => {
        const item = new vscode.TreeItem(secretKey, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("key");
        item.contextValue = "secret";
        item.tooltip = `Secret: ${secretKey}\nClick to copy name`;
        item.command = {
          command: "workbench.action.quickOpen",
          title: "Copy Secret Name",
          arguments: [`>Loom: `],
        };
        return item;
      });
    } catch {
      const errorItem = new vscode.TreeItem(
        "Failed to load secrets",
        vscode.TreeItemCollapsibleState.None
      );
      errorItem.iconPath = new vscode.ThemeIcon("warning");
      errorItem.tooltip = "Click to retry or check if loom CLI is available";
      errorItem.command = {
        command: "loom.refreshSecrets",
        title: "Retry",
      };
      return [errorItem];
    }
  }

  private async fetchSecrets(): Promise<string[]> {
    if (this.cachedSecrets !== null) {
      return this.cachedSecrets;
    }

    const loomBinary = resolveLoomBinary(this.workspaceRoot);
    const { stdout } = await execFileAsync(loomBinary, ["secrets", "list"], {
      cwd: this.workspaceRoot || os.homedir(),
      timeout: 10000,
    });

    // Parse output - look for lines that are secret names (after "Secrets (N):" header)
    const lines = stdout.split("\n");
    const secrets: string[] = [];
    let inSecretsList = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("Secrets (")) {
        inSecretsList = true;
        continue;
      }
      if (
        inSecretsList &&
        trimmed &&
        !trimmed.startsWith("Configured") &&
        !trimmed.startsWith("No secrets")
      ) {
        secrets.push(trimmed);
      }
    }

    this.cachedSecrets = secrets;
    return secrets;
  }
}
