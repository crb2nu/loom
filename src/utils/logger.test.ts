import { describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";

import { Logger } from "./logger";

function createMockChannel(): vscode.OutputChannel {
  return {
    name: "Test",
    append: vi.fn(),
    appendLine: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    replace: vi.fn(),
  } as unknown as vscode.OutputChannel;
}

describe("Logger", () => {
  it("should log info messages with timestamp", () => {
    const channel = createMockChannel();
    const logger = new Logger(channel);

    logger.info("test message");

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(channel.appendLine).toHaveBeenCalledWith(
      expect.stringMatching(/^\[.*\] INFO: test message$/)
    );
  });

  it("should include prefix when set", () => {
    const channel = createMockChannel();
    const logger = new Logger(channel, "hub");

    logger.info("connected");

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(channel.appendLine).toHaveBeenCalledWith(
      expect.stringMatching(/\[hub\] INFO: connected/)
    );
  });

  it("should respect log level filtering", () => {
    const channel = createMockChannel();
    const logger = new Logger(channel, "", "warn");

    logger.debug("should be filtered");
    logger.info("should be filtered");
    logger.warn("should appear");
    logger.error("should appear");

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(channel.appendLine).toHaveBeenCalledTimes(2);
  });

  it("should allow changing log level", () => {
    const channel = createMockChannel();
    const logger = new Logger(channel, "", "error");

    logger.warn("filtered");
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(channel.appendLine).not.toHaveBeenCalled();

    logger.setLevel("debug");
    logger.debug("now visible");
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(channel.appendLine).toHaveBeenCalledTimes(1);
  });

  describe("child", () => {
    it("should create child with combined prefix", () => {
      const channel = createMockChannel();
      const parent = new Logger(channel, "parent");
      const child = parent.child("child");

      child.info("test");

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(channel.appendLine).toHaveBeenCalledWith(
        expect.stringMatching(/\[parent:child\] INFO: test/)
      );
    });

    it("should use child prefix when parent has none", () => {
      const channel = createMockChannel();
      const parent = new Logger(channel);
      const child = parent.child("hub");

      child.info("test");

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(channel.appendLine).toHaveBeenCalledWith(expect.stringMatching(/\[hub\] INFO: test/));
    });

    it("should inherit parent log level", () => {
      const channel = createMockChannel();
      const parent = new Logger(channel, "", "error");
      const child = parent.child("sub");

      child.warn("filtered");
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(channel.appendLine).not.toHaveBeenCalled();

      child.error("visible");
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(channel.appendLine).toHaveBeenCalledTimes(1);
    });
  });

  describe("log levels", () => {
    it("should log debug messages", () => {
      const channel = createMockChannel();
      const logger = new Logger(channel, "", "debug");

      logger.debug("debug msg");

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining("DEBUG: debug msg"));
    });

    it("should log warn messages", () => {
      const channel = createMockChannel();
      const logger = new Logger(channel);

      logger.warn("warning");

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining("WARN: warning"));
    });

    it("should log error messages", () => {
      const channel = createMockChannel();
      const logger = new Logger(channel);

      logger.error("failure");

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining("ERROR: failure"));
    });
  });
});
