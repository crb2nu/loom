/**
 * Pure render helpers for the Server Health webview's degraded banner and the
 * per-server Monitor / Divergence detail. These are framework-free string
 * builders so they can be unit-tested without the VS Code webview runtime and
 * embedded into the panel HTML at integration time.
 *
 * The input shapes mirror loom-core's `GET /api/health` contract
 * (`internal/visibility/contracts/health.ServerHealth`): each server carries
 * optional `local`/`hub`/`monitor` entries, a `target`/`transport`, and an
 * optional per-server `divergence`. The top-level `divergence` array is the
 * `health.HealthDivergenceEntry` summary.
 */
import { HubServerHealth, HubHealthDivergenceEntry, isServerDegraded } from "../../clients/hub";

/** Minimal escaping for untrusted server names / reasons rendered into HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A degraded server, surfaced in the banner with the reason it degraded. */
export interface DegradedServer {
  name: string;
  reason: string;
}

/**
 * Derive the human-readable reason a server is degraded, in priority order:
 * router/monitor divergence, an explicit unhealthy endpoint (with its error
 * message when present), then a sustained consecutive-failure streak.
 */
export function degradedReason(server: HubServerHealth): string {
  if (server.divergence) {
    return server.divergence.reason?.trim() || "health monitor and router disagree on availability";
  }
  const labelled: Array<[string, NonNullable<HubServerHealth["local"]>]> = [];
  if (server.local) labelled.push(["local", server.local]);
  if (server.hub) labelled.push(["hub", server.hub]);
  if (server.monitor) labelled.push(["monitor", server.monitor]);

  for (const [label, entry] of labelled) {
    if (entry.healthy === false) {
      const msg = entry.errorMessage?.trim();
      return msg ? `${label} probe failing: ${msg}` : `${label} probe failing`;
    }
  }
  for (const [label, entry] of labelled) {
    const fails = entry.consecFails ?? 0;
    if (fails >= 3) {
      return `${label} probe failed ${fails} consecutive times`;
    }
  }
  return "degraded";
}

/**
 * Compute the set of degraded servers from a parsed `/api/health` server map.
 * Stable insertion order is preserved for deterministic rendering/tests.
 */
export function collectDegradedServers(servers: Record<string, HubServerHealth>): DegradedServer[] {
  const out: DegradedServer[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (isServerDegraded(server)) {
      out.push({ name, reason: degradedReason(server) });
    }
  }
  return out;
}

/**
 * Render the degraded banner HTML, or an empty string when nothing is
 * degraded (so the caller can unconditionally inject the result).
 */
export function renderDegradedBanner(degraded: DegradedServer[]): string {
  if (degraded.length === 0) {
    return "";
  }
  const count = degraded.length;
  const noun = count === 1 ? "server" : "servers";
  const items = degraded
    .map(
      (d) =>
        `<li><span class="banner-server">${escapeHtml(d.name)}</span>: ${escapeHtml(d.reason)}</li>`
    )
    .join("");
  return `<div class="health-banner health-banner-degraded" role="alert">
  <div class="health-banner-title">⚠ ${count} ${noun} degraded</div>
  <ul class="health-banner-list">${items}</ul>
</div>`;
}

/**
 * Render the per-server Monitor + Divergence detail block, or an empty string
 * when the server has neither (older payloads). Embedded inside a server card.
 */
export function renderServerHealthDetail(server: HubServerHealth): string {
  const parts: string[] = [];

  if (server.monitor) {
    const m = server.monitor;
    const state = m.healthy === false ? "unhealthy" : "healthy";
    const latency = typeof m.avgLatencyMs === "number" ? ` · ${Math.round(m.avgLatencyMs)}ms` : "";
    const fails = (m.consecFails ?? 0) > 0 ? ` · ${m.consecFails} fails` : "";
    parts.push(
      `<div class="health-detail health-monitor health-monitor-${state}">` +
        `<span class="health-detail-label">Monitor</span> ${state}${latency}${fails}` +
        `</div>`
    );
  }

  if (server.divergence) {
    const d = server.divergence;
    const reason = escapeHtml(d.reason?.trim() || "monitor and router disagree");
    parts.push(
      `<div class="health-detail health-divergence">` +
        `<span class="health-detail-label">Divergence</span> ${reason}` +
        ` <span class="health-divergence-flags">(monitor=${d.monitor_healthy ? "up" : "down"}, ` +
        `router=${d.router_available ? "up" : "down"})</span>` +
        `</div>`
    );
  }

  return parts.join("");
}

/**
 * Render the top-level divergence summary list (the `divergence` array from
 * `/api/health`), or an empty string when there are no divergences.
 */
export function renderDivergenceSummary(divergence: HubHealthDivergenceEntry[]): string {
  if (!divergence || divergence.length === 0) {
    return "";
  }
  const items = divergence
    .map((d) => {
      const server = escapeHtml(d.server?.trim() || "unknown");
      const reason = escapeHtml(d.reason?.trim() || "divergence reported");
      return `<li><span class="banner-server">${server}</span>: ${reason}</li>`;
    })
    .join("");
  return `<div class="health-banner health-banner-divergence" role="alert">
  <div class="health-banner-title">Health/router divergence</div>
  <ul class="health-banner-list">${items}</ul>
</div>`;
}
