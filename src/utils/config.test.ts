import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

// Mock fs and os before importing module under test
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockWatch = vi.hoisted(() => vi.fn());

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  watch: mockWatch,
  promises: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
  },
}));

vi.mock("os", () => ({
  homedir: () => "/home/testuser",
}));

import {
  deriveHubSettings,
  convertHubUrlToHttpBase,
  findRegistryPath,
  isHubRoutedConfig,
  loadVscodeConfigSnapshot,
} from "./config";

describe("deriveHubSettings", () => {
  beforeEach(() => {
    delete process.env.MCP_HUB_URL;
    delete process.env.MCP_PROFILE;
    delete process.env.CF_ACCESS_CLIENT_ID;
    delete process.env.CF_Access_Client_Id;
    delete process.env.CF_ACCESS_CLIENT_SECRET;
    delete process.env.CF_Access_ClientSecret;
  });

  it("should use VS Code config values when set", () => {
    const mockConfig = {
      get: vi.fn((key: string) => {
        if (key === "hubUrl") return "wss://custom.example.com/ws";
        if (key === "hubProfile") return "custom";
        return undefined;
      }),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    const settings = deriveHubSettings();

    expect(settings.hubUrl).toBe("wss://custom.example.com/ws");
    expect(settings.profile).toBe("custom");
  });

  it("should fallback to env vars when config is empty", () => {
    process.env.MCP_HUB_URL = "wss://env.example.com/ws";
    process.env.MCP_PROFILE = "envprofile";

    const mockConfig = {
      get: vi.fn(() => undefined),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    const settings = deriveHubSettings();

    expect(settings.hubUrl).toBe("wss://env.example.com/ws");
    expect(settings.profile).toBe("envprofile");
  });

  it("should use default profile when nothing is set", () => {
    const mockConfig = {
      get: vi.fn(() => undefined),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    const settings = deriveHubSettings();

    expect(settings.profile).toBe("codex");
  });

  it("should include CF Access credentials from env", () => {
    process.env.CF_ACCESS_CLIENT_ID = "test-client-id";
    process.env.CF_ACCESS_CLIENT_SECRET = "test-secret";

    const mockConfig = {
      get: vi.fn(() => undefined),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    const settings = deriveHubSettings();

    expect(settings.cfAccessClientId).toBe("test-client-id");
    expect(settings.cfAccessClientSecret).toBe("test-secret");
  });
});

describe("convertHubUrlToHttpBase", () => {
  it("should convert wss:// to https://", () => {
    expect(convertHubUrlToHttpBase("wss://mcp.example.com/ws")).toBe("https://mcp.example.com");
  });

  it("should convert ws:// to http://", () => {
    expect(convertHubUrlToHttpBase("ws://localhost:8080/ws")).toBe("http://localhost:8080");
  });

  it("should pass through http:// URLs", () => {
    expect(convertHubUrlToHttpBase("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("should pass through https:// URLs", () => {
    expect(convertHubUrlToHttpBase("https://mcp.example.com")).toBe("https://mcp.example.com");
  });

  it("should return undefined for empty string", () => {
    expect(convertHubUrlToHttpBase("")).toBeUndefined();
  });

  it("should return undefined for invalid URL", () => {
    expect(convertHubUrlToHttpBase("not a url at all :::")).toBeUndefined();
  });

  it("should default to wss:// for bare hostnames", () => {
    expect(convertHubUrlToHttpBase("mcp.example.com")).toBe("https://mcp.example.com");
  });
});

describe("findRegistryPath", () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
  });

  it("should prefer home directory registry", () => {
    mockExistsSync.mockImplementation(
      (p: string) => p === "/home/testuser/.config/loom/registry.yaml"
    );

    const result = findRegistryPath("/workspace");

    expect(result).toBe("/home/testuser/.config/loom/registry.yaml");
  });

  it("should fallback to workspace registry", () => {
    mockExistsSync.mockImplementation(
      (p: string) => p === "/workspace/mcp/context/registry.yaml"
    );

    const result = findRegistryPath("/workspace");

    expect(result).toBe("/workspace/mcp/context/registry.yaml");
  });

  it("should return null when no registry found", () => {
    mockExistsSync.mockReturnValue(false);

    const result = findRegistryPath("/workspace");

    expect(result).toBeNull();
  });
});

describe("isHubRoutedConfig", () => {
  it("should detect mcp-hub-wrapper in command", () => {
    expect(isHubRoutedConfig({ command: "mcp-hub-wrapper", args: [] })).toBe(true);
  });

  it("should detect mcp-hub-wrapper in args", () => {
    expect(
      isHubRoutedConfig({ command: "node", args: ["mcp-hub-wrapper", "--server", "github"] })
    ).toBe(true);
  });

  it("should detect mcp-ws-adapter in args", () => {
    expect(
      isHubRoutedConfig({ command: "npx", args: ["mcp-ws-adapter", "--url", "wss://..."] })
    ).toBe(true);
  });

  it("should detect websocket type", () => {
    expect(isHubRoutedConfig({ type: "websocket" })).toBe(true);
  });

  it("should return false for local server", () => {
    expect(isHubRoutedConfig({ command: "python", args: ["server.py"] })).toBe(false);
  });

  it("should handle missing fields gracefully", () => {
    expect(isHubRoutedConfig({})).toBe(false);
  });
});

describe("loadVscodeConfigSnapshot", () => {
  beforeEach(() => {
    mockReadFile.mockReset();
  });

  it("should return null for empty workspace root", async () => {
    const result = await loadVscodeConfigSnapshot("");

    expect(result).toBeNull();
  });

  it("should parse mcp.json and classify servers", async () => {
    const mcpJson = JSON.stringify({
      mcpServers: {
        github: { command: "mcp-hub-wrapper", args: ["--server", "github"] },
        local: { command: "python", args: ["server.py"] },
      },
    });

    mockReadFile.mockResolvedValueOnce(mcpJson);

    const result = await loadVscodeConfigSnapshot("/workspace");

    expect(result).not.toBeNull();
    expect(result!.serverNames).toContain("github");
    expect(result!.serverNames).toContain("local");
    expect(result!.hubRouted).toEqual(["github"]);
    expect(result!.localRouted).toEqual(["local"]);
  });

  it("should return null when no config files exist", async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockReadFile.mockRejectedValue(err);

    const result = await loadVscodeConfigSnapshot("/workspace");

    expect(result).toBeNull();
  });
});
