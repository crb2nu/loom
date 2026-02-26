export interface TargetSpec {
  description?: string;
  command?: string;
  args?: Array<string | number | boolean>;
  env?: Record<string, string>;
  hint?: string;
  timeout?: number;
  always_allow?: string[];
  type?: string;
}

export interface RegistryServer {
  name: string;
  categories?: string[];
  common?: TargetSpec;
  targets?: Record<string, TargetSpec>;
}

export interface RegistryDocument {
  version?: number;
  servers?: Array<RegistryServer>;
}

export interface HubSettings {
  hubUrl: string;
  httpBaseUrl?: string;
  profile: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

export interface HubHealthResponse {
  status?: string;
  timestamp?: string;
  sessions?: number;
}

export interface HubReadyResponse {
  ready?: boolean;
  servers?: number;
  error?: string;
}

export interface HubServerInfo {
  name: string;
  description?: string;
  categories?: string[];
}

export interface DaemonServerInfo {
  name: string;
  categories?: string[];
  description?: string;
  running: boolean;
}

export interface ToolInputSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface Tool {
  name: string;
  description?: string;
  inputSchema?: ToolInputSchema;
}

export interface DaemonToolInfo {
  name: string;
  description?: string;
  server: string;
}

export interface HubStatusSnapshot {
  health?: HubHealthResponse;
  readiness?: HubReadyResponse;
  servers: HubServerInfo[];
  lastUpdated?: Date;
  error?: string;
}

export interface VscodeConfigSnapshot {
  source: string;
  serverNames: string[];
  hubRouted: string[];
  localRouted: string[];
}

export interface ConfigSyncState {
  status: "synced" | "out-of-sync" | "unknown" | "no-generated";
  generatedPath?: string;
  appliedPath?: string;
  generatedHash?: string;
  appliedHash?: string;
  lastChecked: Date;
  diffs?: string[];
}

export interface ActionableError {
  message: string;
  actions: { label: string; command?: string; url?: string }[];
}

export interface DaemonConfig {
  repo_root?: string;
  hub: {
    url: string;
    enabled: boolean;
    profile: string;
    cf_access_client_id?: string;
    cf_access_client_secret?: string;
  };
  debug: boolean;
}

export interface SnapshotEnvResult {
  env: Record<string, string>;
  resolved: string[];
  missing: string[];
}

// ============================================================================
// Skills Registry Types
// ============================================================================

export interface SkillScript {
  name: string;
  path: string;
  description?: string;
}

export type SkillOutputType = "command" | "skill" | "rule" | "instruction" | "workflow";

export interface SkillTargetConfig {
  enabled: boolean;
  output_format?: string;
  type?: SkillOutputType;
}

export interface SkillDefinition {
  name: string;
  categories: string[];
  common: {
    description: string;
    instructions: string;
    scripts: SkillScript[];
    references: string[];
    assets: string[];
    always_allow: string[];
  };
  targets?: Record<string, SkillTargetConfig>;
}

export interface SkillsRegistry {
  version: number;
  updated: string;
  skills: SkillDefinition[];
}

// ============================================================================
// Agent Context Types
// ============================================================================

export interface AgentSession {
  session_id: string;
  namespace: string;
  description?: string;
  agent_id: string;
  started_at: string;
  ended_at?: string;
  status: "active" | "ended" | "summarized";
  entry_count: number;
}

export interface AgentContextEntry {
  entry_id: string;
  session_id: string;
  entry_type: string;
  title: string;
  content: string;
  tags?: string[];
  file_path?: string;
  line_start?: number;
  line_end?: number;
  created_at: string;
}

export interface AgentTask {
  task_id: string;
  session_id: string;
  title: string;
  description?: string;
  priority: "low" | "medium" | "high" | "critical";
  status: "pending" | "in_progress" | "completed" | "blocked";
  file_path?: string;
  context?: string;
  resolution?: string;
  created_at: string;
  updated_at: string;
}

export interface AgentCodeAnnotation {
  annotation_id: string;
  session_id: string;
  file_path: string;
  line_start: number;
  line_end: number;
  annotation_type: "note" | "todo" | "warning" | "question" | "decision";
  content: string;
  created_at: string;
}

export interface KnowledgeGraphEntity {
  entity_id: string;
  name: string;
  entity_type: string;
  properties: Record<string, unknown>;
}

export interface KnowledgeGraphRelation {
  relation_id: string;
  source_id: string;
  target_id: string;
  relation_type: string;
  properties?: Record<string, unknown>;
}

export interface MemoryTier {
  tier: "working" | "short_term" | "long_term";
  entry_count: number;
  total_tokens: number;
  entries: AgentContextEntry[];
}

// ============================================================================
// Server Health Types
// ============================================================================

export interface ServerHealthMetrics {
  serverName: string;
  status: "online" | "offline" | "degraded";
  latencyMs: number;
  errorCount: number;
  lastCheck: Date;
  toolCount: number;
  isHubRouted: boolean;
}

export interface ServerHealthHistory {
  serverName: string;
  samples: Array<{
    timestamp: Date;
    latencyMs: number;
    status: "online" | "offline" | "degraded";
  }>;
}

export interface ServerProfile {
  name: string;
  servers: string[] | "*";
  hubEnabled: boolean;
}

// ============================================================================
// Remote Tunnel Types
// ============================================================================

export interface RemoteTunnelProfile {
  name: string;
  context?: string;
  namespace: string;
  service: string;
  localPort: number;
  remotePort: number;
  hubPath?: string;
  autoSetHubUrl?: boolean;
}

export interface RoutingStatus {
  hubRouted: string[];
  localRouted: string[];
  hubHealthy: boolean;
  activeProfile: string;
}

// ============================================================================
// Platform Configuration Types
// ============================================================================

/**
 * Supported platform types for MCP configuration.
 */
export type PlatformType = "vscode" | "antigravity" | "gemini" | "codex" | "kilocode" | "claude";

/**
 * Sync status for a platform configuration.
 */
export type PlatformSyncStatus = "synced" | "out-of-sync" | "missing" | "error" | "unknown";

/**
 * Platform configuration state.
 */
export interface PlatformConfig {
  platform: PlatformType;
  format: "json" | "toml";
  repoPath: string; // Full path to repo config
  homePath: string; // Full path to home config
  syncStatus: PlatformSyncStatus;
  serverCount: number;
  repoHash?: string;
  homeHash?: string;
  lastChecked: Date;
  error?: string;
}

/**
 * Result of a platform sync operation.
 */
export interface PlatformSyncResult {
  platform: PlatformType;
  success: boolean;
  message: string;
  repoPath?: string;
  homePath?: string;
  serversUpdated?: number;
}

/**
 * Overall sync dashboard state.
 */
export interface SyncDashboardState {
  platforms: PlatformConfig[];
  registryPath?: string;
  registryServerCount: number;
  lastUpdated: Date;
}

/**
 * Extended server profile with platform support.
 */
export interface ExtendedServerProfile extends ServerProfile {
  platforms?: PlatformType[];
}
