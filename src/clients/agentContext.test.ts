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

function toolResponse(text: string, isError = false): { stdout: string; stderr: string } {
  return {
    stdout: JSON.stringify({
      content: [{ type: "text", text }],
      ...(isError ? { isError: true } : {}),
    }),
    stderr: "",
  };
}

function jsonResponse(payload: unknown): { stdout: string; stderr: string } {
  return {
    stdout: JSON.stringify(payload),
    stderr: "",
  };
}

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
    it("should call MCP tool with new prefixed tool name and parse response", async () => {
      mockExecFileAsync.mockResolvedValueOnce(
        toolResponse(
          [
            "active_agents: 1",
            "agent_id: test-agent",
            "namespace: test/feature",
            "ok: true",
            "session_id: sess-1",
            'started_at: "2026-02-24T18:00:00Z"',
          ].join("\n")
        )
      );

      const result = await client.startSession("test/feature", "Working on X");

      expect(result).not.toBeNull();
      expect(result?.session_id).toBe("sess-1");
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "/usr/local/bin/loom",
        [
          "tools",
          "call",
          "agent_context__agent_session_start",
          "--json",
          "--args",
          expect.stringContaining('"namespace":"test/feature"'),
        ],
        expect.any(Object)
      );
    });

    it("should return null on tool-level error response", async () => {
      mockExecFileAsync.mockResolvedValueOnce(toolResponse("session_id: is required", true));

      const result = await client.startSession("test/ns");

      expect(result).toBeNull();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockChannel.appendLine).toHaveBeenCalledWith(
        expect.stringContaining("MCP tool error")
      );
    });

    it("should treat top-level JSON error payload as a failure", async () => {
      mockExecFileAsync.mockResolvedValueOnce(
        jsonResponse({ error: "daemon error for tools/call" })
      );

      const result = await client.startSession("test/ns");

      expect(result).toBeNull();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockChannel.appendLine).toHaveBeenCalledWith(
        expect.stringContaining("daemon error for tools/call")
      );
    });

    it("should fall back to unprefixed tool name when prefixed tool is unavailable", async () => {
      mockExecFileAsync
        .mockResolvedValueOnce(
          toolResponse("tool agent_context__agent_session_start not found", true)
        )
        .mockResolvedValueOnce(
          jsonResponse({
            session_id: "legacy-sess-1",
            namespace: "test/feature",
            agent_id: "test-agent",
            started_at: "2026-02-24T18:00:00Z",
            status: "active",
            entry_count: 0,
          })
        );

      const result = await client.startSession("test/feature", "Working on X");

      expect(result?.session_id).toBe("legacy-sess-1");
      expect(mockExecFileAsync).toHaveBeenCalledTimes(2);
      expect(mockExecFileAsync).toHaveBeenNthCalledWith(
        1,
        "/usr/local/bin/loom",
        expect.arrayContaining(["agent_context__agent_session_start"]),
        expect.any(Object)
      );
      expect(mockExecFileAsync).toHaveBeenNthCalledWith(
        2,
        "/usr/local/bin/loom",
        expect.arrayContaining(["agent_session_start"]),
        expect.any(Object)
      );
    });
  });

  describe("endSession", () => {
    it("should end session and return true when ok=true", async () => {
      mockExecFileAsync.mockResolvedValueOnce(toolResponse("ok: true"));

      const result = await client.endSession("sess-1", true);

      expect(result).toBe(true);
    });

    it("should return false on execution error", async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error("failed"));

      const result = await client.endSession("sess-1");

      expect(result).toBe(false);
    });

    it("should treat legacy success=true response as success", async () => {
      mockExecFileAsync.mockResolvedValueOnce(jsonResponse({ success: true }));

      const result = await client.endSession("sess-1");

      expect(result).toBe(true);
    });
  });

  describe("listSessions", () => {
    it("should parse session rows from indexed payload", async () => {
      mockExecFileAsync.mockResolvedValueOnce(
        toolResponse(
          [
            "count: 1",
            "ok: true",
            "sessions[1]:",
            "  -",
            "    id: s1",
            "    namespace: test",
            "    agent_id: test-agent",
            '    started_at: "2026-02-24T18:00:00Z"',
            "    status: active",
            "    entry_count: 3",
          ].join("\n")
        )
      );

      const result = await client.listSessions();

      expect(result).toHaveLength(1);
      expect(result[0].session_id).toBe("s1");
      expect(result[0].entry_count).toBe(3);
    });

    it("should return empty array on error", async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error("failed"));

      const result = await client.listSessions();

      expect(result).toEqual([]);
    });

    it("should retry without --json when daemon does not support it", async () => {
      mockExecFileAsync
        .mockRejectedValueOnce(new Error("unknown flag: --json"))
        .mockResolvedValueOnce(
          toolResponse(
            [
              "count: 1",
              "ok: true",
              "tasks[1]{id,session_id,agent_id,namespace,title,priority,status,created_at,updated_at,token_count}:",
              '  t1,sess-1,test-agent,test/ns,Fix bug,high,pending,"2026-02-24T18:00:00Z","2026-02-24T18:01:00Z",5',
            ].join("\n")
          )
        );

      const result = await client.listTasks("sess-1");

      expect(result).toHaveLength(1);
      expect(mockExecFileAsync).toHaveBeenCalledTimes(2);
      expect(mockExecFileAsync).toHaveBeenNthCalledWith(
        1,
        "/usr/local/bin/loom",
        expect.arrayContaining(["--json"]),
        expect.any(Object)
      );
      expect(mockExecFileAsync).toHaveBeenNthCalledWith(
        2,
        "/usr/local/bin/loom",
        expect.not.arrayContaining(["--json"]),
        expect.any(Object)
      );
    });
  });

  describe("addContextEntries", () => {
    it("should return created entries with ids from response", async () => {
      mockExecFileAsync.mockResolvedValueOnce(
        toolResponse("count: 1\nentry_ids[1]: entry-1\nok: true")
      );

      const result = await client.addContextEntries("sess-1", [
        { entry_type: "decision", title: "Chose approach A", content: "Because..." },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].entry_id).toBe("entry-1");
      expect(result[0].session_id).toBe("sess-1");
    });
  });

  describe("recallEnhanced", () => {
    it("should prefer agent_recall for context retrieval", async () => {
      mockExecFileAsync.mockResolvedValueOnce(
        jsonResponse({
          entries: [
            {
              entry_id: "entry-1",
              session_id: "sess-1",
              entry_type: "decision",
              title: "Use doctor",
              content: "doctor report is canonical",
              created_at: "2026-02-24T18:00:00Z",
            },
          ],
          tasks: [
            {
              task_id: "task-1",
              session_id: "sess-1",
              title: "Update extension",
              status: "in_progress",
              priority: "high",
              created_at: "2026-02-24T18:00:00Z",
              updated_at: "2026-02-24T18:01:00Z",
            },
          ],
        })
      );

      const result = await client.recallEnhanced("doctor", "/workspace/src/extension.ts", "loom");

      expect(result.entries).toHaveLength(1);
      expect(result.decisions).toHaveLength(1);
      expect(result.tasks[0]?.task_id).toBe("task-1");
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "/usr/local/bin/loom",
        [
          "tools",
          "call",
          "agent_context__agent_recall",
          "--json",
          "--args",
          expect.stringContaining('"scope":"context"'),
        ],
        expect.any(Object)
      );
    });
  });

  describe("listTasks", () => {
    it("should parse task table rows", async () => {
      mockExecFileAsync.mockResolvedValueOnce(
        toolResponse(
          [
            "count: 1",
            "ok: true",
            "tasks[1]{id,session_id,agent_id,namespace,title,priority,status,created_at,updated_at,token_count}:",
            '  t1,sess-1,test-agent,test/ns,Fix bug,high,pending,"2026-02-24T18:00:00Z","2026-02-24T18:01:00Z",5',
          ].join("\n")
        )
      );

      const result = await client.listTasks("sess-1");

      expect(result).toHaveLength(1);
      expect(result[0].task_id).toBe("t1");
      expect(result[0].title).toBe("Fix bug");
      expect(result[0].priority).toBe("high");
    });

    it("should return empty array on error", async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error("failed"));

      const result = await client.listTasks();

      expect(result).toEqual([]);
    });
  });

  describe("annotations and memory", () => {
    it("should prefer agent_context_add when creating annotations", async () => {
      mockExecFileAsync.mockResolvedValueOnce(
        jsonResponse({ entry_ids: ["entry-annotation-1"], ok: true })
      );

      const result = await client.addAnnotation("sess-1", {
        file_path: "/workspace/src/file.ts",
        line_start: 10,
        line_end: 12,
        annotation_type: "warning",
        content: "Investigate drift",
      });

      expect(result?.annotation_id).toBe("entry-annotation-1");
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "/usr/local/bin/loom",
        [
          "tools",
          "call",
          "agent_context__agent_context_add",
          "--json",
          "--args",
          expect.stringContaining('"entry_type":"annotation"'),
        ],
        expect.any(Object)
      );
    });

    it("should prefer agent_recall for memory tiers", async () => {
      mockExecFileAsync
        .mockResolvedValueOnce(
          jsonResponse({
            working_memory: { item_count: 1, token_count: 15 },
            short_term_memory: { item_count: 0, token_count: 0 },
            long_term_memory: { item_count: 1, token_count: 25 },
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            items: [
              {
                id: "mem-1",
                session_id: "sess-1",
                tier: "working",
                category: "decision",
                title: "Current note",
                content: "working memory entry",
                created_at: "2026-02-24T18:00:00Z",
              },
              {
                id: "mem-2",
                session_id: "sess-1",
                tier: "long_term",
                category: "insight",
                title: "Archived note",
                content: "long term memory entry",
                created_at: "2026-02-24T18:00:00Z",
              },
            ],
          })
        );

      const result = await client.getMemoryTiers("sess-1");

      expect(result).toHaveLength(3);
      expect(result[0]?.entries[0]?.entry_id).toBe("mem-1");
      expect(result[2]?.entries[0]?.entry_id).toBe("mem-2");
      expect(mockExecFileAsync).toHaveBeenNthCalledWith(
        2,
        "/usr/local/bin/loom",
        [
          "tools",
          "call",
          "agent_context__agent_recall",
          "--json",
          "--args",
          expect.stringContaining('"scope":"memory"'),
        ],
        expect.any(Object)
      );
    });
  });

  describe("error logging", () => {
    it("should log prefixed tool invocations", async () => {
      mockExecFileAsync.mockResolvedValueOnce(toolResponse("count: 0\nok: true\nsessions[0]:"));

      await client.listSessions();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockChannel.appendLine).toHaveBeenCalledWith(
        expect.stringContaining("MCP tool: agent_context__agent_session_list")
      );
    });

    it("should log tool execution errors with original tool name", async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error("oops"));

      await client.startSession("ns");

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockChannel.appendLine).toHaveBeenCalledWith(
        expect.stringContaining("MCP tool error (agent_context__agent_session_start)")
      );
    });
  });
});
