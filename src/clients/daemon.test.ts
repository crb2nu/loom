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
    // Speed up retry-based tests.
    (client as unknown as { retryConfig: unknown }).retryConfig = {
      maxRetries: 3,
      initialDelayMs: 1,
      maxDelayMs: 2,
      backoffMultiplier: 1,
    };
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
    it("should parse paged JSON tool list output with normalized metadata", async () => {
      const page1 = JSON.stringify({
        page: 1,
        totalPages: 2,
        tools: [
          {
            name: "github__list_repos",
            description: "List GitHub repositories",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
          },
          { name: "github__create_issue", description: "Create GitHub issue" },
        ],
      });
      const page2 = JSON.stringify({
        page: 2,
        total_pages: 2,
        tools: [
          {
            name: "prometheus__query",
            description: "Query Prometheus metrics",
            input_schema: {
              properties: {
                query: { type: "string" },
                limit: { type: "number" },
              },
            },
          },
        ],
      });

      mockExecFileAsync.mockResolvedValueOnce({ stdout: page1, stderr: "" });
      mockExecFileAsync.mockResolvedValueOnce({ stdout: page2, stderr: "" });
      const tools = await client.getTools();

      expect(tools).toHaveLength(3);
      expect(tools[0].name).toBe("github__list_repos");
      expect(tools[0].server).toBe("github");
      expect(tools[0].serverPrefix).toBe("github");
      expect(tools[0].description).toBe("List GitHub repositories");
      expect(tools[0].inputSchema?.type).toBe("object");
      expect(tools[0].inputSchema?.properties).toHaveProperty("query");
      expect(tools[2].inputSchema?.properties).toHaveProperty("limit");
    });

    it("should use cached tools within timeout", async () => {
      const page1 = JSON.stringify({
        page: 1,
        totalPages: 1,
        tools: [{ name: "github__list_repos", description: "List repos" }],
      });
      mockExecFile(page1);

      // First call
      await client.getTools();
      const callCount = mockExecFileAsync.mock.calls.length;

      // Second call within cache timeout
      await client.getTools();

      expect(mockExecFileAsync).toHaveBeenCalledTimes(callCount);
    });

    it("should fallback to text parsing when JSON listing fails", async () => {
      const textOutput = `NAME                          DESCRIPTION
----                          -----------
github__list_repos            List GitHub repositories
prometheus__query             Query Prometheus metrics`;
      // JSON path fails (4 attempts with retry), fallback text succeeds.
      mockExecFileAsync
        .mockRejectedValueOnce(new Error("unknown flag: --json"))
        .mockRejectedValueOnce(new Error("unknown flag: --json"))
        .mockRejectedValueOnce(new Error("unknown flag: --json"))
        .mockRejectedValueOnce(new Error("unknown flag: --json"))
        .mockResolvedValueOnce({ stdout: textOutput, stderr: "" });

      const tools = await client.getTools();

      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe("github__list_repos");
      expect(tools[0].server).toBe("github");
      expect(tools[0].serverPrefix).toBe("github");
      expect(tools[0].inputSchema).toBeUndefined();
    });

    it("should return empty array when both JSON and text listing fail", async () => {
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

    it("should treat top-level JSON error payload as a tool failure", async () => {
      mockExecFile('{"error":"daemon error for tools/call: access denied"}');

      const result = await client.executeTool("github__create_issue", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("access denied");
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

    it("should emit tool execution event on success", async () => {
      const events: Array<{
        toolName: string;
        success: boolean;
      }> = [];
      client.onToolExecution((event) => {
        events.push({ toolName: event.toolName, success: event.success });
      });
      mockExecFile('{"ok":true}');

      await client.executeTool("github__list_repos", { limit: 1 });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ toolName: "github__list_repos", success: true });
    });

    it("should emit tool execution event on failure", async () => {
      const events: Array<{
        toolName: string;
        success: boolean;
      }> = [];
      client.onToolExecution((event) => {
        events.push({ toolName: event.toolName, success: event.success });
      });
      mockExecFileError(new Error("boom"));

      await client.executeTool("failing_tool", {});

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ toolName: "failing_tool", success: false });
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

  describe("daemon lifecycle recovery", () => {
    it("should notify when start daemon recovers after a retry", async () => {
      mockExecFileAsync
        .mockRejectedValueOnce(new Error("temporary start failure"))
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "running", stderr: "" });

      const result = await client.startDaemon();

      expect(result).toBe(true);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("Retrying")
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("recovered and completed start the Loom daemon")
      );
    });

    it("should notify when start daemon exhausts retries", async () => {
      (client as unknown as { retryConfig: unknown }).retryConfig = {
        maxRetries: 1,
        initialDelayMs: 1,
        maxDelayMs: 2,
        backoffMultiplier: 1,
      };
      mockExecFileAsync.mockRejectedValue(new Error("persistent start failure"));

      const result = await client.startDaemon();

      expect(result).toBe(false);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("failed to start the Loom daemon after 2 attempts")
      );
    });
  });
});
