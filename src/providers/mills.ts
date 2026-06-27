import * as vscode from "vscode";

import {
  MillsAuditFinding,
  MillsBacklogItem,
  MillsClient,
  MillsCouncilRun,
  MillsCrossRepoRun,
  MillsEvalScore,
  MillsPipelineRun,
  MillsPolicyProposal,
  MillsSettings,
  MillsSquad,
  MillsWorkflowRun,
} from "../clients/mills";
import { Logger } from "../utils/logger";

export type MillsSubjectKind =
  | "backlog"
  | "council"
  | "pipeline"
  | "audit"
  | "policy-proposal"
  | "cross-repo"
  | "workflow"
  | "eval"
  | "cost-preview"
  | "squad-memory"
  | "squad-outcomes";

export interface MillsSubjectRef {
  kind: MillsSubjectKind;
  id: string;
}

type SectionId =
  | "backlog"
  | "pipelines"
  | "council"
  | "squads"
  | "audit"
  | "proposals"
  | "crossRepo"
  | "workflows"
  | "evalScores";

interface SectionDefinition {
  id: SectionId;
  label: string;
  emptyText: string;
  fetch: (client: MillsClient) => Promise<unknown[]>;
  toLeaf: (item: unknown) => MillsLeafItem;
}

const SECTIONS: SectionDefinition[] = [
  {
    id: "backlog",
    label: "Backlog",
    emptyText: "No backlog items",
    fetch: (c) => c.fetchBacklog(),
    toLeaf: (raw) => backlogLeaf(raw as MillsBacklogItem),
  },
  {
    id: "pipelines",
    label: "Pipeline Runs",
    emptyText: "No pipeline runs",
    fetch: (c) => c.fetchPipelineRuns(),
    toLeaf: (raw) => pipelineLeaf(raw as MillsPipelineRun),
  },
  {
    id: "council",
    label: "Council Runs",
    emptyText: "No council runs",
    fetch: (c) => c.fetchCouncilRuns(),
    toLeaf: (raw) => councilLeaf(raw as MillsCouncilRun),
  },
  {
    id: "crossRepo",
    label: "Cross-Repo Runs",
    emptyText: "No cross-repo runs",
    fetch: (c) => c.fetchCrossRepoRuns(),
    toLeaf: (raw) => crossRepoLeaf(raw as MillsCrossRepoRun),
  },
  {
    id: "workflows",
    label: "Workflow Runs",
    emptyText: "No workflow runs",
    fetch: (c) => c.fetchWorkflowRuns(),
    toLeaf: (raw) => workflowLeaf(raw as MillsWorkflowRun),
  },
  {
    id: "evalScores",
    label: "Eval Scores",
    emptyText: "No eval scores recorded",
    fetch: (c) => c.fetchEvalScores(),
    toLeaf: (raw) => evalLeaf(raw as MillsEvalScore),
  },
  {
    id: "squads",
    label: "Squads",
    emptyText: "No squads configured",
    fetch: (c) => c.fetchSquads(),
    toLeaf: (raw) => squadLeaf(raw as MillsSquad),
  },
  {
    id: "audit",
    label: "Audit Findings",
    emptyText: "No audit findings",
    fetch: (c) => c.fetchAuditFindings(),
    toLeaf: (raw) => auditLeaf(raw as MillsAuditFinding),
  },
  {
    id: "proposals",
    label: "Policy Proposals",
    emptyText: "No policy proposals",
    fetch: (c) => c.fetchPolicyProposals(),
    toLeaf: (raw) => policyProposalLeaf(raw as MillsPolicyProposal),
  },
];

interface MillsLeafItem {
  label: string;
  description?: string;
  tooltip?: string;
  iconId: string;
  iconColor?: string;
  subject?: MillsSubjectRef;
  /**
   * When set, the leaf is expandable and exposes the per-squad
   * Memory/Outcomes child rows for this squad name (instead of opening a
   * detail directly). Used only by squad leaves.
   */
  squadName?: string;
  /**
   * When set, the leaf is expandable and exposes a "Cost Preview" child
   * row for this backlog id. The leaf itself still opens its own detail
   * via `subject`. Used only by backlog leaves.
   */
  costPreviewBacklogId?: string;
}

type MillsTreeNode =
  | {
      kind: "section";
      sectionId: SectionId;
      label: string;
      count: number;
      error?: string;
    }
  | {
      kind: "leaf";
      sectionId: SectionId;
      leaf: MillsLeafItem;
    }
  | {
      kind: "squad-child";
      label: string;
      iconId: string;
      subject: MillsSubjectRef;
    }
  | {
      kind: "placeholder";
      sectionId: SectionId;
      label: string;
      iconId: string;
    };

interface SectionState {
  items: unknown[];
  error?: string;
  loading: boolean;
  loaded: boolean;
}

/**
 * Tree provider for the Mills view. Lazy-loads each section the first
 * time it's expanded; explicit refresh re-fetches all loaded sections.
 */
export class MillsTreeProvider implements vscode.TreeDataProvider<MillsTreeNode> {
  private readonly emitter = new vscode.EventEmitter<MillsTreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly logger: Logger;
  private readonly channel: vscode.OutputChannel;
  private settings: MillsSettings;
  private readonly state: Record<SectionId, SectionState> = {
    backlog: emptyState(),
    pipelines: emptyState(),
    council: emptyState(),
    crossRepo: emptyState(),
    workflows: emptyState(),
    evalScores: emptyState(),
    squads: emptyState(),
    audit: emptyState(),
    proposals: emptyState(),
  };

  constructor(initial: MillsSettings, channel: vscode.OutputChannel) {
    this.settings = initial;
    this.channel = channel;
    this.logger = new Logger(channel, "MillsTree");
  }

  updateSettings(next: MillsSettings): void {
    this.settings = next;
    this.invalidateAll();
  }

  /**
   * Force re-fetch on next expand. Triggers a tree rebuild.
   */
  refresh(): void {
    this.invalidateAll();
  }

  getTreeItem(node: MillsTreeNode): vscode.TreeItem {
    if (node.kind === "section") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `mills.section.${node.sectionId}`;
      item.contextValue = `mills.section.${node.sectionId}`;
      if (node.error) {
        item.description = "error";
        item.iconPath = new vscode.ThemeIcon(
          "error",
          new vscode.ThemeColor("statusBarItem.errorBackground")
        );
        item.tooltip = node.error;
      } else {
        item.description = `${node.count}`;
        item.iconPath = new vscode.ThemeIcon(sectionIcon(node.sectionId));
      }
      return item;
    }
    if (node.kind === "placeholder") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(node.iconId);
      return item;
    }
    if (node.kind === "squad-child") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(node.iconId);
      item.contextValue = `mills.squad-child.${node.subject.kind}`;
      item.command = {
        command: "loom.openMillsDetail",
        title: "Open Mills Detail",
        arguments: [node.subject],
      };
      return item;
    }
    const leaf = node.leaf;
    // Squad leaves expand into Memory / Outcomes; backlog leaves expand
    // into a Cost Preview child while staying directly clickable.
    // Everything else is a flat clickable leaf.
    const expandable = Boolean(leaf.squadName) || Boolean(leaf.costPreviewBacklogId);
    const collapsible = expandable
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(leaf.label, collapsible);
    item.description = leaf.description;
    item.tooltip = leaf.tooltip;
    item.iconPath = leaf.iconColor
      ? new vscode.ThemeIcon(leaf.iconId, new vscode.ThemeColor(leaf.iconColor))
      : new vscode.ThemeIcon(leaf.iconId);
    item.contextValue = `mills.leaf.${node.sectionId}`;
    if (leaf.subject) {
      item.command = {
        command: "loom.openMillsDetail",
        title: "Open Mills Detail",
        arguments: [leaf.subject],
      };
    }
    return item;
  }

  async getChildren(node?: MillsTreeNode): Promise<MillsTreeNode[]> {
    if (!this.settings.hudBaseUrl) {
      return [
        {
          kind: "placeholder",
          sectionId: "backlog",
          label: "Mills HUD URL not configured",
          iconId: "circle-slash",
        },
      ];
    }

    if (!node) {
      // Build section list — counts come from cached state if loaded.
      return SECTIONS.map<MillsTreeNode>((def) => ({
        kind: "section",
        sectionId: def.id,
        label: def.label,
        count: this.state[def.id].items.length,
        error: this.state[def.id].error,
      }));
    }

    // A squad leaf expands into its Memory / Outcomes child rows; each
    // child opens the read-only detail panel for that squad.
    if (node.kind === "leaf" && node.leaf.squadName) {
      const name = node.leaf.squadName;
      return [
        {
          kind: "squad-child",
          label: "Memory",
          iconId: "history",
          subject: { kind: "squad-memory", id: name },
        },
        {
          kind: "squad-child",
          label: "Outcomes",
          iconId: "graph",
          subject: { kind: "squad-outcomes", id: name },
        },
      ];
    }

    // A backlog leaf expands into a Cost Preview child row that opens the
    // read-only estimate detail for that backlog id.
    if (node.kind === "leaf" && node.leaf.costPreviewBacklogId) {
      const id = node.leaf.costPreviewBacklogId;
      return [
        {
          kind: "squad-child",
          label: "Cost Preview",
          iconId: "credit-card",
          subject: { kind: "cost-preview", id },
        },
      ];
    }

    if (node.kind !== "section") {
      return [];
    }

    const def = SECTIONS.find((s) => s.id === node.sectionId);
    if (!def) return [];

    const state = this.state[def.id];
    if (!state.loaded && !state.loading) {
      await this.loadSection(def);
    }

    if (state.error) {
      return [
        {
          kind: "placeholder",
          sectionId: def.id,
          label: `Error: ${state.error}`,
          iconId: "error",
        },
      ];
    }
    if (state.items.length === 0) {
      return [
        {
          kind: "placeholder",
          sectionId: def.id,
          label: def.emptyText,
          iconId: "info",
        },
      ];
    }
    return state.items.map<MillsTreeNode>((item) => ({
      kind: "leaf",
      sectionId: def.id,
      leaf: def.toLeaf(item),
    }));
  }

  private async loadSection(def: SectionDefinition): Promise<void> {
    const state = this.state[def.id];
    state.loading = true;
    state.error = undefined;
    const client = new MillsClient(this.settings, this.channel);
    try {
      const items = await def.fetch(client);
      state.items = items;
      state.loaded = true;
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      state.items = [];
      state.loaded = true;
      this.logger.warn(`Mills ${def.id} fetch failed: ${state.error}`);
    } finally {
      state.loading = false;
    }
  }

  private invalidateAll(): void {
    for (const def of SECTIONS) {
      this.state[def.id] = emptyState();
    }
    this.emitter.fire();
  }
}

function emptyState(): SectionState {
  return { items: [], loading: false, loaded: false };
}

function sectionIcon(id: SectionId): string {
  switch (id) {
    case "backlog":
      return "list-unordered";
    case "pipelines":
      return "rocket";
    case "council":
      return "organization";
    case "crossRepo":
      return "repo-forked";
    case "workflows":
      return "list-tree";
    case "evalScores":
      return "dashboard";
    case "squads":
      return "people";
    case "audit":
      return "shield";
    case "proposals":
      return "lightbulb";
  }
}

function backlogLeaf(item: MillsBacklogItem): MillsLeafItem {
  const priority = item.Priority ? `[${item.Priority}] ` : "";
  return {
    label: item.ID,
    description: `${priority}${item.State ?? ""}${item.Title ? " — " + item.Title : ""}`.trim(),
    tooltip: backlogTooltip(item),
    iconId: stateIcon(item.State),
    subject: { kind: "backlog", id: item.ID },
    costPreviewBacklogId: item.ID,
  };
}

function pipelineLeaf(item: MillsPipelineRun): MillsLeafItem {
  const stage = item.CurrentStage ? ` [${item.CurrentStage}]` : "";
  const backlog = item.BacklogID ? ` ${item.BacklogID}` : "";
  return {
    label: item.ID,
    description: `${item.State ?? ""}${stage}${backlog}`.trim(),
    tooltip: pipelineTooltip(item),
    iconId: pipelineIcon(item.State),
    subject: { kind: "pipeline", id: item.ID },
  };
}

function councilLeaf(item: MillsCouncilRun): MillsLeafItem {
  const trigger = item.Trigger ? `[${item.Trigger}] ` : "";
  return {
    label: item.ID,
    description: `${trigger}${item.Outcome ?? "in-flight"}`.trim(),
    tooltip: councilTooltip(item),
    iconId: councilIcon(item.Outcome),
    subject: { kind: "council", id: item.ID },
  };
}

function squadLeaf(item: MillsSquad): MillsLeafItem {
  const name = item.Name ?? item.name ?? "(unnamed)";
  const description = item.Description ?? item.description ?? "";
  // Squad leaves expand into Memory / Outcomes child rows (squadName set)
  // rather than opening a detail panel directly. An unnamed squad stays
  // a flat leaf — there's no name to key the memory/outcomes reads on.
  const squadName = name !== "(unnamed)" ? name : undefined;
  return {
    label: name,
    description: typeof description === "string" ? description : "",
    iconId: "person",
    squadName,
  };
}

function crossRepoLeaf(item: MillsCrossRepoRun): MillsLeafItem {
  const backlog = item.backlog_item_id ? ` ${item.backlog_item_id}` : "";
  const repoCount = item.repos?.length ?? 0;
  return {
    label: item.id,
    description:
      `${item.state ?? "?"}${backlog} (${repoCount} repo${repoCount === 1 ? "" : "s"})`.trim(),
    tooltip: crossRepoTooltip(item),
    iconId: crossRepoIcon(item.state),
    subject: { kind: "cross-repo", id: item.id },
  };
}

function workflowLeaf(item: MillsWorkflowRun): MillsLeafItem {
  const engine = item.engine ? `[${item.engine}] ` : "";
  const steps = item.step_count != null ? ` ${item.step_count} steps` : "";
  return {
    label: item.id,
    description: `${engine}${item.state ?? "?"}${steps}`.trim(),
    tooltip: workflowTooltip(item),
    iconId: workflowIcon(item.state),
    subject: { kind: "workflow", id: item.id },
  };
}

function evalLeaf(item: MillsEvalScore): MillsLeafItem {
  const score = typeof item.Score === "number" ? item.Score.toFixed(2) : "—";
  return {
    label: `${item.SubjectKind ?? "eval"}/${item.SubjectID ?? item.ID ?? "?"}`,
    description: `${item.Rubric ?? ""} score=${score}`.trim(),
    tooltip: evalTooltip(item),
    iconId: "symbol-number",
    subject: { kind: "eval", id: String(item.ID ?? "") },
  };
}

function auditLeaf(item: MillsAuditFinding): MillsLeafItem {
  const score = typeof item.SurvivalScore === "number" ? item.SurvivalScore.toFixed(2) : "—";
  return {
    label: `${item.SubjectKind ?? "audit"}/${item.SubjectID ?? item.ID}`,
    description: `${item.Severity ?? ""} score=${score}`.trim(),
    tooltip: auditTooltip(item),
    iconId: severityIcon(item.Severity),
    iconColor: severityColor(item.Severity),
    subject: { kind: "audit", id: String(item.ID) },
  };
}

function policyProposalLeaf(item: MillsPolicyProposal): MillsLeafItem {
  return {
    label: item.ID,
    description: `${item.Status ?? "pending"}${item.Reason ? " — " + item.Reason : ""}`.trim(),
    tooltip: item.Reason,
    iconId: proposalIcon(item.Status),
    subject: { kind: "policy-proposal", id: item.ID },
  };
}

function proposalIcon(status?: string): string {
  switch (status) {
    case "applied":
      return "check";
    case "rejected":
      return "x";
    default:
      return "lightbulb";
  }
}

function stateIcon(state?: string): string {
  switch (state) {
    case "queued":
      return "circle-outline";
    case "running":
    case "in-progress":
      return "sync~spin";
    case "blocked":
      return "stop-circle";
    case "done":
      return "check";
    default:
      return "circle";
  }
}

function pipelineIcon(state?: string): string {
  if (!state) return "circle";
  if (state === "succeeded" || state === "merged") return "check";
  if (state === "failed" || state === "errored") return "error";
  if (state === "queued") return "circle-outline";
  return "sync~spin";
}

function councilIcon(outcome?: string): string {
  if (!outcome || outcome === "in-flight") return "sync~spin";
  if (outcome === "success") return "check";
  if (outcome === "no-op") return "dash";
  return "error";
}

function crossRepoIcon(state?: string): string {
  switch (state) {
    case "merged":
      return "check";
    case "reverted":
    case "failed":
      return "error";
    case "planning":
      return "circle-outline";
    default:
      return "sync~spin";
  }
}

function workflowIcon(state?: string): string {
  switch (state) {
    case "succeeded":
    case "completed":
      return "check";
    case "failed":
    case "errored":
      return "error";
    case "quarantined":
      return "warning";
    case "pending":
    case "queued":
      return "circle-outline";
    default:
      return "sync~spin";
  }
}

function severityIcon(severity?: string): string {
  switch (severity) {
    case "critical":
    case "high":
      return "warning";
    case "medium":
      return "info";
    default:
      return "circle";
  }
}

function severityColor(severity?: string): string | undefined {
  switch (severity) {
    case "critical":
      return "errorForeground";
    case "high":
      return "list.warningForeground";
    default:
      return undefined;
  }
}

function backlogTooltip(item: MillsBacklogItem): string {
  const lines: string[] = [`ID: ${item.ID}`];
  if (item.Title) lines.push(`Title: ${item.Title}`);
  if (item.State) lines.push(`State: ${item.State}`);
  if (item.Priority) lines.push(`Priority: ${item.Priority}`);
  if (item.Labels?.length) lines.push(`Labels: ${item.Labels.join(", ")}`);
  if (item.GitLabIssueIID != null) lines.push(`GitLab issue: !${item.GitLabIssueIID}`);
  return lines.join("\n");
}

function pipelineTooltip(item: MillsPipelineRun): string {
  const lines: string[] = [`Run: ${item.ID}`];
  if (item.BacklogID) lines.push(`Backlog: ${item.BacklogID}`);
  if (item.Template) lines.push(`Template: ${item.Template}`);
  if (item.State) lines.push(`State: ${item.State}`);
  if (item.CurrentStage) lines.push(`Stage: ${item.CurrentStage}`);
  if (item.Attempts != null) lines.push(`Attempts: ${item.Attempts}`);
  if (item.MRIID != null) lines.push(`MR: !${item.MRIID}`);
  if (typeof item.CostUSD === "number") lines.push(`Cost: $${item.CostUSD.toFixed(2)}`);
  return lines.join("\n");
}

function councilTooltip(item: MillsCouncilRun): string {
  const lines: string[] = [`Run: ${item.ID}`];
  if (item.Trigger) lines.push(`Trigger: ${item.Trigger}`);
  if (item.Outcome) lines.push(`Outcome: ${item.Outcome}`);
  if (item.BranchName) lines.push(`Branch: ${item.BranchName}`);
  const totalCost = (item.CostFrontierUSD ?? 0) + (item.CostLocalUSD ?? 0);
  if (totalCost > 0) lines.push(`Cost: $${totalCost.toFixed(2)}`);
  return lines.join("\n");
}

function auditTooltip(item: MillsAuditFinding): string {
  const lines: string[] = [`Finding: ${item.ID}`];
  if (item.SubjectKind) lines.push(`Subject kind: ${item.SubjectKind}`);
  if (item.SubjectID) lines.push(`Subject: ${item.SubjectID}`);
  if (item.Severity) lines.push(`Severity: ${item.Severity}`);
  if (item.RubricID) lines.push(`Rubric: ${item.RubricID}`);
  if (typeof item.SurvivalScore === "number") {
    lines.push(`Survival score: ${item.SurvivalScore.toFixed(2)}`);
  }
  return lines.join("\n");
}

function crossRepoTooltip(item: MillsCrossRepoRun): string {
  const lines: string[] = [`Run: ${item.id}`];
  if (item.backlog_item_id) lines.push(`Backlog: ${item.backlog_item_id}`);
  if (item.state) lines.push(`State: ${item.state}`);
  if (item.atomicity_strategy) lines.push(`Strategy: ${item.atomicity_strategy}`);
  if (item.repos?.length) {
    lines.push(`Repos: ${item.repos.map((r) => r.repo_name ?? r.project_id ?? "?").join(", ")}`);
  }
  return lines.join("\n");
}

function workflowTooltip(item: MillsWorkflowRun): string {
  const lines: string[] = [`Run: ${item.id}`];
  if (item.backlog_id) lines.push(`Backlog: ${item.backlog_id}`);
  if (item.engine) lines.push(`Engine: ${item.engine}`);
  if (item.template) lines.push(`Template: ${item.template}`);
  if (item.state) lines.push(`State: ${item.state}`);
  if (item.step_count != null) lines.push(`Steps: ${item.step_count}`);
  if (typeof item.cost_usd === "number") lines.push(`Cost: $${item.cost_usd.toFixed(2)}`);
  return lines.join("\n");
}

function evalTooltip(item: MillsEvalScore): string {
  const lines: string[] = [`Score: ${item.ID ?? "?"}`];
  if (item.SubjectKind) lines.push(`Subject kind: ${item.SubjectKind}`);
  if (item.SubjectID) lines.push(`Subject: ${item.SubjectID}`);
  if (item.Rubric) lines.push(`Rubric: ${item.Rubric}`);
  if (typeof item.Score === "number") lines.push(`Score: ${item.Score.toFixed(2)}`);
  if (item.JudgedBy) lines.push(`Judged by: ${item.JudgedBy}`);
  return lines.join("\n");
}
