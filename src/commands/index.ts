import * as vscode from "vscode";

import { registerContextCommands } from "./context";
import { registerDaemonCommands } from "./daemon";
import { registerHubCommands } from "./hub";
import { registerSecretsCommands } from "./secrets";
import { registerStatusCommands } from "./status";
import { registerSyncCommands } from "./sync";
import { registerToolsCommands } from "./tools";
import { CommandContext } from "./types";

export { CommandContext, ExecError } from "./types";
export { registerSkillsCommands, SkillsCommandContext } from "./skills";
export { registerAgentContextCommands, AgentContextCommandContext } from "./agentContext";
export { registerServerHealthCommands, ServerHealthCommandContext } from "./serverHealth";

/**
 * Register all Loom commands.
 * Returns an array of disposables for cleanup.
 */
export function registerAllCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    ...registerDaemonCommands(ctx),
    ...registerToolsCommands(ctx),
    ...registerSecretsCommands(ctx),
    ...registerHubCommands(ctx),
    ...registerSyncCommands(ctx),
    ...registerContextCommands(ctx),
    ...registerStatusCommands(ctx),
  ];
}
