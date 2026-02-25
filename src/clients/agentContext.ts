import { execFile } from "child_process";
import * as os from "os";
import { promisify } from "util";

import * as vscode from "vscode";
import { parse as parseYaml } from "yaml";

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
import { Logger } from "../utils/logger";

const execFileAsync = promisify(execFile);
const AGENT_CONTEXT_PREFIX = "agent_context__";
const INDEXED_KEY_PATTERN = /^([a-zA-Z0-9_]+)\[(\d+)\]$/;
const TABLE_KEY_PATTERN = /^([a-zA-Z0-9_]+)\[(\d+)\]\{([^}]+)\}$/;
const DEFAULT_TASK_PRIORITY: AgentTask["priority"] = "medium";
const DEFAULT_TASK_STATUS: AgentTask["status"] = "pending";

interface ToolContent {
  type?: string;
  text?: string;
}

interface ToolEnvelope {
  content?: ToolContent[];
  isError?: boolean;
}

interface ToolExecutionResult {
  data: LooseRecord | null;
  errorText?: string;
  toolNotFound?: boolean;
}

type LooseRecord = Record<string, unknown>;

/**
 * Client for interacting with the mcp-agent-context MCP server.
 * Wraps MCP tool calls via the loom CLI.
 */
export class AgentContextClient {
  private readonly workspaceRoot: string;
  private readonly logger: Logger;
  private agentId: string;

  constructor(
    workspaceRoot: string,
    channel: vscode.OutputChannel,
    agentId: string = "vscode-loom"
  ) {
    this.workspaceRoot = workspaceRoot;
    this.logger = new Logger(channel, "AgentContext");
    this.agentId = agentId;
  }

  /**
   * Execute an MCP tool via loom CLI and normalize the daemon's response payload.
   */
  private async executeTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<LooseRecord | null> {
    const normalizedArgs = Object.fromEntries(
      Object.entries(args).filter(([, value]) => value !== undefined)
    );
    const argsJson = JSON.stringify(normalizedArgs);
    const candidates = this.getToolNameCandidates(toolName);

    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      this.logger.info(`MCP tool: ${candidate} ${argsJson}`);
      const result = await this.runToolCall(candidate, argsJson);
      if (result.data) {
        return result.data;
      }
      if (result.toolNotFound && i < candidates.length - 1) {
        this.logger.info(`MCP tool not found (${candidate}), trying compatibility fallback`);
        continue;
      }
      if (result.errorText) {
        this.logger.error(`MCP tool error (${candidate}): ${result.errorText}`);
        return null;
      }
    }
    return null;
  }

  private getToolNameCandidates(toolName: string): string[] {
    if (toolName.startsWith(AGENT_CONTEXT_PREFIX)) {
      const unprefixed = toolName.slice(AGENT_CONTEXT_PREFIX.length);
      return unprefixed ? [toolName, unprefixed] : [toolName];
    }
    return [`${AGENT_CONTEXT_PREFIX}${toolName}`, toolName];
  }

  private async runToolCall(toolName: string, argsJson: string): Promise<ToolExecutionResult> {
    const loomBinary = resolveLoomBinary(this.workspaceRoot);
    const cwd = this.workspaceRoot || os.homedir();

    try {
      const { stdout } = await execFileAsync(
        loomBinary,
        ["tools", "call", toolName, "--json", "--args", argsJson],
        {
          cwd,
          timeout: 30000,
        }
      );
      return this.parseToolOutput(stdout);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isJsonFlagUnsupported(message)) {
        try {
          const { stdout } = await execFileAsync(
            loomBinary,
            ["tools", "call", toolName, "--args", argsJson],
            {
              cwd,
              timeout: 30000,
            }
          );
          return this.parseToolOutput(stdout);
        } catch (fallbackError) {
          const fallbackMessage =
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          return {
            data: null,
            errorText: fallbackMessage,
            toolNotFound: this.isToolNotFoundMessage(fallbackMessage),
          };
        }
      }

      return {
        data: null,
        errorText: message,
        toolNotFound: this.isToolNotFoundMessage(message),
      };
    }
  }

  private parseToolOutput(stdout: string): ToolExecutionResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { data: {} };
    }

    try {
      const parsedJson = JSON.parse(trimmed) as unknown;
      const parsedRecord = this.asRecord(parsedJson);
      const envelope = parsedRecord as ToolEnvelope | null;
      if (envelope && Array.isArray(envelope.content)) {
        const text = this.extractText(envelope.content);
        if (envelope.isError) {
          return {
            data: null,
            errorText: text || "unknown error",
            toolNotFound: this.isToolNotFoundMessage(text),
          };
        }
        if (!text.trim()) {
          return { data: {} };
        }
        const parsedText = this.parseTextPayload(text);
        return { data: parsedText ?? { raw: text } };
      }

      const normalizedJson = this.normalizeSpecialKeys(parsedJson);
      const asRecord = this.asRecord(normalizedJson);
      if (asRecord) {
        return { data: asRecord };
      }
    } catch {
      // Fall through to plain text/YAML parsing.
    }

    const parsedText = this.parseTextPayload(trimmed);
    return { data: parsedText ?? { raw: trimmed } };
  }

  private parseTextPayload(text: string): LooseRecord | null {
    try {
      const parsedYaml = parseYaml(text) as unknown;
      const normalized = this.normalizeSpecialKeys(parsedYaml);
      return this.asRecord(normalized);
    } catch {
      return null;
    }
  }

  private isJsonFlagUnsupported(message: string): boolean {
    return /unknown flag: --json|flag provided but not defined/i.test(message);
  }

  private isToolNotFoundMessage(message: string): boolean {
    return /not found|unknown tool|no such tool|does not exist|unrecognized tool/i.test(message);
  }

  private extractText(content: ToolContent[]): string {
    return content
      .map((item) => item.text ?? "")
      .filter((text) => text.length > 0)
      .join("\n")
      .trim();
  }

  private normalizeSpecialKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeSpecialKeys(item));
    }

    if (value === null || typeof value !== "object") {
      return value;
    }

    const input = value as LooseRecord;
    const output: LooseRecord = {};

    for (const [rawKey, rawValue] of Object.entries(input)) {
      const normalizedValue = this.normalizeSpecialKeys(rawValue);
      const tableMatch = rawKey.match(TABLE_KEY_PATTERN);
      if (tableMatch) {
        const [, baseKey, , fieldList] = tableMatch;
        output[baseKey] = this.parseTableRows(fieldList, normalizedValue);
        continue;
      }

      const indexedMatch = rawKey.match(INDEXED_KEY_PATTERN);
      if (indexedMatch) {
        const [, baseKey] = indexedMatch;
        output[baseKey] = this.normalizeIndexedValue(normalizedValue);
        continue;
      }

      output[rawKey] = normalizedValue;
    }

    return output;
  }

  private parseTableRows(fieldList: string, value: unknown): LooseRecord[] {
    const fields = fieldList
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);

    const rows: string[] = [];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          const trimmed = item.trim();
          if (trimmed.length > 0) rows.push(trimmed);
        }
      }
    } else if (typeof value === "string") {
      for (const line of value.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0) rows.push(trimmed);
      }
    } else if (typeof value === "number" || typeof value === "boolean") {
      rows.push(`${value}`);
    }

    return rows.map((row) => {
      const values = this.parseCsvRow(row);
      const record: LooseRecord = {};
      for (let i = 0; i < fields.length; i += 1) {
        record[fields[i]] = this.coerceScalar(values[i] ?? "");
      }
      return record;
    });
  }

  private normalizeIndexedValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value;
    }

    if (value === null || value === undefined) {
      return [];
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return [];
      }
      if (trimmed.includes(",")) {
        return this.parseCsvRow(trimmed).map((part) => this.coerceScalar(part));
      }
      return [this.coerceScalar(trimmed)];
    }

    return [value];
  }

  private parseCsvRow(row: string): string[] {
    const values: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < row.length; i += 1) {
      const char = row[i];
      const next = row[i + 1];

      if (char === '"') {
        if (inQuotes && next === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (char === "," && !inQuotes) {
        values.push(current.trim());
        current = "";
        continue;
      }

      current += char;
    }

    values.push(current.trim());
    return values;
  }

  private coerceScalar(value: string): unknown {
    const trimmed = value.trim();
    if (trimmed.length === 0) return "";
    if (trimmed === "null") return null;
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;

    const numberValue = Number(trimmed);
    if (!Number.isNaN(numberValue) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
      return numberValue;
    }

    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
      return trimmed.slice(1, -1);
    }

    return trimmed;
  }

  private asRecord(value: unknown): LooseRecord | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as LooseRecord)
      : null;
  }

  private asRecordArray(value: unknown): LooseRecord[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((item) => this.asRecord(item))
      .filter((item): item is LooseRecord => item !== null);
  }

  private asString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  private asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((item) => this.asString(item))
      .filter((item): item is string => item !== undefined);
  }

  private normalizeSession(session: LooseRecord): AgentSession {
    const sessionId =
      this.asString(session.session_id) ?? this.asString(session.id) ?? `session-${Date.now()}`;
    const endedAt = this.asString(session.ended_at);
    const rawStatus = this.asString(session.status);
    const status: AgentSession["status"] =
      rawStatus === "active" || rawStatus === "ended" || rawStatus === "summarized"
        ? rawStatus
        : endedAt
          ? "ended"
          : "active";

    return {
      session_id: sessionId,
      namespace: this.asString(session.namespace) ?? "unknown",
      description: this.asString(session.description),
      agent_id: this.asString(session.agent_id) ?? this.agentId,
      started_at: this.asString(session.started_at) ?? new Date().toISOString(),
      ended_at: endedAt,
      status,
      entry_count: this.asNumber(session.entry_count) ?? 0,
    };
  }

  private normalizeContextEntry(entry: LooseRecord): AgentContextEntry {
    const entryId =
      this.asString(entry.entry_id) ?? this.asString(entry.id) ?? `entry-${Date.now()}`;
    const createdAt =
      this.asString(entry.created_at) ?? this.asString(entry.timestamp) ?? new Date().toISOString();

    return {
      entry_id: entryId,
      session_id: this.asString(entry.session_id) ?? "",
      entry_type: this.asString(entry.entry_type) ?? "note",
      title: this.asString(entry.title) ?? "(untitled)",
      content: this.asString(entry.content) ?? "",
      tags: Array.isArray(entry.tags)
        ? entry.tags
            .map((tag) => this.asString(tag))
            .filter((tag): tag is string => tag !== undefined)
        : undefined,
      file_path: this.asString(entry.file_path),
      line_start: this.asNumber(entry.line_start),
      line_end: this.asNumber(entry.line_end),
      created_at: createdAt,
    };
  }

  private normalizeTask(task: LooseRecord): AgentTask {
    const metadata = this.asRecord(task.metadata) ?? {};
    const rawPriority = this.asString(task.priority) ?? this.asString(metadata.task_priority);
    const priority: AgentTask["priority"] =
      rawPriority === "low" ||
      rawPriority === "medium" ||
      rawPriority === "high" ||
      rawPriority === "critical"
        ? rawPriority
        : DEFAULT_TASK_PRIORITY;

    const rawStatus = this.asString(task.status) ?? this.asString(metadata.task_status);
    const status: AgentTask["status"] =
      rawStatus === "pending" ||
      rawStatus === "in_progress" ||
      rawStatus === "completed" ||
      rawStatus === "blocked"
        ? rawStatus
        : DEFAULT_TASK_STATUS;

    const title = this.asString(task.title) ?? "(untitled task)";
    const normalizedTitle = title.replace(/^\[[^\]]+\]\s*/, "");
    return {
      task_id: this.asString(task.task_id) ?? this.asString(task.id) ?? `task-${Date.now()}`,
      session_id: this.asString(task.session_id) ?? "",
      title: normalizedTitle,
      description: this.asString(task.description),
      priority,
      status,
      file_path: this.asString(task.file_path),
      context: this.asString(task.context),
      resolution: this.asString(task.resolution),
      created_at:
        this.asString(task.created_at) ?? this.asString(task.timestamp) ?? new Date().toISOString(),
      updated_at: this.asString(task.updated_at) ?? new Date().toISOString(),
    };
  }

  private normalizeAnnotation(annotation: LooseRecord): AgentCodeAnnotation {
    const lineStart = this.asNumber(annotation.line_start) ?? 1;
    return {
      annotation_id:
        this.asString(annotation.annotation_id) ??
        this.asString(annotation.id) ??
        `annotation-${Date.now()}`,
      session_id: this.asString(annotation.session_id) ?? "",
      file_path: this.asString(annotation.file_path) ?? "",
      line_start: lineStart,
      line_end: this.asNumber(annotation.line_end) ?? lineStart,
      annotation_type: this.normalizeAnnotationType(this.asString(annotation.annotation_type)),
      content: this.asString(annotation.content) ?? "",
      created_at: this.asString(annotation.created_at) ?? new Date().toISOString(),
    };
  }

  private normalizeAnnotationType(
    type: string | undefined
  ): AgentCodeAnnotation["annotation_type"] {
    if (
      type === "note" ||
      type === "todo" ||
      type === "warning" ||
      type === "question" ||
      type === "decision"
    ) {
      return type;
    }
    return "note";
  }

  private normalizeMemoryTier(tier: string | undefined): MemoryTier["tier"] {
    if (tier === "working" || tier === "short_term" || tier === "long_term") {
      return tier;
    }
    return "working";
  }

  private normalizeEntity(entity: LooseRecord): KnowledgeGraphEntity {
    const entityType = this.asString(entity.entity_type) ?? this.asString(entity.type) ?? "entity";
    const properties = { ...entity };
    delete properties.id;
    delete properties.entity_id;
    delete properties.name;
    delete properties.type;
    delete properties.entity_type;
    return {
      entity_id:
        this.asString(entity.entity_id) ?? this.asString(entity.id) ?? `entity-${Date.now()}`,
      name: this.asString(entity.name) ?? "(unnamed entity)",
      entity_type: entityType,
      properties,
    };
  }

  private normalizeRelation(relation: LooseRecord): KnowledgeGraphRelation {
    const relationType =
      this.asString(relation.relation_type) ?? this.asString(relation.type) ?? "related_to";
    const properties = { ...relation };
    delete properties.id;
    delete properties.relation_id;
    delete properties.source_id;
    delete properties.target_id;
    delete properties.type;
    delete properties.relation_type;
    return {
      relation_id:
        this.asString(relation.relation_id) ??
        this.asString(relation.id) ??
        `relation-${Date.now()}`,
      source_id: this.asString(relation.source_id) ?? "",
      target_id: this.asString(relation.target_id) ?? "",
      relation_type: relationType,
      properties,
    };
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  /**
   * Start a new agent session.
   */
  async startSession(namespace: string, description?: string): Promise<AgentSession | null> {
    const result = await this.executeTool("agent_session_start", {
      namespace,
      description,
      agent_id: this.agentId,
      working_dir: this.workspaceRoot || undefined,
    });
    if (!result) return null;
    return this.normalizeSession(result);
  }

  /**
   * End an agent session.
   */
  async endSession(sessionId: string, summarize: boolean = true): Promise<boolean> {
    const result = await this.executeTool("agent_session_end", {
      session_id: sessionId,
      summarize,
    });
    return Boolean(result?.ok ?? result?.success);
  }

  /**
   * List all sessions.
   */
  async listSessions(status?: AgentSession["status"], namespace?: string): Promise<AgentSession[]> {
    const result = await this.executeTool("agent_session_list", {
      status,
      namespace,
      agent_id: this.agentId,
      limit: 200,
    });
    if (!result) return [];
    return this.asRecordArray(result.sessions).map((session) => this.normalizeSession(session));
  }

  /**
   * Get session by ID.
   */
  async getSession(sessionId: string): Promise<AgentSession | null> {
    const ownSessions = await this.listSessions();
    const ownMatch = ownSessions.find((session) => session.session_id === sessionId);
    if (ownMatch) {
      return ownMatch;
    }

    const allSessionsResult = await this.executeTool("agent_session_list", { limit: 500 });
    if (!allSessionsResult) return null;
    const allSessions = this.asRecordArray(allSessionsResult.sessions).map((session) =>
      this.normalizeSession(session)
    );
    return allSessions.find((session) => session.session_id === sessionId) ?? null;
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
    const result = await this.executeTool("agent_context_add", {
      session_id: sessionId,
      entries,
    });
    if (!result) return [];

    const entryIds = this.asStringArray(result.entry_ids);
    const createdAt = new Date().toISOString();
    return entries.map((entry, index) => ({
      entry_id: entryIds[index] ?? `${sessionId}-entry-${index}`,
      session_id: sessionId,
      created_at: createdAt,
      ...entry,
    }));
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
    const searchQuery = query.trim() || "*";
    let result = await this.executeTool("agent_context_search", {
      query: searchQuery,
      agent_id: this.agentId,
      ...options,
    });
    if (!result && query.trim().length === 0) {
      result = await this.executeTool("agent_context_search", {
        query: "",
        agent_id: this.agentId,
        ...options,
      });
    }
    if (!result) return [];

    const results = this.asRecordArray(result.results);
    const entriesFromResults = results
      .map((item) => this.asRecord(item.entry))
      .filter((entry): entry is LooseRecord => entry !== null)
      .map((entry) => this.normalizeContextEntry(entry));

    const directEntries = this.asRecordArray(result.entries).map((entry) =>
      this.normalizeContextEntry(entry)
    );

    const combined = entriesFromResults.length > 0 ? entriesFromResults : directEntries;
    return combined.filter((entry) => {
      if (options?.entry_types && !options.entry_types.includes(entry.entry_type)) {
        return false;
      }
      if (options?.tags && options.tags.length > 0) {
        const entryTags = entry.tags ?? [];
        if (!options.tags.some((tag) => entryTags.includes(tag))) {
          return false;
        }
      }
      return true;
    });
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
    const result = await this.executeTool("agent_context_recall_enhanced", {
      query: query.trim() || "*",
      file_context: fileContext,
      namespace,
      agent_id: this.agentId,
    });
    if (!result) return { entries: [], decisions: [], tasks: [] };

    const entryRecords = this.asRecordArray(result.entries);
    const entries = entryRecords.map((entry) => this.normalizeContextEntry(entry));
    const decisions = entries.filter((entry) => entry.entry_type === "decision");

    const taskRecords = this.asRecordArray(result.tasks);
    const tasks =
      taskRecords.length > 0
        ? taskRecords.map((task) => this.normalizeTask(task))
        : entryRecords
            .filter((entry) => (this.asString(entry.entry_type) ?? "") === "task")
            .map((task) => this.normalizeTask(task));

    return { entries, decisions, tasks };
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
    const result = await this.executeTool("agent_task_add", {
      session_id: sessionId,
      tasks,
    });
    if (!result) return [];

    const taskIds = this.asStringArray(result.task_ids);
    const timestamp = new Date().toISOString();
    return tasks.map((task, index) => ({
      task_id: taskIds[index] ?? `${sessionId}-task-${index}`,
      session_id: sessionId,
      title: task.title,
      description: task.description,
      priority: task.priority ?? DEFAULT_TASK_PRIORITY,
      status: DEFAULT_TASK_STATUS,
      file_path: task.file_path,
      context: task.context,
      resolution: task.resolution,
      created_at: timestamp,
      updated_at: timestamp,
    }));
  }

  /**
   * Update a task.
   */
  async updateTask(
    taskId: string,
    updates: Partial<Pick<AgentTask, "status" | "resolution" | "description">>
  ): Promise<AgentTask | null> {
    const result = await this.executeTool("agent_task_update", {
      task_id: taskId,
      ...updates,
    });
    const task = this.asRecord(result?.task);
    return task ? this.normalizeTask(task) : null;
  }

  /**
   * List tasks.
   */
  async listTasks(
    sessionId?: string,
    status?: AgentTask["status"],
    priority?: AgentTask["priority"]
  ): Promise<AgentTask[]> {
    let result = await this.executeTool("agent_task_list", {
      session_id: sessionId,
      status: status ? [status] : undefined,
      agent_id: this.agentId,
      include_completed: true,
      limit: 200,
    });
    if (!result) {
      result = await this.executeTool("agent_task_list", {
        session_id: sessionId,
        status,
        priority,
      });
    }
    if (!result) return [];

    const tasks = this.asRecordArray(result.tasks).map((task) => this.normalizeTask(task));
    if (!priority) {
      return tasks;
    }
    return tasks.filter((task) => task.priority === priority);
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
    const result = await this.executeTool("agent_code_annotate", {
      session_id: sessionId,
      ...annotation,
    });
    const annotationRecord = this.asRecord(result?.annotation);
    if (annotationRecord) {
      return this.normalizeAnnotation(annotationRecord);
    }

    const annotationId = this.asString(result?.annotation_id);
    if (!annotationId) return null;

    const lineEnd = annotation.line_end ?? annotation.line_start;
    return {
      annotation_id: annotationId,
      session_id: sessionId,
      created_at: new Date().toISOString(),
      ...annotation,
      line_end: lineEnd,
    };
  }

  /**
   * Get annotations for a file.
   */
  async getAnnotations(filePath: string, sessionId?: string): Promise<AgentCodeAnnotation[]> {
    const result = await this.executeTool("agent_code_annotations_get", {
      file_path: filePath,
      limit: 200,
    });
    if (!result) return [];

    const annotations = this.asRecordArray(result.annotations).map((annotation) =>
      this.normalizeAnnotation(annotation)
    );
    if (!sessionId) {
      return annotations;
    }
    return annotations.filter((annotation) => annotation.session_id === sessionId);
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
    let result = await this.executeTool("agent_entity_add", {
      entities: entities.map((entity) => ({
        name: entity.name,
        type: entity.entity_type,
        properties: entity.properties,
      })),
      agent_id: this.agentId,
    });
    if (!result) {
      result = await this.executeTool("agent_entity_create", {
        entities: entities.map((entity) => ({
          name: entity.name,
          entity_type: entity.entity_type,
          properties: entity.properties,
        })),
      });
    }
    if (!result) return [];

    const entityIds = this.asStringArray(result.entity_ids);
    if (entityIds.length === 0) {
      const legacyEntities = this.asRecordArray(result.entities).map((entity) =>
        this.normalizeEntity(entity)
      );
      if (legacyEntities.length > 0) {
        return legacyEntities;
      }
    }
    return entities.map((entity, index) => ({
      entity_id: entityIds[index] ?? `entity-${index}`,
      ...entity,
    }));
  }

  /**
   * Create relations in the knowledge graph.
   */
  async createRelations(
    relations: Array<Omit<KnowledgeGraphRelation, "relation_id">>
  ): Promise<KnowledgeGraphRelation[]> {
    let result = await this.executeTool("agent_relation_add", {
      relations: relations.map((relation) => ({
        source_id: relation.source_id,
        target_id: relation.target_id,
        type: relation.relation_type,
        properties: relation.properties,
      })),
      agent_id: this.agentId,
    });
    if (!result) {
      result = await this.executeTool("agent_relation_create", {
        relations: relations.map((relation) => ({
          source_id: relation.source_id,
          target_id: relation.target_id,
          relation_type: relation.relation_type,
          properties: relation.properties,
        })),
      });
    }
    if (!result) return [];

    const relationIds = this.asStringArray(result.relation_ids);
    if (relationIds.length === 0) {
      const legacyRelations = this.asRecordArray(result.relations).map((relation) =>
        this.normalizeRelation(relation)
      );
      if (legacyRelations.length > 0) {
        return legacyRelations;
      }
    }
    return relations.map((relation, index) => ({
      relation_id: relationIds[index] ?? `relation-${index}`,
      ...relation,
    }));
  }

  /**
   * Get the full knowledge graph.
   */
  async getKnowledgeGraph(): Promise<{
    entities: KnowledgeGraphEntity[];
    relations: KnowledgeGraphRelation[];
  }> {
    let result = await this.executeTool("agent_graph_query", {
      limit: 500,
    });
    if (!result) {
      result = await this.executeTool("agent_knowledge_graph_get", {});
    }
    if (!result) return { entities: [], relations: [] };

    const entities = this.asRecordArray(result.entities).map((entity) =>
      this.normalizeEntity(entity)
    );
    const relations = this.asRecordArray(result.relations).map((relation) =>
      this.normalizeRelation(relation)
    );
    return { entities, relations };
  }

  /**
   * Search the knowledge graph.
   */
  async searchKnowledgeGraph(
    query: string,
    entityTypes?: string[]
  ): Promise<KnowledgeGraphEntity[]> {
    let result = await this.executeTool("agent_entity_find", {
      limit: 500,
    });
    if (!result) {
      result = await this.executeTool("agent_entity_search", {
        query,
        entity_types: entityTypes,
      });
    }
    if (!result) return [];

    const normalizedQuery = query.trim().toLowerCase();
    const entities = this.asRecordArray(result.entities).map((entity) =>
      this.normalizeEntity(entity)
    );
    return entities.filter((entity) => {
      if (entityTypes && entityTypes.length > 0 && !entityTypes.includes(entity.entity_type)) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      return (
        entity.name.toLowerCase().includes(normalizedQuery) ||
        entity.entity_type.toLowerCase().includes(normalizedQuery) ||
        JSON.stringify(entity.properties).toLowerCase().includes(normalizedQuery)
      );
    });
  }

  // ============================================================================
  // Memory Management
  // ============================================================================

  /**
   * Get memory tiers.
   */
  async getMemoryTiers(sessionId?: string): Promise<MemoryTier[]> {
    const stats = await this.executeTool("agent_memory_stats", {});
    if (!stats) {
      const legacyTiersResult = await this.executeTool("agent_memory_tiers_get", {
        session_id: sessionId,
      });
      if (!legacyTiersResult) return [];
      return this.asRecordArray(legacyTiersResult.tiers).map((tier) => ({
        tier: this.normalizeMemoryTier(this.asString(tier.tier)),
        entry_count: this.asNumber(tier.entry_count) ?? 0,
        total_tokens: this.asNumber(tier.total_tokens) ?? 0,
        entries: this.asRecordArray(tier.entries).map((entry) => this.normalizeContextEntry(entry)),
      }));
    }

    const recall = await this.executeTool("agent_memory_recall", {
      session_id: sessionId,
      limit: 60,
    });
    const recallItems = this.asRecordArray(recall?.items);

    const entryByTier = new Map<MemoryTier["tier"], AgentContextEntry[]>([
      ["working", []],
      ["short_term", []],
      ["long_term", []],
    ]);

    for (const item of recallItems) {
      const tier = this.asString(item.tier);
      if (tier !== "working" && tier !== "short_term" && tier !== "long_term") {
        continue;
      }
      entryByTier.get(tier)!.push({
        entry_id: this.asString(item.id) ?? `memory-${Date.now()}`,
        session_id: this.asString(item.session_id) ?? "",
        entry_type: this.asString(item.category) ?? "note",
        title: this.asString(item.title) ?? "(untitled memory)",
        content: this.asString(item.content) ?? "",
        created_at: this.asString(item.created_at) ?? new Date().toISOString(),
      });
    }

    const tiers: MemoryTier["tier"][] = ["working", "short_term", "long_term"];
    return tiers.map((tier) => {
      const key = `${tier}_memory`;
      const tierStats = this.asRecord(stats[key]) ?? {};
      return {
        tier,
        entry_count: this.asNumber(tierStats.item_count) ?? 0,
        total_tokens: this.asNumber(tierStats.token_count) ?? 0,
        entries: entryByTier.get(tier) ?? [],
      };
    });
  }

  /**
   * Promote entry to a higher tier.
   */
  async promoteEntry(entryId: string, targetTier: MemoryTier["tier"]): Promise<boolean> {
    let result = await this.executeTool("agent_memory_promote", {
      item_ids: [entryId],
    });
    if (!result) {
      result = await this.executeTool("agent_memory_promote", {
        entry_id: entryId,
        target_tier: targetTier,
      });
    }
    return Boolean(result?.ok ?? result?.success);
  }

  /**
   * Compress memory (summarize and archive).
   */
  async compressMemory(sessionId: string): Promise<boolean> {
    let result = await this.executeTool("agent_memory_compress", {
      tier: "working",
    });
    if (!result) {
      result = await this.executeTool("agent_memory_compress", {
        session_id: sessionId,
      });
    }
    return Boolean(result?.ok ?? result?.success);
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
