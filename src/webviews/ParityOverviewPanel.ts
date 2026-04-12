import { Webview, WebviewPanel, window, Uri, ViewColumn } from "vscode";

import { ParityDomainSnapshot } from "../readModels";

import { BaseWebviewPanel } from "./BaseWebviewPanel";

interface ParityOverviewMessage {
  type: string;
}

/**
 * Webview panel for the parity-based Loom overview shell.
 */
export class ParityOverviewPanel extends BaseWebviewPanel {
  public static currentPanel: ParityOverviewPanel | undefined;
  private latestSnapshot?: ParityDomainSnapshot;

  private constructor(panel: WebviewPanel, extensionUri: Uri) {
    super(panel, extensionUri);
  }

  public static render(extensionUri: Uri): ParityOverviewPanel {
    if (ParityOverviewPanel.currentPanel) {
      ParityOverviewPanel.currentPanel.reveal(ViewColumn.One);
      return ParityOverviewPanel.currentPanel;
    }

    const panel = window.createWebviewPanel("loomParityOverview", "Loom Overview", ViewColumn.One, {
      enableScripts: true,
      localResourceRoots: [Uri.joinPath(extensionUri, "src", "webviews", "parity-overview")],
    });

    ParityOverviewPanel.currentPanel = new ParityOverviewPanel(panel, extensionUri);
    return ParityOverviewPanel.currentPanel;
  }

  public updateSnapshot(snapshot: ParityDomainSnapshot): void {
    this.latestSnapshot = snapshot;
    void this.postMessage({
      type: "updateSnapshot",
      data: snapshot,
    });
  }

  protected onDispose(): void {
    ParityOverviewPanel.currentPanel = undefined;
  }

  protected handleMessage(message: unknown): void {
    const typed = message as ParityOverviewMessage;
    if (typed.type === "ready" && this.latestSnapshot) {
      void this.postMessage({
        type: "updateSnapshot",
        data: this.latestSnapshot,
      });
    }
  }

  protected getHtmlForWebview(webview: Webview): string {
    const csp = this.generateCsp(webview);

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${csp}
  <title>Loom Overview</title>
  <style>
    ${this.getBaseStyles()}
    body {
      padding: 24px;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 20px;
    }
    .hero-copy {
      flex: 1;
    }
    .hero-title {
      margin: 0 0 6px 0;
      font-size: 28px;
      font-weight: 700;
    }
    .hero-subtitle {
      color: var(--vscode-descriptionForeground);
      max-width: 72ch;
      line-height: 1.5;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(120px, 1fr));
      gap: 12px;
      min-width: 320px;
    }
    .summary-card {
      padding: 14px;
      border-radius: 10px;
      border: 1px solid var(--vscode-editorWidget-border);
      background: var(--vscode-editorWidget-background);
    }
    .summary-value {
      font-size: 24px;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .summary-label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .attention {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0 0 20px 0;
    }
    .chip {
      border-radius: 999px;
      padding: 4px 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 12px;
      font-weight: 600;
    }
    .domains {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
    }
    .domain-card {
      padding: 16px;
      border-radius: 12px;
      border: 1px solid var(--vscode-editorWidget-border);
      background: var(--vscode-editorWidget-background);
    }
    .domain-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 12px;
    }
    .domain-title {
      font-size: 16px;
      font-weight: 700;
    }
    .state {
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .state-ready {
      background: rgba(46, 125, 50, 0.18);
      color: #4caf50;
    }
    .state-degraded {
      background: rgba(245, 124, 0, 0.18);
      color: #ffb74d;
    }
    .state-unavailable {
      background: rgba(198, 40, 40, 0.18);
      color: #ef5350;
    }
    .metric-list, .bullet-list {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .metric-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      font-size: 13px;
    }
    .metric-label {
      color: var(--vscode-descriptionForeground);
    }
    .metric-value {
      font-weight: 600;
      text-align: right;
    }
    .reason {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-editorWidget-border);
      color: var(--vscode-descriptionForeground);
      line-height: 1.45;
      font-size: 12px;
    }
    .section-label {
      margin-top: 14px;
      margin-bottom: 8px;
      font-size: 12px;
      font-weight: 700;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .empty {
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
    }
  </style>
</head>
<body>
  <section class="hero">
    <div class="hero-copy">
      <h1 class="hero-title">Loom Overview</h1>
      <div class="hero-subtitle">
        One view for fleet, health, tasks, memory, stream, and presence. Use this
        to spot routing gaps, degraded backends, and blocked work without jumping
        across multiple commands.
      </div>
    </div>
    <div class="summary-grid">
      <div class="summary-card">
        <div class="summary-value" id="summary-ready">0</div>
        <div class="summary-label">Ready</div>
      </div>
      <div class="summary-card">
        <div class="summary-value" id="summary-degraded">0</div>
        <div class="summary-label">Degraded</div>
      </div>
      <div class="summary-card">
        <div class="summary-value" id="summary-unavailable">0</div>
        <div class="summary-label">Unavailable</div>
      </div>
    </div>
  </section>

  <div class="attention" id="attention"></div>
  <section class="domains" id="domains"></section>

  <script>
    const vscode = acquireVsCodeApi();

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'updateSnapshot') {
        renderSnapshot(message.data);
      }
    });

    function renderSnapshot(snapshot) {
      document.getElementById('summary-ready').textContent = String(snapshot.summary.ready);
      document.getElementById('summary-degraded').textContent = String(snapshot.summary.degraded);
      document.getElementById('summary-unavailable').textContent = String(snapshot.summary.unavailable);

      const attention = document.getElementById('attention');
      const items = snapshot.summary.attention || [];
      attention.innerHTML = items.length
        ? items.map((item) => \`<span class="chip">\${escapeHtml(item)}</span>\`).join('')
        : '<span class="chip">No active attention items</span>';

      const domains = [
        ['Fleet', snapshot.fleet, renderFleetDetails(snapshot.fleet)],
        ['Health', snapshot.health, renderHealthDetails(snapshot.health)],
        ['Tasks', snapshot.tasks, renderTasksDetails(snapshot.tasks)],
        ['Memory', snapshot.memory, renderMemoryDetails(snapshot.memory)],
        ['Stream', snapshot.stream, renderStreamDetails(snapshot.stream)],
        ['Presence', snapshot.presence, renderPresenceDetails(snapshot.presence)],
      ];

      document.getElementById('domains').innerHTML = domains.map(([title, domain, details]) => {
        const stateClass = \`state state-\${domain.state}\`;
        const reason = domain.reason
          ? \`<div class="reason">\${escapeHtml(domain.reason)}</div>\`
          : '';
        return \`
          <article class="domain-card">
            <div class="domain-head">
              <div class="domain-title">\${escapeHtml(title)}</div>
              <span class="\${stateClass}">\${escapeHtml(domain.state)}</span>
            </div>
            \${details}
            \${reason}
          </article>
        \`;
      }).join('');
    }

    function renderFleetDetails(fleet) {
      return \`
        <ul class="metric-list">
          <li class="metric-row"><span class="metric-label">Registry</span><span class="metric-value">\${fleet.registryCount}</span></li>
          <li class="metric-row"><span class="metric-label">Hub</span><span class="metric-value">\${fleet.hubCount}</span></li>
          <li class="metric-row"><span class="metric-label">VS Code</span><span class="metric-value">\${fleet.configCount}</span></li>
        </ul>
        \${renderListSection('Registry → Hub gaps', fleet.missingFromHub)}
        \${renderListSection('Registry → VS Code gaps', fleet.missingFromConfig)}
        \${renderListSection('Hub-only', fleet.hubOnly)}
        \${renderListSection('Config-only', fleet.configOnly)}
        \${renderListSection('Local routed', fleet.localRouted)}
      \`;
    }

    function renderHealthDetails(health) {
      return \`
        <ul class="metric-list">
          <li class="metric-row"><span class="metric-label">Hub status</span><span class="metric-value">\${escapeHtml(String(health.hubStatus))}</span></li>
          <li class="metric-row"><span class="metric-label">Hub ready</span><span class="metric-value">\${health.hubReady ? 'yes' : 'no'}</span></li>
          <li class="metric-row"><span class="metric-label">Hub sessions</span><span class="metric-value">\${health.hubSessions}</span></li>
          <li class="metric-row"><span class="metric-label">Daemon</span><span class="metric-value">\${escapeHtml(String(health.daemonConnection))}</span></li>
          <li class="metric-row"><span class="metric-label">Running servers</span><span class="metric-value">\${health.daemonRunningCount}/\${health.daemonServerCount}</span></li>
        </ul>
      \`;
    }

    function renderTasksDetails(tasks) {
      const statuses = Object.entries(tasks.byStatus || {});
      return \`
        <ul class="metric-list">
          <li class="metric-row"><span class="metric-label">Total tasks</span><span class="metric-value">\${tasks.total}</span></li>
          <li class="metric-row"><span class="metric-label">Blocked</span><span class="metric-value">\${tasks.blocked}</span></li>
          <li class="metric-row"><span class="metric-label">Session</span><span class="metric-value">\${escapeHtml(tasks.sessionId || 'none')}</span></li>
        </ul>
        \${statuses.length ? renderKeyValueSection('By status', statuses) : '<div class="empty">No task status data</div>'}
      \`;
    }

    function renderMemoryDetails(memory) {
      const tiers = (memory.tiers || []).map((tier) => [tier.tier, \`\${tier.entryCount} entries / \${tier.tokenCount} tokens\`]);
      return \`
        <ul class="metric-list">
          <li class="metric-row"><span class="metric-label">Entries</span><span class="metric-value">\${memory.totalEntries}</span></li>
          <li class="metric-row"><span class="metric-label">Tokens</span><span class="metric-value">\${memory.totalTokens}</span></li>
          <li class="metric-row"><span class="metric-label">Session</span><span class="metric-value">\${escapeHtml(memory.sessionId || 'none')}</span></li>
        </ul>
        \${tiers.length ? renderKeyValueSection('Tiers', tiers) : '<div class="empty">No memory tier data</div>'}
      \`;
    }

    function renderStreamDetails(stream) {
      return \`
        <ul class="metric-list">
          <li class="metric-row"><span class="metric-label">Total calls</span><span class="metric-value">\${stream.totalCalls}</span></li>
          <li class="metric-row"><span class="metric-label">Successes</span><span class="metric-value">\${stream.successCalls}</span></li>
          <li class="metric-row"><span class="metric-label">Failures</span><span class="metric-value">\${stream.failureCalls}</span></li>
          <li class="metric-row"><span class="metric-label">Top server</span><span class="metric-value">\${escapeHtml(stream.topServer || 'none')}</span></li>
        </ul>
      \`;
    }

    function renderPresenceDetails(presence) {
      return \`
        <ul class="metric-list">
          <li class="metric-row"><span class="metric-label">Active sessions</span><span class="metric-value">\${presence.activeSessions}</span></li>
          <li class="metric-row"><span class="metric-label">Active session ID</span><span class="metric-value">\${escapeHtml(presence.activeSessionId || 'none')}</span></li>
        </ul>
      \`;
    }

    function renderListSection(title, values) {
      const list = values || [];
      return \`
        <div class="section-label">\${escapeHtml(title)}</div>
        \${list.length
          ? \`<ul class="bullet-list">\${list.map((value) => \`<li>\${escapeHtml(String(value))}</li>\`).join('')}</ul>\`
          : '<div class="empty">None</div>'}
      \`;
    }

    function renderKeyValueSection(title, entries) {
      return \`
        <div class="section-label">\${escapeHtml(title)}</div>
        <ul class="metric-list">
          \${entries.map(([label, value]) => \`<li class="metric-row"><span class="metric-label">\${escapeHtml(String(label))}</span><span class="metric-value">\${escapeHtml(String(value))}</span></li>\`).join('')}
        </ul>
      \`;
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
