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

  it.each([true, false])("accepts worker session hosting enabled=%s", (enabled) => {
    expect(validateConfigObject({ nodeHost: { workerRuns: { enabled } } }).ok).toBe(true);
  });

  it.each([1, 5, 1024])("accepts worker session hosting capacity=%s", (capacity) => {
    expect(validateConfigObject({ nodeHost: { workerRuns: { capacity } } }).ok).toBe(true);
  });

  it.each([0, -1, 1.5, 1025])("rejects invalid worker session hosting capacity=%s", (capacity) => {
    const result = validateConfigObject({ nodeHost: { workerRuns: { capacity } } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === "nodeHost.workerRuns.capacity")).toBe(
        true,
      );
    }
  });

  it("rejects non-boolean worker session hosting enablement", () => {
    const result = validateConfigObject({ nodeHost: { workerRuns: { enabled: "yes" } } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === "nodeHost.workerRuns.enabled")).toBe(
        true,
      );
    }
  });
});
