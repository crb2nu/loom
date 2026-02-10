import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

// Mock the HTTP utility
const mockRequestJson = vi.hoisted(() => vi.fn());

vi.mock("../utils/http", () => ({
  requestJson: mockRequestJson,
}));

import { HubSettings } from "../types";

import { HubClient } from "./hub";

describe("HubClient", () => {
  let client: HubClient;
  let mockChannel: vscode.OutputChannel;
  let defaultSettings: HubSettings;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestJson.mockReset();

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

    defaultSettings = {
      hubUrl: "wss://mcp.example.com/ws",
      httpBaseUrl: "https://mcp.example.com",
      profile: "test",
    };

    client = new HubClient(defaultSettings, mockChannel);
  });

  describe("initial state", () => {
    it("should start with unknown connection status", () => {
      expect(client.getConnectionStatus()).toBe("unknown");
    });

    it("should not be online initially", () => {
      expect(client.isOnline()).toBe(false);
    });

    it("should have no last health check", () => {
      expect(client.getLastHealthCheck()).toBeNull();
    });

    it("should have zero consecutive failures", () => {
      expect(client.getConsecutiveFailures()).toBe(0);
    });
  });

  describe("checkConnectivity", () => {
    it("should return true and set connected on success", async () => {
      mockRequestJson.mockResolvedValue({ status: "ok" });

      const result = await client.checkConnectivity();

      expect(result).toBe(true);
      expect(client.getConnectionStatus()).toBe("connected");
      expect(client.getLastHealthCheck()).toBeInstanceOf(Date);
    });

    it("should return false on failure", async () => {
      mockRequestJson.mockRejectedValue(new Error("network error"));

      const result = await client.checkConnectivity();

      expect(result).toBe(false);
      // checkConnectivity calls fetchHealth, which increments on error,
      // then checkConnectivity's own catch also increments — so 2 per call
      expect(client.getConsecutiveFailures()).toBe(2);
    });

    it("should mark disconnected after 3 consecutive failures", async () => {
      mockRequestJson.mockRejectedValue(new Error("network error"));

      await client.checkConnectivity();
      await client.checkConnectivity();
      await client.checkConnectivity();

      expect(client.getConnectionStatus()).toBe("disconnected");
    });

    it("should reset failure count on success", async () => {
      // Fail twice
      mockRequestJson.mockRejectedValue(new Error("fail"));
      await client.checkConnectivity();
      await client.checkConnectivity();
      // 2 calls × 2 increments each = 4
      expect(client.getConsecutiveFailures()).toBe(4);

      // Now succeed
      mockRequestJson.mockResolvedValue({ status: "ok" });
      await client.checkConnectivity();
      expect(client.getConsecutiveFailures()).toBe(0);
      expect(client.getConnectionStatus()).toBe("connected");
    });
  });

  describe("fetchHealth", () => {
    it("should return health response", async () => {
      const health = { status: "ok", sessions: 5 };
      mockRequestJson.mockResolvedValue(health);

      const result = await client.fetchHealth();

      expect(result).toEqual(health);
      expect(client.getConnectionStatus()).toBe("connected");
    });

    it("should throw and track failure on error", async () => {
      mockRequestJson.mockRejectedValue(new Error("timeout"));

      await expect(client.fetchHealth()).rejects.toThrow("timeout");
      expect(client.getConsecutiveFailures()).toBe(1);
    });
  });

  describe("fetchReady", () => {
    it("should return readiness response", async () => {
      const ready = { ready: true, servers: 3 };
      mockRequestJson.mockResolvedValue(ready);

      const result = await client.fetchReady();

      expect(result).toEqual(ready);
    });
  });

  describe("fetchServers", () => {
    it("should return server list", async () => {
      mockRequestJson.mockResolvedValue({
        servers: [{ name: "github", description: "GitHub API" }],
      });

      const servers = await client.fetchServers();

      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe("github");
    });

    it("should return empty array when no servers key", async () => {
      mockRequestJson.mockResolvedValue({});

      const servers = await client.fetchServers();

      expect(servers).toEqual([]);
    });
  });

  describe("without httpBaseUrl", () => {
    it("should throw when httpBaseUrl is not configured", async () => {
      const noUrlSettings: HubSettings = {
        hubUrl: "wss://example.com",
        profile: "test",
      };
      const noUrlClient = new HubClient(noUrlSettings, mockChannel);

      await expect(noUrlClient.fetchHealth()).rejects.toThrow("Hub URL is not configured");
    });
  });

  describe("CF Access headers", () => {
    it("should include CF headers when credentials are set", async () => {
      const cfSettings: HubSettings = {
        hubUrl: "wss://mcp.example.com/ws",
        httpBaseUrl: "https://mcp.example.com",
        profile: "test",
        cfAccessClientId: "client-id",
        cfAccessClientSecret: "client-secret",
      };
      const cfClient = new HubClient(cfSettings, mockChannel);

      mockRequestJson.mockResolvedValue({ status: "ok" });

      await cfClient.fetchHealth();

      expect(mockRequestJson).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          "CF-Access-Client-Id": "client-id",
          "CF-Access-Client-Secret": "client-secret",
        })
      );
    });
  });
});
