import { describe, it, expect, vi, beforeEach } from "vitest";

import { CommandContext } from "./types";

const mockRegisterDaemonCommands = vi.hoisted(() =>
  vi.fn(() => [{ dispose: vi.fn() }, { dispose: vi.fn() }])
);
const mockRegisterToolsCommands = vi.hoisted(() => vi.fn(() => [{ dispose: vi.fn() }]));
const mockRegisterSecretsCommands = vi.hoisted(() => vi.fn(() => [{ dispose: vi.fn() }]));
const mockRegisterHubCommands = vi.hoisted(() => vi.fn(() => [{ dispose: vi.fn() }]));
const mockRegisterSyncCommands = vi.hoisted(() => vi.fn(() => [{ dispose: vi.fn() }]));
const mockRegisterContextCommands = vi.hoisted(() => vi.fn(() => [{ dispose: vi.fn() }]));
const mockRegisterStatusCommands = vi.hoisted(() => vi.fn(() => [{ dispose: vi.fn() }]));

vi.mock("./daemon", () => ({
  registerDaemonCommands: mockRegisterDaemonCommands,
}));
vi.mock("./tools", () => ({
  registerToolsCommands: mockRegisterToolsCommands,
}));
vi.mock("./secrets", () => ({
  registerSecretsCommands: mockRegisterSecretsCommands,
}));
vi.mock("./hub", () => ({
  registerHubCommands: mockRegisterHubCommands,
}));
vi.mock("./sync", () => ({
  registerSyncCommands: mockRegisterSyncCommands,
}));
vi.mock("./context", () => ({
  registerContextCommands: mockRegisterContextCommands,
}));
vi.mock("./status", () => ({
  registerStatusCommands: mockRegisterStatusCommands,
}));

import { registerAllCommands } from "./index";

describe("registerAllCommands", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = {} as CommandContext;
  });

  it("registers all command groups and flattens disposables", () => {
    const disposables = registerAllCommands(ctx);

    expect(mockRegisterDaemonCommands).toHaveBeenCalledWith(ctx);
    expect(mockRegisterToolsCommands).toHaveBeenCalledWith(ctx);
    expect(mockRegisterSecretsCommands).toHaveBeenCalledWith(ctx);
    expect(mockRegisterHubCommands).toHaveBeenCalledWith(ctx);
    expect(mockRegisterSyncCommands).toHaveBeenCalledWith(ctx);
    expect(mockRegisterContextCommands).toHaveBeenCalledWith(ctx);
    expect(mockRegisterStatusCommands).toHaveBeenCalledWith(ctx);

    // 2 daemon + 6 single-disposable groups
    expect(disposables).toHaveLength(8);
  });
});
