import * as vscode from "vscode";

import { DaemonClient } from "../clients/daemon";
import { DaemonToolInfo } from "../types";

/**
 * Custom TreeItem for tools that tracks server grouping.
 */
export class ToolTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly isServer: boolean = false,
    public readonly serverName?: string,
    public readonly toolInfo?: DaemonToolInfo
  ) {
    super(label, collapsibleState);
  }
}

/**
 * Tree data provider for the Loom Tools panel.
 * Shows all available tools grouped by server.
 */
export class ToolProvider implements vscode.TreeDataProvider<ToolTreeItem> {
  private readonly daemonClient: DaemonClient;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private filterQuery: string = "";

  constructor(daemonClient: DaemonClient) {
    this.daemonClient = daemonClient;
  }

  refresh() {
    this.daemonClient.invalidateCache();
    this.emitter.fire();
  }

  setFilter(query: string) {
    this.filterQuery = query.toLowerCase();
    this.emitter.fire();
  }

  clearFilter() {
    this.filterQuery = "";
    this.emitter.fire();
  }

  getTreeItem(element: ToolTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ToolTreeItem): Promise<ToolTreeItem[]> {
    if (!element) {
      // Root level: show servers with tools
      const tools = await this.daemonClient.getTools();

      if (tools.length === 0) {
        const placeholder = new ToolTreeItem(
          "No tools available (daemon not running?)",
          vscode.TreeItemCollapsibleState.None
        );
        placeholder.iconPath = new vscode.ThemeIcon("warning");
        placeholder.command = {
          command: "loom.startDaemon",
          title: "Start Daemon",
        };
        return [placeholder];
      }

      // Filter tools if query is set
      const filteredTools = this.filterQuery
        ? tools.filter(
            (t) =>
              t.name.toLowerCase().includes(this.filterQuery) ||
              t.description?.toLowerCase().includes(this.filterQuery)
          )
        : tools;

      if (filteredTools.length === 0 && this.filterQuery) {
        const noMatch = new ToolTreeItem(
          `No tools match "${this.filterQuery}"`,
          vscode.TreeItemCollapsibleState.None
        );
        noMatch.iconPath = new vscode.ThemeIcon("search-stop");
        return [noMatch];
      }

      // Group by server
      const serverMap = new Map<string, DaemonToolInfo[]>();
      for (const tool of filteredTools) {
        const serverTools = serverMap.get(tool.server) ?? [];
        serverTools.push(tool);
        serverMap.set(tool.server, serverTools);
      }

      // Create server items
      return Array.from(serverMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([serverName, serverTools]) => {
          const item = new ToolTreeItem(
            serverName,
            vscode.TreeItemCollapsibleState.Collapsed,
            true,
            serverName
          );
          item.description = `${serverTools.length} tools`;
          item.iconPath = new vscode.ThemeIcon("server-process");
          return item;
        });
    }

    // Child level: show tools for a server
    if (element.isServer && element.serverName) {
      const tools = await this.daemonClient.getTools();
      const serverTools = tools.filter((t) => t.server === element.serverName);

      // Apply filter
      const filteredTools = this.filterQuery
        ? serverTools.filter(
            (t) =>
              t.name.toLowerCase().includes(this.filterQuery) ||
              t.description?.toLowerCase().includes(this.filterQuery)
          )
        : serverTools;

      return filteredTools.map((tool) => {
        // Extract tool name without server prefix
        const shortName = tool.name.replace(`${element.serverName}__`, "");
        const item = new ToolTreeItem(
          shortName,
          vscode.TreeItemCollapsibleState.None,
          false,
          element.serverName,
          tool
        );
        item.description = tool.description ?? "";
        item.iconPath = new vscode.ThemeIcon("symbol-method");
        item.tooltip = this.buildToolTooltip(tool, shortName);
        return item;
      });
    }

    return [];
  }

  private buildToolTooltip(tool: DaemonToolInfo, shortName: string): vscode.MarkdownString {
    const lines: string[] = [
      `**${shortName}**`,
      "",
      `Server: \`${tool.server}\``,
      `Full name: \`${tool.name}\``,
    ];
    if (tool.description) {
      lines.push("", tool.description);
    }
    const tooltip = new vscode.MarkdownString(lines.join("\n"));
    tooltip.isTrusted = true;
    return tooltip;
  }
}
