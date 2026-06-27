import * as vscode from "vscode";

import { MILLS_METRIC_KEYS, MillsStatusSnapshot, readMetric } from "../clients/mills";
import { MillsAdminClient } from "../clients/millsAdmin";
import { MillsStatusManager } from "../managers/millsStatus";
import { MillsSubjectKind, MillsSubjectRef, MillsTreeProvider } from "../providers/mills";
import { MillsTokenStore } from "../utils/millsToken";
import { MillsDetailPanel } from "../webviews/MillsDetailPanel";

export interface MillsCommandContext {
  extensionUri: vscode.Uri;
  loomChannel: vscode.OutputChannel;
  millsStatusManager: MillsStatusManager;
  millsTreeProvider?: MillsTreeProvider;
  millsTokenStore: MillsTokenStore;
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
    vscode.commands.registerCommand("loom.mills.setAdminToken", () => setAdminToken(ctx)),
    vscode.commands.registerCommand("loom.mills.clearAdminToken", () => clearAdminToken(ctx)),
    vscode.commands.registerCommand("loom.mills.councilDryrun", () => councilDryrun(ctx)),
    vscode.commands.registerCommand("loom.mills.councilRun", () => councilRun(ctx)),
    vscode.commands.registerCommand("loom.mills.pipelinePause", (subject: unknown) =>
      pipelineMutation(ctx, subject, "pause")
    ),
    vscode.commands.registerCommand("loom.mills.pipelineResume", (subject: unknown) =>
      pipelineMutation(ctx, subject, "resume")
    ),
    vscode.commands.registerCommand("loom.mills.pipelineEscalate", (subject: unknown) =>
      pipelineMutation(ctx, subject, "escalate")
    ),
    vscode.commands.registerCommand("loom.mills.proposalApply", (subject: unknown) =>
      proposalMutation(ctx, subject, "apply")
    ),
    vscode.commands.registerCommand("loom.mills.proposalReject", (subject: unknown) =>
      proposalMutation(ctx, subject, "reject")
    ),
    vscode.commands.registerCommand("loom.mills.backlogSubmit", () => backlogSubmit(ctx)),
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

// All Mills detail subject kinds the detail panel can render. Kept in sync with
// MillsSubjectKind in providers/mills.ts; the panel fetches + renders each.
const MILLS_SUBJECT_KINDS: readonly MillsSubjectKind[] = [
  "backlog",
  "council",
  "pipeline",
  "audit",
  "policy-proposal",
  "cross-repo",
  "workflow",
  "eval",
  "cost-preview",
  "squad-memory",
  "squad-outcomes",
];

function parseSubject(raw: unknown): MillsSubjectRef | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
  const id = obj.id;
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (typeof kind !== "string" || !MILLS_SUBJECT_KINDS.includes(kind as MillsSubjectKind)) {
    return undefined;
  }
  return { kind: kind as MillsSubjectKind, id };
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

// ===========================================================================
// Admin token management
// ===========================================================================

async function setAdminToken(ctx: MillsCommandContext): Promise<void> {
  const entered = await vscode.window.showInputBox({
    title: "Mills HUD admin token",
    prompt: "Stored securely in VS Code SecretStorage",
    password: true,
    ignoreFocusOut: true,
  });
  if (!entered) return;
  await ctx.millsTokenStore.set(entered);
  void vscode.window.showInformationMessage("Loom: Mills admin token saved.");
}

async function clearAdminToken(ctx: MillsCommandContext): Promise<void> {
  await ctx.millsTokenStore.clear();
  void vscode.window.showInformationMessage("Loom: Mills admin token cleared.");
}

// ===========================================================================
// Mutation helpers
// ===========================================================================

async function ensureMutationPrereqs(
  ctx: MillsCommandContext,
  promptTitle: string
): Promise<MillsAdminClient | undefined> {
  const settings = ctx.millsStatusManager.getSettings();
  if (!settings.hudBaseUrl) {
    void vscode.window.showWarningMessage(
      "Loom: Mills HUD URL is not configured. Set 'loom.mills.hudBaseUrl' first."
    );
    return undefined;
  }
  const token = await ctx.millsTokenStore.ensure(promptTitle);
  if (!token) return undefined;
  return new MillsAdminClient({ ...settings, adminToken: token }, ctx.loomChannel);
}

async function confirm(message: string, destructive = false): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    destructive ? "Confirm (destructive)" : "Confirm"
  );
  return Boolean(choice);
}

function refreshAfterMutation(ctx: MillsCommandContext): void {
  ctx.millsTreeProvider?.refresh();
  void ctx.millsStatusManager.refresh();
}

function reportSuccess(action: string): void {
  void vscode.window.showInformationMessage(`Loom Mills: ${action} succeeded.`);
}

function reportFailure(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  void vscode.window.showErrorMessage(`Loom Mills: ${action} failed — ${message}`);
}

// ===========================================================================
// Council mutations
// ===========================================================================

async function councilDryrun(ctx: MillsCommandContext): Promise<void> {
  if (!(await confirm("Run council in dryrun mode? Safe — no commits."))) return;
  const client = await ensureMutationPrereqs(ctx, "Mills admin token (council dryrun)");
  if (!client) return;
  try {
    await client.councilDryrun();
    reportSuccess("council dryrun");
    refreshAfterMutation(ctx);
  } catch (error) {
    reportFailure("council dryrun", error);
  }
}

async function councilRun(ctx: MillsCommandContext): Promise<void> {
  if (
    !(await confirm(
      "Trigger a real council run? This may produce commits, MRs, and incur LLM cost.",
      true
    ))
  )
    return;
  const client = await ensureMutationPrereqs(ctx, "Mills admin token (council run)");
  if (!client) return;
  try {
    await client.councilRun();
    reportSuccess("council run");
    refreshAfterMutation(ctx);
  } catch (error) {
    reportFailure("council run", error);
  }
}

// ===========================================================================
// Pipeline mutations (pause / resume / escalate)
// ===========================================================================

type PipelineAction = "pause" | "resume" | "escalate";

async function pipelineMutation(
  ctx: MillsCommandContext,
  rawSubject: unknown,
  action: PipelineAction
): Promise<void> {
  const subject = parseSubject(rawSubject);
  const id = subject?.kind === "pipeline" ? subject.id : await promptForId("Pipeline run ID");
  if (!id) return;
  const verb = action === "escalate" ? "force-escalate" : action;
  const destructive = action === "escalate";
  if (!(await confirm(`${capitalize(verb)} pipeline run ${id}?`, destructive))) return;
  const client = await ensureMutationPrereqs(ctx, `Mills admin token (pipeline ${action})`);
  if (!client) return;
  try {
    if (action === "pause") await client.pipelinePause(id);
    else if (action === "resume") await client.pipelineResume(id);
    else await client.pipelineEscalate(id);
    reportSuccess(`pipeline ${action} (${id})`);
    refreshAfterMutation(ctx);
  } catch (error) {
    reportFailure(`pipeline ${action}`, error);
  }
}

// ===========================================================================
// Policy proposal mutations
// ===========================================================================

type ProposalAction = "apply" | "reject";

async function proposalMutation(
  ctx: MillsCommandContext,
  rawSubject: unknown,
  action: ProposalAction
): Promise<void> {
  const subject = parseSubject(rawSubject);
  const id =
    subject?.kind === "policy-proposal" ? subject.id : await promptForId("Policy proposal ID");
  if (!id) return;
  const destructive = action === "apply";
  if (
    !(await confirm(
      `${capitalize(action)} policy proposal ${id}? This rotates the live Mills policy.`,
      destructive
    ))
  )
    return;
  const client = await ensureMutationPrereqs(ctx, `Mills admin token (proposal ${action})`);
  if (!client) return;
  try {
    if (action === "apply") await client.proposalApply(id);
    else await client.proposalReject(id);
    reportSuccess(`proposal ${action} (${id})`);
    refreshAfterMutation(ctx);
  } catch (error) {
    reportFailure(`proposal ${action}`, error);
  }
}

// ===========================================================================
// Backlog submit
// ===========================================================================

async function backlogSubmit(ctx: MillsCommandContext): Promise<void> {
  const id = await vscode.window.showInputBox({
    title: "New Mills backlog item",
    prompt: "Backlog ID (e.g. MILLS-42)",
    ignoreFocusOut: true,
  });
  if (!id) return;
  const title = await vscode.window.showInputBox({
    title: "New Mills backlog item",
    prompt: "Title",
    ignoreFocusOut: true,
  });
  if (!title) return;
  const priority = await vscode.window.showQuickPick(["P1", "P2", "P3", "P4"], {
    title: "Priority",
    placeHolder: "Select priority (or Esc for default P3)",
  });
  if (!(await confirm(`Submit backlog item ${id} — "${title}"?`))) return;
  const client = await ensureMutationPrereqs(ctx, "Mills admin token (backlog submit)");
  if (!client) return;
  try {
    await client.backlogSubmit({ ID: id, Title: title, Priority: priority });
    reportSuccess(`backlog submit (${id})`);
    refreshAfterMutation(ctx);
  } catch (error) {
    reportFailure("backlog submit", error);
  }
}

// ===========================================================================
// Misc helpers
// ===========================================================================

async function promptForId(label: string): Promise<string | undefined> {
  return vscode.window.showInputBox({ title: label, prompt: label, ignoreFocusOut: true });
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function formatSnapshotMessage(snapshot: MillsStatusSnapshot): string {
  if (snapshot.health === "unreachable") {
    return `Loom: Mills HUD unreachable${snapshot.error ? ` — ${snapshot.error}` : ""}`;
  }
  if (snapshot.health === "unconfigured") {
    return "Loom: Mills HUD not configured.";
  }
  const parts: string[] = [`health=${snapshot.health}`];
  const policyVersion = snapshot.status?.policy_version;
  if (policyVersion) parts.push(`policy=${policyVersion}`);
  const queueDepth = snapshot.status?.queue_depth;
  if (queueDepth !== undefined) parts.push(`queue=${queueDepth}`);
  const activeRuns = snapshot.status?.active_pipeline_runs;
  if (activeRuns !== undefined) parts.push(`active_runs=${activeRuns}`);
  const regressions = readMetric(snapshot.kpis, MILLS_METRIC_KEYS.regressionCount);
  if (regressions !== undefined) parts.push(`regressions=${regressions}`);
  return `Loom Mills: ${parts.join(", ")}`;
}
