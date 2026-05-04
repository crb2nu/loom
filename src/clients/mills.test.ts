import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

const mockRequestJson = vi.hoisted(() => vi.fn());

vi.mock("../utils/http", () => ({
  requestJson: mockRequestJson,
}));

import { MillsClient, MillsSettings, deriveHealth } from "./mills";

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
      expect(mockRequestJson).toHaveBeenCalledWith(
        "https://hud.example.com/api/mills/status",
        {}
      );
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

      expect(mockRequestJson).toHaveBeenCalledWith(
        "https://hud.example.com/api/mills/kpis",
        {}
      );
    });
  });

  describe("fetchPolicy", () => {
    it("hits /api/mills/policy", async () => {
      mockRequestJson.mockResolvedValue({ enabled: true });
      const client = new MillsClient(settings, channel);

      await client.fetchPolicy();

      expect(mockRequestJson).toHaveBeenCalledWith(
        "https://hud.example.com/api/mills/policy",
        {}
      );
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

    it("returns ok when status enabled and no regressions", async () => {
      mockRequestJson
        .mockResolvedValueOnce({ enabled: true, stage: "prod" })
        .mockResolvedValueOnce({ regression_count: 0, council_runs_total: 12 });
      const client = new MillsClient(settings, channel);

      const snapshot = await client.fetchSnapshot();

      expect(snapshot.health).toBe("ok");
      expect(snapshot.status?.stage).toBe("prod");
      expect(snapshot.kpis?.council_runs_total).toBe(12);
      expect(snapshot.lastUpdated).toBeInstanceOf(Date);
    });

    it("returns paused when status.paused is true", async () => {
      mockRequestJson
        .mockResolvedValueOnce({ enabled: true, paused: true })
        .mockResolvedValueOnce({ regression_count: 0 });
      const client = new MillsClient(settings, channel);

      const snapshot = await client.fetchSnapshot();
      expect(snapshot.health).toBe("paused");
    });

    it("returns paused when status.enabled is false", async () => {
      mockRequestJson
        .mockResolvedValueOnce({ enabled: false })
        .mockResolvedValueOnce({ regression_count: 0 });
      const client = new MillsClient(settings, channel);

      const snapshot = await client.fetchSnapshot();
      expect(snapshot.health).toBe("paused");
    });

    it("returns degraded when regression_count > 0", async () => {
      mockRequestJson
        .mockResolvedValueOnce({ enabled: true })
        .mockResolvedValueOnce({ regression_count: 3 });
      const client = new MillsClient(settings, channel);

      const snapshot = await client.fetchSnapshot();
      expect(snapshot.health).toBe("degraded");
      expect(snapshot.kpis?.regression_count).toBe(3);
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

describe("deriveHealth", () => {
  it("paused beats degraded when both signals fire", () => {
    expect(deriveHealth({ paused: true }, { regression_count: 5 })).toBe("paused");
  });

  it("degraded when regression_count > 0 and not paused", () => {
    expect(deriveHealth({ enabled: true }, { regression_count: 1 })).toBe("degraded");
  });

  it("ok when no signals", () => {
    expect(deriveHealth({ enabled: true }, {})).toBe("ok");
    expect(deriveHealth({}, { regression_count: 0 })).toBe("ok");
  });
});
