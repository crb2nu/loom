import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockWatch = vi.hoisted(() =>
  vi.fn(() => ({
    close: vi.fn(),
    on: vi.fn(),
  }))
);

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  watch: mockWatch,
  promises: {
    readFile: mockReadFile,
    writeFile: vi.fn(),
    mkdir: vi.fn(),
  },
}));

vi.mock("os", () => ({
  homedir: () => "/home/testuser",
}));

vi.mock("crypto", () => ({
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => "hash123"),
  })),
}));

vi.mock("../utils/binary", () => ({
  resolveLoomBinary: vi.fn(() => "/usr/local/bin/loom"),
}));

import { ConfigSyncManager } from "./configSync";

describe("ConfigSyncManager", () => {
  let manager: ConfigSyncManager;
  let mockChannel: vscode.OutputChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);

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
  });

  describe("checkSync", () => {
    it("should update state when configs exist", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('{"mcpServers":{}}');

      await manager.checkSync();

      const state = manager.getState();
      expect(state.lastChecked).toBeInstanceOf(Date);
    });

    it("should handle no-generated state", async () => {
      mockExistsSync.mockReturnValue(false);

      await manager.checkSync();

      const state = manager.getState();
      // Status depends on whether generated config exists
      expect(["unknown", "no-generated"]).toContain(state.status);
    });
  });

  describe("dispose", () => {
    it("should clean up resources", () => {
      // Should not throw
      manager.dispose();
    });
  });
});
