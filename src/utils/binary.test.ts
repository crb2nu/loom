import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockStatSync = vi.hoisted(() => vi.fn());

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  statSync: mockStatSync,
}));

vi.mock("os", () => ({
  homedir: () => "/home/testuser",
}));

import { findBinaryInPath, resolveLoomBinary, resolveHubWrapperCommand } from "./binary";

describe("findBinaryInPath", () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
    mockStatSync.mockReset();
  });

  it("should find binary in PATH", () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/local/bin:/usr/bin";

    mockExistsSync.mockImplementation((p: string) => p === "/usr/local/bin/loom");
    mockStatSync.mockReturnValue({ isFile: () => true });

    const result = findBinaryInPath("loom");

    expect(result).toBe("/usr/local/bin/loom");

    process.env.PATH = originalPath;
  });

  it("should return undefined when binary not found", () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin";

    mockExistsSync.mockReturnValue(false);

    const result = findBinaryInPath("nonexistent");

    expect(result).toBeUndefined();

    process.env.PATH = originalPath;
  });

  it("should handle empty PATH", () => {
    const originalPath = process.env.PATH;
    delete process.env.PATH;

    const result = findBinaryInPath("loom");

    expect(result).toBeUndefined();

    process.env.PATH = originalPath;
  });

  it("should handle stat errors gracefully", () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin";

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockImplementation(() => {
      throw new Error("permission denied");
    });

    const result = findBinaryInPath("loom");

    expect(result).toBeUndefined();

    process.env.PATH = originalPath;
  });
});

describe("resolveLoomBinary", () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
    mockStatSync.mockReset();
    delete process.env.LOOM_BINARY;
  });

  it("should use LOOM_BINARY env override", () => {
    process.env.LOOM_BINARY = "/opt/loom/bin/loom";
    mockExistsSync.mockImplementation((p: string) => p === "/opt/loom/bin/loom");

    const result = resolveLoomBinary();

    expect(result).toBe("/opt/loom/bin/loom");
  });

  it("should check ~/.local/bin/loom", () => {
    mockExistsSync.mockImplementation((p: string) => p === "/home/testuser/.local/bin/loom");

    const result = resolveLoomBinary();

    expect(result).toBe("/home/testuser/.local/bin/loom");
  });

  it("should check workspace build directory", () => {
    mockExistsSync.mockImplementation(
      (p: string) => p === "/workspace/services/loom-core/bin/loom"
    );
    mockStatSync.mockReturnValue({ isFile: () => true });

    const result = resolveLoomBinary("/workspace");

    expect(result).toBe("/workspace/services/loom-core/bin/loom");
  });

  it("should resolve a sibling loom-core repository", () => {
    mockExistsSync.mockImplementation(
      (p: string) => p === "/workspace/services/loom-core/bin/loom"
    );
    mockStatSync.mockReturnValue({ isFile: () => true });

    const result = resolveLoomBinary("/workspace/services/loom");

    expect(result).toBe("/workspace/services/loom-core/bin/loom");
  });

  it("should resolve loom-core from an ancestor monorepo root", () => {
    mockExistsSync.mockImplementation(
      (p: string) => p === "/workspace/services/loom-core/bin/loom"
    );
    mockStatSync.mockReturnValue({ isFile: () => true });

    const result = resolveLoomBinary("/workspace/platform/gitops");

    expect(result).toBe("/workspace/services/loom-core/bin/loom");
  });

  it("should resolve the repo-local loom-core binary", () => {
    mockExistsSync.mockImplementation(
      (p: string) => p === "/workspace/services/loom-core/bin/loom"
    );
    mockStatSync.mockReturnValue({ isFile: () => true });

    const result = resolveLoomBinary("/workspace/services/loom-core");

    expect(result).toBe("/workspace/services/loom-core/bin/loom");
  });

  it("should fallback to 'loom' when nothing found", () => {
    mockExistsSync.mockReturnValue(false);

    const result = resolveLoomBinary();

    expect(result).toBe("loom");
  });

  it("should skip empty LOOM_BINARY", () => {
    process.env.LOOM_BINARY = "  ";
    mockExistsSync.mockImplementation((p: string) => p === "/home/testuser/.local/bin/loom");

    const result = resolveLoomBinary();

    expect(result).toBe("/home/testuser/.local/bin/loom");
  });
});

describe("resolveHubWrapperCommand", () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
    delete process.env.MCP_HUB_WRAPPER_PATH;
    delete process.env.MCP_HUB_WRAPPER;
  });

  it("should use MCP_HUB_WRAPPER_PATH env override", () => {
    process.env.MCP_HUB_WRAPPER_PATH = "/opt/wrapper";
    mockExistsSync.mockImplementation((p: string) => p === "/opt/wrapper");

    const result = resolveHubWrapperCommand();

    expect(result).toBe("/opt/wrapper");
  });

  it("should use MCP_HUB_WRAPPER env fallback", () => {
    process.env.MCP_HUB_WRAPPER = "/opt/wrapper2";
    mockExistsSync.mockImplementation((p: string) => p === "/opt/wrapper2");

    const result = resolveHubWrapperCommand();

    expect(result).toBe("/opt/wrapper2");
  });

  it("should check workspace shim", () => {
    mockExistsSync.mockImplementation((p: string) => p === "/workspace/scripts/mcp/hub_wrapper.sh");

    const result = resolveHubWrapperCommand("/workspace");

    expect(result).toBe("/workspace/scripts/mcp/hub_wrapper.sh");
  });

  it("should fallback to 'mcp-hub-wrapper'", () => {
    mockExistsSync.mockReturnValue(false);

    const result = resolveHubWrapperCommand();

    expect(result).toBe("mcp-hub-wrapper");
  });
});
