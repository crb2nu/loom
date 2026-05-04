import * as vscode from "vscode";

import { MillsClient, MillsSettings, MillsStatusSnapshot } from "../clients/mills";
import { Logger } from "../utils/logger";

/**
 * Polls Mills HUD and reflects health in a status bar item.
 *
 * Status bar item is hidden when Mills HUD is not configured
 * (`loom.mills.hudBaseUrl` empty), keeping the UI clean for users
 * without a Mills operator.
 */
export class MillsStatusManager implements vscode.Disposable {
  private settings: MillsSettings;
  private readonly channel: vscode.OutputChannel;
  private readonly logger: Logger;
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly emitter = new vscode.EventEmitter<MillsStatusSnapshot>();
  private snapshot: MillsStatusSnapshot = { health: "unconfigured" };
  private timer: NodeJS.Timeout | undefined;
  private refreshIntervalMs: number;

  readonly onDidChange = this.emitter.event;

  constructor(settings: MillsSettings, refreshIntervalMs: number, channel: vscode.OutputChannel) {
    this.settings = settings;
    this.refreshIntervalMs = Math.max(refreshIntervalMs, 5_000);
    this.channel = channel;
    this.logger = new Logger(channel, "MillsStatus");

    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 88);
    this.statusBarItem.command = "loom.showMillsStatus";
    this.renderStatusBar();
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.statusBarItem.dispose();
    this.emitter.dispose();
  }

  getSnapshot(): MillsStatusSnapshot {
    return this.snapshot;
  }

  getSettings(): MillsSettings {
    return this.settings;
  }

  updateSettings(next: MillsSettings, refreshIntervalMs?: number): void {
    this.settings = next;
    if (refreshIntervalMs !== undefined) {
      this.refreshIntervalMs = Math.max(refreshIntervalMs, 5_000);
    }
    this.restartTimer();
    void this.refresh();
  }

  start(): void {
    this.restartTimer();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const client = new MillsClient(this.settings, this.channel);
    const next = await client.fetchSnapshot();
    this.applySnapshot(next);
  }

  private restartTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!this.settings.hudBaseUrl) {
      return;
    }
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.refreshIntervalMs);
  }

  private applySnapshot(next: MillsStatusSnapshot): void {
    const changed = next.health !== this.snapshot.health || next.error !== this.snapshot.error;
    this.snapshot = next;
    this.renderStatusBar();
    if (changed) {
      this.emitter.fire(next);
    }
  }

  private renderStatusBar(): void {
    const item = this.statusBarItem;
    if (this.snapshot.health === "unconfigured") {
      item.hide();
      return;
    }
    const { icon, label, tooltip, background } = describeHealth(this.snapshot);
    item.text = `$(${icon}) ${label}`;
    item.tooltip = tooltip;
    item.backgroundColor = background;
    item.show();
    if (this.snapshot.error) {
      this.logger.warn(`Mills snapshot error: ${this.snapshot.error}`);
    }
  }
}

interface HealthDescription {
  icon: string;
  label: string;
  tooltip: string;
  background?: vscode.ThemeColor;
}

function describeHealth(snapshot: MillsStatusSnapshot): HealthDescription {
  const regressions = snapshot.kpis?.regression_count;
  const stage = snapshot.status?.stage;
  switch (snapshot.health) {
    case "ok":
      return {
        icon: "check",
        label: "Mills",
        tooltip: stage ? `Mills running (stage: ${stage})` : "Mills running",
      };
    case "paused":
      return {
        icon: "debug-pause",
        label: "Mills paused",
        tooltip: "Mills autonomy is paused (kill switch engaged)",
        background: new vscode.ThemeColor("statusBarItem.warningBackground"),
      };
    case "degraded":
      return {
        icon: "warning",
        label: regressions ? `Mills ${regressions} regr.` : "Mills degraded",
        tooltip: regressions
          ? `Mills reporting ${regressions} regressions`
          : "Mills reporting regressions",
        background: new vscode.ThemeColor("statusBarItem.warningBackground"),
      };
    case "unreachable":
      return {
        icon: "error",
        label: "Mills offline",
        tooltip: snapshot.error
          ? `Mills HUD unreachable: ${snapshot.error}`
          : "Mills HUD unreachable",
        background: new vscode.ThemeColor("statusBarItem.errorBackground"),
      };
    case "unconfigured":
    default:
      return {
        icon: "circle-slash",
        label: "Mills",
        tooltip: "Mills HUD URL is not configured",
      };
  }
}
