import * as vscode from "vscode";

import { SkillsClient } from "../clients/skills";
import { SkillDefinition, SkillScript, SkillTargetConfig, PlatformType } from "../types";

/**
 * Tree item types for skills hierarchy.
 */
type SkillTreeItemType =
  | "category"
  | "skill"
  | "scripts-group"
  | "script"
  | "references-group"
  | "reference"
  | "assets-group"
  | "asset"
  | "targets-group"
  | "target";

/**
 * Custom TreeItem for skills that tracks item type and metadata.
 */
export class SkillTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: SkillTreeItemType,
    public readonly skill?: SkillDefinition,
    public readonly script?: SkillScript,
    public readonly resourcePath?: string
  ) {
    super(label, collapsibleState);
  }
}

/**
 * Tree data provider for the Loom Skills panel.
 * Shows skills organized by category with scripts, references, and assets.
 */
export class SkillsProvider implements vscode.TreeDataProvider<SkillTreeItem> {
  private readonly skillsClient: SkillsClient;
  private readonly emitter = new vscode.EventEmitter<SkillTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private filterQuery: string = "";
  private platformFilter: PlatformType | "all" = "all";

  constructor(skillsClient: SkillsClient) {
    this.skillsClient = skillsClient;

    // Refresh when registry changes
    skillsClient.onDidChange(() => {
      this.emitter.fire();
    });
  }

  refresh(): void {
    this.skillsClient.refresh();
    this.emitter.fire();
  }

  setFilter(query: string): void {
    this.filterQuery = query.toLowerCase();
    this.emitter.fire();
  }

  clearFilter(): void {
    this.filterQuery = "";
    this.emitter.fire();
  }

  /**
   * Set the platform/target filter.
   */
  setPlatformFilter(platform: PlatformType | "all"): void {
    this.platformFilter = platform;
    this.emitter.fire();
  }

  /**
   * Get the current platform filter.
   */
  getPlatformFilter(): PlatformType | "all" {
    return this.platformFilter;
  }

  /**
   * Clear the platform filter.
   */
  clearPlatformFilter(): void {
    this.platformFilter = "all";
    this.emitter.fire();
  }

  getTreeItem(element: SkillTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SkillTreeItem): SkillTreeItem[] {
    if (!element) {
      // Root level: show categories
      return this.getRootItems();
    }

    switch (element.itemType) {
      case "category":
        return this.getSkillsInCategory(element.label);
      case "skill":
        return this.getSkillChildren(element.skill!);
      case "targets-group":
        return this.getTargetItems(element.skill!);
      case "scripts-group":
        return this.getScriptItems(element.skill!);
      case "references-group":
        return this.getReferenceItems(element.skill!);
      case "assets-group":
        return this.getAssetItems(element.skill!);
      default:
        return [];
    }
  }

  private getRootItems(): SkillTreeItem[] {
    const skills = this.skillsClient.getSkills();

    if (skills.length === 0) {
      const placeholder = new SkillTreeItem(
        "No skills found",
        vscode.TreeItemCollapsibleState.None,
        "category"
      );
      placeholder.iconPath = new vscode.ThemeIcon("info");
      placeholder.description = "Configure loom.skillsRegistryPath";
      return [placeholder];
    }

    // Apply text filter if set
    let filteredSkills = this.filterQuery
      ? this.skillsClient.searchSkills(this.filterQuery)
      : skills;

    // Apply platform filter if set
    if (this.platformFilter !== "all") {
      filteredSkills = filteredSkills.filter((skill) => {
        // Check if skill has this target enabled
        const targets = skill.targets ?? {};
        const targetConfig = targets[this.platformFilter];
        // Include skill if target exists and is enabled, or if no targets defined (assume enabled for all)
        return (
          Object.keys(targets).length === 0 || (targetConfig && targetConfig.enabled !== false)
        );
      });
    }

    if (filteredSkills.length === 0 && this.filterQuery) {
      const noMatch = new SkillTreeItem(
        `No skills match "${this.filterQuery}"`,
        vscode.TreeItemCollapsibleState.None,
        "category"
      );
      noMatch.iconPath = new vscode.ThemeIcon("search-stop");
      return [noMatch];
    }

    if (filteredSkills.length === 0 && this.platformFilter !== "all") {
      const noMatch = new SkillTreeItem(
        `No skills for ${this.platformFilter}`,
        vscode.TreeItemCollapsibleState.None,
        "category"
      );
      noMatch.iconPath = new vscode.ThemeIcon("filter");
      noMatch.description = "Clear filter to show all";
      return [noMatch];
    }

    // Group by category
    const categoryMap = new Map<string, SkillDefinition[]>();
    for (const skill of filteredSkills) {
      for (const category of skill.categories ?? ["uncategorized"]) {
        const existing = categoryMap.get(category) ?? [];
        existing.push(skill);
        categoryMap.set(category, existing);
      }
    }

    // Create category items
    return Array.from(categoryMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, categorySkills]) => {
        const item = new SkillTreeItem(
          category,
          vscode.TreeItemCollapsibleState.Expanded,
          "category"
        );
        item.description = `${categorySkills.length} skill${categorySkills.length !== 1 ? "s" : ""}`;
        item.iconPath = new vscode.ThemeIcon(this.getCategoryIcon(category));
        return item;
      });
  }

  private getSkillsInCategory(category: string): SkillTreeItem[] {
    const skills = this.filterQuery
      ? this.skillsClient
          .searchSkills(this.filterQuery)
          .filter((s) => s.categories?.includes(category))
      : this.skillsClient.getSkillsByCategory(category);

    return skills.map((skill) => {
      const item = new SkillTreeItem(
        skill.name,
        vscode.TreeItemCollapsibleState.Collapsed,
        "skill",
        skill
      );
      item.iconPath = new vscode.ThemeIcon("lightbulb");
      item.tooltip = this.buildSkillTooltip(skill);
      item.command = {
        command: "loom.showSkillDetails",
        title: "Show Skill Details",
        arguments: [skill.name],
      };
      return item;
    });
  }

  private getSkillChildren(skill: SkillDefinition): SkillTreeItem[] {
    const children: SkillTreeItem[] = [];

    // Targets group (platforms)
    const targets = skill.targets ?? {};
    const targetKeys = Object.keys(targets);
    if (targetKeys.length > 0) {
      const targetsItem = new SkillTreeItem(
        "Targets",
        vscode.TreeItemCollapsibleState.Collapsed,
        "targets-group",
        skill
      );
      const enabledCount = targetKeys.filter((k) => targets[k]?.enabled !== false).length;
      targetsItem.description = `${enabledCount}/${targetKeys.length} enabled`;
      targetsItem.iconPath = new vscode.ThemeIcon("layers");
      children.push(targetsItem);
    }

    // Scripts group
    const scripts = skill.common?.scripts ?? [];
    if (scripts.length > 0) {
      const scriptsItem = new SkillTreeItem(
        "Scripts",
        vscode.TreeItemCollapsibleState.Collapsed,
        "scripts-group",
        skill
      );
      scriptsItem.description = `${scripts.length}`;
      scriptsItem.iconPath = new vscode.ThemeIcon("terminal");
      children.push(scriptsItem);
    }

    // References group
    const references = skill.common?.references ?? [];
    if (references.length > 0) {
      const refsItem = new SkillTreeItem(
        "References",
        vscode.TreeItemCollapsibleState.Collapsed,
        "references-group",
        skill
      );
      refsItem.description = `${references.length}`;
      refsItem.iconPath = new vscode.ThemeIcon("book");
      children.push(refsItem);
    }

    // Assets group
    const assets = skill.common?.assets ?? [];
    if (assets.length > 0) {
      const assetsItem = new SkillTreeItem(
        "Assets",
        vscode.TreeItemCollapsibleState.Collapsed,
        "assets-group",
        skill
      );
      assetsItem.description = `${assets.length}`;
      assetsItem.iconPath = new vscode.ThemeIcon("file-directory");
      children.push(assetsItem);
    }

    return children;
  }

  private getTargetItems(skill: SkillDefinition): SkillTreeItem[] {
    const targets = skill.targets ?? {};

    return Object.entries(targets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([targetName, config]) => {
        const isEnabled = config?.enabled !== false;
        const item = new SkillTreeItem(
          targetName,
          vscode.TreeItemCollapsibleState.None,
          "target",
          skill
        );
        item.description = isEnabled ? "enabled" : "disabled";
        item.iconPath = new vscode.ThemeIcon(
          isEnabled ? "check" : "circle-slash",
          isEnabled ? new vscode.ThemeColor("charts.green") : new vscode.ThemeColor("charts.gray")
        );
        item.tooltip = this.buildTargetTooltip(targetName, config);
        item.contextValue = `target-${isEnabled ? "enabled" : "disabled"}`;
        return item;
      });
  }

  private getScriptItems(skill: SkillDefinition): SkillTreeItem[] {
    const scripts = skill.common?.scripts ?? [];
    const alwaysAllow = new Set(skill.common?.always_allow ?? []);

    return scripts.map((script) => {
      const item = new SkillTreeItem(
        script.name,
        vscode.TreeItemCollapsibleState.None,
        "script",
        skill,
        script
      );
      item.description = script.description ?? "";
      item.iconPath = new vscode.ThemeIcon(alwaysAllow.has(script.name) ? "play-circle" : "play");
      item.tooltip = this.buildScriptTooltip(skill, script, alwaysAllow.has(script.name));
      item.command = {
        command: "loom.runSkillScript",
        title: "Run Script",
        arguments: [skill.name, script.name],
      };
      return item;
    });
  }

  private getReferenceItems(skill: SkillDefinition): SkillTreeItem[] {
    const references = skill.common?.references ?? [];

    return references.map((ref) => {
      const item = new SkillTreeItem(
        ref,
        vscode.TreeItemCollapsibleState.None,
        "reference",
        skill,
        undefined,
        ref
      );
      item.iconPath = new vscode.ThemeIcon("file-text");
      item.command = {
        command: "loom.openSkillResource",
        title: "Open Reference",
        arguments: [skill.name, "references", ref],
      };
      return item;
    });
  }

  private getAssetItems(skill: SkillDefinition): SkillTreeItem[] {
    const assets = skill.common?.assets ?? [];

    return assets.map((asset) => {
      const item = new SkillTreeItem(
        asset,
        vscode.TreeItemCollapsibleState.None,
        "asset",
        skill,
        undefined,
        asset
      );
      item.iconPath = new vscode.ThemeIcon("file");
      item.command = {
        command: "loom.openSkillResource",
        title: "Open Asset",
        arguments: [skill.name, "assets", asset],
      };
      return item;
    });
  }

  private getCategoryIcon(category: string): string {
    const iconMap: Record<string, string> = {
      kubernetes: "server",
      gitops: "git-branch",
      operations: "gear",
      mcp: "plug",
      configuration: "settings-gear",
      devops: "rocket",
      planning: "checklist",
      research: "search",
      documentation: "book",
      release: "tag",
      versioning: "versions",
      "ci-cd": "debug-start",
      branding: "paintcan",
      gitlab: "source-control",
      maintenance: "tools",
      memory: "database",
      agents: "robot",
      context: "symbol-interface",
    };
    return iconMap[category] ?? "folder";
  }

  private buildSkillTooltip(skill: SkillDefinition): vscode.MarkdownString {
    const lines: string[] = [
      `**${skill.name}**`,
      "",
      `Categories: ${skill.categories?.join(", ") ?? "none"}`,
      "",
      skill.common?.description ?? "No description",
    ];

    const tooltip = new vscode.MarkdownString(lines.join("\n"));
    tooltip.isTrusted = true;
    return tooltip;
  }

  private buildScriptTooltip(
    skill: SkillDefinition,
    script: SkillScript,
    isAutoApproved: boolean
  ): vscode.MarkdownString {
    const lines: string[] = [
      `**${script.name}**`,
      "",
      script.description ?? "No description",
      "",
      `Path: \`${script.path}\``,
      `Skill: ${skill.name}`,
    ];

    if (isAutoApproved) {
      lines.push("", "**Auto-approved** (in always_allow list)");
    }

    const tooltip = new vscode.MarkdownString(lines.join("\n"));
    tooltip.isTrusted = true;
    return tooltip;
  }

  private buildTargetTooltip(targetName: string, config: SkillTargetConfig): vscode.MarkdownString {
    const lines: string[] = [
      `**Target: ${targetName}**`,
      "",
      `Enabled: ${config?.enabled !== false ? "Yes" : "No"}`,
    ];

    if (config?.output_format) {
      lines.push(`Output Format: ${config.output_format}`);
    }

    const tooltip = new vscode.MarkdownString(lines.join("\n"));
    tooltip.isTrusted = true;
    return tooltip;
  }
}
