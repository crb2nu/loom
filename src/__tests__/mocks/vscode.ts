/**
 * VS Code API mock for Vitest testing
 * This module provides mock implementations of VS Code APIs
 * to enable unit testing without the actual VS Code runtime.
 */
import { vi } from "vitest";

// Event emitter mock
export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];

  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => this.listeners.splice(this.listeners.indexOf(listener), 1) };
  };

  fire(data: T) {
    this.listeners.forEach((listener) => listener(data));
  }

  dispose() {
    this.listeners = [];
  }
}

// Disposable mock
export class Disposable {
  static from(...disposables: { dispose: () => void }[]) {
    return new Disposable(() => {
      disposables.forEach((d) => d.dispose());
    });
  }

  constructor(private callOnDispose: () => void) {}

  dispose() {
    this.callOnDispose();
  }
}

// URI mock
export class Uri {
  static file(path: string): Uri {
    return new Uri("file", "", path, "", "");
  }

  static parse(value: string): Uri {
    const url = new URL(value);
    return new Uri(url.protocol.replace(":", ""), url.host, url.pathname, url.search, url.hash);
  }

  static joinPath(base: Uri, ...pathSegments: string[]): Uri {
    const newPath = [base.path, ...pathSegments].join("/").replace(/\/+/g, "/");
    return new Uri(base.scheme, base.authority, newPath, base.query, base.fragment);
  }

  constructor(
    public readonly scheme: string,
    public readonly authority: string,
    public readonly path: string,
    public readonly query: string,
    public readonly fragment: string
  ) {}

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}${this.query}${this.fragment}`;
  }

  with(change: {
    scheme?: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment
    );
  }
}

// TreeItem mock
export class TreeItem {
  label?: string | { label: string };
  id?: string;
  iconPath?: string | Uri | { light: string | Uri; dark: string | Uri };
  description?: string | boolean;
  tooltip?: string;
  command?: { command: string; title: string; arguments?: unknown[] };
  collapsibleState?: TreeItemCollapsibleState;
  contextValue?: string;

  constructor(labelOrResourceUri: string | Uri, collapsibleState?: TreeItemCollapsibleState) {
    if (typeof labelOrResourceUri === "string") {
      this.label = labelOrResourceUri;
    }
    this.collapsibleState = collapsibleState;
  }
}

// Tree item collapsible state
export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

// Status bar alignment
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

// Configuration target
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

// File type
export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

// Output channel mock
const createOutputChannel = vi.fn((name: string) => ({
  name,
  append: vi.fn(),
  appendLine: vi.fn(),
  clear: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
}));

// Status bar item mock
const createStatusBarItem = vi.fn(() => ({
  alignment: StatusBarAlignment.Left,
  priority: 0,
  text: "",
  tooltip: "",
  color: undefined,
  backgroundColor: undefined,
  command: undefined,
  accessibilityInformation: undefined,
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
}));

// Configuration mock
const createConfiguration = () => {
  const configStore: Record<string, unknown> = {};

  return {
    get: vi.fn(<T>(section: string, defaultValue?: T): T => {
      return (configStore[section] as T) ?? (defaultValue as T);
    }),
    has: vi.fn((section: string): boolean => section in configStore),
    inspect: vi.fn(() => undefined),
    update: vi.fn(async (section: string, value: unknown) => {
      configStore[section] = value;
    }),
  };
};

// Window namespace
export const window = {
  showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
  showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
  showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
  showQuickPick: vi.fn(() => Promise.resolve(undefined)),
  showInputBox: vi.fn(() => Promise.resolve(undefined)),
  createOutputChannel,
  createStatusBarItem,
  withProgress: vi.fn(async (_options, task) => {
    return task(
      { report: vi.fn() },
      { isCancellationRequested: false, onCancellationRequested: vi.fn() }
    );
  }),
  showTextDocument: vi.fn(() => Promise.resolve(undefined)),
  createTreeView: vi.fn(() => ({
    onDidExpandElement: vi.fn(),
    onDidCollapseElement: vi.fn(),
    onDidChangeSelection: vi.fn(),
    onDidChangeVisibility: vi.fn(),
    visible: true,
    message: undefined,
    title: undefined,
    description: undefined,
    badge: undefined,
    reveal: vi.fn(),
    dispose: vi.fn(),
  })),
  registerTreeDataProvider: vi.fn(),
  activeTextEditor: undefined,
  visibleTextEditors: [],
  onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
  terminals: [],
  createTerminal: vi.fn(() => ({
    name: "test",
    processId: Promise.resolve(12345),
    sendText: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  })),
};

// Commands namespace
export const commands = {
  registerCommand: vi.fn((_command: string, _callback: () => void) => ({
    dispose: vi.fn(),
  })),
  executeCommand: vi.fn(() => Promise.resolve()),
  getCommands: vi.fn(() => Promise.resolve([])),
};

// Workspace namespace
export const workspace = {
  workspaceFolders: undefined as { uri: Uri; name: string; index: number }[] | undefined,
  getConfiguration: vi.fn((_section?: string) => createConfiguration()),
  onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
  fs: {
    readFile: vi.fn(() => Promise.resolve(Buffer.from(""))),
    writeFile: vi.fn(() => Promise.resolve()),
    stat: vi.fn(() => Promise.resolve({ type: FileType.File, ctime: 0, mtime: 0, size: 0 })),
    readDirectory: vi.fn(() => Promise.resolve([])),
    createDirectory: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
    copy: vi.fn(() => Promise.resolve()),
  },
  findFiles: vi.fn(() => Promise.resolve([])),
  openTextDocument: vi.fn(() =>
    Promise.resolve({
      getText: vi.fn(() => ""),
      lineAt: vi.fn(() => ({ text: "" })),
      lineCount: 0,
      fileName: "",
      uri: Uri.file(""),
    })
  ),
  applyEdit: vi.fn(() => Promise.resolve(true)),
};

// Extensions namespace
export const extensions = {
  getExtension: vi.fn(() => undefined),
  all: [],
  onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
};

// Env namespace
export const env = {
  appName: "Visual Studio Code",
  appRoot: "/Applications/Visual Studio Code.app",
  language: "en",
  machineId: "test-machine-id",
  sessionId: "test-session-id",
  uriScheme: "vscode",
  clipboard: {
    readText: vi.fn(() => Promise.resolve("")),
    writeText: vi.fn(() => Promise.resolve()),
  },
  openExternal: vi.fn(() => Promise.resolve(true)),
};

// Progress location
export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

// ThemeIcon mock
export class ThemeIcon {
  static readonly File = new ThemeIcon("file");
  static readonly Folder = new ThemeIcon("folder");

  constructor(
    public readonly id: string,
    public readonly color?: { id: string }
  ) {}
}

// ThemeColor mock
export class ThemeColor {
  constructor(public readonly id: string) {}
}

// MarkdownString mock
export class MarkdownString {
  value: string;
  isTrusted?: boolean;
  supportThemeIcons?: boolean;
  supportHtml?: boolean;

  constructor(value?: string, supportThemeIcons?: boolean) {
    this.value = value ?? "";
    this.supportThemeIcons = supportThemeIcons;
  }

  appendText(value: string): MarkdownString {
    this.value += value;
    return this;
  }

  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }

  appendCodeblock(value: string, language?: string): MarkdownString {
    this.value += `\n\`\`\`${language ?? ""}\n${value}\n\`\`\`\n`;
    return this;
  }
}

// Default export for module alias
export default {
  EventEmitter,
  Disposable,
  Uri,
  TreeItem,
  TreeItemCollapsibleState,
  StatusBarAlignment,
  ConfigurationTarget,
  FileType,
  ProgressLocation,
  ThemeIcon,
  ThemeColor,
  MarkdownString,
  window,
  commands,
  workspace,
  extensions,
  env,
};
