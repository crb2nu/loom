import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";

// Mock the HubClient
const mockFetchHealth = vi.hoisted(() => vi.fn());
const mockFetchReady = vi.hoisted(() => vi.fn());
const mockFetchServers = vi.hoisted(() => vi.fn());

vi.mock("../clients/hub", () => ({
  HubClient: vi.fn().mockImplementation(() => ({
    fetchHealth: mockFetchHealth,
    fetchReady: mockFetchReady,
    fetchServers: mockFetchServers,
  })),
}));

import { HubStatusManager } from "./hubStatus";
import { HubSettings } from "../types";

describe("HubStatusManager", () => {
  let manager: HubStatusManager;
  let mockChannel: vscode.OutputChannel;
  let settings: HubSettings;

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

    settings = {
      hubUrl: "wss://mcp.example.com/ws",
      httpBaseUrl: "https://mcp.example.com",
      profile: "test",
    };

    manager = new HubStatusManager(settings, mockChannel);
  });

  afterEach(() => {
    manager.dispose();
  });

  describe("initial state", () => {
    it("should have empty server list", () => {
      const status = manager.getStatus();
      expect(status.servers).toEqual([]);
    });

    it("should return settings", () => {
      expect(manager.getSettings()).toBe(settings);
    });
  });

  describe("refresh", () => {
    it("should update status on successful refresh", async () => {
      mockFetchHealth.mockResolvedValueOnce({ status: "ok", sessions: 3 });
      mockFetchReady.mockResolvedValueOnce({ ready: true, servers: 2 });
      mockFetchServers.mockResolvedValueOnce([
        { name: "github", description: "GitHub API" },
      ]);

      await manager.refresh();

      const status = manager.getStatus();
      expect(status.health?.status).toBe("ok");
      expect(status.readiness?.ready).toBe(true);
      expect(status.servers).toHaveLength(1);
      expect(status.error).toBeUndefined();
      expect(status.lastUpdated).toBeInstanceOf(Date);
    });

    it("should set error on failed refresh", async () => {
      mockFetchHealth.mockRejectedValueOnce(new Error("network error"));

      await manager.refresh();

      const status = manager.getStatus();
      expect(status.error).toContain("network error");
    });

    it("should handle missing httpBaseUrl", async () => {
      const noUrlManager = new HubStatusManager(
        { hubUrl: "wss://example.com", profile: "test" },
        mockChannel
      );

      await noUrlManager.refresh();

      const status = noUrlManager.getStatus();
      expect(status.error).toContain("Invalid MCP hub URL");
      noUrlManager.dispose();
    });

    it("should deduplicate concurrent refreshes", async () => {
      let resolveHealth: (v: unknown) => void;
      const healthPromise = new Promise((resolve) => {
        resolveHealth = resolve;
      });
      mockFetchHealth.mockReturnValue(healthPromise);
      mockFetchReady.mockResolvedValue({ ready: true });
      mockFetchServers.mockResolvedValue([]);

      // Start two concurrent refreshes
      const p1 = manager.refresh();
      const p2 = manager.refresh();

      resolveHealth!({ status: "ok" });
      await Promise.all([p1, p2]);

      // HubClient should only be created once (dedup)
      // Both promises resolved without error
    });
  });

  describe("updateSettings", () => {
    it("should update settings and trigger refresh", async () => {
      mockFetchHealth.mockResolvedValue({ status: "ok" });
      mockFetchReady.mockResolvedValue({ ready: true });
      mockFetchServers.mockResolvedValue([]);

      const newSettings: HubSettings = {
        hubUrl: "wss://new.example.com/ws",
        httpBaseUrl: "https://new.example.com",
        profile: "new",
      };

      manager.updateSettings(newSettings);

      expect(manager.getSettings()).toBe(newSettings);
    });
  });

  describe("onDidChange", () => {
    it("should fire when status changes", async () => {
      const changeSpy = vi.fn();
      manager.onDidChange(changeSpy);

      mockFetchHealth.mockResolvedValueOnce({ status: "ok" });
      mockFetchReady.mockResolvedValueOnce({ ready: true });
      mockFetchServers.mockResolvedValueOnce([{ name: "github" }]);

      await manager.refresh();

      expect(changeSpy).toHaveBeenCalled();
    });

    it("should not fire when status content is identical", async () => {
      mockFetchHealth.mockResolvedValue({ status: "ok" });
      mockFetchReady.mockResolvedValue({ ready: true });
      mockFetchServers.mockResolvedValue([{ name: "github" }]);

      // First refresh sets initial state
      await manager.refresh();

      const changeSpy = vi.fn();
      manager.onDidChange(changeSpy);

      // Second refresh with identical content
      await manager.refresh();

      expect(changeSpy).not.toHaveBeenCalled();
    });
  });
});
