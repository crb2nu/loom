import { describe, it, expect, beforeEach, vi } from "vitest";
import { Uri, window } from "vscode";

import { HubServerHealth, HubHealthDivergenceEntry } from "../clients/hub";
import { RoutingStatus } from "../types";

import {
  ServerHealthData,
  ServerHealthPanel,
  renderHealthBannerSection,
} from "./ServerHealthPanel";

const routing: RoutingStatus = {
  hubRouted: [],
  localRouted: [],
  hubHealthy: true,
  activeProfile: "default",
};

function baseData(overrides: Partial<ServerHealthData> = {}): ServerHealthData {
  return {
    metrics: [],
    history: new Map(),
    routing,
    ...overrides,
  };
}

/** Read the most recent `updateData` payload the panel posted to its webview. */
function lastPostedData(): {
  bannerHtml?: string;
  serverDetails?: Record<string, string>;
} {
  const panelMock = vi.mocked(window.createWebviewPanel).mock.results.at(-1)?.value as {
    webview: { postMessage: ReturnType<typeof vi.fn> };
  };
  const calls = panelMock.webview.postMessage.mock.calls;
  const message = calls[calls.length - 1][0] as {
    data: { bannerHtml?: string; serverDetails?: Record<string, string> };
  };
  return message.data;
}

describe("renderHealthBannerSection", () => {
  it("renders the degraded banner when a server is degraded", () => {
    const hubServers: Record<string, HubServerHealth> = {
      tavily: { local: { healthy: false, errorMessage: "boom" } },
    };
    const html = renderHealthBannerSection(hubServers, []);
    expect(html).toContain("1 server degraded");
    expect(html).toContain("tavily");
    expect(html).toContain("boom");
  });

  it("renders the divergence summary from top-level divergence", () => {
    const divergence: HubHealthDivergenceEntry[] = [{ server: "slack", reason: "monitor down" }];
    const html = renderHealthBannerSection({}, divergence);
    expect(html).toContain("Health/router divergence");
    expect(html).toContain("slack");
    expect(html).toContain("monitor down");
  });

  it("renders nothing when all servers are healthy and there is no divergence", () => {
    const hubServers: Record<string, HubServerHealth> = { github: { local: { healthy: true } } };
    expect(renderHealthBannerSection(hubServers, [])).toBe("");
  });
});

describe("ServerHealthPanel.updateData", () => {
  beforeEach(() => {
    ServerHealthPanel.currentPanel = undefined;
    vi.mocked(window.createWebviewPanel).mockClear();
  });

  it("posts banner HTML and per-server detail when a degraded/divergent server is present", () => {
    const panel = ServerHealthPanel.render(Uri.file("/ext"));
    panel.updateData(
      baseData({
        hubServers: {
          tavily: {
            monitor: { healthy: false, consecFails: 4 },
            divergence: { monitor_healthy: false, router_available: true, reason: "split brain" },
          },
        },
        divergence: [{ server: "tavily", reason: "split brain" }],
      })
    );

    const data = lastPostedData();
    expect(data.bannerHtml).toContain("degraded");
    expect(data.bannerHtml).toContain("Health/router divergence");
    expect(data.bannerHtml).toContain("tavily");
    expect(data.serverDetails?.tavily).toContain("Divergence");
    expect(data.serverDetails?.tavily).toContain("split brain");
  });

  it("posts an empty banner when no servers are degraded", () => {
    const panel = ServerHealthPanel.render(Uri.file("/ext"));
    panel.updateData(baseData({ hubServers: { github: { local: { healthy: true } } } }));

    const data = lastPostedData();
    expect(data.bannerHtml).toBe("");
    expect(data.serverDetails).toEqual({});
  });
});
