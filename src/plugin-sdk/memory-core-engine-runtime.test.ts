/**
 * Tests memory core engine runtime facade behavior.
 */
import { describe, expect, it } from "vitest";
import type { ShortTermAuditIssue } from "./memory-core-engine-runtime.js";

describe("memory-core engine runtime SDK facade", () => {
  it("exposes the short-term recall overflow audit code", () => {
    const issue = {
      severity: "warn",
      code: "recall-store-over-limit",
      message: "Short-term recall store is over the retention limit.",
      fixable: true,
    } satisfies ShortTermAuditIssue;

    expect(issue.code).toBe("recall-store-over-limit");
  });
});
