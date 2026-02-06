import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";

import { SkillsClient } from "../clients/skills";
import { SkillsProvider } from "../providers/skills";
import { SkillDefinition, PlatformType } from "../types";
import { PLATFORMS, getSupportedPlatforms } from "../utils/platform";

export interface SkillsCommandContext {
  workspaceRoot: string;
  loomChannel: vscode.OutputChannel;
  skillsClient: SkillsClient;
  skillsProvider: SkillsProvider;
}

/**
 * Register skills-related commands.
 */
export function registerSkillsCommands(ctx: SkillsCommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("loom.refreshSkills", () => {
      ctx.skillsProvider.refresh();
      ctx.loomChannel.appendLine(`[${new Date().toISOString()}] Skills registry refreshed`);
    }),

    vscode.commands.registerCommand("loom.searchSkills", async () => {
      const query = await vscode.window.showInputBox({
        prompt: "Search skills by name, description, or category",
        placeHolder: "Enter search query...",
      });

      if (query === undefined) return;

      if (query === "") {
        ctx.skillsProvider.clearFilter();
        vscode.window.showInformationMessage("Skills filter cleared");
      } else {
        ctx.skillsProvider.setFilter(query);
        const results = ctx.skillsClient.searchSkills(query);
        vscode.window.showInformationMessage(
          `Found ${results.length} skill${results.length !== 1 ? "s" : ""} matching "${query}"`
        );
      }
    }),

    vscode.commands.registerCommand("loom.showSkillDetails", async (skillName: string) => {
      const skill = ctx.skillsClient.getSkill(skillName);
      if (!skill) {
        vscode.window.showErrorMessage(`Skill not found: ${skillName}`);
        return;
      }

      // Create a virtual document showing skill details
      const content = formatSkillDetails(skill);
      const doc = await vscode.workspace.openTextDocument({
        content,
        language: "markdown",
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand(
      "loom.runSkillScript",
      (skillName: string, scriptName: string) => {
        const skill = ctx.skillsClient.getSkill(skillName);
        if (!skill) {
          vscode.window.showErrorMessage(`Skill not found: ${skillName}`);
          return;
        }

        const script = skill.common?.scripts?.find((s) => s.name === scriptName);
        if (!script) {
          vscode.window.showErrorMessage(`Script not found: ${scriptName}`);
          return;
        }

        const scriptPath = ctx.skillsClient.getScriptPath(skillName, scriptName);
        if (!scriptPath) {
          vscode.window.showErrorMessage(`Script path not resolved: ${scriptName}`);
          return;
        }

        // Check if script exists
        if (!fs.existsSync(scriptPath)) {
          vscode.window.showErrorMessage(`Script file not found: ${scriptPath}`);
          return;
        }

        // Determine script type and run in terminal
        const terminal = vscode.window.createTerminal({
          name: `Skill: ${script.name}`,
          cwd: ctx.workspaceRoot,
        });

        const ext = path.extname(scriptPath).toLowerCase();
        let command: string;

        switch (ext) {
          case ".py":
            command = `python "${scriptPath}"`;
            break;
          case ".sh":
            command = `bash "${scriptPath}"`;
            break;
          default:
            command = `"${scriptPath}"`;
        }

        terminal.show();
        terminal.sendText(command);

        ctx.loomChannel.appendLine(
          `[${new Date().toISOString()}] Running skill script: ${command}`
        );
      }
    ),

    vscode.commands.registerCommand(
      "loom.openSkillResource",
      async (skillName: string, resourceType: string, resourcePath: string) => {
        // Resolve full path based on registry location and skill name
        const registry = ctx.skillsClient.getRegistry();
        if (!registry) {
          vscode.window.showErrorMessage("Skills registry not loaded");
          return;
        }

        // Get registry directory
        const registryPath = vscode.workspace
          .getConfiguration("loom")
          .get<string>("skillsRegistryPath");

        if (!registryPath) {
          vscode.window.showErrorMessage("Skills registry path not configured");
          return;
        }

        const registryDir = path.dirname(registryPath);
        const skillDir = path.join(registryDir, "..", "skills", skillName);
        const fullPath = path.join(skillDir, resourceType, resourcePath);

        if (!fs.existsSync(fullPath)) {
          vscode.window.showErrorMessage(`Resource not found: ${fullPath}`);
          return;
        }

        const doc = await vscode.workspace.openTextDocument(fullPath);
        await vscode.window.showTextDocument(doc);
      }
    ),

    vscode.commands.registerCommand("loom.listSkillCategories", () => {
      const categories = ctx.skillsClient.getCategories();
      if (categories.length === 0) {
        vscode.window.showInformationMessage("No skill categories found");
        return;
      }

      const content = [
        "# Skill Categories",
        "",
        ...categories.map((cat) => {
          const skills = ctx.skillsClient.getSkillsByCategory(cat);
          return `- **${cat}**: ${skills.map((s) => s.name).join(", ")}`;
        }),
      ].join("\n");

      ctx.loomChannel.appendLine(content);
      ctx.loomChannel.show();
    }),

    vscode.commands.registerCommand("loom.syncSkills", () => {
      const terminal = vscode.window.createTerminal({
        name: "Loom: Sync Skills",
        cwd: ctx.workspaceRoot,
      });
      terminal.show();
      terminal.sendText("loom sync skills all");
      ctx.loomChannel.appendLine(
        `[${new Date().toISOString()}] Running: loom sync skills all`
      );
    }),

    vscode.commands.registerCommand(
      "loom.previewSkillOutput",
      async (skillName: string, platform: string) => {
        const skill = ctx.skillsClient.getSkill(skillName);
        if (!skill) {
          vscode.window.showErrorMessage(`Skill not found: ${skillName}`);
          return;
        }

        const outputType = ctx.skillsClient.getSkillOutputType(skillName, platform);
        const generatedPath = ctx.skillsClient.getGeneratedFilePath(skillName, platform);

        const lines: string[] = [
          `# ${skill.name} — ${platform} (${outputType})`,
          "",
          `**Generated file:** \`${generatedPath ?? "N/A"}\``,
          "",
          `**Type:** ${outputType}`,
          "",
          "---",
          "",
        ];

        // Show a preview of what the generated output would look like
        switch (outputType) {
          case "command":
            lines.push(
              "```markdown",
              "---",
              `description: ${skill.common?.description?.split("\n")[0] ?? ""}`,
              "---",
              "",
              `# ${skill.name}`,
              "",
              skill.common?.instructions?.substring(0, 500) ?? "",
              "...",
              "```"
            );
            break;
          case "rule":
            lines.push(
              "```markdown",
              "<!-- Generated by loom from skills-registry.yaml -->",
              `# ${skill.name}`,
              "",
              skill.common?.instructions?.substring(0, 500) ?? "",
              "...",
              "```"
            );
            break;
          case "workflow":
            lines.push(
              "```yaml",
              "# Generated by loom from skills-registry.yaml",
              "version: 1",
              `name: \"${skill.name}\"`,
              "on:",
              `  slash_command: \"/${skill.name}\"`,
              "steps:",
              "  - id: execute",
              "    prompt:",
              "      content: |",
              "        ...",
              "```"
            );
            break;
          case "instruction":
            lines.push(
              "*(Included in composite instructions.md)*",
              "",
              "```markdown",
              `## ${skill.name}`,
              "",
              skill.common?.instructions?.substring(0, 500) ?? "",
              "...",
              "```"
            );
            break;
          case "skill":
            lines.push(
              "```markdown",
              "---",
              `name: ${skill.name}`,
              `description: \"${skill.common?.description?.split("\n")[0] ?? ""}\"`,
              "---",
              "",
              skill.common?.instructions?.substring(0, 500) ?? "",
              "...",
              "```"
            );
            break;
        }

        const content = lines.join("\n");
        const doc = await vscode.workspace.openTextDocument({
          content,
          language: "markdown",
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    ),

    vscode.commands.registerCommand("loom.filterSkillsByPlatform", async () => {
      const currentFilter = ctx.skillsProvider.getPlatformFilter();
      const platforms = getSupportedPlatforms();

      const picks = [
        {
          label: "All Platforms",
          description: currentFilter === "all" ? "(current)" : "",
          platform: "all" as const,
        },
        ...platforms.map((p) => ({
          label: PLATFORMS[p].displayName,
          description: currentFilter === p ? "(current)" : PLATFORMS[p].description,
          platform: p as PlatformType,
        })),
      ];

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: "Filter skills by target platform",
        title: "Filter Skills by Platform",
      });

      if (!selected) {
        return;
      }

      ctx.skillsProvider.setPlatformFilter(selected.platform);

      if (selected.platform === "all") {
        vscode.window.showInformationMessage("Showing skills for all platforms");
      } else {
        const count = ctx.skillsClient.getSkills().filter((skill) => {
          const targets = skill.targets ?? {};
          const targetConfig = targets[selected.platform];
          return (
            Object.keys(targets).length === 0 || (targetConfig && targetConfig.enabled !== false)
          );
        }).length;

        vscode.window.showInformationMessage(
          `Showing ${count} skills for ${PLATFORMS[selected.platform].displayName}`
        );
      }
    }),
  ];
}

/**
 * Format skill details as Markdown.
 */
function formatSkillDetails(skill: SkillDefinition): string {
  const lines: string[] = [
    `# ${skill.name}`,
    "",
    `**Categories:** ${skill.categories?.join(", ") ?? "none"}`,
    "",
    "## Description",
    "",
    skill.common?.description ?? "No description provided.",
    "",
  ];

  // Instructions
  if (skill.common?.instructions) {
    lines.push("## Instructions", "", skill.common.instructions, "");
  }

  // Scripts
  const scripts = skill.common?.scripts ?? [];
  if (scripts.length > 0) {
    lines.push("## Scripts", "");
    for (const script of scripts) {
      const autoApproved = skill.common?.always_allow?.includes(script.name)
        ? " (auto-approved)"
        : "";
      lines.push(`### ${script.name}${autoApproved}`, "");
      if (script.description) {
        lines.push(script.description, "");
      }
      lines.push(`Path: \`${script.path}\``, "");
    }
  }

  // References
  const references = skill.common?.references ?? [];
  if (references.length > 0) {
    lines.push("## References", "");
    for (const ref of references) {
      lines.push(`- \`${ref}\``);
    }
    lines.push("");
  }

  // Assets
  const assets = skill.common?.assets ?? [];
  if (assets.length > 0) {
    lines.push("## Assets", "");
    for (const asset of assets) {
      lines.push(`- \`${asset}\``);
    }
    lines.push("");
  }

  // Targets
  const targets = skill.targets ?? {};
  const enabledTargets = Object.entries(targets)
    .filter(([, config]) => config.enabled)
    .map(([name]) => name);
  if (enabledTargets.length > 0) {
    lines.push("## Enabled Targets", "");
    lines.push(enabledTargets.join(", "), "");
  }

  return lines.join("\n");
}
