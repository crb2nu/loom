import { postJson, requestJson } from "../utils/http";

/**
 * A synthesized weaver query routes through one or more sub-agent models
 * and can take far longer than a read-only status/history GET. Use a
 * generous timeout so slow multi-domain dispatch isn't cut off by the
 * 5s default in DEFAULT_HTTP_TIMEOUT_MS.
 */
const WEAVER_QUERY_TIMEOUT_MS = 120_000;

/**
 * Read-only client for the Loom HUD's weaver + aimodels REST surfaces.
 * Consumed by the WeaverTreeProvider to populate the sidebar without
 * the extension needing to talk to the daemon socket directly.
 *
 * See services/loom-core/.loom/111-product-spec-weaver-qwen3-integration-2026-05-08.md
 * (VSC-001..VSC-003).
 */

/** Settings shared with the Mills client; intentionally identical so
 * the extension only stores one HUD URL + CF Access creds.
 */
export interface WeaverSettings {
  hudBaseUrl: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

/** GET /api/weaver/status — extended in S4 with preflight fields. */
export interface WeaverStatusResponse {
  enabled: boolean;
  router_model?: string;
  subagent_model?: string;
  domains?: WeaverDomainSummary[];
  // Preflight (S4)
  degraded?: boolean;
  missing_models?: string[];
  ready_models?: string[];
  catalog_size?: number;
  catalog_error?: string;
  preflight_at?: string;
  [key: string]: unknown;
}

export interface WeaverDomainSummary {
  name: string;
  description?: string;
  tools?: string[];
  model?: string;
  backend?: string;
  [key: string]: unknown;
}

export interface WeaverHistoryEntry {
  query_id?: string;
  query?: string;
  status?: string;
  latency_ms?: number;
  total_tokens?: number;
  domains_used?: string[];
  parent_session_id?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface WeaverHistoryResponse {
  entries?: WeaverHistoryEntry[];
}

export interface WeaverMetricsResponse {
  total_queries?: number;
  avg_latency_ms?: number;
  error_rate?: number;
  total_tokens?: number;
  error_count?: number;
}

/**
 * Request body for POST /api/weaver/query. Mirrors the HUD handler's
 * params struct (internal/hud/domain/weaver/handlers.go handleQuery):
 * only `query` is required; the rest are optional routing hints.
 */
export interface WeaverQueryRequest {
  query: string;
  domains?: string[];
  max_tokens?: number;
  agent_id?: string;
  session_id?: string;
  parent_session_id?: string;
}

/**
 * Response body for POST /api/weaver/query. Mirrors pkg/weaver.QueryResult
 * (services/loom-core/pkg/weaver/router.go), surfaced verbatim by the HUD.
 * `query_id` / `status` are not part of QueryResult (they live on history
 * entries) but are typed optional in case the daemon enriches the payload.
 */
export interface WeaverQueryResponse {
  answer?: string;
  domain_results?: WeaverDomainResult[];
  total_tokens?: number;
  latency_ms?: number;
  domains_used?: string[];
  query_id?: string;
  status?: string;
  [key: string]: unknown;
}

export interface WeaverDomainResult {
  domain?: string;
  answer?: string;
  tokens?: number;
  [key: string]: unknown;
}

export interface AIModelsRoleEntry {
  role: string;
  primary: string;
  fallbacks?: string[];
}

export interface AIModelsRolesResponse {
  roles: AIModelsRoleEntry[];
  override_path?: string;
}

/**
 * WeaverClient: thin REST wrapper. All methods return `null` when the
 * configured `hudBaseUrl` is empty (matches MillsClient convention).
 */
export class WeaverClient {
  constructor(private readonly settings: WeaverSettings) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.settings.cfAccessClientId) {
      h["CF-Access-Client-Id"] = this.settings.cfAccessClientId;
    }
    if (this.settings.cfAccessClientSecret) {
      h["CF-Access-Client-Secret"] = this.settings.cfAccessClientSecret;
    }
    return h;
  }

  private url(path: string): string | null {
    if (!this.settings.hudBaseUrl) {
      return null;
    }
    return `${this.settings.hudBaseUrl.replace(/\/$/, "")}${path}`;
  }

  async status(): Promise<WeaverStatusResponse | null> {
    const u = this.url("/api/weaver/status");
    if (!u) return null;
    return requestJson<WeaverStatusResponse>(u, this.headers());
  }

  async history(): Promise<WeaverHistoryResponse | null> {
    const u = this.url("/api/weaver/history");
    if (!u) return null;
    return requestJson<WeaverHistoryResponse>(u, this.headers());
  }

  async metrics(): Promise<WeaverMetricsResponse | null> {
    const u = this.url("/api/weaver/metrics");
    if (!u) return null;
    return requestJson<WeaverMetricsResponse>(u, this.headers());
  }

  async roles(): Promise<AIModelsRolesResponse | null> {
    const u = this.url("/api/aimodels/roles");
    if (!u) return null;
    return requestJson<AIModelsRolesResponse>(u, this.headers());
  }

  /**
   * Submit a synthesized query via POST /api/weaver/query. Returns `null`
   * when `hudBaseUrl` is empty (matching the read-only methods above).
   * Rejects on HTTP errors (e.g. weaver disabled/degraded, missing model,
   * network failure) so callers can surface the failure to the user.
   */
  async query(request: WeaverQueryRequest): Promise<WeaverQueryResponse | null> {
    const u = this.url("/api/weaver/query");
    if (!u) return null;
    return postJson<WeaverQueryResponse>(u, request, this.headers(), WEAVER_QUERY_TIMEOUT_MS);
  }
}
