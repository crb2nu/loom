import * as vscode from "vscode";

import {
  MillsAuditFinding,
  MillsBacklogItem,
  MillsClient,
  MillsCouncilRun,
  MillsPipelineRun,
  MillsPolicyProposal,
  MillsSettings,
  MillsSquad,
} from "../clients/mills";
import { Logger } from "../utils/logger";

export type MillsSubjectKind = "backlog" | "council" | "pipeline" | "audit" | "policy-proposal";

export interface MillsSubjectRef {
  kind: MillsSubjectKind;
  id: string;
}

type SectionId = "backlog" | "pipelines" | "council" | "squads" | "audit" | "proposals";

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
    const leaf = node.leaf;
    const item = new vscode.TreeItem(leaf.label, vscode.TreeItemCollapsibleState.None);
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
  return {
    label: name,
    description: typeof description === "string" ? description : "",
    iconId: "person",
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
