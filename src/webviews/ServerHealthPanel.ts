import { Disposable, Webview, WebviewPanel, window, Uri, ViewColumn } from "vscode";

import { ServerHealthMetrics, ServerHealthHistory, RoutingStatus } from "../types";

export interface ServerHealthData {
  metrics: ServerHealthMetrics[];
  history: Map<string, ServerHealthHistory>;
  routing: RoutingStatus;
}

/**
 * Webview panel for server health dashboard.
 */
export class ServerHealthPanel {
  public static currentPanel: ServerHealthPanel | undefined;
  private readonly _panel: WebviewPanel;
  private readonly _extensionUri: Uri;
  private _disposables: Disposable[] = [];

  private constructor(panel: WebviewPanel, extensionUri: Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      (message: { type: string; serverName?: string }) => {
        switch (message.type) {
          case "ready":
            return;
          case "pingServer":
            // Handle ping request
            return;
          case "refreshMetrics":
            // Handle refresh request
            return;
        }
      },
      null,
      this._disposables
    );
  }

  public static render(extensionUri: Uri): ServerHealthPanel {
    if (ServerHealthPanel.currentPanel) {
      ServerHealthPanel.currentPanel._panel.reveal(ViewColumn.One);
      return ServerHealthPanel.currentPanel;
    }

    const panel = window.createWebviewPanel("loomServerHealth", "Server Health", ViewColumn.One, {
      enableScripts: true,
      localResourceRoots: [Uri.joinPath(extensionUri, "src", "webviews", "server-health")],
    });

    ServerHealthPanel.currentPanel = new ServerHealthPanel(panel, extensionUri);
    return ServerHealthPanel.currentPanel;
  }

  public updateData(data: ServerHealthData): void {
    const historyData: Record<
      string,
      Array<{ timestamp: string; latencyMs: number; status: string }>
    > = {};
    data.history.forEach((history, name) => {
      historyData[name] = history.samples.map((s) => ({
        timestamp: s.timestamp.toISOString(),
        latencyMs: s.latencyMs,
        status: s.status,
      }));
    });

    this._panel.webview.postMessage({
      type: "updateData",
      data: {
        metrics: data.metrics,
        history: historyData,
        routing: data.routing,
      },
    });
  }

  public dispose(): void {
    ServerHealthPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  private _getHtmlForWebview(_webview: Webview): string {
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${_webview.cspSource} https://cdn.jsdelivr.net 'unsafe-inline'; style-src ${_webview.cspSource} 'unsafe-inline';">`;

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${csp}
    <title>Server Health</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { box-sizing: border-box; }
        body {
            margin: 0;
            padding: 20px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
        }
        h1 { margin: 0 0 8px 0; font-size: 24px; font-weight: 600; }
        .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 20px; }
        .dashboard { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; margin-bottom: 24px; }
        .server-card {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 8px;
            padding: 16px;
        }
        .server-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        .server-name { font-weight: 600; font-size: 14px; }
        .status-badge {
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 11px;
            font-weight: 500;
        }
        .status-online { background: #2e7d32; color: white; }
        .status-offline { background: #c62828; color: white; }
        .status-degraded { background: #f57c00; color: white; }
        .server-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 12px; }
        .stat { text-align: center; }
        .stat-value { font-size: 18px; font-weight: 600; }
        .stat-label { font-size: 11px; color: var(--vscode-descriptionForeground); }
        .routing-badge {
            font-size: 11px;
            padding: 2px 6px;
            border-radius: 4px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .routing-hub { background: #1565c0; color: white; }
        .routing-local { background: #6a1b9a; color: white; }
        .chart-container { height: 100px; }
        .section-title { font-size: 16px; font-weight: 600; margin: 24px 0 16px 0; }
        .routing-summary {
            display: flex;
            gap: 24px;
            padding: 16px;
            background: var(--vscode-editorWidget-background);
            border-radius: 8px;
            margin-bottom: 24px;
        }
        .routing-group { flex: 1; }
        .routing-group h3 { margin: 0 0 8px 0; font-size: 14px; display: flex; align-items: center; gap: 8px; }
        .routing-list { font-size: 12px; color: var(--vscode-descriptionForeground); }
        .gauge-container { display: flex; gap: 24px; padding: 16px 0; }
        .gauge { flex: 1; text-align: center; }
        .gauge-bar { height: 8px; background: var(--vscode-progressBar-background); border-radius: 4px; overflow: hidden; margin: 8px 0; }
        .gauge-fill { height: 100%; background: var(--vscode-progressBar-background); }
        .gauge-fill-ok { background: #2e7d32; }
        .gauge-fill-warn { background: #f57c00; }
        .gauge-fill-error { background: #c62828; }
        .empty-state { text-align: center; padding: 40px; color: var(--vscode-descriptionForeground); }
    </style>
</head>
<body>
    <h1>Server Health Dashboard</h1>
    <div class="subtitle" id="lastUpdate">Waiting for data...</div>

    <div class="routing-summary" id="routingSummary">
        <div class="routing-group">
            <h3><span class="routing-badge routing-hub">HUB</span> Hub Routed</h3>
            <div class="routing-list" id="hubRoutedList">-</div>
        </div>
        <div class="routing-group">
            <h3><span class="routing-badge routing-local">LOCAL</span> Local</h3>
            <div class="routing-list" id="localRoutedList">-</div>
        </div>
    </div>

    <div class="gauge-container" id="gauges">
        <div class="gauge">
            <div class="stat-value" id="onlineCount">0</div>
            <div class="gauge-bar"><div class="gauge-fill gauge-fill-ok" id="onlineBar" style="width: 0%"></div></div>
            <div class="stat-label">Online</div>
        </div>
        <div class="gauge">
            <div class="stat-value" id="avgLatency">0ms</div>
            <div class="gauge-bar"><div class="gauge-fill gauge-fill-ok" id="latencyBar" style="width: 0%"></div></div>
            <div class="stat-label">Avg Latency</div>
        </div>
        <div class="gauge">
            <div class="stat-value" id="errorCount">0</div>
            <div class="gauge-bar"><div class="gauge-fill gauge-fill-error" id="errorBar" style="width: 0%"></div></div>
            <div class="stat-label">Errors</div>
        </div>
    </div>

    <h2 class="section-title">Servers</h2>
    <div class="dashboard" id="serverGrid">
        <div class="empty-state">Loading server data...</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const charts = new Map();

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'updateData') {
                renderData(message.data);
            }
        });

        function renderData(data) {
            // Update last update time
            document.getElementById('lastUpdate').textContent =
                'Last updated: ' + new Date().toLocaleTimeString();

            // Update routing summary
            if (data.routing) {
                document.getElementById('hubRoutedList').textContent =
                    data.routing.hubRouted.join(', ') || 'None';
                document.getElementById('localRoutedList').textContent =
                    data.routing.localRouted.join(', ') || 'None';
            }

            // Update gauges
            const metrics = data.metrics || [];
            const onlineCount = metrics.filter(m => m.status === 'online').length;
            const totalCount = metrics.length || 1;
            const avgLatency = metrics.length > 0
                ? Math.round(metrics.reduce((a, m) => a + m.latencyMs, 0) / metrics.length)
                : 0;
            const errorCount = metrics.reduce((a, m) => a + m.errorCount, 0);

            document.getElementById('onlineCount').textContent = onlineCount + '/' + totalCount;
            document.getElementById('onlineBar').style.width = (onlineCount / totalCount * 100) + '%';
            document.getElementById('avgLatency').textContent = avgLatency + 'ms';
            document.getElementById('latencyBar').style.width = Math.min(avgLatency / 500 * 100, 100) + '%';
            document.getElementById('latencyBar').className = 'gauge-fill ' +
                (avgLatency < 100 ? 'gauge-fill-ok' : avgLatency < 300 ? 'gauge-fill-warn' : 'gauge-fill-error');
            document.getElementById('errorCount').textContent = errorCount;
            document.getElementById('errorBar').style.width = Math.min(errorCount / 10 * 100, 100) + '%';

            // Render server cards
            const grid = document.getElementById('serverGrid');
            if (metrics.length === 0) {
                grid.innerHTML = '<div class="empty-state">No servers found</div>';
                return;
            }

            grid.innerHTML = metrics.map(m => renderServerCard(m, data.history[m.serverName])).join('');

            // Initialize charts
            metrics.forEach(m => {
                const history = data.history[m.serverName] || [];
                if (history.length > 0) {
                    initChart(m.serverName, history);
                }
            });
        }

        function renderServerCard(metrics, history) {
            return \`
                <div class="server-card">
                    <div class="server-header">
                        <span class="server-name">\${metrics.serverName}</span>
                        <span class="status-badge status-\${metrics.status}">\${metrics.status.toUpperCase()}</span>
                    </div>
                    <div class="server-stats">
                        <div class="stat">
                            <div class="stat-value">\${metrics.latencyMs}ms</div>
                            <div class="stat-label">Latency</div>
                        </div>
                        <div class="stat">
                            <div class="stat-value">\${metrics.errorCount}</div>
                            <div class="stat-label">Errors</div>
                        </div>
                        <div class="stat">
                            <span class="routing-badge \${metrics.isHubRouted ? 'routing-hub' : 'routing-local'}">
                                \${metrics.isHubRouted ? 'HUB' : 'LOCAL'}
                            </span>
                        </div>
                    </div>
                    <div class="chart-container">
                        <canvas id="chart-\${metrics.serverName}"></canvas>
                    </div>
                </div>
            \`;
        }

        function initChart(serverName, history) {
            const ctx = document.getElementById('chart-' + serverName);
            if (!ctx) return;

            // Destroy existing chart
            if (charts.has(serverName)) {
                charts.get(serverName).destroy();
            }

            const labels = history.map(h => new Date(h.timestamp).toLocaleTimeString());
            const data = history.map(h => h.latencyMs);

            const chart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels,
                    datasets: [{
                        label: 'Latency (ms)',
                        data,
                        borderColor: '#4fc3f7',
                        backgroundColor: 'rgba(79, 195, 247, 0.1)',
                        fill: true,
                        tension: 0.3,
                        pointRadius: 0,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { display: false },
                        y: {
                            display: true,
                            grid: { color: 'rgba(255,255,255,0.1)' },
                            ticks: { color: '#888', font: { size: 10 } }
                        }
                    }
                }
            });

            charts.set(serverName, chart);
        }

        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
  }
}
