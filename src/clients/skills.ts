import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";
import { parse as parseYaml } from "yaml";

import { SkillDefinition, SkillsRegistry } from "../types";

/**
 * Client for loading and watching skills-registry.yaml.
 * Provides access to skill definitions with file watching for live updates.
 */
export class SkillsClient {
  private readonly channel: vscode.OutputChannel;
  private registryPath: string | undefined;
  private cachedRegistry: SkillsRegistry | null = null;
  private watcher: fs.FSWatcher | null = null;
  private readonly emitter = new vscode.EventEmitter<SkillsRegistry | null>();
  readonly onDidChange = this.emitter.event;

  constructor(channel: vscode.OutputChannel) {
    this.channel = channel;
  }

  /**
   * Initialize the client with a registry path.
   * If not provided, searches default locations.
   */
  initialize(workspaceRoot: string, customPath?: string): void {
    this.registryPath = customPath ?? this.findRegistryPath(workspaceRoot);

    if (this.registryPath) {
      this.channel.appendLine(
        `[${new Date().toISOString()}] Skills registry found: ${this.registryPath}`
      );
      this.loadRegistry();
      this.startWatcher();
    } else {
      this.channel.appendLine(
        `[${new Date().toISOString()}] Skills registry not found in workspace`
      );
    }
  }

  /**
   * Find skills-registry.yaml in standard locations.
   */
  private findRegistryPath(workspaceRoot: string): string | undefined {
    const candidates = [
      // Configured path from settings
      vscode.workspace.getConfiguration("loom").get<string>("skillsRegistryPath"),
      // Workspace relative paths
      path.join(workspaceRoot, "platform/gitops/mcp/context/skills-registry.yaml"),
      path.join(workspaceRoot, "mcp/context/skills-registry.yaml"),
      path.join(workspaceRoot, ".loom/skills-registry.yaml"),
      path.join(workspaceRoot, "skills-registry.yaml"),
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      const fullPath = path.isAbsolute(candidate) ? candidate : path.join(workspaceRoot, candidate);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }

    return undefined;
  }

  /**
   * Load the skills registry from disk.
   */
  private loadRegistry(): void {
    if (!this.registryPath || !fs.existsSync(this.registryPath)) {
      this.cachedRegistry = null;
      this.emitter.fire(null);
      return;
    }

    try {
      const content = fs.readFileSync(this.registryPath, "utf-8");
      const parsed = parseYaml(content) as SkillsRegistry;
      this.cachedRegistry = parsed;
      this.channel.appendLine(
        `[${new Date().toISOString()}] Loaded ${parsed.skills?.length ?? 0} skills from registry`
      );
      this.emitter.fire(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(
        `[${new Date().toISOString()}] Error loading skills registry: ${message}`
      );
      this.cachedRegistry = null;
      this.emitter.fire(null);
    }
  }

  /**
   * Start watching the registry file for changes.
   */
  private startWatcher(): void {
    if (!this.registryPath) return;

    this.stopWatcher();

    try {
      let debounceTimer: NodeJS.Timeout | undefined;
      this.watcher = fs.watch(this.registryPath, (_eventType) => {
        // Debounce to avoid multiple reloads
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
          this.channel.appendLine(
            `[${new Date().toISOString()}] Skills registry changed, reloading...`
          );
          this.loadRegistry();
        }, 500);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(
        `[${new Date().toISOString()}] Error watching skills registry: ${message}`
      );
    }
  }

  /**
   * Stop watching the registry file.
   */
  private stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Get the cached registry or reload if needed.
   */
  getRegistry(): SkillsRegistry | null {
    return this.cachedRegistry;
  }

  /**
   * Get all skills.
   */
  getSkills(): SkillDefinition[] {
    return this.cachedRegistry?.skills ?? [];
  }

  /**
   * Get a skill by name.
   */
  getSkill(name: string): SkillDefinition | undefined {
    return this.cachedRegistry?.skills?.find((s) => s.name === name);
  }

  /**
   * Get skills by category.
   */
  getSkillsByCategory(category: string): SkillDefinition[] {
    return this.cachedRegistry?.skills?.filter((s) => s.categories?.includes(category)) ?? [];
  }

  /**
   * Get all unique categories.
   */
  getCategories(): string[] {
    const categories = new Set<string>();
    for (const skill of this.cachedRegistry?.skills ?? []) {
      for (const cat of skill.categories ?? []) {
        categories.add(cat);
      }
    }
    return Array.from(categories).sort();
  }

  /**
   * Search skills by query (matches name, description, categories).
   */
  searchSkills(query: string): SkillDefinition[] {
    const lowerQuery = query.toLowerCase();
    return (
      this.cachedRegistry?.skills?.filter((skill) => {
        const nameMatch = skill.name.toLowerCase().includes(lowerQuery);
        const descMatch = skill.common?.description?.toLowerCase().includes(lowerQuery);
        const catMatch = skill.categories?.some((c) => c.toLowerCase().includes(lowerQuery));
        return nameMatch || descMatch || catMatch;
      }) ?? []
    );
  }

  /**
   * Get the path to a skill's script.
   */
  getScriptPath(skillName: string, scriptName: string): string | undefined {
    const skill = this.getSkill(skillName);
    if (!skill || !this.registryPath) return undefined;

    const script = skill.common?.scripts?.find((s) => s.name === scriptName);
    if (!script) return undefined;

    // Scripts are stored relative to mcp/skills/<skill-name>/
    const registryDir = path.dirname(this.registryPath);
    const skillDir = path.join(registryDir, "..", "skills", skillName);
    return path.join(skillDir, script.path);
  }

  /**
   * Refresh the registry from disk.
   */
  refresh(): void {
    this.loadRegistry();
  }

  /**
   * Dispose resources.
   */
  dispose(): void {
    this.stopWatcher();
    this.emitter.dispose();
  }
}
