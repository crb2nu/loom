import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

// Mock the HTTP utility
const mockRequestJson = vi.hoisted(() => vi.fn());
const mockRequestText = vi.hoisted(() => vi.fn());

vi.mock("../utils/http", () => ({
  requestJson: mockRequestJson,
  requestText: mockRequestText,
}));

import { HubSettings } from "../types";

import {
  HubClient,
  HubConfig,
  HubServerHealth,
  allowedViewsFromConfig,
  isServerDegraded,
  isSubViewAllowed,
  isViewAllowed,
} from "./hub";

describe("HubClient", () => {
  let client: HubClient;
  let mockChannel: vscode.OutputChannel;
  let defaultSettings: HubSettings;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestJson.mockReset();
    mockRequestText.mockReset();

    mockChannel = {
      name: "Test",
      append: vi.fn(),
      appendLine: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      replace: vi.fn(),
    };

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

      expect(result).toEqual(expect.objectContaining(health));
      expect(client.getConnectionStatus()).toBe("connected");
      expect(mockRequestJson).toHaveBeenCalledWith(
        "https://mcp.example.com/api/health",
        expect.any(Object)
      );
    });

    it("should normalize current loom-core health payloads", async () => {
      mockRequestJson.mockResolvedValue({
        servers: {
          github: { local: { healthy: true } },
          tavily: { hub: { healthy: true } },
        },
        cache_backend: "memory",
      });

      const result = await client.fetchHealth();

      expect(result.status).toBe("ok");
      expect(result.cacheBackend).toBe("memory");
      expect(result.servers).toHaveProperty("github");
      expect(result.servers).toHaveProperty("tavily");
    });

    it("should mark current loom-core health degraded when a server is unhealthy", async () => {
      mockRequestJson.mockResolvedValue({
        servers: {
          github: { local: { healthy: false } },
        },
      });

      const result = await client.fetchHealth();

      expect(result.status).toBe("degraded");
    });

    it("should preserve Monitor and per-server Divergence on the parsed servers map", async () => {
      mockRequestJson.mockResolvedValue({
        servers: {
          slack: {
            local: { healthy: true, consecFails: 0, avgLatencyMs: 12 },
            hub: { healthy: true },
            monitor: { healthy: false, consecFails: 4, avgLatencyMs: 80 },
            target: "ws",
            transport: "ws",
            divergence: {
              monitor_healthy: false,
              router_available: true,
              reason: "monitor down but router routing",
            },
          },
        },
        divergence: [{ server: "slack", reason: "monitor down but router routing" }],
        cache_backend: "redis",
      });

      const result = await client.fetchHealth();
      const slack = (result.servers as Record<string, HubServerHealth>).slack;

      expect(slack.monitor).toEqual({ healthy: false, consecFails: 4, avgLatencyMs: 80 });
      expect(slack.divergence?.router_available).toBe(true);
      expect(slack.transport).toBe("ws");
      expect(result.divergence).toHaveLength(1);
      expect(result.status).toBe("degraded");
    });

    it("should mark degraded from a top-level divergence array", async () => {
      mockRequestJson.mockResolvedValue({
        servers: { github: { local: { healthy: true } } },
        divergence: [{ server: "github", reason: "split" }],
      });

      const result = await client.fetchHealth();

      expect(result.status).toBe("degraded");
    });

    it("should still parse an old health payload without Monitor/Divergence", async () => {
      mockRequestJson.mockResolvedValue({
        servers: {
          github: { local: { healthy: true } },
          tavily: { hub: { healthy: true } },
        },
      });

      const result = await client.fetchHealth();

      expect(result.status).toBe("ok");
      const servers = result.servers as Record<string, HubServerHealth>;
      expect(servers.github.monitor).toBeUndefined();
      expect(servers.github.divergence).toBeUndefined();
    });

    it("should fall back to plain gateway health when current API is unavailable", async () => {
      mockRequestJson.mockRejectedValueOnce(new Error("HTTP 404"));
      mockRequestText.mockResolvedValueOnce("OK");

      const result = await client.fetchHealth();

      expect(result.status).toBe("ok");
      expect(mockRequestJson).toHaveBeenNthCalledWith(
        1,
        "https://mcp.example.com/api/health",
        expect.any(Object)
      );
      expect(mockRequestText).toHaveBeenCalledWith(
        "https://mcp.example.com/health",
        expect.any(Object)
      );
    });

    it("should throw and track failure on error", async () => {
      mockRequestJson.mockRejectedValue(new Error("timeout"));

      await expect(client.fetchHealth()).rejects.toThrow("timeout");
      expect(client.getConsecutiveFailures()).toBe(1);
    });
  });

  describe("fetchReady", () => {
    it("should return readiness response", async () => {
      const ready = { running: true, servers: 3 };
      mockRequestJson.mockResolvedValue(ready);

      const result = await client.fetchReady();

      expect(result).toEqual({ ready: true, running: true, servers: 3 });
      expect(mockRequestJson).toHaveBeenCalledWith(
        "https://mcp.example.com/api/status",
        expect.any(Object)
      );
    });

    it("should fall back to plain gateway readiness when current status API is unavailable", async () => {
      mockRequestJson.mockRejectedValueOnce(new Error("HTTP 404"));
      mockRequestText.mockResolvedValueOnce("ready");

      const result = await client.fetchReady();

      expect(result).toEqual({ ready: true });
      expect(mockRequestJson).toHaveBeenNthCalledWith(
        1,
        "https://mcp.example.com/api/status",
        expect.any(Object)
      );
      expect(mockRequestText).toHaveBeenCalledWith(
        "https://mcp.example.com/ready",
        expect.any(Object)
      );
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

    it("should treat missing optional server API as empty for gateway-only hubs", async () => {
      mockRequestJson.mockRejectedValue(new Error("HTTP 404"));

      const servers = await client.fetchServers();

      expect(servers).toEqual([]);
      expect(client.getConnectionStatus()).toBe("unknown");
    });

    it("should treat plain 404 errors as empty for gateway-only hubs", async () => {
      mockRequestJson.mockRejectedValue(new Error("404 404 page not found"));

      const servers = await client.fetchServers();

      expect(servers).toEqual([]);
      expect(client.getConnectionStatus()).toBe("unknown");
    });
  });

  describe("fetchHudConfig", () => {
    it("should return the operator subset with allowed views and sub-views", async () => {
      mockRequestJson.mockResolvedValue({
        subset: "operator",
        allowed_views: ["overview", "agents", "activity"],
        allowed_sub_views: { agents: ["fleet"], activity: ["stream"] },
      });

      const config = await client.fetchHudConfig();

      expect(config.subset).toBe("operator");
      expect(config.allowedViews).toEqual(["overview", "agents", "activity"]);
      expect(config.allowedSubViews).toEqual({ agents: ["fleet"], activity: ["stream"] });
      expect(mockRequestJson).toHaveBeenCalledWith(
        "https://mcp.example.com/api/hud/config",
        expect.any(Object)
      );
    });

    it("should treat a full subset with null allowlists as no restriction", async () => {
      mockRequestJson.mockResolvedValue({ subset: "full", allowed_views: null });

      const config = await client.fetchHudConfig();

      expect(config.subset).toBe("full");
      expect(config.allowedViews).toBeUndefined();
      expect(config.allowedSubViews).toBeUndefined();
    });

    it("should default to full when the config endpoint is unavailable (gateway-only hub)", async () => {
      mockRequestJson.mockRejectedValue(new Error("HTTP 404"));

      const config = await client.fetchHudConfig();

      expect(config).toEqual({ subset: "full" });
      // Optional-API 404 must not flip the connection offline.
      expect(client.getConnectionStatus()).toBe("unknown");
    });

    it("fetchAllowedViews returns undefined for a full HUD and the list for operator", async () => {
      mockRequestJson.mockResolvedValueOnce({ subset: "full" });
      expect(await client.fetchAllowedViews()).toBeUndefined();

      mockRequestJson.mockResolvedValueOnce({
        subset: "operator",
        allowed_views: ["overview", "agents"],
      });
      expect(await client.fetchAllowedViews()).toEqual(["overview", "agents"]);
    });
  });

  describe("view-gating helpers", () => {
    const operator: HubConfig = {
      subset: "operator",
      allowedViews: ["overview", "agents", "activity"],
      allowedSubViews: { agents: ["fleet"], activity: ["stream"] },
    };
    const full: HubConfig = { subset: "full" };

    it("allowedViewsFromConfig returns undefined for full, the list for operator", () => {
      expect(allowedViewsFromConfig(full)).toBeUndefined();
      expect(allowedViewsFromConfig(operator)).toEqual(["overview", "agents", "activity"]);
    });

    it("isViewAllowed permits everything under a full HUD", () => {
      expect(isViewAllowed(full, "memory")).toBe(true);
      expect(isViewAllowed(full, "anything")).toBe(true);
    });

    it("isViewAllowed gates against the operator allowlist", () => {
      expect(isViewAllowed(operator, "overview")).toBe(true);
      expect(isViewAllowed(operator, "memory")).toBe(false);
    });

    it("isSubViewAllowed gates sub-views and permits all when no sub-view list", () => {
      expect(isSubViewAllowed(operator, "agents", "fleet")).toBe(true);
      expect(isSubViewAllowed(operator, "agents", "spawn")).toBe(false);
      // overview has no sub-view restriction → all sub-views allowed.
      expect(isSubViewAllowed(operator, "overview", "anything")).toBe(true);
      // disallowed parent view fails regardless of sub-view.
      expect(isSubViewAllowed(operator, "memory", "tiers")).toBe(false);
    });
  });

  describe("isServerDegraded", () => {
    it("is false for a healthy server with no monitor/divergence", () => {
      expect(isServerDegraded({ local: { healthy: true } })).toBe(false);
    });

    it("is true when an endpoint is explicitly unhealthy", () => {
      expect(isServerDegraded({ hub: { healthy: false } })).toBe(true);
    });

    it("is true when consecFails crosses the threshold", () => {
      expect(isServerDegraded({ monitor: { consecFails: 3 } })).toBe(true);
    });

    it("is true when a divergence is present", () => {
      const server: HubServerHealth = {
        local: { healthy: true },
        divergence: { monitor_healthy: false, router_available: true, reason: "split" },
      };
      expect(isServerDegraded(server)).toBe(true);
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
