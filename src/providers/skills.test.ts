import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

import { SkillsClient } from "../clients/skills";
import { SkillRecommendation, SkillRecommendationManager } from "../managers/skillRecommendations";
import { SkillDefinition } from "../types";

import { SkillsProvider, SkillTreeItem } from "./skills";

// Sample skills for testing
const sampleSkills: SkillDefinition[] = [
  {
    name: "go-test",
    categories: ["testing", "go"],
    common: {
      description: "Run Go tests",
      instructions: "Use this skill to run Go tests",
      scripts: [{ name: "run", path: "scripts/run.sh", description: "Run all tests" }],
      references: ["docs/testing.md"],
      assets: ["templates/test.go.tmpl"],
      always_allow: ["run"],
    },
    targets: {
      claude: { enabled: true },
      vscode: { enabled: true },
    },
  },
  {
    name: "docker-build",
    categories: ["docker", "devops"],
    common: {
      description: "Build Docker images",
      instructions: "",
      scripts: [{ name: "build", path: "scripts/build.sh", description: "" }],
      references: [],
      assets: [],
      always_allow: [],
    },
    targets: {
      claude: { enabled: true },
      vscode: { enabled: false },
    },
  },
  {
    name: "typescript-check",
    categories: ["testing", "typescript"],
    common: {
      description: "Run TypeScript type checking",
      instructions: "",
      scripts: [],
      references: [],
      assets: [],
      always_allow: [],
    },
    targets: {},
  },
];

// Sample recommendations for testing
const sampleRecommendations: SkillRecommendation[] = [
  {
    skillId: "go-test",
    name: "go-test",
    description: "Run Go tests",
    confidence: 0.9,
    reason: "Working with .go files",
    triggers: ["Working with .go files", "Project uses go.mod"],
  },
  {
    skillId: "docker-build",
    name: "docker-build",
    description: "Build Docker images",
    confidence: 0.7,
    reason: "Dockerfile detected",
    triggers: ["Dockerfile detected"],
  },
];

describe("SkillsProvider", () => {
  let provider: SkillsProvider;
  let mockSkillsClient: SkillsClient;
  let mockRecommendationManager: SkillRecommendationManager;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock SkillsClient
    mockSkillsClient = {
      getSkills: vi.fn(() => sampleSkills),
      getSkill: vi.fn((name: string) => sampleSkills.find((s) => s.name === name)),
      getSkillsByCategory: vi.fn((category: string) =>
        sampleSkills.filter((s) => s.categories?.includes(category))
      ),
      searchSkills: vi.fn((query: string) => {
        const lowerQuery = query.toLowerCase();
        return sampleSkills.filter(
          (s) =>
            s.name.toLowerCase().includes(lowerQuery) ||
            s.common?.description?.toLowerCase().includes(lowerQuery)
        );
      }),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
      refresh: vi.fn(),
    } as unknown as SkillsClient;

    // Create mock RecommendationManager
    mockRecommendationManager = {
      getRecommendations: vi.fn((limit?: number) =>
        limit ? sampleRecommendations.slice(0, limit) : sampleRecommendations
      ),
      onDidChangeRecommendations: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as SkillRecommendationManager;

    provider = new SkillsProvider(mockSkillsClient, mockRecommendationManager);
  });

  describe("getTreeItem", () => {
    it("should return the tree item unchanged", () => {
      const item = new SkillTreeItem("test", vscode.TreeItemCollapsibleState.None, "category");

      const result = provider.getTreeItem(item);

      expect(result).toBe(item);
    });
  });

  describe("getChildren - root level", () => {
    it("should show Recommended section at root", () => {
      const children = provider.getChildren();

      const recommendedItem = children.find((c) => c.label === "Recommended");
      expect(recommendedItem).toBeDefined();
      expect(recommendedItem?.itemType).toBe("recommended-group");
    });

    it("should show categories after Recommended", () => {
      const children = provider.getChildren();

      // First item should be Recommended
      expect(children[0].label).toBe("Recommended");

      // Categories should follow
      const categoryLabels = children.slice(1).map((c) => c.label);
      expect(categoryLabels).toContain("testing");
      expect(categoryLabels).toContain("go");
      expect(categoryLabels).toContain("docker");
    });

    it("should show placeholder when no skills", () => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      vi.mocked(mockSkillsClient.getSkills).mockReturnValue([]);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      vi.mocked(mockRecommendationManager.getRecommendations).mockReturnValue([]);

      const children = provider.getChildren();

      expect(children).toHaveLength(1);
      expect(children[0].label).toBe("No skills found");
    });

    it("should hide Recommended section when filter is active", () => {
      provider.setFilter("docker");

      const children = provider.getChildren();

      const recommendedItem = children.find((c) => c.label === "Recommended");
      expect(recommendedItem).toBeUndefined();
    });

    it("should hide Recommended section when platform filter is active", () => {
      provider.setPlatformFilter("claude");

      const children = provider.getChildren();

      const recommendedItem = children.find((c) => c.label === "Recommended");
      expect(recommendedItem).toBeUndefined();
    });
  });

  describe("getChildren - recommended-group", () => {
    it("should show recommended skills with confidence", () => {
      const recommendedGroup = new SkillTreeItem(
        "Recommended",
        vscode.TreeItemCollapsibleState.Expanded,
        "recommended-group"
      );

      const children = provider.getChildren(recommendedGroup);

      expect(children).toHaveLength(2);
      expect(children[0].label).toBe("go-test");
      expect(children[0].description).toBe("90%");
      expect(children[0].itemType).toBe("recommended-skill");
    });

    it("should include skill reference for recommended items", () => {
      const recommendedGroup = new SkillTreeItem(
        "Recommended",
        vscode.TreeItemCollapsibleState.Expanded,
        "recommended-group"
      );

      const children = provider.getChildren(recommendedGroup);

      expect(children[0].skill).toBeDefined();
      expect(children[0].skill?.name).toBe("go-test");
    });
  });

  describe("getChildren - category", () => {
    it("should show skills in category", () => {
      const categoryItem = new SkillTreeItem(
        "testing",
        vscode.TreeItemCollapsibleState.Expanded,
        "category"
      );

      const children = provider.getChildren(categoryItem);

      const skillNames = children.map((c) => c.label);
      expect(skillNames).toContain("go-test");
      expect(skillNames).toContain("typescript-check");
    });
  });

  describe("getChildren - skill", () => {
    it("should show targets, scripts, references, assets groups", () => {
      const skill = sampleSkills[0]; // go-test
      const skillItem = new SkillTreeItem(
        skill.name,
        vscode.TreeItemCollapsibleState.Collapsed,
        "skill",
        skill
      );

      const children = provider.getChildren(skillItem);

      const labels = children.map((c) => c.label);
      expect(labels).toContain("Targets");
      expect(labels).toContain("Scripts");
      expect(labels).toContain("References");
      expect(labels).toContain("Assets");
    });

    it("should not show empty groups", () => {
      const skill = sampleSkills[2]; // typescript-check - has no scripts/refs/assets
      const skillItem = new SkillTreeItem(
        skill.name,
        vscode.TreeItemCollapsibleState.Collapsed,
        "skill",
        skill
      );

      const children = provider.getChildren(skillItem);

      // Should only have targets if defined, or be empty
      expect(children.length).toBeLessThan(4);
    });
  });

  describe("getChildren - targets-group", () => {
    it("should show target platforms", () => {
      const skill = sampleSkills[0];
      const targetsGroup = new SkillTreeItem(
        "Targets",
        vscode.TreeItemCollapsibleState.Collapsed,
        "targets-group",
        skill
      );

      const children = provider.getChildren(targetsGroup);

      const labels = children.map((c) => c.label);
      expect(labels).toContain("claude");
      expect(labels).toContain("vscode");
    });

    it("should show enabled/disabled status", () => {
      const skill = sampleSkills[1]; // docker-build - vscode disabled
      const targetsGroup = new SkillTreeItem(
        "Targets",
        vscode.TreeItemCollapsibleState.Collapsed,
        "targets-group",
        skill
      );

      const children = provider.getChildren(targetsGroup);

      const vscodeTarget = children.find((c) => c.label === "vscode");
      expect(vscodeTarget?.description).toBe("disabled");
    });
  });

  describe("getChildren - scripts-group", () => {
    it("should show scripts", () => {
      const skill = sampleSkills[0];
      const scriptsGroup = new SkillTreeItem(
        "Scripts",
        vscode.TreeItemCollapsibleState.Collapsed,
        "scripts-group",
        skill
      );

      const children = provider.getChildren(scriptsGroup);

      expect(children).toHaveLength(1);
      expect(children[0].label).toBe("run");
      expect(children[0].itemType).toBe("script");
    });
  });

  describe("getChildren - references-group", () => {
    it("should show references", () => {
      const skill = sampleSkills[0];
      const refsGroup = new SkillTreeItem(
        "References",
        vscode.TreeItemCollapsibleState.Collapsed,
        "references-group",
        skill
      );

      const children = provider.getChildren(refsGroup);

      expect(children).toHaveLength(1);
      expect(children[0].label).toBe("docs/testing.md");
      expect(children[0].itemType).toBe("reference");
    });
  });

  describe("getChildren - assets-group", () => {
    it("should show assets", () => {
      const skill = sampleSkills[0];
      const assetsGroup = new SkillTreeItem(
        "Assets",
        vscode.TreeItemCollapsibleState.Collapsed,
        "assets-group",
        skill
      );

      const children = provider.getChildren(assetsGroup);

      expect(children).toHaveLength(1);
      expect(children[0].label).toBe("templates/test.go.tmpl");
      expect(children[0].itemType).toBe("asset");
    });
  });

  describe("setFilter", () => {
    it("should filter skills by query", () => {
      provider.setFilter("docker");

      // Get children to trigger the search
      provider.getChildren();

      // When filter is set, searchSkills is used when getChildren is called
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockSkillsClient.searchSkills).toHaveBeenCalledWith("docker");
    });

    it("should show no match message when nothing matches", () => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      vi.mocked(mockSkillsClient.searchSkills).mockReturnValue([]);

      provider.setFilter("nonexistent");
      const children = provider.getChildren();

      expect(children).toHaveLength(1);
      expect(children[0].label).toContain("No skills match");
    });
  });

  describe("clearFilter", () => {
    it("should clear the filter", () => {
      provider.setFilter("docker");
      provider.clearFilter();

      // After clear, should show all skills
      const children = provider.getChildren();
      expect(children.length).toBeGreaterThan(1);
    });
  });

  describe("setPlatformFilter", () => {
    it("should filter by platform", () => {
      provider.setPlatformFilter("vscode");

      const children = provider.getChildren();

      // docker-build has vscode: { enabled: false }, so it should be excluded
      const allItems = children.flatMap((c) =>
        c.itemType === "category" ? provider.getChildren(c) : []
      );
      const dockerBuild = allItems.find((i) => i.label === "docker-build");
      expect(dockerBuild).toBeUndefined();
    });

    it("should show message when no skills for platform", () => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      vi.mocked(mockSkillsClient.getSkills).mockReturnValue([
        {
          name: "claude-only",
          categories: ["test"],
          common: {
            description: "Claude only skill",
            instructions: "",
            scripts: [],
            references: [],
            assets: [],
            always_allow: [],
          },
          targets: { claude: { enabled: true }, vscode: { enabled: false } },
        },
      ]);

      provider.setPlatformFilter("vscode");
      const children = provider.getChildren();

      expect(children[0].label).toContain("No skills for vscode");
    });
  });

  describe("clearPlatformFilter", () => {
    it("should clear platform filter", () => {
      provider.setPlatformFilter("claude");
      provider.clearPlatformFilter();

      expect(provider.getPlatformFilter()).toBe("all");
    });
  });

  describe("refresh", () => {
    it("should refresh skills client", () => {
      provider.refresh();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockSkillsClient.refresh).toHaveBeenCalled();
    });
  });

  describe("onDidChangeTreeData", () => {
    it("should emit event when skills change", () => {
      // Get the callback passed to onDidChange
      const onDidChangeCall = vi.mocked(mockSkillsClient.onDidChange).mock.calls[0];
      const callback = onDidChangeCall[0];

      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);

      // Simulate skills change
      callback(null);

      expect(listener).toHaveBeenCalled();
    });

    it("should emit event when recommendations change", () => {
      // Get the callback passed to onDidChangeRecommendations
      const onChangeCall = vi.mocked(mockRecommendationManager.onDidChangeRecommendations).mock
        .calls[0];
      const callback = onChangeCall[0];

      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);

      // Simulate recommendation change
      callback(sampleRecommendations);

      expect(listener).toHaveBeenCalled();
    });
  });
});

describe("SkillTreeItem", () => {
  it("should create item with all properties", () => {
    const skill: SkillDefinition = {
      name: "test-skill",
      categories: ["test"],
      common: {
        description: "Test skill",
        instructions: "",
        scripts: [],
        references: [],
        assets: [],
        always_allow: [],
      },
    };
    const recommendation: SkillRecommendation = {
      skillId: "test-skill",
      name: "test-skill",
      description: "Test",
      confidence: 0.8,
      reason: "Test reason",
      triggers: ["trigger1"],
    };

    const item = new SkillTreeItem(
      "test-skill",
      vscode.TreeItemCollapsibleState.Collapsed,
      "recommended-skill",
      skill,
      undefined,
      undefined,
      recommendation
    );

    expect(item.label).toBe("test-skill");
    expect(item.itemType).toBe("recommended-skill");
    expect(item.skill).toBe(skill);
    expect(item.recommendation).toBe(recommendation);
  });
});
