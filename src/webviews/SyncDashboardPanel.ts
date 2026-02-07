import * as vscode from "vscode";

import { PlatformConfigClient } from "../clients/platformConfig";
import { SyncDashboardState, PlatformConfig, PlatformType } from "../types";
import { PLATFORMS } from "../utils/platform";

/**
 * Webview panel for the sync dashboard showing status across all platforms.
 */
export class SyncDashboardPanel {
  public static currentPanel: SyncDashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly platformConfigClient: PlatformConfigClient;
  private refreshInterval?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];

  public static render(
    extensionUri: vscode.Uri,
    platformConfigClient: PlatformConfigClient
  ): SyncDashboardPanel {
    if (SyncDashboardPanel.currentPanel) {
      SyncDashboardPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      void SyncDashboardPanel.currentPanel.refresh();
      return SyncDashboardPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "loomSyncDashboard",
      "Loom Sync Dashboard",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    SyncDashboardPanel.currentPanel = new SyncDashboardPanel(
      panel,
      extensionUri,
      platformConfigClient
    );

    return SyncDashboardPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    platformConfigClient: PlatformConfigClient
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.platformConfigClient = platformConfigClient;

    // Set initial content
    this.panel.webview.html = this.getLoadingHtml();

    // Load data and update
    void this.refresh();

    // Set up auto-refresh
    this.refreshInterval = setInterval(() => {
      void this.refresh();
    }, 30000); // Refresh every 30 seconds

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      async (message: { command: string; platform?: PlatformType }) => {
        switch (message.command) {
          case "refresh":
            await this.refresh();
            break;
          case "syncPlatform":
            if (message.platform) {
              await this.syncPlatform(message.platform);
            }
            break;
          case "syncAll":
            await this.syncAll();
            break;
          case "diffPlatform":
            if (message.platform) {
              await vscode.commands.executeCommand("loom.diffPlatformConfig", message.platform);
            }
            break;
          case "openConfig":
            if (message.platform) {
              await vscode.commands.executeCommand(
                "loom.openPlatformConfig",
                message.platform,
                "repo"
              );
            }
            break;
        }
      },
      undefined,
      this.disposables
    );

    // Listen for config changes
    this.disposables.push(
      platformConfigClient.onDidChange(() => {
        void this.refresh();
      })
    );

    // Handle panel disposal
    this.panel.onDidDispose(
      () => {
        SyncDashboardPanel.currentPanel = undefined;
        if (this.refreshInterval) {
          clearInterval(this.refreshInterval);
        }
        for (const disposable of this.disposables) {
          disposable.dispose();
        }
      },
      null,
      this.disposables
    );
  }

  private async refresh(): Promise<void> {
    const state = await this.platformConfigClient.getDashboardState();
    this.panel.webview.html = this.getHtml(state);
  }

  private async syncPlatform(platform: PlatformType): Promise<void> {
    await vscode.commands.executeCommand("loom.syncPlatformConfig", platform);
    await this.refresh();
  }

  private async syncAll(): Promise<void> {
    await vscode.commands.executeCommand("loom.syncAllPlatforms");
    await this.refresh();
  }

  public updateState(state: SyncDashboardState): void {
    this.panel.webview.html = this.getHtml(state);
  }

  public dispose(): void {
    // Dispose triggers onDidDispose handler which cleans up interval and disposables
    this.panel.dispose();
  }

  private getLoadingHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Loom Sync Dashboard</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 20px;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
    }
    .loading {
      text-align: center;
    }
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid var(--vscode-editorWidget-border);
      border-top-color: var(--vscode-progressBar-background);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 10px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="loading">
    <div class="spinner"></div>
    <p>Loading sync status...</p>
  </div>
</body>
</html>`;
  }

  private getHtml(state: SyncDashboardState): string {
    const platformCards = state.platforms.map((config) => this.getPlatformCard(config)).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Loom Sync Dashboard</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 20px;
      margin: 0;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 15px;
      border-bottom: 1px solid var(--vscode-widget-border);
    }
    .header h1 {
      margin: 0;
      font-size: 1.5em;
    }
    .header-actions {
      display: flex;
      gap: 10px;
    }
    .btn {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      cursor: pointer;
      border-radius: 3px;
      font-size: 12px;
    }
    .btn:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
    .btn-secondary {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }
    .registry-info {
      background-color: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textBlockQuote-border);
      padding: 10px 15px;
      margin-bottom: 20px;
      font-size: 12px;
    }
    .registry-info strong {
      color: var(--vscode-textLink-foreground);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 15px;
    }
    .card {
      background-color: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 5px;
      padding: 15px;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .card-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
    }
    .status-badge {
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 500;
    }
    .status-synced {
      background-color: var(--vscode-testing-iconPassed);
      color: #fff;
    }
    .status-out-of-sync {
      background-color: var(--vscode-editorWarning-foreground);
      color: #fff;
    }
    .status-missing {
      background-color: var(--vscode-disabledForeground);
      color: #fff;
    }
    .status-error {
      background-color: var(--vscode-testing-iconFailed);
      color: #fff;
    }
    .status-unknown {
      background-color: var(--vscode-descriptionForeground);
      color: #fff;
    }
    .card-details {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 12px;
    }
    .card-details div {
      margin: 4px 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .card-details code {
      background-color: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 11px;
    }
    .card-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .card-actions .btn {
      font-size: 11px;
      padding: 4px 8px;
    }
    .icon {
      width: 16px;
      height: 16px;
    }
    .last-updated {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 20px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Loom Sync Dashboard</h1>
    <div class="header-actions">
      <button class="btn" onclick="syncAll()">Sync All</button>
      <button class="btn btn-secondary" onclick="refresh()">Refresh</button>
    </div>
  </div>

  ${
    state.registryPath
      ? `
  <div class="registry-info">
    <strong>Registry:</strong> ${state.registryPath}
    <span style="margin-left: 15px;"><strong>Servers:</strong> ${state.registryServerCount}</span>
  </div>
  `
      : ""
  }

  <div class="grid">
    ${platformCards}
  </div>

  <div class="last-updated">
    Last updated: ${state.lastUpdated.toLocaleTimeString()}
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function refresh() {
      vscode.postMessage({ command: 'refresh' });
    }

    function syncAll() {
      vscode.postMessage({ command: 'syncAll' });
    }

    function syncPlatform(platform) {
      vscode.postMessage({ command: 'syncPlatform', platform });
    }

    function diffPlatform(platform) {
      vscode.postMessage({ command: 'diffPlatform', platform });
    }

    function openConfig(platform) {
      vscode.postMessage({ command: 'openConfig', platform });
    }
  </script>
</body>
</html>`;
  }

  private getPlatformCard(config: PlatformConfig): string {
    const info = PLATFORMS[config.platform];
    const statusClass = `status-${config.syncStatus.replace("_", "-")}`;
    const statusText = this.formatStatus(config.syncStatus);

    return `
    <div class="card">
      <div class="card-header">
        <div class="card-title">
          <span>${info.displayName}</span>
        </div>
        <span class="status-badge ${statusClass}">${statusText}</span>
      </div>
      <div class="card-details">
        <div>
          <span>Servers:</span>
          <strong>${config.serverCount}</strong>
        </div>
        <div>
          <span>Repo:</span>
          <code>${config.repoHash ?? "missing"}</code>
        </div>
        <div>
          <span>Home:</span>
          <code>${config.homeHash ?? "missing"}</code>
        </div>
        ${config.error ? `<div style="color: var(--vscode-errorForeground);">Error: ${config.error}</div>` : ""}
      </div>
      <div class="card-actions">
        <button class="btn" onclick="syncPlatform('${config.platform}')">Sync</button>
        <button class="btn btn-secondary" onclick="diffPlatform('${config.platform}')">Diff</button>
        <button class="btn btn-secondary" onclick="openConfig('${config.platform}')">Open</button>
      </div>
    </div>
    `;
  }

  private formatStatus(status: string): string {
    switch (status) {
      case "synced":
        return "Synced";
      case "out-of-sync":
        return "Out of Sync";
      case "missing":
        return "Missing";
      case "error":
        return "Error";
      default:
        return "Unknown";
    }
  }
}
