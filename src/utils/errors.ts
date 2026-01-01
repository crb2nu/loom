import * as vscode from "vscode";

import { ActionableError } from "../types";

export function analyzeError(error: unknown, context: string): ActionableError {
  const err = error as { code?: string; message?: string; stderr?: string };
  const message = err.message ?? String(error);
  const code = err.code ?? "";
  const stderr = err.stderr ?? "";

  // Daemon not running
  if (
    message.includes("ECONNREFUSED") ||
    message.includes("connect ENOENT") ||
    message.includes("no such file") ||
    stderr.includes("daemon not running")
  ) {
    return {
      message: `${context}: Daemon is not running`,
      actions: [
        { label: "Start Daemon", command: "loom.startDaemon" },
        { label: "Check Status", command: "loom.daemonStatus" },
      ],
    };
  }

  // Binary not found
  if (code === "ENOENT" || (message.includes("spawn") && message.includes("ENOENT"))) {
    return {
      message: `${context}: Loom binary not found`,
      actions: [{ label: "Install Loom", url: "https://github.com/crb2nu/loom" }],
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

export async function showActionableError(error: unknown, context: string): Promise<void> {
  const analyzed = analyzeError(error, context);

  if (analyzed.actions.length === 0) {
    void vscode.window.showErrorMessage(analyzed.message);
    return;
  }

  const actionLabels = analyzed.actions.map((a) => a.label);
  const selection = await vscode.window.showErrorMessage(analyzed.message, ...actionLabels);

  if (selection) {
    const action = analyzed.actions.find((a) => a.label === selection);
    if (action?.command) {
      void vscode.commands.executeCommand(action.command);
    } else if (action?.url) {
      void vscode.env.openExternal(vscode.Uri.parse(action.url));
    }
  }
}
