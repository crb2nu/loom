import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";

const mockRequestJson = vi.hoisted(() => vi.fn());

vi.mock("../utils/http", () => ({
  requestJson: mockRequestJson,
  postJson: vi.fn(),
}));

import { MillsStatusSnapshot } from "../clients/mills";

import { MillsAlertingManager } from "./millsAlerts";
import { MillsStatusManager } from "./millsStatus";

function makeChannel(): vscode.OutputChannel {
  return {
    name: "test",
    append: vi.fn(),
    appendLine: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    replace: vi.fn(),
  };
}

class FakeStatusManager {
  private listeners: Array<(s: MillsStatusSnapshot) => void> = [];
  onDidChange = (cb: (s: MillsStatusSnapshot) => void): vscode.Disposable => {
    this.listeners.push(cb);
    return { dispose: () => undefined };
  };
  emit(s: MillsStatusSnapshot): void {
    for (const cb of this.listeners) cb(s);
  }
}

describe("MillsAlertingManager", () => {
  let channel: vscode.OutputChannel;
  let status: FakeStatusManager;
  let mgr: MillsAlertingManager;
  let warningSpy: ReturnType<typeof vi.fn>;
  let originalShowWarning: typeof vscode.window.showWarningMessage;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestJson.mockReset();
    channel = makeChannel();
    status = new FakeStatusManager();
    originalShowWarning = vscode.window.showWarningMessage;
    warningSpy = vi.fn(() => Promise.resolve(undefined));
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = warningSpy;
  });

  afterEach(() => {
    mgr?.dispose();
    (
      vscode.window as unknown as { showWarningMessage: typeof originalShowWarning }
    ).showWarningMessage = originalShowWarning;
  });

  function build(): MillsAlertingManager {
    mgr = new MillsAlertingManager(
      { hudBaseUrl: "https://hud.example.com" },
      30_000,
      status as unknown as MillsStatusManager,
      channel
    );
    return mgr;
  }

  it("does not toast on the first snapshot (priming run)", () => {
    build();
    status.emit({
      health: "ok",
      status: { policy_enabled: true },
      kpis: { Metrics: { regression_count: 0 } },
    });
    expect(warningSpy).not.toHaveBeenCalled();
  });

  it("toasts when policy_enabled flips from true to false", () => {
    build();
    status.emit({
      health: "ok",
      status: { policy_enabled: true },
    });
    status.emit({
      health: "paused",
      status: { policy_enabled: false },
    });
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy.mock.calls[0][0]).toMatch(/paused/i);
  });

  it("does not toast paused twice in a row", () => {
    build();
    status.emit({ health: "ok", status: { policy_enabled: true } });
    status.emit({ health: "paused", status: { policy_enabled: false } });
    status.emit({ health: "paused", status: { policy_enabled: false } });
    expect(warningSpy).toHaveBeenCalledTimes(1);
  });

  it("toasts when regression count grows", () => {
    build();
    status.emit({
      health: "ok",
      status: { policy_enabled: true },
      kpis: { Metrics: { regression_count: 0 } },
    });
    status.emit({
      health: "degraded",
      status: { policy_enabled: true },
      kpis: { Metrics: { regression_count: 2 } },
    });
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy.mock.calls[0][0]).toMatch(/2 new regression/);
  });

  it("does not toast when regression count is unchanged or shrinks", () => {
    build();
    status.emit({
      health: "ok",
      status: { policy_enabled: true },
      kpis: { Metrics: { regression_count: 3 } },
    });
    status.emit({
      health: "ok",
      status: { policy_enabled: true },
      kpis: { Metrics: { regression_count: 3 } },
    });
    status.emit({
      health: "ok",
      status: { policy_enabled: true },
      kpis: { Metrics: { regression_count: 1 } },
    });
    expect(warningSpy).not.toHaveBeenCalled();
  });

  it("ignores unreachable / unconfigured snapshots", () => {
    build();
    status.emit({ health: "unconfigured" });
    status.emit({ health: "unreachable", error: "ECONNREFUSED" });
    status.emit({ health: "ok", status: { policy_enabled: true } });
    status.emit({ health: "paused", status: { policy_enabled: false } });
    expect(warningSpy).toHaveBeenCalledTimes(1); // only the paused transition fires
  });

  it("toasts when audit findings count grows after first poll", async () => {
    build();
    // First poll establishes baseline
    mockRequestJson.mockResolvedValueOnce([{ ID: 1 }, { ID: 2 }]);
    // Prime via a status snapshot
    status.emit({ health: "ok", status: { policy_enabled: true } });
    // Manually trigger first audit poll by calling private behavior via start()
    // (we already constructed without start to avoid the timer; call refresh path):
    // re-poll directly:
    await (mgr as unknown as { checkAuditFindings: () => Promise<void> }).checkAuditFindings();
    expect(warningSpy).not.toHaveBeenCalled(); // baseline only

    mockRequestJson.mockResolvedValueOnce([{ ID: 1 }, { ID: 2 }, { ID: 3 }, { ID: 4 }]);
    await (mgr as unknown as { checkAuditFindings: () => Promise<void> }).checkAuditFindings();
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy.mock.calls[0][0]).toMatch(/2 new audit finding/);
  });

  it("updateSettings re-primes and does not fire on first post-update snapshot", () => {
    build();
    status.emit({
      health: "ok",
      status: { policy_enabled: true },
      kpis: { Metrics: { regression_count: 5 } },
    });
    status.emit({
      health: "degraded",
      status: { policy_enabled: true },
      kpis: { Metrics: { regression_count: 6 } },
    });
    expect(warningSpy).toHaveBeenCalledTimes(1);
    warningSpy.mockClear();

    mgr.updateSettings({ hudBaseUrl: "https://other.example.com" });
    // First snapshot after update is baseline; should not toast
    status.emit({
      health: "ok",
      status: { policy_enabled: true },
      kpis: { Metrics: { regression_count: 0 } },
    });
    expect(warningSpy).not.toHaveBeenCalled();
  });
});
