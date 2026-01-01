import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";

// Cache for secrets loaded from env file
let secretsCache: Record<string, string> | null = null;

/**
 * Clear the secrets cache, forcing reload on next access.
 */
export function clearSecretsCache(): void {
  secretsCache = null;
}

/**
 * Load secrets from the ai.env file in ~/.config/secrets/.
 */
export async function loadSecretsFromEnvFile(): Promise<Record<string, string>> {
  if (secretsCache !== null) {
    return secretsCache;
  }

  secretsCache = {};
  const envFilePath = path.join(os.homedir(), ".config", "secrets", "ai.env");

  try {
    const content = await fsp.readFile(envFilePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      // Handle "export VAR=value" or "VAR=value"
      const match = trimmed.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?$/i);
      if (match) {
        secretsCache[match[1]] = match[2];
      }
    }
  } catch {
    // File doesn't exist or can't be read, that's fine
  }

  return secretsCache;
}

/**
 * Check if a value is a placeholder that needs resolution.
 */
export function isPlaceholder(value: string): boolean {
  return /^\$\{(keychain|env):[^}]+}$/.test(value);
}

/**
 * Resolve a placeholder value to its actual secret.
 * Supports ${keychain:VAR} and ${env:VAR} syntax.
 */
export async function resolvePlaceholder(value: string): Promise<string | undefined> {
  // Handle ${keychain:VAR} - read from env file instead of keychain
  const keychainMatch = value.match(/^\$\{keychain:([^}]+)}$/);
  if (keychainMatch) {
    const secrets = await loadSecretsFromEnvFile();
    const varName = keychainMatch[1];
    // Try exact match first, then common aliases
    if (secrets[varName]) {
      return secrets[varName];
    }
    // Handle GITLAB_PERSONAL_ACCESS_TOKEN -> GITLAB_PAT alias
    if (varName === "GITLAB_PERSONAL_ACCESS_TOKEN" && secrets["GITLAB_PAT"]) {
      return secrets["GITLAB_PAT"];
    }
    // Handle GRAFANA_API_TOKEN -> GRAFANA_API_KEY alias
    if (varName === "GRAFANA_API_TOKEN" && secrets["GRAFANA_API_KEY"]) {
      return secrets["GRAFANA_API_KEY"];
    }
    // Handle QDRANT_API_KEY and MORPH_QDRANT_API_KEY from MORPH_API_KEY
    if (
      (varName === "QDRANT_API_KEY" || varName === "MORPH_QDRANT_API_KEY") &&
      secrets["MORPH_API_KEY"]
    ) {
      return secrets["MORPH_API_KEY"];
    }
    return undefined;
  }

  // Handle ${env:VAR} or ${env:VAR:-default}
  const envMatch = value.match(/^\$\{env:([^}:]+)(:-([^}]*))?}$/);
  if (envMatch) {
    const envKey = envMatch[1];
    const defaultValue = envMatch[3];
    // Check process.env first
    const envValue = process.env[envKey];
    if (envValue !== undefined) {
      return envValue;
    }
    // Then check secrets file
    const secrets = await loadSecretsFromEnvFile();
    if (secrets[envKey]) {
      return secrets[envKey];
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
  }
  return undefined;
}
