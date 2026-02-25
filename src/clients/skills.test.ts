import * as fs from "fs";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";

import { SkillsClient } from "./skills";

// Mock fs module
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  watch: vi.fn(() => ({ close: vi.fn() })),
}));

// Sample skills registry YAML content
const sampleRegistryYaml = `
skills:
  - name: go-test
    categories:
      - testing
      - go
    common:
      description: Run Go tests
      scripts:
        - name: run
          path: scripts/run.sh
          description: Run all tests
      references:
        - docs/testing.md
      assets:
        - templates/test.go.tmpl
    targets:
      claude:
        enabled: true
      vscode:
        enabled: true

  - name: docker-build
    categories:
      - docker
      - devops
    common:
      description: Build Docker images
      scripts:
        - name: build
          path: scripts/build.sh
    targets:
      claude:
        enabled: true
`;

describe("SkillsClient", () => {
  let client: SkillsClient;
  let mockChannel: vscode.OutputChannel;

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

    client = new SkillsClient(mockChannel);
  });

  afterEach(() => {
    client.dispose();
  });

  describe("findRegistryPath", () => {
    it("should find registry in standard location", () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).includes("skills-registry.yaml");
      });

      // Need to call initialize which internally calls findRegistryPath
      client.initialize("/workspace");

      // Check that existsSync was called to search for the file
      expect(fs.existsSync).toHaveBeenCalled();
    });

    it("should return undefined when registry not found", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      client.initialize("/workspace");

      expect(client.getRegistry()).toBeNull();
    });

    it("should find registry in home config when workspace is unavailable", () => {
      const homeDir = process.env.HOME ?? "";
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p) === `${homeDir}/.config/loom/skills-registry.yaml`;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(sampleRegistryYaml);

      client.initialize("");

      expect(client.getSkills()).toHaveLength(2);
    });
  });

  describe("loadRegistry", () => {
    it("should load and parse skills registry", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(sampleRegistryYaml);

      client.initialize("/workspace");

      const skills = client.getSkills();
      expect(skills).toHaveLength(2);
      expect(skills[0].name).toBe("go-test");
      expect(skills[1].name).toBe("docker-build");
    });

    it("should handle parse errors gracefully", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("invalid: yaml: [");

      client.initialize("/workspace");

      expect(client.getRegistry()).toBeNull();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockChannel.appendLine).toHaveBeenCalledWith(
        expect.stringContaining("Error loading skills registry")
      );
    });

    it("should handle file read errors gracefully", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT: file not found");
      });

      client.initialize("/workspace");

      expect(client.getRegistry()).toBeNull();
    });
  });

  describe("getSkills", () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(sampleRegistryYaml);
      client.initialize("/workspace");
    });

    it("should return all skills", () => {
      const skills = client.getSkills();
      expect(skills).toHaveLength(2);
    });

    it("should return empty array when no registry loaded", () => {
      client.dispose();
      client = new SkillsClient(mockChannel);
      // Don't initialize - no registry loaded
      expect(client.getSkills()).toEqual([]);
    });
  });

  describe("getSkill", () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(sampleRegistryYaml);
      client.initialize("/workspace");
    });

    it("should return skill by name", () => {
      const skill = client.getSkill("go-test");
      expect(skill).toBeDefined();
      expect(skill?.name).toBe("go-test");
      expect(skill?.categories).toContain("testing");
    });

    it("should return undefined for unknown skill", () => {
      const skill = client.getSkill("nonexistent");
      expect(skill).toBeUndefined();
    });
  });

  describe("getSkillsByCategory", () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(sampleRegistryYaml);
      client.initialize("/workspace");
    });

    it("should return skills in category", () => {
      const skills = client.getSkillsByCategory("testing");
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe("go-test");
    });

    it("should return empty array for unknown category", () => {
      const skills = client.getSkillsByCategory("unknown");
      expect(skills).toEqual([]);
    });
  });

  describe("getCategories", () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(sampleRegistryYaml);
      client.initialize("/workspace");
    });

    it("should return all unique categories sorted", () => {
      const categories = client.getCategories();
      expect(categories).toContain("testing");
      expect(categories).toContain("go");
      expect(categories).toContain("docker");
      expect(categories).toContain("devops");
      // Should be sorted
      expect(categories).toEqual([...categories].sort());
    });
  });

  describe("searchSkills", () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(sampleRegistryYaml);
      client.initialize("/workspace");
    });

    it("should search by skill name", () => {
      const results = client.searchSkills("go-test");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("go-test");
    });

    it("should search by description", () => {
      const results = client.searchSkills("Docker images");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("docker-build");
    });

    it("should search by category", () => {
      const results = client.searchSkills("devops");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("docker-build");
    });

    it("should be case insensitive", () => {
      const results = client.searchSkills("GO-TEST");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("go-test");
    });

    it("should return empty array for no matches", () => {
      const results = client.searchSkills("nonexistent query");
      expect(results).toEqual([]);
    });
  });

  describe("getScriptPath", () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).endsWith("skills-registry.yaml");
      });
      vi.mocked(fs.readFileSync).mockReturnValue(sampleRegistryYaml);
      client.initialize("/workspace");
    });

    it("should return full script path", () => {
      const scriptPath = client.getScriptPath("go-test", "run");
      expect(scriptPath).toBeDefined();
      expect(scriptPath).toContain("go-test");
      expect(scriptPath).toContain("scripts/run.sh");
    });

    it("should return undefined for unknown skill", () => {
      const scriptPath = client.getScriptPath("unknown", "run");
      expect(scriptPath).toBeUndefined();
    });

    it("should return undefined for unknown script", () => {
      const scriptPath = client.getScriptPath("go-test", "unknown");
      expect(scriptPath).toBeUndefined();
    });
  });

  describe("refresh", () => {
    it("should reload the registry", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(sampleRegistryYaml);
      client.initialize("/workspace");

      const initialSkills = client.getSkills();
      expect(initialSkills).toHaveLength(2);

      // Update the mock to return different content
      const updatedYaml = `
skills:
  - name: new-skill
    categories:
      - new
    common:
      description: A new skill
`;
      vi.mocked(fs.readFileSync).mockReturnValue(updatedYaml);

      client.refresh();

      const updatedSkills = client.getSkills();
      expect(updatedSkills).toHaveLength(1);
      expect(updatedSkills[0].name).toBe("new-skill");
    });
  });

  describe("onDidChange event", () => {
    it("should emit event when registry changes", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(sampleRegistryYaml);

      const listener = vi.fn();
      client.onDidChange(listener);
      client.initialize("/workspace");

      // The event should have fired during initialization
      expect(listener).toHaveBeenCalled();
    });
  });

  describe("dispose", () => {
    it("should stop file watcher on dispose", () => {
      const mockClose = vi.fn();
      vi.mocked(fs.watch).mockReturnValue({ close: mockClose } as unknown as fs.FSWatcher);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(sampleRegistryYaml);

      client.initialize("/workspace");
      client.dispose();

      expect(mockClose).toHaveBeenCalled();
    });
  });
});
