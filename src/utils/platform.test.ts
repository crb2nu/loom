import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

import {
  detectPlatform,
  getCurrentPlatformInfo,
  getPlatformInfo,
  getSupportedPlatforms,
  getEnabledPlatforms,
  isValidPlatformType,
  getPlatformStatusText,
  isAntigravityCompatible,
  PLATFORMS,
} from "./platform";

describe("PLATFORMS registry", () => {
  it("should have 8 platform entries", () => {
    expect(Object.keys(PLATFORMS)).toHaveLength(8);
  });

  it("should have required fields for each platform", () => {
    for (const info of Object.values(PLATFORMS)) {
      expect(info.type).toBeTruthy();
      expect(info.displayName).toBeTruthy();
      expect(info.configFormat).toMatch(/^(json|toml)$/);
      expect(info.repoConfigPath).toBeTruthy();
      expect(info.homeConfigPath).toBeTruthy();
      expect(info.icon).toBeTruthy();
    }
  });
});

describe("detectPlatform", () => {
  beforeEach(() => {
    delete process.env.ANTIGRAVITY_HOME;
    delete process.env.WINDSURF_HOME;
    delete process.env.GOOGLE_AI_STUDIO;
  });

  it("should return configured platform when not auto", () => {
    const mockConfig = {
      get: vi.fn((key: string) => {
        if (key === "platform") return "codex";
        return undefined;
      }),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    expect(detectPlatform()).toBe("codex");
  });

  it("should detect antigravity from app name", () => {
    const mockConfig = {
      get: vi.fn(() => "auto"),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    // Override appName for this test
    const original = vscode.env.appName;
    Object.defineProperty(vscode.env, "appName", { value: "Antigravity", writable: true });

    expect(detectPlatform()).toBe("antigravity");

    Object.defineProperty(vscode.env, "appName", { value: original, writable: true });
  });

  it("should detect antigravity from ANTIGRAVITY_HOME env", () => {
    process.env.ANTIGRAVITY_HOME = "/opt/antigravity";

    const mockConfig = {
      get: vi.fn(() => "auto"),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    // Ensure appName doesn't match
    const original = vscode.env.appName;
    Object.defineProperty(vscode.env, "appName", { value: "Visual Studio Code", writable: true });

    expect(detectPlatform()).toBe("antigravity");

    Object.defineProperty(vscode.env, "appName", { value: original, writable: true });
  });

  it("should default to vscode", () => {
    const mockConfig = {
      get: vi.fn(() => "auto"),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    const original = vscode.env.appName;
    Object.defineProperty(vscode.env, "appName", { value: "Visual Studio Code", writable: true });

    expect(detectPlatform()).toBe("vscode");

    Object.defineProperty(vscode.env, "appName", { value: original, writable: true });
  });

  it("should ignore invalid config values", () => {
    const mockConfig = {
      get: vi.fn((key: string) => {
        if (key === "platform") return "invalidplatform";
        return undefined;
      }),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    const original = vscode.env.appName;
    Object.defineProperty(vscode.env, "appName", { value: "Visual Studio Code", writable: true });

    // Should fall through to default
    expect(detectPlatform()).toBe("vscode");

    Object.defineProperty(vscode.env, "appName", { value: original, writable: true });
  });
});

describe("getCurrentPlatformInfo", () => {
  it("should return platform info for detected platform", () => {
    const mockConfig = {
      get: vi.fn((key: string) => {
        if (key === "platform") return "claude";
        return undefined;
      }),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    const info = getCurrentPlatformInfo();

    expect(info.type).toBe("claude");
    expect(info.displayName).toBe("Claude");
  });
});

describe("getPlatformInfo", () => {
  it("should return correct info for each platform", () => {
    expect(getPlatformInfo("vscode").displayName).toBe("VS Code");
    expect(getPlatformInfo("claude").icon).toBe("comment-discussion");
    expect(getPlatformInfo("gemini").configFormat).toBe("json");
    expect(getPlatformInfo("opencode").repoConfigPath).toBe(".opencode/opencode.json");
    expect(getPlatformInfo("zed").homeConfigPath).toBe("Library/Application Support/Zed/mcp.json");
  });
});

describe("getSupportedPlatforms", () => {
  it("should return all 8 platforms", () => {
    const platforms = getSupportedPlatforms();

    expect(platforms).toHaveLength(8);
    expect(platforms).toContain("vscode");
    expect(platforms).toContain("antigravity");
    expect(platforms).toContain("gemini");
    expect(platforms).toContain("codex");
    expect(platforms).toContain("kilocode");
    expect(platforms).toContain("claude");
    expect(platforms).toContain("opencode");
    expect(platforms).toContain("zed");
  });
});

describe("getEnabledPlatforms", () => {
  it("should return configured platforms", () => {
    const mockConfig = {
      get: vi.fn(() => ["vscode", "claude"]),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    const enabled = getEnabledPlatforms();

    expect(enabled).toEqual(["vscode", "claude"]);
  });

  it("should return defaults when config is empty", () => {
    const mockConfig = {
      get: vi.fn(() => undefined),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    const enabled = getEnabledPlatforms();

    expect(enabled).toEqual(["vscode", "antigravity", "gemini", "claude"]);
  });

  it("should filter out invalid platform types", () => {
    const mockConfig = {
      get: vi.fn(() => ["vscode", "invalid", "claude"]),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    const enabled = getEnabledPlatforms();

    expect(enabled).toEqual(["vscode", "claude"]);
  });
});

describe("isValidPlatformType", () => {
  it("should return true for valid types", () => {
    expect(isValidPlatformType("vscode")).toBe(true);
    expect(isValidPlatformType("claude")).toBe(true);
    expect(isValidPlatformType("gemini")).toBe(true);
    expect(isValidPlatformType("opencode")).toBe(true);
    expect(isValidPlatformType("zed")).toBe(true);
  });

  it("should return false for invalid types", () => {
    expect(isValidPlatformType("invalid")).toBe(false);
    expect(isValidPlatformType("")).toBe(false);
    expect(isValidPlatformType("VSCode")).toBe(false);
  });
});

describe("getPlatformStatusText", () => {
  it("should return display name of detected platform", () => {
    const mockConfig = {
      get: vi.fn((key: string) => {
        if (key === "platform") return "kilocode";
        return undefined;
      }),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    expect(getPlatformStatusText()).toBe("Kilocode");
  });
});

describe("isAntigravityCompatible", () => {
  it("should return true for vscode", () => {
    const mockConfig = {
      get: vi.fn((key: string) => {
        if (key === "platform") return "vscode";
        return undefined;
      }),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    expect(isAntigravityCompatible()).toBe(true);
  });

  it("should return true for antigravity", () => {
    const mockConfig = {
      get: vi.fn((key: string) => {
        if (key === "platform") return "antigravity";
        return undefined;
      }),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    expect(isAntigravityCompatible()).toBe(true);
  });

  it("should return false for other platforms", () => {
    const mockConfig = {
      get: vi.fn((key: string) => {
        if (key === "platform") return "codex";
        return undefined;
      }),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    expect(isAntigravityCompatible()).toBe(false);
  });
});
