import * as vscode from "vscode";

import { DaemonClient } from "../clients/daemon";
import { Tool } from "../types";

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
   */
  public async search(query: string): Promise<SearchResult[]> {
    this.channel.appendLine(`[DeepSearch] Starting search for: "${query}"`);

    // 1. Get all available tools
    let tools: Tool[] = [];
    try {
      const result = await this.daemonClient.getTools();
      tools = result.tools;
    } catch (error) {
      this.channel.appendLine(`[DeepSearch] Failed to fetch tools: ${error}`);
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

    // 3. Execute in parallel
    const promises = searchTools.map(async (tool) => {
      try {
        // Determine the "query" parameter name. Most schemas uses "query", "q", "search", "term".
        // We'll inspect the schema to find the best fit.
        const paramName = this.guessQueryParam(tool.inputSchema);
        if (!paramName) {
          return {
            tool: tool.name,
            source: this.getSource(tool.name),
            error: "Could not identify query parameter",
            data: null,
          };
        }

        const args = { [paramName]: query };
        const result = await this.daemonClient.callTool(tool.name, args);

        return {
          tool: tool.name,
          source: this.getSource(tool.name),
          data: result,
          error: undefined,
        };
      } catch (error) {
        return {
          tool: tool.name,
          source: this.getSource(tool.name),
          error: error instanceof Error ? error.message : String(error),
          data: null,
        };
      }
    });

    const results = await Promise.all(promises);
    return results;
  }

  private getSource(toolName: string): string {
    // Convention: servername__toolname
    if (toolName.includes("__")) {
      return toolName.split("__")[0];
    }
    return "system";
  }

  private guessQueryParam(schema: any): string | null {
    if (!schema?.properties) return null;

    const props = Object.keys(schema.properties);

    // Preferred matches
    const candidates = ["query", "q", "search", "term", "text", "filter", "jql"]; // jql for jira

    for (const candidate of candidates) {
      if (props.includes(candidate)) return candidate;
    }

    // Fallback: Use the first string property if only one required
    if (schema.required && schema.required.length === 1) {
      return schema.required[0];
    }

    // Fallback: Use the first property
    if (props.length > 0) {
      return props[0];
    }

    return null;
  }
}
