import * as vscode from "vscode";

import { DaemonClient } from "../clients/daemon";
import {
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
}

/**
 * Helper type for exec errors that include stdout/stderr.
 */
export interface ExecError extends Error {
  stdout?: string;
  stderr?: string;
}
