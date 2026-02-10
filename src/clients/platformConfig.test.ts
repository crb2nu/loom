import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";

const mockAccess = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: () => vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  promises: {
    access: mockAccess,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
  },
}));

vi.mock("os", () => ({
  homedir: () => "/home/testuser",
}));

vi.mock("crypto", () => ({
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => "abc123"),
  })),
}));

vi.mock("../utils/binary", () => ({
  resolveLoomBinary: vi.fn(() => "/usr/local/bin/loom"),
}));

vi.mock("../utils/platform", () => ({
  getEnabledPlatforms: vi.fn(() => ["vscode", "claude"]),
  PLATFORMS: {
    vscode: {
      type: "vscode",
      displayName: "VS Code",
      configFormat: "json",
      repoConfigPath: ".vscode/mcp.json",
      homeConfigPath: ".vscode/mcp.json",
      icon: "code",
    },
    claude: {
      type: "claude",
      displayName: "Claude",
      configFormat: "json",
      repoConfigPath: ".claude/mcp.json",
      homeConfigPath: ".claude/mcp.json",
      icon: "comment-discussion",
    },
  },
}));

import { PlatformConfigClient } from "./platformConfig";

describe("PlatformConfigClient", () => {
  let client: PlatformConfigClient;
  let mockChannel: vscode.OutputChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockAccess.mockRejectedValue(new Error("ENOENT"));

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

    const mockConfig = {
      get: vi.fn(() => undefined),
      has: vi.fn(() => false),
      inspect: vi.fn(() => undefined),
      update: vi.fn(),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    client = new PlatformConfigClient("/workspace", mockChannel);
  });

  afterEach(() => {
    client.dispose();
  });

  describe("getConfigs", () => {
    it("should return empty array initially", () => {
      expect(client.getConfigs()).toEqual([]);
    });
  });

  describe("getConfig", () => {
    it("should return undefined for unchecked platform", () => {
      expect(client.getConfig("vscode")).toBeUndefined();
    });
  });

  describe("checkAllSyncStatus", () => {
    it("should check all enabled platforms", async () => {
      await client.checkAllSyncStatus();

      const configs = client.getConfigs();
      expect(configs).toHaveLength(2);
    });

    it("should detect missing configs when files don't exist", async () => {
      await client.checkAllSyncStatus();

      const config = client.getConfig("vscode");
      expect(config?.syncStatus).toBe("missing");
    });
  });

  describe("syncPlatform", () => {
    it("should sync when repo config exists", async () => {
      // File exists
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('{"mcpServers": {"github": {}}}');
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      const result = await client.syncPlatform("vscode");

      expect(result.success).toBe(true);
    });

    it("should fail when repo config does not exist", async () => {
      // File does not exist
      mockAccess.mockRejectedValue(new Error("ENOENT"));

      const result = await client.syncPlatform("vscode");

      expect(result.success).toBe(false);
      expect(result.message).toContain("Repo config not found");
    });
  });

  describe("syncAllPlatforms", () => {
    it("should sync all enabled platforms", async () => {
      mockAccess.mockRejectedValue(new Error("ENOENT"));

      const results = await client.syncAllPlatforms();

      expect(results).toHaveLength(2);
    });
  });

  describe("dispose", () => {
    it("should clean up interval on dispose", () => {
      client.dispose();
    });
  });
});
