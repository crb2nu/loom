import * as fs from "fs";

import { Disposable, Webview, WebviewPanel, window, Uri, ViewColumn } from "vscode";

import { KnowledgeGraphEntity, KnowledgeGraphRelation } from "../types";

export interface KnowledgeGraphData {
  entities: KnowledgeGraphEntity[];
  relations: KnowledgeGraphRelation[];
}

/**
 * Webview panel for visualizing the agent knowledge graph.
 */
export class KnowledgeGraphPanel {
  public static currentPanel: KnowledgeGraphPanel | undefined;
  private readonly _panel: WebviewPanel;
  private readonly _extensionUri: Uri;
  private _disposables: Disposable[] = [];

  private constructor(panel: WebviewPanel, extensionUri: Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      (message: { type: string; nodeId?: string }) => {
        switch (message.type) {
          case "ready":
            return;
          case "nodeClicked":
            // Handle node click - could show details
            return;
        }
      },
      null,
      this._disposables
    );
  }

  public static render(extensionUri: Uri): KnowledgeGraphPanel {
    if (KnowledgeGraphPanel.currentPanel) {
      KnowledgeGraphPanel.currentPanel._panel.reveal(ViewColumn.One);
      return KnowledgeGraphPanel.currentPanel;
    }

    const panel = window.createWebviewPanel(
      "loomKnowledgeGraph",
      "Knowledge Graph",
      ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [Uri.joinPath(extensionUri, "src", "webviews", "knowledge-graph")],
      }
    );

    KnowledgeGraphPanel.currentPanel = new KnowledgeGraphPanel(panel, extensionUri);
    return KnowledgeGraphPanel.currentPanel;
  }

  public updateGraph(data: KnowledgeGraphData): void {
    const nodes = data.entities.map((e) => ({
      id: e.entity_id,
      label: e.name,
      type: e.entity_type,
      properties: e.properties,
    }));

    const edges = data.relations.map((r) => ({
      source: r.source_id,
      target: r.target_id,
      type: r.relation_type,
      properties: r.properties,
    }));

    this._panel.webview.postMessage({
      type: "updateGraph",
      data: { nodes, edges },
    });
  }

  public dispose(): void {
    KnowledgeGraphPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  private _getHtmlForWebview(_webview: Webview): string {
    const htmlPath = Uri.joinPath(
      this._extensionUri,
      "assets",
      "webviews",
      "knowledge-graph",
      "index.html"
    );

    if (!fs.existsSync(htmlPath.fsPath)) {
      return this._getInlineHtml(_webview);
    }

    const htmlContent = fs.readFileSync(htmlPath.fsPath, "utf-8");
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${_webview.cspSource} https://d3js.org https://cdn.jsdelivr.net 'unsafe-inline'; style-src ${_webview.cspSource} 'unsafe-inline';">`;
    return htmlContent.replace("{{CSP}}", csp);
  }

  private _getInlineHtml(_webview: Webview): string {
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${_webview.cspSource} https://d3js.org https://cdn.jsdelivr.net 'unsafe-inline'; style-src ${_webview.cspSource} 'unsafe-inline';">`;

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${csp}
  <title>Knowledge Graph</title>
  <style>
    body {
      margin: 0;
      padding: 24px;
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
    }
    .empty-state {
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="empty-state">Knowledge graph assets are unavailable in this build.</div>
</body>
</html>`;
  }
}
