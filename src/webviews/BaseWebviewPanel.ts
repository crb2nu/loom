import { Disposable, WebviewPanel, Uri, Webview } from "vscode";

/**
 * Abstract base class for webview panels in the Loom extension.
 * Provides common lifecycle management, disposal, and message handling patterns.
 *
 * Subclasses must implement:
 * - getHtmlForWebview(): Generate the webview HTML content
 * - handleMessage(): Handle messages from the webview
 * - Static render(): Create or reveal the panel (signature varies per panel)
 *
 * Example usage:
 * ```typescript
 * export class MyPanel extends BaseWebviewPanel {
 *   public static currentPanel: MyPanel | undefined;
 *
 *   public static render(extensionUri: Uri): MyPanel {
 *     if (MyPanel.currentPanel) {
 *       MyPanel.currentPanel.reveal();
 *       return MyPanel.currentPanel;
 *     }
 *     const panel = window.createWebviewPanel(...);
 *     MyPanel.currentPanel = new MyPanel(panel, extensionUri);
 *     return MyPanel.currentPanel;
 *   }
 *
 *   protected getHtmlForWebview(webview: Webview): string { ... }
 *   protected handleMessage(message: unknown): void { ... }
 *   protected onDispose(): void {
 *     MyPanel.currentPanel = undefined;
 *   }
 * }
 * ```
 */
export abstract class BaseWebviewPanel {
  protected readonly panel: WebviewPanel;
  protected readonly extensionUri: Uri;
  protected readonly disposables: Disposable[] = [];

  protected constructor(panel: WebviewPanel, extensionUri: Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    // Set initial HTML content
    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

    // Listen for panel disposal
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleMessage(message),
      null,
      this.disposables
    );
  }

  /**
   * Reveal the panel in the given column.
   */
  public reveal(viewColumn?: number): void {
    this.panel.reveal(viewColumn);
  }

  /**
   * Post a message to the webview.
   */
  protected postMessage(message: unknown): Thenable<boolean> {
    return this.panel.webview.postMessage(message);
  }

  /**
   * Dispose the panel and clean up resources.
   * Subclasses should override onDispose() for custom cleanup.
   */
  public dispose(): void {
    // Call subclass cleanup first
    this.onDispose();

    // Dispose the panel
    this.panel.dispose();

    // Dispose all registered disposables
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  /**
   * Generate the HTML content for the webview.
   * Subclasses must implement this method.
   */
  protected abstract getHtmlForWebview(webview: Webview): string;

  /**
   * Handle messages received from the webview.
   * Subclasses must implement this method.
   */
  protected abstract handleMessage(message: unknown): void;

  /**
   * Called during dispose before panel cleanup.
   * Subclasses should override to clear static currentPanel and perform custom cleanup.
   */
  protected abstract onDispose(): void;

  /**
   * Helper to generate a standard Content Security Policy meta tag.
   * @param webview The webview to generate CSP for
   * @param additionalSources Optional additional script sources (e.g., CDN URLs)
   */
  protected generateCsp(webview: Webview, additionalSources: string[] = []): string {
    const scriptSources = [webview.cspSource, "'unsafe-inline'", ...additionalSources].join(" ");
    return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scriptSources}; style-src ${webview.cspSource} 'unsafe-inline';">`;
  }

  /**
   * Helper to generate standard VS Code webview styles.
   */
  protected getBaseStyles(): string {
    return `
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        padding: 20px;
        background-color: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        font-family: var(--vscode-font-family);
      }
      h1 {
        margin: 0 0 20px 0;
        font-size: 24px;
        font-weight: 600;
      }
      .btn {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        padding: 6px 12px;
        cursor: pointer;
        border-radius: 3px;
        font-size: 12px;
      }
      .btn:hover {
        background-color: var(--vscode-button-hoverBackground);
      }
      .btn-secondary {
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }
      .btn-secondary:hover {
        background-color: var(--vscode-button-secondaryHoverBackground);
      }
      .card {
        background: var(--vscode-editorWidget-background);
        border: 1px solid var(--vscode-editorWidget-border);
        border-radius: 8px;
        padding: 16px;
      }
    `;
  }
}
