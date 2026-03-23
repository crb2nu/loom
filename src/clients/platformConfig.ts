import { execFile } from "child_process";
import * as crypto from "crypto";
import { existsSync, promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import * as vscode from "vscode";
import { parse as parseYaml } from "yaml";

import {
  DoctorEnvWarning,
  DoctorPlatformReport,
  DoctorReport,
  PlatformConfigArtifact,
  PlatformConfig,
  PlatformSyncResult,
  PlatformType,
  SyncDashboardState,
} from "../types";
import { resolveLoomBinary } from "../utils/binary";
import { ConfigManager } from "../utils/configManager";
import { Logger } from "../utils/logger";
import { PLATFORMS, getEnabledPlatforms } from "../utils/platform";

const execFileAsync = promisify(execFile);
const DOCTOR_CACHE_TTL_MS = 30_000;
const ANTIGRAVITY_REPO_SETTINGS_STUB = path.join(".antigravity", "settings.json");
const ANTIGRAVITY_HOME_SETTINGS_STUB = path.join(".gemini", "antigravity", "settings.json");

/**
 * Client for managing MCP configurations across multiple platforms.
 */
export class PlatformConfigClient implements vscode.Disposable {
  private readonly workspaceRoot: string;
  private readonly homeDir: string;
  private readonly channel: vscode.OutputChannel;
  private readonly logger: Logger;
  private readonly configManager?: ConfigManager;
  private readonly emitter = new vscode.EventEmitter<PlatformConfig[]>();
  private configs = new Map<PlatformType, PlatformConfig>();
  private checkInterval?: NodeJS.Timeout;
  private lastConfigsHash = "";
  private cachedDoctorReport?: DoctorReport;
  private lastDoctorLoadAt = 0;

  readonly onDidChange = this.emitter.event;

  constructor(workspaceRoot: string, channel: vscode.OutputChannel, configManager?: ConfigManager) {
    this.workspaceRoot = workspaceRoot;
    this.homeDir = os.homedir();
    this.channel = channel;
    this.logger = new Logger(channel, "PlatformConfig");
    this.configManager = configManager;

    const pollInterval = this.configManager
      ? this.configManager.get("syncStatusPollingInterval")
      : vscode.workspace.getConfiguration("loom").get<number>("syncStatusPollingInterval");

    if (pollInterval && pollInterval > 0) {
      this.checkInterval = setInterval(() => {
        void this.checkAllSyncStatus();
      }, pollInterval);
    }
  }

  dispose(): void {
    this.emitter.dispose();
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
  }

  getConfigs(): PlatformConfig[] {
    return Array.from(this.configs.values());
  }

  getConfig(platform: PlatformType): PlatformConfig | undefined {
    return this.configs.get(platform);
  }

  async getDashboardState(): Promise<SyncDashboardState> {
    await this.checkAllSyncStatus();

    const registryPath = this.findRegistryPath();
    let registryServerCount = 0;
    if (registryPath) {
      const content = await fsp.readFile(registryPath, "utf-8");
      const parsed = this.parseConfigContent(content);
      registryServerCount = this.extractServerNames(parsed).length;
    }

    return {
      platforms: this.getConfigs(),
      registryPath,
      registryServerCount,
      lastUpdated: new Date(),
    };
  }

  async getDoctorReport(forceRefresh = false): Promise<DoctorReport | null> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.cachedDoctorReport &&
      now - this.lastDoctorLoadAt < DOCTOR_CACHE_TTL_MS
    ) {
      return this.cachedDoctorReport;
    }

    try {
      const loomBinary = resolveLoomBinary(this.workspaceRoot);
      const { stdout } = await execFileAsync(loomBinary, ["doctor", "--json"], {
        cwd: this.workspaceRoot || os.homedir(),
        timeout: 30_000,
      });
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      this.cachedDoctorReport = this.normalizeDoctorReport(parsed);
      this.lastDoctorLoadAt = now;
      return this.cachedDoctorReport;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to load doctor report: ${message}`);
      return this.cachedDoctorReport ?? null;
    }
  }

  async fixDoctorIssues(): Promise<{ output: string; report: DoctorReport | null }> {
    const loomBinary = resolveLoomBinary(this.workspaceRoot);
    const { stdout, stderr } = await execFileAsync(loomBinary, ["doctor", "--fix"], {
      cwd: this.workspaceRoot || os.homedir(),
      timeout: 60_000,
    });

    this.cachedDoctorReport = undefined;
    this.lastDoctorLoadAt = 0;
    await this.checkAllSyncStatus();

    return {
      output: [stdout, stderr].filter(Boolean).join("\n").trim(),
      report: await this.getDoctorReport(true),
    };
  }

  async checkAllSyncStatus(): Promise<void> {
    const enabledPlatforms = this.configManager
      ? getEnabledPlatforms(this.configManager.get("enabledPlatforms"))
      : getEnabledPlatforms();
    const doctorReport = await this.getDoctorReport();

    await Promise.all(
      enabledPlatforms.map(async (platform) => {
        const doctor = doctorReport?.platforms.find((item) => item.platform === platform);
        await this.checkPlatformSyncStatus(platform, doctor, doctorReport?.envWarnings ?? []);
      })
    );

    this.fireIfChanged();
  }

  async checkPlatformSyncStatus(
    platform: PlatformType,
    doctorOverride?: DoctorPlatformReport,
    envWarnings: DoctorEnvWarning[] = []
  ): Promise<PlatformConfig> {
    const info = PLATFORMS[platform];
    const repoPath = path.join(this.workspaceRoot, info.repoConfigPath);
    const homePath = path.join(this.homeDir, info.homeConfigPath);
    const config: PlatformConfig = {
      platform,
      format: info.configFormat,
      repoPath,
      homePath,
      artifacts: [],
      syncStatus: "unknown",
      serverCount: 0,
      lastChecked: new Date(),
      doctor: doctorOverride,
    };
    let artifacts: PlatformConfigArtifact[] = [];

    try {
      const supplementalArtifacts = await this.getSupplementalArtifacts(platform);
      const [repoExists, homeExists] = await Promise.all([
        this.fileExists(repoPath),
        this.fileExists(homePath),
      ]);

      artifacts = [
        {
          label: "Repo config",
          path: repoPath,
          required: true,
          exists: repoExists,
        },
        {
          label: "Home config",
          path: homePath,
          required: true,
          exists: homeExists,
        },
        ...supplementalArtifacts,
      ];

      if (repoExists) {
        const repoContent = await fsp.readFile(repoPath, "utf-8");
        config.repoHash = this.hashContent(repoContent);
        artifacts[0].hash = config.repoHash;
        config.serverCount = this.extractServerNames(this.parseConfigContent(repoContent)).length;
      }

      if (homeExists) {
        const homeContent = await fsp.readFile(homePath, "utf-8");
        config.homeHash = this.hashContent(homeContent);
        artifacts[1].hash = config.homeHash;
        if (config.serverCount === 0) {
          config.serverCount = this.extractServerNames(this.parseConfigContent(homeContent)).length;
        }
      }

      const warningCount = envWarnings.length;
      config.artifacts = artifacts;
      config.syncStatus = this.determineSyncStatus(doctorOverride, repoExists, homeExists);
      config.error = this.buildConfigError(doctorOverride, repoExists, homeExists, warningCount);
    } catch (error) {
      config.artifacts = artifacts;
      config.syncStatus = "error";
      config.error = error instanceof Error ? error.message : String(error);
      this.configs.set(platform, config);
      return config;
    }

    config.artifacts = artifacts;
    this.configs.set(platform, config);
    return config;
  }

  async syncPlatform(platform: PlatformType): Promise<PlatformSyncResult> {
    return this.runPlatformCommand(
      platform,
      ["sync", platform, "--regen"],
      `Synced ${PLATFORMS[platform].displayName} config`
    );
  }

  async syncAllPlatforms(): Promise<PlatformSyncResult[]> {
    const enabledPlatforms = this.configManager
      ? getEnabledPlatforms(this.configManager.get("enabledPlatforms"))
      : getEnabledPlatforms();
    const results: PlatformSyncResult[] = [];

    for (const platform of enabledPlatforms) {
      results.push(await this.syncPlatform(platform));
    }

    this.lastConfigsHash = "";
    this.fireIfChanged();
    return results;
  }

  async pullFromHome(platform: PlatformType): Promise<PlatformSyncResult> {
    return this.runPlatformCommand(
      platform,
      ["pull", platform],
      `Pulled ${PLATFORMS[platform].displayName} config from home`
    );
  }

  async regenerateConfig(platform: PlatformType): Promise<PlatformSyncResult> {
    return this.runPlatformCommand(
      platform,
      ["sync", platform, "--regen", "--repo-only"],
      `Regenerated ${PLATFORMS[platform].displayName} config`
    );
  }

  async getDiff(platform: PlatformType): Promise<string> {
    const info = PLATFORMS[platform];
    const repoPath = path.join(this.workspaceRoot, info.repoConfigPath);
    const homePath = path.join(this.homeDir, info.homeConfigPath);
    const config = this.getConfig(platform);

    const [repoExists, homeExists] = await Promise.all([
      this.fileExists(repoPath),
      this.fileExists(homePath),
    ]);
    const [repoContent, homeContent] = await Promise.all([
      repoExists ? fsp.readFile(repoPath, "utf-8") : Promise.resolve("(file not found)"),
      homeExists ? fsp.readFile(homePath, "utf-8") : Promise.resolve("(file not found)"),
    ]);

    const repoServers = repoExists
      ? this.extractServerNames(this.parseConfigContent(repoContent))
      : [];
    const homeServers = homeExists
      ? this.extractServerNames(this.parseConfigContent(homeContent))
      : [];

    const onlyInRepo = repoServers.filter((server) => !homeServers.includes(server));
    const onlyInHome = homeServers.filter((server) => !repoServers.includes(server));

    const lines: string[] = [
      `# ${info.displayName} Configuration Diff`,
      "",
      `Repo: ${repoPath}`,
      `Home: ${homePath}`,
      config?.doctor
        ? `Doctor: status=${config.doctor.status}, hooks=${config.doctor.hooks}, perms=${config.doctor.perms}, schema=${config.doctor.schema}`
        : "Doctor: unavailable",
      "",
    ];

    if (onlyInRepo.length > 0) {
      lines.push("## Only in Repo", "", ...onlyInRepo.map((server) => `- ${server}`), "");
    }
    if (onlyInHome.length > 0) {
      lines.push("## Only in Home", "", ...onlyInHome.map((server) => `- ${server}`), "");
    }
    if (onlyInRepo.length === 0 && onlyInHome.length === 0) {
      lines.push("Server sets are aligned.");
    }

    const supplementalArtifacts = config?.artifacts?.filter((artifact) => !artifact.required) ?? [];
    if (supplementalArtifacts.length > 0) {
      lines.push("", "## Supplemental Artifacts");
      for (const artifact of supplementalArtifacts) {
        lines.push(
          `- ${artifact.label}: ${artifact.exists ? "present" : "missing"} \`${artifact.path}\``
        );
      }
    }

    if (config?.error) {
      lines.push("", `Doctor/Status note: ${config.error}`);
    }

    return lines.join("\n");
  }

  async backupConfigs(): Promise<string> {
    const backupDir = path.join(this.workspaceRoot, ".loom-backup", this.getTimestamp());
    await fsp.mkdir(backupDir, { recursive: true });

    const enabledPlatforms = this.configManager
      ? getEnabledPlatforms(this.configManager.get("enabledPlatforms"))
      : getEnabledPlatforms();

    for (const platform of enabledPlatforms) {
      const info = PLATFORMS[platform];
      const repoPath = path.join(this.workspaceRoot, info.repoConfigPath);
      const homePath = path.join(this.homeDir, info.homeConfigPath);

      if (await this.fileExists(repoPath)) {
        await fsp.mkdir(path.join(backupDir, platform), { recursive: true });
        await fsp.copyFile(repoPath, path.join(backupDir, platform, `repo.${info.configFormat}`));
      }
      if (await this.fileExists(homePath)) {
        await fsp.mkdir(path.join(backupDir, platform), { recursive: true });
        await fsp.copyFile(homePath, path.join(backupDir, platform, `home.${info.configFormat}`));
      }
    }

    return backupDir;
  }

  private async runPlatformCommand(
    platform: PlatformType,
    args: string[],
    successMessage: string
  ): Promise<PlatformSyncResult> {
    const info = PLATFORMS[platform];

    try {
      const loomBinary = resolveLoomBinary(this.workspaceRoot);
      const { stdout, stderr } = await execFileAsync(loomBinary, args, {
        cwd: this.workspaceRoot || os.homedir(),
        timeout: 30_000,
      });

      if (stdout.trim()) {
        this.channel.appendLine(stdout.trim());
      }
      if (stderr.trim()) {
        this.channel.appendLine(stderr.trim());
      }

      this.lastDoctorLoadAt = 0;
      await this.checkAllSyncStatus();

      return {
        platform,
        success: true,
        message: successMessage,
        repoPath: path.join(this.workspaceRoot, info.repoConfigPath),
        homePath: path.join(this.homeDir, info.homeConfigPath),
        serversUpdated: this.configs.get(platform)?.serverCount ?? 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`${args.join(" ")} failed: ${message}`);
      return {
        platform,
        success: false,
        message,
        repoPath: path.join(this.workspaceRoot, info.repoConfigPath),
        homePath: path.join(this.homeDir, info.homeConfigPath),
      };
    }
  }

  private normalizeDoctorReport(raw: Record<string, unknown>): DoctorReport {
    const asRecordArray = (value: unknown): Array<Record<string, unknown>> =>
      Array.isArray(value)
        ? value.filter((item): item is Record<string, unknown> =>
            Boolean(item && typeof item === "object")
          )
        : [];

    return {
      ok: raw.ok !== false,
      platforms: asRecordArray(raw.platforms).map((platform) => ({
        platform: this.asString(platform.platform) ?? "",
        hooks: this.asDoctorStatus(platform.hooks),
        perms: this.asDoctorStatus(platform.perms),
        schema: this.asDoctorStatus(platform.schema),
        status: this.asDoctorStatus(platform.status),
        config_path: typeof platform.config_path === "string" ? platform.config_path : undefined,
        details: Array.isArray(platform.details)
          ? platform.details.filter((entry): entry is string => typeof entry === "string")
          : undefined,
        capabilities:
          platform.capabilities && typeof platform.capabilities === "object"
            ? (platform.capabilities as DoctorPlatformReport["capabilities"])
            : undefined,
      })),
      loomBinary: typeof raw.loom_binary === "string" ? raw.loom_binary : undefined,
      registry: typeof raw.registry === "string" ? raw.registry : undefined,
      registrySource: typeof raw.registry_source === "string" ? raw.registry_source : undefined,
      registryPrecedence: Array.isArray(raw.registry_precedence)
        ? raw.registry_precedence.filter((entry): entry is string => typeof entry === "string")
        : undefined,
      templateProfiles: asRecordArray(raw.template_profiles).map((profile) => ({
        profile: typeof profile.profile === "string" ? profile.profile : undefined,
        unresolved: typeof profile.unresolved === "number" ? profile.unresolved : undefined,
        items: Array.isArray(profile.items)
          ? profile.items.filter((entry): entry is string => typeof entry === "string")
          : undefined,
        fix: Array.isArray(profile.fix)
          ? profile.fix.filter((entry): entry is string => typeof entry === "string")
          : undefined,
      })),
      envWarnings: asRecordArray(raw.env_warnings).map((warning) => ({
        key: typeof warning.key === "string" ? warning.key : undefined,
        message: typeof warning.message === "string" ? warning.message : undefined,
        fix: typeof warning.fix === "string" ? warning.fix : undefined,
        servers: Array.isArray(warning.servers)
          ? warning.servers.filter((entry): entry is string => typeof entry === "string")
          : undefined,
      })),
    };
  }

  private asDoctorStatus(value: unknown): DoctorPlatformReport["status"] {
    if (
      value === "ok" ||
      value === "n/a" ||
      value === "stale" ||
      value === "missing" ||
      value === "healthy" ||
      value === "error"
    ) {
      return value;
    }
    return "error";
  }

  private asString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private determineSyncStatus(
    doctor: DoctorPlatformReport | undefined,
    repoExists: boolean,
    homeExists: boolean
  ): PlatformConfig["syncStatus"] {
    if (!repoExists && !homeExists) {
      return "missing";
    }

    if (!doctor) {
      return repoExists && homeExists ? "synced" : "out-of-sync";
    }

    if (doctor.status === "error") {
      return "error";
    }
    if (doctor.status === "missing") {
      return "missing";
    }
    if (
      doctor.status !== "healthy" ||
      doctor.hooks === "stale" ||
      doctor.perms === "stale" ||
      doctor.schema === "stale"
    ) {
      return "out-of-sync";
    }

    return repoExists && homeExists ? "synced" : "out-of-sync";
  }

  private buildConfigError(
    doctor: DoctorPlatformReport | undefined,
    repoExists: boolean,
    homeExists: boolean,
    envWarningCount: number
  ): string | undefined {
    const issues: string[] = [];
    if (!repoExists) issues.push("repo config missing");
    if (!homeExists) issues.push("home config missing");
    if (doctor) {
      if (doctor.status !== "healthy") issues.push(`doctor status ${doctor.status}`);
      if (doctor.hooks !== "ok" && doctor.hooks !== "n/a") issues.push(`hooks ${doctor.hooks}`);
      if (doctor.perms !== "ok" && doctor.perms !== "n/a") issues.push(`perms ${doctor.perms}`);
      if (doctor.schema !== "ok" && doctor.schema !== "n/a") issues.push(`schema ${doctor.schema}`);
    }
    if (envWarningCount > 0) {
      issues.push(`${envWarningCount} env warning${envWarningCount === 1 ? "" : "s"}`);
    }
    return issues.length > 0 ? issues.join("; ") : undefined;
  }

  private fireIfChanged(): void {
    const nextHash = JSON.stringify(
      Array.from(this.configs.values()).map((config) => ({
        platform: String(config.platform),
        syncStatus: config.syncStatus,
        serverCount: config.serverCount,
        repoHash: config.repoHash,
        homeHash: config.homeHash,
        artifacts: config.artifacts?.map((artifact) => ({
          label: artifact.label,
          path: artifact.path,
          required: artifact.required,
          exists: artifact.exists,
          hash: artifact.hash,
        })),
        error: config.error,
        doctorStatus: config.doctor?.status,
      }))
    );

    if (nextHash !== this.lastConfigsHash) {
      this.lastConfigsHash = nextHash;
      this.emitter.fire(this.getConfigs());
    }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fsp.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private parseConfigContent(content: string): Record<string, unknown> {
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      return (parseYaml(content) as Record<string, unknown>) ?? {};
    }
  }

  private extractServerNames(content: Record<string, unknown>): string[] {
    const candidates = [content.mcpServers, content.mcp, content.servers, content.targets];

    for (const candidate of candidates) {
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        return Object.keys(candidate as Record<string, unknown>).sort();
      }
    }

    return [];
  }

  private hashContent(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 8);
  }

  private findRegistryPath(): string | undefined {
    const candidates = [
      path.join(this.workspaceRoot, "mcp", "context", "registry.yaml"),
      path.join(this.workspaceRoot, ".config", "loom", "registry.yaml"),
      path.join(this.homeDir, ".config", "loom", "registry.yaml"),
    ];

    return candidates.find((candidate) => {
      try {
        return existsSync(candidate);
      } catch {
        return false;
      }
    });
  }

  private async getSupplementalArtifacts(
    platform: PlatformType
  ): Promise<PlatformConfigArtifact[]> {
    if (platform !== "antigravity") {
      return [];
    }

    const repoSettingsPath = path.join(this.workspaceRoot, ANTIGRAVITY_REPO_SETTINGS_STUB);
    const homeSettingsPath = path.join(this.homeDir, ANTIGRAVITY_HOME_SETTINGS_STUB);

    const [repoExists, homeExists] = await Promise.all([
      this.fileExists(repoSettingsPath),
      this.fileExists(homeSettingsPath),
    ]);

    return [
      {
        label: "Repo settings stub",
        path: repoSettingsPath,
        required: false,
        exists: repoExists,
      },
      {
        label: "Home settings stub",
        path: homeSettingsPath,
        required: false,
        exists: homeExists,
      },
    ];
  }

  private getTimestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }
}
