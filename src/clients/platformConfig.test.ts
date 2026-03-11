import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";

type ExecFileResult = { stdout: string; stderr: string };
type ExecFileCallback = (error: Error | null, result?: ExecFileResult) => void;

const mockAccess = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockCopyFile = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockExecFile = vi.hoisted(() => vi.fn());
const mockGetEnabledPlatforms = vi.hoisted(() => vi.fn(() => ["vscode", "claude"]));

vi.mock("child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  promises: {
    access: mockAccess,
    readFile: mockReadFile,
    copyFile: mockCopyFile,
    mkdir: mockMkdir,
  },
}));

vi.mock("os", () => ({
  homedir: () => "/home/testuser",
}));

vi.mock("../utils/binary", () => ({
  resolveLoomBinary: vi.fn(() => "/usr/local/bin/loom"),
}));

vi.mock("../utils/platform", () => ({
  getEnabledPlatforms: mockGetEnabledPlatforms,
  PLATFORMS: {
    vscode: {
      type: "vscode",
      displayName: "VS Code",
      configFormat: "json",
      repoConfigPath: ".vscode/mcp.json",
      homeConfigPath: ".vscode/mcp.json",
      icon: "code",
      description: "VS Code",
    },
    claude: {
      type: "claude",
      displayName: "Claude",
      configFormat: "json",
      repoConfigPath: ".claude/mcp.json",
      homeConfigPath: ".claude/mcp.json",
      icon: "comment-discussion",
      description: "Claude",
    },
  },
}));

import { PlatformConfigClient } from "./platformConfig";

describe("PlatformConfigClient", () => {
  let client: PlatformConfigClient;
  let mockChannel: vscode.OutputChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    mockReadFile.mockResolvedValue('{"mcpServers":{"github":{},"gitlab":{}}}');
    mockCopyFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);

    mockExecFile.mockImplementation(
      (_: string, args: string[], __: unknown, cb: ExecFileCallback) => {
        const command = args.join(" ");

        if (command === "doctor --json") {
          cb(null, {
            stdout: JSON.stringify({
              ok: true,
              platforms: [
                {
                  platform: "vscode",
                  hooks: "n/a",
                  perms: "n/a",
                  schema: "n/a",
                  status: "healthy",
                },
                {
                  platform: "claude",
                  hooks: "ok",
                  perms: "ok",
                  schema: "ok",
                  status: "healthy",
                },
              ],
              env_warnings: [],
            }),
            stderr: "",
          });
          return;
        }

        if (
          command === "sync vscode --regen" ||
          command === "pull vscode" ||
          command === "sync vscode --regen --repo-only"
        ) {
          cb(null, { stdout: "ok", stderr: "" });
          return;
        }

        cb(new Error(`unexpected command: ${command}`), {
          stdout: "",
          stderr: "",
        });
      }
    );

    mockChannel = {
      name: "Platform config tests",
      append: vi.fn(),
      appendLine: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      replace: vi.fn(),
    } as unknown as vscode.OutputChannel;

    const mockConfig = {
      get: vi.fn(() => undefined),
      has: vi.fn(() => false),
      inspect: vi.fn(() => undefined),
      update: vi.fn(),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    client = new PlatformConfigClient("/workspace", mockChannel);
  });

  afterEach(() => {
    client.dispose();
  });

  it("returns empty configs initially", () => {
    expect(client.getConfigs()).toEqual([]);
  });

  it("loads doctor-backed sync status for enabled platforms", async () => {
    mockAccess.mockResolvedValue(undefined);

    await client.checkAllSyncStatus();

    const configs = client.getConfigs();
    expect(configs).toHaveLength(2);
    expect(client.getConfig("vscode")?.syncStatus).toBe("synced");
    expect(client.getConfig("claude")?.doctor?.schema).toBe("ok");
  });

  it("marks platforms missing when repo and home configs are absent", async () => {
    await client.checkAllSyncStatus();

    expect(client.getConfig("vscode")?.syncStatus).toBe("missing");
  });

  it("runs loom sync for platform sync operations", async () => {
    mockAccess.mockResolvedValue(undefined);

    const result = await client.syncPlatform("vscode");

    expect(result.success).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      "/usr/local/bin/loom",
      ["sync", "vscode", "--regen"],
      expect.any(Object),
      expect.anything()
    );
  });

  it("runs loom pull for reverse sync", async () => {
    mockAccess.mockResolvedValue(undefined);

    const result = await client.pullFromHome("vscode");

    expect(result.success).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      "/usr/local/bin/loom",
      ["pull", "vscode"],
      expect.any(Object),
      expect.anything()
    );
  });

  it("runs repo-only regeneration for platform configs", async () => {
    mockAccess.mockResolvedValue(undefined);

    const result = await client.regenerateConfig("vscode");

    expect(result.success).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      "/usr/local/bin/loom",
      ["sync", "vscode", "--regen", "--repo-only"],
      expect.any(Object),
      expect.anything()
    );
  });

  it("returns a cached doctor report", async () => {
    const report = await client.getDoctorReport();

    expect(report?.ok).toBe(true);
    expect(report?.platforms[0]?.platform).toBe("vscode");
  });

  it("backs up repo and home configs for enabled platforms", async () => {
    mockAccess.mockResolvedValue(undefined);

    const backupDir = await client.backupConfigs();

    expect(backupDir).toContain(".loom-backup");
    expect(mockCopyFile).toHaveBeenCalled();
  });
});
