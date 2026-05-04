import * as vscode from "vscode";

import { MillsStatusSnapshot } from "../clients/mills";
import { MillsStatusManager } from "../managers/millsStatus";
import { MillsTreeProvider } from "../providers/mills";

export interface MillsCommandContext {
  millsStatusManager: MillsStatusManager;
  millsTreeProvider?: MillsTreeProvider;
}

/**
 * Register Mills-related commands.
 */
export function registerMillsCommands(ctx: MillsCommandContext): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [
    vscode.commands.registerCommand("loom.showMillsStatus", () => showMillsStatus(ctx)),
  ];
  if (ctx.millsTreeProvider) {
    const tree = ctx.millsTreeProvider;
    disposables.push(
      vscode.commands.registerCommand("loom.refreshMills", () => {
        tree.refresh();
        void ctx.millsStatusManager.refresh();
      })
    );
  }
  return disposables;
}

async function showMillsStatus(ctx: MillsCommandContext): Promise<void> {
  const { millsStatusManager } = ctx;
  if (!millsStatusManager.getSettings().hudBaseUrl) {
    const choice = await vscode.window.showInformationMessage(
      "Mills HUD URL is not configured. Set 'loom.mills.hudBaseUrl' to enable Mills support.",
      "Open Settings"
    );
    if (choice === "Open Settings") {
      void vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "loom.mills.hudBaseUrl"
      );
    }
    return;
  }

  await millsStatusManager.refresh();
  const snapshot = millsStatusManager.getSnapshot();
  const message = formatSnapshotMessage(snapshot);
  void vscode.window.showInformationMessage(message);
}

function formatSnapshotMessage(snapshot: MillsStatusSnapshot): string {
  if (snapshot.health === "unreachable") {
    return `Loom: Mills HUD unreachable${snapshot.error ? ` — ${snapshot.error}` : ""}`;
  }
  if (snapshot.health === "unconfigured") {
    return "Loom: Mills HUD not configured.";
  }
  const parts: string[] = [`health=${snapshot.health}`];
  const stage = snapshot.status?.stage;
  if (stage) parts.push(`stage=${stage}`);
  const regressions = snapshot.kpis?.regression_count;
  if (regressions !== undefined) parts.push(`regressions=${regressions}`);
  const council = snapshot.kpis?.council_runs_total;
  if (council !== undefined) parts.push(`council_runs=${council}`);
  const pipeline = snapshot.kpis?.pipeline_runs_total;
  if (pipeline !== undefined) parts.push(`pipeline_runs=${pipeline}`);
  return `Loom Mills: ${parts.join(", ")}`;
}
