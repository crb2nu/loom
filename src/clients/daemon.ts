import { execFile, spawnSync } from "child_process";
import * as os from "os";
import { promisify } from "util";

import * as vscode from "vscode";

import { DaemonServerInfo, DaemonToolInfo, ToolInputSchema } from "../types";
import { resolveLoomBinary } from "../utils/binary";
import { findRegistryPath } from "../utils/config";
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

interface LoomToolsListResponse {
  tools?: Array<{
    name?: string;
    description?: string;
    server?: string;
    inputSchema?: unknown;
    input_schema?: unknown;
  }>;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  totalTools?: number;
  // Backward-compatible snake_case support.
  page_size?: number;
  total_pages?: number;
  total_tools?: number;
}

export interface LoomRuntimeProfileState {
  active?: string;
  available?: string[];
  toolCount?: number;
}

interface ToolCallErrorEnvelope {
  message?: string;
  data?: {
    code?: string;
    server?: string;
    tool?: string;
    stage?: string;
    retryable?: boolean;
    retry_after?: string;
  };
}

interface ToolCallContentItem {
  text?: string;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
};

export class DaemonClient {
  private static readonly TOOLS_PAGE_SIZE = 200;
  private static readonly PROXY_PROTOCOL_VERSION = "2025-06-18";
  private readonly workspaceRoot: string;
  private readonly channel: vscode.OutputChannel;
  private readonly logger: Logger;
  private cachedServers: DaemonServerInfo[] = [];
  private lastFetch: Date | null = null;
  private readonly cacheTimeoutMs = 5000;
  private cachedTools: DaemonToolInfo[] = [];
  private lastToolFetch: Date | null = null;
  private cachedRuntimeProfileState: LoomRuntimeProfileState | null = null;
  private lastRuntimeProfileFetch: Date | null = null;

  // Connection state tracking
  private _connectionState: DaemonConnectionState = "disconnected";
  private daemonUnavailableNoticeShown = false;
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
      if (state === "connected") {
        this.daemonUnavailableNoticeShown = false;
      }
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
    if (this.daemonUnavailableNoticeShown) {
      return;
    }
    this.daemonUnavailableNoticeShown = true;
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
      const daemonArgs = this.getDaemonControlArgs("start");

      await this.withRetry(
        async () => {
          await execFileAsync(loomBinary, daemonArgs, {
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
      const daemonArgs = this.getDaemonControlArgs("restart");

      await this.withRetry(
        async () => {
          await execFileAsync(loomBinary, daemonArgs, {
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

  getRuntimeProfileState(forceRefresh = false): LoomRuntimeProfileState | null {
    const now = new Date();
    if (
      !forceRefresh &&
      this.lastRuntimeProfileFetch &&
      now.getTime() - this.lastRuntimeProfileFetch.getTime() < this.cacheTimeoutMs
    ) {
      return this.cachedRuntimeProfileState;
    }

    try {
      const runtimeProfileState = this.readRuntimeProfileStateFromProxy();
      this.cachedRuntimeProfileState = runtimeProfileState;
      this.lastRuntimeProfileFetch = now;
      return runtimeProfileState;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(
        `[DaemonClient] runtime profile state unavailable, falling back to CLI parsing: ${message}`
      );
      this.logger.info(`Runtime profile state unavailable: ${message}`);
      return this.cachedRuntimeProfileState;
    }
  }

  async isDaemonRunning(): Promise<boolean> {
    try {
      const loomBinary = resolveLoomBinary(this.workspaceRoot);
      const { stdout } = await execFileAsync(loomBinary, ["daemon", "status"], {
        cwd: this.workspaceRoot || os.homedir(),
        timeout: 2000,
      });
      return /Socket:\s+active\b/.test(stdout);
    } catch {
      return false;
    }
  }

  private getDaemonControlArgs(command: "start" | "restart"): string[] {
    const args = ["daemon", command];
    const registryPath = findRegistryPath(this.workspaceRoot);
    if (registryPath) {
      args.push("--registry", registryPath);
    }
    return args;
  }

  invalidateCache(): void {
    this.lastFetch = null;
    this.cachedServers = [];
    this.cachedTools = [];
    this.lastToolFetch = null;
    this.cachedRuntimeProfileState = null;
    this.lastRuntimeProfileFetch = null;
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
      let tools: DaemonToolInfo[];
      try {
        tools = await this.withRetry(() => this.getToolsFromJsonPaged(), "getTools(json)");
      } catch (jsonError) {
        const message = jsonError instanceof Error ? jsonError.message : String(jsonError);
        this.channel.appendLine(
          `[DaemonClient] JSON tool listing failed, falling back to text parsing: ${message}`
        );
        tools = await this.withRetry(() => this.getToolsFromText(), "getTools(text)");
      }

      this.cachedTools = tools;
      this.lastToolFetch = now;
      return this.cachedTools;
    } catch {
      // Return cached tools on failure
      return this.cachedTools;
    }
  }

  private async getToolsFromJsonPaged(): Promise<DaemonToolInfo[]> {
    const loomBinary = resolveLoomBinary(this.workspaceRoot);
    const cwd = this.workspaceRoot || os.homedir();
    const deduped = new Map<string, DaemonToolInfo>();

    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      const args = [
        "tools",
        "list",
        "--json",
        "--page",
        String(page),
        "--limit",
        String(DaemonClient.TOOLS_PAGE_SIZE),
      ];
      const { stdout } = await execFileAsync(loomBinary, args, {
        cwd,
        timeout: 30000,
      });

      const payload = JSON.parse(stdout) as LoomToolsListResponse;
      const pageTools = Array.isArray(payload.tools) ? payload.tools : [];
      for (const tool of pageTools) {
        const name = tool.name?.trim();
        if (!name) {
          continue;
        }

        const parsedName = this.parseToolName(name);
        const server = tool.server?.trim() || parsedName.server;
        const description = tool.description?.trim() || undefined;
        const inputSchema = this.normalizeToolInputSchema(tool.inputSchema ?? tool.input_schema);
        deduped.set(name, {
          name,
          description,
          server,
          serverPrefix: server,
          inputSchema,
        });
      }

      const nextTotalPages = this.extractTotalPages(payload);
      totalPages = Math.max(1, nextTotalPages);
      page += 1;
    }

    return [...deduped.values()];
  }

  private extractTotalPages(payload: LoomToolsListResponse): number {
    const candidate = payload.totalPages ?? payload.total_pages;
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return Math.floor(candidate);
    }
    return 1;
  }

  private async getToolsFromText(): Promise<DaemonToolInfo[]> {
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
      const match = trimmed.match(/^(\S+)\s*(.*)/);
      if (match) {
        const fullName = match[1];
        const description = match[2]?.trim() || undefined;
        const server = this.parseToolName(fullName).server;
        tools.push({
          name: fullName,
          description,
          server,
          serverPrefix: server,
          inputSchema: undefined,
        });
      }
    }
    return tools;
  }

  private readRuntimeProfileStateFromProxy(): LoomRuntimeProfileState {
    const loomBinary = resolveLoomBinary(this.workspaceRoot);
    const cwd = this.workspaceRoot || os.homedir();
    const input = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: DaemonClient.PROXY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: "loom-profile-manager",
            version: "1.0.0",
          },
        },
      },
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: {
          uri: "loom://config",
        },
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n")
      .concat("\n");

    const result = spawnSync(loomBinary, ["proxy"], {
      cwd,
      input,
      encoding: "utf-8",
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });

    if (result.error) {
      throw result.error;
    }

    const stderr = typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? "");
    if (result.status !== 0) {
      throw new Error(
        `loom proxy exited with status ${result.status ?? "unknown"}${stderr ? `: ${stderr.trim()}` : ""}`
      );
    }

    const response = this.extractProxyResponse(
      typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? ""),
      2
    );
    if (!response) {
      throw new Error("loom proxy did not return a resources/read response");
    }
    if (response.error) {
      throw new Error(response.error.message ?? "loom proxy returned an error");
    }

    return this.parseRuntimeProfileState(response.result as Record<string, unknown> | undefined);
  }

  private extractProxyResponse(
    stdout: string,
    id: number
  ): { result?: unknown; error?: { message?: string } } | null {
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("{")) {
        continue;
      }

      let message: { id?: unknown; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line) as {
          id?: unknown;
          result?: unknown;
          error?: { message?: string };
        };
      } catch {
        continue;
      }

      if (message.id !== id) {
        continue;
      }

      return {
        result: message.result,
        error: message.error,
      };
    }

    return null;
  }

  private parseRuntimeProfileState(
    result: Record<string, unknown> | undefined
  ): LoomRuntimeProfileState {
    if (!result) {
      throw new Error("loom://config response was empty");
    }

    const contents = Array.isArray(result.contents) ? result.contents : [];
    const firstContent = contents.find((item): item is Record<string, unknown> => {
      if (!this.isRecord(item)) {
        return false;
      }
      return typeof item.text === "string";
    });
    const rawText = firstContent?.text;

    if (typeof rawText !== "string" || rawText.trim() === "") {
      throw new Error("loom://config response did not include text content");
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      throw new Error("loom://config response was not valid JSON");
    }

    const profilePayload = this.pickRecord(parsed, "loom/profile", "profile", "loom.profile");
    const configHashPayload = this.pickRecord(
      parsed,
      "loom/config-hash",
      "config-hash",
      "configHash",
      "loom.configHash"
    );

    const active = this.pickString(profilePayload, parsed, "active", "activeProfile");
    const available = this.normalizeStringArray(
      this.pickValue(profilePayload, parsed, "available", "availableProfiles")
    );
    const toolCount = this.pickNumber(configHashPayload, parsed, "toolCount");

    return {
      active,
      available: available.length > 0 ? available : active ? [active] : [],
      toolCount,
    };
  }

  private pickRecord(
    primary: Record<string, unknown>,
    ...keys: string[]
  ): Record<string, unknown> | undefined {
    for (const key of keys) {
      const value = primary[key];
      if (this.isRecord(value)) {
        return value;
      }
    }
    return undefined;
  }

  private pickValue(
    primary: Record<string, unknown> | undefined,
    fallback: Record<string, unknown>,
    ...keys: string[]
  ): unknown {
    for (const key of keys) {
      if (primary && key in primary) {
        return primary[key];
      }
      if (key in fallback) {
        return fallback[key];
      }
    }
    return undefined;
  }

  private pickString(
    primary: Record<string, unknown> | undefined,
    fallback: Record<string, unknown>,
    ...keys: string[]
  ): string | undefined {
    const value = this.pickValue(primary, fallback, ...keys);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private pickNumber(
    primary: Record<string, unknown> | undefined,
    fallback: Record<string, unknown>,
    ...keys: string[]
  ): number | undefined {
    const value = this.pickValue(primary, fallback, ...keys);
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  }

  private normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const names = new Set<string>();
    for (const item of value) {
      if (typeof item === "string" && item.trim()) {
        names.add(item.trim());
        continue;
      }

      if (this.isRecord(item) && typeof item.name === "string" && item.name.trim()) {
        names.add(item.name.trim());
      }
    }
    return [...names];
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private normalizeToolInputSchema(value: unknown): ToolInputSchema | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const candidate = value as Record<string, unknown>;

    const type = typeof candidate.type === "string" ? candidate.type : "object";
    const properties =
      candidate.properties &&
      typeof candidate.properties === "object" &&
      !Array.isArray(candidate.properties)
        ? (candidate.properties as Record<string, unknown>)
        : undefined;
    const required = Array.isArray(candidate.required)
      ? candidate.required.filter((entry): entry is string => typeof entry === "string")
      : undefined;

    if (!properties && !required && typeof candidate.type !== "string") {
      return undefined;
    }

    return {
      type,
      properties,
      required,
    };
  }

  private extractToolCallError(value: unknown): string | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    const errorValue = record.error;

    if (typeof errorValue === "string" && errorValue.trim().length > 0) {
      return errorValue.trim();
    }

    if (errorValue && typeof errorValue === "object" && !Array.isArray(errorValue)) {
      const envelope = errorValue as ToolCallErrorEnvelope;
      if (typeof envelope.message === "string" && envelope.message.trim().length > 0) {
        const details: string[] = [];
        if (typeof envelope.data?.code === "string" && envelope.data.code.trim().length > 0) {
          details.push(envelope.data.code.trim());
        }
        if (typeof envelope.data?.stage === "string" && envelope.data.stage.trim().length > 0) {
          details.push(envelope.data.stage.trim());
        }
        return details.length > 0
          ? `${envelope.message.trim()} (${details.join(", ")})`
          : envelope.message.trim();
      }
    }

    if (record.isError === true && Array.isArray(record.content)) {
      const text = record.content
        .map((item) => this.extractToolCallContentText(item))
        .filter((entry) => entry.length > 0)
        .join("\n")
        .trim();
      return text || "tool call failed";
    }

    return undefined;
  }

  private extractToolCallContentText(item: unknown): string {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return "";
    }
    const contentItem = item as ToolCallContentItem;
    return typeof contentItem.text === "string" ? contentItem.text : "";
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
          const errorMessage = this.extractToolCallError(result);
          if (errorMessage) {
            return { success: false, error: errorMessage };
          }
          return { success: true, result };
        } catch {
          // Output might not be JSON
          return { success: true, result: stdout };
        }
      }, `executeTool(${toolName})`);

      if (!response.success) {
        this.channel.appendLine(`[DaemonClient] Tool execution failed: ${response.error}`);
        this._onToolExecution.fire({
          toolName,
          server: parsedTool.server,
          tool: parsedTool.tool,
          success: false,
          durationMs: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
          error: response.error,
        });
        return response;
      }

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
