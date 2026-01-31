import * as vscode from "vscode";

import { AgentContextClient } from "../clients/agentContext";
import { AgentSessionManager } from "../managers/agentSession";
import { AgentTask } from "../types";

/**
 * Tree item types for tasks hierarchy.
 */
type TaskTreeItemType = "group" | "task";

/**
 * Custom TreeItem for tasks.
 */
export class TaskTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: TaskTreeItemType,
    public readonly task?: AgentTask,
    public readonly groupKey?: string
  ) {
    super(label, collapsibleState);
  }
}

/**
 * Grouping mode for tasks.
 */
export type TaskGroupMode = "priority" | "status" | "none";

/**
 * Tree data provider for Agent Tasks view.
 * Shows tasks with grouping by priority or status.
 */
export class TasksProvider implements vscode.TreeDataProvider<TaskTreeItem> {
  private readonly client: AgentContextClient;
  private readonly sessionManager: AgentSessionManager;
  private readonly emitter = new vscode.EventEmitter<TaskTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private tasks: AgentTask[] = [];
  private groupMode: TaskGroupMode = "priority";

  constructor(client: AgentContextClient, sessionManager: AgentSessionManager) {
    this.client = client;
    this.sessionManager = sessionManager;

    // Refresh when session changes
    sessionManager.onDidChangeSession(() => {
      void this.refresh();
    });
  }

  async refresh(): Promise<void> {
    const sessionId = this.sessionManager.getSessionId();
    this.tasks = await this.client.listTasks(sessionId);
    this.emitter.fire();
  }

  setGroupMode(mode: TaskGroupMode): void {
    this.groupMode = mode;
    this.emitter.fire();
  }

  getTreeItem(element: TaskTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TaskTreeItem): Promise<TaskTreeItem[]> {
    if (!element) {
      if (this.tasks.length === 0) {
        await this.refresh();
      }
      return this.getRootItems();
    }

    if (element.itemType === "group") {
      return this.getTasksInGroup(element.groupKey!);
    }

    return [];
  }

  private getRootItems(): TaskTreeItem[] {
    if (this.tasks.length === 0) {
      const placeholder = new TaskTreeItem(
        "No tasks",
        vscode.TreeItemCollapsibleState.None,
        "group"
      );
      placeholder.iconPath = new vscode.ThemeIcon("checklist");
      placeholder.description = "Add tasks to track work";
      placeholder.command = {
        command: "loom.addTask",
        title: "Add Task",
      };
      return [placeholder];
    }

    if (this.groupMode === "none") {
      return this.tasks.map((task) => this.createTaskItem(task));
    }

    // Group tasks
    const groups = new Map<string, AgentTask[]>();
    for (const task of this.tasks) {
      const key = this.groupMode === "priority" ? task.priority : task.status;
      const existing = groups.get(key) ?? [];
      existing.push(task);
      groups.set(key, existing);
    }

    // Sort groups
    const sortedKeys =
      this.groupMode === "priority"
        ? ["critical", "high", "medium", "low"]
        : ["in_progress", "pending", "blocked", "completed"];

    return sortedKeys
      .filter((key) => groups.has(key))
      .map((key) => {
        const tasks = groups.get(key)!;
        const item = new TaskTreeItem(
          this.formatGroupLabel(key),
          vscode.TreeItemCollapsibleState.Expanded,
          "group",
          undefined,
          key
        );
        item.description = `${tasks.length}`;
        item.iconPath = new vscode.ThemeIcon(this.getGroupIcon(key));
        return item;
      });
  }

  private getTasksInGroup(groupKey: string): TaskTreeItem[] {
    const keyField = this.groupMode === "priority" ? "priority" : "status";
    const tasks = this.tasks.filter((t) => t[keyField as keyof AgentTask] === groupKey);
    return tasks.map((task) => this.createTaskItem(task));
  }

  private createTaskItem(task: AgentTask): TaskTreeItem {
    const item = new TaskTreeItem(task.title, vscode.TreeItemCollapsibleState.None, "task", task);

    item.iconPath = new vscode.ThemeIcon(this.getTaskIcon(task));
    item.description = task.file_path ? `${task.file_path.split("/").pop()}` : undefined;
    item.tooltip = this.buildTaskTooltip(task);
    item.contextValue = `task-${task.status}`;

    // Open file on click if available
    if (task.file_path) {
      item.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [vscode.Uri.file(task.file_path)],
      };
    }

    return item;
  }

  private formatGroupLabel(key: string): string {
    return key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ");
  }

  private getGroupIcon(key: string): string {
    const iconMap: Record<string, string> = {
      // Priority icons
      critical: "flame",
      high: "arrow-up",
      medium: "dash",
      low: "arrow-down",
      // Status icons
      pending: "circle-outline",
      in_progress: "sync~spin",
      blocked: "error",
      completed: "check",
    };
    return iconMap[key] ?? "circle";
  }

  private getTaskIcon(task: AgentTask): string {
    const statusIcons: Record<string, string> = {
      pending: "circle-outline",
      in_progress: "loading~spin",
      blocked: "error",
      completed: "pass",
    };
    return statusIcons[task.status] ?? "circle";
  }

  private buildTaskTooltip(task: AgentTask): vscode.MarkdownString {
    const lines: string[] = [
      `**${task.title}**`,
      "",
      `Priority: ${task.priority}`,
      `Status: ${task.status}`,
      `Created: ${new Date(task.created_at).toLocaleString()}`,
      `Updated: ${new Date(task.updated_at).toLocaleString()}`,
    ];

    if (task.description) {
      lines.push("", task.description);
    }

    if (task.file_path) {
      lines.push("", `File: \`${task.file_path}\``);
    }

    if (task.context) {
      lines.push("", `Context: ${task.context}`);
    }

    if (task.resolution) {
      lines.push("", `Resolution: ${task.resolution}`);
    }

    const tooltip = new vscode.MarkdownString(lines.join("\n"));
    tooltip.isTrusted = true;
    return tooltip;
  }
}
