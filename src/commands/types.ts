import * as vscode from "vscode";

import { AgentContextClient, DaemonClient } from "../clients";
import {
  AgentSessionManager,
  ConfigSyncManager,
  HubStatusManager,
  RemoteTunnelManager,
  UsageAnalyticsManager,
} from "../managers";
import { RegistryProvider, SecretsProvider, ServerProvider, ToolProvider } from "../providers";

/**
 * Shared context passed to all command handlers.
 * Contains dependencies needed by commands to interact with the extension.
 */
export interface CommandContext {
  workspaceRoot: string;
  pythonExecutable: string;
  loomChannel: vscode.OutputChannel;
  hubStatusManager: HubStatusManager;
  configSyncManager: ConfigSyncManager;
  daemonClient: DaemonClient;
  registryProvider: RegistryProvider;
  serverProvider: ServerProvider;
  toolProvider: ToolProvider;
  secretsProvider: SecretsProvider;
  usageAnalyticsManager: UsageAnalyticsManager;
  remoteTunnelManager: RemoteTunnelManager;
  extensionContext: vscode.ExtensionContext;
  agentContextClient?: AgentContextClient;
  agentSessionManager?: AgentSessionManager;
}

/**
 * Helper type for exec errors that include stdout/stderr.
 */
export interface ExecError extends Error {
  stdout?: string;
  stderr?: string;
}
