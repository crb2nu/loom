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
    const csp = this.generateCsp(webview, ["https://cdn.jsdelivr.net"]);

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${csp}
    <title>Memory Dashboard</title>
    <style>
        ${this.getBaseStyles()}
        .dashboard {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 20px;
            max-width: 1200px;
        }
        .tier-card {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 8px;
            padding: 16px;
        }
        .tier-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
        }
        .tier-title {
            font-size: 18px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .tier-icon {
            width: 24px;
            height: 24px;
            border-radius: 50%;
        }
        .tier-working .tier-icon { background: #4fc3f7; }
        .tier-short_term .tier-icon { background: #81c784; }
        .tier-long_term .tier-icon { background: #ba68c8; }
        .tier-stats {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 8px;
            margin-bottom: 16px;
        }
        .stat-item {
            background: var(--vscode-editor-background);
            padding: 8px 12px;
            border-radius: 4px;
        }
        .stat-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
        }
        .stat-value {
            font-size: 20px;
            font-weight: 600;
        }
        .tier-bar {
            height: 8px;
            background: var(--vscode-progressBar-background);
            border-radius: 4px;
            overflow: hidden;
            margin-bottom: 16px;
        }
        .tier-bar-fill {
            height: 100%;
            transition: width 0.3s ease;
        }
        .tier-working .tier-bar-fill { background: #4fc3f7; }
        .tier-short_term .tier-bar-fill { background: #81c784; }
        .tier-long_term .tier-bar-fill { background: #ba68c8; }
        .entry-list {
            max-height: 200px;
            overflow-y: auto;
        }
        .entry-item {
            padding: 8px;
            margin-bottom: 4px;
            background: var(--vscode-editor-background);
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
        }
        .entry-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .entry-title {
            font-weight: 500;
            margin-bottom: 2px;
        }
        .entry-meta {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }
        .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <h1>Memory Dashboard</h1>
    <div class="dashboard" id="dashboard">
        <div class="empty-state">Loading memory tiers...</div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();

        const tierConfig = {
            working: { name: 'Working Memory', maxEntries: 20 },
            short_term: { name: 'Short-Term Memory', maxEntries: 100 },
            long_term: { name: 'Long-Term Memory', maxEntries: 1000 }
        };

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'updateTiers') {
                renderTiers(message.data.tiers);
            }
        });

        function renderTiers(tiers) {
            const dashboard = document.getElementById('dashboard');

            if (!tiers || tiers.length === 0) {
                dashboard.innerHTML = '<div class="empty-state">No memory data available</div>';
                return;
            }

            dashboard.innerHTML = tiers.map(tier => renderTierCard(tier)).join('');
        }

        function renderTierCard(tier) {
            const config = tierConfig[tier.tier] || { name: tier.tier, maxEntries: 100 };
            const fillPercent = Math.min((tier.entry_count / config.maxEntries) * 100, 100);

            return \`
                <div class="tier-card tier-\${tier.tier}">
                    <div class="tier-header">
                        <div class="tier-title">
                            <div class="tier-icon"></div>
                            \${config.name}
                        </div>
                    </div>
                    <div class="tier-stats">
                        <div class="stat-item">
                            <div class="stat-label">Entries</div>
                            <div class="stat-value">\${tier.entry_count}</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-label">Tokens</div>
                            <div class="stat-value">\${formatNumber(tier.total_tokens)}</div>
                        </div>
                    </div>
                    <div class="tier-bar">
                        <div class="tier-bar-fill" style="width: \${fillPercent}%"></div>
                    </div>
                    <div class="entry-list">
                        \${tier.entries.slice(0, 5).map(e => renderEntry(e)).join('')}
                        \${tier.entry_count > 5 ? \`<div class="entry-meta" style="text-align:center;padding:8px;">+ \${tier.entry_count - 5} more entries</div>\` : ''}
                    </div>
                </div>
            \`;
        }

        function renderEntry(entry) {
            return \`
                <div class="entry-item" onclick="selectEntry('\${entry.entry_id}')">
                    <div class="entry-title">\${escapeHtml(entry.title)}</div>
                    <div class="entry-meta">\${entry.entry_type} \u2022 \${formatDate(entry.created_at)}</div>
                </div>
            \`;
        }

        function selectEntry(entryId) {
            vscode.postMessage({ type: 'selectEntry', entryId });
        }

        function formatNumber(n) {
            if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
            if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
            return n.toString();
        }

        function formatDate(dateStr) {
            const date = new Date(dateStr);
            return date.toLocaleDateString();
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
  }
}
