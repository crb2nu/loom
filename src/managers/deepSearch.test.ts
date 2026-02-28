import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { DaemonClient } from "../clients/daemon";
import { DaemonToolInfo } from "../types";

import { DeepSearchManager } from "./deepSearch";

describe("DeepSearchManager", () => {
  let manager: DeepSearchManager;
  let channel: vscode.OutputChannel;
  let tools: DaemonToolInfo[];
  let daemonClient: {
    getTools: ReturnType<typeof vi.fn>;
    executeTool: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    channel = {
      name: "DeepSearch tests",
      append: vi.fn(),
      appendLine: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      replace: vi.fn(),
    } as unknown as vscode.OutputChannel;

    tools = [];
    daemonClient = {
      getTools: vi.fn(() => Promise.resolve(tools)),
      executeTool: vi.fn(() => Promise.resolve({ success: true, result: { items: [] } })),
    };
    manager = new DeepSearchManager(daemonClient as unknown as DaemonClient, channel);
  });

  it("discovers search-capable tools from known configs and input schema", async () => {
    tools = [
      {
        name: "tavily__search",
        server: "tavily",
        serverPrefix: "tavily",
      },
      {
        name: "custom__semantic_lookup",
        server: "custom",
        serverPrefix: "custom",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
          },
        },
      },
      {
        name: "custom__status",
        server: "custom",
        serverPrefix: "custom",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
      },
    ];

    const searchTools = await manager.getSearchTools();

    expect(searchTools.map((tool) => tool.name)).toEqual([
      "tavily__search",
      "custom__semantic_lookup",
    ]);
  });

  it("executes schema-derived search tools with detected query and limit params", async () => {
    tools = [
      {
        name: "custom__semantic_lookup",
        server: "custom",
        serverPrefix: "custom",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
          },
        },
      },
    ];

    const results = await manager.search("vector index", { parallel: false, maxResults: 7 });

    expect(daemonClient.executeTool).toHaveBeenCalledWith("custom__semantic_lookup", {
      query: "vector index",
      limit: 7,
    });
    expect(results[0].status).toBe("ok");
    expect(results[0].resultCount).toBe(0);
    expect(results[0].snippet).toBeUndefined();
  });

  it("uses known family adapters for gitlab search arguments", async () => {
    tools = [
      {
        name: "gitlab__search_repositories",
        server: "gitlab",
        serverPrefix: "gitlab",
      },
    ];

    await manager.search("loom", { parallel: false, maxResults: 4 });

    expect(daemonClient.executeTool).toHaveBeenCalledWith("gitlab__search_repositories", {
      search: "loom",
      per_page: 4,
    });
  });
});
