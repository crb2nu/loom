import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

// Mock fs and os before importing module under test
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockWatch = vi.hoisted(() => vi.fn());

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
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
  writeDaemonConfig,
} from "./config";
import { parse as parseYaml } from "yaml";

describe("deriveHubSettings", () => {
  beforeEach(() => {
    delete process.env.MCP_HUB_URL;
    delete process.env.MCP_PROFILE;
    delete process.env.CF_ACCESS_CLIENT_ID;
    delete process.env.CF_Access_Client_Id;
    delete process.env.CF_ACCESS_CLIENT_SECRET;
    delete process.env.CF_Access_ClientSecret;
    mockReadFileSync.mockReset();
    mockReadFileSync.mockImplementation(() => {
      throw new Error("missing");
    });
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

  it("should fallback to loom config file values", () => {
    mockReadFileSync.mockReturnValue(`hub:
  url: "wss://file.example.com/ws"
  profile: "fileprofile"
  cf_access_client_id: "file-client-id"
  cf_access_client_secret: "file-secret"
`);

    const mockConfig = {
      get: vi.fn(() => undefined),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    const settings = deriveHubSettings();

    expect(settings.hubUrl).toBe("wss://file.example.com/ws");
    expect(settings.profile).toBe("fileprofile");
    expect(settings.cfAccessClientId).toBe("file-client-id");
    expect(settings.cfAccessClientSecret).toBe("file-secret");
  });

  it("should prefer env values over loom config file values", () => {
    process.env.MCP_HUB_URL = "wss://env.example.com/ws";
    process.env.MCP_PROFILE = "envprofile";
    process.env.CF_ACCESS_CLIENT_ID = "env-client-id";
    process.env.CF_ACCESS_CLIENT_SECRET = "env-secret";
    mockReadFileSync.mockReturnValue(`hub:
  url: "wss://file.example.com/ws"
  profile: "fileprofile"
  cf_access_client_id: "file-client-id"
  cf_access_client_secret: "file-secret"
`);

    const mockConfig = {
      get: vi.fn(() => undefined),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      mockConfig as unknown as vscode.WorkspaceConfiguration
    );

    const settings = deriveHubSettings();

    expect(settings.hubUrl).toBe("wss://env.example.com/ws");
    expect(settings.profile).toBe("envprofile");
    expect(settings.cfAccessClientId).toBe("env-client-id");
    expect(settings.cfAccessClientSecret).toBe("env-secret");
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
    mockExistsSync.mockImplementation((p: string) => p === "/workspace/mcp/context/registry.yaml");

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

describe("writeDaemonConfig", () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockMkdir.mockReset();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  function lastWrittenYaml(): Record<string, unknown> {
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const call = mockWriteFile.mock.calls[0];
    return parseYaml(call[1] as string) as Record<string, unknown>;
  }

  it("writes hub.prefer_hub when preferHub=true (the new default)", async () => {
    mockReadFile.mockRejectedValue(new Error("missing"));

    await writeDaemonConfig({
      hubUrl: "wss://mcp.flexinfer.ai/ws",
      profile: "codex",
      preferHub: true,
    });

    const written = lastWrittenYaml();
    const hub = written.hub as Record<string, unknown>;
    expect(hub.prefer_hub).toBe(true);
    expect(hub.url).toBe("wss://mcp.flexinfer.ai/ws");
    expect(hub.enabled).toBe(true);
    expect(hub.profile).toBe("codex");
  });

  it("preserves unknown top-level keys across regens (routing, audit, health)", async () => {
    // Simulates a user who hand-added routing.preferences and audit.* and
    // expects the extension to leave them alone — the bug this fix
    // addresses is that the prior writer wiped them on every activation.
    mockReadFile.mockResolvedValue(`
repo_root: /home/u/workspace
hub:
  url: wss://old.example/ws
  enabled: true
  profile: codex
routing:
  preferences:
    agent_context: prefer-hub
    weaver: hub-only
audit:
  enabled: true
  log_path: /var/log/loom/audit.jsonl
health:
  check_interval_seconds: 45
debug: false
`);

    await writeDaemonConfig({
      hubUrl: "wss://mcp.flexinfer.ai/ws",
      profile: "codex",
      preferHub: true,
    });

    const written = lastWrittenYaml();
    expect(written.repo_root).toBe("/home/u/workspace");
    expect(written.routing).toEqual({
      preferences: { agent_context: "prefer-hub", weaver: "hub-only" },
    });
    expect(written.audit).toEqual({
      enabled: true,
      log_path: "/var/log/loom/audit.jsonl",
    });
    expect(written.health).toEqual({ check_interval_seconds: 45 });
    expect(written.debug).toBe(false);
    const hub = written.hub as Record<string, unknown>;
    expect(hub.url).toBe("wss://mcp.flexinfer.ai/ws");
    expect(hub.prefer_hub).toBe(true);
  });

  it("preserves unknown hub.* sibling keys", async () => {
    mockReadFile.mockResolvedValue(`
hub:
  url: wss://old.example/ws
  enabled: true
  profile: codex
  ping_interval_seconds: 15
  max_retries: 5
  reconnect_interval_seconds: 7
debug: false
`);

    await writeDaemonConfig({
      hubUrl: "wss://mcp.flexinfer.ai/ws",
      profile: "codex",
      preferHub: true,
    });

    const hub = lastWrittenYaml().hub as Record<string, unknown>;
    // extension-owned: rewritten
    expect(hub.url).toBe("wss://mcp.flexinfer.ai/ws");
    expect(hub.profile).toBe("codex");
    // user-owned: preserved verbatim
    expect(hub.ping_interval_seconds).toBe(15);
    expect(hub.max_retries).toBe(5);
    expect(hub.reconnect_interval_seconds).toBe(7);
  });

  it("honors preferHub=false override", async () => {
    mockReadFile.mockRejectedValue(new Error("missing"));

    await writeDaemonConfig({
      hubUrl: "wss://mcp.flexinfer.ai/ws",
      profile: "codex",
      preferHub: false,
    });

    expect((lastWrittenYaml().hub as Record<string, unknown>).prefer_hub).toBe(false);
  });

  it("clears CF Access creds when not provided in settings", async () => {
    mockReadFile.mockResolvedValue(`
hub:
  url: wss://old.example/ws
  enabled: true
  profile: codex
  cf_access_client_id: stale-id
  cf_access_client_secret: stale-secret
`);

    await writeDaemonConfig({
      hubUrl: "wss://mcp.flexinfer.ai/ws",
      profile: "codex",
      preferHub: true,
    });

    const hub = lastWrittenYaml().hub as Record<string, unknown>;
    expect(hub.cf_access_client_id).toBeUndefined();
    expect(hub.cf_access_client_secret).toBeUndefined();
  });

  it("survives a corrupted existing config (degrades to empty merge)", async () => {
    mockReadFile.mockResolvedValue("::: not valid yaml :::");

    await writeDaemonConfig({
      hubUrl: "wss://mcp.flexinfer.ai/ws",
      profile: "codex",
      preferHub: true,
    });

    const written = lastWrittenYaml();
    const hub = written.hub as Record<string, unknown>;
    expect(hub.url).toBe("wss://mcp.flexinfer.ai/ws");
    expect(hub.prefer_hub).toBe(true);
  });
});
