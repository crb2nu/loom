import * as vscode from "vscode";

import { DaemonClient } from "../clients/daemon";
import { DaemonToolInfo } from "../types";

export type SearchResultStatus = "ok" | "error";

export interface SearchResult {
  tool: string;
  source: string;
  data: unknown;
  status: SearchResultStatus;
  error?: string;
  executedAt?: Date;
  durationMs?: number;
  snippet?: string;
  resultCount?: number;
}

export interface SearchOptions {
  tools?: string[]; // Specific tools to use, or all search tools if empty
  parallel?: boolean; // Execute in parallel (default: true)
  timeout?: number; // Timeout per tool in ms (default: 30000)
  maxResults?: number; // Max results per tool (default: 10)
}

// Known search tool configurations
interface SearchToolConfig {
  queryParam: string;
  limitParam?: string;
  staticParams?: Record<string, unknown>;
}

const LEGACY_SEARCH_TOOL_CONFIGS: Record<string, SearchToolConfig> = {
  tavily__search: { queryParam: "query", limitParam: "max_results" },
  tavily__search_context: { queryParam: "query", limitParam: "max_results" },
  github__search_repos: { queryParam: "query", limitParam: "per_page" },
  github__search_code: { queryParam: "query", limitParam: "per_page" },
  gitlab__search_repositories: { queryParam: "search", limitParam: "per_page" },
  codebase_memory__codebase_search: { queryParam: "query", limitParam: "limit" },
  codebase_memory__codebase_text_search: {
    queryParam: "query",
    limitParam: "limit",
  },
  memory__search_nodes: { queryParam: "query", limitParam: "limit" },
  agent_context__agent_context_search: {
    queryParam: "query",
    limitParam: "limit",
  },
  qdrant__qdrant_search: { queryParam: "query", limitParam: "limit" },
};

const QUERY_PARAM_CANDIDATES = ["query", "q", "search", "search_query", "text", "term"] as const;
const LIMIT_PARAM_CANDIDATES = ["max_results", "limit", "per_page", "top_k", "count"] as const;
const SEARCH_NAME_HINTS = [
  "search",
  "lookup",
  "find",
  "query",
  "discover",
  "semantic",
  "match",
  "browse",
] as const;
const RESULT_LIST_KEYS = [
  "results",
  "items",
  "matches",
  "nodes",
  "entries",
  "entities",
  "repositories",
  "records",
  "data",
] as const;

export class DeepSearchManager {
  private searchHistory: Array<{ query: string; results: SearchResult[]; timestamp: Date }> = [];
  private readonly maxHistory = 50;

  constructor(
    private readonly daemonClient: DaemonClient,
    private readonly channel: vscode.OutputChannel
  ) {}

  /**
   * Executes a search query across all available search-capable tools.
   */
  public async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { parallel = true, timeout = 30000, maxResults = 10 } = options;

    this.channel.appendLine(`[DeepSearch] Starting search for: "${query}"`);

    // 1. Get all available tools
    let tools: DaemonToolInfo[] = [];
    try {
      tools = await this.daemonClient.getTools();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(`[DeepSearch] Failed to fetch tools: ${message}`);
      throw new Error("Could not fetch tools from daemon");
    }

    // 2. Filter for search tools
    let searchTools: DaemonToolInfo[];
    if (options.tools && options.tools.length > 0) {
      searchTools = tools.filter((t) => options.tools!.includes(t.name));
    } else {
      searchTools = tools.filter((tool) => this.resolveSearchToolConfig(tool) !== undefined);
    }

    if (searchTools.length === 0) {
      this.channel.appendLine("[DeepSearch] No search-capable tools found.");
      return [];
    }

    this.channel.appendLine(
      `[DeepSearch] Identified ${searchTools.length} search tools: ${searchTools.map((t) => t.name).join(", ")}`
    );

    // 3. Execute search tools
    const results: SearchResult[] = [];

    if (parallel) {
      // Execute all tools in parallel
      const promises = searchTools.map((tool) =>
        this.executeSearchTool(tool, query, timeout, maxResults)
      );
      const settledResults = await Promise.allSettled(promises);

      for (let i = 0; i < settledResults.length; i++) {
        const result = settledResults[i];
        const tool = searchTools[i];

        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          const reason = result.reason as Error | undefined;
          results.push({
            tool: tool.name,
            source: this.getSource(tool.name),
            data: null,
            status: "error",
            error: reason?.message ?? "Unknown error",
            executedAt: new Date(),
          });
        }
      }
    } else {
      // Execute sequentially
      for (const tool of searchTools) {
        try {
          const result = await this.executeSearchTool(tool, query, timeout, maxResults);
          results.push(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({
            tool: tool.name,
            source: this.getSource(tool.name),
            data: null,
            status: "error",
            error: message,
            executedAt: new Date(),
          });
        }
      }
    }

    // Store in history
    this.addToHistory(query, results);

    this.channel.appendLine(
      `[DeepSearch] Completed. ${results.filter((r) => !r.error).length}/${results.length} tools succeeded.`
    );

    return results;
  }

  /**
   * Execute a single search tool.
   */
  private async executeSearchTool(
    tool: DaemonToolInfo,
    query: string,
    timeout: number,
    maxResults: number
  ): Promise<SearchResult> {
    const startTime = Date.now();
    const source = tool.serverPrefix || this.getSource(tool.name);

    // Build tool arguments
    const config = this.resolveSearchToolConfig(tool) ?? { queryParam: "query" };
    const args = this.buildArgs(config, query, maxResults);

    this.channel.appendLine(`[DeepSearch] Executing ${tool.name}...`);

    try {
      const response = await Promise.race([
        this.daemonClient.executeTool(tool.name, args),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout")), timeout)),
      ]);

      const durationMs = Date.now() - startTime;

      if (!response.success) {
        return {
          tool: tool.name,
          source,
          data: null,
          status: "error",
          error: response.error ?? "Tool execution failed",
          executedAt: new Date(),
          durationMs,
        };
      }

      const summary = this.summarizeResult(response.result);
      return {
        tool: tool.name,
        source,
        data: response.result,
        status: "ok",
        executedAt: new Date(),
        durationMs,
        snippet: summary.snippet,
        resultCount: summary.resultCount,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);

      return {
        tool: tool.name,
        source,
        data: null,
        status: "error",
        error: message,
        executedAt: new Date(),
        durationMs,
      };
    }
  }

  /**
   * Get search history.
   */
  public getHistory(): Array<{ query: string; results: SearchResult[]; timestamp: Date }> {
    return [...this.searchHistory];
  }

  /**
   * Clear search history.
   */
  public clearHistory(): void {
    this.searchHistory = [];
  }

  /**
   * Add search to history.
   */
  private addToHistory(query: string, results: SearchResult[]): void {
    this.searchHistory.unshift({ query, results, timestamp: new Date() });
    if (this.searchHistory.length > this.maxHistory) {
      this.searchHistory = this.searchHistory.slice(0, this.maxHistory);
    }
  }

  /**
   * Get available search tools without executing them.
   */
  public async getSearchTools(): Promise<DaemonToolInfo[]> {
    const tools = await this.daemonClient.getTools();
    return tools.filter((tool) => this.resolveSearchToolConfig(tool) !== undefined);
  }

  private getSource(toolName: string): string {
    // Convention: servername__toolname
    if (toolName.includes("__")) {
      return toolName.split("__")[0];
    }
    return "system";
  }

  private resolveSearchToolConfig(tool: DaemonToolInfo): SearchToolConfig | undefined {
    return this.inferSearchToolConfigFromSchema(tool) ?? LEGACY_SEARCH_TOOL_CONFIGS[tool.name];
  }

  private inferSearchToolConfigFromSchema(tool: DaemonToolInfo): SearchToolConfig | undefined {
    const schemaProperties = this.getSchemaProperties(tool);
    if (!schemaProperties) {
      return undefined;
    }

    const queryParam = this.findQueryParam(schemaProperties, tool);
    if (!queryParam) {
      return undefined;
    }

    const limitParam = this.findLimitParam(schemaProperties);
    const familyDefaultLimit = this.getDefaultLimitParamForFamily(tool.serverPrefix || tool.server);

    return {
      queryParam,
      limitParam: limitParam ?? familyDefaultLimit,
    };
  }

  private getSchemaProperties(tool: DaemonToolInfo): Record<string, unknown> | undefined {
    const properties = tool.inputSchema?.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      return undefined;
    }

    return properties;
  }

  private findQueryParam(
    schemaProperties: Record<string, unknown>,
    tool: DaemonToolInfo
  ): string | undefined {
    const exactCandidate = QUERY_PARAM_CANDIDATES.find((candidate) =>
      Object.prototype.hasOwnProperty.call(schemaProperties, candidate)
    );
    if (exactCandidate) {
      return exactCandidate;
    }

    if (!this.isSearchLikeTool(tool)) {
      return undefined;
    }

    const requiredProperties = this.getRequiredProperties(tool);
    const requiredStringCandidates = requiredProperties.filter((propertyName) =>
      this.isStringLikeProperty(schemaProperties[propertyName])
    );
    if (requiredStringCandidates.length === 1) {
      return requiredStringCandidates[0];
    }

    const stringCandidates = Object.keys(schemaProperties).filter(
      (propertyName) =>
        this.isStringLikeProperty(schemaProperties[propertyName]) &&
        !this.isLimitLikeName(propertyName)
    );

    if (stringCandidates.length === 1) {
      return stringCandidates[0];
    }

    return requiredStringCandidates[0] ?? stringCandidates[0];
  }

  private findLimitParam(schemaProperties: Record<string, unknown>): string | undefined {
    return LIMIT_PARAM_CANDIDATES.find((candidate) =>
      Object.prototype.hasOwnProperty.call(schemaProperties, candidate)
    );
  }

  private getRequiredProperties(tool: DaemonToolInfo): string[] {
    const required = tool.inputSchema?.required;
    return Array.isArray(required)
      ? required.filter((value): value is string => typeof value === "string")
      : [];
  }

  private isStringLikeProperty(property: unknown): boolean {
    if (!property || typeof property !== "object" || Array.isArray(property)) {
      return false;
    }

    const typedProperty = property as {
      type?: string | string[];
      enum?: unknown[];
    };
    const propertyType = typedProperty.type;

    if (typeof propertyType === "string") {
      return propertyType === "string";
    }

    if (Array.isArray(propertyType) && propertyType.includes("string")) {
      return true;
    }

    return Array.isArray(typedProperty.enum);
  }

  private isLimitLikeName(propertyName: string): boolean {
    return LIMIT_PARAM_CANDIDATES.some((candidate) => propertyName.includes(candidate));
  }

  private isSearchLikeTool(tool: DaemonToolInfo): boolean {
    const haystack = [tool.name, tool.description, tool.server, tool.serverPrefix]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase();

    return SEARCH_NAME_HINTS.some((hint) => haystack.includes(hint));
  }

  private buildArgs(
    config: SearchToolConfig,
    query: string,
    maxResults: number
  ): Record<string, unknown> {
    const args: Record<string, unknown> = {
      [config.queryParam]: query,
      ...(config.staticParams ?? {}),
    };

    if (config.limitParam) {
      args[config.limitParam] = maxResults;
    }

    return args;
  }

  private getDefaultLimitParamForFamily(family: string): string | undefined {
    const normalized = family.toLowerCase();
    if (normalized === "tavily") return "max_results";
    if (normalized === "github" || normalized === "gitlab") return "per_page";
    if (
      normalized === "codebase_memory" ||
      normalized === "agent_context" ||
      normalized === "qdrant" ||
      normalized === "memory"
    ) {
      return "limit";
    }
    return undefined;
  }

  private summarizeResult(data: unknown): { snippet?: string; resultCount?: number } {
    if (data === null || data === undefined) {
      return {};
    }

    if (typeof data === "string") {
      const snippet = this.trimSnippet(data);
      return snippet ? { snippet } : {};
    }

    if (Array.isArray(data)) {
      return {
        resultCount: data.length,
        snippet: data.length > 0 ? this.stringifySnippet(data[0]) : undefined,
      };
    }

    if (typeof data === "object") {
      const record = data as Record<string, unknown>;
      for (const key of RESULT_LIST_KEYS) {
        const value = record[key];
        if (Array.isArray(value)) {
          return {
            resultCount: value.length,
            snippet: value.length > 0 ? this.stringifySnippet(value[0]) : undefined,
          };
        }
      }
      return { snippet: this.stringifySnippet(record) };
    }

    if (typeof data === "number" || typeof data === "boolean" || typeof data === "bigint") {
      return { snippet: this.trimSnippet(String(data)) };
    }

    return {};
  }

  private stringifySnippet(value: unknown): string {
    if (typeof value === "string") {
      return this.trimSnippet(value);
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return this.trimSnippet(String(value));
    }
    try {
      return this.trimSnippet(JSON.stringify(value));
    } catch {
      return "";
    }
  }

  private trimSnippet(input: string): string {
    const compact = input.replace(/\s+/g, " ").trim();
    if (!compact) {
      return "";
    }
    const maxLength = 220;
    return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
  }
}
