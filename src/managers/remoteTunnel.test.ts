import { EventEmitter } from "events";
import { PassThrough } from "stream";

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

import { RemoteTunnelProfile } from "../types";
import { ConfigManager } from "../utils/configManager";

import { RemoteTunnelManager, SpawnLike } from "./remoteTunnel";

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  killed = false;

  kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed = true;
    this.emit("exit", 0, signal ?? null);
    return true;
  });
}

describe("RemoteTunnelManager", () => {
  let profiles: RemoteTunnelProfile[];
  let configManager: ConfigManager;
  let setConfigMock: ReturnType<typeof vi.fn>;
  let outputChannel: vscode.OutputChannel;
  let spawnMock: ReturnType<typeof vi.fn<SpawnLike>>;

  beforeEach(() => {
    profiles = [
      {
        name: "dev-hub",
        context: "kc-k3s",
        namespace: "flexinfer-system",
        service: "mcp-hub",
        localPort: 37017,
        remotePort: 80,
        hubPath: "/ws",
        autoSetHubUrl: true,
      },
    ];

    setConfigMock = vi.fn(async () => {});

    configManager = {
      get: vi.fn((key: string) => {
        if (key === "remoteTunnels") {
          return profiles;
        }
        return undefined;
      }),
      set: setConfigMock,
    } as unknown as ConfigManager;

    outputChannel = {
      name: "Remote tunnel tests",
      append: vi.fn(),
      appendLine: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      replace: vi.fn(),
    };

    spawnMock = vi.fn<SpawnLike>();
  });

  it("starts a tunnel and updates hubUrl when ready", async () => {
    const child = new FakeProcess();
    spawnMock.mockReturnValue(child as unknown as ReturnType<SpawnLike>);

    const manager = new RemoteTunnelManager("/workspace", configManager, outputChannel, spawnMock);

    const startPromise = manager.startTunnel("dev-hub");
    child.stdout.write("Forwarding from 127.0.0.1:37017 -> 80\n");

    const status = await startPromise;

    expect(status.running).toBe(true);
    expect(status.profileName).toBe("dev-hub");
    expect(status.hubUrl).toBe("ws://127.0.0.1:37017/ws");
    expect(spawnMock).toHaveBeenCalledWith(
      "kubectl",
      [
        "--context",
        "kc-k3s",
        "-n",
        "flexinfer-system",
        "port-forward",
        "svc/mcp-hub",
        "37017:80",
        "--address",
        "127.0.0.1",
      ],
      expect.objectContaining({ cwd: "/workspace" })
    );
    expect(setConfigMock).toHaveBeenCalledWith(
      "hubUrl",
      "ws://127.0.0.1:37017/ws",
      vscode.ConfigurationTarget.Workspace
    );

    manager.stopTunnel();
  });

  it("rejects invalid profile values before spawning", async () => {
    profiles = [
      {
        name: "bad",
        namespace: "INVALID_NAMESPACE",
        service: "mcp-hub",
        localPort: 37017,
        remotePort: 80,
      },
    ];

    const manager = new RemoteTunnelManager("/workspace", configManager, outputChannel, spawnMock);

    await expect(manager.startTunnel("bad")).rejects.toThrow("Invalid namespace");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns false when stopping without an active tunnel", () => {
    const manager = new RemoteTunnelManager("/workspace", configManager, outputChannel, spawnMock);
    expect(manager.stopTunnel()).toBe(false);
  });

  it("stops an active tunnel", async () => {
    const child = new FakeProcess();
    spawnMock.mockReturnValue(child as unknown as ReturnType<SpawnLike>);

    const manager = new RemoteTunnelManager("/workspace", configManager, outputChannel, spawnMock);

    const startPromise = manager.startTunnel("dev-hub");
    child.stderr.write("Forwarding from 127.0.0.1:37017 -> 80\n");
    await startPromise;

    expect(manager.stopTunnel()).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(manager.getStatus().running).toBe(false);
  });
});
