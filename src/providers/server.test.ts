/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-base-to-string */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

import { ServerProvider } from "./server";

describe("ServerProvider", () => {
  let provider: ServerProvider;
  let hubChangeListener: (() => void) | undefined;

  const registrySnapshot = {
    servers: [
      {
        name: "running",
        common: {
          description: "Running server",
          command: "loom",
          args: ["mcp-running", "--flag", "value with spaces"],
          timeout: 15,
          hint: "registry hint",
        },
        categories: ["core", "fast"],
      },
      {
        name: "both-no-daemon",
        common: {
          description: "Hub+registry only",
        },
      },
      {
        name: "registry-only",
        common: {
          description: "Only in registry",
        },
      },
    ],
  };

  let mockRegistryProvider: { getRegistrySnapshot: ReturnType<typeof vi.fn> };
  let mockHubStatusManager: {
    getStatus: ReturnType<typeof vi.fn>;
    onDidChange: ReturnType<typeof vi.fn>;
  };
  let mockDaemonClient: {
    getServers: ReturnType<typeof vi.fn>;
    invalidateCache: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    hubChangeListener = undefined;

    mockRegistryProvider = {
      getRegistrySnapshot: vi.fn(async () => registrySnapshot),
    };

    mockHubStatusManager = {
      getStatus: vi.fn(() => ({
        servers: [
          {
            name: "running",
            description: "Hub running description",
            categories: ["hub"],
          },
          {
            name: "both-no-daemon",
            description: "Hub/registry overlap",
          },
          {
            name: "hub-only",
            description: "Only in hub",
          },
        ],
      })),
      onDidChange: vi.fn((callback: () => void) => {
        hubChangeListener = callback;
        return { dispose: vi.fn() };
      }),
    };

    mockDaemonClient = {
      getServers: vi.fn(async () => [
        {
          name: "running",
          description: "Daemon running description",
          running: true,
        },
        {
          name: "idle-only",
          description: "Daemon idle description",
          running: false,
        },
      ]),
      invalidateCache: vi.fn(),
    };

    provider = new ServerProvider(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockRegistryProvider as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockHubStatusManager as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockDaemonClient as any
    );
  });

  it("returns placeholder when no servers are discovered", async () => {
    mockRegistryProvider.getRegistrySnapshot.mockResolvedValueOnce({ servers: [] });
    mockHubStatusManager.getStatus.mockReturnValueOnce({ servers: [] });
    mockDaemonClient.getServers.mockResolvedValueOnce([]);

    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0].label).toBe("No MCP servers detected");
    expect((children[0].iconPath as vscode.ThemeIcon).id).toBe("info");
  });

  it("returns empty children for nested node requests", async () => {
    const parent = new vscode.TreeItem("parent", vscode.TreeItemCollapsibleState.None);
    await expect(provider.getChildren(parent)).resolves.toEqual([]);
  });

  it("builds server items with status-specific icon and tooltip details", async () => {
    const children = await provider.getChildren();
    const byName = new Map(children.map((item) => [String(item.label), item]));

    const running = byName.get("running");
    const idle = byName.get("idle-only");
    const bothNoDaemon = byName.get("both-no-daemon");
    const registryOnly = byName.get("registry-only");
    const hubOnly = byName.get("hub-only");

    expect(running).toBeDefined();
    expect((running?.iconPath as vscode.ThemeIcon).id).toBe("circle-filled");
    expect(String(running?.description)).toContain("running");
    expect((running?.tooltip as vscode.MarkdownString).value).toContain("Registry command");
    expect((running?.tooltip as vscode.MarkdownString).value).toContain("Hub categories: hub");

    expect(idle).toBeDefined();
    expect((idle?.iconPath as vscode.ThemeIcon).id).toBe("circle-outline");
    expect(String(idle?.description)).toContain("idle");

    expect(bothNoDaemon).toBeDefined();
    expect((bothNoDaemon?.iconPath as vscode.ThemeIcon).id).toBe("plug");

    expect(registryOnly).toBeDefined();
    expect((registryOnly?.iconPath as vscode.ThemeIcon).id).toBe("warning");
    expect(String(registryOnly?.description)).toContain("Only in registry");

    expect(hubOnly).toBeDefined();
    expect((hubOnly?.iconPath as vscode.ThemeIcon).id).toBe("question");
    expect(String(hubOnly?.description)).toContain("Only in hub");
    expect((hubOnly?.tooltip as vscode.MarkdownString).value).toContain("Registry: entry missing");
  });

  it("refreshes on explicit call and hub status changes", () => {
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);

    provider.refresh();
    expect(mockDaemonClient.invalidateCache).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);

    hubChangeListener?.();
    expect(mockDaemonClient.invalidateCache).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("returns element from getTreeItem unchanged", async () => {
    const [first] = await provider.getChildren();
    expect(provider.getTreeItem(first)).toBe(first);
  });
});
