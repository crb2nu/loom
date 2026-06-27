import * as vscode from "vscode";

import { AgentContextClient } from "../clients/agentContext";

/**
 * Manages gutter decorations for agent code annotations.
 */
export class AnnotationDecorationManager implements vscode.Disposable {
  private readonly client: AgentContextClient;
  private readonly decorationTypes: Map<string, vscode.TextEditorDecorationType>;
  private activeDecorations: Map<string, vscode.DecorationOptions[]>;
  private enabled: boolean = true;
  private disposables: vscode.Disposable[] = [];
  private lastErrorTime = 0;
  private static readonly ERROR_BACKOFF_MS = 60_000;

  constructor(client: AgentContextClient) {
    this.client = client;
    this.decorationTypes = new Map();
    this.activeDecorations = new Map();

    // Create decoration types for each annotation type
    this.createDecorationTypes();

    // Listen for active editor changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && this.enabled) {
          void this.updateDecorations(editor);
        }
      })
    );

    // Listen for document saves
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === doc && this.enabled) {
          void this.updateDecorations(editor);
        }
      })
    );

    // Initial update
    const editor = vscode.window.activeTextEditor;
    if (editor && this.enabled) {
      void this.updateDecorations(editor);
    }
  }

  private createDecorationTypes(): void {
    const types: Record<string, { icon: string; color: string }> = {
      note: { icon: "note", color: "#4fc3f7" },
      todo: { icon: "checklist", color: "#81c784" },
      warning: { icon: "warning", color: "#ffb74d" },
      question: { icon: "question", color: "#ba68c8" },
      decision: { icon: "milestone", color: "#64b5f6" },
    };

    for (const [type, config] of Object.entries(types)) {
      const decorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(
          `https://raw.githubusercontent.com/microsoft/vscode-codicons/main/src/icons/${config.icon}.svg`
        ),
        gutterIconSize: "contain",
        overviewRulerColor: config.color,
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        before: {
          contentText: "",
          margin: "0 4px 0 0",
        },
      });
      this.decorationTypes.set(type, decorationType);
    }
  }

  /**
   * Update decorations for the given editor.
   */
  async updateDecorations(editor: vscode.TextEditor): Promise<void> {
    if (!this.enabled) {
      this.clearDecorations(editor);
      return;
    }

    const filePath = editor.document.uri.fsPath;

    // Back off after recent errors to avoid spamming failed MCP calls
    const now = Date.now();
    if (now - this.lastErrorTime < AnnotationDecorationManager.ERROR_BACKOFF_MS) {
      return;
    }

    let annotations;
    try {
      annotations = await this.client.getAnnotations(filePath);
    } catch {
      this.lastErrorTime = Date.now();
      return;
    }

    // Group annotations by type
    const decorationsByType = new Map<string, vscode.DecorationOptions[]>();

    for (const annotation of annotations) {
      const type = annotation.annotation_type;
      if (!decorationsByType.has(type)) {
        decorationsByType.set(type, []);
      }

      const startLine = Math.max(0, annotation.line_start - 1);
      const endLine = Math.max(0, annotation.line_end - 1);

      const range = new vscode.Range(
        startLine,
        0,
        endLine,
        editor.document.lineAt(endLine).text.length
      );

      const hoverMessage = new vscode.MarkdownString();
      hoverMessage.appendMarkdown(
        `**${this.formatAnnotationType(annotation.annotation_type)}**\n\n`
      );
      hoverMessage.appendMarkdown(annotation.content);
      hoverMessage.appendMarkdown(`\n\n---\n*${new Date(annotation.created_at).toLocaleString()}*`);

      decorationsByType.get(type)!.push({
        range,
        hoverMessage,
      });
    }

    // Apply decorations
    for (const [type, decorationType] of this.decorationTypes) {
      const decorations = decorationsByType.get(type) ?? [];
      editor.setDecorations(decorationType, decorations);
    }

    this.activeDecorations.set(filePath, Array.from(decorationsByType.values()).flat());
  }

  /**
   * Clear all decorations from an editor.
   */
  clearDecorations(editor: vscode.TextEditor): void {
    for (const decorationType of this.decorationTypes.values()) {
      editor.setDecorations(decorationType, []);
    }
    this.activeDecorations.delete(editor.document.uri.fsPath);
  }

  /**
   * Toggle decorations on/off.
   */
  toggle(): boolean {
    this.enabled = !this.enabled;

    const editor = vscode.window.activeTextEditor;
    if (editor) {
      if (this.enabled) {
        void this.updateDecorations(editor);
      } else {
        this.clearDecorations(editor);
      }
    }

    return this.enabled;
  }

  /**
   * Set enabled state.
   */
  setEnabled(enabled: boolean): void {
    if (this.enabled !== enabled) {
      this.enabled = enabled;
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        if (enabled) {
          void this.updateDecorations(editor);
        } else {
          this.clearDecorations(editor);
        }
      }
    }
  }

  /**
   * Check if decorations are enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Refresh decorations for the current editor.
   */
  async refresh(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor && this.enabled) {
      await this.updateDecorations(editor);
    }
  }

  private formatAnnotationType(type: string): string {
    return type.charAt(0).toUpperCase() + type.slice(1);
  }

  dispose(): void {
    for (const decorationType of this.decorationTypes.values()) {
      decorationType.dispose();
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
