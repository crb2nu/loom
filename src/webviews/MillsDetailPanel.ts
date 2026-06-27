import { Webview, WebviewPanel, window, Uri, ViewColumn, OutputChannel } from "vscode";

import {
  MillsAuditFinding,
  MillsBacklogItem,
  MillsClient,
  MillsCostPreview,
  MillsCouncilRun,
  MillsCrossRepoRun,
  MillsEvalScore,
  MillsPipelineRun,
  MillsPolicyProposal,
  MillsSettings,
  MillsSquadMemory,
  MillsSquadOutcome,
  MillsWorkflowRunDetail,
} from "../clients/mills";
import { MillsSubjectRef } from "../providers/mills";

import { BaseWebviewPanel } from "./BaseWebviewPanel";

interface RenderState {
  subject: MillsSubjectRef;
  loading: boolean;
  error?: string;
  payload?: unknown;
}

/**
 * Read-only detail view for a Mills subject (backlog item, council run,
 * pipeline run, audit finding, or policy proposal). Single panel reused
 * across subjects so the user has one persistent inspector window.
 */
export class MillsDetailPanel extends BaseWebviewPanel {
  public static currentPanel: MillsDetailPanel | undefined;

  private state: RenderState;
  private settings: MillsSettings;
  private readonly channel: OutputChannel;

  private constructor(
    panel: WebviewPanel,
    extensionUri: Uri,
    settings: MillsSettings,
    channel: OutputChannel,
    initial: MillsSubjectRef
  ) {
    super(panel, extensionUri);
    this.settings = settings;
    this.channel = channel;
    this.state = { subject: initial, loading: true };
    void this.load();
  }

  public static render(
    extensionUri: Uri,
    settings: MillsSettings,
    channel: OutputChannel,
    subject: MillsSubjectRef
  ): MillsDetailPanel {
    if (MillsDetailPanel.currentPanel) {
      MillsDetailPanel.currentPanel.reveal(ViewColumn.Active);
      MillsDetailPanel.currentPanel.updateSettings(settings);
      void MillsDetailPanel.currentPanel.show(subject);
      return MillsDetailPanel.currentPanel;
    }
    const panel = window.createWebviewPanel(
      "loomMillsDetail",
      `Mills: ${subject.kind} ${subject.id}`,
      ViewColumn.Active,
      { enableScripts: false }
    );
    MillsDetailPanel.currentPanel = new MillsDetailPanel(
      panel,
      extensionUri,
      settings,
      channel,
      subject
    );
    return MillsDetailPanel.currentPanel;
  }

  public updateSettings(next: MillsSettings): void {
    this.settings = next;
  }

  public async show(subject: MillsSubjectRef): Promise<void> {
    this.state = { subject, loading: true };
    this.panel.title = `Mills: ${subject.kind} ${subject.id}`;
    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);
    await this.load();
  }

  protected onDispose(): void {
    MillsDetailPanel.currentPanel = undefined;
  }

  protected handleMessage(): void {
    // No bidirectional messages in v1 (read-only).
  }

  protected getHtmlForWebview(webview: Webview): string {
    const csp = this.generateCsp(webview);
    const body = renderBody(this.state);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${csp}
  <title>${escapeHtml(`Mills: ${this.state.subject.kind} ${this.state.subject.id}`)}</title>
  <style>
    ${this.getBaseStyles()}
    h2 { font-size: 16px; margin: 16px 0 8px 0; }
    .subject {
      display: inline-block;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 12px;
      margin-right: 8px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .field {
      display: grid;
      grid-template-columns: 160px 1fr;
      gap: 8px;
      padding: 4px 0;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
    }
    .field-name {
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    .field-value { word-break: break-word; }
    pre {
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textBlockQuote-border);
      padding: 8px 12px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }
    .empty {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    .error {
      color: var(--vscode-errorForeground);
    }
  </style>
</head>
<body>
  <h1>
    <span class="subject">${escapeHtml(this.state.subject.kind)}</span>
    ${escapeHtml(this.state.subject.id)}
  </h1>
  ${body}
</body>
</html>`;
  }

  private async load(): Promise<void> {
    if (!this.settings.hudBaseUrl) {
      this.state = {
        ...this.state,
        loading: false,
        error: "Mills HUD URL is not configured",
      };
      this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);
      return;
    }
    const client = new MillsClient(this.settings, this.channel);
    try {
      const payload = await this.fetch(client, this.state.subject);
      this.state = { ...this.state, loading: false, payload, error: undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state = { ...this.state, loading: false, error: message };
    }
    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);
  }

  private fetch(client: MillsClient, subject: MillsSubjectRef): Promise<unknown> {
    switch (subject.kind) {
      case "backlog":
        return client.fetchBacklogItem(subject.id);
      case "council":
        return client.fetchCouncilRun(subject.id);
      case "pipeline":
        return client.fetchPipelineRun(subject.id);
      case "audit":
        return client.fetchAuditFinding(subject.id);
      case "policy-proposal":
        // Until loom-core grows /api/mills/policy/proposals/{id}, find
        // the matching record in the list response.
        return client.fetchPolicyProposals().then((items) => {
          const match = items.find((p) => p.ID === subject.id);
          if (!match) {
            throw new Error(`Policy proposal ${subject.id} not found`);
          }
          return match;
        });
      case "cross-repo":
        return client.fetchCrossRepoRun(subject.id);
      case "workflow":
        return client.fetchWorkflowRun(subject.id);
      case "cost-preview":
        // subject.id is the backlog id to estimate.
        return client.fetchCostPreview(subject.id);
      case "eval":
        // No per-score GET on the operator; locate the row in the list.
        return client.fetchEvalScores().then((items) => {
          const match = items.find((s) => String(s.ID ?? "") === subject.id);
          if (!match) {
            throw new Error(`Eval score ${subject.id} not found`);
          }
          return match;
        });
      case "squad-memory":
        // subject.id is the squad name; returns a list of memory rows.
        return client.fetchSquadMemory(subject.id);
      case "squad-outcomes":
        // subject.id is the squad name; returns a list of outcome rows.
        return client.fetchSquadOutcomes(subject.id);
    }
  }
}

export function renderBody(state: RenderState): string {
  if (state.loading) {
    return `<p class="empty">Loading…</p>`;
  }
  if (state.error) {
    return `<p class="error">Error: ${escapeHtml(state.error)}</p>`;
  }
  if (state.payload === undefined || state.payload === null) {
    return `<p class="empty">No content.</p>`;
  }
  const fields = renderFields(state.subject.kind, state.payload);
  const raw = `<h2>Raw payload</h2><pre>${escapeHtml(prettyJson(state.payload))}</pre>`;
  return fields + raw;
}

function renderFields(kind: MillsSubjectRef["kind"], payload: unknown): string {
  switch (kind) {
    case "backlog":
      return renderBacklog(payload as MillsBacklogItem);
    case "council":
      return renderCouncil(payload as MillsCouncilRun);
    case "pipeline":
      return renderPipeline(payload as MillsPipelineRun);
    case "audit":
      return renderAudit(payload as MillsAuditFinding);
    case "policy-proposal":
      return renderPolicyProposal(payload as MillsPolicyProposal);
    case "cross-repo":
      return renderCrossRepo(payload as MillsCrossRepoRun);
    case "workflow":
      return renderWorkflow(payload as MillsWorkflowRunDetail);
    case "cost-preview":
      return renderCostPreview(payload as MillsCostPreview);
    case "eval":
      return renderEval(payload as MillsEvalScore);
    case "squad-memory":
      return renderSquadMemory(payload as MillsSquadMemory[]);
    case "squad-outcomes":
      return renderSquadOutcomes(payload as MillsSquadOutcome[]);
  }
}

function renderBacklog(item: MillsBacklogItem): string {
  return fieldList([
    ["ID", item.ID],
    ["Title", item.Title],
    ["State", item.State],
    ["Priority", item.Priority],
    ["Labels", item.Labels?.join(", ")],
    ["GitLab issue", item.GitLabIssueIID != null ? `!${item.GitLabIssueIID}` : undefined],
    ["Created at", item.CreatedAt],
    ["Updated at", item.UpdatedAt],
  ]);
}

function renderCouncil(item: MillsCouncilRun): string {
  const cost = (item.CostFrontierUSD ?? 0) + (item.CostLocalUSD ?? 0);
  return fieldList([
    ["Run ID", item.ID],
    ["Trigger", item.Trigger],
    ["Outcome", item.Outcome],
    ["Branch", item.BranchName],
    ["Started at", item.StartedAt],
    ["Ended at", item.EndedAt ?? undefined],
    [
      "Cost (frontier)",
      item.CostFrontierUSD != null ? `$${item.CostFrontierUSD.toFixed(2)}` : undefined,
    ],
    ["Cost (local)", item.CostLocalUSD != null ? `$${item.CostLocalUSD.toFixed(2)}` : undefined],
    ["Cost (total)", cost > 0 ? `$${cost.toFixed(2)}` : undefined],
  ]);
}

function renderPipeline(item: MillsPipelineRun): string {
  return fieldList([
    ["Run ID", item.ID],
    ["Backlog", item.BacklogID],
    ["Template", item.Template],
    ["State", item.State],
    ["Stage", item.CurrentStage],
    ["Attempts", item.Attempts != null ? String(item.Attempts) : undefined],
    ["MR", item.MRIID != null ? `!${item.MRIID}` : undefined],
    ["Started at", item.StartedAt],
    ["Ended at", item.EndedAt ?? undefined],
    ["Cost", typeof item.CostUSD === "number" ? `$${item.CostUSD.toFixed(2)}` : undefined],
  ]);
}

function renderAudit(item: MillsAuditFinding): string {
  return fieldList([
    ["Finding ID", String(item.ID)],
    ["Subject kind", item.SubjectKind],
    ["Subject", item.SubjectID],
    ["Severity", item.Severity],
    ["Rubric", item.RubricID],
    [
      "Survival score",
      typeof item.SurvivalScore === "number" ? item.SurvivalScore.toFixed(2) : undefined,
    ],
    ["Cost", typeof item.CostUSD === "number" ? `$${item.CostUSD.toFixed(2)}` : undefined],
    ["Created at", item.CreatedAt],
  ]);
}

function renderPolicyProposal(item: MillsPolicyProposal): string {
  const base = fieldList([
    ["Proposal ID", item.ID],
    ["Status", item.Status],
    ["Reason", item.Reason],
    ["Created at", item.CreatedAt],
  ]);
  if (item.Diff) {
    return base + `<h2>Diff</h2><pre>${escapeHtml(item.Diff)}</pre>`;
  }
  return base;
}

function renderCrossRepo(item: MillsCrossRepoRun): string {
  const base = fieldList([
    ["Run ID", item.id],
    ["Backlog item", item.backlog_item_id],
    ["State", item.state],
    ["Atomicity", item.atomicity_strategy],
    ["Created at", item.created_at],
    ["Updated at", item.updated_at],
  ]);
  const repos = item.repos ?? [];
  if (repos.length === 0) {
    return base + `<h2>Repos</h2><p class="empty">No repos in this run.</p>`;
  }
  const rows = repos
    .map((r) =>
      fieldList([
        ["Repo", r.repo_name ?? (r.project_id != null ? `project ${r.project_id}` : undefined)],
        ["Branch", r.branch],
        ["MR", r.mr_iid != null ? `!${r.mr_iid}` : undefined],
        ["CI status", r.ci_status],
        ["Gate status", r.gate_status],
      ])
    )
    .join("");
  return base + `<h2>Repos (${repos.length})</h2>` + rows;
}

function renderWorkflow(detail: MillsWorkflowRunDetail): string {
  const run = detail?.run ?? {};
  const base = fieldList([
    ["Run ID", run.id],
    ["Backlog", run.backlog_id],
    ["Engine", run.engine],
    ["Template", run.template],
    ["State", run.state],
    ["Steps", run.step_count != null ? String(run.step_count) : undefined],
    ["Started at", run.started_at ?? undefined],
    ["Ended at", run.ended_at ?? undefined],
    ["Cost", typeof run.cost_usd === "number" ? `$${run.cost_usd.toFixed(2)}` : undefined],
  ]);
  const steps = detail?.steps ?? [];
  if (steps.length === 0) {
    return base + `<h2>Steps</h2><p class="empty">No journaled steps.</p>`;
  }
  const rows = steps
    .map((s) =>
      fieldList([
        ["Step", s.step_key],
        ["Event", s.event_type],
        ["Status", s.status],
        ["Badge", s.badge],
        ["Effects", s.effect_count != null ? String(s.effect_count) : undefined],
        ["Cost", typeof s.cost_usd === "number" ? `$${s.cost_usd.toFixed(2)}` : undefined],
      ])
    )
    .join("");
  return base + `<h2>Steps (${steps.length})</h2>` + rows;
}

function renderCostPreview(item: MillsCostPreview): string {
  return fieldList([
    ["Backlog", item.backlog_id],
    ["Path class", item.path_class],
    [
      "Estimate",
      typeof item.estimate_usd === "number" ? `$${item.estimate_usd.toFixed(2)}` : undefined,
    ],
    [
      "Median historical",
      typeof item.median_historical_usd === "number"
        ? `$${item.median_historical_usd.toFixed(2)}`
        : undefined,
    ],
    [
      "Sidecar overhead",
      typeof item.sidecar_overhead_usd === "number"
        ? `$${item.sidecar_overhead_usd.toFixed(2)} (${item.sidecar_slice_count ?? 0} slices)`
        : undefined,
    ],
    [
      "Recursion overhead",
      typeof item.recursion_overhead_usd === "number"
        ? `$${item.recursion_overhead_usd.toFixed(2)}`
        : undefined,
    ],
    [
      "Ensemble cap",
      typeof item.ensemble_cap_usd === "number"
        ? `$${item.ensemble_cap_usd.toFixed(2)}`
        : undefined,
    ],
    ["Capped by policy", item.capped_by_policy != null ? String(item.capped_by_policy) : undefined],
    ["Confidence", item.confidence],
    ["Sample size", item.sample_size != null ? String(item.sample_size) : undefined],
    ["Source", item.source],
  ]);
}

function renderEval(item: MillsEvalScore): string {
  const base = fieldList([
    ["Score ID", item.ID != null ? String(item.ID) : undefined],
    ["Subject kind", item.SubjectKind],
    ["Subject", item.SubjectID],
    ["Rubric", item.Rubric],
    ["Score", typeof item.Score === "number" ? item.Score.toFixed(2) : undefined],
    ["Judged by", item.JudgedBy],
    ["Evaluated at", item.EvaluatedAt],
    ["Notes", item.Notes],
  ]);
  if (item.Breakdown && Object.keys(item.Breakdown).length > 0) {
    return base + `<h2>Breakdown</h2><pre>${escapeHtml(prettyJson(item.Breakdown))}</pre>`;
  }
  return base;
}

function renderSquadMemory(rows: MillsSquadMemory[]): string {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    return `<p class="empty">No working-memory entries for this squad.</p>`;
  }
  return list
    .map((m) =>
      fieldList([
        ["Title", m.Title],
        ["Kind", m.Kind],
        ["Importance", typeof m.Importance === "number" ? m.Importance.toFixed(2) : undefined],
        ["Body", m.Body],
        ["Refs", m.Refs?.join(", ")],
        ["Last seen", m.LastSeenAt],
      ])
    )
    .join("");
}

function renderSquadOutcomes(rows: MillsSquadOutcome[]): string {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    return `<p class="empty">No recorded outcomes for this squad.</p>`;
  }
  return list
    .map((o) =>
      fieldList([
        ["Outcome", o.Outcome],
        ["Path class", o.PathClass],
        ["Pipeline run", o.PipelineRunID],
        ["Cost", typeof o.CostUSD === "number" ? `$${o.CostUSD.toFixed(2)}` : undefined],
        ["Duration", o.DurationSeconds != null ? `${o.DurationSeconds}s` : undefined],
        ["Created at", o.CreatedAt],
      ])
    )
    .join("");
}

function fieldList(rows: Array<[string, string | undefined]>): string {
  const visible = rows.filter(([, v]) => v !== undefined && v !== "");
  if (visible.length === 0) {
    return `<p class="empty">No structured fields.</p>`;
  }
  return visible
    .map(
      ([name, value]) =>
        `<div class="field"><span class="field-name">${escapeHtml(name)}</span><span class="field-value">${escapeHtml(String(value))}</span></div>`
    )
    .join("");
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
