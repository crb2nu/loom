import * as vscode from "vscode";

import { AgentContextClient } from "../clients/agentContext";
import { AgentSessionManager } from "../managers/agentSession";
import { AgentSession, AgentContextEntry } from "../types";

/**
 * Tree item types for agent context hierarchy.
 */
type ContextTreeItemType = "session" | "entry-group" | "entry";

/**
 * Custom TreeItem for agent context.
 */
export class AgentContextTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: ContextTreeItemType,
    public readonly session?: AgentSession,
    public readonly entry?: AgentContextEntry,
    public readonly entryType?: string
  ) {
    super(label, collapsibleState);
  }
}

/**
 * Tree data provider for Agent Context view.
 * Shows sessions and their context entries.
 */
export class AgentContextProvider implements vscode.TreeDataProvider<AgentContextTreeItem> {
  private readonly client: AgentContextClient;
  private readonly sessionManager: AgentSessionManager;
  private readonly emitter = new vscode.EventEmitter<AgentContextTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private sessions: AgentSession[] = [];
  private hasLoaded = false;
  private refreshPromise: Promise<void> | null = null;

  constructor(client: AgentContextClient, sessionManager: AgentSessionManager) {
    this.client = client;
    this.sessionManager = sessionManager;

    // Refresh when session changes
    sessionManager.onDidChangeSession(() => {
      void this.refresh();
    });
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      this.sessions = await this.client.listSessions();
      this.hasLoaded = true;
      this.emitter.fire();
    })();

    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  getTreeItem(element: AgentContextTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: AgentContextTreeItem): Promise<AgentContextTreeItem[]> {
    if (!element) {
      return this.getSessionItems();
    }

    switch (element.itemType) {
      case "session":
        return this.getEntryGroups(element.session!);
      case "entry-group":
        return this.getEntries(element.session!, element.entryType!);
      default:
        return [];
    }
  }

  private async getSessionItems(): Promise<AgentContextTreeItem[]> {
    if (!this.hasLoaded) {
      await this.refresh();
    }

    if (this.sessions.length === 0) {
      const placeholder = new AgentContextTreeItem(
        "No sessions",
        vscode.TreeItemCollapsibleState.None,
        "session"
      );
      placeholder.iconPath = new vscode.ThemeIcon("info");
      placeholder.description = "Start a session to track context";
      placeholder.command = {
        command: "loom.startAgentSession",
        title: "Start Session",
      };
      return [placeholder];
    }

    const activeSessionId = this.sessionManager.getSessionId();

    return this.sessions.map((session) => {
      const isActive = session.session_id === activeSessionId;
      const item = new AgentContextTreeItem(
        session.namespace,
        vscode.TreeItemCollapsibleState.Collapsed,
        "session",
        session
      );

      item.iconPath = new vscode.ThemeIcon(isActive ? "symbol-interface" : "history");
      item.description = `${session.entry_count} entries`;
      item.tooltip = this.buildSessionTooltip(session, isActive);

      if (isActive) {
        item.contextValue = "activeSession";
      }

      return item;
    });
  }

  private async getEntryGroups(session: AgentSession): Promise<AgentContextTreeItem[]> {
    // Get entries grouped by type
    const entries = await this.client.searchContext("", {
      session_id: session.session_id,
      limit: 100,
    });

    // Group by entry type
    const typeMap = new Map<string, number>();
    for (const entry of entries) {
      const count = typeMap.get(entry.entry_type) ?? 0;
      typeMap.set(entry.entry_type, count + 1);
    }

    if (typeMap.size === 0) {
      const placeholder = new AgentContextTreeItem(
        "No entries",
        vscode.TreeItemCollapsibleState.None,
        "entry-group",
        session
      );
      placeholder.iconPath = new vscode.ThemeIcon("info");
      return [placeholder];
    }

    return Array.from(typeMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, count]) => {
        const item = new AgentContextTreeItem(
          this.formatEntryType(type),
          vscode.TreeItemCollapsibleState.Collapsed,
          "entry-group",
          session,
          undefined,
          type
        );
        item.description = `${count}`;
        item.iconPath = new vscode.ThemeIcon(this.getEntryTypeIcon(type));
        return item;
      });
  }

  private async getEntries(
    session: AgentSession,
    entryType: string
  ): Promise<AgentContextTreeItem[]> {
    const entries = await this.client.searchContext("", {
      session_id: session.session_id,
      entry_types: [entryType],
      limit: 50,
    });

    return entries.map((entry) => {
      const item = new AgentContextTreeItem(
        entry.title,
        vscode.TreeItemCollapsibleState.None,
        "entry",
        session,
        entry
      );
      item.description = new Date(entry.created_at).toLocaleTimeString();
      item.iconPath = new vscode.ThemeIcon(this.getEntryTypeIcon(entry.entry_type));
      item.tooltip = this.buildEntryTooltip(entry);
      item.command = {
        command: "loom.showContextEntry",
        title: "Show Entry",
        arguments: [entry],
      };
      return item;
    });
  }

  private formatEntryType(type: string): string {
    return type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, " ");
  }

  private getEntryTypeIcon(type: string): string {
    const iconMap: Record<string, string> = {
      decision: "milestone",
      finding: "search",
      file_read: "file-code",
      question: "question",
      note: "note",
      error: "error",
    };
    return iconMap[type] ?? "symbol-text";
  }

  private buildSessionTooltip(session: AgentSession, isActive: boolean): vscode.MarkdownString {
    const lines: string[] = [
      `**${session.namespace}**`,
      "",
      `Status: ${isActive ? "Active" : session.status}`,
      `Agent: ${session.agent_id}`,
      `Entries: ${session.entry_count}`,
      `Started: ${new Date(session.started_at).toLocaleString()}`,
    ];

    if (session.ended_at) {
      lines.push(`Ended: ${new Date(session.ended_at).toLocaleString()}`);
    }

    if (session.description) {
      lines.push("", session.description);
    }

    const tooltip = new vscode.MarkdownString(lines.join("\n"));
    tooltip.isTrusted = true;
    return tooltip;
  }

  private buildEntryTooltip(entry: AgentContextEntry): vscode.MarkdownString {
    const lines: string[] = [
      `**${entry.title}**`,
      "",
      `Type: ${entry.entry_type}`,
      `Created: ${new Date(entry.created_at).toLocaleString()}`,
    ];

    if (entry.tags && entry.tags.length > 0) {
      lines.push(`Tags: ${entry.tags.join(", ")}`);
    }

    if (entry.file_path) {
      lines.push(`File: \`${entry.file_path}\``);
      if (entry.line_start) {
        lines.push(`Lines: ${entry.line_start}-${entry.line_end ?? entry.line_start}`);
      }
    }

    lines.push("", entry.content);

    const tooltip = new vscode.MarkdownString(lines.join("\n"));
    tooltip.isTrusted = true;
    return tooltip;
  }
}
