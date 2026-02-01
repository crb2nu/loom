import { execFile } from "child_process";
import * as os from "os";
import { promisify } from "util";

import * as vscode from "vscode";

import { DaemonServerInfo, DaemonToolInfo } from "../types";
import { resolveLoomBinary } from "../utils/binary";

const execFileAsync = promisify(execFile);

export class DaemonClient {
  private readonly workspaceRoot: string;
  private readonly channel: vscode.OutputChannel;
  private cachedServers: DaemonServerInfo[] = [];
  private lastFetch: Date | null = null;
  private readonly cacheTimeoutMs = 5000;
  private cachedTools: DaemonToolInfo[] = [];
  private lastToolFetch: Date | null = null;

  constructor(workspaceRoot: string, channel: vscode.OutputChannel) {
    this.workspaceRoot = workspaceRoot;
    this.channel = channel;
  }

  async getServers(forceRefresh = false): Promise<DaemonServerInfo[]> {
    const now = new Date();
    if (
      !forceRefresh &&
      this.lastFetch &&
      now.getTime() - this.lastFetch.getTime() < this.cacheTimeoutMs
    ) {
      return this.cachedServers;
    }

    try {
      const loomBinary = resolveLoomBinary(this.workspaceRoot);
      const { stdout } = await execFileAsync(loomBinary, ["servers", "--json"], {
        cwd: this.workspaceRoot || os.homedir(),
        timeout: 5000,
      });

      const parsed = JSON.parse(stdout) as { servers?: DaemonServerInfo[] };
      this.cachedServers = parsed.servers ?? [];
      this.lastFetch = now;
      return this.cachedServers;
    } catch {
      // Daemon might not be running - try parsing text output
      try {
        const loomBinary = resolveLoomBinary(this.workspaceRoot);
        const { stdout } = await execFileAsync(loomBinary, ["servers"], {
          cwd: this.workspaceRoot || os.homedir(),
          timeout: 5000,
        });

        // Parse text output format: "NAME  STATUS  DESCRIPTION"
        const servers: DaemonServerInfo[] = [];
        const lines = stdout.split("\n").slice(2); // Skip header lines
        for (const line of lines) {
          const match = line.match(/^(\S+)\s+(running|idle)\s*(.*)/);
          if (match) {
            servers.push({
              name: match[1],
              running: match[2] === "running",
              description: match[3]?.trim() || undefined,
            });
          }
        }
        this.cachedServers = servers;
        this.lastFetch = now;
        return this.cachedServers;
      } catch {
        // Daemon not running or error
        return [];
      }
    }
  }

  async isDaemonRunning(): Promise<boolean> {
    try {
      const loomBinary = resolveLoomBinary(this.workspaceRoot);
      await execFileAsync(loomBinary, ["daemon", "status"], {
        cwd: this.workspaceRoot || os.homedir(),
        timeout: 2000,
      });
      return true;
    } catch {
      return false;
    }
  }

  invalidateCache(): void {
    this.lastFetch = null;
    this.cachedServers = [];
    this.cachedTools = [];
    this.lastToolFetch = null;
  }

  async getTools(forceRefresh = false): Promise<DaemonToolInfo[]> {
    const now = new Date();
    if (
      !forceRefresh &&
      this.lastToolFetch &&
      now.getTime() - this.lastToolFetch.getTime() < this.cacheTimeoutMs
    ) {
      return this.cachedTools;
    }

    try {
      const loomBinary = resolveLoomBinary(this.workspaceRoot);
      const { stdout } = await execFileAsync(loomBinary, ["tools", "list"], {
        cwd: this.workspaceRoot || os.homedir(),
        timeout: 30000,
      });

      // Parse text output format: "tool_name  description"
      const tools: DaemonToolInfo[] = [];
      const lines = stdout.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("NAME") || trimmed.startsWith("----")) {
          continue;
        }
        // Tool name format: server__toolname
        const match = trimmed.match(/^(\S+)\s*(.*)/);
        if (match) {
          const fullName = match[1];
          const description = match[2]?.trim() || undefined;
          // Parse server from tool name (format: server__toolname)
          const serverMatch = fullName.match(/^([^_]+(?:__)?[^_]*)__(.+)$/);
          const server = serverMatch ? serverMatch[1] : "unknown";
          tools.push({
            name: fullName,
            description,
            server,
          });
        }
      }
      this.cachedTools = tools;
      this.lastToolFetch = now;
      return this.cachedTools;
    } catch {
      // Daemon not running or error
      return [];
    }
  }

  /**
   * Execute a tool via the loom CLI.
   * @param toolName Full tool name (e.g., "tavily__search")
   * @param args Tool arguments as a JSON object
   * @returns Tool execution result
   */
  async executeTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    try {
      const loomBinary = resolveLoomBinary(this.workspaceRoot);
      const argsJson = JSON.stringify(args);

      const { stdout, stderr } = await execFileAsync(
        loomBinary,
        ["tools", "call", toolName, "--json", "--args", argsJson],
        {
          cwd: this.workspaceRoot || os.homedir(),
          timeout: 120000, // 2 minutes for tool execution
        }
      );

      if (stderr && stderr.trim()) {
        this.channel.appendLine(`[DaemonClient] Tool ${toolName} stderr: ${stderr}`);
      }

      try {
        const result = JSON.parse(stdout);
        return { success: true, result };
      } catch {
        // Output might not be JSON
        return { success: true, result: stdout };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(`[DaemonClient] Tool execution failed: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Start a specific MCP server.
   */
  async startServer(serverName: string): Promise<boolean> {
    try {
      const loomBinary = resolveLoomBinary(this.workspaceRoot);
      await execFileAsync(loomBinary, ["servers", "start", serverName], {
        cwd: this.workspaceRoot || os.homedir(),
        timeout: 30000,
      });
      this.invalidateCache();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(`[DaemonClient] Failed to start server ${serverName}: ${message}`);
      return false;
    }
  }

  /**
   * Stop a specific MCP server.
   */
  async stopServer(serverName: string): Promise<boolean> {
    try {
      const loomBinary = resolveLoomBinary(this.workspaceRoot);
      await execFileAsync(loomBinary, ["servers", "stop", serverName], {
        cwd: this.workspaceRoot || os.homedir(),
        timeout: 10000,
      });
      this.invalidateCache();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(`[DaemonClient] Failed to stop server ${serverName}: ${message}`);
      return false;
    }
  }

  /**
   * Restart a specific MCP server.
   */
  async restartServer(serverName: string): Promise<boolean> {
    try {
      const loomBinary = resolveLoomBinary(this.workspaceRoot);
      await execFileAsync(loomBinary, ["servers", "restart", serverName], {
        cwd: this.workspaceRoot || os.homedir(),
        timeout: 30000,
      });
      this.invalidateCache();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(`[DaemonClient] Failed to restart server ${serverName}: ${message}`);
      return false;
    }
  }
}
