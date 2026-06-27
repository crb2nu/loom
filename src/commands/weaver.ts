import * as vscode from "vscode";

import { WeaverClient, WeaverQueryResponse, WeaverSettings } from "../clients/weaver";
import { WeaverTreeProvider } from "../providers/weaver";
import { deriveMillsConfig } from "../utils/config";

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

/**
 * Resolve the HUD settings the weaver run-query command POSTs against.
 * Reuses the same `loom.mills.hudBaseUrl` + CF Access pattern as the
 * weaver tree (registerWeaverIntegration in extension.ts) so the
 * extension only stores one HUD URL + credentials. Exported for tests.
 */
export function resolveWeaverSettings(): WeaverSettings {
  const cfg = deriveMillsConfig();
  return {
    hudBaseUrl: cfg.hudBaseUrl,
    cfAccessClientId: cfg.cfAccessClientId,
    cfAccessClientSecret: cfg.cfAccessClientSecret,
  };
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

  const settings = resolveWeaverSettings();
  if (!settings.hudBaseUrl) {
    const open = "Open Settings";
    const choice = await vscode.window.showWarningMessage(
      "Loom: weaver query needs a HUD URL. Set `loom.mills.hudBaseUrl` first.",
      open
    );
    if (choice === open) {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "loom.mills.hudBaseUrl"
      );
    }
    return;
  }

  ctx.loomChannel.show(true);
  ctx.loomChannel.appendLine(`[weaver] running query: ${query}`);

  const client = new WeaverClient(settings);
  let result: WeaverQueryResponse | null;
  try {
    result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Weaver: synthesizing answer…",
        cancellable: false,
      },
      () => client.query({ query })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.loomChannel.appendLine(`[weaver] query failed: ${message}`);
    vscode.window.showErrorMessage(`Loom: weaver query failed (${message})`);
    return;
  }

  if (!result) {
    // hudBaseUrl was empty — guarded above, but keep this defensive.
    ctx.loomChannel.appendLine("[weaver] query skipped: HUD URL is not configured.");
    return;
  }

  renderResult(ctx.loomChannel, result);
  await ctx.weaverTreeProvider.refresh();
}

/** Format a weaver query result into the Loom output channel. */
function renderResult(channel: vscode.OutputChannel, result: WeaverQueryResponse): void {
  const answer = (result.answer ?? "").trim();
  channel.appendLine("[weaver] answer:");
  channel.appendLine(answer.length > 0 ? answer : "(empty answer)");

  const meta: string[] = [];
  if (typeof result.total_tokens === "number") {
    meta.push(`tokens=${result.total_tokens}`);
  }
  if (typeof result.latency_ms === "number") {
    meta.push(`latency=${result.latency_ms}ms`);
  }
  const domains = result.domains_used ?? [];
  if (domains.length > 0) {
    meta.push(`domains=${domains.join(", ")}`);
  }
  if (result.status) {
    meta.push(`status=${result.status}`);
  }
  if (meta.length > 0) {
    channel.appendLine(`[weaver] ${meta.join(" · ")}`);
  }
}
