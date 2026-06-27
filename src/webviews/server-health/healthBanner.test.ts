import { describe, it, expect } from "vitest";

import { HubServerHealth, HubHealthDivergenceEntry } from "../../clients/hub";

import {
  collectDegradedServers,
  degradedReason,
  escapeHtml,
  renderDegradedBanner,
  renderDivergenceSummary,
  renderServerHealthDetail,
} from "./healthBanner";

describe("escapeHtml", () => {
  it("escapes HTML-significant characters", () => {
    expect(escapeHtml(`<b>"x" & 'y'</b>`)).toBe(
      "&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;"
    );
  });
});

describe("degradedReason", () => {
  it("prefers a divergence reason", () => {
    const server: HubServerHealth = {
      local: { healthy: false },
      divergence: {
        monitor_healthy: false,
        router_available: true,
        reason: "router still routing",
      },
    };
    expect(degradedReason(server)).toBe("router still routing");
  });

  it("reports the failing endpoint and its error message", () => {
    const server: HubServerHealth = {
      hub: { healthy: false, errorMessage: "dial timeout" },
    };
    expect(degradedReason(server)).toBe("hub probe failing: dial timeout");
  });

  it("reports a consecutive-failure streak when healthy flag is absent", () => {
    const server: HubServerHealth = { monitor: { consecFails: 4 } };
    expect(degradedReason(server)).toBe("monitor probe failed 4 consecutive times");
  });
});

describe("collectDegradedServers", () => {
  it("returns only degraded servers in insertion order", () => {
    const servers: Record<string, HubServerHealth> = {
      github: { local: { healthy: true, consecFails: 0 } },
      tavily: { local: { healthy: false, errorMessage: "boom" } },
      slack: { divergence: { monitor_healthy: false, router_available: true, reason: "split" } },
    };
    const degraded = collectDegradedServers(servers);
    expect(degraded.map((d) => d.name)).toEqual(["tavily", "slack"]);
    expect(degraded[0].reason).toContain("boom");
    expect(degraded[1].reason).toBe("split");
  });

  it("treats old payloads without monitor/divergence as healthy when probes pass", () => {
    const servers: Record<string, HubServerHealth> = {
      github: { local: { healthy: true } },
      tavily: { hub: { healthy: true } },
    };
    expect(collectDegradedServers(servers)).toEqual([]);
  });

  it("degrades on a consecFails threshold even when healthy is still true", () => {
    const servers: Record<string, HubServerHealth> = {
      flaky: { local: { healthy: true, consecFails: 3 } },
    };
    expect(collectDegradedServers(servers).map((d) => d.name)).toEqual(["flaky"]);
  });
});

describe("renderDegradedBanner", () => {
  it("renders nothing when no servers are degraded", () => {
    expect(renderDegradedBanner([])).toBe("");
  });

  it("renders a banner with a count and escaped entries", () => {
    const html = renderDegradedBanner([
      { name: "tav<ily>", reason: "probe failing" },
      { name: "slack", reason: "split brain" },
    ]);
    expect(html).toContain("2 servers degraded");
    expect(html).toContain('role="alert"');
    expect(html).toContain("tav&lt;ily&gt;");
    expect(html).toContain("probe failing");
    expect(html).toContain("split brain");
  });

  it("uses singular noun for a single degraded server", () => {
    const html = renderDegradedBanner([{ name: "github", reason: "down" }]);
    expect(html).toContain("1 server degraded");
  });
});

describe("renderServerHealthDetail", () => {
  it("renders nothing for an old payload without monitor or divergence", () => {
    const server: HubServerHealth = { local: { healthy: true } };
    expect(renderServerHealthDetail(server)).toBe("");
  });

  it("renders the monitor entry with latency and fail count", () => {
    const server: HubServerHealth = {
      monitor: { healthy: false, avgLatencyMs: 42.6, consecFails: 2 },
    };
    const html = renderServerHealthDetail(server);
    expect(html).toContain("Monitor");
    expect(html).toContain("unhealthy");
    expect(html).toContain("43ms");
    expect(html).toContain("2 fails");
    expect(html).toContain("health-monitor-unhealthy");
  });

  it("renders the divergence detail with up/down flags", () => {
    const server: HubServerHealth = {
      divergence: { monitor_healthy: false, router_available: true, reason: "still routed" },
    };
    const html = renderServerHealthDetail(server);
    expect(html).toContain("Divergence");
    expect(html).toContain("still routed");
    expect(html).toContain("monitor=down");
    expect(html).toContain("router=up");
  });
});

describe("renderDivergenceSummary", () => {
  it("renders nothing for an empty array", () => {
    expect(renderDivergenceSummary([])).toBe("");
  });

  it("renders one item per divergence entry with escaping", () => {
    const entries: HubHealthDivergenceEntry[] = [
      { server: "slack", reason: "monitor down, router up" },
      { server: "<x>", reason: "" },
    ];
    const html = renderDivergenceSummary(entries);
    expect(html).toContain("Health/router divergence");
    expect(html).toContain("monitor down, router up");
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("divergence reported");
  });
});
