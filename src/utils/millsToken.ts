import * as vscode from "vscode";

const SECRET_KEY = "loom.mills.adminToken";

/**
 * SecretStorage-backed accessor for the Mills HUD admin token.
 * The token never goes into VS Code settings (which sync to other machines).
 */
export class MillsTokenStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  get(): Thenable<string | undefined> {
    return this.secrets.get(SECRET_KEY);
  }

  set(token: string): Thenable<void> {
    return this.secrets.store(SECRET_KEY, token);
  }

  clear(): Thenable<void> {
    return this.secrets.delete(SECRET_KEY);
  }

  /**
   * Resolve a token, prompting the user for one if not already stored.
   * Returns undefined if the user cancels the prompt.
   */
  async ensure(promptTitle: string): Promise<string | undefined> {
    const existing = await this.get();
    if (existing) return existing;
    const entered = await vscode.window.showInputBox({
      title: promptTitle,
      prompt: "Mills HUD admin token (stored securely in VS Code SecretStorage)",
      password: true,
      ignoreFocusOut: true,
    });
    if (!entered) return undefined;
    await this.set(entered);
    return entered;
  }
}
