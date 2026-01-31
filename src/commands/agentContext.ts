import * as vscode from "vscode";

import { AgentContextClient } from "../clients/agentContext";
import { AgentSessionManager } from "../managers/agentSession";
import { AgentContextProvider } from "../providers/agentContext";
import { TasksProvider } from "../providers/tasks";
import { AgentContextEntry } from "../types";

export interface AgentContextCommandContext {
  workspaceRoot: string;
  loomChannel: vscode.OutputChannel;
  agentContextClient: AgentContextClient;
  agentSessionManager: AgentSessionManager;
  agentContextProvider: AgentContextProvider;
  tasksProvider: TasksProvider;
  extensionContext: vscode.ExtensionContext;
}

/**
 * Register agent context commands.
 */
export function registerAgentContextCommands(ctx: AgentContextCommandContext): vscode.Disposable[] {
  return [
    // Session management
    vscode.commands.registerCommand("loom.startAgentSession", async () => {
      const namespace = await vscode.window.showInputBox({
        prompt: "Enter session namespace (e.g., project/feature-x)",
        placeHolder: "project/feature",
        validateInput: (value) => {
          if (!value) return "Namespace is required";
          if (!/^[\w\-/]+$/.test(value)) {
            return "Namespace must contain only letters, numbers, hyphens, and slashes";
          }
          return undefined;
        },
      });

      if (!namespace) return;

      const description = await vscode.window.showInputBox({
        prompt: "Enter session description (optional)",
        placeHolder: "Brief description of what you're working on",
      });

      const session = await ctx.agentSessionManager.startSession(namespace, description);
      if (session) {
        vscode.window
          .showInformationMessage(`Started session: ${namespace}`, "View Context")
          .then((choice) => {
            if (choice === "View Context") {
              vscode.commands.executeCommand("loomAgentContext.focus");
            }
          });
      } else {
        vscode.window.showErrorMessage("Failed to start session");
      }
    }),

    vscode.commands.registerCommand("loom.endAgentSession", async () => {
      if (!ctx.agentSessionManager.hasActiveSession()) {
        vscode.window.showInformationMessage("No active session to end");
        return;
      }

      const summarize = await vscode.window.showQuickPick(
        [
          { label: "Yes, summarize session", value: true },
          { label: "No, just end it", value: false },
        ],
        {
          title: "End Agent Session",
          placeHolder: "Generate summary for future recall?",
        }
      );

      if (summarize === undefined) return;

      const success = await ctx.agentSessionManager.endSession(summarize.value);
      if (success) {
        vscode.window.showInformationMessage("Session ended");
      } else {
        vscode.window.showErrorMessage("Failed to end session");
      }
    }),

    vscode.commands.registerCommand("loom.showAgentSessionMenu", async () => {
      const session = ctx.agentSessionManager.getActiveSession();

      const items: vscode.QuickPickItem[] = session
        ? [
            { label: "$(stop) End Session", description: session.namespace },
            { label: "$(refresh) Refresh Session", description: "Update session info" },
            {
              label: "$(add) Add Context Entry",
              description: "Record a decision, finding, or note",
            },
            { label: "$(checklist) Add Task", description: "Add a task to track" },
            {
              label: "$(graph) Show Knowledge Graph",
              description: "Visualize entities and relations",
            },
          ]
        : [
            { label: "$(play) Start Session", description: "Start a new agent session" },
            { label: "$(history) View Recent Sessions", description: "Browse past sessions" },
          ];

      const choice = await vscode.window.showQuickPick(items, {
        title: session ? `Session: ${session.namespace}` : "Agent Session",
      });

      if (!choice) return;

      const action = choice.label.replace(/^\$\([^)]+\)\s*/, "");
      switch (action) {
        case "End Session":
          await vscode.commands.executeCommand("loom.endAgentSession");
          break;
        case "Refresh Session":
          await ctx.agentSessionManager.refresh();
          await ctx.agentContextProvider.refresh();
          break;
        case "Add Context Entry":
          await vscode.commands.executeCommand("loom.addContextEntry");
          break;
        case "Add Task":
          await vscode.commands.executeCommand("loom.addTask");
          break;
        case "Show Knowledge Graph":
          await vscode.commands.executeCommand("loom.showKnowledgeGraph");
          break;
        case "Start Session":
          await vscode.commands.executeCommand("loom.startAgentSession");
          break;
        case "View Recent Sessions":
          await ctx.agentContextProvider.refresh();
          await vscode.commands.executeCommand("loomAgentContext.focus");
          break;
      }
    }),

    // Context entries
    vscode.commands.registerCommand("loom.addContextEntry", async () => {
      const sessionId = ctx.agentSessionManager.getSessionId();
      if (!sessionId) {
        const start = await vscode.window.showInformationMessage(
          "No active session. Start one first?",
          "Start Session"
        );
        if (start === "Start Session") {
          await vscode.commands.executeCommand("loom.startAgentSession");
        }
        return;
      }

      const entryType = await vscode.window.showQuickPick(
        [
          {
            label: "Decision",
            value: "decision",
            description: "Architecture or implementation choice",
          },
          { label: "Finding", value: "finding", description: "Discovery during exploration" },
          { label: "Note", value: "note", description: "General observation" },
          { label: "Question", value: "question", description: "Open question to revisit" },
          { label: "Error", value: "error", description: "Error and resolution" },
        ],
        {
          title: "Entry Type",
          placeHolder: "What type of entry?",
        }
      );

      if (!entryType) return;

      const title = await vscode.window.showInputBox({
        prompt: "Entry title",
        placeHolder: "Brief title for this entry",
      });

      if (!title) return;

      const content = await vscode.window.showInputBox({
        prompt: "Entry content",
        placeHolder: "Detailed content or description",
      });

      if (!content) return;

      const tagsInput = await vscode.window.showInputBox({
        prompt: "Tags (optional, comma-separated)",
        placeHolder: "auth, security, api",
      });

      const tags = tagsInput
        ? tagsInput
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;

      const entries = await ctx.agentContextClient.addContextEntries(sessionId, [
        {
          entry_type: entryType.value as AgentContextEntry["entry_type"],
          title,
          content,
          tags,
        },
      ]);

      if (entries.length > 0) {
        vscode.window.showInformationMessage(`Added ${entryType.label}: ${title}`);
        await ctx.agentContextProvider.refresh();
      } else {
        vscode.window.showErrorMessage("Failed to add entry");
      }
    }),

    vscode.commands.registerCommand("loom.showContextEntry", async (entry: AgentContextEntry) => {
      const content = formatContextEntry(entry);
      const doc = await vscode.workspace.openTextDocument({
        content,
        language: "markdown",
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand("loom.recallContext", async () => {
      const query = await vscode.window.showInputBox({
        prompt: "What are you looking for?",
        placeHolder: "Search past context entries...",
      });

      if (!query) return;

      // Get current file context if available
      const activeEditor = vscode.window.activeTextEditor;
      const fileContext = activeEditor?.document.uri.fsPath;

      const result = await ctx.agentContextClient.recallEnhanced(query, fileContext);

      // Format results
      const items: (vscode.QuickPickItem & { entry?: AgentContextEntry })[] = [];

      for (const decision of result.decisions) {
        items.push({
          label: `$(milestone) ${decision.title}`,
          description: "Decision",
          detail: decision.content.slice(0, 100),
          entry: decision,
        });
      }

      for (const entry of result.entries) {
        if (!result.decisions.find((d) => d.entry_id === entry.entry_id)) {
          items.push({
            label: `$(${getEntryIcon(entry.entry_type)}) ${entry.title}`,
            description: entry.entry_type,
            detail: entry.content.slice(0, 100),
            entry,
          });
        }
      }

      if (items.length === 0) {
        vscode.window.showInformationMessage("No matching context found");
        return;
      }

      const selected = await vscode.window.showQuickPick(items, {
        title: `Recall: "${query}"`,
        placeHolder: "Select an entry to view details",
      });

      if (selected?.entry) {
        await vscode.commands.executeCommand("loom.showContextEntry", selected.entry);
      }
    }),

    // Task management
    vscode.commands.registerCommand("loom.addTask", async () => {
      const sessionId = ctx.agentSessionManager.getSessionId();
      if (!sessionId) {
        const start = await vscode.window.showInformationMessage(
          "No active session. Start one first?",
          "Start Session"
        );
        if (start === "Start Session") {
          await vscode.commands.executeCommand("loom.startAgentSession");
        }
        return;
      }

      const title = await vscode.window.showInputBox({
        prompt: "Task title",
        placeHolder: "What needs to be done?",
      });

      if (!title) return;

      const priority = await vscode.window.showQuickPick(
        [
          { label: "Critical", value: "critical" as const },
          { label: "High", value: "high" as const },
          { label: "Medium", value: "medium" as const },
          { label: "Low", value: "low" as const },
        ],
        {
          title: "Priority",
          placeHolder: "Select priority",
        }
      );

      if (!priority) return;

      // Optionally add current file as context
      const activeEditor = vscode.window.activeTextEditor;
      let filePath: string | undefined;
      if (activeEditor) {
        const addFile = await vscode.window.showQuickPick(
          [
            { label: "Yes", value: true },
            { label: "No", value: false },
          ],
          {
            title: "Link to current file?",
            placeHolder: activeEditor.document.uri.fsPath,
          }
        );
        if (addFile?.value) {
          filePath = activeEditor.document.uri.fsPath;
        }
      }

      const tasks = await ctx.agentContextClient.addTasks(sessionId, [
        {
          title,
          priority: priority.value,
          file_path: filePath,
        },
      ]);

      if (tasks.length > 0) {
        vscode.window.showInformationMessage(`Added task: ${title}`);
        await ctx.tasksProvider.refresh();
      } else {
        vscode.window.showErrorMessage("Failed to add task");
      }
    }),

    vscode.commands.registerCommand("loom.refreshTasks", async () => {
      await ctx.tasksProvider.refresh();
    }),

    vscode.commands.registerCommand("loom.refreshAgentContext", async () => {
      await ctx.agentContextProvider.refresh();
    }),
  ];
}

/**
 * Get icon name for entry type.
 */
function getEntryIcon(type: string): string {
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

/**
 * Format context entry as Markdown.
 */
function formatContextEntry(entry: AgentContextEntry): string {
  const lines: string[] = [
    `# ${entry.title}`,
    "",
    `**Type:** ${entry.entry_type}`,
    `**Created:** ${new Date(entry.created_at).toLocaleString()}`,
  ];

  if (entry.tags && entry.tags.length > 0) {
    lines.push(`**Tags:** ${entry.tags.join(", ")}`);
  }

  if (entry.file_path) {
    lines.push(`**File:** \`${entry.file_path}\``);
    if (entry.line_start) {
      lines.push(`**Lines:** ${entry.line_start}-${entry.line_end ?? entry.line_start}`);
    }
  }

  lines.push("", "---", "", entry.content);

  return lines.join("\n");
}
