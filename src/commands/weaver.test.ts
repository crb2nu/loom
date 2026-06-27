/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

const mockQuery = vi.hoisted(() => vi.fn());
const mockDeriveMillsConfig = vi.hoisted(() =>
  vi.fn(() => ({
    hudBaseUrl: "https://hud.example.com",
    refreshIntervalMs: 60_000,
    alertingIntervalMs: 120_000,
    cfAccessClientId: undefined,
    cfAccessClientSecret: undefined,
  }))
);

vi.mock("../clients/weaver", () => ({
  WeaverClient: vi.fn().mockImplementation(() => ({
    query: mockQuery,
  })),
}));

vi.mock("../utils/config", () => ({
  deriveMillsConfig: mockDeriveMillsConfig,
}));

import { registerWeaverCommands, WeaverCommandContext } from "./weaver";

function getRegisteredCommandHandler(command: string): () => Promise<void> {
  const call = vi
    .mocked(vscode.commands.registerCommand)
    .mock.calls.find(([registered]) => registered === command);
  if (!call) {
    throw new Error(`Command not registered: ${command}`);
  }
  return call[1] as () => Promise<void>;
}

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

/** All appendLine arguments concatenated, for substring assertions. */
function channelText(channel: vscode.OutputChannel): string {
  return vi
    .mocked(channel.appendLine)
    .mock.calls.map((args) => String(args[0]))
    .join("\n");
}

describe("weaver runQuery command", () => {
  let ctx: WeaverCommandContext;
  let channel: vscode.OutputChannel;
  let refresh: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    mockDeriveMillsConfig.mockReturnValue({
      hudBaseUrl: "https://hud.example.com",
      refreshIntervalMs: 60_000,
      alertingIntervalMs: 120_000,
      cfAccessClientId: undefined,
      cfAccessClientSecret: undefined,
    });

    // experimental gate enabled by default for the run path.
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_section: string, defaultValue?: unknown) => {
        if (_section === "experimental.weaver") return true;
        return defaultValue;
      }),
      has: vi.fn(() => false),
      inspect: vi.fn(() => undefined),
      update: vi.fn(() => Promise.resolve(undefined)),
    });

    vi.mocked(vscode.window.showInputBox).mockResolvedValue("what is the deploy status?");

    channel = makeChannel();
    refresh = vi.fn(() => Promise.resolve(undefined));
    ctx = {
      loomChannel: channel,
      weaverTreeProvider: { refresh } as unknown as WeaverCommandContext["weaverTreeProvider"],
    };
  });

  it("registers refreshWeaver and runQuery commands", () => {
    const disposables = registerWeaverCommands(ctx);
    expect(disposables).toHaveLength(2);
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      "loom.weaver.runQuery",
      expect.any(Function)
    );
  });

  it("POSTs the query and renders answer, tokens, latency, and domains", async () => {
    mockQuery.mockResolvedValue({
      answer: "All green.",
      total_tokens: 412,
      latency_ms: 1830,
      domains_used: ["deploy-status", "ci-pipeline"],
    });

    registerWeaverCommands(ctx);
    const handler = getRegisteredCommandHandler("loom.weaver.runQuery");
    await handler();

    expect(mockQuery).toHaveBeenCalledWith({ query: "what is the deploy status?" });

    const text = channelText(channel);
    expect(text).toContain("All green.");
    expect(text).toContain("tokens=412");
    expect(text).toContain("latency=1830ms");
    expect(text).toContain("domains=deploy-status, ci-pipeline");

    // The stub message must be gone.
    expect(text).not.toContain("use the terminal");
    expect(text).not.toContain("requires the daemon socket");
    expect(text).not.toMatch(/run queries via your terminal/i);

    // History tree refreshes so the new query appears.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it("renders a degraded status without treating it as an error", async () => {
    mockQuery.mockResolvedValue({
      answer: "Partial answer (one domain offline).",
      total_tokens: 88,
      latency_ms: 540,
      domains_used: ["deploy-status"],
      status: "degraded",
    });

    registerWeaverCommands(ctx);
    await getRegisteredCommandHandler("loom.weaver.runQuery")();

    const text = channelText(channel);
    expect(text).toContain("Partial answer (one domain offline).");
    expect(text).toContain("status=degraded");
    expect(text).not.toContain("use the terminal");
    // A returned (non-throwing) degraded result is still a successful call.
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("surfaces query errors and does not refresh the tree", async () => {
    mockQuery.mockRejectedValue(new Error("502 weaver query failed: model qwen3 not loaded"));

    registerWeaverCommands(ctx);
    await getRegisteredCommandHandler("loom.weaver.runQuery")();

    const text = channelText(channel);
    expect(text).toContain("query failed");
    expect(text).toContain("model qwen3 not loaded");
    expect(text).not.toContain("use the terminal");

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("weaver query failed")
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("warns and skips the POST when no HUD URL is configured", async () => {
    mockDeriveMillsConfig.mockReturnValue({
      hudBaseUrl: "",
      refreshIntervalMs: 60_000,
      alertingIntervalMs: 120_000,
      cfAccessClientId: undefined,
      cfAccessClientSecret: undefined,
    });

    registerWeaverCommands(ctx);
    await getRegisteredCommandHandler("loom.weaver.runQuery")();

    expect(mockQuery).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("loom.mills.hudBaseUrl"),
      "Open Settings"
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stays gated behind loom.experimental.weaver when disabled", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_section: string, defaultValue?: unknown) => {
        if (_section === "experimental.weaver") return false;
        return defaultValue;
      }),
      has: vi.fn(() => false),
      inspect: vi.fn(() => undefined),
      update: vi.fn(() => Promise.resolve(undefined)),
    });

    registerWeaverCommands(ctx);
    await getRegisteredCommandHandler("loom.weaver.runQuery")();

    expect(mockQuery).not.toHaveBeenCalled();
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("experimental"),
      "Open Settings"
    );
  });
});
