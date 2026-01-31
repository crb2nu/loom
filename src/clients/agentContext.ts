import { execFile } from "child_process";
import * as os from "os";
import { promisify } from "util";

import * as vscode from "vscode";

import {
  AgentSession,
  AgentContextEntry,
  AgentTask,
  AgentCodeAnnotation,
  KnowledgeGraphEntity,
  KnowledgeGraphRelation,
  MemoryTier,
} from "../types";
import { resolveLoomBinary } from "../utils/binary";

const execFileAsync = promisify(execFile);

/**
 * Client for interacting with the mcp-agent-context MCP server.
 * Wraps MCP tool calls via the loom CLI.
 */
export class AgentContextClient {
  private readonly workspaceRoot: string;
  private readonly channel: vscode.OutputChannel;
  private agentId: string;

  constructor(
    workspaceRoot: string,
    channel: vscode.OutputChannel,
    agentId: string = "vscode-loom"
  ) {
    this.workspaceRoot = workspaceRoot;
    this.channel = channel;
    this.agentId = agentId;
  }

  /**
   * Execute an MCP tool via loom CLI.
   */
  private async executeTool<T>(toolName: string, args: Record<string, unknown>): Promise<T | null> {
    try {
      const loomBinary = resolveLoomBinary(this.workspaceRoot);
      const argsJson = JSON.stringify(args);

      this.channel.appendLine(`[${new Date().toISOString()}] MCP tool: ${toolName} ${argsJson}`);

      const { stdout } = await execFileAsync(
        loomBinary,
        ["tools", "call", toolName, "--args", argsJson],
        {
          cwd: this.workspaceRoot || os.homedir(),
          timeout: 30000,
        }
      );

      return JSON.parse(stdout) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(
        `[${new Date().toISOString()}] MCP tool error (${toolName}): ${message}`
      );
      return null;
    }
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  /**
   * Start a new agent session.
   */
  async startSession(namespace: string, description?: string): Promise<AgentSession | null> {
    return this.executeTool<AgentSession>("agent_session_start", {
      namespace,
      description,
      agent_id: this.agentId,
    });
  }

  /**
   * End an agent session.
   */
  async endSession(sessionId: string, summarize: boolean = true): Promise<boolean> {
    const result = await this.executeTool<{ success: boolean }>("agent_session_end", {
      session_id: sessionId,
      summarize,
    });
    return result?.success ?? false;
  }

  /**
   * List all sessions.
   */
  async listSessions(status?: "active" | "ended", namespace?: string): Promise<AgentSession[]> {
    const result = await this.executeTool<{ sessions: AgentSession[] }>("agent_session_list", {
      status,
      namespace,
      agent_id: this.agentId,
    });
    return result?.sessions ?? [];
  }

  /**
   * Get session by ID.
   */
  async getSession(sessionId: string): Promise<AgentSession | null> {
    const result = await this.executeTool<{ session: AgentSession }>("agent_session_get", {
      session_id: sessionId,
    });
    return result?.session ?? null;
  }

  // ============================================================================
  // Context Entries
  // ============================================================================

  /**
   * Add context entries to a session.
   */
  async addContextEntries(
    sessionId: string,
    entries: Array<Omit<AgentContextEntry, "entry_id" | "session_id" | "created_at">>
  ): Promise<AgentContextEntry[]> {
    const result = await this.executeTool<{ entries: AgentContextEntry[] }>("agent_context_add", {
      session_id: sessionId,
      entries,
    });
    return result?.entries ?? [];
  }

  /**
   * Search context entries.
   */
  async searchContext(
    query: string,
    options?: {
      session_id?: string;
      entry_types?: string[];
      tags?: string[];
      limit?: number;
    }
  ): Promise<AgentContextEntry[]> {
    const result = await this.executeTool<{ entries: AgentContextEntry[] }>(
      "agent_context_search",
      {
        query,
        ...options,
      }
    );
    return result?.entries ?? [];
  }

  /**
   * Enhanced recall with file context.
   */
  async recallEnhanced(
    query: string,
    fileContext?: string,
    namespace?: string
  ): Promise<{
    entries: AgentContextEntry[];
    decisions: AgentContextEntry[];
    tasks: AgentTask[];
  }> {
    const result = await this.executeTool<{
      entries: AgentContextEntry[];
      decisions: AgentContextEntry[];
      tasks: AgentTask[];
    }>("agent_context_recall_enhanced", {
      query,
      file_context: fileContext,
      namespace,
      agent_id: this.agentId,
    });
    return result ?? { entries: [], decisions: [], tasks: [] };
  }

  // ============================================================================
  // Task Management
  // ============================================================================

  /**
   * Add tasks to a session.
   */
  async addTasks(
    sessionId: string,
    tasks: Array<Omit<AgentTask, "task_id" | "session_id" | "status" | "created_at" | "updated_at">>
  ): Promise<AgentTask[]> {
    const result = await this.executeTool<{ tasks: AgentTask[] }>("agent_task_add", {
      session_id: sessionId,
      tasks,
    });
    return result?.tasks ?? [];
  }

  /**
   * Update a task.
   */
  async updateTask(
    taskId: string,
    updates: Partial<Pick<AgentTask, "status" | "resolution" | "description">>
  ): Promise<AgentTask | null> {
    const result = await this.executeTool<{ task: AgentTask }>("agent_task_update", {
      task_id: taskId,
      ...updates,
    });
    return result?.task ?? null;
  }

  /**
   * List tasks.
   */
  async listTasks(
    sessionId?: string,
    status?: AgentTask["status"],
    priority?: AgentTask["priority"]
  ): Promise<AgentTask[]> {
    const result = await this.executeTool<{ tasks: AgentTask[] }>("agent_task_list", {
      session_id: sessionId,
      status,
      priority,
    });
    return result?.tasks ?? [];
  }

  // ============================================================================
  // Code Annotations
  // ============================================================================

  /**
   * Add a code annotation.
   */
  async addAnnotation(
    sessionId: string,
    annotation: Omit<AgentCodeAnnotation, "annotation_id" | "session_id" | "created_at">
  ): Promise<AgentCodeAnnotation | null> {
    const result = await this.executeTool<{ annotation: AgentCodeAnnotation }>(
      "agent_code_annotate",
      {
        session_id: sessionId,
        ...annotation,
      }
    );
    return result?.annotation ?? null;
  }

  /**
   * Get annotations for a file.
   */
  async getAnnotations(filePath: string, sessionId?: string): Promise<AgentCodeAnnotation[]> {
    const result = await this.executeTool<{ annotations: AgentCodeAnnotation[] }>(
      "agent_code_annotations_get",
      {
        file_path: filePath,
        session_id: sessionId,
      }
    );
    return result?.annotations ?? [];
  }

  // ============================================================================
  // Knowledge Graph
  // ============================================================================

  /**
   * Create entities in the knowledge graph.
   */
  async createEntities(
    entities: Array<Omit<KnowledgeGraphEntity, "entity_id">>
  ): Promise<KnowledgeGraphEntity[]> {
    const result = await this.executeTool<{ entities: KnowledgeGraphEntity[] }>(
      "agent_entity_create",
      {
        entities,
      }
    );
    return result?.entities ?? [];
  }

  /**
   * Create relations in the knowledge graph.
   */
  async createRelations(
    relations: Array<Omit<KnowledgeGraphRelation, "relation_id">>
  ): Promise<KnowledgeGraphRelation[]> {
    const result = await this.executeTool<{ relations: KnowledgeGraphRelation[] }>(
      "agent_relation_create",
      {
        relations,
      }
    );
    return result?.relations ?? [];
  }

  /**
   * Get the full knowledge graph.
   */
  async getKnowledgeGraph(): Promise<{
    entities: KnowledgeGraphEntity[];
    relations: KnowledgeGraphRelation[];
  }> {
    const result = await this.executeTool<{
      entities: KnowledgeGraphEntity[];
      relations: KnowledgeGraphRelation[];
    }>("agent_knowledge_graph_get", {});
    return result ?? { entities: [], relations: [] };
  }

  /**
   * Search the knowledge graph.
   */
  async searchKnowledgeGraph(
    query: string,
    entityTypes?: string[]
  ): Promise<KnowledgeGraphEntity[]> {
    const result = await this.executeTool<{ entities: KnowledgeGraphEntity[] }>(
      "agent_entity_search",
      {
        query,
        entity_types: entityTypes,
      }
    );
    return result?.entities ?? [];
  }

  // ============================================================================
  // Memory Management
  // ============================================================================

  /**
   * Get memory tiers.
   */
  async getMemoryTiers(sessionId?: string): Promise<MemoryTier[]> {
    const result = await this.executeTool<{ tiers: MemoryTier[] }>("agent_memory_tiers_get", {
      session_id: sessionId,
    });
    return result?.tiers ?? [];
  }

  /**
   * Promote entry to a higher tier.
   */
  async promoteEntry(entryId: string, targetTier: MemoryTier["tier"]): Promise<boolean> {
    const result = await this.executeTool<{ success: boolean }>("agent_memory_promote", {
      entry_id: entryId,
      target_tier: targetTier,
    });
    return result?.success ?? false;
  }

  /**
   * Compress memory (summarize and archive).
   */
  async compressMemory(sessionId: string): Promise<boolean> {
    const result = await this.executeTool<{ success: boolean }>("agent_memory_compress", {
      session_id: sessionId,
    });
    return result?.success ?? false;
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Set the agent ID.
   */
  setAgentId(agentId: string): void {
    this.agentId = agentId;
  }

  /**
   * Get the current agent ID.
   */
  getAgentId(): string {
    return this.agentId;
  }
}
