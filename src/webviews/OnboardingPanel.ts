import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as vscode from "vscode";

import { DaemonClient } from "../clients/daemon";
import { PlatformConfigClient } from "../clients/platformConfig";
import { PlatformType } from "../types";
import { PLATFORMS } from "../utils/platform";

export type ProfileType = "full" | "dev" | "infra" | "k8s-ops" | "research";

export interface DetectedPlatform {
  type: PlatformType;
  detected: boolean;
  enabled: boolean;
}

export interface VerificationResult {
  check: string;
  status: "pass" | "fail" | "pending";
  message: string;
}

export interface OnboardingState {
  step: number;
  hubUrl: string;
  hubEnabled: boolean;
  selectedPlatforms: PlatformType[];
  detectedPlatforms: DetectedPlatform[];
  profile: ProfileType;
  verificationResults: VerificationResult[];
  completed: boolean;
}

/**
 * Webview panel for the onboarding wizard.
 * 5 steps: Welcome → Hub Config → Platforms → Profile → Verify
 */
export class OnboardingPanel {
  public static currentPanel: OnboardingPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly platformConfigClient: PlatformConfigClient;
  private readonly daemonClient: DaemonClient;
  private readonly workspaceRoot: string;
  private disposables: vscode.Disposable[] = [];
  private state: OnboardingState = {
    step: 1,
    hubUrl: "",
    hubEnabled: false,
    selectedPlatforms: ["vscode"],
    detectedPlatforms: [],
    profile: "full",
    verificationResults: [],
    completed: false,
  };

  public static render(
    extensionUri: vscode.Uri,
    platformConfigClient: PlatformConfigClient,
    daemonClient: DaemonClient,
    workspaceRoot: string
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
      platformConfigClient,
      daemonClient,
      workspaceRoot
    );

    return OnboardingPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    platformConfigClient: PlatformConfigClient,
    daemonClient: DaemonClient,
    workspaceRoot: string
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.platformConfigClient = platformConfigClient;
    this.daemonClient = daemonClient;
    this.workspaceRoot = workspaceRoot;

    // TODO: Use ConfigManager when OnboardingPanel is refactored to receive injected dependencies
    const config = vscode.workspace.getConfiguration("loom");
    this.state.hubUrl = config.get<string>("hubUrl") ?? "";
    this.state.hubEnabled = this.state.hubUrl.trim().length > 0;
    this.state.profile = (config.get<string>("activeProfile") as ProfileType | undefined) ?? "full";

    // Auto-detect installed platforms
    this.state.detectedPlatforms = this.detectInstalledPlatforms();
    this.state.selectedPlatforms = this.state.detectedPlatforms
      .filter((p) => p.detected)
      .map((p) => p.type);
    if (this.state.selectedPlatforms.length === 0) {
      this.state.selectedPlatforms = ["vscode"];
    }

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
        profile?: ProfileType;
      }) => {
        switch (message.command) {
          case "next":
            this.state.step = Math.min(5, this.state.step + 1);
            // Run verification when entering step 5
            if (this.state.step === 5) {
              await this.runVerification();
            }
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
          case "updateProfile":
            if (message.profile) {
              this.state.profile = message.profile;
            }
            break;
          case "runVerification":
            await this.runVerification();
            this.updateContent();
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

  /**
   * Detect which platforms are installed by checking for their config directories.
   */
  private detectInstalledPlatforms(): DetectedPlatform[] {
    const homeDir = os.homedir();
    const platforms: DetectedPlatform[] = [];

    for (const [key, info] of Object.entries(PLATFORMS)) {
      const platformType = key as PlatformType;
      const configDir = path.join(homeDir, path.dirname(info.homeConfigPath));
      const detected = fs.existsSync(configDir);

      platforms.push({
        type: platformType,
        detected,
        enabled: detected || platformType === "vscode", // VS Code always enabled
      });
    }

    return platforms;
  }

  /**
   * Run verification checks for the current configuration.
   */
  private async runVerification(): Promise<void> {
    const results: VerificationResult[] = [];

    // Check 1: Daemon status
    try {
      const isRunning = await this.daemonClient.isDaemonRunning();
      results.push({
        check: "Daemon Status",
        status: isRunning ? "pass" : "fail",
        message: isRunning ? "Daemon is running" : "Daemon not responding",
      });
    } catch {
      results.push({
        check: "Daemon Status",
        status: "fail",
        message: "Cannot connect to daemon - ensure loom-core is running",
      });
    }

    // Check 2: MCP servers available
    try {
      const tools = await this.daemonClient.getTools();
      const toolCount = tools.length;
      results.push({
        check: "MCP Tools",
        status: toolCount > 0 ? "pass" : "fail",
        message: toolCount > 0 ? `${toolCount} tools available` : "No tools loaded",
      });
    } catch {
      results.push({
        check: "MCP Tools",
        status: "fail",
        message: "Failed to query tools",
      });
    }

    // Check 3: Platform configs
    for (const platform of this.state.selectedPlatforms) {
      try {
        const config = await this.platformConfigClient.checkPlatformSyncStatus(platform);
        const inSync = config.syncStatus === "synced";
        results.push({
          check: `${PLATFORMS[platform].displayName} Config`,
          status: inSync ? "pass" : "fail",
          message: inSync ? "Configuration synced" : `Config ${config.syncStatus}`,
        });
      } catch {
        results.push({
          check: `${PLATFORMS[platform].displayName} Config`,
          status: "fail",
          message: "Failed to check sync status",
        });
      }
    }

    // Check 4: Registry file
    const registryPath = path.join(os.homedir(), ".config/loom/registry.yaml");
    const registryExists = fs.existsSync(registryPath);
    results.push({
      check: "Registry File",
      status: registryExists ? "pass" : "fail",
      message: registryExists
        ? "Registry found at ~/.config/loom/registry.yaml"
        : "Registry not found - run loom sync first",
    });

    this.state.verificationResults = results;
  }

  private async finishOnboarding(): Promise<void> {
    // TODO: Use ConfigManager when OnboardingPanel is refactored to receive injected dependencies
    const config = vscode.workspace.getConfiguration("loom");
    await config.update(
      "hubUrl",
      this.state.hubEnabled ? this.state.hubUrl : "",
      vscode.ConfigurationTarget.Global
    );
    await config.update("activeProfile", this.state.profile, vscode.ConfigurationTarget.Global);
    await config.update(
      "enabledPlatforms",
      this.state.selectedPlatforms,
      vscode.ConfigurationTarget.Global
    );
    await config.update("onboardingComplete", true, vscode.ConfigurationTarget.Global);

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
    const passCount = this.state.verificationResults.filter((r) => r.status === "pass").length;
    const totalCount = this.state.verificationResults.length;
    vscode.window.showInformationMessage(
      `Loom setup complete! (${passCount}/${totalCount} checks passed)`
    );
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
    .tip.warning {
      border-left-color: var(--vscode-editorWarning-foreground);
    }
    .badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      margin-left: 8px;
    }
    .badge.recommended {
      background: var(--vscode-charts-green);
      color: white;
    }
    .platform-card.detected {
      border-color: var(--vscode-charts-green);
    }
    .profile-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 15px;
      margin: 20px 0;
    }
    .profile-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 15px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .profile-card:hover {
      border-color: var(--vscode-button-background);
    }
    .profile-card.selected {
      border-color: var(--vscode-button-background);
      background: var(--vscode-list-hoverBackground);
    }
    .profile-card input[type="radio"] {
      display: none;
    }
    .profile-header {
      display: flex;
      align-items: center;
      margin-bottom: 8px;
    }
    .profile-name {
      font-weight: bold;
      font-size: 16px;
    }
    .profile-desc {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin: 5px 0;
    }
    .profile-features {
      list-style: none;
      padding: 0;
      margin: 10px 0 0;
      font-size: 12px;
    }
    .profile-features li {
      padding: 3px 0;
      color: var(--vscode-descriptionForeground);
    }
    .profile-features li::before {
      content: "•";
      margin-right: 6px;
      color: var(--vscode-charts-blue);
    }
    .verification-results {
      margin: 20px 0;
    }
    .verification-results .result {
      display: flex;
      align-items: center;
      padding: 10px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .verification-results .result:last-child {
      border-bottom: none;
    }
    .verification-results .icon {
      width: 24px;
      font-size: 16px;
      font-weight: bold;
    }
    .verification-results .check {
      flex: 1;
      font-weight: 500;
    }
    .verification-results .message {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .result.pass .icon {
      color: var(--vscode-charts-green);
    }
    .result.fail .icon {
      color: var(--vscode-charts-red);
    }
    .result.pending .icon {
      color: var(--vscode-charts-yellow);
    }
    .pending {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
  </style>
</head>
<body>
  <h1>Welcome to Loom</h1>

  <div class="step-indicator">
    ${[1, 2, 3, 4, 5]
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

    function updateHubSettings() {
      const hubUrl = document.getElementById('hubUrl')?.value ?? '';
      const hubEnabled = document.getElementById('hubEnabled')?.checked ?? false;
      vscode.postMessage({ command: 'updateHubSettings', hubUrl, hubEnabled });
    }

    function togglePlatform(platform) {
      const card = document.querySelector('[data-platform="' + platform + '"]');
      card?.classList.toggle('selected');

      const selected = Array.from(document.querySelectorAll('.platform-card.selected'))
        .map(el => el.getAttribute('data-platform'))
        .filter(platform => typeof platform === 'string');
      vscode.postMessage({ command: 'updatePlatforms', platforms: selected });
    }

    function selectProfile(profile) {
      document.querySelectorAll('.profile-card').forEach(el => el.classList.remove('selected'));
      const card = document.querySelector('.profile-card input[value="' + profile + '"]')?.closest('.profile-card');
      card?.classList.add('selected');
      vscode.postMessage({ command: 'updateProfile', profile: profile });
    }

    function rerunVerification() {
      vscode.postMessage({ command: 'runVerification' });
    }

    document.addEventListener('click', (event) => {
      const target = event.target?.closest?.('[data-action]');
      if (!target) {
        return;
      }

      const action = target.getAttribute('data-action');
      switch (action) {
        case 'next':
          vscode.postMessage({ command: 'next' });
          break;
        case 'back':
          vscode.postMessage({ command: 'back' });
          break;
        case 'skip':
          vscode.postMessage({ command: 'skip' });
          break;
        case 'finish':
          vscode.postMessage({ command: 'finish' });
          break;
        case 'toggle-platform': {
          const platform = target.getAttribute('data-platform');
          if (platform) {
            togglePlatform(platform);
          }
          break;
        }
        case 'select-profile': {
          const profile = target.getAttribute('data-profile');
          if (profile) {
            selectProfile(profile);
          }
          break;
        }
        case 'rerun-verification':
          rerunVerification();
          break;
      }
    });

    const hubUrlInput = document.getElementById('hubUrl');
    if (hubUrlInput) {
      hubUrlInput.addEventListener('change', updateHubSettings);
    }

    const hubEnabledInput = document.getElementById('hubEnabled');
    if (hubEnabledInput) {
      hubEnabledInput.addEventListener('change', updateHubSettings);
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
            <input type="url" id="hubUrl" placeholder="https://mcp-hub.example.com" value="${this.state.hubUrl}">
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" id="hubEnabled" ${this.state.hubEnabled ? "checked" : ""}>
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
          <p>Choose which AI coding assistant platforms to configure. Detected platforms are pre-selected:</p>

          <div class="platform-grid">
            ${this.state.detectedPlatforms
              .map(
                (dp) => `
              <div class="platform-card ${this.state.selectedPlatforms.includes(dp.type) ? "selected" : ""} ${dp.detected ? "detected" : ""}"
                   data-platform="${dp.type}"
                   data-action="toggle-platform">
                <div class="platform-name">
                  ${PLATFORMS[dp.type].displayName}
                  ${dp.detected ? '<span class="badge">Detected</span>' : ""}
                </div>
                <div class="platform-desc">${PLATFORMS[dp.type].description}</div>
              </div>
            `
              )
              .join("")}
          </div>

          <div class="tip">
            <strong>Tip:</strong> Platforms are auto-detected based on config directories. You can always add more later.
          </div>
        `;

      case 4:
        return `
          <h2>Choose Server Profile</h2>
          <p>Select the active loom-core tool profile:</p>

          <div class="profile-grid">
            <label class="profile-card ${this.state.profile === "full" ? "selected" : ""}" data-action="select-profile" data-profile="full">
              <input type="radio" name="profile" value="full" ${this.state.profile === "full" ? "checked" : ""}>
              <div class="profile-header">
                <span class="profile-name">Full</span>
                <span class="badge recommended">Recommended</span>
              </div>
              <p class="profile-desc">All available tools with smart prioritization</p>
              <ul class="profile-features">
                <li>Max 500 tools</li>
                <li>Broadest local and remote coverage</li>
                <li>Best default for general development</li>
              </ul>
            </label>

            <label class="profile-card ${this.state.profile === "dev" ? "selected" : ""}" data-action="select-profile" data-profile="dev">
              <input type="radio" name="profile" value="dev" ${this.state.profile === "dev" ? "checked" : ""}>
              <div class="profile-header">
                <span class="profile-name">Dev</span>
              </div>
              <p class="profile-desc">Core development tools for coding workflows</p>
              <ul class="profile-features">
                <li>Max 50 tools</li>
                <li>Git, GitHub, GitLab focus</li>
                <li>Fastest day-to-day coding profile</li>
              </ul>
            </label>

            <label class="profile-card ${this.state.profile === "infra" ? "selected" : ""}" data-action="select-profile" data-profile="infra">
              <input type="radio" name="profile" value="infra" ${this.state.profile === "infra" ? "checked" : ""}>
              <div class="profile-header">
                <span class="profile-name">Infra</span>
              </div>
              <p class="profile-desc">Infrastructure and cloud management</p>
              <ul class="profile-features">
                <li>Cloudflare, MinIO, monitoring</li>
                <li>Max 60 tools</li>
                <li>Operations-heavy workflows</li>
              </ul>
            </label>

            <label class="profile-card ${this.state.profile === "k8s-ops" ? "selected" : ""}" data-action="select-profile" data-profile="k8s-ops">
              <input type="radio" name="profile" value="k8s-ops" ${this.state.profile === "k8s-ops" ? "checked" : ""}>
              <div class="profile-header">
                <span class="profile-name">K8s Ops</span>
              </div>
              <p class="profile-desc">Kubernetes cluster management and debugging</p>
              <ul class="profile-features">
                <li>Kubernetes and observability focus</li>
                <li>Max 40 tools</li>
                <li>Good for cluster operations</li>
              </ul>
            </label>

            <label class="profile-card ${this.state.profile === "research" ? "selected" : ""}" data-action="select-profile" data-profile="research">
              <input type="radio" name="profile" value="research" ${this.state.profile === "research" ? "checked" : ""}>
              <div class="profile-header">
                <span class="profile-name">Research</span>
              </div>
              <p class="profile-desc">Web search and content extraction</p>
              <ul class="profile-features">
                <li>Tavily and YouTube focus</li>
                <li>Max 20 tools</li>
                <li>Best for source gathering</li>
              </ul>
            </label>
          </div>

          <div class="tip">
            <strong>Note:</strong> You can change the profile anytime from Loom settings.
          </div>
        `;

      case 5:
        return `
          <h2>Setup Verification</h2>
          <p>Checking your Loom configuration:</p>

          <div class="verification-results">
            ${this.state.verificationResults.length === 0 ? '<p class="pending">Running checks...</p>' : ""}
            ${this.state.verificationResults
              .map(
                (r) => `
              <div class="result ${r.status}">
                <span class="icon">${r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "○"}</span>
                <span class="check">${r.check}</span>
                <span class="message">${r.message}</span>
              </div>
            `
              )
              .join("")}
          </div>

          ${
            this.state.verificationResults.some((r) => r.status === "fail")
              ? `
            <div class="tip warning">
              <strong>Note:</strong> Some checks failed. Setup can still complete - fix issues later from the Loom sidebar.
            </div>
            <button class="btn-secondary" data-action="rerun-verification">Re-run Checks</button>
          `
              : ""
          }

          <h3>Quick Start</h3>
          <ul class="checklist">
            <li>Open the <strong>Loom</strong> sidebar to browse servers and tools</li>
            <li>Use <code>Cmd+Shift+P</code> → "Loom:" for all commands</li>
            <li>Try asking your AI assistant: "List my GitHub repos"</li>
          </ul>
        `;

      default:
        return "";
    }
  }

  private getButtons(): string {
    const isFirst = this.state.step === 1;
    const isLast = this.state.step === 5;

    return `
      <div>
        ${
          isFirst
            ? '<button class="btn-link" data-action="skip">Skip Setup</button>'
            : '<button class="btn-secondary" data-action="back">Back</button>'
        }
      </div>
      <div>
        ${
          isLast
            ? '<button class="btn-primary" data-action="finish">Finish Setup</button>'
            : '<button class="btn-primary" data-action="next">Next</button>'
        }
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
