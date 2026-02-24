/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-base-to-string */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockLoadVscodeConfigSnapshot = vi.hoisted(() => vi.fn());

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  promises: {
    readFile: mockReadFile,
  },
}));

vi.mock("../utils/config", () => ({
  loadVscodeConfigSnapshot: mockLoadVscodeConfigSnapshot,
}));

import { SNAPSHOT_STATE_KEY } from "../constants";

import { RegistryProvider } from "./registry";

describe("RegistryProvider", () => {
  let provider: RegistryProvider;
  let hubChangeListener: (() => void) | undefined;

  let mockWorkspaceState: { get: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  let mockHubStatusManager: {
    getStatus: ReturnType<typeof vi.fn>;
    getSettings: ReturnType<typeof vi.fn>;
    onDidChange: ReturnType<typeof vi.fn>;
  };

  const registryYaml = `
version: 9
servers:
  - name: alpha
  - name: beta
`.trim();

  beforeEach(() => {
    vi.clearAllMocks();
    hubChangeListener = undefined;

    mockWorkspaceState = {
      get: vi.fn(() => undefined),
      update: vi.fn(async () => undefined),
    };

    mockHubStatusManager = {
      getStatus: vi.fn(() => ({
        health: { status: "ok", sessions: 3 },
        readiness: { ready: true, servers: 2 },
        servers: [{ name: "alpha" }, { name: "hub-only" }],
        lastUpdated: new Date("2026-02-01T00:00:00.000Z"),
      })),
      getSettings: vi.fn(() => ({
        hubUrl: "wss://mcp.example.com/ws",
        profile: "codex",
        cfAccessClientId: "id",
        cfAccessClientSecret: "secret",
      })),
      onDidChange: vi.fn((callback: () => void) => {
        hubChangeListener = callback;
        return { dispose: vi.fn() };
      }),
    };

    mockReadFile.mockResolvedValue(registryYaml);
    mockLoadVscodeConfigSnapshot.mockResolvedValue({
      source: "/workspace/.vscode/mcp.json",
      serverNames: ["alpha", "config-only"],
      hubRouted: ["alpha"],
      localRouted: ["config-only"],
    });
    mockExistsSync.mockReturnValue(false);

    provider = new RegistryProvider(
      "/workspace",
      "/workspace/mcp/context/registry.yaml",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockWorkspaceState as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockHubStatusManager as any
    );
  });

  it("builds summary when registry is available", async () => {
    const summary = await provider.getSummary();
    expect(summary).toContain("registry loaded (2 servers)");
    expect(summary).toContain("2 VS Code servers (1 hub)");
    expect(summary).toContain("hub ok");
  });

  it("reports missing registry in summary", async () => {
    mockReadFile.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENOENT" }));
    provider.refresh();
    const summary = await provider.getSummary();
    expect(summary).toContain("registry not found");
  });

  it("builds tree items including gap diagnostics and open commands", async () => {
    const items = await provider.getChildren();
    const labels = items.map((item) => String(item.label));

    expect(labels).toContain("Hub status: ok (3 sessions)");
    expect(labels).toContain("Hub URL: wss://mcp.example.com/ws");
    expect(labels).toContain("Profile: codex");
    expect(labels).toContain("Cloudflare Access: configured");
    expect(labels).toContain("Gateway ready (2 servers)");
    expect(labels).toContain("Registry version 9");
    expect(labels).toContain("2 server definitions");
    expect(labels).toContain("VS Code config: 2 servers (1 hub / 1 local)");
    expect(labels).toContain("Registry → hub gaps: beta");
    expect(labels).toContain("Registry → VS Code gaps: beta");
    expect(labels).toContain("VS Code-only servers: config-only");
    expect(labels).toContain("Last snapshot: not captured");
    expect(labels).toContain("Open registry.yaml");
    expect(labels).toContain("Open .vscode/mcp.json");
  });

  it("shows missing-registry item when file is not found", async () => {
    mockReadFile.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENOENT" }));
    provider.refresh();

    const items = await provider.getChildren();
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("registry.yaml not found");
  });

  it("shows generated config open item when VS Code config is missing but generated file exists", async () => {
    mockLoadVscodeConfigSnapshot.mockResolvedValueOnce(null);
    mockExistsSync.mockReturnValueOnce(true);
    provider.refresh();

    const items = await provider.getChildren();
    const labels = items.map((item) => String(item.label));
    expect(labels).toContain("VS Code config: not found (run sync to generate)");
    expect(labels).toContain("Open generated/mcp/vscode/mcp.json");
  });

  it("records snapshot timestamp and persists state key", async () => {
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);

    provider.setLastSnapshot("2026-02-23T20:00:00.000Z");
    expect(mockWorkspaceState.update).toHaveBeenCalledWith(
      SNAPSHOT_STATE_KEY,
      "2026-02-23T20:00:00.000Z"
    );
    expect(listener).toHaveBeenCalled();

    const items = await provider.getChildren();
    const snapshotItem = items.find((item) => String(item.label).startsWith("Last snapshot:"));
    expect(String(snapshotItem?.label)).toContain("Last snapshot: Last:");
    expect(snapshotItem?.command?.command).toBe("loom.snapshotContext");
  });

  it("returns cached registry data until refresh clears cache", async () => {
    await provider.getRegistrySnapshot();
    await provider.getRegistrySnapshot();
    expect(mockReadFile).toHaveBeenCalledTimes(1);

    provider.refresh();
    await provider.getRegistrySnapshot();
    expect(mockReadFile).toHaveBeenCalledTimes(2);
  });

  it("handles non-ENOENT read errors by surfacing a user-visible message", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("permission denied"));
    provider.refresh();

    await provider.getRegistrySnapshot();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Failed to read registry.yaml: permission denied")
    );
  });

  it("refreshes when hub status emits a change", () => {
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);

    hubChangeListener?.();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
