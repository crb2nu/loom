import * as vscode from "vscode";

import { WeaverTreeProvider } from "../providers/weaver";

/**
 * Register the weaver-related VS Code commands. Read-only side ships
 * always; the experimental run-query command is gated by the
 * `loom.experimental.weaver` setting.
 *
 * See services/loom-core/.loom/111-product-spec-weaver-qwen3-integration-2026-05-08.md
 * (VSC-002).
 */
export interface WeaverCommandContext {
  loomChannel: vscode.OutputChannel;
  weaverTreeProvider: WeaverTreeProvider;
}

export function registerWeaverCommands(ctx: WeaverCommandContext): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [
    vscode.commands.registerCommand("loom.refreshWeaver", async () => {
      await ctx.weaverTreeProvider.refresh();
    }),
    vscode.commands.registerCommand("loom.weaver.runQuery", () => runQuery(ctx)),
  ];
  return disposables;
}

async function runQuery(ctx: WeaverCommandContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("loom");
  const experimental = cfg.get<boolean>("experimental.weaver", false);
  if (!experimental) {
    const open = "Open Settings";
    const choice = await vscode.window.showWarningMessage(
      "loom.weaver.runQuery is experimental. Enable `loom.experimental.weaver` in settings first.",
      open
    );
    if (choice === open) {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "loom.experimental.weaver"
      );
    }
    return;
  }

  const query = await vscode.window.showInputBox({
    prompt: "Weaver query",
    placeHolder: "What do you want to ask?",
    ignoreFocusOut: true,
  });
  if (!query) {
    return;
  }

  ctx.loomChannel.show(true);
  ctx.loomChannel.appendLine(`[weaver] running query: ${query}`);
  ctx.loomChannel.appendLine(
    "[weaver] direct query execution requires the daemon socket; the read-only HUD endpoints used by the tree do not support submission."
  );
  ctx.loomChannel.appendLine(
    '[weaver] for now, run queries via your terminal: `loom mcp call weaver weaver__query \'{"query":"..."}\'` or via Claude / Codex / Gemini in this workspace.'
  );
}
