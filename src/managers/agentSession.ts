import * as vscode from "vscode";

import { AgentContextClient } from "../clients/agentContext";
import { AgentSession } from "../types";

/**
 * Manager for tracking and managing the active agent session.
 * Provides session lifecycle management and state persistence.
 */
export class AgentSessionManager implements vscode.Disposable {
  private readonly client: AgentContextClient;
  private readonly channel: vscode.OutputChannel;
  private readonly workspaceState: vscode.Memento;
  private activeSession: AgentSession | null = null;
  private readonly emitter = new vscode.EventEmitter<AgentSession | null>();
  readonly onDidChangeSession = this.emitter.event;
  private statusBarItem: vscode.StatusBarItem;

  constructor(
    client: AgentContextClient,
    channel: vscode.OutputChannel,
    workspaceState: vscode.Memento
  ) {
    this.client = client;
    this.channel = channel;
    this.workspaceState = workspaceState;

    // Create status bar item
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.statusBarItem.command = "loom.showAgentSessionMenu";
    this.updateStatusBar();

    // Try to restore session from workspace state
    void this.restoreSession();
  }

  /**
   * Restore session from workspace state if available.
   */
  private async restoreSession(): Promise<void> {
    const savedSessionId = this.workspaceState.get<string>("loom.activeSessionId");
    if (!savedSessionId) return;

    try {
      const session = await this.client.getSession(savedSessionId);
      if (session && session.status === "active") {
        this.activeSession = session;
        this.channel.appendLine(
          `[${new Date().toISOString()}] Restored active session: ${session.namespace}`
        );
        this.updateStatusBar();
        this.emitter.fire(session);
      }
    } catch {
      // Session may no longer exist, clear saved ID
      await this.workspaceState.update("loom.activeSessionId", undefined);
    }
  }

  /**
   * Start a new session or resume an existing one.
   */
  async startSession(namespace: string, description?: string): Promise<AgentSession | null> {
    // Check for existing active session
    if (this.activeSession) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: "End current session and start new", value: "replace" },
          { label: "Keep current session", value: "keep" },
        ],
        {
          title: `Active session: ${this.activeSession.namespace}`,
          placeHolder: "What would you like to do?",
        }
      );

      if (!choice || choice.value === "keep") {
        return this.activeSession;
      }

      await this.endSession(false);
    }

    const session = await this.client.startSession(namespace, description);
    if (session) {
      this.activeSession = session;
      await this.workspaceState.update("loom.activeSessionId", session.session_id);
      this.channel.appendLine(
        `[${new Date().toISOString()}] Started session: ${namespace} (${session.session_id})`
      );
      this.updateStatusBar();
      this.emitter.fire(session);
    }
    return session;
  }

  /**
   * End the current session.
   */
  async endSession(summarize: boolean = true): Promise<boolean> {
    if (!this.activeSession) {
      return false;
    }

    const success = await this.client.endSession(this.activeSession.session_id, summarize);
    if (success) {
      this.channel.appendLine(
        `[${new Date().toISOString()}] Ended session: ${this.activeSession.namespace}`
      );
      this.activeSession = null;
      await this.workspaceState.update("loom.activeSessionId", undefined);
      this.updateStatusBar();
      this.emitter.fire(null);
    }
    return success;
  }

  /**
   * Get the active session.
   */
  getActiveSession(): AgentSession | null {
    return this.activeSession;
  }

  /**
   * Check if there's an active session.
   */
  hasActiveSession(): boolean {
    return this.activeSession !== null;
  }

  /**
   * Get the session ID if active.
   */
  getSessionId(): string | undefined {
    return this.activeSession?.session_id;
  }

  /**
   * Update the status bar display.
   */
  private updateStatusBar(): void {
    if (this.activeSession) {
      this.statusBarItem.text = `$(symbol-interface) ${this.activeSession.namespace}`;
      this.statusBarItem.tooltip = new vscode.MarkdownString(
        [
          `**Agent Session Active**`,
          ``,
          `Namespace: \`${this.activeSession.namespace}\``,
          `Session ID: \`${this.activeSession.session_id.slice(0, 8)}...\``,
          `Entries: ${this.activeSession.entry_count}`,
          `Started: ${new Date(this.activeSession.started_at).toLocaleTimeString()}`,
          ``,
          `Click to manage session`,
        ].join("\n")
      );
      this.statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.statusBarItem.show();
    } else {
      this.statusBarItem.text = "$(symbol-interface) No Session";
      this.statusBarItem.tooltip = "Click to start an agent session";
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.show();
    }
  }

  /**
   * Refresh session info from server.
   */
  async refresh(): Promise<void> {
    if (!this.activeSession) return;

    const session = await this.client.getSession(this.activeSession.session_id);
    if (session) {
      this.activeSession = session;
      this.updateStatusBar();
      this.emitter.fire(session);
    } else {
      // Session no longer exists
      this.activeSession = null;
      await this.workspaceState.update("loom.activeSessionId", undefined);
      this.updateStatusBar();
      this.emitter.fire(null);
    }
  }

  dispose(): void {
    this.statusBarItem.dispose();
    this.emitter.dispose();
  }
}
