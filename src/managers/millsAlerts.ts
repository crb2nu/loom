import * as vscode from "vscode";

import {
  MILLS_METRIC_KEYS,
  MillsClient,
  MillsSettings,
  MillsStatusSnapshot,
  readMetric,
} from "../clients/mills";
import { Logger } from "../utils/logger";

import { MillsStatusManager } from "./millsStatus";

export interface MillsAlert {
  kind: "paused" | "regression" | "audit";
  message: string;
  /** Optional VS Code command + args to invoke when the user clicks the toast button. */
  action?: {
    title: string;
    command: string;
    args?: unknown[];
  };
}

interface AlertState {
  /** Last `policy_enabled` we saw — used to detect transitions. */
  policyEnabled?: boolean;
  /** Last regression count we toasted on. We only re-toast when it grows. */
  lastRegressionCount?: number;
  /** Last audit findings count we toasted on. */
  lastAuditCount?: number;
  /** True after the very first poll, so we don't fire on initial state. */
  primed: boolean;
}

/**
 * Polls Mills for delta-based alerts and surfaces them as toasts.
 * Reuses the read-only HUD client; never holds the admin token.
 *
 * Three signals:
 *   1. policy_enabled flipped to false → "Mills paused" warning
 *   2. regression metric grew → "Mills regression" warning, deep-link to KPIs
 *   3. audit findings list grew → "New audit finding(s)" warning, deep-link to tree
 *
 * The status manager already polls /status + /kpis on its own cadence and
 * emits onDidChange on health flips; we reuse those snapshots and only
 * fetch /audit/findings on our own interval.
 */
export class MillsAlertingManager implements vscode.Disposable {
  private settings: MillsSettings;
  private readonly channel: vscode.OutputChannel;
  private readonly logger: Logger;
  private readonly emitter = new vscode.EventEmitter<MillsAlert>();
  readonly onDidAlert = this.emitter.event;

  private timer: NodeJS.Timeout | undefined;
  private auditCheckMs: number;
  private state: AlertState = { primed: false };
  private readonly statusListener: vscode.Disposable;

  constructor(
    settings: MillsSettings,
    auditCheckMs: number,
    statusManager: MillsStatusManager,
    channel: vscode.OutputChannel
  ) {
    this.settings = settings;
    this.auditCheckMs = Math.max(auditCheckMs, 30_000);
    this.channel = channel;
    this.logger = new Logger(channel, "MillsAlerts");
    this.statusListener = statusManager.onDidChange((snapshot) => this.onStatusSnapshot(snapshot));
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.statusListener.dispose();
    this.emitter.dispose();
  }

  start(): void {
    this.restartTimer();
    void this.checkAuditFindings();
  }

  updateSettings(next: MillsSettings, auditCheckMs?: number): void {
    this.settings = next;
    if (auditCheckMs !== undefined) {
      this.auditCheckMs = Math.max(auditCheckMs, 30_000);
    }
    this.state = { primed: false };
    this.restartTimer();
  }

  private restartTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!this.settings.hudBaseUrl) return;
    this.timer = setInterval(() => {
      void this.checkAuditFindings();
    }, this.auditCheckMs);
  }

  private async checkAuditFindings(): Promise<void> {
    if (!this.settings.hudBaseUrl) return;
    const client = new MillsClient(this.settings, this.channel);
    try {
      const findings = await client.fetchAuditFindings();
      const count = findings.length;
      this.evaluateAuditCount(count);
    } catch (error) {
      this.logger.warn(
        `audit findings fetch failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private evaluateAuditCount(count: number): void {
    const previous = this.state.lastAuditCount;
    this.state.lastAuditCount = count;
    if (!this.state.primed) return;
    if (previous === undefined) return;
    if (count > previous) {
      this.fire({
        kind: "audit",
        message: `Mills: ${count - previous} new audit finding${count - previous === 1 ? "" : "s"} (total ${count})`,
        action: {
          title: "Open Mills view",
          command: "loom.refreshMills",
        },
      });
    }
  }

  private onStatusSnapshot(snapshot: MillsStatusSnapshot): void {
    if (
      snapshot.health === "unconfigured" ||
      snapshot.health === "unreachable" ||
      !snapshot.status
    ) {
      // Don't reset state — a transient outage shouldn't re-fire on recovery.
      return;
    }

    const enabled = snapshot.status.policy_enabled;
    const regressions = readMetric(snapshot.kpis, MILLS_METRIC_KEYS.regressionCount);

    if (this.state.primed) {
      if (this.state.policyEnabled !== false && enabled === false) {
        this.fire({
          kind: "paused",
          message: "Mills autonomy was paused (policy_enabled=false).",
          action: { title: "Show Status", command: "loom.showMillsStatus" },
        });
      }
      if (
        regressions !== undefined &&
        this.state.lastRegressionCount !== undefined &&
        regressions > this.state.lastRegressionCount
      ) {
        const delta = regressions - this.state.lastRegressionCount;
        this.fire({
          kind: "regression",
          message: `Mills: ${delta} new regression${delta === 1 ? "" : "s"} (total ${regressions})`,
          action: { title: "Show Status", command: "loom.showMillsStatus" },
        });
      }
    }

    this.state.policyEnabled = enabled;
    if (regressions !== undefined) {
      this.state.lastRegressionCount = regressions;
    }
    this.state.primed = true;
  }

  private fire(alert: MillsAlert): void {
    this.emitter.fire(alert);
    void this.showToast(alert);
  }

  private async showToast(alert: MillsAlert): Promise<void> {
    if (alert.action) {
      const choice = await vscode.window.showWarningMessage(alert.message, alert.action.title);
      if (choice === alert.action.title) {
        await vscode.commands.executeCommand(alert.action.command, ...(alert.action.args ?? []));
      }
    } else {
      void vscode.window.showWarningMessage(alert.message);
    }
  }
}
