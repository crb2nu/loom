import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";

const mockAccess = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockWatch = vi.hoisted(() =>
  vi.fn(() => ({
    close: vi.fn(),
    on: vi.fn(),
  }))
);

vi.mock("fs", () => ({
  watch: mockWatch,
  promises: {
    access: mockAccess,
    readFile: mockReadFile,
    writeFile: vi.fn(),
    mkdir: vi.fn(),
  },
}));

vi.mock("os", () => ({
  homedir: () => "/home/testuser",
}));

vi.mock("crypto", () => ({
  createHash: vi.fn(() => {
    let value = "";
    const hash = {
      update: vi.fn((input: string) => {
        value += input;
        return hash;
      }),
      digest: vi.fn(() => `hash:${value}`),
    };
    return hash;
  }),
}));

vi.mock("../utils/binary", () => ({
  resolveLoomBinary: vi.fn(() => "/usr/local/bin/loom"),
}));

const mockGetCurrentPlatformInfo = vi.hoisted(() => vi.fn());

vi.mock("../utils/platform", () => ({
  getCurrentPlatformInfo: mockGetCurrentPlatformInfo,
}));

import { ConfigSyncManager } from "./configSync";

describe("ConfigSyncManager", () => {
  let manager: ConfigSyncManager;
  let mockChannel: vscode.OutputChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    mockGetCurrentPlatformInfo.mockReturnValue({
      type: "vscode",
      displayName: "VS Code",
      label: "VS Code",
      configFormat: "json",
      repoConfigPath: ".vscode/mcp.json",
      homeConfigPath: ".vscode/mcp.json",
      icon: "code",
      description: "VS Code",
    });

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

    manager = new ConfigSyncManager("/workspace", mockChannel);
  });

  afterEach(() => {
    manager.dispose();
  });

  describe("initial state", () => {
    it("should start with unknown sync status", () => {
      const state = manager.getState();
      expect(state.status).toBe("unknown");
    });

    it("should have lastChecked date", () => {
      const state = manager.getState();
      expect(state.lastChecked).toBeInstanceOf(Date);
    });
  });

  describe("onDidChange", () => {
    it("should expose change event", () => {
      expect(manager.onDidChange).toBeDefined();
    });
  });

  describe("offline state", () => {
    it("should start in online mode", () => {
      const state = manager.getOfflineState();
      expect(state.mode).toBe("online");
    });

    it("should have empty pending syncs", () => {
      const state = manager.getOfflineState();
      expect(state.pendingSyncs).toEqual([]);
    });

    it("should queue pending syncs without duplicates", () => {
      manager.queuePendingSync("vscode");
      manager.queuePendingSync("vscode");
      manager.queuePendingSync("claude");

      const state = manager.getOfflineState();
      expect(state.pendingSyncs).toHaveLength(2);
      expect(state.pendingSyncs.map((s) => s.platform).sort()).toEqual(["claude", "vscode"]);
    });

    it("should return empty results when processing with no pending syncs", async () => {
      const results = await manager.processPendingSyncsNow();
      expect(results).toEqual([]);
    });
  });

  describe("checkSync", () => {
    it("should update state when configs exist", async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('{"mcpServers":{}}');

      await manager.checkSync();

      const state = manager.getState();
      expect(state.lastChecked).toBeInstanceOf(Date);
    });

    it("should handle no-generated state", async () => {
      await manager.checkSync();

      const state = manager.getState();
      // Status depends on whether generated config exists
      expect(["unknown", "no-generated"]).toContain(state.status);
    });

    it("uses Antigravity sync paths from loom-core-compatible metadata", async () => {
      mockGetCurrentPlatformInfo.mockReturnValue({
        type: "antigravity",
        displayName: "Antigravity",
        label: "Antigravity",
        configFormat: "json",
        repoConfigPath: ".antigravity/mcp.json",
        homeConfigPath: ".gemini/antigravity/mcp_config.json",
        icon: "rocket",
        description: "Antigravity",
      });
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue('{"mcpServers":{}}');

      await manager.checkSync();

      expect(mockAccess).toHaveBeenCalledWith("/workspace/.antigravity/mcp.json");
      expect(mockReadFile).toHaveBeenCalledWith("/workspace/.antigravity/mcp.json", "utf-8");
      expect(mockReadFile).toHaveBeenCalledWith(
        "/home/testuser/.gemini/antigravity/mcp_config.json",
        "utf-8"
      );
    });

    it("does not emit duplicate drift events for the same diff", async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile
        .mockResolvedValueOnce('{"mcpServers":{"github":{}}}')
        .mockRejectedValueOnce(new Error("ENOENT"))
        .mockResolvedValueOnce('{"mcpServers":{"github":{}}}')
        .mockRejectedValueOnce(new Error("ENOENT"));

      const onDidChange = vi.fn();
      manager.onDidChange(onDidChange);

      await manager.checkSync();
      await manager.checkSync();

      expect(onDidChange).toHaveBeenCalledTimes(1);
      expect(manager.getState().status).toBe("out-of-sync");
    });
  });

  describe("dispose", () => {
    it("should clean up resources", () => {
      // Should not throw
      manager.dispose();
    });
  });
});
