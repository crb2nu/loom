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

  it("renders a cross-repo run with its nested repos", () => {
    const html = renderBody({
      subject: { kind: "cross-repo", id: "cr-1" },
      loading: false,
      payload: {
        id: "cr-1",
        backlog_item_id: "MILLS-3",
        state: "gates_green",
        atomicity_strategy: "all_or_nothing",
        repos: [{ repo_name: "loom", branch: "feat/x", mr_iid: 7, ci_status: "passed" }],
      },
    });
    expect(html).toContain("gates_green");
    expect(html).toContain("Repos (1)");
    expect(html).toContain("feat/x");
    expect(html).toContain("!7");
  });

  it("renders a workflow run with its steps", () => {
    const html = renderBody({
      subject: { kind: "workflow", id: "wf-1" },
      loading: false,
      payload: {
        run: { id: "wf-1", engine: "imperative", state: "succeeded", step_count: 2, cost_usd: 1.5 },
        steps: [{ step_key: "plan", status: "success", badge: "cache_hit", effect_count: 0 }],
      },
    });
    expect(html).toContain("succeeded");
    expect(html).toContain("$1.50");
    expect(html).toContain("Steps (1)");
    expect(html).toContain("cache_hit");
  });

  it("renders a workflow run with no steps without throwing", () => {
    const html = renderBody({
      subject: { kind: "workflow", id: "wf-2" },
      loading: false,
      payload: { run: { id: "wf-2", state: "running" }, steps: [] },
    });
    expect(html).toContain("running");
    expect(html).toContain("No journaled steps");
  });

  it("renders a cost preview with the capped flag and source", () => {
    const html = renderBody({
      subject: { kind: "cost-preview", id: "MILLS-4" },
      loading: false,
      payload: {
        backlog_id: "MILLS-4",
        path_class: "feature",
        estimate_usd: 4.2,
        ensemble_cap_usd: 5,
        capped_by_policy: false,
        confidence: "medium",
        sample_size: 12,
        source: "estimator/v1",
      },
    });
    expect(html).toContain("$4.20");
    expect(html).toContain("feature");
    expect(html).toContain("medium");
    expect(html).toContain("estimator/v1");
  });

  it("renders an eval score with its breakdown", () => {
    const html = renderBody({
      subject: { kind: "eval", id: "9" },
      loading: false,
      payload: {
        ID: 9,
        SubjectKind: "council_artifact",
        Rubric: "default",
        Score: 0.87,
        Breakdown: { clarity: 0.9 },
        JudgedBy: "auditor-a",
      },
    });
    expect(html).toContain("council_artifact");
    expect(html).toContain("0.87");
    expect(html).toContain("Breakdown");
    expect(html).toContain("clarity");
  });

  it("renders squad memory rows", () => {
    const html = renderBody({
      subject: { kind: "squad-memory", id: "alpha" },
      loading: false,
      payload: [
        { ID: 1, Title: "pattern X works", Kind: "lesson", Importance: 0.8, Refs: ["MR!12"] },
      ],
    });
    expect(html).toContain("pattern X works");
    expect(html).toContain("lesson");
    expect(html).toContain("MR!12");
  });

  it("renders an empty-state for a squad with no memory (200-empty)", () => {
    const html = renderBody({
      subject: { kind: "squad-memory", id: "alpha" },
      loading: false,
      payload: [],
    });
    expect(html).toContain("No working-memory entries");
  });

  it("renders squad outcomes rows", () => {
    const html = renderBody({
      subject: { kind: "squad-outcomes", id: "alpha" },
      loading: false,
      payload: [
        { ID: 1, Outcome: "merged_clean", PathClass: "feature", CostUSD: 2.5, DurationSeconds: 90 },
      ],
    });
    expect(html).toContain("merged_clean");
    expect(html).toContain("$2.50");
    expect(html).toContain("90s");
  });

  it("renders an empty-state for a squad with no outcomes", () => {
    const html = renderBody({
      subject: { kind: "squad-outcomes", id: "alpha" },
      loading: false,
      payload: [],
    });
    expect(html).toContain("No recorded outcomes");
  });
});
