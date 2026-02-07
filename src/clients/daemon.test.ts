import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

// Create hoisted mock function that can be used in vi.mock
const mockExecFileAsync = vi.hoisted(() => vi.fn());

// Mock child_process
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

// Mock util.promisify to return our mock
vi.mock("util", () => ({
  promisify: () => mockExecFileAsync,
}));

// Mock the binary resolution
vi.mock("../utils/binary", () => ({
  resolveLoomBinary: vi.fn(() => "/usr/local/bin/loom"),
}));

import { DaemonClient } from "./daemon";

// Helper to set up mock execFile response
function mockExecFile(stdout: string, stderr = "") {
  mockExecFileAsync.mockResolvedValue({ stdout, stderr });
}

function mockExecFileError(error: Error) {
  mockExecFileAsync.mockRejectedValue(error);
}

describe("DaemonClient", () => {
  let client: DaemonClient;
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

    client = new DaemonClient("/workspace", mockChannel);
  });

  describe("getServers", () => {
    it("should parse JSON output from loom servers --json", async () => {
      const jsonOutput = JSON.stringify({
        servers: [
          { name: "github", running: true, description: "GitHub API" },
          { name: "git", running: false, description: "Git operations" },
        ],
      });

      mockExecFile(jsonOutput);

      const servers = await client.getServers();

      expect(servers).toHaveLength(2);
      expect(servers[0].name).toBe("github");
      expect(servers[0].running).toBe(true);
      expect(servers[1].name).toBe("git");
      expect(servers[1].running).toBe(false);
    });

    it("should use cached servers within timeout", async () => {
      const jsonOutput = JSON.stringify({
        servers: [{ name: "github", running: true }],
      });

      mockExecFile(jsonOutput);

      // First call
      await client.getServers();
      const callCount = mockExecFileAsync.mock.calls.length;

      // Second call within cache timeout - should not call execFile again
      const servers = await client.getServers();

      expect(mockExecFileAsync).toHaveBeenCalledTimes(callCount);
      expect(servers).toHaveLength(1);
    });

    it("should force refresh when requested", async () => {
      const jsonOutput = JSON.stringify({
        servers: [{ name: "github", running: true }],
      });

      mockExecFile(jsonOutput);

      // First call
      await client.getServers();
      const callCount = mockExecFileAsync.mock.calls.length;

      // Force refresh
      await client.getServers(true);

      expect(mockExecFileAsync).toHaveBeenCalledTimes(callCount + 1);
    });

    it("should fallback to text parsing when JSON fails", async () => {
      // Set up sequential responses: retries fail, then text parsing succeeds
      const textOutput = `NAME      STATUS    DESCRIPTION
----      ------    -----------
github    running   GitHub API
git       idle      Git operations`;

      // With retry logic: 4 failed JSON attempts (initial + 3 retries), then text succeeds
      mockExecFileAsync
        .mockRejectedValueOnce(new Error("JSON not supported"))
        .mockRejectedValueOnce(new Error("JSON not supported"))
        .mockRejectedValueOnce(new Error("JSON not supported"))
        .mockRejectedValueOnce(new Error("JSON not supported"))
        .mockResolvedValueOnce({ stdout: textOutput, stderr: "" });

      const servers = await client.getServers();

      expect(servers).toHaveLength(2);
      expect(servers[0].name).toBe("github");
      expect(servers[0].running).toBe(true);
    });

    it("should return empty array when daemon is not running", async () => {
      mockExecFileError(new Error("daemon not running"));

      const servers = await client.getServers();

      expect(servers).toEqual([]);
    });
  });

  describe("isDaemonRunning", () => {
    it("should return true when daemon is running", async () => {
      mockExecFile("daemon running on pid 12345");

      const running = await client.isDaemonRunning();

      expect(running).toBe(true);
    });

    it("should return false when daemon is not running", async () => {
      mockExecFileError(new Error("daemon not running"));

      const running = await client.isDaemonRunning();

      expect(running).toBe(false);
    });
  });

  describe("invalidateCache", () => {
    it("should clear cached servers and tools", async () => {
      const jsonOutput = JSON.stringify({
        servers: [{ name: "github", running: true }],
      });

      mockExecFile(jsonOutput);

      // First call to populate cache
      await client.getServers();
      const callCount = mockExecFileAsync.mock.calls.length;

      // Invalidate cache
      client.invalidateCache();

      // Next call should fetch fresh data
      await client.getServers();

      expect(mockExecFileAsync).toHaveBeenCalledTimes(callCount + 1);
    });
  });

  describe("getTools", () => {
    it("should parse tool list output", async () => {
      const toolOutput = `NAME                          DESCRIPTION
----                          -----------
github__list_repos            List GitHub repositories
github__create_issue          Create GitHub issue
prometheus__query             Query Prometheus metrics`;

      mockExecFile(toolOutput);

      const tools = await client.getTools();

      expect(tools).toHaveLength(3);
      expect(tools[0].name).toBe("github__list_repos");
      expect(tools[0].server).toBe("github");
      expect(tools[0].description).toBe("List GitHub repositories");
    });

    it("should use cached tools within timeout", async () => {
      const toolOutput = `NAME                 DESCRIPTION
github__list_repos   List repos`;

      mockExecFile(toolOutput);

      // First call
      await client.getTools();
      const callCount = mockExecFileAsync.mock.calls.length;

      // Second call within cache timeout
      await client.getTools();

      expect(mockExecFileAsync).toHaveBeenCalledTimes(callCount);
    });

    it("should return empty array on error", async () => {
      mockExecFileError(new Error("command failed"));

      const tools = await client.getTools();

      expect(tools).toEqual([]);
    });
  });

  describe("executeTool", () => {
    it("should execute tool and return JSON result", async () => {
      const resultJson = JSON.stringify({ data: [1, 2, 3] });
      mockExecFile(resultJson);

      const result = await client.executeTool("github__list_repos", { limit: 10 });

      expect(result.success).toBe(true);
      expect(result.result).toEqual({ data: [1, 2, 3] });
    });

    it("should return raw output when not JSON", async () => {
      mockExecFile("plain text output");

      const result = await client.executeTool("some_tool", {});

      expect(result.success).toBe(true);
      expect(result.result).toBe("plain text output");
    });

    it("should return error on failure", async () => {
      mockExecFileError(new Error("tool execution failed"));

      const result = await client.executeTool("failing_tool", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("tool execution failed");
    });

    it("should log stderr output", async () => {
      mockExecFile('{"result": "ok"}', "warning: deprecated API");

      await client.executeTool("test_tool", {});

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockChannel.appendLine).toHaveBeenCalledWith(
        expect.stringContaining("warning: deprecated API")
      );
    });
  });

  describe("startServer", () => {
    it("should start server and invalidate cache", async () => {
      mockExecFile("Server started");

      const result = await client.startServer("github");

      expect(result).toBe(true);
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "/usr/local/bin/loom",
        ["servers", "start", "github"],
        expect.any(Object)
      );
    });

    it("should return false on failure", async () => {
      mockExecFileError(new Error("failed to start"));

      const result = await client.startServer("github");

      expect(result).toBe(false);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockChannel.appendLine).toHaveBeenCalledWith(
        expect.stringContaining("Failed to start server")
      );
    });
  });

  describe("stopServer", () => {
    it("should stop server and invalidate cache", async () => {
      mockExecFile("Server stopped");

      const result = await client.stopServer("github");

      expect(result).toBe(true);
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "/usr/local/bin/loom",
        ["servers", "stop", "github"],
        expect.any(Object)
      );
    });

    it("should return false on failure", async () => {
      mockExecFileError(new Error("failed to stop"));

      const result = await client.stopServer("github");

      expect(result).toBe(false);
    });
  });

  describe("restartServer", () => {
    it("should restart server and invalidate cache", async () => {
      mockExecFile("Server restarted");

      const result = await client.restartServer("github");

      expect(result).toBe(true);
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "/usr/local/bin/loom",
        ["servers", "restart", "github"],
        expect.any(Object)
      );
    });

    it("should return false on failure", async () => {
      mockExecFileError(new Error("failed to restart"));

      const result = await client.restartServer("github");

      expect(result).toBe(false);
    });
  });
});
