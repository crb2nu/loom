import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

const mockExecFileAsync = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: () => mockExecFileAsync,
}));

vi.mock("../utils/binary", () => ({
  resolveLoomBinary: vi.fn(() => "/usr/local/bin/loom"),
}));

import { AgentContextClient } from "./agentContext";

describe("AgentContextClient", () => {
  let client: AgentContextClient;
  let mockChannel: vscode.OutputChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileAsync.mockReset();

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

    client = new AgentContextClient("/workspace", mockChannel, "test-agent");
  });

  describe("startSession", () => {
    it("should call MCP tool with correct args", async () => {
      const session = {
        session_id: "sess-1",
        namespace: "test/feature",
        agent_id: "test-agent",
        status: "active",
        started_at: new Date().toISOString(),
        entry_count: 0,
      };

      mockExecFileAsync.mockResolvedValueOnce({
        stdout: JSON.stringify(session),
        stderr: "",
      });

      const result = await client.startSession("test/feature", "Working on X");

      expect(result).not.toBeNull();
      expect(result!.session_id).toBe("sess-1");
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "/usr/local/bin/loom",
        [
          "tools",
          "call",
          "agent_session_start",
          "--args",
          expect.stringContaining('"namespace":"test/feature"'),
        ],
        expect.any(Object)
      );
    });

    it("should return null on error", async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error("command failed"));

      const result = await client.startSession("test/ns");

      expect(result).toBeNull();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockChannel.appendLine).toHaveBeenCalledWith(
        expect.stringContaining("MCP tool error")
      );
    });
  });

  describe("endSession", () => {
    it("should end session and return success", async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: JSON.stringify({ success: true }),
        stderr: "",
      });

      const result = await client.endSession("sess-1", true);

      expect(result).toBe(true);
    });

    it("should return false on error", async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error("failed"));

      const result = await client.endSession("sess-1");

      expect(result).toBe(false);
    });
  });

  describe("listSessions", () => {
    it("should list sessions", async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: JSON.stringify({
          sessions: [
            { session_id: "s1", namespace: "test", status: "active", entry_count: 3 },
          ],
        }),
        stderr: "",
      });

      const result = await client.listSessions();

      expect(result).toHaveLength(1);
      expect(result[0].session_id).toBe("s1");
    });

    it("should return empty array on error", async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error("failed"));

      const result = await client.listSessions();

      expect(result).toEqual([]);
    });
  });

  describe("addContextEntries", () => {
    it("should add context entries", async () => {
      const entries = [
        {
          entry_id: "entry-1",
          session_id: "sess-1",
          entry_type: "decision",
          title: "Chose approach A",
          content: "Because...",
          created_at: new Date().toISOString(),
        },
      ];

      mockExecFileAsync.mockResolvedValueOnce({
        stdout: JSON.stringify({ entries }),
        stderr: "",
      });

      const result = await client.addContextEntries("sess-1", [
        { entry_type: "decision", title: "Chose approach A", content: "Because..." },
      ]);

      expect(result).toHaveLength(1);
    });
  });

  describe("listTasks", () => {
    it("should list tasks for session", async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: JSON.stringify({
          tasks: [
            {
              task_id: "t1",
              session_id: "sess-1",
              title: "Fix bug",
              priority: "high",
              status: "pending",
            },
          ],
        }),
        stderr: "",
      });

      const result = await client.listTasks("sess-1");

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Fix bug");
    });

    it("should return empty array on error", async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error("failed"));

      const result = await client.listTasks();

      expect(result).toEqual([]);
    });
  });

  describe("error logging", () => {
    it("should log tool invocations", async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: JSON.stringify({ sessions: [] }),
        stderr: "",
      });

      await client.listSessions();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockChannel.appendLine).toHaveBeenCalledWith(
        expect.stringContaining("MCP tool: agent_session_list")
      );
    });

    it("should log tool errors with name", async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error("oops"));

      await client.startSession("ns");

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockChannel.appendLine).toHaveBeenCalledWith(
        expect.stringContaining("MCP tool error (agent_session_start)")
      );
    });
  });
});
