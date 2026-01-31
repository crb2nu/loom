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
      "src",
      "webviews",
      "knowledge-graph",
      "index.html"
    );

    if (!fs.existsSync(htmlPath.fsPath)) {
      return this._getInlineHtml(_webview);
    }

    const htmlContent = fs.readFileSync(htmlPath.fsPath, "utf-8");
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${_webview.cspSource} https://d3js.org https://cdn.jsdelivr.net 'unsafe-inline'; style-src ${_webview.cspSource} 'unsafe-inline';">`;
    return htmlContent.replace("<head>", `<head>\n    ${csp}`);
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
            overflow: hidden;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
        }
        #graph-container {
            width: 100vw;
            height: 100vh;
        }
        .tooltip {
            position: absolute;
            padding: 8px 12px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 4px;
            font-size: 12px;
            pointer-events: none;
            z-index: 1000;
            max-width: 300px;
        }
        .legend {
            position: absolute;
            top: 10px;
            right: 10px;
            background: var(--vscode-editorWidget-background);
            padding: 10px;
            border-radius: 4px;
            font-size: 12px;
        }
        .legend-item {
            display: flex;
            align-items: center;
            margin: 4px 0;
        }
        .legend-color {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            margin-right: 8px;
        }
    </style>
</head>
<body>
    <div id="graph-container"></div>
    <div class="legend" id="legend"></div>
    <div class="tooltip" id="tooltip" style="display: none;"></div>
    <script src="https://d3js.org/d3.v7.min.js"></script>
    <script>
        const vscode = acquireVsCodeApi();
        let simulation;

        const typeColors = {
            'file': '#4fc3f7',
            'function': '#81c784',
            'class': '#ffb74d',
            'module': '#ba68c8',
            'concept': '#e57373',
            'decision': '#64b5f6',
            'entity': '#aed581',
            'default': '#90a4ae'
        };

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'updateGraph') {
                renderGraph(message.data);
            }
        });

        function renderGraph(data) {
            const width = window.innerWidth;
            const height = window.innerHeight;

            d3.select("#graph-container").selectAll("*").remove();

            const svg = d3.select("#graph-container")
                .append("svg")
                .attr("width", width)
                .attr("height", height)
                .call(d3.zoom().on("zoom", (event) => {
                    g.attr("transform", event.transform);
                }));

            const g = svg.append("g");

            // Legend
            const types = [...new Set(data.nodes.map(n => n.type))];
            const legend = d3.select("#legend");
            legend.html("");
            types.forEach(type => {
                const item = legend.append("div").attr("class", "legend-item");
                item.append("div")
                    .attr("class", "legend-color")
                    .style("background-color", typeColors[type] || typeColors.default);
                item.append("span").text(type);
            });

            simulation = d3.forceSimulation(data.nodes)
                .force("link", d3.forceLink(data.edges).id(d => d.id).distance(100))
                .force("charge", d3.forceManyBody().strength(-200))
                .force("center", d3.forceCenter(width / 2, height / 2))
                .force("collision", d3.forceCollide().radius(30));

            const link = g.append("g")
                .selectAll("line")
                .data(data.edges)
                .enter().append("line")
                .attr("stroke", "#555")
                .attr("stroke-width", 1.5)
                .attr("stroke-opacity", 0.6);

            const linkLabels = g.append("g")
                .selectAll("text")
                .data(data.edges)
                .enter().append("text")
                .text(d => d.type)
                .attr("font-size", 10)
                .attr("fill", "#888")
                .attr("text-anchor", "middle");

            const node = g.append("g")
                .selectAll("circle")
                .data(data.nodes)
                .enter().append("circle")
                .attr("r", 12)
                .attr("fill", d => typeColors[d.type] || typeColors.default)
                .attr("stroke", "#fff")
                .attr("stroke-width", 2)
                .on("mouseover", showTooltip)
                .on("mouseout", hideTooltip)
                .on("click", (event, d) => {
                    vscode.postMessage({ type: 'nodeClicked', nodeId: d.id });
                })
                .call(d3.drag()
                    .on("start", dragstarted)
                    .on("drag", dragged)
                    .on("end", dragended));

            const labels = g.append("g")
                .selectAll("text")
                .data(data.nodes)
                .enter().append("text")
                .text(d => d.label)
                .attr("font-size", 11)
                .attr("fill", "#ccc")
                .attr("dx", 15)
                .attr("dy", 4);

            simulation.on("tick", () => {
                link
                    .attr("x1", d => d.source.x)
                    .attr("y1", d => d.source.y)
                    .attr("x2", d => d.target.x)
                    .attr("y2", d => d.target.y);

                linkLabels
                    .attr("x", d => (d.source.x + d.target.x) / 2)
                    .attr("y", d => (d.source.y + d.target.y) / 2);

                node
                    .attr("cx", d => d.x)
                    .attr("cy", d => d.y);

                labels
                    .attr("x", d => d.x)
                    .attr("y", d => d.y);
            });
        }

        function showTooltip(event, d) {
            const tooltip = d3.select("#tooltip");
            let html = '<strong>' + d.label + '</strong><br>Type: ' + d.type;
            if (d.properties) {
                Object.entries(d.properties).forEach(([key, value]) => {
                    html += '<br>' + key + ': ' + value;
                });
            }
            tooltip
                .style("display", "block")
                .style("left", (event.pageX + 10) + "px")
                .style("top", (event.pageY - 10) + "px")
                .html(html);
        }

        function hideTooltip() {
            d3.select("#tooltip").style("display", "none");
        }

        function dragstarted(event, d) {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
        }

        function dragged(event, d) {
            d.fx = event.x;
            d.fy = event.y;
        }

        function dragended(event, d) {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
        }

        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
  }
}
