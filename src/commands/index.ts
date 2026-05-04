import * as vscode from "vscode";

import { registerContextCommands } from "./context";
import { registerDaemonCommands } from "./daemon";
import { registerHubCommands } from "./hub";
import { registerMillsCommands } from "./mills";
import { registerRemoteTunnelCommands } from "./remoteTunnels";
import { registerSecretsCommands } from "./secrets";
import { registerStatusCommands } from "./status";
import { registerSyncCommands } from "./sync";
import { registerToolsCommands } from "./tools";
import { CommandContext } from "./types";

export { CommandContext, ExecError } from "./types";
export { registerSkillsCommands, SkillsCommandContext } from "./skills";
export { registerAgentContextCommands, AgentContextCommandContext } from "./agentContext";
export { registerServerHealthCommands, ServerHealthCommandContext } from "./serverHealth";
export { registerMillsCommands, MillsCommandContext } from "./mills";

/**
 * Register all Loom commands.
 * Returns an array of disposables for cleanup.
 */
export function registerAllCommands(ctx: CommandContext): vscode.Disposable[] {
  const baseCommands = [
    ...registerDaemonCommands(ctx),
    ...registerToolsCommands(ctx),
    ...registerSecretsCommands(ctx),
    ...registerHubCommands(ctx),
    ...registerRemoteTunnelCommands(ctx),
    ...registerSyncCommands(ctx),
    ...registerContextCommands(ctx),
    ...registerStatusCommands(ctx),
  ];
  if (ctx.millsStatusManager) {
    baseCommands.push(
      ...registerMillsCommands({
        extensionUri: ctx.extensionContext.extensionUri,
        loomChannel: ctx.loomChannel,
        millsStatusManager: ctx.millsStatusManager,
        millsTreeProvider: ctx.millsTreeProvider,
      })
    );
  }
  return baseCommands;
}
