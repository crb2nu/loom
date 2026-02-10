import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";

import { SkillsClient } from "../clients/skills";
import { SkillDefinition } from "../types";
import { Logger } from "../utils/logger";

/**
 * A skill recommendation with confidence score and reason.
 */
export interface SkillRecommendation {
  skillId: string;
  name: string;
  description: string;
  confidence: number; // 0-1
  reason: string; // Human-readable explanation
  triggers: string[]; // What triggered this recommendation
}

/**
 * Context signals gathered from the workspace.
 */
export interface ContextSignals {
  fileExtensions: Set<string>;
  projectFiles: Set<string>; // package.json, go.mod, Dockerfile, etc.
  recentErrors: string[];
  gitBranch?: string;
  workspaceRoot: string;
}

// File extension to skill mappings
const FILE_EXTENSION_SKILLS: Record<string, string[]> = {
  // Go
  ".go": ["go-test", "go-build", "golangci-lint", "go-mod"],
  ".mod": ["go-mod"],

  // TypeScript/JavaScript
  ".ts": ["typescript-check", "eslint", "vitest", "npm-scripts"],
  ".tsx": ["react-components", "typescript-check", "eslint"],
  ".js": ["eslint", "npm-scripts"],
  ".jsx": ["react-components", "eslint"],

  // Python
  ".py": ["pytest", "mypy", "ruff", "python-venv"],
  ".pyi": ["mypy"],

  // Rust
  ".rs": ["cargo-test", "clippy", "cargo-build"],
  ".toml": ["cargo"],

  // GDScript (Godot)
  ".gd": ["godot-lint", "godot-run", "godot-export"],
  ".tscn": ["godot"],
  ".tres": ["godot"],

  // Shell
  ".sh": ["shellcheck", "bash"],
  ".bash": ["shellcheck", "bash"],

  // Config/Infrastructure
  ".yaml": ["k8s-validate", "helm-lint", "yaml-lint"],
  ".yml": ["k8s-validate", "helm-lint", "yaml-lint"],
  ".json": ["json-schema", "json-lint"],
  ".tf": ["terraform-validate", "terraform-plan"],
  ".hcl": ["terraform"],

  // Markdown/Docs
  ".md": ["markdown-lint", "docs"],

  // Docker
  Dockerfile: ["docker-build", "docker-lint", "hadolint"],
};

// Project file to skill mappings
const PROJECT_FILE_SKILLS: Record<string, string[]> = {
  "package.json": ["npm-scripts", "pnpm", "npm-install"],
  "pnpm-lock.yaml": ["pnpm"],
  "yarn.lock": ["yarn"],
  "go.mod": ["go-mod-tidy", "go-test", "go-build"],
  "go.sum": ["go-mod"],
  "Cargo.toml": ["cargo-test", "cargo-build", "clippy"],
  "pyproject.toml": ["pytest", "poetry", "uv"],
  "requirements.txt": ["pip-install", "python-venv"],
  Dockerfile: ["docker-build", "docker-lint"],
  "docker-compose.yml": ["docker-compose"],
  "docker-compose.yaml": ["docker-compose"],
  ".gitlab-ci.yml": ["gitlab-ci", "gitlab-pipelines"],
  ".github": ["github-actions"],
  Makefile: ["make-targets"],
  "kustomization.yaml": ["kustomize", "flux", "k8s-validate"],
  "Chart.yaml": ["helm", "helm-lint"],
  "helmfile.yaml": ["helmfile"],
  "project.godot": ["godot", "godot-export"],
  "tsconfig.json": ["typescript-check"],
  ".eslintrc": ["eslint"],
  ".eslintrc.js": ["eslint"],
  ".eslintrc.json": ["eslint"],
  "vitest.config.ts": ["vitest"],
  "jest.config.js": ["jest"],
  "pytest.ini": ["pytest"],
  "setup.py": ["python-build"],
  "flake.nix": ["nix"],
  "shell.nix": ["nix"],
  ".envrc": ["direnv"],
  Procfile: ["heroku"],
  "fly.toml": ["fly-deploy"],
  "vercel.json": ["vercel"],
  "netlify.toml": ["netlify"],
};

// Error pattern to skill mappings
const ERROR_PATTERN_SKILLS: Array<{ pattern: RegExp; skills: string[] }> = [
  { pattern: /cannot find module/i, skills: ["npm-install", "pnpm-install"] },
  { pattern: /module not found/i, skills: ["npm-install", "go-mod-tidy"] },
  { pattern: /undefined:/i, skills: ["typescript-check"] },
  { pattern: /type.*is not assignable/i, skills: ["typescript-check"] },
  { pattern: /connection refused/i, skills: ["port-forward", "k8s-debug", "docker-compose"] },
  { pattern: /permission denied/i, skills: ["chmod", "sudo"] },
  { pattern: /merge conflict/i, skills: ["git-resolve", "git-merge"] },
  { pattern: /CONFLICT/i, skills: ["git-resolve"] },
  { pattern: /build failed/i, skills: ["build-debug"] },
  { pattern: /test failed/i, skills: ["test-debug"] },
  { pattern: /import cycle/i, skills: ["go-build", "go-mod"] },
  { pattern: /cannot find package/i, skills: ["go-mod-tidy"] },
  { pattern: /no such file or directory/i, skills: ["file-search"] },
  { pattern: /ENOENT/i, skills: ["npm-install"] },
  { pattern: /pod.*CrashLoopBackOff/i, skills: ["k8s-debug", "k8s-logs"] },
  { pattern: /ImagePullBackOff/i, skills: ["k8s-debug", "docker-login"] },
  { pattern: /OOMKilled/i, skills: ["k8s-resources"] },
];

/**
 * Manager for context-aware skill recommendations.
 * Analyzes workspace context and suggests relevant skills.
 */
export class SkillRecommendationManager {
  private readonly channel: vscode.OutputChannel;
  private readonly logger: Logger;
  private readonly skillsClient: SkillsClient;
  private contextSignals: ContextSignals;
  private usageHistory: Map<string, number> = new Map();
  private recommendations: SkillRecommendation[] = [];
  private debounceTimer: NodeJS.Timeout | undefined;

  private readonly emitter = new vscode.EventEmitter<SkillRecommendation[]>();
  readonly onDidChangeRecommendations = this.emitter.event;

  constructor(channel: vscode.OutputChannel, skillsClient: SkillsClient) {
    this.channel = channel;
    this.logger = new Logger(channel, "SkillRec");
    this.skillsClient = skillsClient;
    this.contextSignals = {
      fileExtensions: new Set(),
      projectFiles: new Set(),
      recentErrors: [],
      workspaceRoot: "",
    };
  }

  /**
   * Initialize the manager with workspace root.
   */
  initialize(workspaceRoot: string): void {
    this.contextSignals.workspaceRoot = workspaceRoot;
    this.scanWorkspace(workspaceRoot);
    this.recalculateRecommendations();
  }

  /**
   * Scan workspace for project files.
   */
  private scanWorkspace(workspaceRoot: string): void {
    try {
      const entries = fs.readdirSync(workspaceRoot);
      for (const entry of entries) {
        // Check for known project files
        if (PROJECT_FILE_SKILLS[entry]) {
          this.contextSignals.projectFiles.add(entry);
        }
        // Check for .github directory
        if (entry === ".github") {
          this.contextSignals.projectFiles.add(".github");
        }
      }

      this.logger.info(`Scanned workspace, found project files: ${Array.from(this.contextSignals.projectFiles).join(", ")}`);
    } catch {
      // Ignore errors scanning workspace
    }
  }

  /**
   * Handle file change event.
   */
  onFileChange(uri: vscode.Uri): void {
    const ext = path.extname(uri.fsPath);
    const filename = path.basename(uri.fsPath);

    if (ext) {
      this.contextSignals.fileExtensions.add(ext);
    }

    // Check if it's a project file
    if (PROJECT_FILE_SKILLS[filename]) {
      this.contextSignals.projectFiles.add(filename);
    }

    // Special case for Dockerfile (no extension)
    if (filename === "Dockerfile" || filename.startsWith("Dockerfile.")) {
      this.contextSignals.projectFiles.add("Dockerfile");
      this.contextSignals.fileExtensions.add("Dockerfile");
    }

    this.scheduleRecalculation();
  }

  /**
   * Handle tool call for usage tracking.
   */
  onToolCall(server: string, tool: string): void {
    // Track which skills lead to tool usage
    // This helps boost frequently used skills
    const skillId = this.inferSkillFromTool(server, tool);
    if (skillId) {
      const count = this.usageHistory.get(skillId) || 0;
      this.usageHistory.set(skillId, count + 1);
      this.scheduleRecalculation();
    }
  }

  /**
   * Handle error for context-aware recommendations.
   */
  onError(error: string): void {
    this.contextSignals.recentErrors.push(error);
    // Keep only last 10 errors
    if (this.contextSignals.recentErrors.length > 10) {
      this.contextSignals.recentErrors.shift();
    }
    this.scheduleRecalculation();
  }

  /**
   * Set git branch for context.
   */
  setGitBranch(branch: string): void {
    this.contextSignals.gitBranch = branch;
    this.scheduleRecalculation();
  }

  /**
   * Get current recommendations.
   */
  getRecommendations(limit?: number): SkillRecommendation[] {
    const recs = [...this.recommendations];
    return limit ? recs.slice(0, limit) : recs;
  }

  /**
   * Clear context signals (e.g., on workspace change).
   */
  clearSignals(): void {
    this.contextSignals = {
      fileExtensions: new Set(),
      projectFiles: new Set(),
      recentErrors: [],
      workspaceRoot: this.contextSignals.workspaceRoot,
    };
    this.recalculateRecommendations();
  }

  /**
   * Schedule a recalculation with debounce.
   */
  private scheduleRecalculation(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.recalculateRecommendations();
    }, 300);
  }

  /**
   * Recalculate recommendations based on current context.
   */
  private recalculateRecommendations(): void {
    const skills = this.skillsClient.getSkills();
    if (!skills.length) {
      this.recommendations = [];
      this.emitter.fire([]);
      return;
    }

    const scored: Array<{ skill: SkillDefinition; score: number; reasons: string[] }> = [];

    for (const skill of skills) {
      const { score, reasons } = this.scoreSkill(skill);
      if (score >= 0.2) {
        // Minimum threshold
        scored.push({ skill, score, reasons });
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Convert to recommendations
    this.recommendations = scored.slice(0, 10).map(({ skill, score, reasons }) => ({
      skillId: skill.name,
      name: skill.name,
      description: skill.common?.description || "",
      confidence: Math.min(score, 1.0),
      reason: reasons[0] || "Matches workspace context",
      triggers: reasons,
    }));

    this.logger.info(`Updated recommendations: ${this.recommendations.map((r) => `${r.name}(${Math.round(r.confidence * 100)}%)`).join(", ")}`);

    this.emitter.fire(this.recommendations);
  }

  /**
   * Score a skill based on current context signals.
   */
  private scoreSkill(skill: SkillDefinition): { score: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];

    // File extension match: +0.3 each
    for (const ext of this.contextSignals.fileExtensions) {
      const skills = FILE_EXTENSION_SKILLS[ext];
      if (skills?.includes(skill.name)) {
        score += 0.3;
        reasons.push(`Working with ${ext} files`);
      }
    }

    // Project file match: +0.4 each
    for (const file of this.contextSignals.projectFiles) {
      const skills = PROJECT_FILE_SKILLS[file];
      if (skills?.includes(skill.name)) {
        score += 0.4;
        reasons.push(`Project uses ${file}`);
      }
    }

    // Error pattern match: +0.5 (highest priority)
    for (const { pattern, skills } of ERROR_PATTERN_SKILLS) {
      if (skills.includes(skill.name)) {
        for (const error of this.contextSignals.recentErrors) {
          if (pattern.test(error)) {
            score += 0.5;
            reasons.push(`May help with recent error`);
            break;
          }
        }
      }
    }

    // Category match for git branch context
    if (this.contextSignals.gitBranch) {
      const branch = this.contextSignals.gitBranch.toLowerCase();
      if (branch.includes("fix") && skill.categories?.includes("debugging")) {
        score += 0.2;
        reasons.push("Branch suggests debugging work");
      }
      if (branch.includes("feat") && skill.categories?.includes("development")) {
        score += 0.2;
        reasons.push("Branch suggests development work");
      }
      if (branch.includes("test") && skill.categories?.includes("testing")) {
        score += 0.3;
        reasons.push("Branch suggests testing work");
      }
      if (branch.includes("deploy") && skill.categories?.includes("deployment")) {
        score += 0.3;
        reasons.push("Branch suggests deployment work");
      }
    }

    // Usage frequency boost: up to +0.2
    const usageCount = this.usageHistory.get(skill.name) || 0;
    if (usageCount > 0) {
      const usageBoost = Math.min(usageCount * 0.05, 0.2);
      score += usageBoost;
      reasons.push(`Used ${usageCount} time(s) in this session`);
    }

    return { score, reasons };
  }

  /**
   * Infer skill from tool call (for usage tracking).
   */
  private inferSkillFromTool(server: string, _tool: string): string | undefined {
    // Map server names to likely skills
    const serverSkillMap: Record<string, string> = {
      git: "git",
      github: "github",
      gitlab: "gitlab-ci",
      docker: "docker-build",
      k8s: "k8s-validate",
      prometheus: "prometheus",
      loki: "loki",
      grafana: "grafana",
      helm: "helm",
      flux: "flux",
      memory: "memory",
      agent_context: "agent-context",
    };
    return serverSkillMap[server];
  }

  /**
   * Dispose resources.
   */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.emitter.dispose();
  }
}
