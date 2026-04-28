import { describe, expect, it } from "vitest";
import { collectDeprecatedInternalConfigApiViolations } from "../../../scripts/lib/deprecated-config-api-guard.mjs";

describe("deprecated internal config API guardrails", () => {
  it("keeps production code off deprecated config load/write seams", () => {
    expect(collectDeprecatedInternalConfigApiViolations()).toEqual([]);
  });
});
