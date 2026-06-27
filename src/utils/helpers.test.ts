import { describe, it, expect, vi, afterEach } from "vitest";

import {
  buildServerTooltip,
  formatArgs,
  formatNameList,
  formatSnapshotLabel,
  formatSyncStatus,
  getPythonExecutable,
  getStatusIcon,
} from "./helpers";

describe("helpers", () => {
  afterEach(() => {
    delete process.env.CM_PYTHON_EXECUTABLE;
    vi.restoreAllMocks();
  });

  it("formats args with quoting for whitespace values", () => {
    expect(formatArgs(["hello world", 42, true, "plain"])).toBe('"hello world" 42 true plain');
    expect(formatArgs([])).toBe("");
    expect(formatArgs(undefined)).toBe("");
  });

  it("formats name lists with truncation", () => {
    expect(formatNameList([])).toBe("none");
    expect(formatNameList(["a", "b"], 3)).toBe("a, b");
    expect(formatNameList(["a", "b", "c", "d"], 2)).toBe("a, b +2 more");
  });

  it("returns icons and status labels for sync state", () => {
    expect(getStatusIcon("synced")).toBe("$(check)");
    expect(getStatusIcon("out-of-sync")).toBe("$(warning)");
    expect(getStatusIcon("no-generated")).toBe("$(question)");
    expect(getStatusIcon("unknown")).toBe("$(circle-outline)");

    expect(formatSyncStatus("synced")).toBe("MCP configs in sync");
    expect(formatSyncStatus("out-of-sync")).toBe("MCP configs out of sync");
    expect(formatSyncStatus("no-generated")).toBe("No generated config");
    expect(formatSyncStatus("unknown")).toBe("Config sync unknown");
  });

  it("formats snapshot labels and empty snapshot state", () => {
    const dateSpy = vi.spyOn(Date.prototype, "toLocaleDateString").mockReturnValue("1/1/2026");
    const timeSpy = vi.spyOn(Date.prototype, "toLocaleTimeString").mockReturnValue("12:34:56 PM");

    expect(formatSnapshotLabel()).toBe("No snapshot recorded");
    expect(formatSnapshotLabel("2026-01-01T17:34:56.000Z")).toBe("Last: 1/1/2026 12:34:56 PM");

    expect(dateSpy).toHaveBeenCalled();
    expect(timeSpy).toHaveBeenCalled();
  });

  it("resolves python executable from env or default", () => {
    expect(getPythonExecutable()).toBe("python3");
    process.env.CM_PYTHON_EXECUTABLE = "/opt/homebrew/bin/python";
    expect(getPythonExecutable()).toBe("/opt/homebrew/bin/python");
  });

  it("builds server tooltip with optional sections", () => {
    const tooltip = buildServerTooltip(
      "qdrant",
      {
        description: "Vector database",
        command: "loom",
        args: ["mcp-qdrant", "--serve", "localhost 6333"],
        env: { QDRANT_API_KEY: "${keychain:QDRANT_API_KEY}" },
        timeout: 5000,
        always_allow: ["qdrant_search", "qdrant_scroll"],
      },
      ["database", "search"]
    );

    expect(tooltip).toContain("**qdrant**");
    expect(tooltip).toContain("Vector database");
    expect(tooltip).toContain("Categories: database, search");
    expect(tooltip).toContain('Command: `loom mcp-qdrant --serve "localhost 6333"`');
    expect(tooltip).toContain("Env: QDRANT_API_KEY");
    expect(tooltip).toContain("Timeout: 5000ms");
    expect(tooltip).toContain("Auto-approve: qdrant_search, qdrant_scroll");
  });
});
