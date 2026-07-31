import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("node agent-runs config", () => {
  it("keeps Claude node execution disabled unless explicitly enabled", () => {
    const result = validateConfigObject({ nodeHost: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.nodeHost?.agentRuns?.claude?.enabled).toBeUndefined();
    }
  });

  it.each([true, false])("accepts Claude enabled=%s", (enabled) => {
    expect(validateConfigObject({ nodeHost: { agentRuns: { claude: { enabled } } } }).ok).toBe(
      true,
    );
  });

  it("rejects non-boolean Claude enablement", () => {
    const result = validateConfigObject({
      nodeHost: { agentRuns: { claude: { enabled: "yes" } } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.path === "nodeHost.agentRuns.claude.enabled"),
      ).toBe(true);
    }
  });
});
