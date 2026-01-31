import * as vscode from "vscode";

import { DaemonClient } from "../clients/daemon";
import { DaemonToolInfo } from "../types";

export interface SearchResult {
  tool: string;
  source: string;
  data: unknown;
  error?: string;
}

export class DeepSearchManager {
  constructor(
    private readonly daemonClient: DaemonClient,
    private readonly channel: vscode.OutputChannel
  ) {}

  /**
   * Executes a search query across all available search-capable tools.
   * Note: Currently returns search-capable tools but cannot execute them
   * because the daemon client doesn't support tool execution yet.
   */
  public async search(query: string): Promise<SearchResult[]> {
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
    // Heuristic: Name contains "search" or "find" or "query"
    const searchTools = tools.filter(
      (t) =>
        t.name.toLowerCase().includes("search") ||
        t.name.toLowerCase().includes("find") ||
        t.name.toLowerCase().includes("query")
    );

    if (searchTools.length === 0) {
      this.channel.appendLine("[DeepSearch] No search-capable tools found.");
      return [];
    }

    this.channel.appendLine(
      `[DeepSearch] Identified ${searchTools.length} search tools: ${searchTools.map((t) => t.name).join(", ")}`
    );

    // 3. Return identified tools - actual execution would require tool call support in daemon
    // For now, we just identify which tools could be used for search
    const results: SearchResult[] = searchTools.map((tool) => ({
      tool: tool.name,
      source: this.getSource(tool.name),
      data: {
        description: tool.description ?? "No description",
        message: `Search tool identified: ${tool.name}`,
        query,
      },
      error: undefined,
    }));

    return results;
  }

  private getSource(toolName: string): string {
    // Convention: servername__toolname
    if (toolName.includes("__")) {
      return toolName.split("__")[0];
    }
    return "system";
  }
}
