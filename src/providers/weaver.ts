import * as vscode from "vscode";

import {
  AIModelsRoleEntry,
  WeaverClient,
  WeaverDomainSummary,
  WeaverHistoryEntry,
  WeaverSettings,
  WeaverStatusResponse,
} from "../clients/weaver";
import { Logger } from "../utils/logger";

/**
 * WeaverTreeProvider feeds the "Loom Weaver" sidebar tree. Read-only.
 * Mirrors the HUD WeaverPanel.svelte sections:
 *   1. Status (router/subagent model, degraded banner)
 *   2. Domains (catalog with tools)
 *   3. Recent queries
 *   4. Role defaults (pkg/aimodels)
 *
 * See services/loom-core/.loom/111-product-spec-weaver-qwen3-integration-2026-05-08.md
 * (VSC-001).
 */
export class WeaverTreeProvider implements vscode.TreeDataProvider<WeaverTreeItem> {
  private readonly emitter = new vscode.EventEmitter<WeaverTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private status: WeaverStatusResponse | null = null;
  private history: WeaverHistoryEntry[] = [];
  private roles: AIModelsRoleEntry[] = [];
  private overridePath = "";
  private fetchError = "";

  private readonly client: WeaverClient;

  constructor(
    settings: WeaverSettings,
    private readonly logger: Logger
  ) {
    this.client = new WeaverClient(settings);
  }

  /** Reload all data from the HUD. Safe to call from commands. */
  async refresh(): Promise<void> {
    this.fetchError = "";
    try {
      const [status, hist, roles] = await Promise.all([
        this.client.status().catch((err: unknown) => {
          // status is the only required call; bubble its error.
          throw err instanceof Error ? err : new Error(String(err));
        }),
        this.client.history().catch(() => null),
        this.client.roles().catch(() => null),
      ]);
      this.status = status;
      this.history = hist?.entries ?? [];
      this.roles = roles?.roles ?? [];
      this.overridePath = roles?.override_path ?? "";
    } catch (err) {
      this.fetchError = err instanceof Error ? err.message : String(err);
      this.logger.error(`weaver: refresh failed: ${this.fetchError}`);
    }
    this.emitter.fire();
  }

  getTreeItem(element: WeaverTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WeaverTreeItem): Promise<WeaverTreeItem[]> {
    if (!element) {
      // Lazy first load; subsequent refreshes go through refresh().
      if (this.status === null && this.fetchError === "") {
        await this.refresh();
      }

      if (this.fetchError) {
        return [
          new MessageItem(`Error: ${this.fetchError}`, "error"),
          new MessageItem("Set Loom HUD URL in settings, then click refresh.", "muted"),
        ];
      }
      if (!this.status) {
        return [new MessageItem("Loading...", "muted")];
      }
      return this.rootSections();
    }
    if (element instanceof SectionItem) {
      return element.children;
    }
    return [];
  }

  private rootSections(): WeaverTreeItem[] {
    const out: WeaverTreeItem[] = [];

    // Status section
    const status = this.status!;
    const statusChildren: WeaverTreeItem[] = [];
    statusChildren.push(
      new MessageItem(`enabled: ${status.enabled ? "yes" : "no"}`, status.enabled ? "ok" : "muted")
    );
    if (status.router_model) {
      statusChildren.push(new MessageItem(`router: ${status.router_model}`, "muted"));
    }
    if (status.subagent_model) {
      statusChildren.push(new MessageItem(`subagent: ${status.subagent_model}`, "muted"));
    }
    if (status.degraded) {
      statusChildren.push(new MessageItem("DEGRADED", "error"));
      for (const m of status.missing_models ?? []) {
        statusChildren.push(new MessageItem(`missing: ${m}`, "error"));
      }
    } else if (typeof status.degraded === "boolean") {
      statusChildren.push(new MessageItem("preflight: ok", "ok"));
    }
    if (status.catalog_error) {
      statusChildren.push(new MessageItem(`catalog error: ${status.catalog_error}`, "error"));
    }
    out.push(new SectionItem("Status", statusChildren));

    // Domains section
    const domains: WeaverDomainSummary[] = status.domains ?? [];
    out.push(
      new SectionItem(
        `Domains (${domains.length})`,
        domains.map((d) => domainItem(d))
      )
    );

    // History section
    const recent = [...this.history]
      .sort((a, b) => {
        const at = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const bt = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return bt - at;
      })
      .slice(0, 20);
    out.push(
      new SectionItem(
        `Recent queries (${recent.length})`,
        recent.map((entry) => historyItem(entry))
      )
    );

    // Role defaults section
    out.push(
      new SectionItem(
        `Role defaults (${this.roles.length})`,
        this.roles.map((r) => roleItem(r))
      )
    );

    if (this.overridePath) {
      out.push(new MessageItem(`Override file: ${this.overridePath}`, "muted"));
    }

    return out;
  }
}

// --- Tree item types ---

export type WeaverTreeItem = SectionItem | MessageItem | DomainItem | HistoryItem | RoleItem;

class SectionItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly children: WeaverTreeItem[]
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "loomWeaverSection";
  }
}

type MessageTone = "ok" | "muted" | "error";

class MessageItem extends vscode.TreeItem {
  constructor(label: string, tone: MessageTone) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = `loomWeaverMessage-${tone}`;
    if (tone === "error") {
      this.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("editorWarning.foreground")
      );
    } else if (tone === "ok") {
      this.iconPath = new vscode.ThemeIcon("check");
    } else {
      this.iconPath = new vscode.ThemeIcon("dash");
    }
  }
}

class DomainItem extends vscode.TreeItem {
  constructor(label: string, tooltip: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = tooltip;
    this.contextValue = "loomWeaverDomain";
    this.iconPath = new vscode.ThemeIcon("symbol-method");
  }
}

class HistoryItem extends vscode.TreeItem {
  constructor(label: string, tooltip: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = tooltip;
    this.contextValue = "loomWeaverHistoryEntry";
    this.iconPath = new vscode.ThemeIcon("history");
  }
}

class RoleItem extends vscode.TreeItem {
  constructor(label: string, tooltip: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = tooltip;
    this.contextValue = "loomWeaverRole";
    this.iconPath = new vscode.ThemeIcon("symbol-parameter");
  }
}

function domainItem(d: WeaverDomainSummary): DomainItem {
  const toolCount = Array.isArray(d.tools) ? d.tools.length : 0;
  const label = d.model ? `${d.name}  ·  ${d.model}` : d.name;
  const tooltipParts = [
    d.description ?? "",
    `tools: ${toolCount}`,
    d.backend ? `backend: ${d.backend}` : "",
  ].filter(Boolean);
  return new DomainItem(label, tooltipParts.join("\n"));
}

function historyItem(e: WeaverHistoryEntry): HistoryItem {
  const status = e.status ?? "?";
  const latency = e.latency_ms !== undefined ? `${Math.round(e.latency_ms)}ms` : "?";
  const tokens = e.total_tokens !== undefined ? `${e.total_tokens}t` : "?";
  const truncQuery = (e.query ?? "").slice(0, 60);
  const label = `[${status}] ${truncQuery}  ·  ${latency}  ·  ${tokens}`;
  const tooltip = [
    e.query ?? "",
    `status: ${status}`,
    `latency: ${latency}`,
    `tokens: ${tokens}`,
    e.parent_session_id ? `parent_session: ${e.parent_session_id}` : "",
    e.domains_used?.length ? `domains: ${e.domains_used.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return new HistoryItem(label, tooltip);
}

function roleItem(r: AIModelsRoleEntry): RoleItem {
  const label = `${r.role}  →  ${r.primary || "—"}`;
  const tooltip = [
    `role: ${r.role}`,
    `primary: ${r.primary || "—"}`,
    r.fallbacks?.length ? `fallbacks: ${r.fallbacks.join(", ")}` : "(no fallbacks)",
  ].join("\n");
  return new RoleItem(label, tooltip);
}
