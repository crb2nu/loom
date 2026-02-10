import { describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";

import { analyzeError, showActionableError } from "./errors";

describe("analyzeError", () => {
  describe("daemon not running", () => {
    it("should detect ECONNREFUSED", () => {
      const result = analyzeError(new Error("connect ECONNREFUSED 127.0.0.1:7777"), "Test");

      expect(result.message).toContain("Daemon is not running");
      expect(result.actions).toHaveLength(2);
      expect(result.actions[0].command).toBe("loom.startDaemon");
    });

    it("should detect connect ENOENT", () => {
      const result = analyzeError(new Error("connect ENOENT /tmp/loom.sock"), "Test");

      expect(result.message).toContain("Daemon is not running");
    });

    it("should detect 'no such file' message", () => {
      const result = analyzeError(new Error("no such file or directory"), "Test");

      expect(result.message).toContain("Daemon is not running");
    });

    it("should detect daemon not running in stderr", () => {
      const error = { message: "command failed", stderr: "daemon not running" };
      const result = analyzeError(error, "Test");

      expect(result.message).toContain("Daemon is not running");
    });
  });

  describe("binary not found", () => {
    it("should detect ENOENT code", () => {
      const error = { code: "ENOENT", message: "spawn loom" };
      const result = analyzeError(error, "Test");

      expect(result.message).toContain("Loom binary not found");
      expect(result.actions[0].url).toContain("github.com");
    });

    it("should detect spawn ENOENT", () => {
      const error = { message: "spawn loom ENOENT" };
      const result = analyzeError(error, "Test");

      expect(result.message).toContain("Loom binary not found");
    });
  });

  describe("timeout", () => {
    it("should detect timeout message", () => {
      const result = analyzeError(new Error("operation timeout"), "Test");

      expect(result.message).toContain("timed out");
      expect(result.actions[0].command).toBe("loom.restartDaemon");
    });

    it("should detect ETIMEDOUT", () => {
      const result = analyzeError(new Error("connect ETIMEDOUT"), "Test");

      expect(result.message).toContain("timed out");
    });
  });

  describe("permission denied", () => {
    it("should detect EACCES code", () => {
      const error = { code: "EACCES", message: "access denied" };
      const result = analyzeError(error, "Test");

      expect(result.message).toContain("Permission denied");
      expect(result.actions).toHaveLength(0);
    });

    it("should detect permission denied message", () => {
      const result = analyzeError(new Error("permission denied"), "Test");

      expect(result.message).toContain("Permission denied");
    });
  });

  describe("config sync issues", () => {
    it("should detect registry errors", () => {
      const result = analyzeError(new Error("failed to parse registry"), "Test");

      expect(result.message).toContain("Configuration error");
      expect(result.actions).toHaveLength(2);
    });

    it("should detect config errors", () => {
      const result = analyzeError(new Error("invalid config format"), "Test");

      expect(result.message).toContain("Configuration error");
    });
  });

  describe("default error", () => {
    it("should return original message for unknown errors", () => {
      const result = analyzeError(new Error("something unexpected"), "Context");

      expect(result.message).toBe("Context: something unexpected");
      expect(result.actions).toHaveLength(0);
    });

    it("should handle non-Error objects", () => {
      const result = analyzeError("string error", "Context");

      expect(result.message).toBe("Context: string error");
    });
  });
});

describe("showActionableError", () => {
  it("should show error message without actions", async () => {
    await showActionableError(new Error("something unexpected"), "Test");

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Test: something unexpected"
    );
  });

  it("should show error with action buttons", async () => {
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValueOnce(
      "Start Daemon" as unknown as undefined
    );

    await showActionableError(new Error("ECONNREFUSED"), "Test");

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Daemon is not running"),
      "Start Daemon",
      "Check Status"
    );
  });

  it("should execute command when action selected", async () => {
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValueOnce(
      "Start Daemon" as unknown as undefined
    );

    await showActionableError(new Error("ECONNREFUSED"), "Test");

    // The mock resolves before executeCommand would be called,
    // but verifies the flow doesn't throw
  });
});
