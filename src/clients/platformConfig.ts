import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import * as vscode from "vscode";

import { PlatformConfig, PlatformSyncResult, PlatformType, SyncDashboardState } from "../types";
import { resolveLoomBinary } from "../utils/binary";
import { PLATFORMS, getEnabledPlatforms } from "../utils/platform";

const execFileAsync = promisify(execFile);

/**
 * Client for managing MCP configurations across multiple platforms.
 */
export class PlatformConfigClient implements vscode.Disposable {
  private readonly workspaceRoot: string;
  private readonly homeDir: string;
  private readonly channel: vscode.OutputChannel;
  private readonly emitter = new vscode.EventEmitter<PlatformConfig[]>();
  private configs: Map<PlatformType, PlatformConfig> = new Map();
  private checkInterval?: NodeJS.Timeout;

  readonly onDidChange = this.emitter.event;

  constructor(workspaceRoot: string, channel: vscode.OutputChannel) {
    this.workspaceRoot = workspaceRoot;
    this.homeDir = os.homedir();
    this.channel = channel;

    // Start periodic sync status checks if configured
    const pollInterval = vscode.workspace
      .getConfiguration("loom")
      .get<number>("syncStatusPollingInterval");

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

  /**
   * Get the current state of all platform configurations.
   */
  getConfigs(): PlatformConfig[] {
    return Array.from(this.configs.values());
  }

  /**
   * Get configuration for a specific platform.
   */
  getConfig(platform: PlatformType): PlatformConfig | undefined {
    return this.configs.get(platform);
  }

  /**
   * Get the full dashboard state.
   */
  async getDashboardState(): Promise<SyncDashboardState> {
    await this.checkAllSyncStatus();

    // Find registry path
    const registryPath = this.findRegistryPath();
    let registryServerCount = 0;

    if (registryPath) {
      try {
        const content = await fsp.readFile(registryPath, "utf-8");
        const parsed = JSON.parse(content) as { servers?: unknown[] };
        registryServerCount = parsed.servers?.length ?? 0;
      } catch {
        // Registry might be YAML
        try {
          const { parse } = await import("yaml");
          const content = await fsp.readFile(registryPath, "utf-8");
          const parsed = parse(content) as { servers?: unknown[] };
          registryServerCount = parsed.servers?.length ?? 0;
        } catch {
          // Ignore parse errors
        }
      }
    }

    return {
      platforms: this.getConfigs(),
      registryPath,
      registryServerCount,
      lastUpdated: new Date(),
    };
  }

  /**
   * Check sync status for all enabled platforms.
   */
  async checkAllSyncStatus(): Promise<void> {
    const enabledPlatforms = getEnabledPlatforms();

    for (const platform of enabledPlatforms) {
      await this.checkPlatformSyncStatus(platform);
    }

    this.emitter.fire(this.getConfigs());
  }

  /**
   * Check sync status for a specific platform.
   */
  async checkPlatformSyncStatus(platform: PlatformType): Promise<PlatformConfig> {
    const info = PLATFORMS[platform];
    const repoPath = path.join(this.workspaceRoot, info.repoConfigPath);
    const homePath = path.join(this.homeDir, info.homeConfigPath);

    const config: PlatformConfig = {
      platform,
      format: info.configFormat,
      repoPath,
      homePath,
      syncStatus: "unknown",
      serverCount: 0,
      lastChecked: new Date(),
    };

    try {
      const [repoExists, homeExists] = await Promise.all([
        this.fileExists(repoPath),
        this.fileExists(homePath),
      ]);

      if (!repoExists && !homeExists) {
        config.syncStatus = "missing";
      } else if (!repoExists) {
        config.syncStatus = "out-of-sync";
        config.error = "Repo config missing";
        if (homeExists) {
          const homeContent = await this.readConfig(homePath, info.configFormat);
          config.serverCount = this.countServers(homeContent);
          config.homeHash = this.hashContent(JSON.stringify(homeContent));
        }
      } else if (!homeExists) {
        config.syncStatus = "out-of-sync";
        config.error = "Home config missing";
        const repoContent = await this.readConfig(repoPath, info.configFormat);
        config.serverCount = this.countServers(repoContent);
        config.repoHash = this.hashContent(JSON.stringify(repoContent));
      } else {
        // Both exist - compare them
        const [repoContent, homeContent] = await Promise.all([
          this.readConfig(repoPath, info.configFormat),
          this.readConfig(homePath, info.configFormat),
        ]);

        config.repoHash = this.hashContent(JSON.stringify(repoContent));
        config.homeHash = this.hashContent(JSON.stringify(homeContent));
        config.serverCount = this.countServers(repoContent);

        // Compare server lists (not full content, due to placeholder resolution)
        const repoServers = this.getServerNames(repoContent);
        const homeServers = this.getServerNames(homeContent);

        if (this.arraysEqual(repoServers, homeServers)) {
          config.syncStatus = "synced";
        } else {
          config.syncStatus = "out-of-sync";
          config.error = `Server mismatch: repo=${repoServers.length}, home=${homeServers.length}`;
        }
      }
    } catch (err) {
      config.syncStatus = "error";
      config.error = err instanceof Error ? err.message : String(err);
    }

    this.configs.set(platform, config);
    return config;
  }

  /**
   * Sync a specific platform's configuration from repo to home.
   */
  async syncPlatform(platform: PlatformType): Promise<PlatformSyncResult> {
    const info = PLATFORMS[platform];
    const repoPath = path.join(this.workspaceRoot, info.repoConfigPath);
    const homePath = path.join(this.homeDir, info.homeConfigPath);

    this.channel.appendLine(`[${new Date().toISOString()}] Syncing ${info.displayName} config...`);

    try {
      // Check if repo config exists
      if (!(await this.fileExists(repoPath))) {
        return {
          platform,
          success: false,
          message: `Repo config not found: ${repoPath}`,
        };
      }

      // Read repo config
      const content = await fsp.readFile(repoPath, "utf-8");

      // Ensure home directory exists
      await fsp.mkdir(path.dirname(homePath), { recursive: true });

      // Write to home
      await fsp.writeFile(homePath, content, "utf-8");

      // Re-check sync status
      await this.checkPlatformSyncStatus(platform);

      this.channel.appendLine(
        `[${new Date().toISOString()}] ${info.displayName} synced successfully`
      );

      return {
        platform,
        success: true,
        message: `Synced ${info.displayName} config`,
        repoPath,
        homePath,
        serversUpdated: this.configs.get(platform)?.serverCount,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.channel.appendLine(
        `[${new Date().toISOString()}] Error syncing ${info.displayName}: ${message}`
      );

      return {
        platform,
        success: false,
        message,
        repoPath,
        homePath,
      };
    }
  }

  /**
   * Sync all enabled platforms.
   */
  async syncAllPlatforms(): Promise<PlatformSyncResult[]> {
    const enabledPlatforms = getEnabledPlatforms();
    const results: PlatformSyncResult[] = [];

    for (const platform of enabledPlatforms) {
      const result = await this.syncPlatform(platform);
      results.push(result);
    }

    this.emitter.fire(this.getConfigs());
    return results;
  }

  /**
   * Pull config from home to repo (reverse sync).
   */
  async pullFromHome(platform: PlatformType): Promise<PlatformSyncResult> {
    const info = PLATFORMS[platform];
    const repoPath = path.join(this.workspaceRoot, info.repoConfigPath);
    const homePath = path.join(this.homeDir, info.homeConfigPath);

    this.channel.appendLine(
      `[${new Date().toISOString()}] Pulling ${info.displayName} config from home...`
    );

    try {
      // Check if home config exists
      if (!(await this.fileExists(homePath))) {
        return {
          platform,
          success: false,
          message: `Home config not found: ${homePath}`,
        };
      }

      // Read home config
      const content = await fsp.readFile(homePath, "utf-8");

      // Ensure repo directory exists
      await fsp.mkdir(path.dirname(repoPath), { recursive: true });

      // Write to repo
      await fsp.writeFile(repoPath, content, "utf-8");

      // Re-check sync status
      await this.checkPlatformSyncStatus(platform);

      this.channel.appendLine(
        `[${new Date().toISOString()}] ${info.displayName} pulled successfully`
      );

      return {
        platform,
        success: true,
        message: `Pulled ${info.displayName} config from home`,
        repoPath,
        homePath,
        serversUpdated: this.configs.get(platform)?.serverCount,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        platform,
        success: false,
        message,
        repoPath,
        homePath,
      };
    }
  }

  /**
   * Regenerate a platform's config using loom CLI.
   */
  async regenerateConfig(platform: PlatformType): Promise<PlatformSyncResult> {
    const info = PLATFORMS[platform];

    this.channel.appendLine(
      `[${new Date().toISOString()}] Regenerating ${info.displayName} config...`
    );

    try {
      const loomBinary = resolveLoomBinary(this.workspaceRoot);

      // Run loom sync with the platform target
      const { stdout, stderr } = await execFileAsync(loomBinary, ["sync", platform, "--regen"], {
        cwd: this.workspaceRoot,
      });

      if (stderr) {
        this.channel.appendLine(stderr);
      }
      if (stdout) {
        this.channel.appendLine(stdout);
      }

      // Re-check sync status
      await this.checkPlatformSyncStatus(platform);

      return {
        platform,
        success: true,
        message: `Regenerated ${info.displayName} config`,
        serversUpdated: this.configs.get(platform)?.serverCount,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.channel.appendLine(
        `[${new Date().toISOString()}] Error regenerating ${info.displayName}: ${message}`
      );

      return {
        platform,
        success: false,
        message,
      };
    }
  }

  /**
   * Get the diff between repo and home configs.
   */
  async getDiff(platform: PlatformType): Promise<string> {
    const info = PLATFORMS[platform];
    const repoPath = path.join(this.workspaceRoot, info.repoConfigPath);
    const homePath = path.join(this.homeDir, info.homeConfigPath);

    try {
      const repoExists = await this.fileExists(repoPath);
      const homeExists = await this.fileExists(homePath);

      const [repoContent, homeContent] = await Promise.all([
        repoExists ? fsp.readFile(repoPath, "utf-8") : Promise.resolve("(file not found)"),
        homeExists ? fsp.readFile(homePath, "utf-8") : Promise.resolve("(file not found)"),
      ]);

      const repoServers = this.getServerNamesFromContent(repoContent, info.configFormat);
      const homeServers = this.getServerNamesFromContent(homeContent, info.configFormat);

      const lines: string[] = [
        `# ${info.displayName} Configuration Diff`,
        "",
        `Repo: ${repoPath}`,
        `Home: ${homePath}`,
        "",
        "## Server Comparison",
        "",
      ];

      // Find differences
      const onlyInRepo = repoServers.filter((s) => !homeServers.includes(s));
      const onlyInHome = homeServers.filter((s) => !repoServers.includes(s));
      const inBoth = repoServers.filter((s) => homeServers.includes(s));

      if (onlyInRepo.length > 0) {
        lines.push("### Only in Repo:");
        for (const server of onlyInRepo) {
          lines.push(`+ ${server}`);
        }
        lines.push("");
      }

      if (onlyInHome.length > 0) {
        lines.push("### Only in Home:");
        for (const server of onlyInHome) {
          lines.push(`- ${server}`);
        }
        lines.push("");
      }

      if (inBoth.length > 0) {
        lines.push("### In Both:");
        for (const server of inBoth) {
          lines.push(`  ${server}`);
        }
      }

      if (onlyInRepo.length === 0 && onlyInHome.length === 0) {
        lines.push("Configs are in sync (same servers)");
      }

      return lines.join("\n");
    } catch (err) {
      return `Error generating diff: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Backup all platform configs.
   */
  async backupConfigs(): Promise<string> {
    const backupDir = path.join(this.workspaceRoot, ".loom-backup", this.getTimestamp());
    await fsp.mkdir(backupDir, { recursive: true });

    const enabledPlatforms = getEnabledPlatforms();
    const backedUp: string[] = [];

    for (const platform of enabledPlatforms) {
      const info = PLATFORMS[platform];
      const repoPath = path.join(this.workspaceRoot, info.repoConfigPath);
      const homePath = path.join(this.homeDir, info.homeConfigPath);

      // Backup repo config
      if (await this.fileExists(repoPath)) {
        const destPath = path.join(backupDir, `${platform}-repo.${info.configFormat}`);
        await fsp.copyFile(repoPath, destPath);
        backedUp.push(`${platform} (repo)`);
      }

      // Backup home config
      if (await this.fileExists(homePath)) {
        const destPath = path.join(backupDir, `${platform}-home.${info.configFormat}`);
        await fsp.copyFile(homePath, destPath);
        backedUp.push(`${platform} (home)`);
      }
    }

    this.channel.appendLine(
      `[${new Date().toISOString()}] Backed up ${backedUp.length} configs to ${backupDir}`
    );

    return backupDir;
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fsp.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async readConfig(
    filePath: string,
    format: "json" | "toml"
  ): Promise<Record<string, unknown>> {
    const content = await fsp.readFile(filePath, "utf-8");

    if (format === "json") {
      return JSON.parse(content) as Record<string, unknown>;
    }

    // TOML parsing - simplified for now
    // In production, you'd use a proper TOML parser
    try {
      // Try to parse as JSON first (some "toml" configs might actually be JSON)
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      // Return empty object for now - TOML parsing would go here
      return {};
    }
  }

  private countServers(config: Record<string, unknown>): number {
    // Handle different config structures
    if (config.mcpServers && typeof config.mcpServers === "object") {
      return Object.keys(config.mcpServers).length;
    }
    if (config.servers && typeof config.servers === "object") {
      if (Array.isArray(config.servers)) {
        return config.servers.length;
      }
      return Object.keys(config.servers).length;
    }
    return 0;
  }

  private getServerNames(config: Record<string, unknown>): string[] {
    if (config.mcpServers && typeof config.mcpServers === "object") {
      return Object.keys(config.mcpServers).sort();
    }
    if (config.servers && typeof config.servers === "object") {
      if (Array.isArray(config.servers)) {
        return (config.servers as { name?: string }[])
          .map((s) => s.name ?? "")
          .filter(Boolean)
          .sort();
      }
      return Object.keys(config.servers).sort();
    }
    return [];
  }

  private getServerNamesFromContent(content: string, format: "json" | "toml"): string[] {
    try {
      if (content === "(file not found)") {
        return [];
      }
      const config: Record<string, unknown> =
        format === "json" ? (JSON.parse(content) as Record<string, unknown>) : {};
      return this.getServerNames(config);
    } catch {
      return [];
    }
  }

  private hashContent(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
  }

  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  private getTimestamp(): string {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  }

  private findRegistryPath(): string | undefined {
    const locations = [
      path.join(this.homeDir, ".config", "loom", "registry.yaml"),
      path.join(this.workspaceRoot, "mcp", "context", "registry.yaml"),
      path.join(this.workspaceRoot, ".loom", "registry.yaml"),
    ];

    for (const loc of locations) {
      if (fs.existsSync(loc)) {
        return loc;
      }
    }
    return undefined;
  }
}
