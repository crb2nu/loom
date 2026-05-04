import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

import { MillsTokenStore } from "./millsToken";

function makeSecrets(): vscode.SecretStorage {
  const store = new Map<string, string>();
  return {
    get: vi.fn((k: string) => Promise.resolve(store.get(k))),
    store: vi.fn((k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve();
    }),
    delete: vi.fn((k: string) => {
      store.delete(k);
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve(Array.from(store.keys()))),
    onDidChange: vi.fn() as unknown as vscode.Event<vscode.SecretStorageChangeEvent>,
  } as unknown as vscode.SecretStorage;
}

describe("MillsTokenStore", () => {
  let secrets: vscode.SecretStorage;
  let tokens: MillsTokenStore;

  beforeEach(() => {
    secrets = makeSecrets();
    tokens = new MillsTokenStore(secrets);
  });

  it("stores and retrieves a token", async () => {
    await tokens.set("abc");
    expect(await tokens.get()).toBe("abc");
  });

  it("clears the token", async () => {
    await tokens.set("abc");
    await tokens.clear();
    expect(await tokens.get()).toBeUndefined();
  });

  it("ensure() returns existing token without prompting", async () => {
    await tokens.set("abc");
    const showInputBoxSpy = vi.spyOn(vscode.window, "showInputBox");
    const result = await tokens.ensure("title");
    expect(result).toBe("abc");
    expect(showInputBoxSpy).not.toHaveBeenCalled();
  });

  it("ensure() prompts and stores when no token exists", async () => {
    const showInputBoxSpy = vi
      .spyOn(vscode.window, "showInputBox")
      .mockResolvedValue("entered-token");
    const result = await tokens.ensure("title");
    expect(result).toBe("entered-token");
    expect(showInputBoxSpy).toHaveBeenCalledWith(
      expect.objectContaining({ password: true, ignoreFocusOut: true })
    );
    expect(await tokens.get()).toBe("entered-token");
  });

  it("ensure() returns undefined when user cancels prompt", async () => {
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(undefined);
    const result = await tokens.ensure("title");
    expect(result).toBeUndefined();
  });
});
