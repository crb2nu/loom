import * as vscode from "vscode";

import { DaemonClient } from "../clients/daemon";
import { DaemonToolInfo } from "../types";

export interface SearchResult {
  tool: string;
  source: string;
  data: unknown;
  error?: string;
  executedAt?: Date;
  durationMs?: number;
}

export interface SearchOptions {
  tools?: string[]; // Specific tools to use, or all search tools if empty
  parallel?: boolean; // Execute in parallel (default: true)
  timeout?: number; // Timeout per tool in ms (default: 30000)
  maxResults?: number; // Max results per tool (default: 10)
}

// Known search tool configurations
const SEARCH_TOOL_CONFIGS: Record<
  string,
  { queryParam: string; extraParams?: Record<string, unknown> }
> = {
  tavily__search: { queryParam: "query", extraParams: { max_results: 10 } },
  tavily__search_context: { queryParam: "query", extraParams: { max_results: 5 } },
  github__search_repos: { queryParam: "query", extraParams: { per_page: 10 } },
  github__search_code: { queryParam: "query", extraParams: { per_page: 10 } },
  gitlab__search_repositories: { queryParam: "query" },
  codebase_memory__codebase_search: { queryParam: "query", extraParams: { limit: 10 } },
  codebase_memory__codebase_text_search: { queryParam: "query", extraParams: { limit: 10 } },
  memory__search_nodes: { queryParam: "query" },
  agent_context__agent_context_search: { queryParam: "query", extraParams: { limit: 10 } },
  qdrant__qdrant_search: { queryParam: "query", extraParams: { limit: 10 } },
};

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
      searchTools = tools.filter(
        (t) =>
          t.name.toLowerCase().includes("search") ||
          t.name.toLowerCase().includes("find") ||
          t.name.toLowerCase().includes("query")
      );
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
            error: reason?.message ?? "Unknown error",
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
            error: message,
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
    const source = this.getSource(tool.name);

    // Build tool arguments
    const config = SEARCH_TOOL_CONFIGS[tool.name];
    const queryParam = config?.queryParam ?? "query";
    const extraParams = config?.extraParams ?? {};

    const args: Record<string, unknown> = {
      [queryParam]: query,
      ...extraParams,
    };

    // Override max results if specified
    if (args.max_results !== undefined) {
      args.max_results = maxResults;
    } else if (args.limit !== undefined) {
      args.limit = maxResults;
    } else if (args.per_page !== undefined) {
      args.per_page = maxResults;
    }

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
          error: response.error ?? "Tool execution failed",
          executedAt: new Date(),
          durationMs,
        };
      }

      return {
        tool: tool.name,
        source,
        data: response.result,
        executedAt: new Date(),
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);

      return {
        tool: tool.name,
        source,
        data: null,
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
    return tools.filter(
      (t) =>
        t.name.toLowerCase().includes("search") ||
        t.name.toLowerCase().includes("find") ||
        t.name.toLowerCase().includes("query")
    );
  }

  private getSource(toolName: string): string {
    // Convention: servername__toolname
    if (toolName.includes("__")) {
      return toolName.split("__")[0];
    }
    return "system";
  }
}
