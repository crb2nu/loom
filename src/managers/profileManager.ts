import { execFile } from "child_process";
import * as os from "os";
import { promisify } from "util";

import * as vscode from "vscode";

import { DaemonClient } from "../clients/daemon";
import type { LoomRuntimeProfileState } from "../clients/daemon";
import { RoutingStatus, LoomCoreProfile, PlatformType } from "../types";
import { resolveLoomBinary } from "../utils/binary";
import { ConfigManager } from "../utils/configManager";
import { Logger } from "../utils/logger";
import { getEnabledPlatforms } from "../utils/platform";

import { HubStatusManager } from "./hubStatus";

const execFileAsync = promisify(execFile);

const PROFILE_CACHE_TTL_MS = 30_000;

interface LoomDoctorTemplateProfile {
  profile?: string;
  ok?: boolean;
  count?: number;
  unresolved?: unknown[];
}

interface LoomDoctorResponse {
  template_profiles?: LoomDoctorTemplateProfile[];
}

/**
 * Manager for loom-core tool profiles and routing status.
 */
export class ProfileManager implements vscode.Disposable {
  private static warnedDeprecatedProfiles = false;

  private readonly hubStatusManager: HubStatusManager;
  private readonly daemonClient: DaemonClient;
  private readonly workspaceRoot: string;
  private readonly logger: Logger;
  private readonly configManager?: ConfigManager;
  private readonly emitter = new vscode.EventEmitter<string>();
  readonly onDidChangeProfile = this.emitter.event;

  private activeProfile = "full";
  private cachedProfiles: LoomCoreProfile[] = [];
  private lastProfilesLoadAt = 0;

  constructor(
    hubStatusManager: HubStatusManager,
    daemonClient: DaemonClient,
    workspaceRoot: string,
    channel: vscode.OutputChannel,
    configManager?: ConfigManager
  ) {
    this.hubStatusManager = hubStatusManager;
    this.daemonClient = daemonClient;
    this.workspaceRoot = workspaceRoot;
    this.logger = new Logger(channel, "Profile");
    this.configManager = configManager;
    this.activeProfile = this.configManager
      ? this.configManager.get("activeProfile")
      : (vscode.workspace.getConfiguration("loom").get<string>("activeProfile") ?? "full");

    this.maybeWarnDeprecatedProfiles();
  }

  private maybeWarnDeprecatedProfiles(): void {
    const configuredProfiles = this.configManager
      ? this.configManager.get("profiles")
      : (vscode.workspace.getConfiguration("loom").get<Record<string, unknown>>("profiles") ?? {});

    if (ProfileManager.warnedDeprecatedProfiles || Object.keys(configuredProfiles).length === 0) {
      return;
    }

    ProfileManager.warnedDeprecatedProfiles = true;
    void vscode.window.showWarningMessage(
      "Loom: custom extension profiles are deprecated. The extension now uses loom-core profiles and ignores loom.profiles."
    );
  }

  async getProfiles(forceRefresh = false): Promise<LoomCoreProfile[]> {
    const now = Date.now();
    if (!forceRefresh && now - this.lastProfilesLoadAt < PROFILE_CACHE_TTL_MS) {
      return this.cachedProfiles;
    }

    try {
      const runtimeState = this.getRuntimeProfileState();
      const summaries = runtimeState?.available?.length
        ? this.loadProfileSummariesFromNames(runtimeState.available)
        : await this.loadProfileSummaries();
      const resolvedActive = this.resolveActiveProfileName(
        runtimeState?.active ?? this.activeProfile,
        summaries.map((profile) => profile.name)
      );
      const profiles = await Promise.all(
        summaries.map(async (summary) => ({
          ...summary,
          ...(await this.loadProfileDetails(summary.name)),
        }))
      );

      this.cachedProfiles = profiles;
      this.lastProfilesLoadAt = now;

      if (resolvedActive !== this.activeProfile) {
        this.activeProfile = resolvedActive;
        await this.persistActiveProfile(resolvedActive);
      }

      return this.cachedProfiles;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to load loom-core profiles: ${message}`);

      this.cachedProfiles = [
        {
          name: "full",
          description: "All available tools with smart prioritization",
          maxTools: 500,
          servers: "*",
        },
      ];
      this.lastProfilesLoadAt = now;
      return this.cachedProfiles;
    }
  }

  async getActiveProfile(): Promise<LoomCoreProfile | undefined> {
    const profiles = await this.getProfiles();
    return profiles.find((profile) => profile.name === this.activeProfile);
  }

  getActiveProfileName(): string {
    return this.activeProfile;
  }

  getProfilePlatforms(): PlatformType[] {
    return this.configManager
      ? getEnabledPlatforms(this.configManager.get("enabledPlatforms"))
      : getEnabledPlatforms();
  }

  async switchProfile(profileName: string): Promise<boolean> {
    const profiles = await this.getProfiles();
    const profile = profiles.find((candidate) => candidate.name === profileName);
    if (!profile) {
      vscode.window.showErrorMessage(`Profile not found: ${profileName}`);
      return false;
    }

    this.activeProfile = profile.name;
    await this.persistActiveProfile(profile.name);
    this.logger.info(`Switched to profile: ${profile.name}`);
    this.emitter.fire(profile.name);
    return true;
  }

  async getRoutingStatus(): Promise<RoutingStatus> {
    const [hubStatus, servers, activeProfile] = await Promise.all([
      Promise.resolve(this.hubStatusManager.getStatus()),
      this.daemonClient.getServers(),
      this.getActiveProfile(),
    ]);

    const hubServers = new Set(hubStatus.servers.map((server) => server.name));
    const localServers = servers.map((server) => server.name);

    const hubRouted: string[] = [];
    const localRouted: string[] = [];

    for (const server of localServers) {
      if (hubServers.has(server)) {
        hubRouted.push(server);
      } else {
        localRouted.push(server);
      }
    }

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
      profileDescription: activeProfile?.description,
      profileMaxTools: activeProfile?.maxTools,
      profileServers: activeProfile?.servers,
      profileCategories: activeProfile?.categories,
    };
  }

  isServerEnabled(serverName: string): boolean {
    const profile = this.cachedProfiles.find((candidate) => candidate.name === this.activeProfile);
    if (!profile || profile.servers === "*") {
      return true;
    }

    return profile.servers.some((candidate) => this.matchesProfileServer(candidate, serverName));
  }

  isHubEnabled(): boolean {
    return true;
  }

  reloadProfiles(): void {
    this.lastProfilesLoadAt = 0;
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private async persistActiveProfile(profileName: string): Promise<void> {
    if (this.configManager) {
      await this.configManager.set("activeProfile", profileName);
      return;
    }

    await vscode.workspace
      .getConfiguration("loom")
      .update("activeProfile", profileName, vscode.ConfigurationTarget.Global);
  }

  private getRuntimeProfileState(): LoomRuntimeProfileState | null {
    try {
      return this.daemonClient.getRuntimeProfileState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.info(`Falling back to legacy profile discovery: ${message}`);
      return null;
    }
  }

  private async runLoom(args: string[]): Promise<string> {
    const loomBinary = resolveLoomBinary(this.workspaceRoot);
    const { stdout } = await execFileAsync(loomBinary, args, {
      cwd: this.workspaceRoot || os.homedir(),
      timeout: 10_000,
    });
    return stdout;
  }

  private async loadProfileSummaries(): Promise<LoomCoreProfile[]> {
    try {
      return await this.loadProfileSummariesFromDoctor();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.info(`Falling back to loom profile list text parsing: ${message}`);
      return this.loadProfileSummariesFromCli();
    }
  }

  private loadProfileSummariesFromNames(profileNames: string[]): LoomCoreProfile[] {
    const profiles = new Map<string, LoomCoreProfile>();

    for (const rawName of profileNames) {
      const name = rawName.trim();
      if (!name) {
        continue;
      }

      profiles.set(name, {
        name,
        servers: "*",
      });
    }

    return [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async loadProfileDetails(profileName: string): Promise<Partial<LoomCoreProfile>> {
    try {
      const output = await this.runLoom(["profile", "show", profileName]);
      const description = this.extractValue(output, "Description");
      const maxToolsText = this.extractValue(output, "Max Tools");
      const servers = this.parseBracketList(this.extractValue(output, "Servers"));
      const categories = this.parseBracketList(this.extractValue(output, "Categories"));

      if (!description && !maxToolsText && servers.length === 0 && categories.length === 0) {
        this.logger.info(
          `Profile details for "${profileName}" had no parseable fields; using summary-only fallback`
        );
        return { servers: "*" };
      }

      return {
        description: description ?? undefined,
        maxTools: maxToolsText ? Number(maxToolsText) : undefined,
        servers: servers.length === 1 && servers[0] === "*" ? "*" : servers,
        categories,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.info(`Falling back to summary-only profile "${profileName}": ${message}`);
      return { servers: "*" };
    }
  }

  private async loadProfileSummariesFromDoctor(): Promise<LoomCoreProfile[]> {
    const output = await this.runLoom(["doctor", "--json"]);
    const parsed = JSON.parse(output) as LoomDoctorResponse;
    const profiles = new Map<string, LoomCoreProfile>();

    for (const candidate of parsed.template_profiles ?? []) {
      const name = candidate.profile?.trim();
      if (!name) {
        continue;
      }

      profiles.set(name, {
        name,
        servers: "*",
      });
    }

    if (profiles.size === 0) {
      throw new Error("loom doctor --json returned no template profiles");
    }

    return [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async loadProfileSummariesFromCli(): Promise<LoomCoreProfile[]> {
    const output = await this.runLoom(["profile", "list"]);
    const profiles = new Map<string, LoomCoreProfile>();

    for (const rawLine of output.split("\n")) {
      const line = rawLine.trimEnd();
      if (!line.startsWith("  ")) {
        continue;
      }

      const match = line.match(/^\s{2,}(\S+)\s{2,}(.*?)(?:\s+\(max\s+(\d+)\s+tools\))?$/);
      if (!match) {
        continue;
      }

      const name = match[1];
      profiles.set(name, {
        name,
        description: match[2]?.trim() || undefined,
        maxTools: match[3] ? Number(match[3]) : undefined,
        servers: "*",
      });
    }

    if (profiles.size === 0) {
      throw new Error("loom profile list returned no profiles");
    }

    return [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private extractValue(output: string, label: string): string | undefined {
    const match = output.match(new RegExp(`^${label}:\\s*(.+)$`, "m"));
    return match?.[1]?.trim();
  }

  private parseBracketList(value?: string): string[] {
    if (!value) {
      return [];
    }
    const trimmed = value.trim();
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
      return [];
    }

    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      return [];
    }

    return inner
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private matchesProfileServer(candidate: string, serverName: string): boolean {
    if (candidate === serverName) {
      return true;
    }

    if (!candidate.startsWith("mcp-")) {
      return false;
    }

    const normalized = candidate.slice(4).replace(/-/g, "_");
    return normalized === serverName;
  }

  private resolveActiveProfileName(
    preferred: string | undefined,
    availableNames: string[]
  ): string {
    const candidates = [preferred, this.activeProfile, "full"];
    for (const candidate of candidates) {
      const normalized = candidate?.trim();
      if (normalized && availableNames.includes(normalized)) {
        return normalized;
      }
    }

    return availableNames[0] ?? "full";
  }
}
