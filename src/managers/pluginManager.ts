import * as fs from "fs";
import { createRequire } from "module";
import * as path from "path";

import * as vscode from "vscode";

import { Logger } from "../utils/logger";

type PluginActivationResult = void | vscode.Disposable | vscode.Disposable[];
type PluginActivateFn = (
  api: LoomPluginApi
) => PluginActivationResult | Promise<PluginActivationResult>;

interface PluginModuleShape {
  name?: string;
  activate: PluginActivateFn;
  deactivate?: () => void | Promise<void>;
}

interface ActivePlugin {
  deactivate?: () => void | Promise<void>;
  name: string;
  disposables: vscode.Disposable[];
}

interface PluginManagerOptions {
  workspaceRoot: string;
  extensionContext: vscode.ExtensionContext;
  outputChannel: vscode.OutputChannel;
  logger: Logger;
}

interface LoomWebviewViewProviderOptions {
  webviewOptions?: {
    retainContextWhenHidden?: boolean;
  };
}

export interface LoomPluginApi {
  extensionContext: vscode.ExtensionContext;
  workspaceRoot: string;
  outputChannel: vscode.OutputChannel;
  registerCommand(command: string, callback: (...args: unknown[]) => unknown): vscode.Disposable;
  registerTreeDataProvider<T>(
    viewId: string,
    provider: vscode.TreeDataProvider<T>
  ): vscode.Disposable;
  createTreeView<T>(viewId: string, options: vscode.TreeViewOptions<T>): vscode.TreeView<T>;
  registerWebviewViewProvider(
    viewId: string,
    provider: vscode.WebviewViewProvider,
    options?: LoomWebviewViewProviderOptions
  ): vscode.Disposable;
  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions: vscode.ViewColumn | { viewColumn: vscode.ViewColumn; preserveFocus?: boolean },
    options?: vscode.WebviewPanelOptions & vscode.WebviewOptions
  ): vscode.WebviewPanel;
}

export class PluginManager implements vscode.Disposable {
  private readonly activePlugins: ActivePlugin[] = [];
  private readonly requireFromWorkspace: NodeJS.Require;

  constructor(private readonly options: PluginManagerOptions) {
    const requireAnchor = options.workspaceRoot
      ? path.join(options.workspaceRoot, ".loom-plugin-loader.cjs")
      : __filename;
    this.requireFromWorkspace = createRequire(requireAnchor);
  }

  async reloadConfiguredPlugins(pluginSpecs: string[]): Promise<void> {
    await this.unloadPlugins();

    const seen = new Set<string>();
    const normalizedSpecs = pluginSpecs
      .map((spec) => spec.trim())
      .filter((spec) => spec.length > 0);

    for (const spec of normalizedSpecs) {
      if (seen.has(spec)) {
        continue;
      }
      seen.add(spec);

      try {
        await this.loadPlugin(spec);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.logger.error(`Failed to load plugin '${spec}': ${message}`);
      }
    }

    if (this.activePlugins.length > 0) {
      this.options.logger.info(`Loaded ${this.activePlugins.length} plugin(s)`);
    }
  }

  dispose(): void {
    for (let i = this.activePlugins.length - 1; i >= 0; i -= 1) {
      const plugin = this.activePlugins[i];
      if (plugin.deactivate) {
        void Promise.resolve(plugin.deactivate()).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.options.logger.warn(`Plugin '${plugin.name}' deactivate failed: ${message}`);
        });
      }
      for (const disposable of plugin.disposables) {
        disposable.dispose();
      }
    }
    this.activePlugins.length = 0;
  }

  private async loadPlugin(spec: string): Promise<void> {
    const moduleTarget = this.resolveModuleTarget(spec);

    const resolvedPath = this.requireFromWorkspace.resolve(moduleTarget);
    delete this.requireFromWorkspace.cache[resolvedPath];

    const moduleExports = this.requireFromWorkspace(moduleTarget) as unknown;
    const plugin = this.toPluginModule(moduleExports, spec);
    const pluginName = plugin.name ?? spec;
    const pluginDisposables: vscode.Disposable[] = [];

    const api = this.createPluginApi(pluginDisposables);
    const result = await plugin.activate(api);
    this.addActivationDisposables(pluginName, pluginDisposables, result);

    this.activePlugins.push({
      name: pluginName,
      deactivate: plugin.deactivate?.bind(plugin),
      disposables: pluginDisposables,
    });

    this.options.logger.info(`Loaded plugin '${pluginName}' (${spec})`);
  }

  private async unloadPlugins(): Promise<void> {
    for (let i = this.activePlugins.length - 1; i >= 0; i -= 1) {
      const plugin = this.activePlugins[i];
      if (plugin.deactivate) {
        await plugin.deactivate();
      }
      for (const disposable of plugin.disposables) {
        disposable.dispose();
      }
    }
    this.activePlugins.length = 0;
  }

  private resolveModuleTarget(spec: string): string {
    if (path.isAbsolute(spec)) {
      if (!fs.existsSync(spec)) {
        throw new Error(`Plugin path does not exist: ${spec}`);
      }
      return spec;
    }

    if (spec.startsWith(".")) {
      const workspaceRoot = this.options.workspaceRoot || process.cwd();
      const absolutePath = path.resolve(workspaceRoot, spec);
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`Plugin path does not exist: ${absolutePath}`);
      }
      return absolutePath;
    }

    return spec;
  }

  private toPluginModule(moduleExports: unknown, spec: string): PluginModuleShape {
    const candidate = this.unwrapDefaultExport(moduleExports);
    if (typeof candidate === "function") {
      return { activate: candidate as PluginActivateFn };
    }
    if (this.isPluginModule(candidate)) {
      return candidate;
    }
    throw new Error(`Plugin '${spec}' must export a function or an object with activate(api)`);
  }

  private unwrapDefaultExport(value: unknown): unknown {
    if (typeof value === "object" && value !== null && "default" in value) {
      const maybeDefault = (value as { default?: unknown }).default;
      return maybeDefault ?? value;
    }
    return value;
  }

  private isPluginModule(value: unknown): value is PluginModuleShape {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const maybePlugin = value as { activate?: unknown };
    return typeof maybePlugin.activate === "function";
  }

  private isDisposable(value: unknown): value is vscode.Disposable {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const maybeDisposable = value as { dispose?: unknown };
    return typeof maybeDisposable.dispose === "function";
  }

  private addActivationDisposables(
    pluginName: string,
    disposables: vscode.Disposable[],
    activationResult: PluginActivationResult
  ): void {
    if (!activationResult) {
      return;
    }

    const activationDisposables = Array.isArray(activationResult)
      ? activationResult
      : [activationResult];

    for (const disposable of activationDisposables) {
      if (this.isDisposable(disposable)) {
        disposables.push(disposable);
      } else {
        this.options.logger.warn(
          `Plugin '${pluginName}' returned a non-disposable activation result`
        );
      }
    }
  }

  private createPluginApi(pluginDisposables: vscode.Disposable[]): LoomPluginApi {
    return {
      extensionContext: this.options.extensionContext,
      workspaceRoot: this.options.workspaceRoot,
      outputChannel: this.options.outputChannel,
      registerCommand: (command: string, callback: (...args: unknown[]) => unknown) => {
        const disposable = vscode.commands.registerCommand(command, (...args: unknown[]) =>
          callback(...args)
        );
        pluginDisposables.push(disposable);
        return disposable;
      },
      registerTreeDataProvider: <T>(viewId: string, provider: vscode.TreeDataProvider<T>) => {
        const disposable = vscode.window.registerTreeDataProvider(viewId, provider);
        pluginDisposables.push(disposable);
        return disposable;
      },
      createTreeView: <T>(viewId: string, options: vscode.TreeViewOptions<T>) => {
        const treeView = vscode.window.createTreeView(viewId, options);
        pluginDisposables.push(treeView);
        return treeView;
      },
      registerWebviewViewProvider: (
        viewId: string,
        provider: vscode.WebviewViewProvider,
        options?: LoomWebviewViewProviderOptions
      ) => {
        const disposable = vscode.window.registerWebviewViewProvider(viewId, provider, options);
        pluginDisposables.push(disposable);
        return disposable;
      },
      createWebviewPanel: (
        viewType: string,
        title: string,
        showOptions:
          | vscode.ViewColumn
          | {
              preserveFocus?: boolean;
              viewColumn: vscode.ViewColumn;
            },
        options?: vscode.WebviewPanelOptions & vscode.WebviewOptions
      ) => {
        const panel = vscode.window.createWebviewPanel(viewType, title, showOptions, options);
        pluginDisposables.push(panel);
        return panel;
      },
    };
  }
}
