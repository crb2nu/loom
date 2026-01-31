import * as vscode from "vscode";

import { DaemonClient } from "../clients/daemon";
import { RoutingStatus, ExtendedServerProfile, PlatformType } from "../types";
import { getEnabledPlatforms } from "../utils/platform";

import { HubStatusManager } from "./hubStatus";

/**
 * Manager for server profiles and routing configuration.
 */
export class ProfileManager implements vscode.Disposable {
  private readonly hubStatusManager: HubStatusManager;
  private readonly daemonClient: DaemonClient;
  private readonly channel: vscode.OutputChannel;
  private readonly emitter = new vscode.EventEmitter<string>();
  readonly onDidChangeProfile = this.emitter.event;
  private activeProfile: string = "full";
  private profiles: Map<string, ExtendedServerProfile>;

  constructor(
    hubStatusManager: HubStatusManager,
    daemonClient: DaemonClient,
    channel: vscode.OutputChannel
  ) {
    this.hubStatusManager = hubStatusManager;
    this.daemonClient = daemonClient;
    this.channel = channel;
    this.profiles = new Map();

    // Load profiles from config
    this.loadProfiles();

    // Load active profile
    this.activeProfile =
      vscode.workspace.getConfiguration("loom").get<string>("activeProfile") ?? "full";
  }

  /**
   * Load profiles from VS Code configuration.
   */
  private loadProfiles(): void {
    const configProfiles =
      vscode.workspace
        .getConfiguration("loom")
        .get<
          Record<
            string,
            { servers: string[] | "*"; hubEnabled: boolean; platforms?: PlatformType[] }
          >
        >("profiles") ?? {};

    this.profiles.clear();

    const allPlatforms = getEnabledPlatforms();

    // Add default profiles
    this.profiles.set("full", {
      name: "full",
      servers: "*",
      hubEnabled: true,
      platforms: allPlatforms,
    });

    this.profiles.set("local", {
      name: "local",
      servers: "*",
      hubEnabled: false,
      platforms: allPlatforms,
    });

    // Add user-defined profiles
    for (const [name, config] of Object.entries(configProfiles)) {
      this.profiles.set(name, {
        name,
        servers: config.servers,
        hubEnabled: config.hubEnabled,
        platforms: config.platforms ?? allPlatforms,
      });
    }
  }

  /**
   * Get all available profiles.
   */
  getProfiles(): ExtendedServerProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Get the active profile.
   */
  getActiveProfile(): ExtendedServerProfile | undefined {
    return this.profiles.get(this.activeProfile);
  }

  /**
   * Get platforms enabled for the current profile.
   */
  getProfilePlatforms(): PlatformType[] {
    const profile = this.getActiveProfile();
    return profile?.platforms ?? getEnabledPlatforms();
  }

  /**
   * Check if a platform is enabled for the current profile.
   */
  isPlatformEnabled(platform: PlatformType): boolean {
    const profile = this.getActiveProfile();
    if (!profile?.platforms) return true;
    return profile.platforms.includes(platform);
  }

  /**
   * Create a new profile.
   */
  async createProfile(
    name: string,
    servers: string[] | "*",
    hubEnabled: boolean,
    platforms?: PlatformType[]
  ): Promise<boolean> {
    if (this.profiles.has(name)) {
      vscode.window.showErrorMessage(`Profile already exists: ${name}`);
      return false;
    }

    const newProfile: ExtendedServerProfile = {
      name,
      servers,
      hubEnabled,
      platforms: platforms ?? getEnabledPlatforms(),
    };

    // Get existing profiles and add the new one
    const existingProfiles =
      vscode.workspace
        .getConfiguration("loom")
        .get<Record<string, ExtendedServerProfile>>("profiles") ?? {};

    const updatedProfiles = {
      ...existingProfiles,
      [name]: {
        servers: newProfile.servers,
        hubEnabled: newProfile.hubEnabled,
        platforms: newProfile.platforms,
      },
    };

    await vscode.workspace
      .getConfiguration("loom")
      .update("profiles", updatedProfiles, vscode.ConfigurationTarget.Global);

    this.loadProfiles();
    this.channel.appendLine(`[${new Date().toISOString()}] Created profile: ${name}`);

    return true;
  }

  /**
   * Update an existing profile.
   */
  async updateProfile(
    name: string,
    updates: Partial<Omit<ExtendedServerProfile, "name">>
  ): Promise<boolean> {
    const existing = this.profiles.get(name);
    if (!existing) {
      vscode.window.showErrorMessage(`Profile not found: ${name}`);
      return false;
    }

    // Don't allow editing built-in profiles directly in config
    if (name === "full" || name === "local") {
      vscode.window.showErrorMessage(`Cannot modify built-in profile: ${name}`);
      return false;
    }

    const existingProfiles =
      vscode.workspace
        .getConfiguration("loom")
        .get<Record<string, ExtendedServerProfile>>("profiles") ?? {};

    const updatedProfiles = {
      ...existingProfiles,
      [name]: {
        ...existingProfiles[name],
        ...updates,
      },
    };

    await vscode.workspace
      .getConfiguration("loom")
      .update("profiles", updatedProfiles, vscode.ConfigurationTarget.Global);

    this.loadProfiles();
    this.channel.appendLine(`[${new Date().toISOString()}] Updated profile: ${name}`);

    return true;
  }

  /**
   * Get the active profile name.
   */
  getActiveProfileName(): string {
    return this.activeProfile;
  }

  /**
   * Switch to a different profile.
   */
  async switchProfile(profileName: string): Promise<boolean> {
    const profile = this.profiles.get(profileName);
    if (!profile) {
      vscode.window.showErrorMessage(`Profile not found: ${profileName}`);
      return false;
    }

    this.activeProfile = profileName;

    // Save to config
    await vscode.workspace
      .getConfiguration("loom")
      .update("activeProfile", profileName, vscode.ConfigurationTarget.Global);

    this.channel.appendLine(`[${new Date().toISOString()}] Switched to profile: ${profileName}`);

    this.emitter.fire(profileName);
    return true;
  }

  /**
   * Get current routing status.
   */
  async getRoutingStatus(): Promise<RoutingStatus> {
    const hubStatus = this.hubStatusManager.getStatus();
    const servers = await this.daemonClient.getServers();

    const hubServers = new Set(hubStatus.servers.map((s) => s.name));
    const localServers = servers.map((s) => s.name);

    const hubRouted: string[] = [];
    const localRouted: string[] = [];

    for (const server of localServers) {
      if (hubServers.has(server)) {
        hubRouted.push(server);
      } else {
        localRouted.push(server);
      }
    }

    // Add hub-only servers
    for (const server of hubStatus.servers) {
      if (!localServers.includes(server.name)) {
        hubRouted.push(server.name);
      }
    }

    return {
      hubRouted,
      localRouted,
      hubHealthy: hubStatus.health?.status === "ok",
      activeProfile: this.activeProfile,
    };
  }

  /**
   * Check if a server is enabled in the current profile.
   */
  isServerEnabled(serverName: string): boolean {
    const profile = this.getActiveProfile();
    if (!profile) return true;

    if (profile.servers === "*") return true;
    return profile.servers.includes(serverName);
  }

  /**
   * Check if hub routing is enabled in the current profile.
   */
  isHubEnabled(): boolean {
    const profile = this.getActiveProfile();
    return profile?.hubEnabled ?? true;
  }

  /**
   * Reload profiles from configuration.
   */
  reloadProfiles(): void {
    this.loadProfiles();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
