import { AgentContextClient } from "../clients/agentContext";
import { DaemonClient } from "../clients/daemon";
import { AgentSessionManager, HubStatusManager, UsageAnalyticsManager } from "../managers";
import { RegistryProvider } from "../providers";
import { AgentTask, MemoryTier } from "../types";
import { loadVscodeConfigSnapshot } from "../utils/config";

export type DomainState = "ready" | "degraded" | "unavailable";

interface DomainStatus {
  state: DomainState;
  reason?: string;
}

export interface FleetDomainSnapshot extends DomainStatus {
  hasRegistry: boolean;
  hasConfig: boolean;
  registryCount: number;
  hubCount: number;
  configCount: number;
  missingFromHub: string[];
  missingFromConfig: string[];
  hubOnly: string[];
  configOnly: string[];
  localRouted: string[];
  configSource?: string;
}

export interface HealthDomainSnapshot extends DomainStatus {
  hubStatus: string;
  hubReady: boolean;
  hubSessions: number;
  daemonConnection: string;
  daemonServerCount: number;
  daemonRunningCount: number;
}

export interface TasksDomainSnapshot extends DomainStatus {
  sessionId?: string;
  total: number;
  blocked: number;
  byStatus: Partial<Record<AgentTask["status"], number>>;
}

export interface MemoryDomainSnapshot extends DomainStatus {
  sessionId?: string;
  totalEntries: number;
  totalTokens: number;
  tiers: Array<{
    tier: MemoryTier["tier"];
    entryCount: number;
    tokenCount: number;
  }>;
}

export interface StreamDomainSnapshot extends DomainStatus {
  totalCalls: number;
  successCalls: number;
  failureCalls: number;
  topServer?: string;
}

export interface PresenceDomainSnapshot extends DomainStatus {
  activeSessions: number;
  activeSessionId?: string;
}

export interface ParityDomainSnapshot {
  fleet: FleetDomainSnapshot;
  health: HealthDomainSnapshot;
  tasks: TasksDomainSnapshot;
  memory: MemoryDomainSnapshot;
  stream: StreamDomainSnapshot;
  presence: PresenceDomainSnapshot;
}

export interface ParityReadModelDeps {
  workspaceRoot?: string;
  registryProvider: RegistryProvider;
  hubStatusManager: HubStatusManager;
  daemonClient?: DaemonClient;
  agentContextClient?: AgentContextClient;
  agentSessionManager?: AgentSessionManager;
  usageAnalyticsManager?: UsageAnalyticsManager;
}

/**
 * Shared read-model adapter for HUD/TUI/mobile parity domains.
 */
export class ParityReadModel {
  constructor(private readonly deps: ParityReadModelDeps) {}

  async collect(): Promise<ParityDomainSnapshot> {
    const [fleet, health, tasks, memory, stream, presence] = await Promise.all([
      this.collectFleet(),
      this.collectHealth(),
      this.collectTasks(),
      this.collectMemory(),
      Promise.resolve(this.collectStream()),
      this.collectPresence(),
    ]);

    return {
      fleet,
      health,
      tasks,
      memory,
      stream,
      presence,
    };
  }

  private async collectFleet(): Promise<FleetDomainSnapshot> {
    const registry = await this.deps.registryProvider.getRegistrySnapshot();
    const hubSnapshot = this.deps.hubStatusManager.getStatus();
    const configSnapshot = this.deps.workspaceRoot
      ? await loadVscodeConfigSnapshot(this.deps.workspaceRoot)
      : null;

    const registryNames = new Set<string>(registry?.servers?.map((server) => server.name) ?? []);
    const hubNames = new Set<string>(hubSnapshot.servers?.map((server) => server.name) ?? []);
    const configNames = new Set<string>(configSnapshot?.serverNames ?? []);

    const missingFromHub = Array.from(registryNames).filter((name) => !hubNames.has(name));
    const missingFromConfig = Array.from(registryNames).filter((name) => !configNames.has(name));
    const hubOnly = Array.from(hubNames).filter((name) => !registryNames.has(name));
    const configOnly = Array.from(configNames).filter((name) => !registryNames.has(name));
    const localRouted = configSnapshot?.localRouted ?? [];

    const fleetIssues: string[] = [];
    if (!registry) fleetIssues.push("registry missing");
    if (!configSnapshot) fleetIssues.push("VS Code config missing");
    if (hubSnapshot.error) fleetIssues.push(`hub error: ${hubSnapshot.error}`);

    const hasSignals = registryNames.size > 0 || hubNames.size > 0 || configNames.size > 0;
    const state: DomainState =
      fleetIssues.length === 0 ? "ready" : hasSignals ? "degraded" : "unavailable";

    return {
      state,
      reason: fleetIssues.length > 0 ? fleetIssues.join("; ") : undefined,
      hasRegistry: Boolean(registry),
      hasConfig: Boolean(configSnapshot),
      registryCount: registryNames.size,
      hubCount: hubNames.size,
      configCount: configNames.size,
      missingFromHub,
      missingFromConfig,
      hubOnly,
      configOnly,
      localRouted,
      configSource: configSnapshot?.source,
    };
  }

  private async collectHealth(): Promise<HealthDomainSnapshot> {
    const hubSnapshot = this.deps.hubStatusManager.getStatus();
    const hubStatus = hubSnapshot.health?.status ?? "unknown";
    const hubReady = Boolean(hubSnapshot.readiness?.ready);
    const hubSessions = hubSnapshot.health?.sessions ?? 0;

    let daemonServerCount = 0;
    let daemonRunningCount = 0;
    let daemonError: string | undefined;
    const daemonConnection = this.deps.daemonClient?.connectionState ?? "unavailable";

    if (this.deps.daemonClient) {
      try {
        const servers = await this.deps.daemonClient.getServers(true);
        daemonServerCount = servers.length;
        daemonRunningCount = servers.filter((server) => server.running).length;
      } catch (error) {
        daemonError = error instanceof Error ? error.message : String(error);
      }
    }

    const issues: string[] = [];
    if (hubSnapshot.error) issues.push(`hub error: ${hubSnapshot.error}`);
    if (!hubReady) issues.push("hub not ready");
    if (daemonError) issues.push(`daemon error: ${daemonError}`);
    if (daemonServerCount > 0 && daemonRunningCount === 0)
      issues.push("all daemon servers offline");

    const hasSignals =
      daemonServerCount > 0 || hubStatus !== "unknown" || hubSnapshot.servers.length > 0;
    const state: DomainState =
      issues.length === 0 ? "ready" : hasSignals ? "degraded" : "unavailable";

    return {
      state,
      reason: issues.length > 0 ? issues.join("; ") : undefined,
      hubStatus,
      hubReady,
      hubSessions,
      daemonConnection,
      daemonServerCount,
      daemonRunningCount,
    };
  }

  private async collectTasks(): Promise<TasksDomainSnapshot> {
    if (!this.deps.agentContextClient) {
      return {
        state: "unavailable",
        reason: "agent context client unavailable",
        total: 0,
        blocked: 0,
        byStatus: {},
      };
    }

    const sessionId = this.deps.agentSessionManager?.getSessionId();
    try {
      const tasks = await this.deps.agentContextClient.listTasks(sessionId);
      const byStatus = tasks.reduce<TasksDomainSnapshot["byStatus"]>((acc, task) => {
        acc[task.status] = (acc[task.status] ?? 0) + 1;
        return acc;
      }, {});
      const blocked = tasks.filter((task) => task.status === "blocked").length;
      return {
        state: "ready",
        sessionId,
        total: tasks.length,
        blocked,
        byStatus,
      };
    } catch (error) {
      return {
        state: "degraded",
        reason: error instanceof Error ? error.message : String(error),
        sessionId,
        total: 0,
        blocked: 0,
        byStatus: {},
      };
    }
  }

  private async collectMemory(): Promise<MemoryDomainSnapshot> {
    if (!this.deps.agentContextClient) {
      return {
        state: "unavailable",
        reason: "agent context client unavailable",
        totalEntries: 0,
        totalTokens: 0,
        tiers: [],
      };
    }

    const sessionId = this.deps.agentSessionManager?.getSessionId();
    try {
      const tiers = await this.deps.agentContextClient.getMemoryTiers(sessionId);
      const tierSummaries = tiers.map((tier) => ({
        tier: tier.tier,
        entryCount: tier.entry_count,
        tokenCount: tier.total_tokens,
      }));
      const totalEntries = tierSummaries.reduce((sum, tier) => sum + tier.entryCount, 0);
      const totalTokens = tierSummaries.reduce((sum, tier) => sum + tier.tokenCount, 0);
      return {
        state: "ready",
        sessionId,
        totalEntries,
        totalTokens,
        tiers: tierSummaries,
      };
    } catch (error) {
      return {
        state: "degraded",
        reason: error instanceof Error ? error.message : String(error),
        sessionId,
        totalEntries: 0,
        totalTokens: 0,
        tiers: [],
      };
    }
  }

  private async collectPresence(): Promise<PresenceDomainSnapshot> {
    if (!this.deps.agentContextClient) {
      return {
        state: "unavailable",
        reason: "agent context client unavailable",
        activeSessions: 0,
      };
    }

    try {
      const sessions = await this.deps.agentContextClient.listSessions("active");
      return {
        state: "ready",
        activeSessions: sessions.length,
        activeSessionId: this.deps.agentSessionManager?.getSessionId(),
      };
    } catch (error) {
      return {
        state: "degraded",
        reason: error instanceof Error ? error.message : String(error),
        activeSessions: 0,
        activeSessionId: this.deps.agentSessionManager?.getSessionId(),
      };
    }
  }

  private collectStream(): StreamDomainSnapshot {
    if (!this.deps.usageAnalyticsManager) {
      return {
        state: "unavailable",
        reason: "usage analytics unavailable",
        totalCalls: 0,
        successCalls: 0,
        failureCalls: 0,
      };
    }

    const snapshot = this.deps.usageAnalyticsManager.getSnapshot();
    const topServer = Object.entries(snapshot.byServer).sort((a, b) => b[1] - a[1])[0]?.[0];
    const failureRate = snapshot.totalCalls > 0 ? snapshot.failureCalls / snapshot.totalCalls : 0;
    return {
      state: failureRate >= 0.5 ? "degraded" : "ready",
      reason: failureRate >= 0.5 ? "high failure rate in recent tool stream" : undefined,
      totalCalls: snapshot.totalCalls,
      successCalls: snapshot.successCalls,
      failureCalls: snapshot.failureCalls,
      topServer,
    };
  }
}
