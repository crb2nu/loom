import * as vscode from "vscode";

import { MillsStatusSnapshot } from "../clients/mills";
import { MillsStatusManager } from "../managers/millsStatus";
import { MillsSubjectRef, MillsTreeProvider } from "../providers/mills";
import { MillsDetailPanel } from "../webviews/MillsDetailPanel";

export interface MillsCommandContext {
  extensionUri: vscode.Uri;
  loomChannel: vscode.OutputChannel;
  millsStatusManager: MillsStatusManager;
  millsTreeProvider?: MillsTreeProvider;
}

/**
 * Register Mills-related commands.
 */
export function registerMillsCommands(ctx: MillsCommandContext): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [
    vscode.commands.registerCommand("loom.showMillsStatus", () => showMillsStatus(ctx)),
    vscode.commands.registerCommand("loom.openMillsDetail", (subject: unknown) =>
      openMillsDetail(ctx, subject)
    ),
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

function openMillsDetail(ctx: MillsCommandContext, raw: unknown): void {
  const subject = parseSubject(raw);
  if (!subject) {
    void vscode.window.showWarningMessage("Loom: invalid Mills subject (expected {kind, id}).");
    return;
  }
  MillsDetailPanel.render(
    ctx.extensionUri,
    ctx.millsStatusManager.getSettings(),
    ctx.loomChannel,
    subject
  );
}

function parseSubject(raw: unknown): MillsSubjectRef | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
  const id = obj.id;
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (
    kind !== "backlog" &&
    kind !== "council" &&
    kind !== "pipeline" &&
    kind !== "audit" &&
    kind !== "policy-proposal"
  ) {
    return undefined;
  }
  return { kind, id };
}

async function showMillsStatus(ctx: MillsCommandContext): Promise<void> {
  const { millsStatusManager } = ctx;
  if (!millsStatusManager.getSettings().hudBaseUrl) {
    const choice = await vscode.window.showInformationMessage(
      "Mills HUD URL is not configured. Set 'loom.mills.hudBaseUrl' to enable Mills support.",
      "Open Settings"
    );
    if (choice === "Open Settings") {
      void vscode.commands.executeCommand("workbench.action.openSettings", "loom.mills.hudBaseUrl");
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
