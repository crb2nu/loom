/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

const mockGetEnabledPlatforms = vi.hoisted(() => vi.fn(() => ["vscode", "codex"]));

vi.mock("../utils/platform", () => ({
  getEnabledPlatforms: mockGetEnabledPlatforms,
}));

import { DaemonClient } from "../clients/daemon";
import { ConfigManager } from "../utils/configManager";

import { ProfileManager } from "./profileManager";

describe("ProfileManager", () => {
  let manager: ProfileManager;
  let configStore: {
    activeProfile: string;
    enabledPlatforms: string[];
    profiles: Record<
      string,
      { servers: string[] | "*"; hubEnabled: boolean; platforms?: Array<"vscode" | "codex"> }
    >;
  };

  let mockConfigManager: ConfigManager;
  let mockDaemonClient: DaemonClient;
  let mockHubStatusManager: { getStatus: ReturnType<typeof vi.fn> };
  let mockChannel: vscode.OutputChannel;

  beforeEach(() => {
    vi.clearAllMocks();

    configStore = {
      activeProfile: "team",
      enabledPlatforms: ["vscode", "codex"],
      profiles: {
        team: {
          servers: ["shared"],
          hubEnabled: true,
          platforms: ["codex"],
        },
      },
    };

    mockConfigManager = {
      get: vi.fn((key: string) => {
        const value = configStore[key as keyof typeof configStore];
        return value;
      }),
      set: vi.fn(async (key: string, value: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (configStore as any)[key] = value;
      }),
    } as unknown as ConfigManager;

    mockDaemonClient = {
      getServers: vi.fn(async () => [
        { name: "shared", running: true },
        { name: "local-only", running: true },
      ]),
    } as unknown as DaemonClient;

    mockHubStatusManager = {
      getStatus: vi.fn(() => ({
        servers: [{ name: "shared" }, { name: "hub-only" }],
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

    manager = new ProfileManager(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockHubStatusManager as any,
      mockDaemonClient,
      mockChannel,
      mockConfigManager
    );
  });

  it("loads built-in and configured profiles with active profile from config", () => {
    const profileNames = manager.getProfiles().map((p) => p.name);
    expect(profileNames).toContain("full");
    expect(profileNames).toContain("local");
    expect(profileNames).toContain("team");
    expect(manager.getActiveProfileName()).toBe("team");
    expect(manager.getActiveProfile()?.servers).toEqual(["shared"]);
  });

  it("returns profile platforms and platform enablement checks", () => {
    expect(manager.getProfilePlatforms()).toEqual(["codex"]);
    expect(manager.isPlatformEnabled("codex")).toBe(true);
    expect(manager.isPlatformEnabled("vscode")).toBe(false);
  });

  it("creates a profile and rejects duplicate names", async () => {
    await expect(manager.createProfile("ops", ["local-only"], false, ["vscode"])).resolves.toBe(
      true
    );
    expect(manager.getProfiles().some((p) => p.name === "ops")).toBe(true);
    expect(vi.mocked(mockConfigManager.set)).toHaveBeenCalled();

    await expect(manager.createProfile("ops", "*", true)).resolves.toBe(false);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Profile already exists: ops");
  });

  it("updates profiles and blocks invalid updates", async () => {
    await expect(manager.updateProfile("missing", { hubEnabled: false })).resolves.toBe(false);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Profile not found: missing");

    await expect(manager.updateProfile("full", { hubEnabled: false })).resolves.toBe(false);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Cannot modify built-in profile: full"
    );

    await expect(
      manager.updateProfile("team", { hubEnabled: false, servers: ["local-only"] })
    ).resolves.toBe(true);
    expect(manager.isServerEnabled("local-only")).toBe(true);
    expect(manager.isServerEnabled("shared")).toBe(false);
  });

  it("switches profiles, emits changes, and handles missing profile", async () => {
    await manager.createProfile("ops", ["local-only"], false, ["vscode"]);

    const listener = vi.fn();
    manager.onDidChangeProfile(listener);

    await expect(manager.switchProfile("ops")).resolves.toBe(true);
    expect(manager.getActiveProfileName()).toBe("ops");
    expect(listener).toHaveBeenCalledWith("ops");
    expect(vi.mocked(mockConfigManager.set)).toHaveBeenCalledWith("activeProfile", "ops");

    await expect(manager.switchProfile("does-not-exist")).resolves.toBe(false);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Profile not found: does-not-exist"
    );
  });

  it("computes routing status from hub and daemon state", async () => {
    const status = await manager.getRoutingStatus();
    expect(status.hubRouted.sort()).toEqual(["hub-only", "shared"]);
    expect(status.localRouted).toEqual(["local-only"]);
    expect(status.hubHealthy).toBe(true);
    expect(status.activeProfile).toBe("team");
  });

  it("evaluates server and hub enablement by profile", async () => {
    expect(manager.isServerEnabled("shared")).toBe(true);
    expect(manager.isServerEnabled("local-only")).toBe(false);
    expect(manager.isHubEnabled()).toBe(true);

    await manager.switchProfile("local");
    expect(manager.isServerEnabled("anything")).toBe(true);
    expect(manager.isHubEnabled()).toBe(false);
  });

  it("reloads and disposes without errors", () => {
    expect(() => manager.reloadProfiles()).not.toThrow();
    expect(() => manager.dispose()).not.toThrow();
  });
});
