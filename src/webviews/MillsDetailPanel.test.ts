import { describe, it, expect } from "vitest";

import { escapeHtml, renderBody } from "./MillsDetailPanel";

describe("escapeHtml", () => {
  it("escapes the five special HTML characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"
    );
  });

  it("returns identity for plain text", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("renderBody", () => {
  it("shows loading placeholder while fetching", () => {
    const html = renderBody({
      subject: { kind: "council", id: "abc" },
      loading: true,
    });
    expect(html).toContain("Loading");
  });

  it("shows escaped error message on failure", () => {
    const html = renderBody({
      subject: { kind: "pipeline", id: "p1" },
      loading: false,
      error: '500 <script>alert("xss")</script>',
    });
    expect(html).toContain("Error:");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("renders backlog fields and a raw payload section", () => {
    const html = renderBody({
      subject: { kind: "backlog", id: "MILLS-1" },
      loading: false,
      payload: {
        ID: "MILLS-1",
        Title: "Add OAuth",
        State: "queued",
        Priority: "P1",
        Labels: ["security", "auth"],
      },
    });
    expect(html).toContain("Add OAuth");
    expect(html).toContain("queued");
    expect(html).toContain("P1");
    expect(html).toContain("security, auth");
    expect(html).toContain("Raw payload");
  });

  it("renders council run including total cost", () => {
    const html = renderBody({
      subject: { kind: "council", id: "c-1" },
      loading: false,
      payload: {
        ID: "c-1",
        Trigger: "manual",
        Outcome: "success",
        CostFrontierUSD: 1.5,
        CostLocalUSD: 0.25,
      },
    });
    expect(html).toContain("manual");
    expect(html).toContain("success");
    expect(html).toContain("$1.75");
  });

  it("renders pipeline run with MR reference", () => {
    const html = renderBody({
      subject: { kind: "pipeline", id: "p-1" },
      loading: false,
      payload: {
        ID: "p-1",
        BacklogID: "MILLS-2",
        State: "implementing",
        MRIID: 42,
        CostUSD: 3.21,
      },
    });
    expect(html).toContain("implementing");
    expect(html).toContain("!42");
    expect(html).toContain("$3.21");
  });

  it("renders policy proposal diff when present", () => {
    const html = renderBody({
      subject: { kind: "policy-proposal", id: "prop-1" },
      loading: false,
      payload: {
        ID: "prop-1",
        Status: "pending",
        Reason: "Reduce ensemble size",
        Diff: "- ensemble: [a, b, c]\n+ ensemble: [a, b]",
      },
    });
    expect(html).toContain("pending");
    expect(html).toContain("Reduce ensemble size");
    expect(html).toContain("Diff");
    expect(html).toContain("ensemble");
  });

  it("renders empty placeholder for null payload", () => {
    const html = renderBody({
      subject: { kind: "audit", id: "1" },
      loading: false,
      payload: null,
    });
    expect(html).toContain("No content");
  });
});
