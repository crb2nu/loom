import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

const mockRequestJson = vi.hoisted(() => vi.fn());

vi.mock("../utils/http", () => ({
  requestJson: mockRequestJson,
}));

import { MillsClient, MillsSettings, coerceList, deriveHealth } from "./mills";

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

describe("MillsClient", () => {
  let channel: vscode.OutputChannel;
  let settings: MillsSettings;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestJson.mockReset();
    channel = makeChannel();
    settings = { hudBaseUrl: "https://hud.example.com" };
  });

  describe("isConfigured", () => {
    it("returns true when hudBaseUrl is set", () => {
      const client = new MillsClient(settings, channel);
      expect(client.isConfigured()).toBe(true);
    });

    it("returns false when hudBaseUrl is empty", () => {
      const client = new MillsClient({ hudBaseUrl: "" }, channel);
      expect(client.isConfigured()).toBe(false);
    });
  });

  describe("fetchStatus", () => {
    it("hits /api/mills/status under the configured HUD", async () => {
      mockRequestJson.mockResolvedValue({ enabled: true, stage: "prod" });
      const client = new MillsClient(settings, channel);

      const result = await client.fetchStatus();

      expect(result).toEqual({ enabled: true, stage: "prod" });
      expect(mockRequestJson).toHaveBeenCalledWith("https://hud.example.com/api/mills/status", {});
    });

    it("throws when HUD URL is missing", async () => {
      const client = new MillsClient({ hudBaseUrl: "" }, channel);
      await expect(client.fetchStatus()).rejects.toThrow("Mills HUD URL is not configured");
    });
  });

  describe("fetchKpis", () => {
    it("hits /api/mills/kpis", async () => {
      mockRequestJson.mockResolvedValue({ regression_count: 0 });
      const client = new MillsClient(settings, channel);

      await client.fetchKpis();

      expect(mockRequestJson).toHaveBeenCalledWith("https://hud.example.com/api/mills/kpis", {});
    });
  });

  describe("fetchPolicy", () => {
    it("hits /api/mills/policy", async () => {
      mockRequestJson.mockResolvedValue({ enabled: true });
      const client = new MillsClient(settings, channel);

      await client.fetchPolicy();

      expect(mockRequestJson).toHaveBeenCalledWith("https://hud.example.com/api/mills/policy", {});
    });
  });

  describe("CF Access headers", () => {
    it("includes CF headers when both id and secret are set", async () => {
      mockRequestJson.mockResolvedValue({});
      const client = new MillsClient(
        {
          hudBaseUrl: "https://hud.example.com",
          cfAccessClientId: "id",
          cfAccessClientSecret: "secret",
        },
        channel
      );

      await client.fetchStatus();

      expect(mockRequestJson).toHaveBeenCalledWith(
        "https://hud.example.com/api/mills/status",
        expect.objectContaining({
          "CF-Access-Client-Id": "id",
          "CF-Access-Client-Secret": "secret",
        })
      );
    });

    it("omits CF headers when only one of id/secret is set", async () => {
      mockRequestJson.mockResolvedValue({});
      const client = new MillsClient(
        { hudBaseUrl: "https://hud.example.com", cfAccessClientId: "id" },
        channel
      );

      await client.fetchStatus();

      const headers = mockRequestJson.mock.calls[0][1] as Record<string, string>;
      expect(headers["CF-Access-Client-Id"]).toBeUndefined();
    });
  });

  describe("fetchSnapshot", () => {
    it("returns unconfigured when HUD URL is empty", async () => {
      const client = new MillsClient({ hudBaseUrl: "" }, channel);
      const snapshot = await client.fetchSnapshot();
      expect(snapshot.health).toBe("unconfigured");
      expect(mockRequestJson).not.toHaveBeenCalled();
    });

    it("returns ok when policy enabled and no regressions", async () => {
      mockRequestJson
        .mockResolvedValueOnce({ policy_enabled: true, queue_depth: 4 })
        .mockResolvedValueOnce({ Metrics: { regression_count: 0 } });
      const client = new MillsClient(settings, channel);

      const snapshot = await client.fetchSnapshot();

      expect(snapshot.health).toBe("ok");
      expect(snapshot.status?.queue_depth).toBe(4);
      expect(snapshot.lastUpdated).toBeInstanceOf(Date);
    });

    it("returns paused when status.policy_enabled is false", async () => {
      mockRequestJson
        .mockResolvedValueOnce({ policy_enabled: false })
        .mockResolvedValueOnce({ Metrics: { regression_count: 0 } });
      const client = new MillsClient(settings, channel);

      const snapshot = await client.fetchSnapshot();
      expect(snapshot.health).toBe("paused");
    });

    it("returns degraded when regression metric > 0", async () => {
      mockRequestJson
        .mockResolvedValueOnce({ policy_enabled: true })
        .mockResolvedValueOnce({ Metrics: { regression_count: 3 } });
      const client = new MillsClient(settings, channel);

      const snapshot = await client.fetchSnapshot();
      expect(snapshot.health).toBe("degraded");
    });

    it("tolerates KPI metrics under alternate keys", async () => {
      mockRequestJson.mockResolvedValueOnce({ policy_enabled: true }).mockResolvedValueOnce({
        Metrics: { loom_mills_regression_count_total: 2 },
      });
      const client = new MillsClient(settings, channel);

      const snapshot = await client.fetchSnapshot();
      expect(snapshot.health).toBe("degraded");
    });

    it("returns unreachable on network error and does not throw", async () => {
      mockRequestJson.mockRejectedValue(new Error("ECONNREFUSED"));
      const client = new MillsClient(settings, channel);

      const snapshot = await client.fetchSnapshot();

      expect(snapshot.health).toBe("unreachable");
      expect(snapshot.error).toContain("ECONNREFUSED");
    });
  });
});

describe("MillsClient list endpoints", () => {
  let channel: vscode.OutputChannel;
  let client: MillsClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestJson.mockReset();
    channel = makeChannel();
    client = new MillsClient({ hudBaseUrl: "https://hud.example.com" }, channel);
  });

  it("fetchBacklog hits /api/mills/backlog and returns array", async () => {
    mockRequestJson.mockResolvedValue([{ ID: "MILLS-1", Title: "x" }]);
    const items = await client.fetchBacklog();
    expect(items).toEqual([{ ID: "MILLS-1", Title: "x" }]);
    expect(mockRequestJson).toHaveBeenCalledWith("https://hud.example.com/api/mills/backlog", {});
  });

  it("fetchBacklog unwraps {items: [...]} envelope", async () => {
    mockRequestJson.mockResolvedValue({ items: [{ ID: "MILLS-2" }] });
    const items = await client.fetchBacklog();
    expect(items).toHaveLength(1);
    expect(items[0].ID).toBe("MILLS-2");
  });

  it("fetchPipelineRuns hits /api/mills/pipeline/runs", async () => {
    mockRequestJson.mockResolvedValue([]);
    await client.fetchPipelineRuns();
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/pipeline/runs",
      {}
    );
  });

  it("fetchCouncilRuns hits /api/mills/council/runs", async () => {
    mockRequestJson.mockResolvedValue([]);
    await client.fetchCouncilRuns();
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/council/runs",
      {}
    );
  });

  it("fetchSquads hits /api/mills/squads", async () => {
    mockRequestJson.mockResolvedValue([]);
    await client.fetchSquads();
    expect(mockRequestJson).toHaveBeenCalledWith("https://hud.example.com/api/mills/squads", {});
  });

  it("fetchAuditFindings hits /api/mills/audit/findings", async () => {
    mockRequestJson.mockResolvedValue([]);
    await client.fetchAuditFindings();
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/audit/findings",
      {}
    );
  });

  it("returns [] when payload is unknown shape", async () => {
    mockRequestJson.mockResolvedValue({ unrelated: 42 });
    const items = await client.fetchBacklog();
    expect(items).toEqual([]);
  });
});

describe("MillsClient detail endpoints", () => {
  let channel: vscode.OutputChannel;
  let client: MillsClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestJson.mockReset();
    channel = makeChannel();
    client = new MillsClient({ hudBaseUrl: "https://hud.example.com" }, channel);
  });

  it("fetchBacklogItem hits /api/mills/backlog/{id} with URL-encoding", async () => {
    mockRequestJson.mockResolvedValue({ ID: "MILLS A/1" });
    await client.fetchBacklogItem("MILLS A/1");
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/backlog/MILLS%20A%2F1",
      {}
    );
  });

  it("fetchCouncilRun hits /api/mills/council/runs/{id}", async () => {
    mockRequestJson.mockResolvedValue({ ID: "abc" });
    await client.fetchCouncilRun("abc");
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/council/runs/abc",
      {}
    );
  });

  it("fetchPipelineRun hits /api/mills/pipeline/runs/{id}", async () => {
    mockRequestJson.mockResolvedValue({ ID: "p1" });
    await client.fetchPipelineRun("p1");
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/pipeline/runs/p1",
      {}
    );
  });

  it("fetchAuditFinding hits /api/mills/audit/findings/{id}", async () => {
    mockRequestJson.mockResolvedValue({ ID: 7 });
    await client.fetchAuditFinding("7");
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/audit/findings/7",
      {}
    );
  });

  it("fetchPolicyProposals hits /api/mills/policy/proposals", async () => {
    mockRequestJson.mockResolvedValue([]);
    await client.fetchPolicyProposals();
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/policy/proposals",
      {}
    );
  });
});

describe("MillsClient S7 read surfaces", () => {
  let channel: vscode.OutputChannel;
  let client: MillsClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestJson.mockReset();
    channel = makeChannel();
    client = new MillsClient({ hudBaseUrl: "https://hud.example.com" }, channel);
  });

  it("fetchCostPreview hits /api/mills/cost-preview with backlog_id", async () => {
    mockRequestJson.mockResolvedValue({ backlog_id: "MILLS-1", estimate_usd: 2.5, source: "x" });
    const preview = await client.fetchCostPreview("MILLS-1");
    expect(preview.estimate_usd).toBe(2.5);
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/cost-preview?backlog_id=MILLS-1",
      {}
    );
  });

  it("fetchCostPreview URL-encodes the backlog id", async () => {
    mockRequestJson.mockResolvedValue({});
    await client.fetchCostPreview("MILLS A/1");
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/cost-preview?backlog_id=MILLS%20A%2F1",
      {}
    );
  });

  it("fetchCostPreview propagates a 503 (policy manager not ready) as an Error", async () => {
    mockRequestJson.mockRejectedValue(new Error("503 policy manager not ready"));
    await expect(client.fetchCostPreview("MILLS-1")).rejects.toThrow("policy manager not ready");
  });

  it("fetchEvalScores hits /api/mills/eval/scores and returns the array", async () => {
    mockRequestJson.mockResolvedValue([{ ID: 1, Score: 0.9 }]);
    const scores = await client.fetchEvalScores();
    expect(scores).toHaveLength(1);
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/eval/scores",
      {}
    );
  });

  it("fetchEvalScores returns [] on a 200-empty body (table empty until 3.5)", async () => {
    mockRequestJson.mockResolvedValue([]);
    const scores = await client.fetchEvalScores();
    expect(scores).toEqual([]);
  });

  it("fetchEvalScores returns [] when requestJson yields {} (empty body)", async () => {
    mockRequestJson.mockResolvedValue({});
    const scores = await client.fetchEvalScores();
    expect(scores).toEqual([]);
  });

  it("fetchCrossRepoRuns unwraps the {runs,total,limit} envelope", async () => {
    mockRequestJson.mockResolvedValue({
      runs: [{ id: "cr-1", state: "open" }],
      total: 1,
      limit: 50,
    });
    const runs = await client.fetchCrossRepoRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe("cr-1");
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/cross-repo/runs",
      {}
    );
  });

  it("fetchCrossRepoRuns returns [] for an empty envelope", async () => {
    mockRequestJson.mockResolvedValue({ runs: [], total: 0, limit: 50 });
    expect(await client.fetchCrossRepoRuns()).toEqual([]);
  });

  it("fetchCrossRepoRun hits /api/mills/cross-repo/runs/{id}", async () => {
    mockRequestJson.mockResolvedValue({ id: "cr-1", state: "merged" });
    const run = await client.fetchCrossRepoRun("cr-1");
    expect(run.state).toBe("merged");
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/cross-repo/runs/cr-1",
      {}
    );
  });

  it("fetchWorkflowRuns hits /api/mills/workflow/runs and unwraps {runs}", async () => {
    mockRequestJson.mockResolvedValue({ runs: [{ id: "wf-1", state: "running" }] });
    const runs = await client.fetchWorkflowRuns();
    expect(runs).toHaveLength(1);
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/workflow/runs",
      {}
    );
  });

  it("fetchWorkflowRun returns {run, steps} and normalizes missing steps", async () => {
    mockRequestJson.mockResolvedValue({ run: { id: "wf-1", state: "succeeded" } });
    const detail = await client.fetchWorkflowRun("wf-1");
    expect(detail.run.id).toBe("wf-1");
    expect(detail.steps).toEqual([]);
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/workflow/runs/wf-1",
      {}
    );
  });

  it("fetchWorkflowRun carries nested steps through", async () => {
    mockRequestJson.mockResolvedValue({
      run: { id: "wf-1" },
      steps: [{ step_key: "plan", badge: "live" }],
    });
    const detail = await client.fetchWorkflowRun("wf-1");
    expect(detail.steps).toHaveLength(1);
    expect(detail.steps[0].badge).toBe("live");
  });

  it("fetchWorkflowRun synthesizes a run id when the body is empty", async () => {
    mockRequestJson.mockResolvedValue({});
    const detail = await client.fetchWorkflowRun("wf-9");
    expect(detail.run.id).toBe("wf-9");
    expect(detail.steps).toEqual([]);
  });

  it("fetchSquadMemory hits the squad memory path and returns rows", async () => {
    mockRequestJson.mockResolvedValue([{ ID: 1, Title: "note" }]);
    const rows = await client.fetchSquadMemory("alpha");
    expect(rows).toHaveLength(1);
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/squads/alpha/memory",
      {}
    );
  });

  it("fetchSquadMemory returns [] on a 200-empty body (loader unconfigured)", async () => {
    mockRequestJson.mockResolvedValue([]);
    expect(await client.fetchSquadMemory("alpha")).toEqual([]);
  });

  it("fetchSquadMemory URL-encodes the squad name", async () => {
    mockRequestJson.mockResolvedValue([]);
    await client.fetchSquadMemory("team a/b");
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/squads/team%20a%2Fb/memory",
      {}
    );
  });

  it("fetchSquadOutcomes hits the squad outcomes path", async () => {
    mockRequestJson.mockResolvedValue([{ ID: 2, Outcome: "merged_clean" }]);
    const rows = await client.fetchSquadOutcomes("alpha");
    expect(rows[0].Outcome).toBe("merged_clean");
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/squads/alpha/outcomes",
      {}
    );
  });

  it("fetchSquadOutcomes returns [] when empty", async () => {
    mockRequestJson.mockResolvedValue([]);
    expect(await client.fetchSquadOutcomes("alpha")).toEqual([]);
  });

  it("propagates a 404 (squad not found) from squad memory/outcomes", async () => {
    mockRequestJson.mockRejectedValue(new Error("404 squad not found"));
    await expect(client.fetchSquadMemory("ghost")).rejects.toThrow("squad not found");
  });

  it("fetchCapabilities hits /api/mills/capabilities", async () => {
    mockRequestJson.mockResolvedValue({
      autonomy_ready: false,
      autonomy_blockers: ["council.ensemble"],
      capabilities: [{ id: "x", status: "stub" }],
      checked_at: "2026-06-27T00:00:00Z",
    });
    const report = await client.fetchCapabilities();
    expect(report.autonomy_ready).toBe(false);
    expect(report.capabilities).toHaveLength(1);
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/capabilities",
      {}
    );
  });

  it("S7 reads throw when HUD URL is missing", async () => {
    const bare = new MillsClient({ hudBaseUrl: "" }, channel);
    await expect(bare.fetchEvalScores()).rejects.toThrow("Mills HUD URL is not configured");
    await expect(bare.fetchCapabilities()).rejects.toThrow("Mills HUD URL is not configured");
  });

  it("S7 reads forward CF Access headers when configured", async () => {
    mockRequestJson.mockResolvedValue([]);
    const cfClient = new MillsClient(
      {
        hudBaseUrl: "https://hud.example.com",
        cfAccessClientId: "id",
        cfAccessClientSecret: "secret",
      },
      channel
    );
    await cfClient.fetchCrossRepoRuns();
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud.example.com/api/mills/cross-repo/runs",
      expect.objectContaining({
        "CF-Access-Client-Id": "id",
        "CF-Access-Client-Secret": "secret",
      })
    );
  });
});

describe("coerceList", () => {
  it("returns array unchanged", () => {
    expect(coerceList([{ a: 1 }])).toEqual([{ a: 1 }]);
  });

  it("unwraps `items`, `runs`, `findings`, `squads`, `backlog` keys", () => {
    expect(coerceList({ items: [1] })).toEqual([1]);
    expect(coerceList({ runs: [2] })).toEqual([2]);
    expect(coerceList({ findings: [3] })).toEqual([3]);
    expect(coerceList({ squads: [4] })).toEqual([4]);
    expect(coerceList({ backlog: [5] })).toEqual([5]);
    expect(coerceList({ scores: [6] })).toEqual([6]);
    expect(coerceList({ outcomes: [7] })).toEqual([7]);
    expect(coerceList({ memory: [8] })).toEqual([8]);
  });

  it("returns [] for null, undefined, or unknown shape", () => {
    expect(coerceList(null)).toEqual([]);
    expect(coerceList(undefined)).toEqual([]);
    expect(coerceList({ other: [1] })).toEqual([]);
    expect(coerceList(42)).toEqual([]);
  });
});

describe("deriveHealth", () => {
  it("paused beats degraded when both signals fire", () => {
    expect(deriveHealth({ policy_enabled: false }, { Metrics: { regression_count: 5 } })).toBe(
      "paused"
    );
  });

  it("degraded when regression metric > 0 and not paused", () => {
    expect(deriveHealth({ policy_enabled: true }, { Metrics: { regression_count: 1 } })).toBe(
      "degraded"
    );
  });

  it("ok when no signals", () => {
    expect(deriveHealth({ policy_enabled: true }, {})).toBe("ok");
    expect(deriveHealth({}, { Metrics: { regression_count: 0 } })).toBe("ok");
  });
});
