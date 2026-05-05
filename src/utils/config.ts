import * as fs from "fs";
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";

import * as vscode from "vscode";
import { parse as parseYaml } from "yaml";

import { DEFAULT_HUB_URL } from "../constants";
import { DaemonConfig, HubSettings, VscodeConfigSnapshot } from "../types";

/**
 * Derive hub settings from VS Code configuration and environment variables.
 */
export function deriveHubSettings(): HubSettings {
  const configuration = vscode.workspace.getConfiguration("loom");
  const fileSettings = readHubSettingsFromConfig();
  const configuredUrl = configuration.get<string>("hubUrl")?.trim();
  const configuredProfile = configuration.get<string>("hubProfile")?.trim();
  const hubUrl = configuredUrl || process.env.MCP_HUB_URL || fileSettings.hubUrl || DEFAULT_HUB_URL;
  const profile = configuredProfile || process.env.MCP_PROFILE || fileSettings.profile || "codex";
  const httpBaseUrl = convertHubUrlToHttpBase(hubUrl);
  const cfAccessClientId =
    process.env.CF_ACCESS_CLIENT_ID ||
    process.env.CF_Access_Client_Id ||
    fileSettings.cfAccessClientId ||
    undefined;
  const cfAccessClientSecret =
    process.env.CF_ACCESS_CLIENT_SECRET ||
    process.env.CF_Access_ClientSecret ||
    fileSettings.cfAccessClientSecret ||
    undefined;

  return {
    hubUrl,
    httpBaseUrl,
    profile,
    cfAccessClientId,
    cfAccessClientSecret,
  };
}

function readHubSettingsFromConfig(): Partial<HubSettings> {
  const configPath = path.join(os.homedir(), ".config", "loom", "config.yaml");

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as {
      hub?: {
        url?: unknown;
        profile?: unknown;
        cf_access_client_id?: unknown;
        cf_access_client_secret?: unknown;
      };
    } | null;
    const hub = parsed?.hub;

    return {
      hubUrl: typeof hub?.url === "string" ? hub.url.trim() : undefined,
      profile: typeof hub?.profile === "string" ? hub.profile.trim() : undefined,
      cfAccessClientId:
        typeof hub?.cf_access_client_id === "string" ? hub.cf_access_client_id.trim() : undefined,
      cfAccessClientSecret:
        typeof hub?.cf_access_client_secret === "string"
          ? hub.cf_access_client_secret.trim()
          : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Convert a WebSocket URL to its HTTP equivalent.
 */
export function convertHubUrlToHttpBase(urlText: string): string | undefined {
  if (!urlText) {
    return undefined;
  }
  try {
    const normalized =
      urlText.startsWith("ws") || urlText.startsWith("http") ? urlText : `wss://${urlText}`;
    const parsed = new URL(normalized);
    let protocol = parsed.protocol;
    if (protocol === "wss:") {
      protocol = "https:";
    } else if (protocol === "ws:") {
      protocol = "http:";
    }
    return `${protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

/**
 * Settings for the Mills HUD client and refresh cadence, derived from VS Code config.
 */
export interface MillsConfig {
  hudBaseUrl: string;
  refreshIntervalMs: number;
  alertingIntervalMs: number;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

/**
 * Derive Mills settings from VS Code configuration.
 * CF Access credentials are reused from the same env vars as the hub.
 */
export function deriveMillsConfig(): MillsConfig {
  const configuration = vscode.workspace.getConfiguration("loom.mills");
  const hudBaseUrl = (configuration.get<string>("hudBaseUrl") ?? "").trim();
  const refreshIntervalMs = configuration.get<number>("refreshIntervalMs") ?? 60_000;
  const alertingIntervalMs = configuration.get<number>("alertingIntervalMs") ?? 120_000;
  const cfAccessClientId =
    process.env.CF_ACCESS_CLIENT_ID || process.env.CF_Access_Client_Id || undefined;
  const cfAccessClientSecret =
    process.env.CF_ACCESS_CLIENT_SECRET || process.env.CF_Access_ClientSecret || undefined;
  return {
    hudBaseUrl,
    refreshIntervalMs,
    alertingIntervalMs,
    cfAccessClientId,
    cfAccessClientSecret,
  };
}

/**
 * Write the daemon configuration file.
 */
export async function writeDaemonConfig(settings: HubSettings): Promise<void> {
  const configDir = path.join(os.homedir(), ".config", "loom");
  const configPath = path.join(configDir, "config.yaml");

  // Read existing config to preserve repo_root if set
  let existingRepoRoot: string | undefined;
  try {
    const existingContent = await fsp.readFile(configPath, "utf-8");
    const repoRootMatch = existingContent.match(/^repo_root:\s*(.+)$/m);
    if (repoRootMatch) {
      existingRepoRoot = repoRootMatch[1]?.trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // File doesn't exist yet, that's fine
  }

  const config: DaemonConfig = {
    repo_root: existingRepoRoot,
    hub: {
      url: settings.hubUrl,
      enabled: true,
      profile: settings.profile,
    },
    debug: false,
  };

  if (settings.cfAccessClientId) {
    config.hub.cf_access_client_id = settings.cfAccessClientId;
  }
  if (settings.cfAccessClientSecret) {
    config.hub.cf_access_client_secret = settings.cfAccessClientSecret;
  }

  try {
    await fsp.mkdir(configDir, { recursive: true });
    const repoRootLine = config.repo_root
      ? `# Workspace root for resolving \${repo} in registry.yaml\nrepo_root: ${config.repo_root}\n\n`
      : "";
    const yaml = `# Loom daemon configuration
# This file is managed by the Loom VS Code extension
# Changes will be applied on next daemon restart

${repoRootLine}hub:
  url: "${config.hub.url}"
  enabled: ${config.hub.enabled}
  profile: "${config.hub.profile}"
${config.hub.cf_access_client_id ? `  cf_access_client_id: "${config.hub.cf_access_client_id}"` : ""}
${config.hub.cf_access_client_secret ? `  cf_access_client_secret: "${config.hub.cf_access_client_secret}"` : ""}

debug: ${config.debug}
`;
    await fsp.writeFile(configPath, yaml, "utf-8");
  } catch {
    // Silently fail - daemon config is best-effort
  }
}

/**
 * Find the registry.yaml file, checking home directory first, then workspace.
 */
export function findRegistryPath(workspaceRoot: string): string | null {
  const candidates = [
    path.join(os.homedir(), ".config", "loom", "registry.yaml"),
    path.join(workspaceRoot, "mcp", "context", "registry.yaml"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Watch the registry.yaml file for changes.
 */
export function watchRegistry(
  root: string,
  registryPath: string,
  onChange: () => void
): fs.FSWatcher | undefined {
  if (!root || !registryPath) {
    return undefined;
  }
  try {
    return fs.watch(registryPath, { persistent: false }, () => onChange());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      void vscode.window.showErrorMessage(
        `Failed to watch registry.yaml: ${(error as Error).message}`
      );
    }
    return undefined;
  }
}

/**
 * Check if a server configuration is hub-routed (via mcp-hub-wrapper or WebSocket).
 */
export function isHubRoutedConfig(config: Record<string, unknown>): boolean {
  const command = typeof config.command === "string" ? config.command : "";
  const args = Array.isArray(config.args) ? (config.args as unknown[]) : [];
  const joined = [
    command,
    ...args.filter((value: unknown) => typeof value === "string").map((value) => String(value)),
  ].join(" ");
  if (joined.includes("mcp-hub-wrapper") || joined.includes("mcp-ws-adapter")) {
    return true;
  }
  const type = typeof config.type === "string" ? config.type.toLowerCase() : "";
  return type === "websocket";
}

/**
 * Load VS Code MCP configuration snapshot from workspace.
 */
export async function loadVscodeConfigSnapshot(
  workspaceRoot: string
): Promise<VscodeConfigSnapshot | null> {
  if (!workspaceRoot) {
    return null;
  }
  const candidates = [
    path.join(workspaceRoot, ".vscode", "mcp.json"),
    path.join(workspaceRoot, ".vscode-mcp", "mcp.json"),
  ];

  for (const candidate of candidates) {
    try {
      const raw = await fsp.readFile(candidate, "utf-8");
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, Record<string, unknown>> };
      const servers =
        parsed.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : {};
      const hubRouted: string[] = [];
      const localRouted: string[] = [];
      const serverNames: string[] = [];

      for (const [name, serverConfig] of Object.entries(servers)) {
        serverNames.push(name);
        if (isHubRoutedConfig(serverConfig)) {
          hubRouted.push(name);
        } else {
          localRouted.push(name);
        }
      }

      return {
        source: candidate,
        serverNames,
        hubRouted,
        localRouted,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      // Silently skip parse errors
    }
  }

  return null;
}
