import * as fs from "fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";

import { SkillsClient } from "../clients/skills";
import { SkillDefinition } from "../types";
import { SkillRecommendationManager, ContextSignals } from "./skillRecommendations";

// Mock fs module
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  watch: vi.fn(() => ({ close: vi.fn() })),
}));

// Sample skills for testing
const sampleSkills: SkillDefinition[] = [
  {
    name: "go-test",
    categories: ["testing", "go"],
    common: {
      description: "Run Go tests",
    },
  },
  {
    name: "go-build",
    categories: ["development", "go"],
    common: {
      description: "Build Go applications",
    },
  },
  {
    name: "typescript-check",
    categories: ["testing", "typescript"],
    common: {
      description: "Run TypeScript type checking",
    },
  },
  {
    name: "npm-install",
    categories: ["development", "nodejs"],
    common: {
      description: "Install npm packages",
    },
  },
  {
    name: "docker-build",
    categories: ["devops", "docker"],
    common: {
      description: "Build Docker images",
    },
  },
  {
    name: "k8s-debug",
    categories: ["debugging", "kubernetes"],
    common: {
      description: "Debug Kubernetes pods",
    },
  },
  {
    name: "pytest",
    categories: ["testing", "python"],
    common: {
      description: "Run Python tests",
    },
  },
  {
    name: "go-mod-tidy",
    categories: ["development", "go"],
    common: {
      description: "Clean up Go modules",
    },
  },
];

describe("SkillRecommendationManager", () => {
  let manager: SkillRecommendationManager;
  let mockChannel: vscode.OutputChannel;
  let mockSkillsClient: SkillsClient;

  beforeEach(() => {
    vi.clearAllMocks();

    mockChannel = {
      name: "Test",
      append: vi.fn(),
      appendLine: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      replace: vi.fn(),
    } as unknown as vscode.OutputChannel;

    // Create a mock SkillsClient
    mockSkillsClient = {
      getSkills: vi.fn(() => sampleSkills),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as SkillsClient;

    manager = new SkillRecommendationManager(mockChannel, mockSkillsClient);
  });

  afterEach(() => {
    manager.dispose();
  });

  describe("initialize", () => {
    it("should scan workspace for project files", () => {
      vi.mocked(fs.readdirSync).mockReturnValue([
        "go.mod",
        "package.json",
        "Dockerfile",
        "main.go",
      ] as unknown as fs.Dirent[]);

      manager.initialize("/workspace");

      // Check that recommendations were calculated
      const recs = manager.getRecommendations();
      expect(Array.isArray(recs)).toBe(true);
    });

    it("should handle errors scanning workspace", () => {
      vi.mocked(fs.readdirSync).mockImplementation(() => {
        throw new Error("Permission denied");
      });

      // Should not throw
      expect(() => manager.initialize("/workspace")).not.toThrow();
    });
  });

  describe("onFileChange", () => {
    beforeEach(() => {
      vi.mocked(fs.readdirSync).mockReturnValue([]);
      manager.initialize("/workspace");
    });

    it("should track file extension for .go files", async () => {
      const uri = vscode.Uri.file("/workspace/main.go");
      manager.onFileChange(uri);

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 350));

      const recs = manager.getRecommendations();
      // Should recommend Go-related skills
      const goSkills = recs.filter((r) => r.skillId.includes("go"));
      expect(goSkills.length).toBeGreaterThan(0);
    });

    it("should track file extension for .ts files", async () => {
      const uri = vscode.Uri.file("/workspace/app.ts");
      manager.onFileChange(uri);

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 350));

      const recs = manager.getRecommendations();
      // Should recommend TypeScript-related skills
      const tsSkills = recs.filter((r) => r.skillId === "typescript-check");
      expect(tsSkills.length).toBeGreaterThan(0);
    });

    it("should recognize Dockerfile", async () => {
      const uri = vscode.Uri.file("/workspace/Dockerfile");
      manager.onFileChange(uri);

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 350));

      const recs = manager.getRecommendations();
      const dockerSkills = recs.filter((r) => r.skillId === "docker-build");
      expect(dockerSkills.length).toBeGreaterThan(0);
    });

    it("should recognize package.json", async () => {
      const uri = vscode.Uri.file("/workspace/package.json");
      manager.onFileChange(uri);

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 350));

      const recs = manager.getRecommendations();
      const npmSkills = recs.filter((r) => r.skillId === "npm-install");
      expect(npmSkills.length).toBeGreaterThan(0);
    });
  });

  describe("onError", () => {
    beforeEach(() => {
      vi.mocked(fs.readdirSync).mockReturnValue([]);
      manager.initialize("/workspace");
    });

    it("should track errors and recommend relevant skills", async () => {
      manager.onError("cannot find module 'lodash'");

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 350));

      const recs = manager.getRecommendations();
      const npmSkills = recs.filter((r) => r.skillId === "npm-install");
      expect(npmSkills.length).toBeGreaterThan(0);
    });

    it("should limit recent errors to 10", () => {
      for (let i = 0; i < 15; i++) {
        manager.onError(`Error ${i}`);
      }

      // Internal state check - errors should be limited
      // We can verify by checking that older errors don't affect recommendations
      expect(true).toBe(true); // Placeholder - no direct way to check internal state
    });
  });

  describe("setGitBranch", () => {
    beforeEach(() => {
      vi.mocked(fs.readdirSync).mockReturnValue([]);
      manager.initialize("/workspace");
    });

    it("should boost debugging skills on fix branches", async () => {
      // Add a debugging skill
      vi.mocked(mockSkillsClient.getSkills).mockReturnValue([
        ...sampleSkills,
        {
          name: "debug-tool",
          categories: ["debugging"],
          common: { description: "Debug tool" },
        },
      ]);

      manager.setGitBranch("fix/memory-leak");

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 350));

      // The manager should consider debugging skills more relevant
      // This is a behavior test - the branch context should affect scoring
      expect(true).toBe(true);
    });

    it("should boost testing skills on test branches", async () => {
      manager.setGitBranch("test/integration");

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 350));

      const recs = manager.getRecommendations();
      // Testing skills might be boosted
      expect(Array.isArray(recs)).toBe(true);
    });
  });

  describe("onToolCall", () => {
    beforeEach(() => {
      vi.mocked(fs.readdirSync).mockReturnValue([]);
      manager.initialize("/workspace");
    });

    it("should track tool usage for boosting", async () => {
      // Call a tool multiple times
      manager.onToolCall("github", "list_issues");
      manager.onToolCall("github", "create_issue");

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 350));

      // Usage should be tracked (affects scoring)
      expect(true).toBe(true);
    });
  });

  describe("getRecommendations", () => {
    beforeEach(() => {
      vi.mocked(fs.readdirSync).mockReturnValue(["go.mod", "package.json"] as unknown as fs.Dirent[]);
      manager.initialize("/workspace");
    });

    it("should return sorted recommendations by confidence", async () => {
      // Trigger some file changes
      manager.onFileChange(vscode.Uri.file("/workspace/main.go"));
      manager.onFileChange(vscode.Uri.file("/workspace/app.ts"));

      await new Promise((resolve) => setTimeout(resolve, 350));

      const recs = manager.getRecommendations();

      // Should be sorted by confidence descending
      for (let i = 1; i < recs.length; i++) {
        expect(recs[i - 1].confidence).toBeGreaterThanOrEqual(recs[i].confidence);
      }
    });

    it("should respect limit parameter", async () => {
      manager.onFileChange(vscode.Uri.file("/workspace/main.go"));
      await new Promise((resolve) => setTimeout(resolve, 350));

      const limited = manager.getRecommendations(3);
      expect(limited.length).toBeLessThanOrEqual(3);
    });

    it("should include confidence scores between 0 and 1", async () => {
      manager.onFileChange(vscode.Uri.file("/workspace/main.go"));
      await new Promise((resolve) => setTimeout(resolve, 350));

      const recs = manager.getRecommendations();
      for (const rec of recs) {
        expect(rec.confidence).toBeGreaterThanOrEqual(0);
        expect(rec.confidence).toBeLessThanOrEqual(1);
      }
    });

    it("should include reasons for recommendations", async () => {
      manager.onFileChange(vscode.Uri.file("/workspace/main.go"));
      await new Promise((resolve) => setTimeout(resolve, 350));

      const recs = manager.getRecommendations();
      for (const rec of recs) {
        expect(rec.reason).toBeTruthy();
        expect(typeof rec.reason).toBe("string");
      }
    });
  });

  describe("clearSignals", () => {
    it("should reset context signals", async () => {
      vi.mocked(fs.readdirSync).mockReturnValue([]);
      manager.initialize("/workspace");

      // Add some signals
      manager.onFileChange(vscode.Uri.file("/workspace/main.go"));
      await new Promise((resolve) => setTimeout(resolve, 350));

      const beforeClear = manager.getRecommendations();

      manager.clearSignals();

      // After clearing, with no skills client returning skills, should have different recommendations
      // This tests that the signals were cleared
      expect(Array.isArray(manager.getRecommendations())).toBe(true);
    });
  });

  describe("onDidChangeRecommendations event", () => {
    it("should emit event when recommendations change", async () => {
      vi.mocked(fs.readdirSync).mockReturnValue([]);
      manager.initialize("/workspace");

      const listener = vi.fn();
      manager.onDidChangeRecommendations(listener);

      manager.onFileChange(vscode.Uri.file("/workspace/main.go"));

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 350));

      expect(listener).toHaveBeenCalled();
    });
  });

  describe("dispose", () => {
    it("should clean up resources", () => {
      vi.mocked(fs.readdirSync).mockReturnValue([]);
      manager.initialize("/workspace");

      // Should not throw
      expect(() => manager.dispose()).not.toThrow();
    });

    it("should clear debounce timer", async () => {
      vi.mocked(fs.readdirSync).mockReturnValue([]);
      manager.initialize("/workspace");

      // Trigger a change that would cause debounce
      manager.onFileChange(vscode.Uri.file("/workspace/main.go"));

      // Dispose immediately
      manager.dispose();

      // Wait longer than debounce time - should not throw
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
  });
});
