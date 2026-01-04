import { Disposable, Webview, WebviewPanel, window, Uri, ViewColumn } from "vscode";
import * as fs from "fs";
import { RegistryDocument, HubStatusSnapshot } from "../../types";

export class ContextGraphPanel {
  public static currentPanel: ContextGraphPanel | undefined;
  private readonly _panel: WebviewPanel;
  private readonly _extensionUri: Uri;
  private _disposables: Disposable[] = [];

  private constructor(panel: WebviewPanel, extensionUri: Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    // Set the webview's initial html content
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

    // Listen for when the panel is disposed
    // This happens when the user closes the panel or when the panel is closed programmatically
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.type) {
          case "ready":
            // Can send initial data here if needed
            return;
        }
      },
      null,
      this._disposables
    );
  }

  public static render(extensionUri: Uri) {
    if (ContextGraphPanel.currentPanel) {
      ContextGraphPanel.currentPanel._panel.reveal(ViewColumn.One);
    } else {
      const panel = window.createWebviewPanel(
        "loomContextGraph",
        "Loom Context Graph",
        ViewColumn.One,
        {
          enableScripts: true,
          localResourceRoots: [Uri.joinPath(extensionUri, "src", "webviews", "context-graph")],
        }
      );

      ContextGraphPanel.currentPanel = new ContextGraphPanel(panel, extensionUri);
    }
  }

  public updateGraph(registry: RegistryDocument | null, hubStatus: HubStatusSnapshot) {
    const nodes: { id: string; label: string; type: string; status?: string }[] = [];
    const edges: { source: string; target: string }[] = [];

    // Hub Node (Center)
    const hubNodeId = "MCP Hub";
    nodes.push({
      id: hubNodeId,
      label: `MCP Hub (${hubStatus.health?.status ?? "unknown"})`,
      type: "hub",
      status: hubStatus.error ? "error" : hubStatus.health?.status === "ok" ? "ok" : "pending",
    });

    // Transform registry servers into nodes and edges
    if (registry?.servers) {
      registry.servers.forEach((server) => {
        nodes.push({
          id: server.name,
          label: server.name,
          type: "server",
          status: "ok", // Assume server from registry is "defined"
        });
        edges.push({ source: hubNodeId, target: server.name });
      });
    }

    // Send data to webview
    this._panel.webview.postMessage({
      type: "updateGraph",
      data: {
        nodes,
        edges,
      },
    });
  }

  public dispose() {
    ContextGraphPanel.currentPanel = undefined;

    // Clean up our resources
    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _getHtmlForWebview(_webview: Webview) {
    // Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
    const htmlPath = Uri.joinPath(
      this._extensionUri,
      "src",
      "webviews",
      "context-graph",
      "index.html"
    );
    const htmlContent = fs.readFileSync(htmlPath.fsPath, "utf-8");

    // Add CSP
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${_webview.cspSource} https://d3js.org https://cdn.jsdelivr.net 'unsafe-inline'; style-src ${_webview.cspSource} 'unsafe-inline';">`;

    // Inject CSP into head
    return htmlContent.replace("<head>", `<head>\n    ${csp}`);
  }
}
