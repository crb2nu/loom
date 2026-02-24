import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock("fs", () => ({
  promises: {
    readFile: mockReadFile,
  },
}));

vi.mock("os", () => ({
  homedir: () => "/home/testuser",
}));

import {
  clearSecretsCache,
  isPlaceholder,
  loadSecretsFromEnvFile,
  resolvePlaceholder,
} from "./secrets";

describe("secrets utils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSecretsCache();
  });

  afterEach(() => {
    delete process.env.TEST_ENV_VALUE;
    delete process.env.FROM_PROCESS_ENV;
  });

  it("loads and parses secrets from env file", async () => {
    mockReadFile.mockResolvedValue(
      [
        "# comment",
        "export GITLAB_PAT=abc123",
        'QDRANT_API_KEY="quoted-value"',
        "PLAIN_VALUE=hello",
        "",
      ].join("\n")
    );

    const secrets = await loadSecretsFromEnvFile();

    expect(secrets).toEqual({
      GITLAB_PAT: "abc123",
      QDRANT_API_KEY: "quoted-value",
      PLAIN_VALUE: "hello",
    });
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it("returns cached secrets until cache is cleared", async () => {
    mockReadFile.mockResolvedValueOnce("TOKEN=first");
    expect(await loadSecretsFromEnvFile()).toEqual({ TOKEN: "first" });

    mockReadFile.mockResolvedValueOnce("TOKEN=second");
    expect(await loadSecretsFromEnvFile()).toEqual({ TOKEN: "first" });

    clearSecretsCache();
    expect(await loadSecretsFromEnvFile()).toEqual({ TOKEN: "second" });
  });

  it("handles missing env file gracefully", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    await expect(loadSecretsFromEnvFile()).resolves.toEqual({});
  });

  it("detects placeholder patterns", () => {
    expect(isPlaceholder("${keychain:OPENAI_API_KEY}")).toBe(true);
    expect(isPlaceholder("${env:OPENAI_API_KEY}")).toBe(true);
    expect(isPlaceholder("plain-value")).toBe(false);
    expect(isPlaceholder("$env:OPENAI_API_KEY")).toBe(false);
  });

  it("resolves keychain placeholders with aliases", async () => {
    mockReadFile.mockResolvedValue(
      ["GITLAB_PAT=gitlab-token", "GRAFANA_API_KEY=grafana-key", "MORPH_API_KEY=morph-token"].join(
        "\n"
      )
    );

    await expect(resolvePlaceholder("${keychain:GITLAB_PERSONAL_ACCESS_TOKEN}")).resolves.toBe(
      "gitlab-token"
    );
    await expect(resolvePlaceholder("${keychain:GRAFANA_API_TOKEN}")).resolves.toBe("grafana-key");
    await expect(resolvePlaceholder("${keychain:QDRANT_API_KEY}")).resolves.toBe("morph-token");
    await expect(resolvePlaceholder("${keychain:DOES_NOT_EXIST}")).resolves.toBeUndefined();
  });

  it("resolves env placeholders from process.env first", async () => {
    process.env.FROM_PROCESS_ENV = "process-value";
    mockReadFile.mockResolvedValue("FROM_PROCESS_ENV=file-value");

    await expect(resolvePlaceholder("${env:FROM_PROCESS_ENV}")).resolves.toBe("process-value");
  });

  it("resolves env placeholders from secrets file and default fallback", async () => {
    mockReadFile.mockResolvedValue("TEST_ENV_VALUE=file-value");
    await expect(resolvePlaceholder("${env:TEST_ENV_VALUE}")).resolves.toBe("file-value");
    await expect(resolvePlaceholder("${env:MISSING_VALUE:-default}")).resolves.toBe("default");
    await expect(resolvePlaceholder("${env:ANOTHER_MISSING}")).resolves.toBeUndefined();
  });
});
