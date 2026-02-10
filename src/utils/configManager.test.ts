import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";

import { ConfigManager } from "./configManager";

function createMockConfig(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn(<T>(key: string, _defaultValue?: T): T | undefined => {
      return overrides[key] as T | undefined;
    }),
    has: vi.fn(() => false),
    inspect: vi.fn(() => undefined),
    update: vi.fn(async () => {}),
  } as unknown as vscode.WorkspaceConfiguration;
}

describe("ConfigManager", () => {
  let manager: ConfigManager;

  beforeEach(() => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(createMockConfig());
    manager = new ConfigManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  describe("get", () => {
    it("should return default values when config is empty", () => {
      expect(manager.get("hubProfile")).toBe("codex");
      expect(manager.get("platform")).toBe("auto");
      expect(manager.get("syncOnStartup")).toBe(false);
      expect(manager.get("agentId")).toBe("vscode-loom");
      expect(manager.get("serverMetricsInterval")).toBe(30000);
    });

    it("should return configured values", () => {
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
        createMockConfig({
          hubProfile: "custom",
          agentId: "test-agent",
          syncOnStartup: true,
        })
      );

      // Create fresh manager to pick up new mock
      manager.dispose();
      manager = new ConfigManager();

      expect(manager.get("hubProfile")).toBe("custom");
      expect(manager.get("agentId")).toBe("test-agent");
      expect(manager.get("syncOnStartup")).toBe(true);
    });
  });

  describe("config", () => {
    it("should return full config object", () => {
      const config = manager.config;

      expect(config).toHaveProperty("hubUrl");
      expect(config).toHaveProperty("hubProfile");
      expect(config).toHaveProperty("platform");
      expect(config).toHaveProperty("enabledPlatforms");
      expect(config).toHaveProperty("agentId");
    });

    it("should cache config between accesses", () => {
      const config1 = manager.config;
      const config2 = manager.config;

      // Same object reference = cached
      expect(config1).toBe(config2);
    });
  });

  describe("set", () => {
    it("should update config via VS Code API", async () => {
      const mockConfig = createMockConfig();
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(mockConfig);

      manager.dispose();
      manager = new ConfigManager();

      await manager.set("hubProfile", "newprofile");

      expect(mockConfig.update).toHaveBeenCalledWith(
        "hubProfile",
        "newprofile",
        vscode.ConfigurationTarget.Global
      );
    });
  });

  describe("onDidChange", () => {
    it("should fire when loom config changes", () => {
      // Capture the onDidChangeConfiguration listener
      const listeners: Array<(e: vscode.ConfigurationChangeEvent) => void> = [];
      vi.mocked(vscode.workspace.onDidChangeConfiguration).mockImplementation(
        (listener: (e: vscode.ConfigurationChangeEvent) => void) => {
          listeners.push(listener);
          return { dispose: vi.fn() };
        }
      );

      manager.dispose();
      manager = new ConfigManager();

      const changeSpy = vi.fn();
      manager.onDidChange(changeSpy);

      // Simulate config change
      if (listeners.length > 0) {
        listeners[0]({
          affectsConfiguration: (section: string) => section === "loom" || section.startsWith("loom."),
        });
      }

      expect(changeSpy).toHaveBeenCalled();
    });
  });

  describe("defaults", () => {
    it("should have correct default enabledPlatforms", () => {
      expect(manager.get("enabledPlatforms")).toEqual([
        "vscode",
        "antigravity",
        "gemini",
        "claude",
      ]);
    });

    it("should have correct default autoSyncOnDrift", () => {
      expect(manager.get("autoSyncOnDrift")).toBe("prompt");
    });

    it("should have correct default activeProfile", () => {
      expect(manager.get("activeProfile")).toBe("full");
    });

    it("should have null skillsRegistryPath by default", () => {
      expect(manager.get("skillsRegistryPath")).toBeNull();
    });
  });
});
