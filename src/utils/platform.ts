import * as vscode from "vscode";

/**
 * Supported platform types for MCP configuration.
 */
export type PlatformType = "vscode" | "antigravity" | "gemini" | "codex" | "kilocode" | "claude";

/**
 * Platform metadata and configuration paths.
 */
export interface PlatformInfo {
  type: PlatformType;
  displayName: string;
  configFormat: "json" | "toml";
  repoConfigPath: string; // Relative to workspace root
  homeConfigPath: string; // Relative to home directory
  icon: string; // VS Code ThemeIcon name
  description: string;
}

/**
 * Platform registry with configuration details for each supported platform.
 */
export const PLATFORMS: Record<PlatformType, PlatformInfo> = {
  vscode: {
    type: "vscode",
    displayName: "VS Code",
    configFormat: "json",
    repoConfigPath: ".vscode/mcp.json",
    homeConfigPath: ".vscode/mcp.json",
    icon: "code",
    description: "Visual Studio Code MCP extension",
  },
  antigravity: {
    type: "antigravity",
    displayName: "Antigravity",
    configFormat: "json",
    repoConfigPath: ".antigravity/mcp.json",
    homeConfigPath: ".antigravity/mcp.json",
    icon: "rocket",
    description: "Antigravity (Google's VS Code fork with Gemini/Claude)",
  },
  gemini: {
    type: "gemini",
    displayName: "Gemini",
    configFormat: "toml",
    repoConfigPath: ".gemini/settings.json",
    homeConfigPath: ".gemini/settings.json",
    icon: "sparkle",
    description: "Google Gemini CLI assistant",
  },
  codex: {
    type: "codex",
    displayName: "Codex",
    configFormat: "json",
    repoConfigPath: ".codex/mcp.json",
    homeConfigPath: ".codex/mcp.json",
    icon: "hubot",
    description: "OpenAI Codex CLI assistant",
  },
  kilocode: {
    type: "kilocode",
    displayName: "Kilocode",
    configFormat: "json",
    repoConfigPath: ".kilocode/mcp.json",
    homeConfigPath: ".kilocode/mcp.json",
    icon: "terminal",
    description: "Kilocode VS Code extension",
  },
  claude: {
    type: "claude",
    displayName: "Claude",
    configFormat: "json",
    repoConfigPath: ".claude/mcp.json",
    homeConfigPath: ".claude/mcp.json",
    icon: "comment-discussion",
    description: "Claude Code CLI assistant",
  },
};

/**
 * Detect the current IDE platform.
 *
 * Detection strategy:
 * 1. Check vscode.env.appName for "Antigravity" or "Windsurf"
 * 2. Check process.env for Antigravity-specific markers
 * 3. Check loom.platform configuration setting
 * 4. Fallback to "vscode"
 */
export function detectPlatform(): PlatformType {
  // Check configuration override first
  const configPlatform = vscode.workspace.getConfiguration("loom").get<string>("platform");

  if (configPlatform && configPlatform !== "auto") {
    if (isValidPlatformType(configPlatform)) {
      return configPlatform;
    }
  }

  // Check app name for Antigravity detection
  const appName = vscode.env.appName.toLowerCase();
  if (appName.includes("antigravity") || appName.includes("windsurf")) {
    return "antigravity";
  }

  // Check environment variables for Antigravity
  if (process.env.ANTIGRAVITY_HOME || process.env.WINDSURF_HOME || process.env.GOOGLE_AI_STUDIO) {
    return "antigravity";
  }

  // Default to VS Code
  return "vscode";
}

/**
 * Get information about the current platform.
 */
export function getCurrentPlatformInfo(): PlatformInfo {
  return PLATFORMS[detectPlatform()];
}

/**
 * Get information about a specific platform.
 */
export function getPlatformInfo(platform: PlatformType): PlatformInfo {
  return PLATFORMS[platform];
}

/**
 * Get all supported platform types.
 */
export function getSupportedPlatforms(): PlatformType[] {
  return Object.keys(PLATFORMS) as PlatformType[];
}

/**
 * Get platforms enabled in configuration.
 */
export function getEnabledPlatforms(): PlatformType[] {
  const enabled = vscode.workspace.getConfiguration("loom").get<string[]>("enabledPlatforms");

  if (!enabled || enabled.length === 0) {
    // Default to vscode, antigravity, gemini, claude if not specified
    return ["vscode", "antigravity", "gemini", "claude"];
  }

  return enabled.filter(isValidPlatformType);
}

/**
 * Check if a string is a valid platform type.
 */
export function isValidPlatformType(value: string): value is PlatformType {
  return Object.keys(PLATFORMS).includes(value);
}

/**
 * Get display text for platform status bar.
 */
export function getPlatformStatusText(): string {
  const platform = detectPlatform();
  const info = PLATFORMS[platform];
  return info.displayName;
}

/**
 * Check if running in an Antigravity-compatible environment.
 */
export function isAntigravityCompatible(): boolean {
  const platform = detectPlatform();
  return platform === "antigravity" || platform === "vscode";
}
