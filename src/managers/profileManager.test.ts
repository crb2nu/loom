/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

type ExecFileResult = { stdout: string; stderr: string };
type ExecFileCallback = (error: Error | null, result?: ExecFileResult) => void;

const mockGetEnabledPlatforms = vi.hoisted(() => vi.fn(() => ["vscode", "codex"]));
const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock("../utils/platform", () => ({
  getEnabledPlatforms: mockGetEnabledPlatforms,
}));

vi.mock("../utils/binary", () => ({
  resolveLoomBinary: vi.fn(() => "/mock/bin/loom"),
}));

vi.mock("child_process", () => ({
  execFile: mockExecFile,
}));

import { DaemonClient } from "../clients/daemon";
import { ConfigManager } from "../utils/configManager";

import { ProfileManager } from "./profileManager";

describe("ProfileManager", () => {
  let manager: ProfileManager;
  let doctorJsonAvailable: boolean;
  let runtimeProfileState: {
    active?: string;
    available?: string[];
    toolCount?: number;
  } | null;
  let configStore: {
    activeProfile: string;
    enabledPlatforms: string[];
    profiles: Record<string, unknown>;
  };

  let mockConfigManager: ConfigManager;
  let mockConfigSet: ReturnType<typeof vi.fn>;
  let mockDaemonClient: DaemonClient;
  let mockGetRuntimeProfileState: ReturnType<typeof vi.fn>;
  let mockHubStatusManager: { getStatus: ReturnType<typeof vi.fn> };
  let mockChannel: vscode.OutputChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    (ProfileManager as unknown as { warnedDeprecatedProfiles: boolean }).warnedDeprecatedProfiles =
      false;

    configStore = {
      activeProfile: "dev",
      enabledPlatforms: ["vscode", "codex"],
      profiles: { legacy: { servers: ["shared"] } },
    };
    doctorJsonAvailable = true;
    runtimeProfileState = {
      active: "dev",
      available: ["dev", "full", "research"],
      toolCount: 52,
    };

    mockConfigSet = vi.fn(async (key: string, value: unknown) => {
      configStore[key as keyof typeof configStore] = value as never;
    });

    mockConfigManager = {
      get: vi.fn((key: string) => configStore[key as keyof typeof configStore]),
      set: mockConfigSet,
    } as unknown as ConfigManager;

    mockGetRuntimeProfileState = vi.fn(async () => runtimeProfileState);
    mockDaemonClient = {
      getServers: vi.fn(async () => [
        { name: "git", running: true },
        { name: "local-only", running: true },
      ]),
      getRuntimeProfileState: mockGetRuntimeProfileState,
    } as unknown as DaemonClient;

    mockHubStatusManager = {
      getStatus: vi.fn(() => ({
        servers: [{ name: "git" }, { name: "hub-only" }],
        health: { status: "ok" },
      })),
    };

    mockChannel = {
      name: "Profile tests",
      append: vi.fn(),
      appendLine: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      replace: vi.fn(),
    } as unknown as vscode.OutputChannel;

    mockExecFile.mockImplementation(
      (_: string, args: string[], __: unknown, cb: ExecFileCallback) => {
        const command = args.join(" ");
        if (command === "doctor --json") {
          if (!doctorJsonAvailable) {
            cb(new Error("doctor unavailable"), {
              stdout: "",
              stderr: "",
            });
            return;
          }

          cb(null, {
            stdout: JSON.stringify({
              template_profiles: [
                { profile: "dev", ok: true, count: 2, unresolved: [] },
                { profile: "full", ok: true, count: 0, unresolved: [] },
                { profile: "research", ok: true, count: 1, unresolved: [] },
              ],
            }),
            stderr: "",
          });
          return;
        }

        if (command === "profile list") {
          cb(null, {
            stdout: [
              "Available profiles:",
              "  dev          Core development tools for coding workflows (max 50 tools)",
              "  full         All available tools with smart prioritization (max 500 tools)",
              "  research     Web search and content extraction (max 20 tools)",
              "",
            ].join("\n"),
            stderr: "",
          });
          return;
        }

        if (command === "profile show dev") {
          cb(null, {
            stdout: [
              "Profile: dev",
              "Description: Core development tools for coding workflows",
              "Max Tools: 50",
              "Servers: [mcp-git mcp-gitlab]",
              "Categories: [version-control search]",
              "",
            ].join("\n"),
            stderr: "",
          });
          return;
        }

        if (command === "profile show full") {
          cb(null, {
            stdout: [
              "Profile: full",
              "Description: All available tools with smart prioritization",
              "Max Tools: 500",
              "Servers: [*]",
              "",
            ].join("\n"),
            stderr: "",
          });
          return;
        }

        if (command === "profile show research") {
          cb(null, {
            stdout: ["Profile: research", ""].join("\n"),
            stderr: "",
          });
          return;
        }

        cb(new Error(`unexpected command: ${command}`), {
          stdout: "",
          stderr: "",
        });
      }
    );

    manager = new ProfileManager(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockHubStatusManager as any,
      mockDaemonClient,
      "/workspace",
      mockChannel,
      mockConfigManager
    );
  });

  it("prefers runtime resource profile state over legacy text parsing", async () => {
    const profiles = await manager.getProfiles();

    expect(profiles.map((profile) => profile.name)).toEqual(["dev", "full", "research"]);
    expect(manager.getActiveProfileName()).toBe("dev");
    expect(mockGetRuntimeProfileState).toHaveBeenCalled();
    expect(
      mockExecFile.mock.calls.some(
        ([command, args]) =>
          command === "/mock/bin/loom" && Array.isArray(args) && args.join(" ") === "doctor --json"
      )
    ).toBe(true);
    expect(
      mockExecFile.mock.calls.some(
        ([command, args]) =>
          command === "/mock/bin/loom" && Array.isArray(args) && args.join(" ") === "profile list"
      )
    ).toBe(false);
    await expect(manager.getActiveProfile()).resolves.toMatchObject({
      name: "dev",
      maxTools: 50,
      servers: ["mcp-git", "mcp-gitlab"],
    });
    expect(profiles.find((profile) => profile.name === "research")).toMatchObject({
      name: "research",
      servers: "*",
    });
  });

  it("warns once when deprecated extension-local profiles are configured", async () => {
    await manager.getProfiles();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      "Loom: custom extension profiles are deprecated. The extension now uses loom-core profiles and ignores loom.profiles."
    );

    const secondManager = new ProfileManager(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockHubStatusManager as any,
      mockDaemonClient,
      "/workspace",
      mockChannel,
      mockConfigManager
    );
    await secondManager.getProfiles();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it("falls back to loom profile list text output when doctor JSON is unavailable", async () => {
    runtimeProfileState = null;
    doctorJsonAvailable = false;

    const fallbackManager = new ProfileManager(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockHubStatusManager as any,
      mockDaemonClient,
      "/workspace",
      mockChannel,
      mockConfigManager
    );

    const profiles = await fallbackManager.getProfiles();

    expect(profiles.map((profile) => profile.name)).toEqual(["dev", "full", "research"]);
    expect(mockGetRuntimeProfileState).toHaveBeenCalled();
    expect(mockExecFile).toHaveBeenCalledWith(
      "/mock/bin/loom",
      ["doctor", "--json"],
      expect.objectContaining({
        cwd: "/workspace",
      }),
      expect.any(Function)
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      "/mock/bin/loom",
      ["profile", "list"],
      expect.objectContaining({
        cwd: "/workspace",
      }),
      expect.any(Function)
    );
  });

  it("returns enabled platforms from config", () => {
    expect(manager.getProfilePlatforms()).toEqual(["vscode", "codex"]);
  });

  it("switches profiles, persists the choice, and rejects missing profiles", async () => {
    const listener = vi.fn();
    manager.onDidChangeProfile(listener);

    await expect(manager.switchProfile("research")).resolves.toBe(true);
    expect(manager.getActiveProfileName()).toBe("research");
    expect(listener).toHaveBeenCalledWith("research");
    expect(mockConfigSet).toHaveBeenCalledWith("activeProfile", "research");

    await expect(manager.switchProfile("does-not-exist")).resolves.toBe(false);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Profile not found: does-not-exist"
    );
  });

  it("falls back to full when the configured profile does not exist", async () => {
    runtimeProfileState = null;
    configStore.activeProfile = "missing";

    const fallbackManager = new ProfileManager(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockHubStatusManager as any,
      mockDaemonClient,
      "/workspace",
      mockChannel,
      mockConfigManager
    );

    const profiles = await fallbackManager.getProfiles();
    expect(profiles.some((profile) => profile.name === "full")).toBe(true);
    expect(fallbackManager.getActiveProfileName()).toBe("full");
    expect(mockConfigSet).toHaveBeenCalledWith("activeProfile", "full");
  });

  it("falls back to summary-only profile details when profile show has no parseable fields", async () => {
    const profiles = await manager.getProfiles();

    const research = profiles.find((profile) => profile.name === "research");
    expect(research).toMatchObject({
      name: "research",
      servers: "*",
    });
  });

  it("computes routing status from hub and daemon state", async () => {
    const status = await manager.getRoutingStatus();

    expect(status.hubRouted.sort()).toEqual(["git", "hub-only"]);
    expect(status.localRouted).toEqual(["local-only"]);
    expect(status.hubHealthy).toBe(true);
    expect(status.activeProfile).toBe("dev");
    expect(status.profileDescription).toBe("Core development tools for coding workflows");
    expect(status.profileMaxTools).toBe(50);
  });

  it("matches loom-core mcp-prefixed server names when checking enablement", async () => {
    await manager.getProfiles();

    expect(manager.isServerEnabled("git")).toBe(true);
    expect(manager.isServerEnabled("gitlab")).toBe(true);
    expect(manager.isServerEnabled("local-only")).toBe(false);
    expect(manager.isHubEnabled()).toBe(true);
  });

  it("reloads and disposes without errors", () => {
    expect(() => manager.reloadProfiles()).not.toThrow();
    expect(() => manager.dispose()).not.toThrow();
  });
});
