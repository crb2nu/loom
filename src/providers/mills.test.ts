import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

const mockRequestJson = vi.hoisted(() => vi.fn());

vi.mock("../utils/http", () => ({
  requestJson: mockRequestJson,
}));

import { MillsTreeProvider } from "./mills";

function makeChannel(): vscode.OutputChannel {
  return {
    name: "test",
    append: vi.fn(),
    appendLine: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    replace: vi.fn(),
  } as unknown as vscode.OutputChannel;
}

describe("MillsTreeProvider", () => {
  let channel: vscode.OutputChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestJson.mockReset();
    channel = makeChannel();
  });

  it("returns an unconfigured placeholder when HUD URL is empty", async () => {
    const provider = new MillsTreeProvider({ hudBaseUrl: "" }, channel);
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0].kind).toBe("placeholder");
    if (children[0].kind === "placeholder") {
      expect(children[0].label).toMatch(/not configured/i);
    }
  });

  it("returns six sections at root when configured", async () => {
    const provider = new MillsTreeProvider(
      { hudBaseUrl: "https://hud.example.com" },
      channel
    );
    const children = await provider.getChildren();
    expect(children).toHaveLength(6);
    const ids = children.map((n) => (n.kind === "section" ? n.sectionId : null));
    expect(ids).toEqual([
      "backlog",
      "pipelines",
      "council",
      "squads",
      "audit",
      "proposals",
    ]);
  });

  it("attaches an open-detail command to actionable leaves", async () => {
    mockRequestJson.mockResolvedValue([
      { ID: "MILLS-1", Title: "x", State: "queued" },
    ]);
    const provider = new MillsTreeProvider(
      { hudBaseUrl: "https://hud.example.com" },
      channel
    );
    const sections = await provider.getChildren();
    const backlog = sections.find((s) => s.kind === "section" && s.sectionId === "backlog");
    const leaves = await provider.getChildren(backlog);
    const item = provider.getTreeItem(leaves[0]);
    expect(item.command).toBeDefined();
    expect(item.command?.command).toBe("loom.openMillsDetail");
    expect(item.command?.arguments).toEqual([{ kind: "backlog", id: "MILLS-1" }]);
  });

  it("does not attach a command to squad leaves (no detail endpoint)", async () => {
    mockRequestJson.mockResolvedValue([{ Name: "alpha" }]);
    const provider = new MillsTreeProvider(
      { hudBaseUrl: "https://hud.example.com" },
      channel
    );
    const sections = await provider.getChildren();
    const squads = sections.find((s) => s.kind === "section" && s.sectionId === "squads");
    const leaves = await provider.getChildren(squads);
    const item = provider.getTreeItem(leaves[0]);
    expect(item.command).toBeUndefined();
  });

  it("each section's getTreeItem returns a Collapsed item", async () => {
    const provider = new MillsTreeProvider(
      { hudBaseUrl: "https://hud.example.com" },
      channel
    );
    const sections = await provider.getChildren();
    for (const node of sections) {
      const item = provider.getTreeItem(node);
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    }
  });

  it("expanding the backlog section fetches and caches results", async () => {
    mockRequestJson.mockResolvedValue([
      { ID: "MILLS-1", Title: "First", State: "queued", Priority: "P2" },
      { ID: "MILLS-2", Title: "Second", State: "running" },
    ]);
    const provider = new MillsTreeProvider(
      { hudBaseUrl: "https://hud.example.com" },
      channel
    );

    const sections = await provider.getChildren();
    const backlogSection = sections.find((s) => s.kind === "section" && s.sectionId === "backlog");
    expect(backlogSection).toBeDefined();

    const leaves = await provider.getChildren(backlogSection);
    expect(leaves).toHaveLength(2);
    expect(leaves[0].kind).toBe("leaf");
    if (leaves[0].kind === "leaf") {
      expect(leaves[0].leaf.label).toBe("MILLS-1");
      expect(leaves[0].leaf.description).toContain("queued");
      expect(leaves[0].leaf.description).toContain("First");
    }

    // Second call should not refetch (cached)
    expect(mockRequestJson).toHaveBeenCalledTimes(1);
    await provider.getChildren(backlogSection);
    expect(mockRequestJson).toHaveBeenCalledTimes(1);
  });

  it("renders an info placeholder for empty sections", async () => {
    mockRequestJson.mockResolvedValue([]);
    const provider = new MillsTreeProvider(
      { hudBaseUrl: "https://hud.example.com" },
      channel
    );
    const sections = await provider.getChildren();
    const audit = sections.find((s) => s.kind === "section" && s.sectionId === "audit");
    const leaves = await provider.getChildren(audit);
    expect(leaves).toHaveLength(1);
    expect(leaves[0].kind).toBe("placeholder");
    if (leaves[0].kind === "placeholder") {
      expect(leaves[0].iconId).toBe("info");
    }
  });

  it("renders an error placeholder when fetch fails", async () => {
    mockRequestJson.mockRejectedValue(new Error("ECONNREFUSED"));
    const provider = new MillsTreeProvider(
      { hudBaseUrl: "https://hud.example.com" },
      channel
    );
    const sections = await provider.getChildren();
    const pipelines = sections.find((s) => s.kind === "section" && s.sectionId === "pipelines");
    const leaves = await provider.getChildren(pipelines);
    expect(leaves).toHaveLength(1);
    expect(leaves[0].kind).toBe("placeholder");
    if (leaves[0].kind === "placeholder") {
      expect(leaves[0].label).toMatch(/Error/);
      expect(leaves[0].iconId).toBe("error");
    }
  });

  it("refresh() invalidates cached state and triggers re-fetch", async () => {
    mockRequestJson.mockResolvedValue([{ ID: "MILLS-1" }]);
    const provider = new MillsTreeProvider(
      { hudBaseUrl: "https://hud.example.com" },
      channel
    );
    const sections = await provider.getChildren();
    const backlog = sections.find((s) => s.kind === "section" && s.sectionId === "backlog");
    await provider.getChildren(backlog);
    expect(mockRequestJson).toHaveBeenCalledTimes(1);

    provider.refresh();

    const sectionsAfter = await provider.getChildren();
    const backlogAfter = sectionsAfter.find(
      (s) => s.kind === "section" && s.sectionId === "backlog"
    );
    await provider.getChildren(backlogAfter);
    expect(mockRequestJson).toHaveBeenCalledTimes(2);
  });

  it("updateSettings switches HUD URL and clears cache", async () => {
    mockRequestJson.mockResolvedValue([{ ID: "MILLS-1" }]);
    const provider = new MillsTreeProvider(
      { hudBaseUrl: "https://hud-old.example.com" },
      channel
    );
    let sections = await provider.getChildren();
    const backlog = sections.find((s) => s.kind === "section" && s.sectionId === "backlog");
    await provider.getChildren(backlog);
    expect(mockRequestJson).toHaveBeenCalledWith(
      "https://hud-old.example.com/api/mills/backlog",
      expect.any(Object)
    );

    provider.updateSettings({ hudBaseUrl: "https://hud-new.example.com" });

    sections = await provider.getChildren();
    const newBacklog = sections.find((s) => s.kind === "section" && s.sectionId === "backlog");
    await provider.getChildren(newBacklog);
    expect(mockRequestJson).toHaveBeenLastCalledWith(
      "https://hud-new.example.com/api/mills/backlog",
      expect.any(Object)
    );
  });
});
