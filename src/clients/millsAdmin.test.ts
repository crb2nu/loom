import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

const mockPostJson = vi.hoisted(() => vi.fn());

vi.mock("../utils/http", () => ({
  postJson: mockPostJson,
  requestJson: vi.fn(),
}));

import { MillsAdminClient } from "./millsAdmin";

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
  } as unknown as vscode.OutputChannel;
}

describe("MillsAdminClient", () => {
  let channel: vscode.OutputChannel;
  let client: MillsAdminClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPostJson.mockReset();
    channel = makeChannel();
    client = new MillsAdminClient(
      { hudBaseUrl: "https://hud.example.com", adminToken: "tok-123" },
      channel
    );
  });

  it("council dryrun POSTs to /api/mills/council/dryrun with bearer", async () => {
    mockPostJson.mockResolvedValue({ ID: "c-1" });
    await client.councilDryrun();
    expect(mockPostJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/council/dryrun",
      undefined,
      expect.objectContaining({ Authorization: "Bearer tok-123" })
    );
  });

  it("council run POSTs to /api/mills/council/run", async () => {
    mockPostJson.mockResolvedValue({ ID: "c-2" });
    await client.councilRun();
    expect(mockPostJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/council/run",
      undefined,
      expect.objectContaining({ Authorization: "Bearer tok-123" })
    );
  });

  it("pipeline pause hits /pipeline/runs/{id}/pause with URL-encoding", async () => {
    mockPostJson.mockResolvedValue({});
    await client.pipelinePause("p 1");
    expect(mockPostJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/pipeline/runs/p%201/pause",
      undefined,
      expect.objectContaining({ Authorization: "Bearer tok-123" })
    );
  });

  it("pipeline resume hits the resume path", async () => {
    mockPostJson.mockResolvedValue({});
    await client.pipelineResume("p1");
    expect(mockPostJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/pipeline/runs/p1/resume",
      undefined,
      expect.any(Object)
    );
  });

  it("pipeline escalate hits the escalate path", async () => {
    mockPostJson.mockResolvedValue({});
    await client.pipelineEscalate("p1");
    expect(mockPostJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/pipeline/runs/p1/escalate",
      undefined,
      expect.any(Object)
    );
  });

  it("proposal apply hits /policy/proposals/{id}/apply", async () => {
    mockPostJson.mockResolvedValue({});
    await client.proposalApply("prop-7");
    expect(mockPostJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/policy/proposals/prop-7/apply",
      undefined,
      expect.any(Object)
    );
  });

  it("proposal reject hits /policy/proposals/{id}/reject", async () => {
    mockPostJson.mockResolvedValue({});
    await client.proposalReject("prop-7");
    expect(mockPostJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/policy/proposals/prop-7/reject",
      undefined,
      expect.any(Object)
    );
  });

  it("backlog submit POSTs the body to /api/mills/backlog", async () => {
    mockPostJson.mockResolvedValue({ ID: "MILLS-9", Title: "Add X" });
    await client.backlogSubmit({ ID: "MILLS-9", Title: "Add X", Priority: "P2" });
    expect(mockPostJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/backlog",
      { ID: "MILLS-9", Title: "Add X", Priority: "P2" },
      expect.any(Object)
    );
  });

  it("forwards CF Access headers when configured", async () => {
    const cfClient = new MillsAdminClient(
      {
        hudBaseUrl: "https://hud.example.com",
        adminToken: "tok",
        cfAccessClientId: "id",
        cfAccessClientSecret: "secret",
      },
      channel
    );
    mockPostJson.mockResolvedValue({});
    await cfClient.councilDryrun();
    expect(mockPostJson).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      expect.objectContaining({
        Authorization: "Bearer tok",
        "CF-Access-Client-Id": "id",
        "CF-Access-Client-Secret": "secret",
      })
    );
  });

  it("throws when HUD URL is empty", async () => {
    const noUrl = new MillsAdminClient({ hudBaseUrl: "", adminToken: "tok" }, channel);
    await expect(noUrl.councilDryrun()).rejects.toThrow("Mills HUD URL is not configured");
  });

  it("throws when admin token is empty", async () => {
    const noToken = new MillsAdminClient(
      { hudBaseUrl: "https://hud.example.com", adminToken: "" },
      channel
    );
    await expect(noToken.councilDryrun()).rejects.toThrow("Mills admin token is not set");
  });

  it("re-throws when the upstream call fails", async () => {
    mockPostJson.mockRejectedValue(new Error("403 forbidden"));
    await expect(client.councilDryrun()).rejects.toThrow("403 forbidden");
  });
});
