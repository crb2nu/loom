import * as path from "path";

/** Path to the registry.yaml file relative to workspace root */
export const REGISTRY_PATH = path.join("mcp", "context", "registry.yaml");

/** Key for storing last snapshot timestamp in workspace state */
export const SNAPSHOT_STATE_KEY = "loom.lastSnapshotISO";

/** Interval for refreshing hub status (in milliseconds) */
export const HUB_REFRESH_INTERVAL_MS = 60_000;

/** Default hub WebSocket URL */
export const DEFAULT_HUB_URL = "wss://mcp.flexinfer.ai/ws";

/** Default daemon cache TTL (in milliseconds) */
export const DAEMON_CACHE_TTL_MS = 5_000;

/** Default HTTP request timeout (in milliseconds) */
export const DEFAULT_HTTP_TIMEOUT_MS = 5_000;

/** Default interval for refreshing Mills status (in milliseconds) */
export const MILLS_REFRESH_INTERVAL_MS = 60_000;
