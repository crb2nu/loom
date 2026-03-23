import { describe, expect, it } from "vitest";

import {
  formatOnboardingProfileName,
  selectOnboardingProfile,
  summarizeOnboardingProfile,
} from "./OnboardingPanel";

describe("OnboardingPanel profile helpers", () => {
  it("formats live loom-core profile names for onboarding cards", () => {
    expect(formatOnboardingProfileName("ops-team")).toBe("Ops Team");
    expect(formatOnboardingProfileName("release_management")).toBe("Release Management");
  });

  it("summarizes live profile metadata for onboarding cards", () => {
    expect(
      summarizeOnboardingProfile({
        name: "ops-team",
        description: "Cluster and release operations",
        maxTools: 75,
        servers: ["mcp-k8s-apps-k3s", "mcp-gitlab", "mcp-prometheus"],
        categories: ["operations", "release-management", "monitoring"],
      })
    ).toEqual([
      "Max 75 tools",
      "3 explicit server routes",
      "Categories: Operations, Release Management, Monitoring",
    ]);
  });

  it("falls back to the live active profile when the saved setting no longer exists", () => {
    expect(
      selectOnboardingProfile("ghost", "ops-team", [
        {
          name: "ops-team",
          description: "Cluster and release operations",
          servers: "*",
        },
        {
          name: "full",
          description: "All available tools with smart prioritization",
          servers: "*",
        },
      ])
    ).toBe("ops-team");
  });
});
