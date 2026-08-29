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

  it("keeps direct worker execution as the implicit default", () => {
    const result = validateConfigObject({ nodeHost: { workerRuns: {} } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.nodeHost?.workerRuns?.isolation).toBeUndefined();
    }
  });

  it.each(["none", "container"])("accepts worker session isolation=%s", (isolation) => {
    expect(validateConfigObject({ nodeHost: { workerRuns: { isolation } } }).ok).toBe(true);
  });

  it.each(["docker", "", true, null])(
    "rejects invalid worker session isolation=%j",
    (isolation) => {
      const result = validateConfigObject({ nodeHost: { workerRuns: { isolation } } });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((issue) => issue.path === "nodeHost.workerRuns.isolation")).toBe(
          true,
        );
      }
    },
  );

  it.each(["node:22-slim", `registry.example.test/workers/node@sha256:${"a".repeat(64)}`])(
    "accepts worker container image=%s",
    (containerImage) => {
      expect(validateConfigObject({ nodeHost: { workerRuns: { containerImage } } }).ok).toBe(true);
    },
  );

  it.each(["", "   ", 22, null])("rejects invalid worker container image=%j", (containerImage) => {
    const result = validateConfigObject({ nodeHost: { workerRuns: { containerImage } } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.path === "nodeHost.workerRuns.containerImage"),
      ).toBe(true);
    }
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
