import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { Logger } from "../utils/logger";

import { PluginManager } from "./pluginManager";

describe("PluginManager", () => {
  let manager: PluginManager | undefined;
  let tempRoot: string;
  let outputChannel: vscode.OutputChannel;
  let appendLineSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loom-plugin-manager-"));
    appendLineSpy = vi.fn();
    outputChannel = {
      name: "Test",
      append: vi.fn(),
      appendLine: appendLineSpy,
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      replace: vi.fn(),
    };
    (globalThis as Record<string, unknown>).__loomPluginDeactivateCount = 0;
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    fs.rmSync(tempRoot, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>).__loomPluginDeactivateCount;
  });

  function writePlugin(name: string, source: string): string {
    const filePath = path.join(tempRoot, name);
    fs.writeFileSync(filePath, source, "utf8");
    return filePath;
  }

  function createManager(): PluginManager {
    const extensionContext = {
      subscriptions: [],
      extensionUri: vscode.Uri.file(tempRoot),
    } as unknown as vscode.ExtensionContext;

    return new PluginManager({
      workspaceRoot: tempRoot,
      extensionContext,
      outputChannel,
      logger: new Logger(outputChannel, "PluginsTest"),
    });
  }

  it("loads plugin from relative path and registers commands", async () => {
    writePlugin(
      "command-plugin.cjs",
      `
module.exports = {
  name: "command-plugin",
  activate(api) {
    api.registerCommand("loom.plugin.hello", () => "ok");
  }
};
`.trim()
    );

    manager = createManager();
    await manager.reloadConfiguredPlugins(["./command-plugin.cjs"]);

    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      "loom.plugin.hello",
      expect.any(Function)
    );
  });

  it("logs and skips plugins with invalid exports", async () => {
    writePlugin(
      "invalid-plugin.cjs",
      `
module.exports = {
  notActivate: true
};
`.trim()
    );

    manager = createManager();
    await manager.reloadConfiguredPlugins(["./invalid-plugin.cjs"]);

    expect(vscode.commands.registerCommand).not.toHaveBeenCalled();
    expect(appendLineSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load plugin './invalid-plugin.cjs'")
    );
  });

  it("disposes and deactivates plugins on reload", async () => {
    writePlugin(
      "lifecycle-plugin.cjs",
      `
module.exports = {
  activate(api) {
    api.registerCommand("loom.plugin.lifecycle", () => undefined);
  },
  deactivate() {
    globalThis.__loomPluginDeactivateCount = (globalThis.__loomPluginDeactivateCount || 0) + 1;
  }
};
`.trim()
    );

    const disposeSpy = vi.fn();
    const commandDisposable = { dispose: disposeSpy } as unknown as vscode.Disposable;
    vi.mocked(vscode.commands.registerCommand).mockReturnValue(commandDisposable);

    manager = createManager();
    await manager.reloadConfiguredPlugins(["./lifecycle-plugin.cjs"]);
    await manager.reloadConfiguredPlugins([]);

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect((globalThis as Record<string, unknown>).__loomPluginDeactivateCount).toBe(1);
  });
});
