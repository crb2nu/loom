import { execFile } from "child_process";
import * as os from "os";
import { promisify } from "util";

import * as vscode from "vscode";

import { DaemonServerInfo, DaemonToolInfo } from "../types";
import { resolveLoomBinary } from "../utils/binary";
import { Logger } from "../utils/logger";

const execFileAsync = promisify(execFile);

/**
 * Connection state for the daemon.
 */
export type DaemonConnectionState = "connected" | "disconnected" | "connecting";

export interface ToolExecutionEvent {
  toolName: string;
  server: string;
  tool: string;
  success: boolean;
  durationMs: number;
  timestamp: string;
  error?: string;
}

/**
 * Retry configuration for daemon operations.
 */
interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

interface RetryOptions {
  notifyUser?: boolean;
  userOperation?: string;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
};

export class DaemonClient {
  private readonly workspaceRoot: string;
  private readonly channel: vscode.OutputChannel;
  private readonly logger: Logger;
  private cachedServers: DaemonServerInfo[] = [];
  private lastFetch: Date | null = null;
  private readonly cacheTimeoutMs = 5000;
  private cachedTools: DaemonToolInfo[] = [];
  private lastToolFetch: Date | null = null;

  // Connection state tracking
  private _connectionState: DaemonConnectionState = "disconnected";
  private readonly _onConnectionStateChange = new vscode.EventEmitter<DaemonConnectionState>();
  readonly onConnectionStateChange = this._onConnectionStateChange.event;
  private readonly _onToolExecution = new vscode.EventEmitter<ToolExecutionEvent>();
  readonly onToolExecution = this._onToolExecution.event;

  // Retry configuration
  private retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG;

  // Health check interval
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly healthCheckIntervalMs = 30000; // 30 seconds

  constructor(workspaceRoot: string, channel: vscode.OutputChannel) {
    this.workspaceRoot = workspaceRoot;
    this.channel = channel;
    this.logger = new Logger(channel, "Daemon");
  }

  /**
   * Current connection state.
   */
  get connectionState(): DaemonConnectionState {
    return this._connectionState;
  }

  /**
   * Start monitoring daemon health.
   */
  startHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      return;
    }

    // Initial check
    void this.checkDaemonHealth();

    // Periodic health checks
    this.healthCheckInterval = setInterval(() => {
      void this.checkDaemonHealth();
    }, this.healthCheckIntervalMs);
  }

  /**
   * Stop monitoring daemon health.
   */
  stopHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Check daemon health and update connection state.
   */
  private async checkDaemonHealth(): Promise<void> {
    const isRunning = await this.isDaemonRunning();
    const newState: DaemonConnectionState = isRunning ? "connected" : "disconnected";

    if (newState !== this._connectionState) {
      this._connectionState = newState;
      this._onConnectionStateChange.fire(newState);

      if (newState === "disconnected") {
        this.logger.info("Daemon disconnected");
      } else {
        this.logger.info("Daemon connected");
      }
    }
  }

  /**
   * Set the connection state and fire event.
   */
  private setConnectionState(state: DaemonConnectionState): void {
    if (state !== this._connectionState) {
      this._connectionState = state;
      this._onConnectionStateChange.fire(state);
    }
  }

  /**
   * Execute an operation with retry logic and exponential backoff.
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    options: RetryOptions = {}
  ): Promise<T> {
    let lastError: Error | undefined;
    let delay = this.retryConfig.initialDelayMs;
    const userOperation = options.userOperation ?? operationName;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          this.setConnectionState("connecting");
          this.channel.appendLine(
            `[DaemonClient] Retry attempt ${attempt}/${this.retryConfig.maxRetries} for ${operationName}`
          );
          if (options.notifyUser) {
            void vscode.window.showWarningMessage(
              `Loom: failed to ${userOperation} (attempt ${attempt}/${this.retryConfig.maxRetries + 1}). Retrying...`
            );
          }
          await this.sleep(delay);
          delay = Math.min(delay * this.retryConfig.backoffMultiplier, this.retryConfig.maxDelayMs);
        }

        const result = await operation();
        this.setConnectionState("connected");
        if (attempt > 0 && options.notifyUser) {
          const retryLabel = attempt === 1 ? "retry" : "retries";
          void vscode.window.showInformationMessage(
            `Loom: recovered and completed ${userOperation} after ${attempt} ${retryLabel}.`
          );
        }
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Log the failure
        this.channel.appendLine(
          `[DaemonClient] ${operationName} failed (attempt ${attempt + 1}): ${lastError.message}`
        );

        // If this was the last attempt, set disconnected
        if (attempt === this.retryConfig.maxRetries) {
          this.setConnectionState("disconnected");
          if (options.notifyUser) {
            void vscode.window.showErrorMessage(
              `Loom: failed to ${userOperation} after ${this.retryConfig.maxRetries + 1} attempts. Check the Loom output channel for details.`
            );
          }
        }
      }
    }

    throw (
      lastError ?? new Error(`${operationName} failed after ${this.retryConfig.maxRetries} retries`)
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Show a notification when daemon is unavailable with action to start it.
   */
  async showDaemonUnavailableNotification(): Promise<void> {
    const action = await vscode.window.showWarningMessage(
      "Loom daemon is not running. Some features will be unavailable.",
      "Start Daemon",
      "Dismiss"
    );

    if (action === "Start Daemon") {
      await this.startDaemon();
    }
  }

  /**
   * Start the loom daemon.
   */
  async startDaemon(): Promise<boolean> {
    try {
      const loomBinary = resolveLoomBinary(this.workspaceRoot);
      this.channel.appendLine(`[DaemonClient] Starting daemon...`);

      await this.withRetry(
        async () => {
          await execFileAsync(loomBinary, ["daemon", "start"], {
            cwd: this.workspaceRoot || os.homedir(),
            timeout: 10000,
          });
          await this.sleep(1500);
          const isRunning = await this.isDaemonRunning();
          if (!isRunning) {
            throw new Error("daemon did not report healthy status after start");
          }
        },
        "startDaemon",
        { notifyUser: true, userOperation: "start the Loom daemon" }
      );

      this.setConnectionState("connected");
      this.invalidateCache();
      this.channel.appendLine(`[DaemonClient] Daemon started successfully`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(`[DaemonClient] Failed to start daemon: ${message}`);
      this.setConnectionState("disconnected");
      return false;
    }
  }

  /**
   * Stop the loom daemon.
   */
  async stopDaemon(): Promise<boolean> {
    try {
      const loomBinary = resolveLoomBinary(this.workspaceRoot);
      this.channel.appendLine(`[DaemonClient] Stopping daemon...`);

      await this.withRetry(
        async () => {
          await execFileAsync(loomBinary, ["daemon", "stop"], {
            cwd: this.workspaceRoot || os.homedir(),
            timeout: 10000,
          });
        },
        "stopDaemon",
        { notifyUser: true, userOperation: "stop the Loom daemon" }
      );

      this.setConnectionState("disconnected");
      this.invalidateCache();
      this.channel.appendLine(`[DaemonClient] Daemon stopped successfully`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(`[DaemonClient] Failed to stop daemon: ${message}`);
      return false;
    }
  }

  /**
   * Restart the loom daemon.
   */
  async restartDaemon(): Promise<boolean> {
    try {
      const loomBinary = resolveLoomBinary(this.workspaceRoot);
      this.channel.appendLine(`[DaemonClient] Restarting daemon...`);

      await this.withRetry(
        async () => {
          await execFileAsync(loomBinary, ["daemon", "restart"], {
            cwd: this.workspaceRoot || os.homedir(),
            timeout: 30000,
          });
          await this.sleep(1500);
          const isRunning = await this.isDaemonRunning();
          if (!isRunning) {
            throw new Error("daemon did not report healthy status after restart");
          }
        },
        "restartDaemon",
        { notifyUser: true, userOperation: "restart the Loom daemon" }
      );

      this.setConnectionState("connected");
      this.invalidateCache();
      this.channel.appendLine(`[DaemonClient] Daemon restarted successfully`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(`[DaemonClient] Failed to restart daemon: ${message}`);
      this.setConnectionState("disconnected");
      return false;
    }
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
      const servers = await this.withRetry(async () => {
        const loomBinary = resolveLoomBinary(this.workspaceRoot);
        const { stdout } = await execFileAsync(loomBinary, ["servers", "--json"], {
          cwd: this.workspaceRoot || os.homedir(),
          timeout: 5000,
        });

        const parsed = JSON.parse(stdout) as { servers?: DaemonServerInfo[] };
        return parsed.servers ?? [];
      }, "getServers");

      this.cachedServers = servers;
      this.lastFetch = now;
      return this.cachedServers;
    } catch {
      // Try text output as fallback
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
        // Daemon not running or error - return cached if available
        if (this._connectionState === "disconnected" && this.cachedServers.length === 0) {
          // First failure - show notification
          void this.showDaemonUnavailableNotification();
        }
        return this.cachedServers;
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
      const tools = await this.withRetry(async () => {
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
        return tools;
      }, "getTools");

      this.cachedTools = tools;
      this.lastToolFetch = now;
      return this.cachedTools;
    } catch {
      // Return cached tools on failure
      return this.cachedTools;
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
    const startedAt = Date.now();
    const parsedTool = this.parseToolName(toolName);

    try {
      const response = await this.withRetry(async () => {
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
          const result = JSON.parse(stdout) as unknown;
          return { success: true, result };
        } catch {
          // Output might not be JSON
          return { success: true, result: stdout };
        }
      }, `executeTool(${toolName})`);

      this._onToolExecution.fire({
        toolName,
        server: parsedTool.server,
        tool: parsedTool.tool,
        success: true,
        durationMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      });

      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(`[DaemonClient] Tool execution failed: ${message}`);

      this._onToolExecution.fire({
        toolName,
        server: parsedTool.server,
        tool: parsedTool.tool,
        success: false,
        durationMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
        error: message,
      });

      return { success: false, error: message };
    }
  }

  private parseToolName(toolName: string): { server: string; tool: string } {
    const separator = toolName.lastIndexOf("__");
    if (separator === -1 || separator === toolName.length - 2) {
      return { server: "unknown", tool: toolName };
    }
    return {
      server: toolName.substring(0, separator),
      tool: toolName.substring(separator + 2),
    };
  }

  /**
   * Start a specific MCP server.
   */
  async startServer(serverName: string): Promise<boolean> {
    try {
      await this.withRetry(async () => {
        const loomBinary = resolveLoomBinary(this.workspaceRoot);
        await execFileAsync(loomBinary, ["servers", "start", serverName], {
          cwd: this.workspaceRoot || os.homedir(),
          timeout: 30000,
        });
      }, `startServer(${serverName})`);

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
      await this.withRetry(async () => {
        const loomBinary = resolveLoomBinary(this.workspaceRoot);
        await execFileAsync(loomBinary, ["servers", "stop", serverName], {
          cwd: this.workspaceRoot || os.homedir(),
          timeout: 10000,
        });
      }, `stopServer(${serverName})`);

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
      await this.withRetry(async () => {
        const loomBinary = resolveLoomBinary(this.workspaceRoot);
        await execFileAsync(loomBinary, ["servers", "restart", serverName], {
          cwd: this.workspaceRoot || os.homedir(),
          timeout: 30000,
        });
      }, `restartServer(${serverName})`);

      this.invalidateCache();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(`[DaemonClient] Failed to restart server ${serverName}: ${message}`);
      return false;
    }
  }

  /**
   * Dispose resources.
   */
  dispose(): void {
    this.stopHealthMonitoring();
    this._onConnectionStateChange.dispose();
    this._onToolExecution.dispose();
  }
}
