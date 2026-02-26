import * as vscode from "vscode";

import { PlatformType, RemoteTunnelProfile } from "../types";

export interface LoomConfig {
  hubUrl: string;
  hubProfile: string;
  platform: string;
  enabledPlatforms: PlatformType[];
  syncOnStartup: boolean;
  syncStatusPollingInterval: number;
  autoSyncOnDrift: "off" | "prompt" | "auto";
  activeProfile: string;
  profiles: Record<string, unknown>;
  agentId: string;
  autoStartSession: boolean;
  showAnnotationDecorations: boolean;
  onboardingComplete: boolean;
  skillsRegistryPath: string | null;
  serverMetricsInterval: number;
  plugins: string[];
  remoteTunnels: RemoteTunnelProfile[];
}

const DEFAULTS: LoomConfig = {
  hubUrl: "wss://mcp.flexinfer.ai/ws",
  hubProfile: "codex",
  platform: "auto",
  enabledPlatforms: ["vscode", "antigravity", "gemini", "claude"],
  syncOnStartup: false,
  syncStatusPollingInterval: 60000,
  autoSyncOnDrift: "prompt",
  activeProfile: "full",
  profiles: {},
  agentId: "vscode-loom",
  autoStartSession: false,
  showAnnotationDecorations: true,
  onboardingComplete: false,
  skillsRegistryPath: null,
  serverMetricsInterval: 30000,
  plugins: [],
  remoteTunnels: [],
};

export class ConfigManager implements vscode.Disposable {
  private emitter = new vscode.EventEmitter<LoomConfig>();
  readonly onDidChange = this.emitter.event;
  private disposable: vscode.Disposable;
  private cached: LoomConfig | undefined;

  constructor() {
    this.disposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("loom")) {
        this.cached = undefined;
        this.emitter.fire(this.config);
      }
    });
  }

  get config(): LoomConfig {
    if (!this.cached) {
      this.cached = this.read();
    }
    return this.cached;
  }

  get<K extends keyof LoomConfig>(key: K): LoomConfig[K] {
    return this.config[key];
  }

  async set<K extends keyof LoomConfig>(
    key: K,
    value: LoomConfig[K],
    target = vscode.ConfigurationTarget.Global
  ): Promise<void> {
    await vscode.workspace.getConfiguration("loom").update(key, value, target);
  }

  private read(): LoomConfig {
    const c = vscode.workspace.getConfiguration("loom");
    return {
      hubUrl: c.get<string>("hubUrl") ?? DEFAULTS.hubUrl,
      hubProfile: c.get<string>("hubProfile") ?? DEFAULTS.hubProfile,
      platform: c.get<string>("platform") ?? DEFAULTS.platform,
      enabledPlatforms: c.get<PlatformType[]>("enabledPlatforms") ?? DEFAULTS.enabledPlatforms,
      syncOnStartup: c.get<boolean>("syncOnStartup") ?? DEFAULTS.syncOnStartup,
      syncStatusPollingInterval:
        c.get<number>("syncStatusPollingInterval") ?? DEFAULTS.syncStatusPollingInterval,
      autoSyncOnDrift:
        c.get<"off" | "prompt" | "auto">("autoSyncOnDrift") ?? DEFAULTS.autoSyncOnDrift,
      activeProfile: c.get<string>("activeProfile") ?? DEFAULTS.activeProfile,
      profiles: c.get<Record<string, unknown>>("profiles") ?? DEFAULTS.profiles,
      agentId: c.get<string>("agentId") ?? DEFAULTS.agentId,
      autoStartSession: c.get<boolean>("autoStartSession") ?? DEFAULTS.autoStartSession,
      showAnnotationDecorations:
        c.get<boolean>("showAnnotationDecorations") ?? DEFAULTS.showAnnotationDecorations,
      onboardingComplete: c.get<boolean>("onboardingComplete") ?? DEFAULTS.onboardingComplete,
      skillsRegistryPath: c.get<string | null>("skillsRegistryPath") ?? DEFAULTS.skillsRegistryPath,
      serverMetricsInterval:
        c.get<number>("serverMetricsInterval") ?? DEFAULTS.serverMetricsInterval,
      plugins: c.get<string[]>("plugins") ?? DEFAULTS.plugins,
      remoteTunnels: c.get<RemoteTunnelProfile[]>("remoteTunnels") ?? DEFAULTS.remoteTunnels,
    };
  }

  dispose(): void {
    this.emitter.dispose();
    this.disposable.dispose();
  }
}
