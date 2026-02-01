import * as vscode from "vscode";

import { PlatformConfigClient } from "../clients/platformConfig";
import { PlatformType } from "../types";
import { PLATFORMS } from "../utils/platform";

export interface OnboardingState {
  step: number;
  hubUrl: string;
  hubEnabled: boolean;
  selectedPlatforms: PlatformType[];
  completed: boolean;
}

/**
 * Webview panel for the onboarding wizard.
 */
export class OnboardingPanel {
  public static currentPanel: OnboardingPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly platformConfigClient: PlatformConfigClient;
  private disposables: vscode.Disposable[] = [];
  private state: OnboardingState = {
    step: 1,
    hubUrl: "",
    hubEnabled: false,
    selectedPlatforms: ["vscode"],
    completed: false,
  };

  public static render(
    extensionUri: vscode.Uri,
    platformConfigClient: PlatformConfigClient
  ): OnboardingPanel {
    if (OnboardingPanel.currentPanel) {
      OnboardingPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      return OnboardingPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "loomOnboarding",
      "Welcome to Loom",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    OnboardingPanel.currentPanel = new OnboardingPanel(
      panel,
      extensionUri,
      platformConfigClient
    );

    return OnboardingPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    platformConfigClient: PlatformConfigClient
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.platformConfigClient = platformConfigClient;

    // Load saved hub URL from settings
    const config = vscode.workspace.getConfiguration("loom");
    this.state.hubUrl = config.get<string>("hubUrl") ?? "";
    this.state.hubEnabled = config.get<boolean>("hubEnabled") ?? false;

    // Set initial content
    this.updateContent();

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      async (message: {
        command: string;
        step?: number;
        hubUrl?: string;
        hubEnabled?: boolean;
        platforms?: PlatformType[];
      }) => {
        switch (message.command) {
          case "next":
            this.state.step = Math.min(4, this.state.step + 1);
            this.updateContent();
            break;
          case "back":
            this.state.step = Math.max(1, this.state.step - 1);
            this.updateContent();
            break;
          case "updateHubSettings":
            if (message.hubUrl !== undefined) {
              this.state.hubUrl = message.hubUrl;
            }
            if (message.hubEnabled !== undefined) {
              this.state.hubEnabled = message.hubEnabled;
            }
            break;
          case "updatePlatforms":
            if (message.platforms) {
              this.state.selectedPlatforms = message.platforms;
            }
            break;
          case "finish":
            await this.finishOnboarding();
            break;
          case "skip":
            this.panel.dispose();
            break;
        }
      },
      undefined,
      this.disposables
    );

    // Handle panel disposal
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async finishOnboarding(): Promise<void> {
    // Save settings
    const config = vscode.workspace.getConfiguration("loom");
    await config.update("hubUrl", this.state.hubUrl, vscode.ConfigurationTarget.Global);
    await config.update("hubEnabled", this.state.hubEnabled, vscode.ConfigurationTarget.Global);
    await config.update(
      "onboardingComplete",
      true,
      vscode.ConfigurationTarget.Global
    );

    // Sync selected platforms
    for (const platform of this.state.selectedPlatforms) {
      try {
        await this.platformConfigClient.syncPlatform(platform);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showWarningMessage(`Failed to sync ${platform}: ${message}`);
      }
    }

    this.state.completed = true;
    vscode.window.showInformationMessage("Loom setup complete! Happy coding!");
    this.panel.dispose();
  }

  private updateContent(): void {
    this.panel.webview.html = this.getHtml();
  }

  private getHtml(): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Welcome to Loom</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 20px 40px;
      max-width: 800px;
      margin: 0 auto;
    }
    h1 {
      color: var(--vscode-foreground);
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 10px;
    }
    h2 {
      color: var(--vscode-foreground);
      margin-top: 30px;
    }
    .step-indicator {
      display: flex;
      justify-content: center;
      gap: 10px;
      margin: 20px 0 40px;
    }
    .step-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--vscode-button-secondaryBackground);
    }
    .step-dot.active {
      background: var(--vscode-button-background);
    }
    .step-dot.completed {
      background: var(--vscode-charts-green);
    }
    .step-content {
      min-height: 300px;
    }
    .form-group {
      margin: 20px 0;
    }
    label {
      display: block;
      margin-bottom: 8px;
      font-weight: bold;
    }
    input[type="text"], input[type="url"] {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-size: 14px;
    }
    input[type="checkbox"] {
      margin-right: 8px;
    }
    .checkbox-label {
      display: flex;
      align-items: center;
      cursor: pointer;
    }
    .platform-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 15px;
      margin: 20px 0;
    }
    .platform-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 15px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .platform-card:hover {
      border-color: var(--vscode-button-background);
    }
    .platform-card.selected {
      border-color: var(--vscode-button-background);
      background: var(--vscode-list-hoverBackground);
    }
    .platform-name {
      font-weight: bold;
      margin-bottom: 5px;
    }
    .platform-desc {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .button-row {
      display: flex;
      justify-content: space-between;
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    button {
      padding: 10px 20px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-link {
      background: transparent;
      color: var(--vscode-textLink-foreground);
      text-decoration: underline;
    }
    .checklist {
      list-style: none;
      padding: 0;
    }
    .checklist li {
      padding: 10px 0;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .checklist li::before {
      content: "\\2713";
      color: var(--vscode-charts-green);
      font-weight: bold;
    }
    .tip {
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textLink-foreground);
      padding: 10px 15px;
      margin: 20px 0;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <h1>Welcome to Loom</h1>

  <div class="step-indicator">
    ${[1, 2, 3, 4]
      .map(
        (s) =>
          `<div class="step-dot ${s === this.state.step ? "active" : ""} ${s < this.state.step ? "completed" : ""}"></div>`
      )
      .join("")}
  </div>

  <div class="step-content">
    ${this.getStepContent()}
  </div>

  <div class="button-row">
    ${this.getButtons()}
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    function next() {
      vscode.postMessage({ command: 'next' });
    }

    function back() {
      vscode.postMessage({ command: 'back' });
    }

    function skip() {
      vscode.postMessage({ command: 'skip' });
    }

    function finish() {
      vscode.postMessage({ command: 'finish' });
    }

    function updateHubSettings() {
      const hubUrl = document.getElementById('hubUrl')?.value ?? '';
      const hubEnabled = document.getElementById('hubEnabled')?.checked ?? false;
      vscode.postMessage({ command: 'updateHubSettings', hubUrl, hubEnabled });
    }

    function togglePlatform(platform) {
      const card = document.querySelector('[data-platform="' + platform + '"]');
      card?.classList.toggle('selected');

      const selected = Array.from(document.querySelectorAll('.platform-card.selected'))
        .map(el => el.getAttribute('data-platform'));
      vscode.postMessage({ command: 'updatePlatforms', platforms: selected });
    }
  </script>
</body>
</html>`;
  }

  private getStepContent(): string {
    switch (this.state.step) {
      case 1:
        return `
          <h2>About Loom</h2>
          <p>Loom is your MCP (Model Context Protocol) management hub for VS Code and other AI coding assistants.</p>

          <ul class="checklist">
            <li>Manage MCP servers from a central registry</li>
            <li>Sync configurations across multiple platforms</li>
            <li>Monitor server health and performance</li>
            <li>Access persistent agent context and memory</li>
          </ul>

          <div class="tip">
            <strong>Tip:</strong> Loom works best with a workspace that has a <code>.vscode-mcp/</code> directory for generated configs.
          </div>
        `;

      case 2:
        return `
          <h2>Hub Configuration (Optional)</h2>
          <p>Connect to a remote MCP Hub for centralized server management.</p>

          <div class="form-group">
            <label for="hubUrl">Hub URL</label>
            <input type="url" id="hubUrl" placeholder="https://mcp-hub.example.com" value="${this.state.hubUrl}" onchange="updateHubSettings()">
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" id="hubEnabled" ${this.state.hubEnabled ? "checked" : ""} onchange="updateHubSettings()">
              Enable hub connection
            </label>
          </div>

          <div class="tip">
            <strong>Note:</strong> Hub is optional. Without it, Loom uses local MCP servers only.
          </div>
        `;

      case 3:
        return `
          <h2>Select Platforms</h2>
          <p>Choose which AI coding assistant platforms to sync with:</p>

          <div class="platform-grid">
            ${Object.entries(PLATFORMS)
              .map(
                ([key, platform]) => `
              <div class="platform-card ${this.state.selectedPlatforms.includes(key as PlatformType) ? "selected" : ""}"
                   data-platform="${key}"
                   onclick="togglePlatform('${key}')">
                <div class="platform-name">${platform.displayName}</div>
                <div class="platform-desc">${platform.description}</div>
              </div>
            `
              )
              .join("")}
          </div>

          <div class="tip">
            <strong>Tip:</strong> You can always add more platforms later from the Loom Platforms view.
          </div>
        `;

      case 4:
        return `
          <h2>Ready to Go!</h2>
          <p>Your Loom setup is complete. Here's what happens next:</p>

          <ul class="checklist">
            <li>MCP configurations will be synced to selected platforms</li>
            <li>Server status will be monitored in the sidebar</li>
            <li>Use the Command Palette (Cmd+Shift+P) and search "Loom" for all commands</li>
          </ul>

          <h3>Quick Start Commands</h3>
          <ul class="checklist">
            <li><code>Loom: Show Sync Dashboard</code> - View sync status</li>
            <li><code>Loom: Refresh Servers</code> - Refresh server list</li>
            <li><code>Loom: Deep Search</code> - Search across all sources</li>
          </ul>
        `;

      default:
        return "";
    }
  }

  private getButtons(): string {
    const isFirst = this.state.step === 1;
    const isLast = this.state.step === 4;

    return `
      <div>
        ${isFirst ? '<button class="btn-link" onclick="skip()">Skip Setup</button>' : '<button class="btn-secondary" onclick="back()">Back</button>'}
      </div>
      <div>
        ${isLast ? '<button class="btn-primary" onclick="finish()">Finish Setup</button>' : '<button class="btn-primary" onclick="next()">Next</button>'}
      </div>
    `;
  }

  public dispose(): void {
    OnboardingPanel.currentPanel = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
