import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "child_process";

import * as vscode from "vscode";

import { RemoteTunnelProfile } from "../types";
import { ConfigManager } from "../utils/configManager";
import { Logger } from "../utils/logger";

const K8S_NAME_REGEX = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DEFAULT_HUB_PATH = "/ws";
const READY_PATTERN = /Forwarding from 127\.0\.0\.1:\d+/;
const START_TIMEOUT_MS = 15000;

export type SpawnLike = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

export interface RemoteTunnelStatus {
  running: boolean;
  profileName?: string;
  localPort?: number;
  remotePort?: number;
  namespace?: string;
  service?: string;
  startedAt?: string;
  pid?: number;
  hubUrl?: string;
}

interface ActiveTunnel {
  process: ChildProcessWithoutNullStreams;
  profile: RemoteTunnelProfile;
  startedAt: string;
  hubUrl: string;
}

/**
 * Manages local kubectl port-forward tunnels to remote K8s MCP services.
 */
export class RemoteTunnelManager implements vscode.Disposable {
  private readonly logger: Logger;
  private active?: ActiveTunnel;

  constructor(
    private readonly workspaceRoot: string,
    private readonly configManager: ConfigManager,
    channel: vscode.OutputChannel,
    private readonly spawnFn: SpawnLike = spawn
  ) {
    this.logger = new Logger(channel, "RemoteTunnel");
  }

  getProfiles(): RemoteTunnelProfile[] {
    return this.configManager.get("remoteTunnels");
  }

  getStatus(): RemoteTunnelStatus {
    if (!this.active) {
      return { running: false };
    }

    return {
      running: true,
      profileName: this.active.profile.name,
      localPort: this.active.profile.localPort,
      remotePort: this.active.profile.remotePort,
      namespace: this.active.profile.namespace,
      service: this.active.profile.service,
      startedAt: this.active.startedAt,
      pid: this.active.process.pid,
      hubUrl: this.active.hubUrl,
    };
  }

  async startTunnel(profileName: string): Promise<RemoteTunnelStatus> {
    const profile = this.getProfiles().find((candidate) => candidate.name === profileName);
    if (!profile) {
      throw new Error(`Remote tunnel profile not found: ${profileName}`);
    }

    this.validateProfile(profile);

    if (this.active?.profile.name === profile.name) {
      return this.getStatus();
    }

    this.stopTunnel();

    const args: string[] = [];
    if (profile.context) {
      args.push("--context", profile.context);
    }

    args.push(
      "-n",
      profile.namespace,
      "port-forward",
      `svc/${profile.service}`,
      `${profile.localPort}:${profile.remotePort}`,
      "--address",
      "127.0.0.1"
    );

    this.logger.info(`Starting tunnel profile "${profile.name}"`);
    this.logger.info(`→ kubectl ${args.join(" ")}`);

    const child = this.spawnFn("kubectl", args, {
      cwd: this.workspaceRoot || undefined,
      env: globalThis.process.env,
    });

    const hubPath = normalizeHubPath(profile.hubPath);
    const hubUrl = `ws://127.0.0.1:${profile.localPort}${hubPath}`;

    return new Promise<RemoteTunnelStatus>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Timed out waiting for tunnel readiness (${START_TIMEOUT_MS}ms)`));
      }, START_TIMEOUT_MS);

      const complete = async () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);

        this.active = {
          process: child,
          profile,
          startedAt: new Date().toISOString(),
          hubUrl,
        };

        if (profile.autoSetHubUrl ?? true) {
          await this.configManager.set("hubUrl", hubUrl, vscode.ConfigurationTarget.Workspace);
        }

        resolve(this.getStatus());
      };

      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(message));
      };

      const onData = (chunk: Buffer | string) => {
        const line = chunk.toString();
        this.logger.info(line.trim());
        if (READY_PATTERN.test(line)) {
          void complete().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            fail(`Tunnel startup failed: ${message}`);
          });
        }
      };

      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      child.once("error", (error) => {
        fail(`Failed to start kubectl tunnel: ${error.message}`);
      });

      child.once("exit", (code, signal) => {
        this.logger.warn(`Tunnel process exited (code=${String(code)}, signal=${String(signal)})`);
        if (!settled) {
          fail(`Tunnel exited before ready (code=${String(code)}, signal=${String(signal)})`);
        }
        if (this.active?.process === child) {
          this.active = undefined;
        }
      });
    });
  }

  stopTunnel(): boolean {
    if (!this.active) {
      return false;
    }

    const { process, profile } = this.active;
    this.active = undefined;

    if (!process.killed) {
      process.kill("SIGTERM");
    }

    this.logger.info(`Stopped tunnel profile "${profile.name}"`);
    return true;
  }

  private validateProfile(profile: RemoteTunnelProfile): void {
    if (!profile.name.trim()) {
      throw new Error("Remote tunnel profile name must not be empty");
    }

    if (!K8S_NAME_REGEX.test(profile.namespace)) {
      throw new Error(`Invalid namespace for profile "${profile.name}": ${profile.namespace}`);
    }

    if (!K8S_NAME_REGEX.test(profile.service)) {
      throw new Error(`Invalid service for profile "${profile.name}": ${profile.service}`);
    }

    if (!isValidPort(profile.localPort)) {
      throw new Error(`Invalid localPort for profile "${profile.name}": ${profile.localPort}`);
    }

    if (!isValidPort(profile.remotePort)) {
      throw new Error(`Invalid remotePort for profile "${profile.name}": ${profile.remotePort}`);
    }
  }

  dispose(): void {
    this.stopTunnel();
  }
}

function normalizeHubPath(pathValue?: string): string {
  if (!pathValue || !pathValue.trim()) {
    return DEFAULT_HUB_PATH;
  }
  return pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
}

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}
