import * as fs from "fs";

import { Webview, WebviewPanel, window, Uri, ViewColumn } from "vscode";

import { MemoryTier } from "../types";

import { BaseWebviewPanel } from "./BaseWebviewPanel";

interface MemoryDashboardMessage {
  type: string;
  entryId?: string;
}

/**
 * Webview panel for visualizing agent memory tiers.
 */
export class MemoryDashboardPanel extends BaseWebviewPanel {
  public static currentPanel: MemoryDashboardPanel | undefined;

  private constructor(panel: WebviewPanel, extensionUri: Uri) {
    super(panel, extensionUri);
  }

  public static render(extensionUri: Uri): MemoryDashboardPanel {
    if (MemoryDashboardPanel.currentPanel) {
      MemoryDashboardPanel.currentPanel.reveal(ViewColumn.One);
      return MemoryDashboardPanel.currentPanel;
    }

    const panel = window.createWebviewPanel(
      "loomMemoryDashboard",
      "Memory Dashboard",
      ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [Uri.joinPath(extensionUri, "src", "webviews", "memory-dashboard")],
      }
    );

    MemoryDashboardPanel.currentPanel = new MemoryDashboardPanel(panel, extensionUri);
    return MemoryDashboardPanel.currentPanel;
  }

  public updateTiers(tiers: MemoryTier[]): void {
    this.postMessage({
      type: "updateTiers",
      data: { tiers },
    });
  }

  protected onDispose(): void {
    MemoryDashboardPanel.currentPanel = undefined;
  }

  protected handleMessage(message: unknown): void {
    const msg = message as MemoryDashboardMessage;
    switch (msg.type) {
      case "ready":
        return;
      case "promoteEntry":
        // Handle entry promotion request
        return;
    }
  }

  protected getHtmlForWebview(webview: Webview): string {
    const htmlPath = Uri.joinPath(
      this.extensionUri,
      "assets",
      "webviews",
      "memory-dashboard",
      "index.html"
    );
    const csp = this.generateCsp(webview, ["https://cdn.jsdelivr.net"]);
    if (!fs.existsSync(htmlPath.fsPath)) {
      return this.getFallbackHtml(csp);
    }

    const htmlContent = fs.readFileSync(htmlPath.fsPath, "utf-8");
    return htmlContent.replace("{{CSP}}", csp).replace("{{BASE_STYLES}}", this.getBaseStyles());
  }

  private getFallbackHtml(csp: string): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${csp}
  <title>Memory Dashboard</title>
  <style>
    ${this.getBaseStyles()}
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <h1>Memory Dashboard</h1>
  <div class="empty-state">Memory dashboard assets are unavailable in this build.</div>
</body>
</html>`;
  }
}
