import { describe, it, expect } from "vitest";

import * as utils from "./index";

describe("utils barrel exports", () => {
  it("re-exports key utility functions", () => {
    expect(typeof utils.deriveHubSettings).toBe("function");
    expect(typeof utils.requestJson).toBe("function");
    expect(typeof utils.formatArgs).toBe("function");
    expect(typeof utils.resolvePlaceholder).toBe("function");
    expect(typeof utils.getEnabledPlatforms).toBe("function");
  });
});
